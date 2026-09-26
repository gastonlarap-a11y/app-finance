package drive

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/oauth2"
	gdrive "google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
)

// fakeDrive serves the Drive endpoints the backup uses. get answers files.get
// (status, body); list answers files.list; creates counts files.create calls.
type fakeDrive struct {
	get     func() (int, string)
	list    func() (int, string)
	creates atomic.Int32
}

// RoundTrip answers in memory: no port to bind, no network.
func (f *fakeDrive) RoundTrip(r *http.Request) (*http.Response, error) {
	w := httptest.NewRecorder()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.Method == http.MethodPost:
		f.creates.Add(1)
		_, _ = w.Write([]byte(`{"id":"new"}`))
	case strings.HasSuffix(r.URL.Path, "/files"):
		code, body := f.list()
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	default:
		code, body := f.get()
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}
	return w.Result(), nil
}

func (f *fakeDrive) serve(t *testing.T) *gdrive.Service {
	t.Helper()
	svc, err := gdrive.NewService(context.Background(), option.WithEndpoint("https://drive.test/"),
		option.WithHTTPClient(&http.Client{Transport: f}), option.WithoutAuthentication())
	if err != nil {
		t.Fatalf("drive service: %v", err)
	}
	return svc
}

const notFound = `{"error":{"code":404,"message":"File not found"}}`

func TestIsGone(t *testing.T) {
	for _, tc := range []struct {
		name     string
		code     int
		body     string
		wantGone bool
		wantErr  bool
	}{
		{"live file", 200, `{"id":"f","trashed":false}`, false, false},
		{"file in the trash", 200, `{"id":"f","trashed":true}`, true, false},
		{"deleted file", 404, notFound, true, false},
		{"server hiccup is not 'missing'", 503, `{"error":{"code":503,"message":"backend"}}`, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeDrive{get: func() (int, string) { return tc.code, tc.body }}
			gone, err := isGone(t.Context(), f.serve(t), "f")
			if gone != tc.wantGone || (err != nil) != tc.wantErr {
				t.Fatalf("isGone = %v, %v; want %v, error %v", gone, err, tc.wantGone, tc.wantErr)
			}
		})
	}
}

// A failed folder lookup used to count as "not found" and create another
// backup folder on every network hiccup.
func TestEnsureFolderNeverCreatesOnAFailedLookup(t *testing.T) {
	f := &fakeDrive{
		get:  func() (int, string) { return 404, notFound },
		list: func() (int, string) { return 500, `{"error":{"code":500,"message":"boom"}}` },
	}
	svc := f.serve(t)
	if _, err := (&Manager{}).ensureFolder(t.Context(), svc, "App Finance Backups", "stale-id"); err == nil {
		t.Fatal("ensureFolder with a failing lookup succeeded")
	}
	if n := f.creates.Load(); n != 0 {
		t.Fatalf("created %d folders after a failed lookup, want 0", n)
	}

	f.list = func() (int, string) { return 200, `{"files":[]}` }
	id, err := (&Manager{}).ensureFolder(t.Context(), svc, "App Finance Backups", "")
	if err != nil || id != "new" || f.creates.Load() != 1 {
		t.Fatalf("ensureFolder with no folder yet = %q, %v (creates %d); want it created once", id, err, f.creates.Load())
	}
}

func TestQuoteEscapesBackslashAndQuote(t *testing.T) {
	for in, want := range map[string]string{
		"Respaldos":    `'Respaldos'`,
		"Gastón's":     `'Gastón\'s'`,
		`a\b`:          `'a\\b'`,
		`fin\' or 1=1`: `'fin\\\' or 1=1'`,
	} {
		if got := quote(in); got != want {
			t.Errorf("quote(%q) = %s, want %s", in, got, want)
		}
	}
}

// tokenEndpoint answers Google's token refresh in memory.
type tokenEndpoint struct {
	status int
	body   string
}

func (e tokenEndpoint) RoundTrip(*http.Request) (*http.Response, error) {
	w := httptest.NewRecorder()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.status)
	_, _ = w.Write([]byte(e.body))
	return w.Result(), nil
}

func TestRefreshFailureDropsOnlyStaleTokens(t *testing.T) {
	tests := []struct {
		name      string
		endpoint  tokenEndpoint
		reconnect bool // ErrReconnect, and the token file is gone
	}{
		{name: "revoked or expired", endpoint: tokenEndpoint{http.StatusBadRequest, `{"error":"invalid_grant"}`}, reconnect: true},
		{name: "issued to another OAuth client", endpoint: tokenEndpoint{http.StatusUnauthorized, `{"error":"unauthorized_client","error_description":"Unauthorized"}`}, reconnect: true},
		{name: "Google hiccup", endpoint: tokenEndpoint{http.StatusServiceUnavailable, `{"error":"backend_error"}`}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			t.Setenv("APPDATA", t.TempDir())
			m := NewManager("drive-test", func() (string, string) { return "client-id", "client-secret" })
			expired := &oauth2.Token{AccessToken: "old", RefreshToken: "refresh", Expiry: time.Now().Add(-time.Hour)}
			if err := m.saveToken(expired); err != nil {
				t.Fatal(err)
			}
			ctx := context.WithValue(t.Context(), oauth2.HTTPClient, &http.Client{Transport: tt.endpoint})

			_, err := m.service(ctx)
			if err == nil {
				t.Fatal("service() with a failing refresh = ok")
			}
			if got := errors.Is(err, ErrReconnect); got != tt.reconnect {
				t.Fatalf("errors.Is(%v, ErrReconnect) = %v, want %v", err, got, tt.reconnect)
			}
			if connected := m.IsConnected(); connected == tt.reconnect {
				t.Fatalf("IsConnected() = %v after %q, want %v", connected, tt.name, !tt.reconnect)
			}
		})
	}
}
