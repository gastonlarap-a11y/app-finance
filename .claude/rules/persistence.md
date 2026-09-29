---
paths:
  - "backend/**/migrations/**"
  - "backend/shared/db/**"
  - "frontend/src/engine/db/**"
---

# Persistence invariants

Step-by-step procedure for a schema change: the `db-migration` skill.

- **Migrations**: embedded SQL run on startup; register each domain's `embed.FS` in
  `backend/shared/db/migrator.go`; the `YYYYMMDDNNN` filename prefix sets global order. SQLite can
  add columns but not change/drop them — rebuild + copy instead. Use the `db-migration` skill.
  New files are `*.tx.up.sql` (one transaction); a migration is recorded only on success,
  `main.go` snapshots the DB to `<backups>/pre-migrate/` first, and a DB with unknown migrations
  newer than this binary's latest is refused (`db.ErrNewerSchema`; older unknown ones are retired
  and ignored). Never delete or rename an applied migration file. Migrations need no engine
  change (auto-discovered by glob), but must be plain SQLite SQL with `--bun:split` separators.
- **SQLite connection (invariant)**: open it only through `db.Open`/`db.DSN` (tests:
  `dbtest.OpenMigrated`). The driver is modernc, which honors only `_pragma=…` DSN keys; `db.Open`
  fails if `foreign_keys` is not 1. Journal stays DELETE (no WAL): the DB may live in a synced folder.
- **Sync state (invariant)**: desktop⇄iPad copies are compared with a version vector
  (`sync_vector` plus `sync_state.dirty`, `backend/shared/db/syncstate.go`, mirrored in
  `engine/db/syncstate.ts`). Every new user-data table needs its three `sync_dirty_*` triggers in its
  migration. `MarkShared` runs before a copy leaves the device (backup, web export). The device id
  never lives in the DB. See `ARCHITECTURE.md` §20.
- **Web DB** (`frontend/src/engine/db/`): a .db import is proven in memory
  (`engine/db/importCheck.ts`) before it replaces OPFS, and the previous file is restored on
  failure; one tab owns the DB (`acquireDbLock`, Web Locks). The engine reuses the SAME
  `backend/*/migrations/*.up.sql` files, so exported `.sqlite` files are interchangeable
  desktop⇄web.
