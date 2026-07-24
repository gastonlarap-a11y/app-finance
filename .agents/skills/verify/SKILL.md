---
name: verify
description: Launch App Finance and verify a change end-to-end (build backend + Vite dev server + native window). Use before declaring UI/backend work done.
---

# Verify

This is a Wails v3 desktop app — "verify" means the app actually builds, binds, and opens.

1. **Fast checks first** (no window):
   - `go build . && go vet ./... && go test ./...` — backend compiles, binds, passes.
   - `cd frontend && npm run build` — frontend typechecks (`tsc --noEmit`) and bundles.
2. **Run the app** for a real end-to-end check: `wails3 dev` (or `task dev`). Ready when the Vite
   dev server is up on `http://localhost:9245`, the native window opens, and bindings regenerate
   into `frontend/bindings/`. Hot reload covers both Go and frontend edits.
3. **Exercise the changed surface** in the window (the relevant tab: Mes, Año, Gastos fijos,
   Tarjetas, Categorías, Comercios, Papelera, Ajustes) and, for backend changes, confirm the
   expected data/behavior. For user-scoping changes, switch profiles (`UserSwitcher`) and confirm
   each profile sees only its own data.
4. Stop the dev process; report what was actually observed (not just that it compiled).

> Never use `wails dev` (the v2 CLI) — it fails with *"Unable to find Wails in go.mod"*. Use
> `wails3` / `task`. Run `wails3 doctor` if the toolchain looks off.
