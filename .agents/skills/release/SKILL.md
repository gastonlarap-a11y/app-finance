---
name: release
description: Package App Finance for distribution — macOS .app/.dmg and Windows NSIS installer. User-invoked only.
disable-model-invocation: true
---

# Release / packaging

Side-effectful build packaging. Run only when the user explicitly asks. Verify first, then package
for the target platform(s).

Official releases are built by CI: bump `info.version` in `build/config.yml`, run
`wails3 task common:update:build-assets`, merge to `main`, then push the tag `vX.Y.Z` →
`.github/workflows/release.yml` publishes the `.dmg` + Windows setup as a GitHub Release. The steps
below are the local equivalent (testing a build, or packaging without CI).

**Google Drive backup in releases**: the workflow writes the gitignored
`backend/shared/drive/credentials.local.go` from the repository secrets `GOOGLE_OAUTH_CLIENT_ID` /
`GOOGLE_OAUTH_CLIENT_SECRET` (a Google Cloud "Desktop app" OAuth client) and fails if they are
missing — a release without them cannot refresh Drive tokens. To rotate the client: create a new
one in Google Cloud Console, delete the old one, `gh secret set` both values, update your local
`credentials.local.go`, and reconnect Drive once in Ajustes after installing the release. Keep the
consent screen **In production** (in "Testing" refresh tokens expire after 7 days).

**In-app updates** (`backend/updates`, Wails v3 `pkg/updater`): installed apps ≥ 0.3.0 check the
latest GitHub Release and update themselves from two extra assets the workflow publishes —
`app-finance-darwin-universal.zip` (the signed `.app` zipped with
`ditto -c -k --norsrc --noextattr --noacl --keepParent`; plain `ditto` adds `._*` AppleDouble files
that break the bundle's signature seal once extracted) and `app-finance-windows-amd64.exe`. Both
**must be listed in `SHA256SUMS.txt`** and **signed** (`<asset>.sig`, made by the workflow's `sign`
job): the app refuses to install an artifact without a checksum or a valid Ed25519 signature.

Update signing key (free, no service involved):
- Public key: `backend/updates/update_signing.pub` (committed, embedded in the app).
- Private key: the `UPDATE_SIGNING_KEY` secret of the `release` environment (deployment policy: `v*`
  tags only), plus the owner's offline backup. If it is lost, installed apps can no longer
  auto-update: users must install the next release by hand.
- Sign/verify by hand: `UPDATE_SIGNING_KEY="$(cat key.pem)" go run ./tools/updatesign sign -pub
  backend/updates/update_signing.pub FILE…` and `go run ./tools/updatesign verify -pub … FILE…`.
- Rotation (leak or schedule): `updatesign keygen` a new pair, commit the new `.pub`, and release
  it **signed with the old key** (installed apps only trust the old one). For that one release the
  `sign` job's `-pub` must point at the old key
  (`git show <previous tag>:backend/updates/update_signing.pub`), since the step refuses a secret
  that does not pair with the committed key. Swap the secret to the new key only after that release
  is out.
Keep those asset names (the macOS one is matched as platform `darwin` + arch `universal`). The
version the app compares against is `info.version` in `build/config.yml` (embedded by `main.go`),
so the tag must equal it — the workflow already enforces that.

1. **Pre-flight**: `task check` (vet + lint + typecheck + tests + web build) and
   `cd frontend && npm run build` must pass (under the Claude Code sandbox use
   `go build -ldflags=-w -o /dev/null .` for the compile check — see AGENTS.md). Confirm the
   toolchain with `wails3 doctor` (the `wails3` CLI version must match the
   `github.com/wailsapp/wails/v3` pin in `go.mod`).

2. **macOS**:
   - `task build` → `bin/app-finance` (stripped production binary).
   - `task package` → `bin/app-finance.app` (ad-hoc signed bundle).
   - `task package:dmg` → `bin/app-finance.dmg` (the shareable artifact).
   - The bundle is **not notarized** (needs an Apple Developer account). A downloaded copy carries
     the quarantine flag and Gatekeeper blocks its first launch; since macOS 15 right-click → Open no
     longer bypasses it: System Settings → Privacy & Security → **Open Anyway**, or
     `xattr -dr com.apple.quarantine /Applications/app-finance.app`. Tell the user never to pick
     "Move to Trash" in that dialog.

3. **Windows** (cross-compiled from macOS, no CGO — pure-Go `modernc.org/sqlite`):
   - One-time prerequisite: `brew install makensis`.
   - `task build:windows` → `bin/app-finance.exe` (amd64).
   - `task package:windows` → `bin/app-finance-amd64-installer.exe` (Start-menu entry +
     uninstaller). Unsigned → SmartScreen warns on first run (Más información → Ejecutar de todos modos).
     It installs **per user** (`%LOCALAPPDATA%\Programs`, no UAC) so the in-app updater can replace
     the exe; an older machine-wide install (Program Files, < 0.3.0) must be uninstalled first.

4. If `build/config.yml` changed (product name, file associations, icons), regenerate platform assets
   first: `wails3 task common:update:build-assets`.

5. Report the exact artifact paths produced and their sizes.
