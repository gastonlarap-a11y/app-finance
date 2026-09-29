# app-finance

Guidance for any AI agent working in this repository — Claude Code reads it through the thin
`CLAUDE.md` that imports this file; Codex and Antigravity read it natively.

## What this repo is

**App Finance** — a [Wails v3](https://v3.wails.io) desktop **personal-finance manager** (Spanish
UI): a Go backend bound to a React 19 + Vite frontend, plus an installable web/PWA target for iPad
running the same UI over a local TypeScript engine. It tracks money month to month — per-month
salary, extra incomes, expenses (one-off or credit-card installments/cuotas), recurring fixed
expenses, cards, categories (with effective-dated monthly budgets, $0 caps and rollover), merchants,
light accounts, shared expenses (receivables), purchases in another currency, due-date reminders,
monthly/yearly summaries (incl. category × month), a commitments forecast and a history-wide expense
search — with local SQLite storage and optional Google Drive backup.

This is **Wails v3, not v2** — confirm via the import `github.com/wailsapp/wails/v3/pkg/application`
in `main.go`. Never use v2 APIs (`wails.Run`, `OnDomReady`, the global `runtime` package) or the v2
CLI (`wails dev` fails here — always `wails3`). See the `wails` skill for the v2→v3 mapping.

## Commands

```bash
# Development
wails3 dev            # dev mode: build + Vite dev server (:9245) + window + hot reload (or: task dev)
go build . && go vet ./...     # quick backend compile + vet
go test -race ./...            # backend tests (finance + users); single: go test -run TestName ./backend/finance
cd frontend && npm run build   # frontend typecheck (tsc --noEmit) + production bundle

# Quality gates (= CI) — run `task check` before declaring work done
# (no standalone `task` binary? `wails3 task <name>` runs the same Taskfile)
task check                     # go vet + golangci-lint + ESLint + typecheck (desktop+web) + tests + build:web
task lint | task test | task typecheck | task vuln   # individual gates (.golangci.yml, frontend/eslint.config.js)

# Web/PWA target (iPad) — same frontend, local TS engine (no Go backend)
cd frontend && npm run dev:web    # dev server for the web target (open /app-finance/ in a browser)
cd frontend && npm run build:web  # typecheck (tsconfig.web.json) + PWA bundle → dist/
cd frontend && npm test           # vitest: `unit` (engine/lib, Node) + `browser` (UI, headless Chromium)
cd frontend && npx vitest run --project unit|browser [file]   # one project / one file while iterating
cd frontend && npx playwright install chromium                # once per machine (browser project)

# Packaging/distribution (macOS .app/.dmg, Windows NSIS installer) → `release` skill (user-invoked)
# Official releases: bump info.version in build/config.yml + `wails3 task common:update:build-assets`,
# merge, then push tag vX.Y.Z on main → .github/workflows/release.yml publishes the GitHub Release

# Bindings and toolchain
wails3 generate bindings -ts   # regenerate TS bindings after changing exported Go signatures
wails3 doctor         # verify toolchain after any version/dependency change
```

Sandboxed-session quirks: prefix Go commands with `GOCACHE=$TMPDIR/gocache` (the default build
cache is not sandbox-writable); `go build .`'s dsymutil step also fails — use
`go build -ldflags=-w -o /dev/null .` as the compile+link check. Prefer `./node_modules/.bin/tsc`
over `npx tsc` and pass `--cache $TMPDIR/npm-cache` to npm (the npm cache is not sandbox-writable);
`npm install` (lockfile), dev servers and the vitest `browser` project (port bind) need to run
outside the sandbox.

## Versions (beta — keep aligned)

- Go toolchain: `go 1.27` in `go.mod` (CI reads it via `go-version-file`). Node 24 LTS
  (`frontend/.nvmrc`). TypeScript stays on 5.9 until typescript-eslint supports TS 7 (7.1 API).
- Go library: `github.com/wailsapp/wails/v3 v3.0.0-beta.25` (pinned in `go.mod`; excluded from
  Dependabot — bump lib, CLI and `@wailsio/runtime` together by hand).
- `wails3` CLI **must match** the Go library version; reinstall with
  `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.25` when you change the pin
  (CI derives it from `go.mod`). Different CLI versions emit different binding models.
- npm `@wailsio/runtime` shares the version since the beta line: `3.0.0-beta.25`. Run
  `wails3 doctor` after any toolchain change.

## Architecture

Full detail and rationale: `ARCHITECTURE.md`. The invariants:

- **`main.go` is the only orchestration point** (no `app.go` god object): `application.New`
  (SingleInstance, `Logger`, `PanicHandler`) → DB open + migrations → shared deps → services via
  `app.RegisterService` → window → `app.Run()`. `New` comes first because SingleInstance is enforced
  inside it: a second copy must exit before touching the DB. Startup failures go through
  `exitWithDialog` (native error dialog), never a bare `os.Exit`.
- **One Service per domain**: plain struct + `application.NewService(...)`; exported methods
  auto-bind to TS. Reference: `backend/finance/service.go`. Current services: `finance`, `users`,
  `settings`, `updates` (desktop only), `reminders` (desktop only, native due-date notifications, no
  bound methods), `diagnostics`, `reports`. Every exported method of a service becomes a binding:
  anything one service must offer another is a package function, never a method.
- **`finance`** (`backend/finance/`) is the core domain — one file per entity plus `period.go`
  (YYYY-MM math), `result.go` (view models) and `service.go` (bound methods + summaries).
  Per-month values resolve by lexical `period` string comparison; fixed expenses use
  effective-dated overrides + sparse payments (`backend/finance/fixedexpense.go`).
- **`users`** (`backend/users/`) = multi-user profiles, no login: one shared SQLite DB, every
  finance row carries `user_id`, active id in the in-memory `users.Session`.
- **User scoping (invariant)**: every finance read/write filters by the user id; a query that
  forgets it leaks another profile's data. Each bound method reads `uid := s.uid()` ONCE and passes
  it to its helpers (a concurrent SwitchUser must not mix profiles mid-call). Child tables without
  `user_id` (`fixed_expense_amounts`, `fixed_expense_payments`) are written only after proving the
  parent's ownership (`ownFixedExpense`). Guard new bound methods with a cross-user test in
  `backend/users/isolation_test.go` (+ its vitest mirror in `frontend/src/engine/finance/features.test.ts`).
- **Savings contributions are a monthly outflow**: they lower `Disponible`/`Balance` and the carried
  balance (`cumulativeBalanceBefore`) but are reported as `Ahorro`, apart from `Gastos`, and never
  count against category budgets. Contributions of a trashed goal are excluded everywhere
  (`liveGoalContributions`), like installments of a deleted expense. A withdrawal is a negative
  contribution (`WithdrawSavings`); a goal's balance never goes below zero.
- **Carried balance restarts at a reconciliation**: `cumulativeBalanceBefore` = latest
  `reconciliations` row before the month (real closing balance; the opening balance is one on the
  month before the first) + `flowsBetween` it and the month. Any new monthly flow must be added to
  `flowsBetween` (Go and TS) and to the year/forecast loops, which reset at a reconciled close.
- **Import inbox (invariant)**: bank movements (card statements, cartolas: PDF or CSV) only enter through
  `finance.StageCandidates`/`stageItems` into `import_items` and become expenses (or, for bank
  credits, extra incomes) only when the user confirms them (`ConfirmImportItem`/`LinkImportItem`/
  `ConfirmImportItemAsIncome`), or mark a fixed expense's month paid (`LinkImportItemToFixed`).
  Never create expenses straight from a parser. An item's `kind` (gasto | abono) is fixed when
  staged — `lineCandidate` turns negative charge lines into abono — and every confirm path checks
  it (`requireKind`; an abono may also become the refund of an expense: `ConfirmImportItemAsRefund`);
  items in another currency need a whole-peso amount (`requirePesos`). Credit-card
  statements are stored whole (`ImportCardStatement` → `card_statements` + lines + schedule) and
  feed the inbox from the same path. A purchase seen again in a later statement is matched by its
  stable operation number (`operationNumber`, last 8 digits), never by its key or wording. The bank's
  reference code is kept on the item and on the lines, and never discarded: it is the user's proof in
  a dispute. Card expenses are placed by the statements' real cutoff windows (`cardCutoff`); the
  card's billing day is only the fallback. A bank movement that matches an expense entered by hand
  merges into it (`mergeIntoExpense`): the bank wins on date, amount and month, the user's words
  stay, the bank's descriptor goes to `bank_description`, and paid cuotas never move. Statement
  parsers live in the frontend (`frontend/src/lib/statements/`, shared by desktop and web); the
  user uploads every statement by hand (the IMAP mail sync was removed; its migrations stay under
  `backend/mailsync/migrations`, desktop only). Parser fixtures must be anonymized (public
  repo) — `frontend/scripts/pdf-runs.mjs` dumps a PDF's positioned text runs. See `ARCHITECTURE.md` §18.
- **In-app updates** (`backend/updates`, Wails `pkg/updater`): `main()` must call
  `updater.HandleHelperMode()` before anything else; the app version is `info.version` of the
  embedded `build/config.yml`; a release artifact without an entry in `SHA256SUMS.txt` or a valid
  Ed25519 `<artifact>.sig` (key pinned in `backend/updates/update_signing.pub`, signed in the
  release workflow's `sign` job by `tools/updatesign`) is never installed; the close-time backup runs
  in `RestartToUpdate`, not `OnShutdown` (the updater's helper aborts if the app takes > 30 s to
  quit). Release asset names/zip flags and key rotation: `release` skill.
- **Export**: views build an `ExportTable` (`frontend/src/lib/exportTables.ts`, money as decimal
  strings); `@/services/reports` writes it — desktop via `ReportsService.SaveTable` (.xlsx + native
  Save dialog; blob downloads are unreliable in the webview), web via CSV + Share Sheet.
- **Fixed-expense charges go through `fixedCharge`** (Go `uf.go`, TS `engine/finance/fixedexpense.ts`):
  a fixed expense bills only where `billsIn` (its `interval_months` schedule) and converts UF amounts
  with that month's `uf_values` row. Never read `resolveAsOf` of a fixed expense as a peso charge.
  UF values are downloaded by the frontend (`lib/uf.ts`, mindicador.cl), never by the backend.
- **Effective-dated values** (fixed-expense amounts, category budgets): rows apply from
  `effective_from` onward; resolve with `latestAsOf`/`resolveAsOf`, sum ranges with `sumAsOf`
  (`backend/finance/fixedexpense.go`, mirrored in `frontend/src/engine/finance/fixedexpense.ts`).
- **Sync state (invariant)**: desktop⇄iPad copies are compared with a version vector
  (`sync_vector` plus `sync_state.dirty`, `backend/shared/db/syncstate.go`, mirrored in
  `engine/db/syncstate.ts`). Every new user-data table needs its three `sync_dirty_*` triggers in its
  migration. `MarkShared` runs before a copy leaves the device (backup, web export). The device id
  never lives in the DB. See `ARCHITECTURE.md` §20.
- **Soft delete** (bun `soft_delete`) on cards/categories/incomes/expenses/fixed_expenses/users;
  deleted rows surface in the frontend "Papelera" (`TrashView.tsx`) with restore. Children of a
  trashed parent are frozen (no paying its cuotas, no deleting its contributions); an edit may keep
  a trashed card a row already has (`billingDayFor(…, allowTrashed)`), nothing new may use it.
  Deleting for good happens only from the trash (`PurgeTrashItem`/`EmptyTrash`, `users.PurgeUser`,
  which finds every `user_id` table at run time); children go by `ON DELETE CASCADE`.
- **Views over the ledger, never a second ledger**: accounts (`account.go`) and due dates
  (`dues.go`) only attribute or read existing flows; transfers between own accounts
  (`transfer.go`, fixed or `salary_rest`) only move account balances, and an account
  reconciliation (`accountreconciliation.go`) only restarts one account's balance. A receivable settles as a refund (`insertRefund`), a
  foreign-currency purchase keeps its pesos in `installment_amount`. None of them adds a monthly
  flow to `flowsBetween`.
- **Paid cuotas are immutable (invariant)**: `UpdateExpense` never regenerates installments —
  `replanInstallments` adapts them by number (stable ids: statement lines link to them), applies a
  new amount to pending cuotas only, keeps the cuota-1 month while the date/card lead to the same
  billing month (it may come from a card statement), and refuses dropping or moving paid cuotas.
  Input ranges: years 2000–2099 (`minYear`/`maxYear`), up to 120 cuotas (`maxInstallments`).
- **Migrations**: embedded SQL run on startup; register each domain's `embed.FS` in
  `backend/shared/db/migrator.go`; the `YYYYMMDDNNN` filename prefix sets global order. SQLite can
  add columns but not change/drop them — rebuild + copy instead. Use the `db-migration` skill.
  New files are `*.tx.up.sql` (one transaction); a migration is recorded only on success,
  `main.go` snapshots the DB to `<backups>/pre-migrate/` first, and a DB with unknown migrations
  newer than this binary's latest is refused (`db.ErrNewerSchema`; older unknown ones are retired
  and ignored). Never delete or rename an applied migration file.
- **SQLite connection (invariant)**: open it only through `db.Open`/`db.DSN` (tests:
  `dbtest.OpenMigrated`). The driver is modernc, which honors only `_pragma=…` DSN keys; `db.Open`
  fails if `foreign_keys` is not 1. Journal stays DELETE (no WAL): the DB may live in a synced folder.
- **Shared packages** under `backend/shared/`: `config`, `prefs` (user prefs that override config),
  `db`, `logger`, `errors.go` (`AppError`), `windowstate`, `background` (goroutine pool), `backup`,
  `drive`, `types` (Decimal). The `settings` domain owns DB-folder selection, Google Drive OAuth
  and backup-on-close (backup runs in `main.go`'s `OnShutdown`). The OAuth client is never in git:
  local builds read the gitignored `backend/shared/drive/credentials.local.go`; the release workflow
  generates it from the `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` repository secrets.
- **Web/PWA target (iPad)**: `vite --mode web` ships the same React app as a PWA backed by a TS
  port of the domain (`frontend/src/engine/`) over sqlite-wasm (opfs-sahpool, Worker + Comlink).
  Mode `web` aliases `@/services/{finance,users,settings,…}` → `frontend/src/services/web/*`; the
  shared type contract is `frontend/src/services/contract.ts`. The engine reuses the SAME
  `backend/*/migrations/*.up.sql` files, so exported `.sqlite` files are interchangeable
  desktop⇄web. Deploy: `.github/workflows/deploy-web.yml` → GitHub Pages. See `ARCHITECTURE.md` §17.
  Web invariants: a .db import is proven in memory (`engine/db/importCheck.ts`) before it replaces
  OPFS, and the previous file is restored on failure; one tab owns the DB (`acquireDbLock`, Web
  Locks); the service worker is `prompt` mode, registered only in `main.tsx`'s web branch.

## Conventions

- Bound methods take `context.Context` as the first param and **must not block** the call handler —
  hand heavy work to `background.Worker`, stream results via emitted events, honor `ctx.Done()`.
- **Errors**: system/IO errors → native Go `error` (rejects the JS promise). Business errors
  (validation/not-found/conflict) → Result struct with `*shared.AppError` set (resolves; frontend
  checks `result.error`). Codes in `backend/shared/errors.go`.
- **Money** uses `backend/shared/types.Decimal`, stored as TEXT and marshaled to JSON as a
  **string**. Keep it a string on the frontend: format with `formatCLP` (`lib/format.ts`), compare /
  sum with `lib/money.ts` (decimal.js). Never `Number()`/`parseFloat` for money decisions; `ratio()`
  is the only number produced, for display widths.
- **Bindings**: never import from `frontend/bindings/` directly across the app (gitignored and
  regenerated) — wrap each service in one module and import that. The desktop wrappers are typed as
  the contract (`FinanceService: FinanceServiceContract = Bound`), so the desktop typecheck proves
  the bindings match `contract.ts`. Regenerate after signature changes.
- **Frontend data loading**: `useQuery(key, load)` (`lib/useQuery.ts`) — encode every input
  (period, `useVersion(...topics)`…) in the key; it drops stale responses and turns rejections into
  an error state (`QueryError`). Mutations call `failed(res)` (toast via `lib/notify.ts`, never
  `window.alert`) and `useInvalidate()(...topics)` for what they changed (`atoms/refresh.ts`:
  ledger | imports | profiles | settings | mail; no topic = all, e.g. a profile switch). Atoms hold
  UI state only — never server data.
- **Dialogs**: `Modal` is a native `<dialog>` (focus trap, Escape); icon-only buttons use
  `IconButton` (mandatory accessible label). React Compiler is on: no manual `useCallback`/`useMemo`.
- **UI look (invariant)**: screens are built from the primitives in `frontend/src/components/ui/`
  and the semantic color tokens of `frontend/src/index.css` — never raw palette colors
  (`slate-400`, `amber-200`…), which `src/styles/rawclasses.test.ts` rejects; token
  contrast is asserted by `src/styles/tokens.test.ts`. Icons are `lucide-react` static imports;
  icons/colors the user picks are stored as keys of `backend/finance/looks.json` (`''` = automatic).
  Details: `.claude/rules/frontend-ui.md` and `ARCHITECTURE.md` §21.
- **Navigation**: screens are routes in the URL hash (`frontend/src/lib/route.ts`); move with
  `navigate()`/`<Link>`, never with an atom. Month-dependent data belongs in the month views;
  what is configured once, in Configuración (`components/config/sections.tsx`). Keyboard shortcuts
  go through `lib/shortcuts.ts`. See `ARCHITECTURE.md` §22.
- **Go⇄TS parity (invariant)**: adding or changing a bound method in `finance`/`users` requires the
  same change in `frontend/src/services/contract.ts` and in the web engine
  (`frontend/src/engine/…/service.ts`), with a mirror test in vitest. Migrations need no engine
  change (auto-discovered by glob), but must be plain SQLite SQL with `--bun:split` separators.

## Build/dev tooling

**Workflows (`.github/workflows/`)**: every action is pinned to a full commit SHA with its tag in a
comment (Dependabot bumps both); checkouts use `persist-credentials: false`; each job has
`timeout-minutes` and the least `permissions` it needs. `release.yml` builds read-only and without
caches (cache poisoning), checks the tag is on main, and only its `publish` job can write.
`deploy-web.yml` runs after a successful CI of a push to main. Validate edits with
`go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12`. Tool versions are pinned, never `@latest`.

`wails3 dev`/`wails3 build` read `build/config.yml` and drive the root `Taskfile.yml` (which
`includes:` the per-OS Taskfiles under `build/`). After editing `build/config.yml`, regenerate
platform assets with `wails3 task common:update:build-assets`. Unused template platforms
(`build/android|ios|docker`) and auto-generated build binaries are gitignored — see `.gitignore`.

## Project skills (`.claude/skills/`)

On-demand skills (canonical source `.agents/skills/`; each `.claude/skills/*/SKILL.md` is a
symlink to it — edit the canonical file): `wails` and `go-modern`
(language/framework reference), `new-domain` (scaffold a backend domain following `backend/users`),
`db-migration` (create/register a SQL migration), `verify` (run the app and check a change
end-to-end) and `release` (macOS/Windows packaging; user-invoked only).

## Config maintenance
- After ANY task that changed structure, commands or conventions: check that this file still
  matches reality; propose the exact edit in the same session.
- Same-session fix also when a documented command fails, a stated convention contradicts the
  code, or the user corrects the same thing twice.
- New repeated procedure → propose a `.claude/skills/` entry; new language/area convention →
  a `paths:`-scoped rule in `.claude/rules/` — never more always-loaded lines.
- New technology appears in the repo (dependency, SDK, platform, infra — e.g. a cloud
  provider or a new datastore) → offer the matching plugins/skills/rules in the same
  session; ask first, never add silently.
- After structural changes (new package, framework migration, tooling swap), re-run
  `/setup-project audit`.
