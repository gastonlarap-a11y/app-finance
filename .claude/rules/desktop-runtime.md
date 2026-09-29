---
paths:
  - "main.go"
  - "backend/{updates,settings,reminders,diagnostics,reports,shared}/**"
  - "tools/**"
  - "build/**"
  - "Taskfile.yml"
---

# Desktop runtime invariants

- **`main.go` is the only orchestration point** (no `app.go` god object): `application.New`
  (SingleInstance, `Logger`, `PanicHandler`) → DB open + migrations → shared deps → services via
  `app.RegisterService` → window → `app.Run()`. `New` comes first because SingleInstance is enforced
  inside it: a second copy must exit before touching the DB. Startup failures go through
  `exitWithDialog` (native error dialog), never a bare `os.Exit`.
- **In-app updates** (`backend/updates`, Wails `pkg/updater`): `main()` must call
  `updater.HandleHelperMode()` before anything else; the app version is `info.version` of the
  embedded `build/config.yml`; a release artifact without an entry in `SHA256SUMS.txt` or a valid
  Ed25519 `<artifact>.sig` (key pinned in `backend/updates/update_signing.pub`, signed in the
  release workflow's `sign` job by `tools/updatesign`) is never installed; the close-time backup runs
  in `RestartToUpdate`, not `OnShutdown` (the updater's helper aborts if the app takes > 30 s to
  quit). Release asset names/zip flags and key rotation: `release` skill.
- **Shared packages** under `backend/shared/`: `config`, `prefs` (user prefs that override config),
  `db`, `logger`, `errors.go` (`AppError`), `windowstate`, `background` (goroutine pool), `backup`,
  `drive`, `types` (Decimal). The `settings` domain owns DB-folder selection, Google Drive OAuth
  and backup-on-close (backup runs in `main.go`'s `OnShutdown`). The OAuth client is never in git:
  local builds read the gitignored `backend/shared/drive/credentials.local.go`; the release workflow
  generates it from the `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` repository secrets.
- **Build tooling**: `wails3 dev`/`wails3 build` read `build/config.yml` and drive the root
  `Taskfile.yml` (which `includes:` the per-OS Taskfiles under `build/`). After editing
  `build/config.yml`, regenerate platform assets with `wails3 task common:update:build-assets`.
  Unused template platforms (`build/android|ios|docker`) and auto-generated build binaries are
  gitignored — see `.gitignore`.
