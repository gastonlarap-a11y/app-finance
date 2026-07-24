---
name: new-domain
description: Scaffold a new backend domain/service for App Finance following the backend/users exemplar (model + result + service + migrations, registered in main.go and bound to TS). Use when adding a new bound domain.
argument-hint: "<domain-name>"
---

# New domain

A domain is a plain Go package with a struct registered via `application.NewService(...)`; its
exported methods auto-bind to TypeScript. `backend/users/` is the smallest complete exemplar;
`backend/finance/` shows the one-file-per-entity split for larger domains.

1. **Create `backend/<domain>/`** mirroring `backend/users/`:
   - model file(s) — bun structs (`user.go`; `finance` splits `card.go`, `expense.go`, … instead).
     User-owned data carries a `user_id` column; deletable data uses `bun:",soft_delete"`.
   - `result.go` — Result wrappers with `*shared.AppError` for business errors.
   - `service.go` — the struct + `NewService(...)` constructor, `ServiceName() string`, optional
     `ServiceStartup`/`ServiceShutdown`, and the exported bound methods.
   - `migrations/` — `embed.go` (`//go:embed *.sql` → `var Migrations embed.FS`) plus the first
     `.up.sql`/`.down.sql` pair (see the `db-migration` skill for prefixing).
2. **Register the migrations embed.FS** in `backend/shared/db/migrator.go` (import + append to the
   slice) — required because this is a new domain `embed.FS`.
3. **Register the service** in the `main.go` `Services` slice via `application.NewService(<svc>)`.
   If the domain reads user-scoped data, inject the shared `users.Session` like `finance` does.
4. **Conventions**: bound methods take `context.Context` first and must not block; system/IO errors
   return a native `error`, business errors return a Result with `*shared.AppError`; money is
   `shared/types.Decimal` (string over the bridge).
5. **Bindings**: `wails3 generate bindings -ts`, then re-export from
   `frontend/src/services/<domain>.ts` and import that wrapper (never `frontend/bindings/` directly).
6. Add tests (isolation test if user-scoped), run `go build . && go vet ./... && go test ./...` and
   `cd frontend && npm run build`; report real results.
