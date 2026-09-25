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
  cards, categories, incomes, expenses + installments, **fixed expenses**, **merchants**, and
  `MonthlySummary` / `YearSummary`. One file per entity (`card.go`, `expense.go`, `fixedexpense.go`,
  `merchant.go`, …) plus `period.go`, `result.go`, `service.go`.
- **`users`** (`backend/users/`) — multi-user profiles with no login (see §14). Owns the profile CRUD,
  the in-memory active-user `Session`, and soft-delete/restore of profiles.
- **`settings`** (`backend/settings/`) — DB-folder selection, Google Drive connect/disconnect, OAuth
  client config, backup-on-close, and `BackupNow`. Drives the "Ajustes" tab.
- **`mailsync`** (`backend/mailsync/`, desktop only) — reads the bank's purchase-alert emails over
  IMAP and stages them in the finance import inbox (see §18). Drives "Ajustes → Correo de alertas".
- **`updates`** (`backend/updates/`, desktop only) — in-app updates from GitHub Releases (see §19).
- **`diagnostics`** — error reporting. **`reports`** — Excel export (`backend/reports/excel.go`).

`main.go` also constructs the `users.Session` (seeded from `prefs.ActiveUserID`) before the finance
service, wires `prefs` (user prefs overriding config), a `drive.Manager`, and a `backup.Runner`
invoked from the `OnShutdown` hook when backup-on-close is enabled.

## 2. ⚠ Wails v3 Status

This project targets **Wails v3** (beta since 2026-08: the desktop API is
stable, releases are still pre-release nightlies).

**This project pins Wails to:** `v3.0.0-beta.25`
The `wails3` CLI **must match** this version (install with
`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.25`) — different
CLI versions generate different binding models. The npm `@wailsio/runtime` uses
the same version (`3.0.0-beta.25`). To change the pin: `go get
github.com/wailsapp/wails/v3@<ver>`, `go mod tidy`, `npm i @wailsio/runtime@<ver>`,
reinstall the matching CLI, regenerate bindings, then verify with `wails3 doctor`
and `task check`.

Requirements: Go 1.27+, Node.js 24 LTS. Run `wails3 doctor` to verify.

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
startup (`backend/shared/db/migrator.go`, which registers `financemigrations`, `usersmigrations` +
`windowstatemigrations`). The numeric filename prefix sets global order across all domains. Current set:

- `20260628003_create_app_settings.{up,down}.sql` (window state KV table)
- `20260628004_create_finance.{up,down}.sql` (settings, cards, incomes, expenses, installments)
- `20260628005_salary_categories.{up,down}.sql` (period_salaries, categories)
- `20260628006_create_fixed_expenses.{up,down}.sql` (fixed_expenses, fixed_expense_amounts, fixed_expense_payments)
- `20260630010_users_multitenant.{up,down}.sql` (users table + `user_id` on every finance table; rebuilds `period_salaries` with a composite PK)
- `20260630011_finance_soft_delete.{up,down}.sql` (`deleted_at` on cards/categories/incomes/expenses/fixed_expenses; partial unique index on active category names)
- `20260630012_soft_delete_users.{up,down}.sql` (`deleted_at` on users)
- `20260702013_create_merchants.{up,down}.sql` (merchants table + `expenses.merchant` text column)

(Later sets — budgets, savings, import inbox, mail accounts, card statements — follow the same scheme;
`ls backend/*/migrations` is the source of truth.) `20260926019_fk_orphan_cleanup.tx.up.sql` applies
the cascades desktop builds up to 0.3.2 skipped: their DSN used mattn-style keys that the modernc
driver ignores, so foreign keys were off.

Adding `.sql` files to an already-registered domain `embed.FS` needs no migrator change; only a brand
new domain `embed.FS` must be added to the slice. SQLite note: `ALTER TABLE ... ADD COLUMN` is
supported, but changing or dropping a column's type is not — write a new table + copy migration instead
(see the `period_salaries` composite-PK rebuild in migration 010). With foreign keys on, dropping a
table that others reference cascades into them — only rebuild leaf tables that way.

Safety rails (`migrator.go`, `main.go`): the migrator records a migration only after it succeeds
(`WithMarkAppliedOnSuccess`) and new files use bun's `.tx.up.sql` suffix to run in one transaction;
before applying anything to an existing DB, `main.go` snapshots it to `<backups>/pre-migrate/` (last 3
kept); a DB carrying unknown migrations that sort after this binary's latest one (opened by a newer
version) is refused with `db.ErrNewerSchema` before anything is written. Unknown migrations that sort
before it are retired ones and are ignored: early databases still record the original template's
`20260628001`/`20260628002`.

Connection (`db.go`): `db.DSN` passes `_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)` plus
`_txlock=immediate`, and `db.Open` fails unless `PRAGMA foreign_keys` reads 1. The journal stays in
DELETE mode on purpose — the DB folder may be synced by iCloud/Dropbox, and WAL side files synced out
of step can corrupt it. Tests open DBs through `dbtest.OpenMigrated`, i.e. with the same settings.

### Per-month & effective-dated data

Values that exist per month are keyed by a `period` (YYYY-MM) `TEXT` column and resolved by **lexical
string comparison** (zero-padded YYYY-MM sorts correctly), e.g. `period < ?` in
`cumulativeBalanceBefore` and `period LIKE 'YYYY-%'` in `YearSummary`. `PeriodSalary` keeps one value
per month. **Fixed expenses** implement carry-forward plus "edit from this month onward":
`fixed_expense_amounts(fixed_expense_id, effective_from, amount)` is resolved by taking the row with
the greatest `effective_from <= month`, so editing a month UPSERTs a new override row and leaves
earlier months untouched; `fixed_expense_payments` records paid/pending sparsely per month. The monthly
and yearly summaries fold fixed charges into gastos/balance/categorías alongside installments. See
`backend/finance/fixedexpense.go` and the fixed-expense methods in `service.go`. Payments and amount
changes are accepted only for months the fixed expense bills in (`requireActiveIn`), and it can only be
ended after its first month (ending it there would leave a row that never bills: delete it instead).

Periods are compared as strings, which orders correctly only while every year has four digits, so
dates and periods are bounded to 2000–2099 and plans to 120 cuotas (`minYear`/`maxYear`/
`maxInstallments`; the UI's cuota field already stopped at 120).

**Editing an expense** follows the ledger rule that recorded payments are not rewritten:
`replanInstallments` adapts the existing cuotas by number instead of regenerating them. Ids stay stable,
so `card_statement_lines.installment_id` links survive. A new amount reaches pending cuotas only, and
cuota 1 keeps its month while the old and new date/card lead to the same billing month, because that
month may come from a card statement (`ConfirmImportItem`'s `FirstPeriod`). Dropping a paid cuota or
moving a plan that has paid cuotas is refused until the user unmarks them.

The effective-dated lookup is generic (`effectiveDated` rows → `latestAsOf` / `resolveAsOf`), and
`sumAsOf` totals a month range by multiplying each amount stretch instead of walking month by month —
so `cumulativeBalanceBefore` (and every summary that carries the balance forward) no longer grows with
the history length. **Category budgets** (`category_budgets`, `budget.go`) reuse the same scheme keyed
by `category_id` (renames keep the budget; the rows ride along with the category into the trash);
`MonthlySummary.Presupuestos` compares each cap in effect with the month's `PorCategoria` total.

Read-only aggregates built on top: `CommitmentsForecast` (`forecast.go` — future installments + active
fixed expenses vs. salary, reusing the last known salary for months without one) and `SearchExpenses`
(`search.go` — LIKE with escaped wildcards, category/card/period-range filters, paginated with a count).
`YearSummary.CategoriaMeses` is the category × month breakdown (same pass that builds `PorCategoria`).

**Savings goals** (`savings.go`, migration `20260923015`): `savings_goals` (soft delete, Papelera) and
`savings_contributions` (per month, hard delete, ride along with their goal). Contributions are an
outflow of their month: `MonthlySummary.Ahorro`, `Balance = Disponible − Gastos − Ahorro`,
`Alcanza = Disponible ≥ Gastos + Ahorro`, and they are subtracted in `cumulativeBalanceBefore`, the
year view and the forecast. `SpendingTrend` (`trend.go`) compares a month with the previous one and the
average of the earlier months of a 2–24-month window, overall and per category (`spendingByMonth`).
`DetectRecurring` (`recurring.go`) groups one-off expenses of the last 6 months by merchant (or
description), keeps amounts within ±15 % of the group median and suggests those seen in ≥ 3 months
that are not already a fixed expense; the UI converts one via `CreateFixedExpense` starting the month
after its last charge, so nothing is counted twice.

## 4b. Backup & Google Drive

`backend/shared/backup` snapshots the live SQLite DB and (when Drive is connected) uploads it via
`backend/shared/drive`, a Google Drive OAuth2 manager (`golang.org/x/oauth2`, `google.golang.org/api`).
The `settings` service exposes connect/disconnect, OAuth client config, the Drive folder name, and
backup-on-close; `main.go` runs a backup in `OnShutdown` when that flag is on. `backend/shared/prefs`
persists these user choices and overrides `config` at startup (DB folder, OAuth creds, backup-on-close).

Local snapshots are timestamped (`<name>-YYYYMMDD-HHMMSS.db`, last 5 kept) and each is written with
`VACUUM INTO` to a `.tmp` file renamed into place, so a failed backup never destroys the previous one;
Drive still holds one file, overwritten by each upload. When the DB file did not exist at startup (a DB
folder that went missing, e.g. an unsynced cloud folder), the runner refuses to back up while earlier
backups exist (`backup.ErrFreshDatabase`), so an empty DB never replaces them. `ApplyDBFolder` requires
an absolute path, compares with `os.SameFile`, and refuses a folder that already holds a DB.

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
config key (`debug` | `info` | `warn` | `error`). The rotated JSON file goes to
`config.LogDir()` — `<app data dir>/logs/app.log` (macOS: `~/Library/Application Support/App
Finance/logs/`), never a relative path: a packaged app runs with `/` as its working directory.
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
emitted events. `mailsync` is the reference user: a single-concurrency worker runs mailbox syncs
(queued by `SyncNow` and by an auto-sync loop owned by the service) and reports each outcome with
`application.Get().Event.Emit("mailsync:done", SyncEvent)`, which the frontend receives through
`onMailSyncDone` (`services/mailsync.ts`, `Events.On` from `@wailsio/runtime`). The finance methods
are fast DB calls and don't use it.

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

The generated models type `types.Decimal` as `any`, so the wrappers
(`services/finance.ts`, `services/users.ts`) export the service typed as the
hand-written contract (`services/contract.ts`) — `const FinanceService:
FinanceServiceContract = Bound`. That single assignment makes the desktop
typecheck fail whenever a Go signature changes without the contract (and hence
the web engine) following, and gives the whole UI string-typed money. CI's
macOS job installs the go.mod-pinned `wails3`, generates the bindings and runs
that typecheck.

## 12. Decimal Precision

JavaScript numbers are IEEE-754 floats and silently lose precision on money
(e.g. 0.1 + 0.2). This template uses `backend/shared/types.Decimal`
(wrapping shopspring/decimal): stored as TEXT,
marshalled to JSON as a **string**. The frontend keeps `amount` as a string,
formats it with `formatCLP` (Intl.NumberFormat accepts the decimal string
directly, no float round-trip) and compares/sums with `lib/money.ts`
(decimal.js) — never `Number()`/`parseFloat` for money decisions.

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

## 14. Multi-user profiles (no login)

The app supports several profiles over a **single** SQLite database — there is no auth. Every
finance row carries a `user_id`; the currently active id lives in an in-memory `users.Session`
(`backend/users/session.go`) and is persisted through `prefs.ActiveUserID` so it survives restarts.
`main.go` builds the `Session`, resolves the active id, and injects it into both `users` and
`finance` services.

`FinanceService` reads the active id via `s.uid()` (= `session.Active()`) and scopes **every** query
by it (`WHERE user_id = ?`). Switching profiles only mutates the in-memory id + triggers a frontend
refetch (`UserSwitcher.tsx`) — the DB connection is never reopened, so the switch is instant. The
per-user isolation guarantee is covered by `backend/users/isolation_test.go`; add a similar test
whenever a new bound method reads user-owned data.

## 15. Soft delete & trash

Cards, categories, incomes, expenses, fixed expenses and users use bun's `soft_delete` (a nullable
`deleted_at` column + the `bun:",soft_delete"` struct tag). Deleting sets the timestamp instead of
removing the row; list queries exclude soft-deleted rows automatically, and the frontend "Papelera"
(`TrashView.tsx`) lists and restores them. Category-name uniqueness is a **partial** unique index
scoped to `deleted_at IS NULL`, so a deleted name can be reused and a restore never collides with an
active row. See migrations `011` (finance) and `012` (users).

## 16. Merchants

`backend/finance/merchant.go` is a user-managed list of "comercios". Expenses store the merchant as
plain text (`expenses.merchant`), not a foreign key — renaming or deleting a merchant does not cascade
to historical expenses, which keep the text they were saved with. Surfaced in `MerchantsView.tsx`.


## 17. Web/PWA target (iPad)

Besides the Wails desktop app, the same frontend ships as an **installable PWA** with a
**local TypeScript engine** replacing the Go backend — no server involved:

- **Build selection**: `vite --mode web` (`npm run dev:web` / `build:web`). In web mode
  `vite.config.ts` aliases `@/services/{finance,users,settings}` to `frontend/src/services/web/*`
  and skips the Wails plugin; the default mode (what `wails3 dev/build` runs) is untouched.
  `frontend/tsconfig.web.json` mirrors the alias for the web typecheck and excludes the three
  bindings wrappers. `import.meta.env.VITE_TARGET` (`define`-inlined: 'web' | 'desktop') gates
  web-only code so each bundle drops the other target's modules.
- **Contract**: `frontend/src/services/contract.ts` hand-mirrors the Go models/result shapes and
  the bound service surfaces. Both the Wails wrappers (structurally) and the web adapters
  (explicitly) satisfy it. **Adding/changing a bound Go method requires updating contract.ts and
  the engine port.**
- **Engine**: `frontend/src/engine/` is a 1:1 TypeScript port of `backend/finance` +
  `backend/users` over sqlite-wasm (`@sqlite.org/sqlite-wasm`, `opfs-sahpool` VFS — persistent
  OPFS, no COOP/COEP headers, single connection) running in a dedicated Worker
  (`engine/db/worker.ts`, Comlink RPC). Money uses `decimal.js` internally, strings at the edges.
- **Shared migrations**: the engine raw-imports the same `backend/*/migrations/*.up.sql` files
  (glob — new migrations are picked up automatically), replicates bun's `--bun:split` parsing and
  its `bun_migrations` bookkeeping (name = numeric filename prefix). This makes an exported
  `.db` file **interchangeable between desktop and web** (the desktop-only `windowstate` and
  `mailsync` sets and the web's `web_prefs` table are each ignored by the other side).
- **Backup**: web has no Drive; Ajustes offers export/import of the SQLite file
  (`services/web/settings.ts` + Share-Sheet-aware `lib/exportFile.ts`). Import validates the file's
  bytes first (`engine/db/dbfile.ts`), then reopens the imported database to report what it held
  (`ImportSummary`) before the mandatory page reload. **No `window.confirm`/`alert` anywhere in this
  flow** and **no `accept` on the file input**: Safari suppresses native dialogs without a live user
  activation, and iPadOS greys out `.db`/`.sqlite` files when `accept` is set (no system UTI owns
  those extensions). Both turned a failed restore into a screen that just looked empty.
- **Tests**: `npm test` (vitest) runs the engine against the same sqlite-wasm build in Node
  (in-memory), including a mirror-integration suite (`engine/finance/service.test.ts`).
- **Deploy**: `.github/workflows/deploy-web.yml` publishes `frontend/dist` (built with
  `base: /app-finance/`) to GitHub Pages on pushes to `main`.

## 18. Import inbox (bank emails & statements)

Movements detected by the bank reach the app through **one reviewed inbox** — nothing becomes an
expense until the user confirms it:

- **Inbox** (`backend/finance/importitem.go` + `imports.go`, mirrored in the TS engine):
  `import_items` rows move `pendiente → confirmado` (new expense via `ConfirmImportItem`, or an
  existing one via `LinkImportItem`) or `→ descartado`. `StageCandidates(ctx, idb, uid, batch)` is
  the single entry point (bound `StageImport` for statements; `mailsync` passes its own tx). It
  rejects a batch whole if any candidate is invalid, dedupes by a per-user `external_key` built from
  the candidate's stable fields + its ordinal among identical ones (re-importing adds nothing), and
  **reconciles** across source families: a statement line matching an unmatched alert email (same
  amount/currency, compatible last digits, ±1 day) is stored `conciliado` so a purchase is never
  reviewed twice. `ListImportItems` suggests the card (by `cards.last_digits`), the learned
  `merchant_rules` (longest word-prefix of the normalized descriptor, `descriptor.go`), a live
  expense that looks like the same purchase (±2 days, cuota or total), and a fixed expense whose
  unpaid month the charge looks like the bill of (`fixedmatch.go`, Actual Budget's schedule model:
  a significant word of the name must match, the amount only within ±7.5 %, because a fixed
  amount is an estimate). `LinkImportItemToFixed` marks that month paid and, for a CLP charge,
  makes the bank's real amount that month's amount only (an override at the month, the plan
  restored the month after). The item's `kind` is fixed at staging and every confirm path checks
  it: an abono never becomes an expense, nor a charge an income. A USD item needs a whole-peso
  amount other than its USD figure (CLP has no minor unit, ISO 4217). A confirmed item whose
  expense, income or fixed expense went to the trash can be reopened (`RestoreImportItem`,
  `reopenable` in the view); an expense takes the link of one item only.
- **Statements (PDF, desktop + web)**: parsed in the frontend only (`frontend/src/lib/statements/`),
  then staged with `StageImport`. `pdfText.ts` is the only pdf.js module (dynamic import; its worker
  is precached by the PWA). Parsers work on positioned runs: **rows are rebuilt from y coordinates**
  (`layout.ts`), never from text order, because statements come out column by column. One parser per
  issuer/format (`detect.ts` registry); each reports notes (what it skipped on purpose) and
  warnings (e.g. the Itaú cartola replays daily balances and flags a mismatch). Fixtures are
  **anonymized** `TextRun` JSON produced by `frontend/scripts/pdf-runs.mjs` — never commit a real
  statement (the repo is public). A parser returns either a batch (cartola → `StageImport`) or whole
  card statements (`ParsedStatement` union). Only card payments carry a hint (`card_payment`, warned
  in the inbox and kept out of bulk confirm); transfers are ordinary spending.
- **Credit-card statements** (`backend/finance/cardstatement.go`, mirrored in the engine; parser
  `itau/cardStatement.ts`): one Itaú PDF carries a national (CLP) and an international (USD)
  statement, each stored in full by `ImportCardStatement` — `card_statements` (header, limits,
  rates, previous period, totals, unique per user+digits+kind+date), `card_statement_lines` (every
  movement by section `pago|compra|voluntario|cargo|abono`, cuota n/N and the bank's exact cuota)
  and `card_statement_schedule` (the bank's coming months). In one transaction it links a cuota n
  that continues an app expense (same card, N, cuota, date ±1) to that installment, reconciles the
  statement's payments with the cartola's `card_payment` items (both directions; pending or already
  discarded, since a discarded payment is the same bank fact; the USD payment also teaches the
  CLP/USD rate → `suggestedAmountClp`), and stages the rest: every purchase and fee keeps
  `first_period` (cuota 1's month; the statement's own month for a one-payment purchase or a fee)
  so `ConfirmImportItem` bills it in the month the bank did and marks earlier cuotas paid; credits,
  and negative lines of any charge section (reversals, refunded fees), stage as `kind = abono` →
  `ConfirmImportItemAsIncome`. The
  parser cross-checks the bank's totals (sections, A+B+C+D, credit used, USD debt) into warnings;
  its fixture (`itau/testdata/cardStatementRuns.ts`) is synthetic text on the real geometry.
- **Alert emails (desktop only)** — `backend/mailsync`: IMAP (`go-imap/v2`, read-only `EXAMINE`,
  `BODY.PEEK[]` so nothing is marked read), MIME/charsets via `go-message`, HTML reduced to text.
  Incremental by **UIDVALIDITY + last UID** per account; the server filters by sender (`FROM`), and
  each fetched chunk's items and watermark commit in one transaction. The password lives in the OS
  keychain (`go-keyring`), never in the DB or prefs. Email parsers implement `EmailParser`
  (`parsers.go` registry); emails nobody recognizes are counted and reported, not guessed.

## 19. In-app updates (desktop)

`backend/updates` drives Wails v3 `pkg/updater` with its GitHub provider over this repo's Releases:
check at startup (+20 s) and every 6 h → banner (`UpdateNotice.tsx`) → `InstallUpdate` downloads in
the background (progress: `wails:updater:download-progress`) and verifies the SHA-256 from
`SHA256SUMS.txt` → `RestartToUpdate` backs up, then Wails spawns the app itself in helper mode, which
waits for the app to exit, swaps the `.app` bundle / `.exe` (keeping a `.bak` to roll back) and
relaunches it (`open -n` on macOS). State changes reach the UI through `updates:changed`, emitted
after the service records them (Wails' own events fire earlier).

Constraints, all verified on macOS with the real bundle and the real updater code:
- `updater.HandleHelperMode()` is the first call in `main()` (the helper must not open the DB).
- Releases whose artifact is missing from `SHA256SUMS.txt` are refused (Wails would install them
  unverified).
- The helper aborts if the app takes > 30 s to exit, so the close-time backup runs inside
  `RestartToUpdate` and `OnShutdown` skips it (`Restarting` flag).
- The macOS zip must be built with `ditto --norsrc --noextattr --noacl`; the extracted bundle keeps
  a valid ad-hoc signature and carries no quarantine flag, so Gatekeeper does not prompt again.
- The app refuses to self-update when it cannot write next to itself (read-only folder, mounted
  `.dmg`), runs translocated (not moved to Aplicaciones) or is a `wails3 dev` build.
- Windows installs per user (`INSTALL_SCOPE: user`) so the exe can be replaced without UAC.
- The PWA (web build) updates through its service worker; `services/web/updates.ts` is a stub.
