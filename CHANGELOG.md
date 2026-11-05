# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-11-06

### Fixed
- `reflect.js fetch` no longer fails with `ENOBUFS` when the transcript exceeds 1 MiB: subprocess output is now buffered up to 64 MiB (#8).
- `reflect.js` no longer truncates its JSON output when stdout is a pipe or socket: it ends by letting stdout drain instead of calling `process.exit()`. Before this, a large `fetch` envelope could be cut off with exit code 0.

### Changed
- `npm test` names its test files explicitly instead of relying on the default `node --test` scan.

## [0.1.3] - 2026-06-05

### Added
- CLAUDE.md with development guide and release process from zylos-component-template.

### Fixed
- Cap conversation fetch window to `max_conversations` (default 300) to prevent pulling entire DB on first run.
- Use SQL-based capping (`ORDER BY id DESC LIMIT N`) instead of ID arithmetic — handles non-contiguous IDs correctly.
- Bound cap query to `latestId` snapshot (`AND id <= endId`) to prevent read-snapshot race between queries.

### Changed
- Replace hardcoded "Howard" references with generic "owner" in SKILL.md, README.md, and default policy.md template.
- Remove legacy long-prompt task migration from post-install and post-upgrade hooks.

## [0.1.0] - 2026-06-05

### Added
- Initial identity-reflection utility component.
- `scripts/reflect.js fetch` with cursor-based C4 conversation fetching, threshold gating, and JSON envelope output.
- `scripts/reflect.js commit` with atomic state updates and run logging.
- Scheduler task registration and legacy long-prompt task migration in `post-install`.
- Background-subagent workflow and identity safety constraints in `SKILL.md`.
- User-editable policy file for identity-relevant signal priority.

### Upgrade Notes

Initial release. For fresh installation:

```bash
zylos add identity-reflection
```

No migration required.
