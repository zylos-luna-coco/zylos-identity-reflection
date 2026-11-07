<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-identity-reflection</h1>

<p align="center">
  Periodic identity reflection component for Zylos agents.
</p>

---

`zylos-identity-reflection` turns the long inline identity-reflection scheduler prompt into an installable Zylos utility component. It keeps a cursor over unprocessed C4 conversations, waits until enough new conversation volume has accumulated, and then asks a background subagent to decide whether stable identity traits have changed.

The component never updates identity automatically from script logic. The script fetches conversations and maintains state; the agent applies judgment and may update only the `Personality & Behavioral Traits` section of `memory/identity.md`.

## System Requirements

- Node.js, provided by the Zylos runtime.
- `sqlite3` CLI, used to inspect the C4 and scheduler SQLite databases.

Install `sqlite3` on Debian/Ubuntu systems with:

```bash
apt-get install sqlite3
```

On macOS with Homebrew:

```bash
brew install sqlite3
```

On Core versions with conversation projection, structured history messages
appear as readable text. Earlier Core versions already provide plain-text
history, so reflection works as usual with no minimum Core version requirement.
The component passes Core fetch output unchanged to the reflection agent; it
does not project the transcript a second time.

## Install

```bash
zylos add identity-reflection
```

The post-install hook creates:

- `~/zylos/components/identity-reflection/config.json`
- `~/zylos/components/identity-reflection/policy.md`
- `~/zylos/components/identity-reflection/state.json`
- `~/zylos/components/identity-reflection/logs/`
- a recurring scheduler task named `identity-reflection`

It also pauses the old long-prompt identity-reflection task when it matches the legacy prompt fingerprint.

## Configuration

Edit `~/zylos/components/identity-reflection/config.json`:

```json
{
  "enabled": true,
  "min_conversations": 50,
  "identity_file": "~/zylos/memory/identity.md",
  "c4_db": "~/zylos/comm-bridge/c4.db",
  "c4_fetch_script": "~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js"
}
```

`min_conversations` controls the threshold for running reflection. If fewer unprocessed conversations are available, the run is recorded as `skip` and the processed cursor is not advanced.

## Policy

Edit `~/zylos/components/identity-reflection/policy.md` to customize identity conflict resolution. The default policy gives the owner's direct feedback absolute priority and requires stable evidence rather than single events.

## CLI

Fetch unprocessed conversations:

```bash
node ~/zylos/.claude/skills/identity-reflection/scripts/reflect.js fetch
```

Commit a skipped run without advancing the processed cursor:

```bash
node ~/zylos/.claude/skills/identity-reflection/scripts/reflect.js commit --result skip --observed-end-id 123
```

Commit a processed run:

```bash
node ~/zylos/.claude/skills/identity-reflection/scripts/reflect.js commit --result no_change --end-id 123
node ~/zylos/.claude/skills/identity-reflection/scripts/reflect.js commit --result updated --end-id 123
```

All CLI output is JSON. State writes are atomic.

## Runtime Model

The scheduler task dispatches the skill. The main session launches a background subagent, and the subagent performs the fetch/analyze/update/commit flow. This keeps reflection work out of the main loop and avoids blocking heartbeat delivery.

## State

`state.json` tracks:

- `last_processed_id`: cursor advanced only after `no_change` or `updated`
- `last_observed_id`: latest ID observed during fetches, including skipped runs
- `last_run_at`
- `last_result`
- `last_identity_update_at`
- `scheduler_prompt_hash`

Run entries are appended to `logs/runs.jsonl`.

## License

[MIT](./LICENSE)

## Tests

The default tests are self-contained and need no Core checkout or Core-related
environment variables. They use a fake history CLI in
private temporary directories (the sqlite3 CLI is still required):

```bash
npm test
```

The real-Core projection tests are opt-in. Use the current `multi-session/chat` Core checkout with its existing
development dependencies, and an older Core checkout at `6436b3e2` without the
public projection module. Both checkouts need their existing Core dependencies.
The tests import the structured-message prefix from the current Core schema. Do not install either into a live instance. Keep the
component's `v0.1.5` Git tag available for the byte-for-byte baseline.
Run in temporary HOME, ZYLOS_DIR, PM2_HOME and short TMPDIR directories; cases
create private C4 databases beneath TMPDIR and clean them up. No model,
runtime, PM2, tmux or network is started.

```bash
ZYLOS_PACKAGE_ROOT=/path/to/core-checkout \
TEST_LEGACY_CORE_ROOT=/path/to/older-core \
npm run test:integration
```
