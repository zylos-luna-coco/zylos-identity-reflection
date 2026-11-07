#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(HOME, 'zylos');
const DATA_DIR = process.env.ZYLOS_DATA_DIR || path.join(ZYLOS_DIR, 'components/identity-reflection');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const RUN_LOG_PATH = path.join(LOG_DIR, 'runs.jsonl');
const SUBPROCESS_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const DEFAULT_CONFIG = {
  enabled: true,
  min_conversations: 50,
  max_conversations: 300,
  identity_file: '~/zylos/memory/identity.md',
  c4_db: '~/zylos/comm-bridge/c4.db',
  c4_fetch_script: '~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js'
};

const DEFAULT_STATE = {
  schema_version: 1,
  last_processed_id: 0,
  last_observed_id: 0,
  last_run_at: null,
  last_result: null,
  last_identity_update_at: null,
  scheduler_prompt_hash: null
};

function requireSqliteCli() {
  try {
    execFileSync('which', ['sqlite3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error('sqlite3 CLI is required but not found. Install it with: apt-get install sqlite3');
  }
}

function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return HOME;
  if (value.startsWith('~/')) return path.join(HOME, value.slice(2));
  return value;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { ...fallback };
    throw new Error(`Failed to read ${filePath}: ${err.message}`);
  }
}

function atomicWriteJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, payload);
  fs.renameSync(tmpPath, filePath);
}

function loadConfig() {
  const loaded = readJson(CONFIG_PATH, DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...loaded };
}

function loadState() {
  const loaded = readJson(STATE_PATH, DEFAULT_STATE);
  return normalizeState(loaded);
}

function normalizeState(state) {
  return {
    ...DEFAULT_STATE,
    ...state,
    schema_version: 1,
    last_processed_id: normalizeId(state.last_processed_id, 0),
    last_observed_id: normalizeId(state.last_observed_id, 0)
  };
}

function normalizeId(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`Invalid conversation id: ${value}`);
  }
  return numeric;
}

function outputJson(value, exitCode = 0) {
  // Let the process end on its own: process.exit() here drops whatever a pipe
  // has not yet accepted, so callers must return after calling this.
  process.exitCode = exitCode;
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function outputError(message, details = undefined) {
  outputJson({ status: 'error', error: message, ...(details ? { details } : {}) }, 1);
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: SUBPROCESS_MAX_BUFFER_BYTES
  });
}

function getLatestConversationId(c4DbPath) {
  if (!fs.existsSync(c4DbPath)) {
    throw new Error(`C4 database not found: ${c4DbPath}`);
  }
  const raw = run('sqlite3', [c4DbPath, 'SELECT COALESCE(MAX(id), 0) FROM conversations;']).trim();
  return normalizeId(raw || '0', 0);
}

function getConversationCount(c4DbPath, beginId, endId) {
  if (endId < beginId) return 0;
  const sql = `SELECT COUNT(*) FROM conversations WHERE id BETWEEN ${beginId} AND ${endId};`;
  const raw = run('sqlite3', [c4DbPath, sql]).trim();
  return normalizeId(raw || '0', 0);
}

// The fetch window holds at most `limit` conversations after the cursor. Normal
// runs take the oldest ones so a large backlog is caught up over several runs
// instead of being skipped. A first run (cursor 0) takes the newest ones so a
// fresh install does not start from the beginning of the history.
function getFetchWindow(c4DbPath, afterId, latestId, limit) {
  const order = afterId === 0 ? 'DESC' : 'ASC';
  const sql = `SELECT MIN(id), MAX(id) FROM (SELECT id FROM conversations WHERE id > ${afterId} AND id <= ${latestId} ORDER BY id ${order} LIMIT ${limit});`;
  const [minRaw, maxRaw] = run('sqlite3', [c4DbPath, sql]).trim().split('|');
  if (!minRaw || !maxRaw) return null;
  return { beginId: normalizeId(minRaw), endId: normalizeId(maxRaw) };
}

function fetchTranscript(c4FetchScript, beginId, endId) {
  // Core supplies readable history. Do not project its output again: a
  // legitimate fallback may contain a structured-message marker.
  return run('node', [c4FetchScript, '--begin', String(beginId), '--end', String(endId)]);
}

function appendRunLog(entry) {
  ensureDir(LOG_DIR);
  fs.appendFileSync(RUN_LOG_PATH, `${JSON.stringify(entry)}\n`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return { command, args };
}

function commandFetch() {
  requireSqliteCli();

  const config = loadConfig();
  const state = loadState();

  if (config.enabled === false) {
    outputJson({
      status: 'skip',
      reason: 'disabled',
      begin_id: state.last_processed_id + 1,
      end_id: state.last_processed_id,
      count: 0
    });
    return;
  }

  const c4DbPath = expandHome(config.c4_db);
  const c4FetchScript = expandHome(config.c4_fetch_script);
  if (!fs.existsSync(c4FetchScript)) {
    throw new Error(`c4-fetch.js not found: ${c4FetchScript}`);
  }

  const latestId = getLatestConversationId(c4DbPath);
  let beginId = state.last_processed_id + 1;
  let endId = latestId;
  const maxConversations = Number(config.max_conversations ?? DEFAULT_CONFIG.max_conversations);
  if (Number.isSafeInteger(maxConversations) && maxConversations > 0) {
    const window = getFetchWindow(c4DbPath, state.last_processed_id, latestId, maxConversations);
    if (window !== null) {
      ({ beginId, endId } = window);
    }
  }
  const count = getConversationCount(c4DbPath, beginId, endId);
  const minConversations = Number(config.min_conversations ?? DEFAULT_CONFIG.min_conversations);

  if (!Number.isSafeInteger(minConversations) || minConversations < 1) {
    throw new Error(`Invalid min_conversations: ${config.min_conversations}`);
  }

  const base = {
    status: count >= minConversations ? 'ready' : 'skip',
    begin_id: beginId,
    end_id: endId,
    count,
    min_conversations: minConversations,
    identity_file: config.identity_file,
    state_file: STATE_PATH,
    policy_file: path.join(DATA_DIR, 'policy.md')
  };

  if (base.status === 'skip') {
    outputJson(base);
    return;
  }

  outputJson({ ...base, conversations: fetchTranscript(c4FetchScript, beginId, endId) });
}

function commandCommit(args) {
  const result = args.result;
  if (!['skip', 'no_change', 'updated'].includes(result)) {
    throw new Error('commit requires --result skip|no_change|updated');
  }

  const state = loadState();
  const now = new Date().toISOString();
  const nextState = { ...state, last_run_at: now, last_result: result };
  let processedEndId = null;
  let observedEndId = null;

  if (result === 'skip') {
    if (args['observed-end-id'] !== undefined && args['observed-end-id'] !== true) {
      observedEndId = normalizeId(args['observed-end-id']);
      nextState.last_observed_id = Math.max(state.last_observed_id, observedEndId);
    }
  } else {
    if (args['end-id'] === undefined || args['end-id'] === true) {
      throw new Error(`commit --result ${result} requires --end-id <N>`);
    }
    processedEndId = normalizeId(args['end-id']);
    if (processedEndId < state.last_processed_id) {
      throw new Error(`Refusing to move last_processed_id backward from ${state.last_processed_id} to ${processedEndId}`);
    }
    nextState.last_processed_id = processedEndId;
    nextState.last_observed_id = Math.max(state.last_observed_id, processedEndId);
    if (result === 'updated') nextState.last_identity_update_at = now;
  }

  atomicWriteJson(STATE_PATH, nextState);
  appendRunLog({
    timestamp: now,
    result,
    processed_end_id: processedEndId,
    observed_end_id: observedEndId ?? nextState.last_observed_id,
    state_hash: crypto.createHash('sha256').update(JSON.stringify(nextState)).digest('hex')
  });

  outputJson({
    status: 'committed',
    result,
    last_processed_id: nextState.last_processed_id,
    last_observed_id: nextState.last_observed_id,
    last_run_at: nextState.last_run_at
  });
}

function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  try {
    if (command === 'fetch') {
      commandFetch();
    } else if (command === 'commit') {
      commandCommit(args);
    } else {
      outputJson({
        status: 'error',
        error: 'Usage: reflect.js fetch | reflect.js commit --result <skip|no_change|updated> [--end-id N] [--observed-end-id N]'
      }, 1);
    }
  } catch (err) {
    outputError(err.message);
  }
}

main();
