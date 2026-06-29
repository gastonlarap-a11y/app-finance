package drive

// Baked-in Google OAuth client (the *app's* identity, not a user account).
//
// Fill these ONCE with your "Desktop app" OAuth client from Google Cloud Console
// so that every person who installs the app only has to click "Conectar con Google
// Drive" — they never see or enter a Client ID.
//
//   - Override at build time without editing source: `-ldflags "-X '...drive.bakedClientID=...'"`
//     or the env vars GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.
//   - For a Desktop OAuth client the "secret" is NOT confidential; Google expects
//     it to ship inside distributed desktop apps.
//
// Leave empty to fall back to the env vars or a Client ID pasted in the UI (Ajustes).
// Leave empty in version-controlled source. Override via credentials.local.go
// (gitignored) or -ldflags "-X .../drive.bakedClientID=..." at build time.
var (
	bakedClientID     = ""
	bakedClientSecret = ""
)
