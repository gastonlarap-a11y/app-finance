# app-finance

Guidance for any AI agent working in this repository — Claude Code reads it through the thin
`CLAUDE.md` that imports this file; Codex and Antigravity read it natively.

## What this repo is

**App Finance** — a [Wails v3](https://v3.wails.io) desktop **personal-finance manager** (Spanish
UI): a Go backend bound to a React 19 + Vite frontend, plus an installable web/PWA target for iPad
running the same UI over a local TypeScript engine. It tracks money month to month — per-month
salary, extra incomes, expenses (one-off or credit-card installments/cuotas), recurring fixed
expenses, cards, categories (with effective-dated monthly budgets), merchants, monthly/yearly
summaries (incl. category × month), a commitments forecast and a history-wide expense search — with
local SQLite storage and optional Google Drive backup.

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
task check                     # go vet + golangci-lint + ESLint + typecheck (desktop+web) + tests + build:web
task lint | task test | task typecheck | task vuln   # individual gates (.golangci.yml, frontend/eslint.config.js)

# Web/PWA target (iPad) — same frontend, local TS engine (no Go backend)
cd frontend && npm run dev:web    # dev server for the web target (open /app-finance/ in a browser)
cd frontend && npm run build:web  # typecheck (tsconfig.web.json) + PWA bundle → dist/
cd frontend && npm test           # vitest: TS engine against sqlite-wasm in Node

# Packaging/distribution (macOS .app/.dmg, Windows NSIS installer) → `release` skill (user-invoked)

# Bindings and toolchain
wails3 generate bindings -ts   # regenerate TS bindings after changing exported Go signatures
wails3 doctor         # verify toolchain after any version/dependency change
```

Sandboxed-session quirks: prefix Go commands with `GOCACHE=$TMPDIR/gocache` (the default build
cache is not sandbox-writable); `go build .`'s dsymutil step also fails — use
`go build -ldflags=-w -o /dev/null .` as the compile+link check. Prefer `./node_modules/.bin/tsc`
over `npx tsc` and pass `--cache $TMPDIR/npm-cache` to npm (the npm cache is not sandbox-writable);
`npm install` (lockfile) and dev servers (port bind) need to run outside the sandbox.

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

- **`main.go` is the only orchestration point** (no `app.go` god object): shared deps →
  `Services` slice → `application.New` → window → `app.Run()`.
- **One Service per domain**: plain struct + `application.NewService(...)`; exported methods
  auto-bind to TS. Reference: `backend/finance/service.go`. Current services: `finance`, `users`,
  `settings`, `diagnostics`, `reports`.
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
- **Effective-dated values** (fixed-expense amounts, category budgets): rows apply from
  `effective_from` onward; resolve with `latestAsOf`/`resolveAsOf`, sum ranges with `sumAsOf`
  (`backend/finance/fixedexpense.go`, mirrored in `frontend/src/engine/finance/fixedexpense.ts`).
- **Soft delete** (bun `soft_delete`) on cards/categories/incomes/expenses/fixed_expenses/users;
  deleted rows surface in the frontend "Papelera" (`TrashView.tsx`) with restore.
- **Migrations**: embedded SQL run on startup; register each domain's `embed.FS` in
  `backend/shared/db/migrator.go`; the `YYYYMMDDNNN` filename prefix sets global order. SQLite can
  add columns but not change/drop them — rebuild + copy instead. Use the `db-migration` skill.
- **Shared packages** under `backend/shared/`: `config`, `prefs` (user prefs that override config),
  `db`, `logger`, `errors.go` (`AppError`), `windowstate`, `background` (goroutine pool), `backup`,
  `drive`, `types` (Decimal). The `settings` domain owns DB-folder selection, Google Drive OAuth
  and backup-on-close (backup runs in `main.go`'s `OnShutdown`).
- **Web/PWA target (iPad)**: `vite --mode web` ships the same React app as a PWA backed by a TS
  port of the domain (`frontend/src/engine/`) over sqlite-wasm (opfs-sahpool, Worker + Comlink).
  Mode `web` aliases `@/services/{finance,users,settings}` → `frontend/src/services/web/*`; the
  shared type contract is `frontend/src/services/contract.ts`. The engine reuses the SAME
  `backend/*/migrations/*.up.sql` files, so exported `.sqlite` files are interchangeable
  desktop⇄web. Deploy: `.github/workflows/deploy-web.yml` → GitHub Pages. See `ARCHITECTURE.md` §17.

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
  (period, `refreshAtom`…) in the key; it drops stale responses and turns rejections into an error
  state (`QueryError`). Mutations call `failed(res)` (toast via `lib/notify.ts`, never
  `window.alert`) and bump `refreshAtom`. Atoms hold UI state only — never server data.
- **Dialogs**: `Modal` is a native `<dialog>` (focus trap, Escape); icon-only buttons use
  `IconButton` (mandatory accessible label). React Compiler is on: no manual `useCallback`/`useMemo`.
- **Go⇄TS parity (invariant)**: adding or changing a bound method in `finance`/`users` requires the
  same change in `frontend/src/services/contract.ts` and in the web engine
  (`frontend/src/engine/…/service.ts`), with a mirror test in vitest. Migrations need no engine
  change (auto-discovered by glob), but must be plain SQLite SQL with `--bun:split` separators.

## Build/dev tooling

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
