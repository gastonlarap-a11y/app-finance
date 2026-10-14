---
paths:
  - "tools/codemap/**"
  - "frontend/scripts/codemap*"
---

# Code map (`tools/codemap`) invariants

Overview and commands: `ARCHITECTURE.md` §13 "Code map".

- **Dev tool only**: nothing in the app imports `tools/codemap`, and `go list -deps .` must not
  grow because of it. Its answers are text in Spanish, cite `file:line`, and never hide what the
  index could not resolve (`Unresolved`, "sin resolver") nor a partial index (`Graph.Notes`).
- **Graph model** (`internal/graph`): node IDs are stable — `go:<pkgpath>.<Recv>.<Name>`,
  `ts:<relpath>#<Outer.Name>`, `sql:<table>`. A `services/contract.ts` member is the hub: TS
  callers point to it and it `Dispatch`es to the Go bound method (`desktop`) and the engine
  implementation (`web`). CLI, MCP and viewer share one renderer (`text.go`) and one set of
  answers (`answers.go`).
- **Go half**: `go/packages` only lists packages and builds dependency export data; the module is
  type-checked **sequentially** in `goload.go`. Do not switch back to `NeedTypes`/`NeedSyntax`:
  concurrent checkers race inside Go 1.27's `go/types` and break `go test -race`. Bound methods
  come from `application.NewService[T]` instances; tables from bun `Model`/`TableExpr` (verb from
  the query type) and from SQL strings and constants (`classifySQL`, upper-case keywords only).
- **TS half** (`frontend/scripts/codemap-ts.ts`): Node runs the file directly — erasable syntax
  only, `ts.sys` only (no `@types/node`). Its `EXTRACT_VERSION` must equal `tsExtractVersion` in
  `internal/index/ts.go`; bump both on any change to the JSON shape.
- **Tests**: the fixture `internal/index/testdata/app` is a miniature of this repo (stub Wails and
  bun, migrations with create/rename/drop, a contract with binding + engine). A new code pattern
  the index must understand goes into the fixture with its test. Node-backed tests skip without
  `frontend/node_modules` unless `CODEMAP_REQUIRE_NODE=1` (CI sets it after `npm ci`).
- **Archify** (`internal/archify`): emits only `architecture` and `sequence` at `schema_version` 1
  for Archify 3.1+ (`FindCLI` enforces it), `quality_profile: standard`, `locale: es`. Respect
  Archify's layout rules (origin near `[40,40]`, canvas ≤ 1240px, label gaps, no self-messages,
  short participant labels — all tables share one SQLite lifeline) and never emit an empty card
  (`null` items fail the schema). Cite only files clean at `HEAD`, and pin `meta.repository` only
  with at least one citation and only when the root is the checkout's top.
- **Viewer and Ask** (`internal/viewer`), security invariants: listen on 127.0.0.1 only; every
  request passes `guard` (per-launch token → HttpOnly SameSite=Strict cookie, Host is this
  server, POST needs this Origin and a JSON body); pages carry `pageCSP` (no inline script),
  Archify files are served only by listed name with `diagramCSP` (sandboxed, opaque origin).
  `claude` runs from `Asker.args` only: `--restricted`, `--tools Read,Grep,Glob`,
  `--strict-mcp-config`, `dontAsk`, `//`-anchored deny rules (`/path` rules anchor at the settings
  source and an inline `--settings` has none — that gap leaked `config.toml` once), the question
  on stdin, session IDs validated, paid-auth env vars stripped, never `--bare`. Changing any of it
  needs `CODEMAP_LIVE_CLAUDE=1 go test -run TestLiveClaude ./tools/codemap/internal/viewer/`.
- **MCP**: every tool is read-only (`ReadOnlyHint`) and answers within `graph.MaxChars`. The
  server is registered in `.mcp.json`, mirrored by hand in `.codex/config.toml`, and enabled in
  `.claude/settings.json` (`enabledMcpjsonServers`).
