---
name: release
description: Package App Finance for distribution — macOS .app/.dmg and Windows NSIS installer. User-invoked only.
disable-model-invocation: true
---

# Release / packaging

Side-effectful build packaging. Run only when the user explicitly asks. Verify first, then package
for the target platform(s).

1. **Pre-flight**: `go build . && go vet ./... && go test ./...` and `cd frontend && npm run build`
   must pass. Confirm the toolchain with `wails3 doctor` (the `wails3` CLI version must match the
   `github.com/wailsapp/wails/v3` pin in `go.mod`).

2. **macOS**:
   - `task build` → `bin/app-finance` (stripped production binary).
   - `task package` → `bin/app-finance.app` (ad-hoc signed bundle).
   - `task package:dmg` → `bin/app-finance.dmg` (the shareable artifact).
   - The bundle is **not notarized** (needs an Apple Developer account); on another Mac, Gatekeeper
     may block the first launch → right-click → Open → Open anyway.

3. **Windows** (cross-compiled from macOS, no CGO — pure-Go `modernc.org/sqlite`):
   - One-time prerequisite: `brew install makensis`.
   - `task build:windows` → `bin/app-finance.exe` (amd64).
   - `task package:windows` → `build/windows/nsis/app-finance-installer.exe` (Start-menu entry +
     uninstaller). Unsigned → SmartScreen warns on first run (Más información → Ejecutar de todos modos).

4. If `build/config.yml` changed (product name, file associations, icons), regenerate platform assets
   first: `wails3 task common:update:build-assets`.

5. Report the exact artifact paths produced and their sizes.
