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
  client config, backup-on-close, and `BackupNow`. Drives Configuración › Respaldo y Google Drive.
- **`updates`** (`backend/updates/`, desktop only) — in-app updates from GitHub Releases (see §19).
- **`reminders`** (`backend/reminders/`, desktop only, no bound methods) — native due-date
  notifications (see "Due dates and reminders" in §4).
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
`cumulativeBalanceBefore` and `period LIKE 'YYYY-%'` in `YearSummary`. **Salary** (`salary.go`,
migration `20260929041`): `PeriodSalary` is the salary confirmed for one month; `salary_plans(user_id,
effective_from, amount, active)` is the base salary, effective-dated like fixed-expense amounts
(`SetBaseSalary`, `EndBaseSalary` writes `active = 0`). A month without a confirmed salary takes the base
in effect as *expected* (`PeriodSalary.Expected`, `MonthlySummary.SalaryExpected`), the way Actual
Budget's schedules add a paycheck until the real one replaces it; `DeleteSalary` goes back to it. Every
reader goes through `salaryByMonth` — the month, `flowsBetween`, the year, the forecast, the accounts
and `salary_rest` transfers — so none reads a missing salary as zero. **Fixed expenses** implement carry-forward plus "edit from this month onward":
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
so `card_statement_lines.installment_id` links survive. A pending cuota changes only as far as the edit
does: it takes a new cuota amount only when the edit changes it (otherwise it keeps its own — the bank's
rounded last cuota, one set by hand), and it keeps its month while the old and new date/card lead to
the same billing month, because that month may come from a card statement (`ConfirmImportItem`'s
`FirstPeriod`) or a prepayment. Cuotas added to a plan that did not move follow its last one. Dropping
a paid cuota or moving a plan that has paid cuotas is refused until the user unmarks them.

The effective-dated lookup is generic (`effectiveDated` rows → `latestAsOf` / `resolveAsOf`), and
`sumAsOf` totals a month range by multiplying each amount stretch instead of walking month by month —
so `cumulativeBalanceBefore` (and every summary that carries the balance forward) no longer grows with
the history length. **Category budgets** (`category_budgets`, `budget.go`) reuse the same scheme keyed
by `category_id` (renames keep the budget; the rows ride along with the category into the trash);
`MonthlySummary.Presupuestos` compares each cap in effect with the month's `PorCategoria` total:
`Over` past the cap, `Near` from 80 % of it (`budgetAlertPercent`, the usual early warning), shown as
red and amber alerts atop the month view.

**Performance (measured, not guessed).** `backend/finance/bench_test.go` seeds 5 years of history
(≈3.000 expenses, cuotas, fixed expenses, a statement a month, 200 inbox items) and times the hot
paths (`go test -run '^$' -bench . -benchmem ./backend/finance`); `frontend/src/engine/finance/
summaries.perf.test.ts` does the same for the web engine (`BENCH=1`). Rules that came out of it:
- read only the columns a total needs (`sumAmounts`, `pendingByCard`, `cardChargesIn`) — full rows
  with their timestamps were 95 % of MonthlySummary's allocations; money is still summed as decimals
  in code, never with SQLite's float `SUM()`;
- never call a whole summary to get one of its figures: the statement list needs each card's month
  charges (`cardChargesIn`), not `monthlySummary` per billed month (1,4 s → 10 ms on 5 years);
- load a list's per-row data in one query (statement lines/pending counts, the inbox's duplicate
  candidates over a date span and its matched items) instead of one query per row;
- composite indexes put the equality first (`user_id`) and the range or second filter after
  (migration `20260926021`); dates are compared as `YYYY-MM-DD…` string ranges, which both stored
  formats share and an index can serve (`julianday(substr(date…))` cannot).

Read-only aggregates built on top: `CommitmentsForecast` (`forecast.go` — future installments + active
fixed expenses vs. salary: a month's confirmed or base salary, else — only without a base salary — the
last confirmed one) and `SearchExpenses`
(`search.go` — LIKE with escaped wildcards, category/card/period-range filters, paginated with a count).
`YearSummary.CategoriaMeses` is the category × month breakdown (same pass that builds `PorCategoria`).

**Savings goals** (`savings.go`, migration `20260923015`): `savings_goals` (soft delete, Papelera) and
`savings_contributions` (per month, hard delete, ride along with their goal). Contributions are an
outflow of their month: `MonthlySummary.Ahorro`, `Balance = Disponible − Gastos − Ahorro`,
`Alcanza = Disponible ≥ Gastos + Ahorro`, and they are subtracted in `cumulativeBalanceBefore`, the
year view and the forecast. A withdrawal (`WithdrawSavings`) is a negative contribution: the same sums
give the money back to its month, and a goal never goes below zero (withdrawing more than it holds, or
deleting a contribution a withdrawal relies on, is refused). A goal past its target month and still
short is `Overdue`, flagged in the Ahorro view. A goal may instead **follow a savings account**
(`savings_goals.account_id`, migration `20260929040`, `SetSavingsGoalAccount`; one live goal per
account), as Monarch and Copilot link goals to accounts: it holds that account's balance at the
current month (`accountsSummary`), and the money transfers move into the account, net of what they
move out of it, is that month's Ahorro (`goalTransfers`, added by `savingsIn`/`savingsBetween`/
`savingsByMonth`, so the month, the carried balance, the year and the forecast agree). Such a goal
takes no contributions by hand, and one with contributions cannot follow an account. `SpendingTrend` (`trend.go`) compares a month with the previous one and the
average of the earlier months of a 2–24-month window, overall and per category (`spendingByMonth`).
`DetectRecurring` (`recurring.go`) groups one-off expenses of the last 6 months by merchant (or
description), keeps amounts within ±15 % of the group median and suggests those seen in ≥ 3 months
that are not already a fixed expense; the UI converts one via `CreateFixedExpense` starting the month
after its last charge, so nothing is counted twice.

**Fixed-expense schedules and UF** (`fixedexpense.go`, `uf.go`, migration `20260926023`): a fixed
expense bills every `interval_months` (1, 2, 3, 4, 6, 12) from its start (`billsIn`; `activeIn` is only
its life span) and is priced in `currency` CLP or UF. Both are set at creation — changing them would
move or re-price recorded charges. `fixedCharge` is the single rule every summary uses (month, year,
forecast, trend, carried balance, inbox matching, trash): the amount in effect, times the UF value of
that month when in UF, rounded half away from zero to whole pesos (`MulRound`). `uf_values(period,
value)` holds the UF of day 1 of each month; it is public data (no `user_id`). A month without a
value borrows the closest known one and the movimiento says so (`Estimado`, shown as "estimado").
The backend never goes online for it: `lib/uf.ts` (shared by desktop and web) asks
`UFMonthsNeeded`, downloads those years from mindicador.cl (free, no key, CORS `*`; allowed in the
web CSP) and stores them with `SetUFValues`. `fixedTotal` keeps the carried balance of monthly CLP
expenses O(amount changes) (`sumAsOf`) and walks billing months for the rest. Paying or linking a
bank charge to a month off the schedule is refused (`requireBillsIn`).

**Tags** (`tag.go`, migration `20260926025`), like Monarch's tags or Actual's #tags: labels across
categories (viaje, trabajo, deducible). `tags(user_id, name, name_key)` (the lowercase key keeps
"Viaje" and "viaje" one tag) and `expense_tags(expense_id, tag_id)`, which has no `user_id` and is
written only after proving the expense is the profile's (`SetExpenseTags` replaces an expense's set:
at most 10 tags of up to 30 characters). They show on the month's movimientos; `SearchExpenses`
filters by one and returns `Sum`, the total of every match (not just the page) — "¿cuánto costó el
viaje?". Renaming onto another tag's name is refused; deleting a tag removes it from its expenses.

**Refunds** (`refund.go`, migration `20260926024`), as YNAB and Monarch treat them: `refunds(expense_id,
period, amount)` is money returned for one expense (a store return, a bank reversal), partial or
total, never more than the expense cost — the sum of its cuotas, which an uneven plan makes differ from
cuota × N (`expenseCost`, `insertRefund`). It is a negative movimiento of the month it
arrives in (`SourceReembolso`, status pagado) in its expense's category and card, so `Gastos`,
`PorCategoria`, budgets, the card's month charges (`cardChargesIn`, statement comparison), the year,
the trend and the carried balance (`flowsBetween`) are all net of it; the forecast adds it to
`Libre`. Refunds ride along with their expense: a trashed expense's refunds count nowhere. A pending
CLP bank credit named like a purchase of the last 120 days that cost at least as much gets a
suggestion (`refundOf`) and `ConfirmImportItemAsRefund` links it (`import_items.refund_id`); deleting
the refund lets the credit go back to review.

**Reconciliation / opening balance** (`reconciliation.go`, migration `20260926022`), the reconciliation
of Actual Budget and YNAB on this app's monthly grain: `reconciliations(user_id, period, amount)` is the
real account balance at the close of a month (may be negative). `cumulativeBalanceBefore` starts from
the latest one before the month and adds only the flows after it (`flowsBetween`: salaries + extras −
cuotas − fixed − ahorro in `(after, before)`), so an unrecorded cash expense stops skewing every later
month once the user reconciles. The "saldo inicial" is the same record on the month before the first
one tracked. `MonthlySummary.Conciliacion` shows real vs computed (`Balance`) and the difference;
`AcumuladoDesde` says which close the carried balance comes from. `YearSummary` and
`CommitmentsForecast` reset their running balance at a reconciled close (`YearMonth.Conciliado`).
A month that has not started cannot be reconciled.

**Budget rules** (`budget.go`, migrations `20260927029`–`030`). A budget row is either a cap
(`capped = 1`, and `0` is a real cap: "no gastar en X") or the end of one (`RemoveCategoryBudget`
writes `capped = 0` from a month on). A category with `rollover` carries last month's unspent cap
into the next (`rolloverCarries`, `BudgetStatus.Carried`): only a positive remainder carries, and a
month without a cap restarts the chain. «Sin categoría» is the bucket of uncategorized spending, so
no category may take that name (`validCategoryName`; migration 029 renamed an existing one to
«Sin categoría (propia)»).

**Cuotas the bank rounds, and paying a plan off** (`installments.go`). `SetInstallmentAmount` edits
one pending cuota (uneven plans). When a bank movement confirms or merges into a plan,
`settleLastCuota` makes the last cuota absorb the rounding, so the cuotas add up to the bank's total.
`PrepayExpense` moves every pending cuota into `period` (the month the balance is paid), keeping each
amount; paid cuotas stay where they are.

**Receivables** (`receivable.go`, migration `20260927031`) cover shared expenses: the part of an
expense someone else owes (`person`, `amount` ≤ the expense's cost, `expenseCost`). Settling one records a refund on that
expense in the month it arrives (`SettleReceivable` → `insertRefund`), so every total nets it through
the refund path. An open receivable changes nothing.

**Purchases in another currency** (`currency.go`, migration `20260927032`). The expense stays in
pesos for every total (`installment_amount`), and additionally keeps `currency`, `original_amount`
(its total there) and `fx_rate`. `ConfirmImportItem` records them from a foreign-currency item
(`recordItemCurrency`), and `LatestFxRate` suggests the CLP/USD rate implied by the last
international card payment.

**Accounts, light** (`account.go`, migrations `20260927033`, `20260928036`). An account
(corriente, vista, digital — a prepaid wallet such as Mercado Pago —, efectivo, ahorro) is a lens on
the same ledger, never a second one: `accounts` rows with an opening balance and month, plus a
nullable `account_id` on expenses, incomes, cards and fixed expenses. `ListAccounts` attributes each
month's flows (`accountFlows`): the salary to the one `receives_salary` account, incomes to theirs,
cuotas and refunds to the expense's account or its card's, and fixed charges to their own account or
their card's. `AccountsSummary.Unassigned*` shows what no account claims. The app's
`Disponible`/`Balance` do not change.

**Card payments in the accounts view** (`cardpayment.go`, migration `20260929039`). A card purchase is
spending of the month its statement bills it (month view, carried balance, budgets), but the money
leaves the account that pays the card when that statement is paid — the card payment is a transfer on
the day it is paid, as in YNAB, Monarch and Copilot. `accountFlows` books cuotas, fixed charges and
refunds on a card in `paymentPeriod`: the month of the imported statement's «pagar hasta» (the
earliest of the card's national/international statements of that month); else the card's
`payment_day` (`SetCardPaymentDay`: the same month when it comes after the cutoff day, the next one
otherwise); else the month after. It looks `cardPaymentLookback` months back for charges paid inside
the range, and `AccountsSummary.Cards` (`CardOwed`) is what each card had billed and not yet paid at
the month's close — the liability between the accounts' balances and the app's balance.

**Transfers** (`transfer.go`) move money between two own accounts (the salary passed from the bank
it lands in to the everyday one, topping up a digital wallet): one-off (`end_period =
start_period`) or monthly (`end_period = ''`, ended with `EndTransfer`). They are neither spending
nor income, so they never enter `flowsBetween` or a month's summary; they only move the two
accounts' balances (`AccountView.TransferIn/Out`). Deleting an account deletes its transfers
(`ON DELETE CASCADE`). A transfer's `mode` (migration `20260929038`) says what it moves each month:
`fixed` moves `amount`; `salary_rest` moves that month's salary minus `amount`, which stays behind
(the salary lands in one bank, the mortgage is debited there, the rest goes on to the everyday
account). It never moves less than nothing, and a month without a salary yet moves 0. Only the
account that receives the salary can be its source (`ownAccounts`), and while one is live (open-ended
or ending this month or later) the salary cannot move to, or be cleared from, another account
(`keepSalaryRestSource`): the transfer would keep passing on a salary that lands elsewhere.

**Account reconciliations** (`accountreconciliation.go`, migration `20260929038`) are the monthly
reconciliation per account: the real balance at a month's close, as the bank shows it. From the
next month on, `ListAccounts` starts the account's balance there instead of adding every flow since
the opening (`accountStart`), so an unrecorded fee stops skewing it; the opening balance is set once.
The reconciled month keeps its computed balance and shows `AccountView.Conciliacion`
(real/computed/difference). A reconciliation before the account's opening is ignored. Like the
accounts, they are a view: the month's summary never changes.

**Due dates and reminders** (`dues.go`, migration `20260927034`; `backend/reminders`).
`UpcomingDues(today, days)` lists what is still unpaid and falls due from `today` to `days` later,
plus what fell due in the last 10 days:
- a card falls due on its imported statement's «pagar hasta» date. What it owes is its pending
  cuotas and fixed charges of the statement's month, so a paid card drops off;
- a fixed expense without a card falls due on its `due_day` (clamped to the month's last day). One
  on a card is paid with the card's statement.

Both builds show them atop the month view (`DuesBanner`). The desktop `reminders` service adds a
native notification: Wails' `pkg/services/notifications`, at most one a day (`prefs.LastDueReminder`),
3 days ahead, checked 20 s after launch and hourly. It starts the notifier itself instead of
registering it, because the notifier's startup fails without a bundle id (`wails3 dev`), and a
missing reminder must never block the app. The iPad/PWA build has no background push: that needs a
push server, and the app only uses free services.

## 4b. Backup & Google Drive

`backend/shared/backup` snapshots the live SQLite DB and (when Drive is connected) uploads it via
`backend/shared/drive`, a Google Drive OAuth2 manager (`golang.org/x/oauth2`, `google.golang.org/api`).
The `settings` service exposes connect/disconnect, OAuth client config, the Drive folder name, and
backup-on-close; `main.go` runs a backup in `OnShutdown` when that flag is on. `backend/shared/prefs`
persists these user choices and overrides `config` at startup (DB folder, OAuth creds, backup-on-close).

Local snapshots are timestamped (`<name>-YYYYMMDD-HHMMSS.db`, last 3 kept) and each is written with
`VACUUM INTO` to a `.tmp` file renamed into place, so a failed backup never destroys the previous one.
Drive holds one file **per computer** (`DriveFileName` = `<name>-<device>.db`, from the device label),
overwritten by that computer's uploads, so two computers on one Google account never overwrite each
other. The first upload claims the old single file of that name (`ownsFile`, renaming it). A Drive
restore takes the newest file of any computer and says which one («Google Drive · equipo X · fecha»).
When the DB file did not exist at startup (a DB
folder that went missing, e.g. an unsynced cloud folder), the runner refuses to back up while earlier
backups exist (`backup.ErrFreshDatabase`), so an empty DB never replaces them. `ApplyDBFolder` requires
an absolute path, compares with `os.SameFile`, and refuses a folder that already holds a DB.

**Restore (desktop, `backup/restore.go`, Configuración › Respaldo › «Restaurar un respaldo»).** Sources: the
backups `List` finds (rotating snapshots, `pre-migrate/`, `pre-restore/`, the older single file), a
file picked with the native dialog, or the Drive backup (`drive.Manager.Download`, the cached file id
or the newest file of that name the app can see). A backup is never trusted as is: it is copied to a
temp file and checked there (SQLite header, `PRAGMA integrity_check`, the App Finance tables, the
newer-schema guard) and migrated there; `InspectBackup` shows what it holds before the user
confirms. `RestoreBackup` then copies the live database to `<backups>/pre-restore/` (last 3 kept,
listed as «Antes de restaurar», so a restore is undone the same way) and overwrites it with
SQLite's online backup API (modernc's `NewRestore`, reached through `sql.Conn.Raw`) on the app's
single connection, held for the whole copy — SQLite requires the destination connection to be
unused meanwhile, and every other query waits. No restart: the runner's fresh-database guard is
lifted (`MarkRestored`, the way out of a missing DB folder), `main.go`'s `afterRestore` re-resolves
the active profile, and the frontend reloads. The web build keeps its own import (§17).

Drive calls treat only a real 404, or an item in Drive's trash (emptied after 30 days), as "missing"
(`isGone`); any other failure aborts the upload, where it used to create a duplicate folder or file
on every network hiccup. A refresh token Google no longer honors (`invalid_grant`: revoked, or
expired after 7 days while the OAuth app is in "Testing") drops the token and returns
`drive.ErrReconnect`, so Configuración shows Drive disconnected. The token is a 0600 file written atomically
(temp + rename), not a keychain item: Windows caps credential blobs at 2560 bytes, too close to a
token's size, and go-keyring's macOS items are readable by any process of the same user anyway.

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
emitted events (`application.Get().Event.Emit`, received with `Events.On` from `@wailsio/runtime`).
No service needs it today: the mail sync that used it was removed, and the finance methods are fast
DB calls. A task that panics is recovered into a logged error (`runTask`), so a task reading
untrusted input cannot kill the app.

Startup (`main.go`): `application.New` runs before the database is opened, with `SingleInstance`
(a second launch focuses the running window and exits before touching the DB), `Logger:
slog.Default()` (release builds otherwise drop Wails' own log, including recovered binding panics)
and a `PanicHandler` that logs the stack. Services are added with `app.RegisterService` once the DB
is ready; the binding generator still finds all of them. A DB that cannot be opened or migrated is
reported in a native error dialog (`exitWithDialog`) instead of the app silently vanishing.

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
refetch (`components/shell/profiles.ts`) — the DB connection is never reopened, so the switch is instant. The
per-user isolation guarantee is covered by `backend/users/isolation_test.go`; add a similar test
whenever a new bound method reads user-owned data.

## 15. Soft delete & trash

Cards, categories, incomes, expenses, fixed expenses and users use bun's `soft_delete` (a nullable
`deleted_at` column + the `bun:",soft_delete"` struct tag). Deleting sets the timestamp instead of
removing the row; list queries exclude soft-deleted rows automatically, and the frontend "Papelera"
(`TrashView.tsx`) lists and restores them. Category-name uniqueness is a **partial** unique index
scoped to `deleted_at IS NULL`, so a deleted name can be reused and a restore never collides with an
active row. See migrations `011` (finance) and `012` (users).

**Deleting for good** is a second step, done from the trash only. `PurgeTrashItem` and `EmptyTrash`
hard-delete trashed rows; their children go by `ON DELETE CASCADE`. `users.PurgeUser` erases a
trashed profile from every table that has a `user_id` column. It finds those tables at run time
(`sqlite_master` × `pragma_table_info`), so a new table is covered without code changes. A profile
keeps nothing outside the DB.

## 16. Merchants

`backend/finance/merchant.go` is a user-managed list of "comercios". Expenses store the merchant as
plain text (`expenses.merchant`), not a foreign key: renaming a merchant (`UpdateMerchant`) rewrites
that text on its expenses and import rules; deleting one leaves the text untouched. A merchant may
have a usual category (`merchants.category`, `SetMerchantCategory`): the expense form proposes it,
and an import whose rule names the merchant but no category takes it. Renaming a category
(`UpdateCategory`) rewrites it on expenses, fixed expenses, merchants and import rules.

**Suggested catalog** (`catalog.go` + `catalog.json`, mirrored by `engine/finance/catalog.ts`):
~34 categories (with a looks.json icon and color) and ~200 Chilean merchants with their usual
category and bank-descriptor prefixes (normalized like `normalizeDescriptor`; ambiguous names get
none). `ApplyCatalog` adds what the profile lacks and never overrides a choice: names compare in
any case, a name in the trash counts as taken, an existing merchant only gets a category if it had
none, an existing rule pattern is left alone; applying it again adds nothing.
Surfaced in `MerchantsView.tsx`.


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
- **Backup**: web has no Drive; Configuración › Respaldo offers export/import of the SQLite file
  (`services/web/settings.ts` + Share-Sheet-aware `lib/exportFile.ts`). Import validates the file's
  bytes first (`engine/db/dbfile.ts`), then **proves the file in memory before OPFS is touched**
  (`engine/db/importCheck.ts`: `sqlite3_deserialize` into `:memory:`, `PRAGMA integrity_check`, the
  App Finance tables, the newer-schema guard, the migrations run on that copy); only then it swaps
  the stored file, keeping the previous bytes and restoring them if the swap fails
  (sqlite-wasm's own `importDb` checks just the header and overwrites first). The result
  (`ImportSummary`) shows before the mandatory page reload. Export hands the file to the Share Sheet;
  when Safari refuses it because the tap was spent while the worker exported (`share()` needs a live
  user activation), the button turns into «Compartir respaldo» and its own tap shares the ready file.
  Configuración › Respaldo shows whether the browser granted persistent storage (`navigator.storage.persist()`, asked
  at startup; WebKit grants it on its own heuristics, installing to the home screen being the
  documented signal) and when a backup last left this device. **No `window.confirm`/`alert` anywhere in this
  flow** and **no `accept` on the file input**: Safari suppresses native dialogs without a live user
  activation, and iPadOS greys out `.db`/`.sqlite` files when `accept` is set (no system UTI owns
  those extensions). Both turned a failed restore into a screen that just looked empty.
- **Tests**: `npm test` (vitest) runs the engine against the same sqlite-wasm build in Node
  (in-memory), including a mirror-integration suite (`engine/finance/service.test.ts`).
- **Deploy**: `.github/workflows/deploy-web.yml` publishes `frontend/dist` (built with
  `base: /app-finance/`, no dependency cache) to GitHub Pages after CI passes on a push to `main`.
  The build carries a Content-Security-Policy `<meta>` (`web-csp` plugin in `vite.config.ts`,
  build only): same-origin scripts, workers and connections, `'wasm-unsafe-eval'` for sqlite-wasm,
  inline styles for React `style` attributes, no objects, no foreign base or form targets. Pages
  cannot send headers, so `frame-ancestors`/`report-to`/`sandbox` are not enforceable (accepted
  gap). Verified in a browser: engine, service worker and pdf.js worker run with no violations,
  and `eval` is blocked. The service worker registers in
  `prompt` mode from `main.tsx` (`injectRegister: false`, so the desktop bundle never imports the
  PWA's virtual module): a new deploy waits for the user's «Actualizar» in `WebUpdateBanner`
  (`lib/pwaUpdate.ts`) instead of swapping files under an open page, and a lazy chunk that fails to
  load (`vite:preloadError`) reloads once.
- **One tab owns the database**: opfs-sahpool admits a single connection, so `main.tsx` takes the
  `app-finance-db` Web Lock (`acquireDbLock`) before the engine starts; a second tab or window shows
  "La app ya está abierta" instead of failing inside SQLite. The worker client races every call
  against the worker's `error`/`messageerror` events, so a worker that cannot load (a chunk a new
  deploy no longer serves) turns into an error with a reload button, not an endless spinner.
  `Fatal` screens always offer «Recargar»: an installed PWA has no browser reload.

## 18. Import inbox (statements and cartolas)

Movements detected by the bank reach the app through **one reviewed inbox** — nothing becomes an
expense until the user confirms it:

- **CSV of any bank** (`frontend/src/lib/statements/csv.ts` + `components/CsvImport.tsx`), the file
  import of YNAB, Actual and Monarch: every Chilean bank exports its cartola to Excel/CSV, so instead
  of a parser per layout the user maps the columns once (fecha, descripción, and a signed monto, a
  column of card charges, or separate cargos/abonos). The reader detects the delimiter (`;` `,` tab)
  and the encoding (UTF-8, else Windows-1252), reads es-CL dates and amounts, skips title/total rows,
  and stages the rows with source `csv` (statement family: re-importing adds nothing). A new
  bank-specific PDF parser still needs a real sample of that bank's document, turned into an
  anonymized fixture.

- **Inbox** (`backend/finance/importitem.go` + `imports.go`, mirrored in the TS engine):
  `import_items` rows move `pendiente → confirmado` (new expense via `ConfirmImportItem`, or an
  existing one via `LinkImportItem`) or `→ descartado`. `StageCandidates(ctx, idb, uid, batch)` is
  the single entry point (bound `StageImport`). It rejects a batch whole if any candidate is
  invalid, dedupes by a per-user `external_key` built from the candidate's stable fields + its
  ordinal among identical ones (re-importing adds nothing), and **reconciles** across source
  families: a statement line matching an unmatched item of the other family (the `email` items
  staged before the mail sync was removed: same amount/currency, compatible last digits, ±1 day) is
  stored `conciliado` so a purchase is never reviewed twice. `ListImportItems` suggests the card (by `cards.last_digits`), the learned
  `merchant_rules` (longest word-prefix of the normalized descriptor, `descriptor.go`), a live
  expense that looks like the same purchase (±10 days, cuota or total), and a fixed expense whose
  unpaid month the charge looks like the bill of (`fixedmatch.go`, Actual Budget's schedule model:
  a significant word of the name must match, the amount only within ±7.5 %, because a fixed
  amount is an estimate). `LinkImportItemToFixed` marks that month paid and, for a CLP charge on a
  CLP fixed expense, makes the bank's real amount that month's amount only (an override at the
  month, the plan restored the month after); a fixed expense in UF keeps its UF amounts, since a
  peso charge is not an amount in UF. The item's `kind` is fixed at staging and every confirm path checks
  it: an abono never becomes an expense, nor a charge an income. A USD item needs a whole-peso
  amount other than its USD figure (CLP has no minor unit, ISO 4217). A confirmed item whose
  expense, income or fixed expense went to the trash can be reopened (`RestoreImportItem`,
  `reopenable` in the view); an expense takes the link of one item only.
  Two more suggestions, the way Actual Budget reviews an import (`inboxmatch.go`, migration
  `20260929042`): a pending CLP movement that moves exactly what a transfer between own accounts moves
  in its month (`salary_rest` included) is offered as that transfer's leg — `LinkImportItemToTransfer`
  confirms it with `import_items.transfer_id/transfer_period`, adding no expense nor income; each leg
  (transfer, month, kind: the source's charge and the destination's credit) takes one movement, and
  deleting the transfer makes the item reopenable. And a pending movement that repeats an earlier one
  imported from another format or bank label (same kind, currency and amount, a day apart, named alike
  or with the same bank reference) is flagged as `DuplicateItem*` on the later sighting only; nothing is
  removed on its own (Actual's auto-dedupe can eat a legitimate repeat).
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
- **Card statement formats**: Chilean issuers print the CMF's standard statement.
  - `cmfCardStatement.ts` reads it for each issuer, taking the issuer as options (Template Method). Itaú's emailed PDF is the fallback; Banco de Chile is recognized by «DÓLARES-PREMIO» or its purchase totals split into one cuota and cuotas.
  - Banco de Chile packs several cells in one text run («12.345 $»). `cellRuns` splits those cells and joins each «$» or «%» to its number.
  - Itaú's statement downloaded from its web has its own parser, `itau/webCardStatement.ts`. It prints no section totals, so its lines are checked against the grand total.
  - Cencosud Scotiabank (`cencosud/cardStatement.ts`) and CMR Falabella (`cmr/cardStatement.ts`) have parsers of their own too: dd/mm/yyyy dates, bare amounts, no section totals (checked against the grand total and the credit used), no operation numbers (a cuota plan is recognized month to month by its import key: date, total, descriptor). Cencosud prints rates with a decimal point, one sub-header per card, and names each coming month by when it is paid (MAY = April's statement). Notes a user wrote over the PDF come out as extra text runs in the description column: only a row's first text after its date is the descriptor. CMR puts the card in the footer and the card payment among the charges; built from a statement without purchases, its purchase columns come from the table header and every import notes they are not yet validated, and its coming months are not read.
  - Shared label readers and checks live in `cardFields.ts`. Each format has a synthetic fixture under `testdata/`.
  - Section `diferida` holds cuotas 00/N (bought this period, first cuota next period). They stage with `first_period` set to the next month.
- **Bank reference codes**: each line's code is kept as printed, in `card_statement_lines.reference` and `import_items.reference`. It is what the user quotes to dispute a charge.
  - An expense lists the codes of every statement that reported it (`reference.go`, `Movimiento.references` / `ExpenseHit.references`), and search matches them.
  - The prefix of a code moves: in Itaú's email PDF it is the posting date, which changes every month a cuota is billed; the web PDF uses the operation date.
  - So a purchase seen again is recognized by its **operation number**, the last 8 digits (`operationNumber`), together with its card, currency, date and cuota count (`earlierSighting`). A cuota the user discarded never comes back.
- **Merging a purchase entered by hand** (`merge.go`, mirrored in the engine). This is the "matching" of YNAB and Actual Budget.
  - A statement purchase merges on its own into the one expense entered by hand that matches it. The expense must have no bank movement yet (`bankLinked`), be on the statement's card, be dated within ±10 days (`mergeWindowDays`, YNAB's window) and have the same total or cuota.
  - With two candidates, or an unknown card, the item waits in the inbox with the suggestion, and «Sí, unir» (`LinkImportItem`) does the same merge.
  - The bank decides the date, the amount/cuotas and the billing month. The user's description, category, merchant and tags stay.
  - The bank's descriptor goes to `expenses.bank_description`, and its code comes with the link.
  - A paid cuota never moves: when the bank's plan would move or drop one, only the date and the descriptor are taken.
- **Real cutoffs** (`cutoff.go`, `engine/finance/cutoff.ts`): banks move the cutoff with weekends and holidays.
  - A card expense entered by hand is placed by the windows its card's statements printed: first each statement's billed period, then the next period it announced. The card's billing day covers only the dates no statement reached.
  - Statements link to the one live card holding their last digits. Saving a card's digits relinks them (`relinkStatements`), so the national and international statements land on the same card.
- **No mail sync**: the IMAP reader of bank alert emails was removed; the user uploads each statement.
  Its migrations stay (`backend/mailsync/migrations`, desktop only: `017` created `mail_accounts`,
  `037` drops it). The finance domain still knows the `email` source, so items staged by it before
  the removal keep showing and reconciling.

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
- **Signed updates** (`signing.go`), the model of Sparkle's EdDSA and Tauri's updater: the release
  workflow signs the SHA-256 digest of each update artifact with Ed25519 and publishes
  `<artifact>.sig` (base64). The public key is embedded from `update_signing.pub` and is the
  updater's only trust anchor (`updater.Config.PublicKey`), so whoever controls the release feed can
  swap the artifact and `SHA256SUMS.txt`, but cannot sign what they swapped in. Wails' GitHub
  provider never loads signatures, so `signedProvider` fetches the `.sig` next to the artifact URL.
  `Service.check` refuses unsigned or badly signed releases with a clear message, and Wails verifies
  again over the digest of the bytes it downloaded. An unreadable embedded key disables updates.
  Signing runs in its own job (`sign`, stdlib-only `tools/updatesign`) with the key in the `release`
  environment (v* tags only), away from the build job's npm/toolchain code. Not covered: the
  signature binds the file, not the version, as in Sparkle and Tauri. Rotating the key means
  shipping one release signed by the old key that embeds the new public key.
- The helper aborts if the app takes > 30 s to exit, so the close-time backup runs inside
  `RestartToUpdate` and `OnShutdown` skips it (`Restarting` flag).
- The macOS zip must be built with `ditto --norsrc --noextattr --noacl`; the extracted bundle keeps
  a valid ad-hoc signature and carries no quarantine flag, so Gatekeeper does not prompt again.
- The app refuses to self-update when it cannot write next to itself (read-only folder, mounted
  `.dmg`), runs translocated (not moved to Aplicaciones) or is a `wails3 dev` build.
- Windows installs per user (`INSTALL_SCOPE: user`) so the exe can be replaced without UAC.
- The PWA (web build) updates through its service worker (prompted, see §17);
  `services/web/updates.ts` is a stub.

## 20. Desktop ⇄ iPad handoff (sync state)

Desktop and iPad hold separate copies of the same `.sqlite` file. They move it by hand: a Drive
backup or an exported file goes one way, a restore or a web import brings it in on the other side.
The app never merges two copies. It only tells the user, before anything is replaced, how the
incoming copy relates to the local one, so a copy with changes made elsewhere is never overwritten
silently.

- **Version vector (`sync_vector(device_id, edits)`)**: how many shared rounds of edits each
  device has put into this copy. `sync_state.dirty` flips to 1 on any write to a user-data table,
  through 72 SQLite triggers (insert, update and delete on 24 tables, migration
  `20260926026_sync_state`). The triggers live in the schema, so the Go and TS engines share them.
- **`MarkShared`** runs before a copy leaves the device: the desktop backup `Runner.Run` and the web
  `exportDb`. If `dirty` is 1, it bumps this device's counter and clears the flag, in one
  transaction. A copy made with no edits since the last share leaves the vector as it was.
- **`CompareSync(local, dirty, device, incoming)`** returns `igual`, `mas-nueva`, `mas-antigua` or
  `divergente`, using the usual vector dominance. It has one twist: when this device has unshared
  edits (`dirty`), a copy that only matches its vector is `mas-antigua`, and one that also brings
  another device's edits is `divergente`. `InspectBackup` (desktop) and `inspectDb` (web) fill
  `sync` in the summary, and `SyncNoticeBox` turns it into the confirmation's warning.
- **The device id lives outside the DB**, in desktop `prefs.json` (`prefs.DeviceID`, `escritorio-…`)
  and in web `localStorage` (`web-…`). A restored copy therefore never brings the other device's
  identity with it.
- **Why not automatic merge or sync:** it would need a server, or both devices reaching the same
  Drive file. The web build has no OAuth client, and `drive.file` only shows a file to the OAuth
  client that created it, so the iPad cannot read the desktop's backup without a Google Cloud setup
  per user. The zero-cost constraint rules out a server.

## 21. UI foundations (tokens, themes, primitives)

- **Semantic color tokens** live in `frontend/src/index.css`, as OKLCH values: surfaces (`canvas`,
  `panel`, `raised`, `sunken`, `sidebar`), borders (`line`, `line-strong`, `line-input`), text
  (`fg`, `fg-muted`, `fg-subtle`), the accent and the states (`positive`/`negative`/`caution`/`info`
  with `-fg` and `-soft`). The light values sit in `@theme`; the dark theme re-declares them on
  `:root[data-theme='dark']`. Components name only these tokens, so both themes stay consistent.
  `src/styles/tokens.test.ts` computes the WCAG contrast of every pair the primitives use (4.5:1
  text, 3:1 form outlines and focus ring) straight from the CSS.
- **No raw colors**: `src/styles/rawclasses.test.ts` fails on any raw palette class, black/white or
  pre-redesign token name (`surface`, `primary`, `danger`…) in a component — such a color is right
  in one theme only. A missing color becomes a new token (light + dark value + contrast pair).
- **Theme preference** is per device (`localStorage['app-finance:theme']`: `system|light|dark`,
  Configuración › Apariencia), never in the DB. `public/theme-init.js`, a blocking same-origin
  script (the web CSP forbids inline scripts) injected by the `theme-init` Vite plugin, sets
  `data-theme` on `<html>` before the first paint. `lib/theme.ts` keeps it applied (OS appearance
  changes, other tabs), feeds `useThemeMode()` and rewrites the `theme-color` meta. The installed
  iOS PWA uses the `default` status-bar style: iOS fixes the bar at launch, and
  `black-translucent`'s white text is unreadable over the light theme.
- **Primitives** (`frontend/src/components/ui/`, one barrel): `Button`/`IconButton` (sizes, icon,
  `loading`), `Badge`, `Callout`, `EmptyState`, `Skeleton`, `SegmentedControl` and `Tabs`
  (roving tabindex), `Menu` and `Toggletip` (native Popover API: top layer, light dismiss, Escape;
  placed by the pure `position.ts`, since CSS anchor positioning is missing on Safari 17.6),
  `ConfirmAction` (inline two-step confirm; no `window.confirm`), `Field`/`Input`/`Select`/
  `MoneyInput`/`Switch` (hint and error wired to `aria-describedby`), `Modal`, `Toaster`, and the
  `tbl` class recipes for tables.
- **Personalization** (icon + color per category, color per card, icon per savings goal) is stored
  as keys of `backend/finance/looks.json` in `TEXT NOT NULL DEFAULT ''` columns (`''` = automatic:
  the app picks from the name or id). Go embeds the file (`look.go`) and the engine raw-imports it
  (`engine/finance/looks.ts`), so both validate the same keys on write (`SetCategoryLook`,
  `SetCardColor`, `SetSavingsGoalIcon`). No CHECK constraint: the catalog may grow, and a key
  unknown to an older copy (written by a newer device) is shown as automatic, never rejected.
  Expenses reference categories by name, so a category's look follows a rename untouched.
  On screen, `lib/look.ts` maps keys to static lucide imports (`ICONS`, with Spanish labels) and
  derives the automatic look (icon from name keywords, color from the row id); `categoryLooks()`
  resolves an expense's category by name. Colors reach the DOM only as `data-look="<key>"`, which
  `index.css` turns into `--look`/`--look-soft` (per-theme `--color-look-*` tokens, contrast-tested),
  so no class is ever built from a stored key. Primitives: `LookIcon`, `ColorDot`, `IconPicker`,
  `ColorPicker` (native radio groups).
- **Font**: Inter Variable, self-hosted (`@fontsource-variable/inter`; the CSP allows only
  same-origin fonts). The PWA precaches only its latin subsets.
- **Tests**: interactive primitives run in a real headless Chromium through vitest's browser
  project (`*.dom.test.tsx`, `vitest-browser-react`): jsdom has no `<dialog>.showModal` and
  happy-dom no Escape/Popover. CI installs only Chromium, in the `web` job, which runs in parallel
  with the slower `desktop` job, so the gate does not get longer. The browser project resolves
  `@/services/*` to the web adapters (CI's web job has no wails3 bindings); tests mock their data.

## 22. Shell, navigation and window

- **Routes live in the URL hash** (`lib/route.ts`: a typed `Route` union, `parseHash`/`formatHash`,
  pure and tested). `lib/useRoute.ts` reads it with `useSyncExternalStore` over `hashchange` and
  changes it with `navigate()` or `<Link>`; there is no route atom, so nothing needs syncing. A start
  without hash (PWA `start_url`, the desktop window) reopens the last screen (`startRouteMemory`).
  Unknown hashes land on the Resumen; desktop-only Configuración sections on the web build land on
  its list.
- **Information architecture**: month-dependent data lives in the month views (Resumen shows card
  quotas and account balances of the selected month); what is configured once lives in
  Configuración (`components/config/sections.tsx`, a `Record<ConfigSection, …>` so a route section
  cannot ship without its screen). Categories show the budgets in force in a month of their own,
  independent of the Resumen's month. Card statements live in Importar › Estados de cuenta.
- **Shell** (`components/shell/`): `AppShell` renders the sidebar (expanded ≥1024px and not
  collapsed; icon rail with visible labels at 768–1023px or when collapsed; `NavDrawer` in a
  `<dialog>` below 768px), the screen's `PageHeader` with `PeriodNav` on month/year screens and the
  global «Gasto» button (`QuickAddHost` + `quickAddAtom`: new expenses from any screen; editing stays
  in the Resumen table). Focus moves to the new screen's `h1` after each navigation.
- **Shortcuts** (`lib/shortcuts.ts`, a pure resolver with tests; one listener in `AppShell`): ⌘/Ctrl+K
  command palette (also while typing), ⌘/Ctrl 1…7 sections, ⌘/Ctrl+, Configuración, N new expense,
  ←/→ period. None fires inside an open dialog (it would drop a half-filled form); plain keys never
  fire while typing.
- **Command palette** (`components/palette/`): `commands.ts` builds the catalog with a pure function
  from the platform, profiles and Configuración sections, the shell injecting the actions;
  `rankCommands` orders it with `lib/fuzzy.ts` (accent-insensitive; prefix > word start > letters in
  order) and keeps «Buscar gastos: …» last. The UI is a native `<dialog>` around an ARIA 1.2
  combobox (focus stays in the input, `aria-activedescendant` marks the option), state in the pure
  `paletteReducer`, recents per device in localStorage. Opened by ⌘K or the sidebar's «Ir a…»
  (`paletteOpenAtom`, like `quickAddAtom`).
- **Guía de inicio** (`OnboardingChecklist`, rules in `lib/onboarding.ts`): derived from existing
  queries, no stored progress; hidden per profile and device.
- **Swipe** (`lib/swipe.ts` pure classifier + `lib/useSwipePeriod.ts`): on month/year screens a
  horizontal touch swipe turns the period (left = next). ≥ 64 px, 1.5× more horizontal than
  vertical, quick (< 600 ms or ≥ 0.3 px/ms); never from the left 24 px (iOS back), on form fields,
  dialogs, `[data-no-swipe]` or sideways-scrolling content (tables keep their pan). `<main>` is
  `touch-action: pan-y pinch-zoom`, so the browser keeps scroll and zoom and a pan it takes over
  arrives as `pointercancel`.
- **Desktop window** (`main.go`): minimum 960×640 (`windowstate.MinWidth/MinHeight`; a smaller saved
  geometry is clamped), background = the dark canvas token, and on macOS a hidden-inset title bar:
  the traffic lights sit over the sidebar, whose top band and the screen header drag the window
  (CSS `--wails-draggable`; `theme-init.js` sets `data-os` in the desktop build and index.css's
  `mac:` variant leaves room for the lights). No translucent backdrop: with
  `BackgroundTypeTranslucent`, Wails beta.25 on macOS left the web content invisible.
