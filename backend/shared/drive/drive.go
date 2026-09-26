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
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	gdrive "google.golang.org/api/drive/v3"
	"google.golang.org/api/googleapi"
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

// saveToken writes the token to a temp file and renames it into place, so a
// crash mid-write never leaves a torn file (which would read as "not
// connected" and silently turn every backup local-only). The token stays a
// 0600 file rather than a keychain item: Windows' credential blob caps at 2560
// bytes, too close to a token's size, and on macOS go-keyring's items are
// readable by any process of the same user anyway.
func (m *Manager) saveToken(t *oauth2.Token) error {
	if err := os.MkdirAll(prefs.Dir(m.appName), 0o700); err != nil {
		return fmt.Errorf("creating the prefs folder: %w", err)
	}
	b, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding the token: %w", err)
	}
	path := prefs.TokenPath(m.appName)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return fmt.Errorf("writing the token: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("saving the token: %w", err)
	}
	return nil
}

// ErrReconnect means Google no longer honors the stored refresh token (revoked
// by the user, expired — Google expires them after 7 days while an OAuth app
// is in "Testing" — or issued to another OAuth client, e.g. before the app's
// client was replaced). The token is dropped, so Ajustes shows Drive as
// disconnected and offers to connect again.
var ErrReconnect = errors.New("hay que volver a conectar Google Drive: hazlo en Ajustes → Respaldo")

// staleRefreshToken reports a refresh the stored token can never pass again:
// invalid_grant (revoked or expired) and unauthorized_client (the token
// belongs to another OAuth client). Anything else — offline, a 5xx — may
// succeed later, so the token is kept.
func staleRefreshToken(err error) bool {
	re, ok := errors.AsType[*oauth2.RetrieveError](err)
	return ok && (re.ErrorCode == "invalid_grant" || re.ErrorCode == "unauthorized_client")
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
	// report hands the first outcome to Connect; later requests (a reload, a
	// stray tab) must not block their handler on a full channel.
	report := func(err error) {
		select {
		case errCh <- err:
		default:
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("state") != state {
			// Not the redirect this login started (another tab, a stale link):
			// refuse it without giving up on the real one still to come.
			http.Error(w, "state inválido", http.StatusBadRequest)
			return
		}
		if e := q.Get("error"); e != "" {
			// Plain text: the value comes from the query string.
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			fmt.Fprintf(w, "Error: %s. Puedes cerrar esta pestaña.", e)
			report(fmt.Errorf("oauth: %s", e))
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, successHTML)
		select {
		case codeCh <- q.Get("code"):
		default: // a code already arrived
		}
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			report(fmt.Errorf("servidor de callback OAuth: %w", err))
		}
	}()
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Warn("drive: cerrar servidor de callback OAuth", "err", err)
		}
	}()

	if err := openBrowser(authURL); err != nil {
		return fmt.Errorf("no se pudo abrir el navegador: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	select {
	case code := <-codeCh:
		tok, err := conf.Exchange(ctx, code, oauth2.VerifierOption(verifier))
		if err != nil {
			return fmt.Errorf("intercambio de token: %w", err)
		}
		return m.saveToken(tok)
	case err := <-errCh:
		return err
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return errors.New("tiempo de espera agotado para el inicio de sesión")
		}
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
	refreshed, err := ts.Token()
	if err != nil {
		if staleRefreshToken(err) {
			if rmErr := os.Remove(prefs.TokenPath(m.appName)); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
				slog.Warn("drive: borrar token revocado", "err", rmErr)
			}
			return nil, ErrReconnect
		}
		return nil, fmt.Errorf("no se pudo renovar el acceso a Google Drive (¿sin conexión?): %w", err)
	}
	if refreshed.AccessToken != tok.AccessToken {
		// Non-fatal: the in-memory token source keeps working; only the next
		// launch would refresh again.
		if err := m.saveToken(refreshed); err != nil {
			slog.Warn("drive: guardar token refrescado", "err", err)
		}
	}
	return gdrive.NewService(ctx, option.WithTokenSource(ts))
}

// isGone reports whether a Drive file or folder can no longer be used: it does
// not exist (404) or it is in the trash (Drive empties it after 30 days, so
// backing up into it would silently lose the backup). Any other failure — a
// network blip, a 5xx, a rate limit — is returned as an error: treating it as
// "missing" used to create a duplicate folder or file on every hiccup.
func isGone(ctx context.Context, svc *gdrive.Service, id string) (bool, error) {
	f, err := svc.Files.Get(id).Fields("id,trashed").Context(ctx).Do()
	if ge, ok := errors.AsType[*googleapi.Error](err); ok && ge.Code == http.StatusNotFound {
		return true, nil
	}
	if err != nil {
		return false, fmt.Errorf("consultando Drive: %w", err)
	}
	return f.Trashed, nil
}

// Upload uploads localFile into folderName (created if needed), overwriting the
// single backup file. Returns the (possibly new) folder and file ids to cache.
func (m *Manager) Upload(ctx context.Context, localFile, folderName, fileName, folderID, fileID string) (string, string, error) {
	svc, err := m.service(ctx)
	if err != nil {
		return "", "", err
	}

	folderID, err = m.ensureFolder(ctx, svc, folderName, folderID)
	if err != nil {
		return "", "", fmt.Errorf("carpeta de respaldos en Drive: %w", err)
	}

	f, err := os.Open(localFile)
	if err != nil {
		return folderID, "", err
	}
	defer f.Close()

	if fileID != "" {
		gone, err := isGone(ctx, svc, fileID)
		if err != nil {
			return folderID, "", err
		}
		if gone {
			fileID = ""
		}
	}
	if fileID == "" {
		q := fmt.Sprintf("name=%s and %s in parents and trashed=false", quote(fileName), quote(folderID))
		list, err := svc.Files.List().Q(q).Fields("files(id)").Context(ctx).Do()
		if err != nil {
			return folderID, "", fmt.Errorf("buscando el respaldo en Drive: %w", err)
		}
		if len(list.Files) > 0 {
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

// ErrNoRemoteBackup means Drive holds no backup this app uploaded.
var ErrNoRemoteBackup = errors.New("no hay un respaldo de la app en Google Drive")

// Download saves the Drive backup to dest: the cached fileID while it is still
// live, else the newest non-trashed file named fileName the app can see (the
// drive.file scope only shows files this app created).
func (m *Manager) Download(ctx context.Context, fileName, fileID, dest string) error {
	svc, err := m.service(ctx)
	if err != nil {
		return err
	}
	if fileID != "" {
		gone, err := isGone(ctx, svc, fileID)
		if err != nil {
			return err
		}
		if gone {
			fileID = ""
		}
	}
	if fileID == "" {
		q := fmt.Sprintf("name=%s and trashed=false and mimeType!='application/vnd.google-apps.folder'", quote(fileName))
		list, err := svc.Files.List().Q(q).OrderBy("modifiedTime desc").PageSize(1).Fields("files(id)").Context(ctx).Do()
		if err != nil {
			return fmt.Errorf("buscando el respaldo en Drive: %w", err)
		}
		if len(list.Files) == 0 {
			return ErrNoRemoteBackup
		}
		fileID = list.Files[0].Id
	}
	resp, err := svc.Files.Get(fileID).Context(ctx).Download()
	if err != nil {
		return fmt.Errorf("descargando el respaldo de Drive: %w", err)
	}
	defer func() { _ = resp.Body.Close() }() // read to the end below; nothing left to report
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("creando el archivo descargado: %w", err)
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		return errors.Join(fmt.Errorf("descargando el respaldo de Drive: %w", err), f.Close())
	}
	return f.Close()
}

// ensureFolder resolves a Drive folder path that may contain "/" separators.
// It walks each segment from the root, finding or creating each level. If
// folderID is still valid it is returned immediately (fast path for repeat
// backups).
func (m *Manager) ensureFolder(ctx context.Context, svc *gdrive.Service, name, folderID string) (string, error) {
	if folderID != "" {
		gone, err := isGone(ctx, svc, folderID)
		if err != nil {
			return "", err
		}
		if !gone {
			return folderID, nil
		}
	}
	parentID := ""
	for seg := range strings.SplitSeq(name, "/") {
		seg = strings.TrimSpace(seg)
		if seg == "" {
			continue
		}
		var err error
		if parentID, err = m.ensureFolderChild(ctx, svc, seg, parentID); err != nil {
			return "", err
		}
	}
	if parentID == "" {
		return "", errors.New("el nombre de la carpeta está vacío")
	}
	return parentID, nil
}

// ensureFolderChild finds or creates a single folder named name as a direct
// child of parentID (or the user's root Drive when parentID is empty). A failed
// lookup is an error, never a reason to create another folder.
func (m *Manager) ensureFolderChild(ctx context.Context, svc *gdrive.Service, name, parentID string) (string, error) {
	var q string
	if parentID == "" {
		// Omit 'root' in parents: with drive.file scope that constraint can return
		// empty results even for folders the app just created. Filtering by name
		// alone is safe because drive.file already limits visibility to app files.
		q = fmt.Sprintf("mimeType='application/vnd.google-apps.folder' and name=%s and trashed=false", quote(name))
	} else {
		q = fmt.Sprintf("mimeType='application/vnd.google-apps.folder' and name=%s and %s in parents and trashed=false", quote(name), quote(parentID))
	}
	list, err := svc.Files.List().Q(q).Fields("files(id)").Context(ctx).Do()
	if err != nil {
		return "", fmt.Errorf("buscando la carpeta %q: %w", name, err)
	}
	if len(list.Files) > 0 {
		return list.Files[0].Id, nil
	}
	f := &gdrive.File{Name: name, MimeType: "application/vnd.google-apps.folder"}
	if parentID != "" {
		f.Parents = []string{parentID}
	}
	created, err := svc.Files.Create(f).Fields("id").Context(ctx).Do()
	if err != nil {
		return "", fmt.Errorf("creando la carpeta %q: %w", name, err)
	}
	return created.Id, nil
}

// quote renders a Drive query string literal: backslash first, then the single
// quote, each escaped with a backslash (Drive's query syntax).
func quote(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	return "'" + strings.ReplaceAll(s, "'", `\'`) + "'"
}

// randomState is the OAuth CSRF state (crypto/rand.Text: 128+ bits of entropy).
func randomState() string { return rand.Text() }

const successHTML = `<!doctype html><html><head><meta charset="utf-8"><title>App Finance</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding-top:4rem;background:#0f172a;color:#e2e8f0">
<h2 style="color:#22c55e">✓ Conectado a Google Drive</h2>
<p>Ya puedes cerrar esta pestaña y volver a App Finance.</p></body></html>`
