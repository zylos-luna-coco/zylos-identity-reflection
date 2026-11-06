---
name: identity-reflection
version: 0.1.5
description: Maintain durable self-knowledge for a Zylos agent by periodically reflecting on unprocessed C4 conversations and updating only stable identity traits when warranted.
type: utility

lifecycle:
  npm: true
  data_dir: ~/zylos/components/identity-reflection
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - policy.md
    - state.json
    - logs/
    - backups/

upgrade:
  repo: zz-howard/zylos-identity-reflection
  branch: main

config:
  optional:
    - name: IDENTITY_REFLECTION_MIN_CONVERSATIONS
      description: Minimum unprocessed C4 conversations before reflection runs. Stored in component config.json.
      default: "50"

dependencies:
  - comm-bridge
  - scheduler
---

# Identity Reflection

Use this skill when a scheduled `identity-reflection` task arrives, or when the owner explicitly asks to run identity reflection.

Identity reflection exists to help the owner and team get things done across sessions. It is not free-form self-improvement. It maintains accurate self-knowledge only where that self-knowledge improves future work.

## Execution Model

Reflection must run in a background subagent. The main session must not do the conversation analysis inline.

Outer layer, in the main session:
1. Launch a background subagent.
   - Claude runtime: use the Task tool with `run_in_background: true`.
   - Codex runtime: use the available background agent mechanism such as `spawn_agent`.
2. Give the subagent the Inner Subagent Workflow below.
3. Wait for the subagent result only when you are ready to mark the scheduled task done.
4. Run the scheduler `done` command from the scheduled task after the subagent completes.
5. If the subagent reports failure, investigate enough to avoid losing state; do not mark success silently.

## Inner Subagent Workflow

The subagent owns the actual reflection work:

1. Run:
   ```bash
   node ~/zylos/.claude/skills/identity-reflection/scripts/reflect.js fetch
   ```
2. Parse the JSON output.
3. If `status` is `skip`, run:
   ```bash
   node ~/zylos/.claude/skills/identity-reflection/scripts/reflect.js commit --result skip --observed-end-id <end_id>
   ```
   Then stop. Do not edit memory.
4. Read `~/zylos/components/identity-reflection/policy.md`.
5. Read the configured identity file from the `identity_file` field in the fetch JSON.
6. Analyze the fetched conversations for stable trait-level changes only.
7. If a genuine stable trait change exists, update only the `Personality & Behavioral Traits` section in `identity.md`.
8. If there is no genuine stable trait change, do not edit `identity.md`.
9. Commit state:
   - If identity changed:
     ```bash
     node ~/zylos/.claude/skills/identity-reflection/scripts/reflect.js commit --result updated --end-id <end_id>
     ```
   - If identity did not change:
     ```bash
     node ~/zylos/.claude/skills/identity-reflection/scripts/reflect.js commit --result no_change --end-id <end_id>
     ```

## Identity Write Boundary

What belongs in `identity.md`:
- Stable character traits and behavioral patterns that have crystallized from repeated experience.
- Values and principles.
- Cognitive style and durable collaboration style.
- Capabilities that are stable enough to shape future work.

What does not belong in `identity.md`:
- Specific corrections or one-off lessons.
- Version numbers, project status, task state, or event logs.
- Operational details, config paths, database paths, or credentials.
- Anything that primarily describes what happened rather than who the agent is.

Only the `Personality & Behavioral Traits` section may be modified. `Who I Am`, `Principles`, `Communication Style`, `Digital Assets`, and every other section are read-only. If `Personality & Behavioral Traits` is missing, log a warning through the reflection commit/run log and do not modify the file.

## Reflection Standard

Ask:
- Has a repeated pattern of behavior solidified into a stable trait?
- Has an existing trait description become inaccurate?
- Is this durable self-knowledge, or just a recent event?

When in doubt, do not edit identity. Quality over frequency.
