// Package drive integrates Google Drive natively (no external tools): a visual
// OAuth login (loopback flow) and uploading a single backup file with the minimal
// `drive.file` scope (the app only ever sees the folder/files it creates).
//
// The OAuth Client ID identifies the *app* to Google — it is not a user account
// and stores no personal data. Each user logs in with their own Google account and
// the resulting token is stored only on their machine (prefs.TokenPath).
package drive

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	gdrive "google.golang.org/api/drive/v3"
	"google.golang.org/api/option"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/prefs"
)

// Baked-in OAuth client lives in credentials.go (so it can be set with ldflags).

// Manager handles OAuth + uploads for one app/user. Client credentials are
// resolved lazily so a UI-entered client ID takes effect without a restart.
type Manager struct {
	appName string
	resolve func() (id, secret string) // typically reads prefs
}

func NewManager(appName string, resolve func() (string, string)) *Manager {
	return &Manager{appName: appName, resolve: resolve}
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}

func (m *Manager) creds() (string, string) {
	var id, secret string
	if m.resolve != nil {
		id, secret = m.resolve()
	}
	id = firstNonEmpty(id, os.Getenv("GOOGLE_OAUTH_CLIENT_ID"), bakedClientID)
	secret = firstNonEmpty(secret, os.Getenv("GOOGLE_OAUTH_CLIENT_SECRET"), bakedClientSecret)
	return id, secret
}

// HasClientID reports whether an OAuth client is configured.
func (m *Manager) HasClientID() bool {
	id, _ := m.creds()
	return id != ""
}

// IsConnected reports whether a stored token exists.
func (m *Manager) IsConnected() bool {
	_, err := m.loadToken()
	return err == nil
}

// Disconnect removes the stored token.
func (m *Manager) Disconnect() error {
	err := os.Remove(prefs.TokenPath(m.appName))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (m *Manager) oauthConfig(redirectURL string) *oauth2.Config {
	id, secret := m.creds()
	return &oauth2.Config{
		ClientID:     id,
		ClientSecret: secret,
		Endpoint:     google.Endpoint,
		Scopes:       []string{gdrive.DriveFileScope},
		RedirectURL:  redirectURL,
	}
}

func (m *Manager) loadToken() (*oauth2.Token, error) {
	b, err := os.ReadFile(prefs.TokenPath(m.appName))
	if err != nil {
		return nil, err
	}
	t := new(oauth2.Token)
	if err := json.Unmarshal(b, t); err != nil {
		return nil, err
	}
	return t, nil
}

func (m *Manager) saveToken(t *oauth2.Token) error {
	if err := os.MkdirAll(prefs.Dir(m.appName), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(prefs.TokenPath(m.appName), b, 0o600)
}

// Connect runs the loopback OAuth flow: it opens the user's browser (via openBrowser)
// to Google's consent screen and waits for the redirect to capture the code.
func (m *Manager) Connect(ctx context.Context, openBrowser func(string) error) error {
	if !m.HasClientID() {
		return errors.New("falta el Client ID de Google. Configúralo en Ajustes o en el build")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	conf := m.oauthConfig(fmt.Sprintf("http://127.0.0.1:%d/callback", port))

	state := randomState()
	// PKCE: ties the auth code to this client instance, so the (non-confidential,
	// embedded) client secret is not what secures the exchange. Recommended by
	// Google for installed/desktop apps.
	verifier := oauth2.GenerateVerifier()
	authURL := conf.AuthCodeURL(state, oauth2.AccessTypeOffline, oauth2.S256ChallengeOption(verifier))

	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("state") != state {
			http.Error(w, "state inválido", http.StatusBadRequest)
			errCh <- errors.New("state mismatch")
			return
		}
		if e := q.Get("error"); e != "" {
			fmt.Fprintf(w, "Error: %s. Puedes cerrar esta pestaña.", e)
			errCh <- fmt.Errorf("oauth: %s", e)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, successHTML)
		codeCh <- q.Get("code")
	})
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Shutdown(context.Background())

	if err := openBrowser(authURL); err != nil {
		return fmt.Errorf("no se pudo abrir el navegador: %w", err)
	}

	select {
	case code := <-codeCh:
		tok, err := conf.Exchange(ctx, code, oauth2.VerifierOption(verifier))
		if err != nil {
			return fmt.Errorf("intercambio de token: %w", err)
		}
		return m.saveToken(tok)
	case err := <-errCh:
		return err
	case <-time.After(3 * time.Minute):
		return errors.New("tiempo de espera agotado para el inicio de sesión")
	case <-ctx.Done():
		return ctx.Err()
	}
}

// AccountEmail returns the connected Google account email (best-effort; empty if
// the API doesn't expose it under the drive.file scope).
func (m *Manager) AccountEmail(ctx context.Context) string {
	svc, err := m.service(ctx)
	if err != nil {
		return ""
	}
	about, err := svc.About.Get().Fields("user(emailAddress)").Context(ctx).Do()
	if err != nil || about.User == nil {
		return ""
	}
	return about.User.EmailAddress
}

func (m *Manager) service(ctx context.Context) (*gdrive.Service, error) {
	tok, err := m.loadToken()
	if err != nil {
		return nil, errors.New("no estás conectado a Google Drive")
	}
	ts := m.oauthConfig("").TokenSource(ctx, tok)
	if refreshed, err := ts.Token(); err == nil && refreshed.AccessToken != tok.AccessToken {
		_ = m.saveToken(refreshed)
	}
	return gdrive.NewService(ctx, option.WithTokenSource(ts))
}

// Upload uploads localFile into folderName (created if needed), overwriting the
// single backup file. Returns the (possibly new) folder and file ids to cache.
func (m *Manager) Upload(ctx context.Context, localFile, folderName, fileName, folderID, fileID string) (string, string, error) {
	svc, err := m.service(ctx)
	if err != nil {
		return "", "", err
	}

	folderID = m.ensureFolder(ctx, svc, folderName, folderID)
	if folderID == "" {
		return "", "", errors.New("no se pudo crear/obtener la carpeta en Drive")
	}

	f, err := os.Open(localFile)
	if err != nil {
		return folderID, "", err
	}
	defer f.Close()

	if fileID != "" {
		if _, e := svc.Files.Get(fileID).Fields("id").Context(ctx).Do(); e != nil {
			fileID = ""
		}
	}
	if fileID == "" {
		q := fmt.Sprintf("name=%s and %s in parents and trashed=false", quote(fileName), quote(folderID))
		if list, e := svc.Files.List().Q(q).Fields("files(id)").Context(ctx).Do(); e == nil && len(list.Files) > 0 {
			fileID = list.Files[0].Id
		}
	}

	if fileID != "" {
		if _, e := svc.Files.Update(fileID, &gdrive.File{}).Media(f).Context(ctx).Do(); e != nil {
			return folderID, "", fmt.Errorf("actualizar archivo en Drive: %w", e)
		}
		return folderID, fileID, nil
	}
	created, e := svc.Files.Create(&gdrive.File{Name: fileName, Parents: []string{folderID}}).
		Media(f).Fields("id").Context(ctx).Do()
	if e != nil {
		return folderID, "", fmt.Errorf("subir archivo a Drive: %w", e)
	}
	return folderID, created.Id, nil
}

// ensureFolder resolves a Drive folder path that may contain "/" separators.
// It walks each segment from the root, finding or creating each level. If
// folderID is still valid it is returned immediately (fast path for repeat
// backups).
func (m *Manager) ensureFolder(ctx context.Context, svc *gdrive.Service, name, folderID string) string {
	if folderID != "" {
		if _, e := svc.Files.Get(folderID).Fields("id").Context(ctx).Do(); e == nil {
			return folderID
		}
	}
	parentID := ""
	for _, seg := range strings.Split(name, "/") {
		seg = strings.TrimSpace(seg)
		if seg == "" {
			continue
		}
		parentID = m.ensureFolderChild(ctx, svc, seg, parentID)
		if parentID == "" {
			return ""
		}
	}
	return parentID
}

// ensureFolderChild finds or creates a single folder named name as a direct
// child of parentID (or the user's root Drive when parentID is empty).
func (m *Manager) ensureFolderChild(ctx context.Context, svc *gdrive.Service, name, parentID string) string {
	var q string
	if parentID == "" {
		// Omit 'root' in parents: with drive.file scope that constraint can return
		// empty results even for folders the app just created. Filtering by name
		// alone is safe because drive.file already limits visibility to app files.
		q = fmt.Sprintf("mimeType='application/vnd.google-apps.folder' and name=%s and trashed=false", quote(name))
	} else {
		q = fmt.Sprintf("mimeType='application/vnd.google-apps.folder' and name=%s and %s in parents and trashed=false", quote(name), quote(parentID))
	}
	if list, e := svc.Files.List().Q(q).Fields("files(id)").Context(ctx).Do(); e == nil && len(list.Files) > 0 {
		return list.Files[0].Id
	}
	f := &gdrive.File{Name: name, MimeType: "application/vnd.google-apps.folder"}
	if parentID != "" {
		f.Parents = []string{parentID}
	}
	created, e := svc.Files.Create(f).Fields("id").Context(ctx).Do()
	if e != nil {
		return ""
	}
	return created.Id
}

// quote renders a Drive query string literal, escaping single quotes.
func quote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `\'`) + "'"
}

func randomState() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

const successHTML = `<!doctype html><html><head><meta charset="utf-8"><title>App Finance</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding-top:4rem;background:#0f172a;color:#e2e8f0">
<h2 style="color:#22c55e">✓ Conectado a Google Drive</h2>
<p>Ya puedes cerrar esta pestaña y volver a App Finance.</p></body></html>`
