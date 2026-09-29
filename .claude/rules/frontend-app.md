---
paths:
  - "frontend/src/**"
  - "frontend/vite.config.ts"
  - "frontend/tsconfig*.json"
---

# Frontend app conventions

UI look, primitives and navigation: `frontend-ui.md`.

- **Frontend data loading**: `useQuery(key, load)` (`lib/useQuery.ts`) — encode every input
  (period, `useVersion(...topics)`…) in the key; it drops stale responses and turns rejections into
  an error state (`QueryError`). Mutations call `failed(res)` (toast via `lib/notify.ts`, never
  `window.alert`) and `useInvalidate()(...topics)` for what they changed (`atoms/refresh.ts`:
  ledger | imports | profiles | settings; no topic = all, e.g. a profile switch). Atoms hold
  UI state only — never server data.
- **Dialogs**: `Modal` is a native `<dialog>` (focus trap, Escape); icon-only buttons use
  `IconButton` (mandatory accessible label). React Compiler is on: no manual `useCallback`/`useMemo`.
- **Export**: views build an `ExportTable` (`frontend/src/lib/exportTables.ts`, money as decimal
  strings); `@/services/reports` writes it — desktop via `ReportsService.SaveTable` (.xlsx + native
  Save dialog; blob downloads are unreliable in the webview), web via CSV + Share Sheet.
- **Web/PWA target (iPad)**: `vite --mode web` ships the same React app as a PWA backed by a TS
  port of the domain (`frontend/src/engine/`) over sqlite-wasm (opfs-sahpool, Worker + Comlink).
  Mode `web` aliases `@/services/{finance,users,settings,…}` → `frontend/src/services/web/*`; the
  shared type contract is `frontend/src/services/contract.ts`. Deploy:
  `.github/workflows/deploy-web.yml` → GitHub Pages. See `ARCHITECTURE.md` §17. The service worker
  is `prompt` mode, registered only in `main.tsx`'s web branch. Web DB invariants (import check,
  one-tab lock, shared migrations): `persistence.md`.
