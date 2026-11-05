import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const REFLECT = path.join(ROOT, 'scripts/reflect.js');
const POST_INSTALL = path.join(ROOT, 'hooks/post-install.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reflection-test-'));
}

function runNode(script, args = [], env = {}) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function runNodeFailure(script, args = [], env = {}) {
  try {
    runNode(script, args, env);
  } catch (err) {
    return {
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || '',
      status: err.status
    };
  }
  throw new Error('Expected command to fail');
}

function runSqlite(dbPath, sql) {
  execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
}

function createC4Db(dir, rows) {
  const dbPath = path.join(dir, 'c4.db');
  runSqlite(dbPath, `CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    direction TEXT NOT NULL,
    channel TEXT NOT NULL,
    endpoint_id TEXT,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    priority INTEGER DEFAULT 3,
    require_idle INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    delivery_action TEXT
  );`);
  for (const row of rows) {
    const idClause = row.id != null ? `${row.id}, ` : '';
    const cols = row.id != null ? 'id, direction, channel, endpoint_id, content' : 'direction, channel, endpoint_id, content';
    const vals = row.id != null
      ? `${row.id}, '${row.direction}', '${row.channel}', '${row.endpoint}', '${row.content}'`
      : `'${row.direction}', '${row.channel}', '${row.endpoint}', '${row.content}'`;
    runSqlite(dbPath, `INSERT INTO conversations (${cols}) VALUES (${vals});`);
  }
  return dbPath;
}

function createFakeFetch(dir) {
  const fetchPath = path.join(dir, 'c4-fetch.js');
  fs.writeFileSync(fetchPath, `console.log('[Conversations] ' + process.argv.slice(2).join(' '));\n`);
  return fetchPath;
}

function writeConfig(dataDir, config) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

test('fetch skips below threshold without advancing state', () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  const dbPath = createC4Db(dir, [{ direction: 'in', channel: 'telegram', endpoint: '1', content: 'hello' }]);
  const fetchPath = createFakeFetch(dir);
  writeConfig(dataDir, { min_conversations: 2, c4_db: dbPath, c4_fetch_script: fetchPath });

  const result = JSON.parse(runNode(REFLECT, ['fetch'], { ZYLOS_DATA_DIR: dataDir }));

  assert.equal(result.status, 'skip');
  assert.equal(result.begin_id, 1);
  assert.equal(result.end_id, 1);
  assert.equal(result.count, 1);
  assert.equal(result.conversations, undefined);
});

test('fetch reports missing sqlite3 CLI with explicit JSON error', () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  writeConfig(dataDir, { min_conversations: 1 });

  const failure = runNodeFailure(REFLECT, ['fetch'], { ZYLOS_DATA_DIR: dataDir, PATH: dir });
  const result = JSON.parse(failure.stdout);

  assert.equal(failure.status, 1);
  assert.equal(result.status, 'error');
  assert.match(result.error, /sqlite3 CLI is required but not found/);
});

test('fetch returns ready envelope with transcript at threshold', () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  const dbPath = createC4Db(dir, [
    { direction: 'in', channel: 'telegram', endpoint: '1', content: 'hello' },
    { direction: 'out', channel: 'telegram', endpoint: '1', content: 'hi' }
  ]);
  const fetchPath = createFakeFetch(dir);
  writeConfig(dataDir, { min_conversations: 2, c4_db: dbPath, c4_fetch_script: fetchPath });

  const result = JSON.parse(runNode(REFLECT, ['fetch'], { ZYLOS_DATA_DIR: dataDir }));

  assert.equal(result.status, 'ready');
  assert.equal(result.begin_id, 1);
  assert.equal(result.end_id, 2);
  assert.equal(result.count, 2);
  assert.match(result.conversations, /--begin 1 --end 2/);
});

// Runs the real CLI against a temporary C4 database and a stand-in c4-fetch.js;
// HOME, ZYLOS_DIR and ZYLOS_DATA_DIR all point into the temporary directory.
// Covers: a transcript over Node's 1 MiB default passes through run() and the whole
// JSON envelope reaches a reader on a pipe-like stdout. Does not cover the real c4-fetch.js or the upper
// buffer limit. Run it when run(), fetchTranscript() or the fetch output changes;
// it needs only node and sqlite3, so there is no reason to skip it.
test('fetch returns a transcript larger than 1 MiB intact', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'data');
  const dbPath = createC4Db(dir, [
    { direction: 'in', channel: 'telegram', endpoint: '1', content: 'hello' },
    { direction: 'out', channel: 'telegram', endpoint: '1', content: 'hi' }
  ]);
  const transcriptBytes = 2 * 1024 * 1024;
  const endMarker = '[end of transcript]';
  const fetchPath = path.join(dir, 'c4-fetch.js');
  fs.writeFileSync(
    fetchPath,
    `process.stdout.write('x'.repeat(${transcriptBytes - endMarker.length}) + ${JSON.stringify(endMarker)});\n`
  );
  writeConfig(dataDir, { min_conversations: 2, c4_db: dbPath, c4_fetch_script: fetchPath });

  const child = spawnSync(process.execPath, [REFLECT, 'fetch'], {
    cwd: ROOT,
    env: { ...process.env, HOME: dir, ZYLOS_DIR: path.join(dir, 'zylos'), ZYLOS_DATA_DIR: dataDir },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000
  });

  assert.equal(child.status, 0, child.stdout.slice(0, 500));
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'ready');
  assert.equal(result.conversations.length, transcriptBytes);
  assert.ok(result.conversations.endsWith(endMarker));
});

test('fetch reports disabled as a single skip envelope', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'data');
  writeConfig(dataDir, { enabled: false, c4_fetch_script: path.join(dir, 'missing-c4-fetch.js') });

  const result = JSON.parse(runNode(REFLECT, ['fetch'], { HOME: dir, ZYLOS_DIR: path.join(dir, 'zylos'), ZYLOS_DATA_DIR: dataDir }));

  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'disabled');
});

test('unknown command reports usage and exits non-zero', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const failure = runNodeFailure(REFLECT, ['unknown'], { HOME: dir, ZYLOS_DIR: path.join(dir, 'zylos'), ZYLOS_DATA_DIR: path.join(dir, 'data') });

  assert.equal(failure.status, 1);
  assert.match(JSON.parse(failure.stdout).error, /^Usage:/);
});

test('fetch caps window to max_conversations on first run', () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  const rows = Array.from({ length: 10 }, (_, i) => ({
    direction: 'in', channel: 'telegram', endpoint: '1', content: `msg${i}`
  }));
  const dbPath = createC4Db(dir, rows);
  const fetchPath = createFakeFetch(dir);
  writeConfig(dataDir, { min_conversations: 2, max_conversations: 5, c4_db: dbPath, c4_fetch_script: fetchPath });

  const result = JSON.parse(runNode(REFLECT, ['fetch'], { ZYLOS_DATA_DIR: dataDir }));

  assert.equal(result.status, 'ready');
  assert.equal(result.begin_id, 6);
  assert.equal(result.end_id, 10);
  assert.equal(result.count, 5);
  assert.match(result.conversations, /--begin 6 --end 10/);
});

test('fetch caps correctly with non-contiguous IDs (gaps)', () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  const rows = [
    { id: 1, direction: 'in', channel: 'tg', endpoint: '1', content: 'a' },
    { id: 5, direction: 'in', channel: 'tg', endpoint: '1', content: 'b' },
    { id: 10, direction: 'in', channel: 'tg', endpoint: '1', content: 'c' },
    { id: 50, direction: 'in', channel: 'tg', endpoint: '1', content: 'd' },
    { id: 100, direction: 'in', channel: 'tg', endpoint: '1', content: 'e' },
    { id: 200, direction: 'in', channel: 'tg', endpoint: '1', content: 'f' },
  ];
  const dbPath = createC4Db(dir, rows);
  const fetchPath = createFakeFetch(dir);
  writeConfig(dataDir, { min_conversations: 2, max_conversations: 3, c4_db: dbPath, c4_fetch_script: fetchPath });

  const result = JSON.parse(runNode(REFLECT, ['fetch'], { ZYLOS_DATA_DIR: dataDir }));

  assert.equal(result.status, 'ready');
  assert.equal(result.begin_id, 50);
  assert.equal(result.end_id, 200);
  assert.equal(result.count, 3);
  assert.match(result.conversations, /--begin 50 --end 200/);
});

test('fetch cap is bounded by latestId (no rows beyond snapshot)', () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  const rows = Array.from({ length: 10 }, (_, i) => ({
    direction: 'in', channel: 'telegram', endpoint: '1', content: `msg${i}`
  }));
  const dbPath = createC4Db(dir, rows);
  const fetchPath = createFakeFetch(dir);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ last_processed_id: 3, last_observed_id: 3 }));
  writeConfig(dataDir, { min_conversations: 2, max_conversations: 5, c4_db: dbPath, c4_fetch_script: fetchPath });

  const result = JSON.parse(runNode(REFLECT, ['fetch'], { ZYLOS_DATA_DIR: dataDir }));

  assert.equal(result.status, 'ready');
  assert.equal(result.begin_id, 6);
  assert.equal(result.end_id, 10);
  assert.equal(result.count, 5);
  assert.ok(result.begin_id <= result.end_id);
  assert.match(result.conversations, /--begin 6 --end 10/);

  runSqlite(dbPath, `INSERT INTO conversations (direction, channel, endpoint_id, content) VALUES ('in', 'tg', '1', 'late-arrival');`);

  const result2 = JSON.parse(runNode(REFLECT, ['fetch'], { ZYLOS_DATA_DIR: dataDir }));
  assert.ok(result2.begin_id <= result2.end_id);
});

test('commit skip records observation without advancing processed cursor', () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ last_processed_id: 7, last_observed_id: 7 }));

  const result = JSON.parse(runNode(REFLECT, ['commit', '--result', 'skip', '--observed-end-id', '9'], { ZYLOS_DATA_DIR: dataDir }));
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));

  assert.equal(result.status, 'committed');
  assert.equal(state.last_processed_id, 7);
  assert.equal(state.last_observed_id, 9);
  assert.equal(state.last_result, 'skip');
  assert.ok(fs.existsSync(path.join(dataDir, 'logs/runs.jsonl')));
});

test('commit preserves monotonic cursors and rejects stale processed end-id', () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ last_processed_id: 10, last_observed_id: 12 }));

  runNode(REFLECT, ['commit', '--result', 'skip', '--observed-end-id', '9'], { ZYLOS_DATA_DIR: dataDir });
  let state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(state.last_processed_id, 10);
  assert.equal(state.last_observed_id, 12);

  const failure = runNodeFailure(REFLECT, ['commit', '--result', 'no_change', '--end-id', '5'], { ZYLOS_DATA_DIR: dataDir });
  const result = JSON.parse(failure.stdout);
  assert.equal(failure.status, 1);
  assert.match(result.error, /Refusing to move last_processed_id backward/);

  state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(state.last_processed_id, 10);
  assert.equal(state.last_observed_id, 12);

  runNode(REFLECT, ['commit', '--result', 'updated', '--end-id', '11'], { ZYLOS_DATA_DIR: dataDir });
  state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(state.last_processed_id, 11);
  assert.equal(state.last_observed_id, 12);
});

test('commit no_change advances processed cursor and requires end-id', () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const failure = runNodeFailure(REFLECT, ['commit', '--result', 'no_change'], { ZYLOS_DATA_DIR: dataDir });
  assert.equal(failure.status, 1);
  assert.match(failure.stdout, /requires --end-id/);

  runNode(REFLECT, ['commit', '--result', 'no_change', '--end-id', '12'], { ZYLOS_DATA_DIR: dataDir });
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));

  assert.equal(state.last_processed_id, 12);
  assert.equal(state.last_observed_id, 12);
  assert.equal(state.last_result, 'no_change');
});

test('post-install creates data files and registers scheduler task', () => {
  const dir = tmpDir();
  const zylosDir = path.join(dir, 'zylos');
  const schedulerDir = path.join(zylosDir, 'scheduler');
  const cliDir = path.join(zylosDir, '.claude/skills/scheduler/scripts');
  const dbPath = path.join(schedulerDir, 'scheduler.db');
  const cliLog = path.join(dir, 'scheduler-cli.log');
  fs.mkdirSync(schedulerDir, { recursive: true });
  fs.mkdirSync(cliDir, { recursive: true });

  runSqlite(dbPath, `CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    type TEXT,
    cron_expression TEXT,
    priority INTEGER,
    status TEXT
  );`);

  fs.writeFileSync(path.join(cliDir, 'cli.js'), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(cliLog)}, process.argv.slice(2).join(' ') + '\\n');\n`);

  runNode(POST_INSTALL, [], { ZYLOS_DIR: zylosDir });

  const componentDir = path.join(zylosDir, 'components/identity-reflection');
  assert.ok(fs.existsSync(path.join(componentDir, 'config.json')));
  assert.ok(fs.existsSync(path.join(componentDir, 'policy.md')));
  assert.ok(fs.existsSync(path.join(componentDir, 'state.json')));

  const log = fs.readFileSync(cliLog, 'utf8');
  assert.match(log, /^add Run the identity-reflection skill/m);
});
