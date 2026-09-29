# app-finance

Guidance for any AI agent working in this repository — Claude Code reads it through the thin
`CLAUDE.md` that imports this file; Codex and Antigravity read it natively.

## What this repo is

**App Finance** — a [Wails v3](https://v3.wails.io) desktop **personal-finance manager** (Spanish
UI): a Go backend bound to a React 19 + Vite frontend, plus an installable web/PWA target for iPad
running the same UI over a local TypeScript engine. Local SQLite storage, optional Google Drive
backup. Features: `README.md`; full architecture and rationale: `ARCHITECTURE.md`.

This is **Wails v3, not v2** — confirm via the import `github.com/wailsapp/wails/v3/pkg/application`
in `main.go`. Never use v2 APIs (`wails.Run`, `OnDomReady`, the global `runtime` package) or the v2
CLI (`wails dev` fails here — always `wails3`). See the `wails` skill for the v2→v3 mapping.

## Commands

```bash
# Development
wails3 dev            # dev mode: build + Vite dev server (:9245) + window + hot reload (or: task dev)
go build . && go vet ./...     # quick backend compile + vet
go test -race ./...            # backend tests; single: go test -run TestName ./backend/finance
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

# Packaging and releases (tag vX.Y.Z → .github/workflows/release.yml) → `release` skill (user-invoked)

# Bindings and toolchain
wails3 generate bindings -ts   # regenerate TS bindings after changing exported Go signatures
wails3 doctor         # verify toolchain after any version/dependency change
```

Sandboxed-session quirks: prefix Go commands with `GOCACHE=$TMPDIR/gocache` (the default build
cache is not sandbox-writable); `go build .`'s dsymutil step also fails — use
`go build -ldflags=-w -o /dev/null .` as the compile+link check. Prefer `./node_modules/.bin/tsc`
over `npx tsc` and pass `--cache $TMPDIR/npm-cache` to npm (the npm cache is not sandbox-writable);
`npm install` (lockfile), dev servers and the vitest `browser` project (port bind) need to run
outside the sandbox. `clang: couldn't create cache file …xcrun_db…` lines during cgo builds are
harmless noise.

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

## Architecture (repo-wide invariants)

- **`main.go` is the only orchestration point** (no `app.go` god object): `application.New` →
  DB open + migrations → shared deps → services via `app.RegisterService` → window → `app.Run()`
  (ordering and startup failures: `.claude/rules/desktop-runtime.md`).
- **One Service per domain**: plain struct + `application.NewService(...)`; exported methods
  auto-bind to TS. Reference: `backend/finance/service.go`. Current services: `finance`, `users`,
  `settings`, `updates` (desktop only), `reminders` (desktop only, native due-date notifications, no
  bound methods), `diagnostics`, `reports`. Every exported method of a service becomes a binding:
  anything one service must offer another is a package function, never a method. Dependencies
  point one way — `reminders → finance → users → backend/shared`; `backend/shared` imports a
  domain only for its `migrations` embed.FS (`backend/shared/db/migrator.go`).
- **User scoping (invariant)**: every finance read/write filters by the user id; a query that
  forgets it leaks another profile's data. Each bound method reads `uid := s.uid()` ONCE and passes
  it to its helpers (a concurrent SwitchUser must not mix profiles mid-call). Child tables without
  `user_id` (`fixed_expense_amounts`, `fixed_expense_payments`) are written only after proving the
  parent's ownership (`ownFixedExpense`). Guard new bound methods with a cross-user test in
  `backend/users/isolation_test.go` (+ its vitest mirror in `frontend/src/engine/finance/features.test.ts`).
- **Go⇄TS parity (invariant)**: adding or changing a bound method in `finance`/`users` requires the
  same change in `frontend/src/services/contract.ts` and in the web engine
  (`frontend/src/engine/…/service.ts`), with a mirror test in vitest.
- **Schema changes**: embedded SQL migrations (`db-migration` skill); every new user-data table
  needs its three `sync_dirty_*` triggers; never delete or rename an applied migration file.
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

## Area rules — read before editing the area

Files in `.claude/rules/`. Claude Code loads each one automatically when it reads a matching path;
Codex and Antigravity: read the file before changing any path listed in its `paths:` header.

- `finance-domain.md` — ledger: savings, carried balance, fixed charges, soft delete, paid cuotas…
- `import-inbox.md` — bank statements/cartolas, their parsers and the import inbox.
- `persistence.md` — migrations, the SQLite connection, desktop⇄iPad sync state, web DB.
- `desktop-runtime.md` — `main.go`, in-app updates, shared packages, Wails build tooling.
- `frontend-app.md` — data loading, dialogs, export, web/PWA target; `frontend-ui.md` — UI look.
- `ci-workflows.md` — GitHub Actions workflows; `agent-config.md` — this file and agent config.

## Git

- Conventional Commits: `feat|fix|refactor|test|chore|ci|docs(scope): message`.
- No AI attribution anywhere — no `Co-Authored-By` trailers, no "Generated with" footers.
- Push only a branch that already contains `origin/main`. `.claude/hooks/git-safety.sh` enforces
  both rules for Claude Code.

## Engineering standards

- Every feature ships with its tests: Go `_test.go` beside the code, vitest `*.test.ts` (logic) or
  `*.dom.test.tsx` (UI) beside the unit, plus the engine mirror for bound methods. Run `task check`
  before declaring work done and report the real results.
- Handle errors explicitly at boundaries; never swallow exceptions or ignore returned errors.
- No speculative abstractions: introduce a pattern only for a problem this repo has, and say which
  and why.
- Ambiguous request → ask targeted questions first. Requested approach wrong or beatable → say why
  and let the requester choose before proceeding.
