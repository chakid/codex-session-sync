# Release Notes

## v0.1.0

Initial public release of `codex-sessions`.

### Highlights

- Added a local dashboard for browsing Codex sessions stored in `~/.codex/state_5.sqlite`
- Added session filtering by `model_provider` and keyword search
- Added session detail view with rollout JSONL status
- Added `clone`, `retarget`, and `delete` session actions
- Added `Backup state` flow to run `prepare-backup` checks and create a real snapshot
- Added fallback occupancy checks with `lsof` when `sqlite3` is unavailable
- Added CLI commands for `dashboard`, `list`, `prepare-backup`, `clone`, `retarget`, `delete`, and `backup`
- Added npm package metadata, MIT license, and release/publish scripts

### Notes

- Real backups are triggered from the startup modal via `Backup state`
- Write operations only run `prepare-backup` checks before mutating data
- The project is released under the MIT license
