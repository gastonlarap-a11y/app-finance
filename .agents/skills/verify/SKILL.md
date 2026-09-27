---
name: verify
description: Launch App Finance and verify a change end-to-end (build backend + Vite dev server + native window). Use before declaring UI/backend work done.
---

# Verify

This is a Wails v3 desktop app — "verify" means the app actually builds, binds, and opens.

1. **Fast checks first** (no window):
   - `go build . && go vet ./... && go test ./...` — backend compiles, binds, passes.
   - `cd frontend && npm run build` — frontend typechecks (`tsc --noEmit`) and bundles.
2. **Run the app** for a real end-to-end check: `wails3 dev` (or `task dev` / `wails3 task dev`).
   Ready when the Vite dev server is up on `http://localhost:9245`, the native window opens, and
   bindings regenerate into `frontend/bindings/`. Hot reload covers both Go and frontend edits.
   - If the build stops with *"build output bin/app-finance already exists and is not an object
     file"*, a packaging run left a universal (lipo) binary there: move it aside (don't delete a
     release artifact without asking) and rerun.
   - `curl -s -o /dev/null -w '%{http_code}' http://localhost:9245/src/main.tsx` must print 200: a
     500 means a module the desktop dev server cannot resolve (e.g. a web-only virtual module
     imported from a file the desktop also loads), and the window stays blank.
3. **Exercise the changed surface** in the window — the sidebar screens (Resumen, Importar, Buscar,
   Año, Proyección, Gastos fijos, Ahorro) or the Configuración section involved (Tarjetas, Cuentas,
   Categorías y presupuestos, Etiquetas, Comercios, Reglas, Respaldo, Correo, Perfiles, Papelera,
   Apariencia, Actualizaciones); each has a URL (`#/config/tarjetas`) — and, for backend changes,
   confirm the expected data/behavior. For user-scoping changes, switch profiles (sidebar footer)
   and confirm each profile sees only its own data.
   - To look at the native window, capture only it: get its id with a CoreGraphics window list
     (owner "App Finance") and run `screencapture -x -o -l<id> <file>.png`.
   - Web target: `npm run build:web && npx vite preview --mode web`; unregister the service worker
     (DevTools or `navigator.serviceWorker.getRegistrations()`) or you get the previously cached build.
4. Stop the dev process; report what was actually observed (not just that it compiled).

> Never use `wails dev` (the v2 CLI) — it fails with *"Unable to find Wails in go.mod"*. Use
> `wails3` / `task`. Run `wails3 doctor` if the toolchain looks off.
