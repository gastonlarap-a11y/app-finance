# App Finance — Architecture

## 1. Project Overview

App Finance is a Wails v3 desktop **personal-finance manager** (Spanish UI). It tracks money month to
month: per-month salary and extra incomes, expenses (one-off or in credit-card installments/cuotas),
**recurring fixed expenses** (subscriptions that carry forward and support "edit from this month
onward"), cards (cupo + billing day), categories, and monthly/yearly summaries — backed by local
SQLite with optional Google Drive backup. It began from a zero-config Wails v3 template; the template
domains are gone and replaced by the `finance` and `settings` domains.

Stack:
- Go 1.25+ · Wails v3 (Service Pattern)
- bun ORM + bun/migrate (SQLite via modernc.org/sqlite — pure Go, no CGO)
- React 19 + Jotai + Tailwind CSS v4 (CSS-first, no JS config) + Vite
- slog structured logging (console via tint) (rolling file via lumberjack)
- Google Drive backup via `golang.org/x/oauth2` + `google.golang.org/api`

### Services (registered in `main.go`)

- **`finance`** (`backend/finance/`) — the core domain. Bound methods cover settings, per-month salary,
  cards, categories, incomes, expenses + installments, **fixed expenses**, and `MonthlySummary` /
  `YearSummary`. One file per entity (`card.go`, `expense.go`, `fixedexpense.go`, …) plus `period.go`,
  `result.go`, `service.go`.
- **`settings`** (`backend/settings/`) — DB-folder selection, Google Drive connect/disconnect, OAuth
  client config, backup-on-close, and `BackupNow`. Drives the "Ajustes" tab.
- **`diagnostics`** — error reporting. **`reports`** — Excel export (`backend/reports/excel.go`).

`main.go` also wires `prefs` (user prefs overriding config), a `drive.Manager`, and a `backup.Runner`
invoked from the `OnShutdown` hook when backup-on-close is enabled.

## 2. ⚠ Wails v3 Status

This project targets **Wails v3** (alpha as of 2026). The API is stable and
applications run in production, but alpha releases may introduce breaking changes.

**This project pins Wails to:** `v3.0.0-alpha2.108`
The `wails3` CLI **must match** this version (install with
`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.108`). The npm
`@wailsio/runtime` tracks its own `latest` (`3.0.0-alpha.94`), the series that pairs
with the Go alpha2.108 line. To change the pin: edit go.mod, run `go mod tidy`,
reinstall the matching CLI, then verify with `wails3 doctor`.

Requirements: Go 1.25+, Node.js 20+. Run `wails3 doctor` to verify.

- v2 docs: https://wails.io
- v3 docs: https://v3.wails.io

## 3. Service Pattern

Every domain is an autonomous Service. There is no `app.go` god object —
`main.go` is the only orchestration point. A service:
- has a constructor that receives its dependencies (e.g. `*bun.DB`),
- exposes `ServiceName() string`,
- optionally implements `ServiceStartup(ctx, application.ServiceOptions) error`
  and `ServiceShutdown() error` for lifecycle,
- exposes public methods that are auto-bound to TypeScript.

See `backend/finance/service.go` for the reference implementation.

## 4. Migration Strategy

Migrations are SQL files embedded with `go:embed` and run by bun/migrate on
startup (`backend/shared/db/migrator.go`, which registers `financemigrations` +
`windowstatemigrations`). The numeric filename prefix sets global order. Current set:

- `20260628003_create_app_settings.{up,down}.sql` (window state KV table)
- `20260628004_create_finance.{up,down}.sql` (settings, cards, incomes, expenses, installments)
- `20260628005_salary_categories.{up,down}.sql` (period_salaries, categories)
- `20260628006_create_fixed_expenses.{up,down}.sql` (fixed_expenses, fixed_expense_amounts, fixed_expense_payments)

Adding `.sql` files to an already-registered domain `embed.FS` needs no migrator change; only a brand
new domain `embed.FS` must be added to the slice. SQLite note: `ALTER TABLE ... ADD COLUMN` is
supported, but changing or dropping a column's type is not — write a new table + copy migration instead.

### Per-month & effective-dated data

Values that exist per month are keyed by a `period` (YYYY-MM) `TEXT` column and resolved by **lexical
string comparison** (zero-padded YYYY-MM sorts correctly), e.g. `period < ?` in
`cumulativeBalanceBefore` and `period LIKE 'YYYY-%'` in `YearSummary`. `PeriodSalary` keeps one value
per month. **Fixed expenses** implement carry-forward plus "edit from this month onward":
`fixed_expense_amounts(fixed_expense_id, effective_from, amount)` is resolved by taking the row with
the greatest `effective_from <= month`, so editing a month UPSERTs a new override row and leaves
earlier months untouched; `fixed_expense_payments` records paid/pending sparsely per month. The monthly
and yearly summaries fold fixed charges into gastos/balance/categorías alongside installments. See
`backend/finance/fixedexpense.go` and the fixed-expense methods in `service.go`.

## 4b. Backup & Google Drive

`backend/shared/backup` snapshots the live SQLite DB and (when Drive is connected) uploads it via
`backend/shared/drive`, a Google Drive OAuth2 manager (`golang.org/x/oauth2`, `google.golang.org/api`).
The `settings` service exposes connect/disconnect, OAuth client config, the Drive folder name, and
backup-on-close; `main.go` runs a backup in `OnShutdown` when that flag is on. `backend/shared/prefs`
persists these user choices and overrides `config` at startup (DB folder, OAuth creds, backup-on-close).

## 5. Configuration

config.toml is the source of truth. Environment variables override individual keys at runtime (useful for CI/testing).
Edit `config.toml` (gitignored) — copy from `config.example.toml`.
Loader: `backend/shared/config/config.go`.

## 6. Error Handling

- **System errors** (DB/file I/O): return a native Go `error` → Wails rejects
  the TypeScript promise.
- **Business errors** (validation, not-found, conflict): return a concrete Result
  struct with `*shared.AppError` set → the promise resolves; the frontend
  checks `result.error`. Codes live in `backend/shared/errors.go`.

## 7. Logging

slog is configured in `backend/shared/logger/logger.go` and installed via
`slog.SetDefault`. Change the level at runtime with the `LOG_LEVEL`
config key (`debug` | `info` | `warn` | `error`).
In debug mode, bun's `bundebug` hook logs every SQL statement.

## 8. Window State

Stored as JSON in the `app_settings` KV table (same DB), read before the
window opens and written on `WindowClosing`. See
`backend/shared/windowstate/`. To reset: delete the `window_state`
row, e.g. `DELETE FROM app_settings WHERE key = 'window_state';`.

## 9. Background Worker

`backend/shared/background/worker.go` is a generic goroutine pool. Inject it
into a service and start/stop it from `ServiceStartup`/`ServiceShutdown`, then
enqueue work with `worker.Enqueue(func(ctx) error { ... })`. Bound methods must
not block the call handler — hand heavy work to the worker and stream results via
emitted events. (The current finance methods are fast DB calls and don't use it.)

## 10. Adding a New Domain

```
1. mkdir backend/{domain}
2. Create model file(s), result.go, service.go
   (finance splits one file per entity instead of a single model.go — choose per domain size)
3. Create migrations/ folder with embed.go and .up.sql/.down.sql
4. Register the embed.FS in backend/shared/db/migrator.go (only for a brand-new domain embed.FS)
5. Register service in main.go Services slice
6. Run: wails3 generate bindings -ts
7. Re-export from frontend/src/services/{domain}.ts and import that (never bindings/ directly)
```

## 11. Frontend Bindings

Never import from `frontend/bindings/` directly across the app — it is
auto-generated by `wails3 generate bindings` (and gitignored). Wrap each
service in a single module and import that everywhere.

## 12. Decimal Precision

JavaScript numbers are IEEE-754 floats and silently lose precision on money
(e.g. 0.1 + 0.2). This template uses `backend/shared/types.Decimal`
(wrapping shopspring/decimal): stored as TEXT,
marshalled to JSON as a **string**. The frontend keeps `amount` as a string
and formats with `Intl.NumberFormat` — never `parseFloat` for math.

## 13. Build & Dev Tooling

`wails3 dev` and `wails3 build` read **`build/config.yml`** and drive the root
**`Taskfile.yml`**, which `includes:` the per-OS Taskfiles under `build/` (e.g.
`build/darwin/Taskfile.yml`). `build/` also holds the platform `Info.plist`,
icons, and `Assets.car`.

Common commands (each has a `task` shortcut):

| Command | Shortcut | Does |
|---|---|---|
| `wails3 dev` | `task dev` | Build + Vite dev server (`:9245`) + window + hot reload |
| `wails3 build` | `task build` | Production build → `bin/app-finance` (stripped) |
| — | `task package` | macOS `.app` bundle (ad-hoc signed) |
| — | `task package:dmg` | macOS `.dmg` disk image → `bin/app-finance.dmg` |
| — | `task build:windows` | Cross-compile Windows `.exe` (amd64) → `bin/app-finance.exe` |
| — | `task package:windows` | Windows NSIS installer (amd64) → `build/windows/nsis/app-finance-installer.exe` (requires `brew install makensis`) |
| `wails3 generate bindings -ts` | — | Regenerate `frontend/bindings/` |

The Vite dev integration lives in `frontend/vite.config.ts` via the
`@wailsio/runtime/plugins/vite` plugin (`wails('./bindings')`) plus a strict dev
port. After editing `build/config.yml` (product name, file associations, etc.),
regenerate the platform assets with `wails3 task common:update:build-assets`.

> Use `wails3` / `task` only — never `wails` (the v2 CLI), which can't read a v3
> `go.mod` and aborts.

