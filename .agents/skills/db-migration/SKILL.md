---
name: db-migration
description: Create and register an embedded SQL migration for App Finance (bun/migrate + go:embed). Use when changing the data model — adding a table, column, or index.
---

# DB migration

Migrations are `.up.sql`/`.down.sql` pairs embedded per domain with `go:embed` and run on startup
by bun/migrate. The numeric filename prefix (`YYYYMMDDNNN`) sets **global** order across all domains.

1. **Pick the domain folder**: `backend/finance/migrations/` or `backend/users/migrations/`
   (a brand-new domain gets its own `migrations/` with `embed.go` — see the `new-domain` skill).
2. **Create the pair** with the next global prefix, higher than every existing file across all
   domains (check with `ls backend/*/migrations/*.up.sql backend/shared/*/migrations/*.up.sql`):
   `NNN_short_name.tx.up.sql` and `NNN_short_name.tx.down.sql`. The `.tx.` suffix makes bun run
   the file in one transaction (SQLite DDL is transactional), so a failure leaves nothing half
   applied; the migrator records a migration only after it succeeds, so it is retried next start.
   Multiple statements in one file are separated by a `--bun:split` line.
3. **Write the SQL**. User-owned tables carry a `user_id` column and are indexed by it; soft-deleted
   tables use a nullable `deleted_at`. SQLite caveat: `ALTER TABLE ADD COLUMN` works, but changing or
   dropping a column type does **not** — rebuild the table + copy (see the `period_salaries`
   composite-PK rebuild in `20260630010_users_multitenant.up.sql`). Always write the matching `.down`.
   **Foreign keys are ON** (desktop DSN and web engine), and `PRAGMA foreign_keys` cannot change
   inside a transaction: dropping a rebuilt table that other tables reference runs their
   `ON DELETE CASCADE` and wipes the children. Only rebuild leaf tables that way; for a referenced
   table, add columns instead or stop and design the rebuild explicitly.
4. **Register the embed.FS** in `backend/shared/db/migrator.go` **only when adding a new domain**
   `embed.FS`; extra `.sql` files inside an already-registered domain need no migrator change.
5. **Update the bun models** (struct tags) for the changed columns, and add/adjust an isolation test
   (`backend/users/isolation_test.go` pattern) if the change touches user-scoped data.
6. Run `go build . && go vet ./... && go test ./...` and report real results. Migrations apply on the
   next `wails3 dev` / app start.
