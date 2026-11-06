import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { coreRoot } from './helpers/core-fixture.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const REFLECT = path.join(ROOT, 'scripts/reflect.js');
const CORE = coreRoot();
assert.equal(execFileSync('git', ['-C', CORE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  'e3eaf512cd11b92d250b03db90fda442133751e1', 'Use the fixed, unreleased Core checkout');
const CORE_SCRIPTS = path.join(CORE, 'skills/comm-bridge/scripts');
const protocol = JSON.parse(fs.readFileSync(path.join(CORE, 'test/fixtures/c4-content-protocol.json'), 'utf8'));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const hidden = 'HOST_PRIVATE_PAYLOAD_SENTINEL';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-projection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'instance'),
    ZYLOS_DATA_DIR: path.join(root, 'data'), PM2_HOME: path.join(root, 'pm2'),
    TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmux'), ZYLOS_PACKAGE_ROOT: CORE };
  for (const key of ['TMUX', 'ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  for (const key of ['HOME', 'ZYLOS_DIR', 'ZYLOS_DATA_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    fs.mkdirSync(env[key], { recursive: true });
    assert.ok(fs.realpathSync(env[key]).startsWith(root + path.sep), key);
  }
  fs.mkdirSync(path.join(env.ZYLOS_DIR, '.zylos'));
  fs.writeFileSync(path.join(env.ZYLOS_DIR, '.zylos/config.json'), '{"runtime":"claude","session_mode":"multi"}');
  const db = path.join(env.ZYLOS_DIR, 'comm-bridge/c4.db');
  assert.ok(path.resolve(db).startsWith(root + path.sep));
  const config = { min_conversations: 1, max_conversations: 300, c4_db: db,
    c4_fetch_script: path.join(CORE_SCRIPTS, 'c4-fetch.js') };
  function configure(changes = {}) {
    Object.assign(config, changes);
    fs.writeFileSync(path.join(env.ZYLOS_DATA_DIR, 'config.json'), JSON.stringify(config));
  }
  configure();
  function invoke(script, args, override = {}) {
    return spawnSync(process.execPath, [script, ...args], {
      cwd: ROOT, env: { ...env, ...override }, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  }
  const init = invoke(path.join(CORE_SCRIPTS, 'c4-db.js'), ['init']);
  assert.equal(init.status, 0, init.stderr);
  function sql(input) {
    return execFileSync('sqlite3', [db], { env, input, encoding: 'utf8', timeout: 5000 });
  }
  function seed(contents) {
    let id = 0;
    const rows = [];
    for (const direction of ['in', 'out']) for (const content of contents) {
      id += 1; rows.push({ id, direction, content });
      sql(`INSERT INTO conversations(id,timestamp,direction,channel,endpoint_id,content,status,session_group)
        VALUES(${id},'2026-01-01 00:00:00',${quote(direction)},'dashboard','room',${quote(content)},'delivered','dashboard:room');`);
    }
    return rows;
  }
  return { root, env, config, configure, invoke, seed, sql };
}
function ready(f, script = REFLECT) {
  const child = f.invoke(script, ['fetch']);
  assert.equal(child.status, 0, child.stdout.slice(0, 500) + child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'ready');
  return { result, output: child.stdout };
}

// Integration: real component CLI -> actual fixed Core fetch -> private SQLite
// -> final JSON/conversations text consumed by the reflection agent. No model,
// services, runtime, PM2, tmux or network. Fixture validates owned paths before
// processes, bounds all children and registers cleanup before assertions.
// Run for history/readiness/prompt handoff changes; skip unrelated lifecycle/UI.
test('reflection history contains only projected text for both directions and keeps source bodies intact', t => {
  const f = fixture(t);
  const envelope = structuredClone(protocol.valid.find(x => x.name === 'markdown').envelope);
  envelope.fallbackText = 'visible reflection summary'; envelope.blocks[0].data.text = hidden;
  const encode = x => '[C4-CONTENT]\n' + JSON.stringify(x);
  const long = { ...envelope, messageId: 'long_history', blocks: [{ ...envelope.blocks[0], data: { text: hidden + 'x'.repeat(20000) } }] };
  const nested = { ...envelope, messageId: 'nested_history', fallbackText: '[C4-CONTENT]\nliteral fallback' };
  const answer = protocol.valid.find(x => x.name === 'answer_single_select').content;
  const plain = 'ordinary JSON {"ok":true}\nUnicode 中🚀 and \\ slash';
  const rows = f.seed([encode(envelope), '[C4-CONTENT]\n{"private":"' + hidden + '"', encode(long), plain, encode(nested), answer]);
  const before = f.sql('SELECT id,hex(content) FROM conversations ORDER BY id;');
  const { result, output } = ready(f);
  assert.equal(result.count, rows.length);
  assert.equal(output.includes(hidden), false);
  assert.equal(output.includes('"blocks"'), false);
  assert.equal(result.conversations.includes('"blocks"'), false);
  assert.equal(result.conversations.includes('"version"'), false);
  for (const row of rows) {
    const prefix = `[2026-01-01 00:00:00] ${row.direction === 'in' ? 'IN' : 'OUT'} (dashboard:room):\n`;
    assert.ok(result.conversations.includes(prefix));
    if (row.content.includes('"private"')) assert.ok(result.conversations.includes(`[C4 content invalid; c4_id=${row.id}]`));
    else if (row.content === plain) assert.ok(result.conversations.includes(plain));
    else {
      const value = JSON.parse(row.content.slice('[C4-CONTENT]\n'.length));
      const interrupt = value.interruptId === undefined ? '' : ` interruptId=${value.interruptId}`;
      assert.ok(result.conversations.includes(`${value.fallbackText}\n[C4 messageId=${value.messageId}${interrupt}; c4_id=${row.id}]`));
      assert.equal(result.conversations.includes(row.content), false);
    }
  }
  assert.equal(f.sql('SELECT id,hex(content) FROM conversations ORDER BY id;'), before);
  assert.equal(fs.existsSync(path.join(f.env.ZYLOS_DATA_DIR, 'state.json')), false);
});

// Integration: unmodified release script as an independent ordinary-text baseline,
// run through the same fixture and Core CLI. Run for output formatting changes;
// skip unrelated hooks. Snapshot is executed as a real file, never reevaluated
// or rewritten; no network or live state, with the same bounds/cleanup as above.
test('ordinary reflection payload is byte identical to the previous component release', t => {
  const f = fixture(t);
  f.seed(['ordinary text', '{"ordinary":"JSON"}\n中文🚀', 'quotes \' and \\ and newlines\nend']);
  const baseline = path.join(f.root, 'baseline-reflect.js');
  fs.writeFileSync(path.join(f.root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(baseline, execFileSync('git', ['show', 'v0.1.5:scripts/reflect.js'], { cwd: ROOT, encoding: 'utf8', timeout: 5000 }));
  assert.equal(ready(f).output, ready(f, baseline).output);
});

// Integration: real historical Core resolver without a public projection export.
// It must fail before invoking legacy fetch or returning any body. Run for Core
// prerequisite/resolution changes; skip unrelated policy/commit changes. Private
// DB and unchanged reflection cursor; no raw fallback, runtime or network.
test('a Core without the public projection entry stops reflection before legacy history fetch', t => {
  const f = fixture(t); f.seed([hidden]);
  const legacy = fs.realpathSync(process.env.TEST_LEGACY_CORE_ROOT);
  assert.equal(fs.existsSync(path.join(legacy, 'cli/lib/content-projection.js')), false);
  f.configure({ c4_fetch_script: path.join(legacy, 'skills/comm-bridge/scripts/c4-fetch.js') });
  const state = '{"last_processed_id":0,"last_observed_id":0}\n';
  fs.writeFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'state.json'), state);
  const child = f.invoke(REFLECT, ['fetch'], { ZYLOS_PACKAGE_ROOT: legacy });
  assert.equal(child.status, 1);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'error');
  assert.match(result.error, /Projected C4 history requires a Core version with Dashboard conversation projection/);
  assert.match(result.error, /cli\/lib\/content-projection\.js/);
  assert.equal(result.conversations, undefined);
  assert.equal(child.stdout.includes(hidden), false);
  assert.equal(fs.readFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'state.json'), 'utf8'), state);
});

// Integration: absent loader cannot fall back to an arbitrary configured fetch.
// Run for availability checks; skip unrelated metadata queries. The sentinel
// fixture never executes; uses the same private env and process bounds above.
test('an unresolved Core loader never calls the configured raw fetch', t => {
  const f = fixture(t); f.seed([hidden]);
  const marker = path.join(f.root, 'raw-fetch-called');
  const script = path.join(f.root, 'raw-fetch.js');
  fs.writeFileSync(path.join(f.root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'called'); console.log(${JSON.stringify(hidden)});`);
  f.configure({ c4_fetch_script: script });
  const child = f.invoke(REFLECT, ['fetch']);
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).status, 'error');
  assert.match(JSON.parse(child.stdout).error, /No history was fetched/);
  assert.equal(child.stdout.includes(hidden), false);
  assert.equal(fs.existsSync(marker), false);
});
