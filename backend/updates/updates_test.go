package updates

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
)

// fakeEngine records calls and returns canned results.
type fakeEngine struct {
	mu          sync.Mutex
	rel         *updater.Release
	checkErr    error
	downloadErr error
	restartErr  error
	downloaded  chan struct{} // closed when DownloadAndInstall returns
	gate        chan struct{} // when set, DownloadAndInstall waits for it
	restarts    int
}

func (f *fakeEngine) Check(context.Context) (*updater.Release, error) { return f.rel, f.checkErr }

func (f *fakeEngine) DownloadAndInstall(context.Context) error {
	defer close(f.downloaded)
	if f.gate != nil {
		<-f.gate
	}
	return f.downloadErr
}

func (f *fakeEngine) Restart(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.restarts++
	return f.restartErr
}

// testKey stands in for the release signing key (the real one never leaves
// the release workflow); the harness trusts its public half.
var testKey = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))

// verified is a release as the signed provider hands it over: digest from
// SHA256SUMS.txt plus a valid signature over it.
func verified(version string) *updater.Release {
	digest := bytes.Repeat([]byte{0xab}, 32)
	return &updater.Release{
		Version:  version,
		Notes:    "notas",
		Artifact: updater.Artifact{Filename: "app-finance-darwin-universal.zip", Size: 42},
		Verification: &updater.Verification{
			DigestAlgo: "sha256", Digest: digest,
			SignatureAlgo: sigAlgo, Signature: ed25519.Sign(testKey, digest),
		},
	}
}

type harness struct {
	svc        *Service
	eng        *fakeEngine
	backups    atomic.Int32
	backupErr  error
	restarting *atomic.Bool

	emitMu     sync.Mutex
	emitPhases []string // phase observed when each EventStateChanged fired
}

func (h *harness) lastEmittedPhase() string {
	h.emitMu.Lock()
	defer h.emitMu.Unlock()
	if len(h.emitPhases) == 0 {
		return ""
	}
	return h.emitPhases[len(h.emitPhases)-1]
}

// newHarness builds the service around a fake engine, "installed" in a
// writable temp folder.
func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{eng: &fakeEngine{downloaded: make(chan struct{})}, restarting: new(atomic.Bool)}
	h.svc = NewService(Options{
		// Reading the state inside the callback also proves it fires with the
		// lock released (it would deadlock otherwise) and after the state moved.
		Emit: func(name string, _ any) {
			if name != EventStateChanged {
				t.Errorf("emitted %q", name)
			}
			phase := h.svc.state().Phase
			h.emitMu.Lock()
			h.emitPhases = append(h.emitPhases, phase)
			h.emitMu.Unlock()
		},
		Repository:     "owner/repo",
		CurrentVersion: "0.3.0",
		BeforeRestart: func(context.Context) error {
			h.backups.Add(1)
			return h.backupErr
		},
		Restarting: h.restarting,
	})
	h.svc.engine = h.eng
	h.svc.pub = testKey.Public().(ed25519.PublicKey)
	h.svc.goos = "darwin"
	app := filepath.Join(t.TempDir(), "app-finance.app", "Contents", "MacOS")
	if err := os.MkdirAll(app, 0o755); err != nil {
		t.Fatal(err)
	}
	h.svc.exe = func() (string, error) { return filepath.Join(app, "app-finance"), nil }
	return h
}

func (h *harness) downloadReady(t *testing.T) {
	t.Helper()
	h.eng.rel = verified("0.4.0")
	if r := h.svc.CheckForUpdate(t.Context()); r.Error != nil || r.Data.Available == nil {
		t.Fatalf("CheckForUpdate = %+v", r)
	}
	if r := h.svc.InstallUpdate(t.Context()); r.Error != nil {
		t.Fatalf("InstallUpdate: %v", r.Error)
	}
	<-h.eng.downloaded
	waitPhase(t, h.svc, PhaseReady)
	deadline := time.Now().Add(2 * time.Second)
	for h.lastEmittedPhase() != PhaseReady && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := h.lastEmittedPhase(); got != PhaseReady {
		t.Fatalf("last state-changed event saw phase %q, want ready (UI would re-read a stale state)", got)
	}
}

func waitPhase(t *testing.T, s *Service, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.state().Phase == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("phase = %s, want %s", s.state().Phase, want)
}

func TestVersionFromConfig(t *testing.T) {
	tests := []struct {
		name, config, want string
		ok                 bool
	}{
		{"info.version", "version: '3'\ninfo:\n  companyName: \"x\"\n  version: \"0.3.0\" # comment\n", "0.3.0", true},
		{"prerelease", "info:\n  version: \"1.0.0-rc.1\"\n", "1.0.0-rc.1", true},
		{"only taskfile version", "version: '3'\n", "", false},
		{"commented ios version", "info:\n#   version: \"0.0.1\"\n", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := VersionFromConfig([]byte(tt.config))
			if (err == nil) != tt.ok || got != tt.want {
				t.Fatalf("VersionFromConfig = %q, %v; want %q (ok=%v)", got, err, tt.want, tt.ok)
			}
		})
	}
}

func TestVersionFromRealConfig(t *testing.T) {
	cfg, err := os.ReadFile("../../build/config.yml")
	if err != nil {
		t.Fatal(err)
	}
	if v, err := VersionFromConfig(cfg); err != nil || v == "" || v[0] < '0' || v[0] > '9' {
		t.Fatalf("build/config.yml version = %q, %v", v, err)
	}
}

func TestInstallTargetAndBlocker(t *testing.T) {
	if got := installTarget("darwin", "/Applications/app-finance.app/Contents/MacOS/app-finance"); got != "/Applications/app-finance.app" {
		t.Fatalf("darwin target = %q", got)
	}
	if got := installTarget("windows", `C:\Users\g\AppData\Local\Programs\App Finance\app-finance.exe`); !strings.HasSuffix(got, "app-finance.exe") {
		t.Fatalf("windows target = %q", got)
	}

	writable := filepath.Join(t.TempDir(), "app-finance.app", "Contents", "MacOS", "app-finance")
	readonly := t.TempDir()
	if err := os.Chmod(readonly, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(readonly, 0o700) }) // let t.TempDir clean up

	tests := []struct {
		name, exe, want string
	}{
		{"writable folder", writable, ""},
		{"translocated", "/private/var/folders/x/AppTranslocation/ABC/d/app-finance.app/Contents/MacOS/app-finance", "Aplicaciones"},
		{"dev build", "/repo/bin/app-finance.dev.app/Contents/MacOS/app-finance", "desarrollo"},
		{"read-only folder", filepath.Join(readonly, "app-finance.app", "Contents", "MacOS", "app-finance"), "No se puede escribir"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := installBlocker("darwin", tt.exe)
			if (tt.want == "" && got != "") || (tt.want != "" && !strings.Contains(got, tt.want)) {
				t.Fatalf("installBlocker = %q, want containing %q", got, tt.want)
			}
		})
	}
}

func TestCheckKeepsOnlyVerifiableReleases(t *testing.T) {
	h := newHarness(t)

	otherKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{9}, ed25519.SeedSize))
	refused := []struct {
		name  string
		edit  func(v *updater.Verification) *updater.Verification
		error string
	}{
		{name: "no SHA256SUMS entry", edit: func(*updater.Verification) *updater.Verification { return nil }, error: "checksum"},
		{name: "unsigned", edit: func(v *updater.Verification) *updater.Verification {
			v.Signature, v.SignatureAlgo = nil, ""
			return v
		}, error: "no está firmada"},
		{name: "signed by another key", edit: func(v *updater.Verification) *updater.Verification {
			v.Signature = ed25519.Sign(otherKey, v.Digest)
			return v
		}, error: "firma"},
		{name: "signature over another digest", edit: func(v *updater.Verification) *updater.Verification {
			v.Digest = bytes.Repeat([]byte{0xcd}, 32)
			return v
		}, error: "firma"},
		{name: "unexpected algorithm", edit: func(v *updater.Verification) *updater.Verification {
			v.SignatureAlgo = "ecdsa-p256"
			return v
		}, error: "firma"},
	}
	for _, tt := range refused {
		t.Run(tt.name, func(t *testing.T) {
			rel := verified("0.4.0")
			rel.Verification = tt.edit(rel.Verification)
			h.eng.rel = rel
			st := h.svc.CheckForUpdate(t.Context()).Data
			if st.Available != nil || !strings.Contains(st.LastError, tt.error) || st.LastChecked == nil {
				t.Fatalf("state = %+v, want refused with an error mentioning %q", st, tt.error)
			}
			if r := h.svc.InstallUpdate(t.Context()); r.Error == nil || r.Error.Code != "NOT_FOUND" {
				t.Fatalf("InstallUpdate of a refused release = %+v, want NOT_FOUND", r.Error)
			}
		})
	}

	h.eng.rel = verified("0.4.0")
	st := h.svc.CheckForUpdate(t.Context()).Data
	if st.Available == nil || st.Available.Version != "0.4.0" || st.Available.Size != 42 || st.LastError != "" {
		t.Fatalf("verifiable release state = %+v", st)
	}
	if got := h.lastEmittedPhase(); got != PhaseIdle {
		t.Fatalf("state-changed after a check saw phase %q, want idle", got)
	}

	// Going offline does not forget the release already found.
	h.eng.rel, h.eng.checkErr = nil, errors.New("offline")
	st = h.svc.CheckForUpdate(t.Context()).Data
	if st.Available == nil || st.Available.Version != "0.4.0" || !strings.Contains(st.LastError, "offline") || st.Phase != PhaseIdle {
		t.Fatalf("failed check state = %+v, want the known release kept and the error shown", st)
	}

	// A successful check that finds nothing newer clears it.
	h.eng.checkErr = nil
	if st = h.svc.CheckForUpdate(t.Context()).Data; st.Available != nil || st.LastError != "" {
		t.Fatalf("up-to-date state = %+v", st)
	}
}

func TestInstallAndRestartBacksUpFirst(t *testing.T) {
	h := newHarness(t)
	h.downloadReady(t)

	if st := h.svc.CheckForUpdate(t.Context()).Data; st.Available == nil || st.Phase != PhaseReady {
		t.Fatalf("a check while ready dropped the staged update: %+v", st)
	}
	if r := h.svc.RestartToUpdate(t.Context(), false); r.Error != nil {
		t.Fatalf("RestartToUpdate: %v", r.Error)
	}
	if h.backups.Load() != 1 || h.eng.restarts != 1 || !h.restarting.Load() {
		t.Fatalf("backups=%d restarts=%d restarting=%v, want 1/1/true", h.backups.Load(), h.eng.restarts, h.restarting.Load())
	}
}

func TestRestartStopsWhenBackupFails(t *testing.T) {
	h := newHarness(t)
	h.downloadReady(t)
	h.backupErr = errors.New("Drive no responde")

	r := h.svc.RestartToUpdate(t.Context(), false)
	if r.Error == nil || !strings.Contains(r.Error.Message, "Drive no responde") {
		t.Fatalf("RestartToUpdate with failing backup = %+v", r.Error)
	}
	if h.eng.restarts != 0 || h.restarting.Load() || h.svc.state().Phase != PhaseReady {
		t.Fatalf("a failed backup must not restart: restarts=%d restarting=%v phase=%s", h.eng.restarts, h.restarting.Load(), h.svc.state().Phase)
	}

	// The user chose to update without the backup.
	if r := h.svc.RestartToUpdate(t.Context(), true); r.Error != nil {
		t.Fatalf("RestartToUpdate(skipBackup): %v", r.Error)
	}
	if h.backups.Load() != 1 || h.eng.restarts != 1 {
		t.Fatalf("backups=%d restarts=%d, want 1/1", h.backups.Load(), h.eng.restarts)
	}
}

func TestRestartFailureKeepsTheUpdateReady(t *testing.T) {
	h := newHarness(t)
	h.downloadReady(t)
	h.eng.restartErr = errors.New("helper did not start")
	if r := h.svc.RestartToUpdate(t.Context(), true); r.Error == nil {
		t.Fatal("RestartToUpdate with a failing helper = ok")
	}
	if h.restarting.Load() || h.svc.state().Phase != PhaseReady {
		t.Fatal("after a failed restart the backup-on-close must be back on and the update still ready")
	}
}

func TestInstallGuards(t *testing.T) {
	h := newHarness(t)
	if r := h.svc.RestartToUpdate(t.Context(), true); r.Error == nil || r.Error.Code != "CONFLICT" {
		t.Fatalf("RestartToUpdate before download = %+v, want CONFLICT", r.Error)
	}

	h.eng.rel = verified("0.4.0")
	h.svc.CheckForUpdate(t.Context())
	h.svc.exe = func() (string, error) {
		return "/private/var/folders/x/AppTranslocation/y/app-finance.app/Contents/MacOS/app-finance", nil
	}
	if r := h.svc.InstallUpdate(t.Context()); r.Error == nil || !strings.Contains(r.Error.Message, "Aplicaciones") {
		t.Fatalf("InstallUpdate from a translocated app = %+v", r.Error)
	}

	h.eng.downloadErr = errors.New("checksum mismatch")
	h.eng.gate = make(chan struct{})
	h.svc.exe = func() (string, error) { return filepath.Join(t.TempDir(), "app-finance"), nil }
	h.svc.goos = "windows"
	if r := h.svc.InstallUpdate(t.Context()); r.Error != nil {
		t.Fatalf("InstallUpdate: %v", r.Error)
	}
	// The download is held by the gate: a second start must be refused.
	if r := h.svc.InstallUpdate(t.Context()); r.Error == nil || r.Error.Code != "CONFLICT" {
		t.Fatalf("second InstallUpdate while downloading = %+v, want CONFLICT", r.Error)
	}
	close(h.eng.gate)
	<-h.eng.downloaded
	waitPhase(t, h.svc, PhaseIdle)
	if st := h.svc.state(); !strings.Contains(st.LastError, "checksum mismatch") || st.Available == nil {
		t.Fatalf("after a failed download = %+v, want the error and the release still offered", st)
	}
}

func TestDisabledWithoutSigningKey(t *testing.T) {
	s := NewService(Options{CurrentVersion: "0.3.0", Repository: "owner/repo"})
	s.pub = nil // what an unreadable embedded key leaves
	if err := s.ServiceStartup(t.Context(), application.ServiceOptions{}); err != nil {
		t.Fatalf("ServiceStartup: %v", err)
	}
	if s.engine != nil {
		t.Fatal("updates were enabled without a key to verify them")
	}
	if r := s.CheckForUpdate(t.Context()); r.Error == nil {
		t.Fatal("CheckForUpdate without a signing key = ok")
	}
}

func TestDisabledWithoutEngine(t *testing.T) {
	s := NewService(Options{CurrentVersion: ""})
	if r := s.CheckForUpdate(t.Context()); r.Error == nil {
		t.Fatal("CheckForUpdate without an engine = ok")
	}
	if st := s.GetUpdateState(t.Context()).Data; st.Phase != PhaseIdle {
		t.Fatalf("state = %+v", st)
	}
}
