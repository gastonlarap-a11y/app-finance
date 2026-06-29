# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this repo is

**App Finance** — a [Wails v3](https://v3.wails.io) desktop **personal-finance manager** (Spanish UI):
a Go backend bound to a React 19 + Vite frontend. It tracks money month to month — per-month salary,
extra incomes, expenses (one-off or in credit-card installments/cuotas), **recurring fixed expenses**
(subscriptions/services that carry forward automatically), cards (cupo/billing day), categories, and
monthly/yearly summaries — with local SQLite storage and optional Google Drive backup.

It was scaffolded from a Wails v3 template generator (which deleted itself after generating); this
repo is now the *app*, not the generator. There is no `generador.go`.

This is **Wails v3, not v2** — confirm via the import `github.com/wailsapp/wails/v3/pkg/application`
in `main.go`. Never use v2 APIs (`wails.Run`, `OnDomReady`, the global `runtime` package) or the v2
CLI (`wails dev`). See the `wails` skill for the v2→v3 mapping.

## Commands

```bash
# Desarrollo
wails3 dev            # dev mode: build + Vite dev server (:9245) + window + hot reload (or: task dev)
go build . && go vet ./...     # quick backend compile + vet

# Build y distribución macOS
wails3 build          # production build → bin/app-finance (or: task build)
task package          # macOS .app bundle (ad-hoc signed) → bin/app-finance.app
task package:dmg      # macOS disk image → bin/app-finance.dmg

# Build y distribución Windows (cross-compile desde macOS)
task build:windows    # compila .exe amd64 → bin/app-finance.exe
task package:windows  # instalador NSIS amd64 → build/windows/nsis/app-finance-installer.exe
                      # Prerrequisito (una sola vez): brew install makensis

# Bindings y toolchain
wails3 generate bindings -ts   # regenerate TS bindings after changing exported Go signatures
wails3 doctor         # verify toolchain after any version/dependency change
```

Never run `wails dev` (v2 CLI) — it fails with *"Unable to find Wails in go.mod"*. Use `wails3`.

## Versions (alpha — keep aligned)

- Go library: `github.com/wailsapp/wails/v3 v3.0.0-alpha2.108` (pinned in `go.mod`).
- `wails3` CLI **must match** the Go library version; reinstall with
  `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.108` when you change the pin.
- npm `@wailsio/runtime` tracks its own `latest` (`3.0.0-alpha.94`) — the series that pairs with the
  Go alpha2.108 line. Run `wails3 doctor` after any toolchain change.

## Architecture

- **`main.go` is the only orchestration point** (no `app.go` god object): construct shared deps
  (config, db, logger, worker) → build the `Services` slice → `application.New` → window → `app.Run()`.
- **One Service per domain.** A service is a plain struct registered with `application.NewService(...)`;
  exported methods auto-bind to TypeScript. Optional lifecycle hooks: `ServiceName()`,
  `ServiceStartup(ctx, application.ServiceOptions)`, `ServiceShutdown()`. Reference:
  `backend/finance/service.go`. Current services: `finance`, `settings`, `diagnostics`, `reports`.
- **`finance` domain** (`backend/finance/`) holds the app's core logic. Unlike the "one model.go"
  template, it splits one file per entity: `card.go`, `category.go`, `expense.go`, `income.go`,
  `installment.go`, `salary.go`, `settings.go`, `fixedexpense.go`, plus `period.go` (YYYY-MM math),
  `result.go` (view models / Result wrappers) and `service.go` (all bound methods + summaries).
- **`settings` domain** (`backend/settings/`) owns DB-folder selection, Google Drive connect/disconnect,
  OAuth client config, and backup-on-close — surfaced in the app's "Ajustes" tab.
- **Backup + Google Drive**: `backend/shared/backup` snapshots the SQLite DB and uploads to Drive via
  `backend/shared/drive` (OAuth2, `golang.org/x/oauth2` + `google.golang.org/api`). `main.go` runs a
  backup in its `OnShutdown` hook when backup-on-close is enabled.
- **Shared packages** live under `backend/shared/`: `config`, `prefs` (user prefs that **override**
  config — DB folder, OAuth creds, backup-on-close; loaded in `main.go`), `db` (connection +
  `migrator.go`), `logger`, `errors.go` (`AppError`), `windowstate`, `background` (goroutine pool),
  `backup`, `drive`, `types` (Decimal).
- **Migrations** are SQL files embedded with `go:embed` and run on startup; register each domain's
  `embed.FS` in `backend/shared/db/migrator.go` (currently `financemigrations` + `windowstatemigrations`).
  Filename numeric prefix sets global order. Current finance set: `004_create_finance`,
  `005_salary_categories`, `006_create_fixed_expenses`.
- **Per-month / effective-dated data**: a value that exists per month is keyed by a `period` (YYYY-MM)
  column and resolved by lexical string comparison (`period < ?`, `period <= ?`, `period LIKE 'YYYY-%'`).
  `PeriodSalary` stores one value per month. **Fixed expenses** add carry-forward + "edit from this
  month onward": `fixed_expense_amounts(effective_from, amount)` is resolved by taking the greatest
  `effective_from <= month`, so editing a month inserts a new override without touching the past;
  `fixed_expense_payments` marks paid/pending per month sparsely. See `backend/finance/fixedexpense.go`.
- **Window state** persists to the `app_settings` table on `events.Common.WindowClosing`
  (`backend/shared/windowstate/`).

## Conventions

- Bound methods take `context.Context` as the first param and **must not block** the call handler —
  hand heavy work to `background.Worker` and stream results via emitted events; honor `ctx.Done()`.
- **Errors**: system/IO errors → return a native Go `error` (rejects the JS promise). Business errors
  (validation/not-found/conflict) → return a Result struct with `*shared.AppError` set (resolves;
  frontend checks `result.error`). Codes in `backend/shared/errors.go`.
- **Money** uses `backend/shared/types.Decimal`, stored as TEXT and marshaled to JSON as a **string**.
  Keep it a string on the frontend; format with `Intl.NumberFormat`, never `parseFloat` for math.
- **Bindings**: never import from `frontend/bindings/` directly across the app (it's gitignored and
  regenerated) — wrap each service in one module and import that. Regenerate after signature changes.

## Adding a new domain

1. `mkdir backend/<domain>`; create model file(s), `result.go`, `service.go` (+ `migrations/` with
   `embed.go` and `.up.sql`/`.down.sql`). `finance` splits one file per entity instead of a single
   `model.go` — follow whichever fits the domain's size.
2. Register the migrations `embed.FS` in `backend/shared/db/migrator.go` (only when adding a *new*
   domain `embed.FS`; extra `.sql` files inside an already-registered domain need no change).
3. Register the service in the `main.go` `Services` slice via `application.NewService(...)`.
4. `wails3 generate bindings -ts`, then re-export from a `frontend/src/services/<domain>.ts` wrapper
   and import that (never `frontend/bindings/` directly).

## Build/dev tooling

`wails3 dev`/`wails3 build` read `build/config.yml` and drive the root `Taskfile.yml` (which
`includes:` the per-OS Taskfiles under `build/`). Regenerate platform assets after editing
`build/config.yml` with `wails3 task common:update:build-assets`. See `ARCHITECTURE.md` for details.

**Plataformas no usadas (gitignoreadas):** `build/android/`, `build/ios/` y `build/docker/` fueron
generadas por el template de Wails pero esta app sólo soporta macOS y Windows — están en `.gitignore`.
Los binarios `build/darwin/Assets.car` (1.8 MB) y `build/windows/nsis/MicrosoftEdgeWebview2Setup.exe`
(1.7 MB) también se excluyen del repo porque se auto-generan durante `task build` / `task package:windows`.
