// Package updates keeps the desktop app current from its GitHub Releases:
// it checks on startup and every checkEvery, and when the user accepts it
// downloads the release for this platform, verifies it against the release's
// SHA256SUMS.txt, and restarts into it (Wails v3 pkg/updater swaps the .app
// bundle / .exe through a helper process and relaunches it).
//
// Two guarantees on top of Wails' updater:
//   - a release without a checksum for its artifact is never installed (the
//     updater itself would install it unverified);
//   - the close-time backup runs before quitting, not in OnShutdown: the
//     helper aborts the swap if the app takes more than 30 s to exit.
package updates

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

const (
	// checksumAsset is the sha256sum listing the release workflow publishes.
	checksumAsset   = "SHA256SUMS.txt"
	checkEvery      = 6 * time.Hour
	firstCheck      = 20 * time.Second // let the window open first
	checkTimeout    = 30 * time.Second
	downloadTimeout = 15 * time.Minute
	backupTimeout   = 2 * time.Minute
)

// engine is the part of Wails' *updater.Updater this service drives.
type engine interface {
	Check(ctx context.Context) (*updater.Release, error)
	DownloadAndInstall(ctx context.Context) error
	Restart(ctx context.Context) error
}

// EventStateChanged tells the frontend to re-read GetUpdateState. Wails' own
// updater events fire inside Check/DownloadAndInstall, before this service has
// recorded their outcome, so the UI must not re-read on those.
const EventStateChanged = "updates:changed"

// Options wires the service to the app.
type Options struct {
	// Emit forwards EventStateChanged to the frontend (main.go passes the Wails
	// event manager; nil disables it).
	Emit           func(name string, data any)
	Repository     string // "owner/repo" whose releases are the update feed
	CurrentVersion string // "" disables updates (version unknown)
	// BeforeRestart runs right before quitting into the new version — the
	// backup OnShutdown would otherwise run past the helper's 30 s wait.
	BeforeRestart func(ctx context.Context) error
	// Restarting is raised just before quitting to update; OnShutdown reads it
	// to skip the backup BeforeRestart already made.
	Restarting *atomic.Bool
}

type Service struct {
	opts   Options
	engine engine
	exe    func() (string, error)
	goos   string

	mu          sync.Mutex
	phase       string
	pending     *updater.Release
	lastChecked *time.Time
	lastError   string

	bgCtx    context.Context // outlives bound calls; cancelled on shutdown
	stopLoop context.CancelFunc
	loopDone chan struct{}
}

func NewService(opts Options) *Service {
	if opts.Restarting == nil {
		opts.Restarting = new(atomic.Bool)
	}
	return &Service{opts: opts, exe: os.Executable, goos: runtime.GOOS, phase: PhaseIdle, bgCtx: context.Background()}
}

func (s *Service) ServiceName() string { return "UpdatesService" }

// ServiceStartup configures Wails' updater with the GitHub provider and starts
// the periodic check. The app exists by now (services start inside app.Run).
func (s *Service) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	if s.opts.CurrentVersion == "" {
		slog.Warn("updates: version unknown, update checks disabled")
		return nil
	}
	if s.engine == nil {
		u, err := newEngine(s.opts, s.goos)
		if err != nil {
			slog.Error("updates: disabled", "err", err)
			return nil // the app works without updates
		}
		s.engine = u
	}
	var loopCtx context.Context
	loopCtx, s.stopLoop = context.WithCancel(ctx)
	s.bgCtx = loopCtx
	s.loopDone = make(chan struct{})
	go func() {
		defer close(s.loopDone)
		s.checkLoop(loopCtx)
	}()
	return nil
}

func (s *Service) ServiceShutdown() error {
	if s.stopLoop != nil {
		s.stopLoop()
		<-s.loopDone
	}
	return nil
}

// newEngine initializes app.Updater. The macOS release ships one universal
// .app, published as app-finance-darwin-universal.zip, so on macOS the asset
// is picked by "universal" instead of the running CPU architecture.
func newEngine(opts Options, goos string) (engine, error) {
	gh, err := github.New(github.Config{Repository: opts.Repository, ChecksumAsset: checksumAsset})
	if err != nil {
		return nil, fmt.Errorf("github provider: %w", err)
	}
	cfg := updater.Config{CurrentVersion: opts.CurrentVersion, Providers: []updater.Provider{gh}}
	if goos == "darwin" {
		cfg.Arch = "universal"
	}
	u := application.Get().Updater
	if err := u.Init(cfg); err != nil {
		return nil, fmt.Errorf("init updater: %w", err)
	}
	return u, nil
}

func (s *Service) checkLoop(ctx context.Context) {
	timer := time.NewTimer(firstCheck)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			// Failures (offline, rate limit) are recorded in the state and retried next tick.
			_ = s.check(ctx)
			timer.Reset(checkEvery)
		}
	}
}

// busy reports a phase in which a new check must not replace the pending release.
func busy(phase string) bool {
	return phase == PhaseChecking || phase == PhaseDownloading || phase == PhaseReady || phase == PhaseRestarting
}

// changed notifies the frontend that the state moved (call without s.mu held).
func (s *Service) changed() {
	if s.opts.Emit != nil {
		s.opts.Emit(EventStateChanged, nil)
	}
}

// check asks the feed for a newer release and keeps it pending only when it
// carries a checksum to verify the download against.
func (s *Service) check(ctx context.Context) error {
	s.mu.Lock()
	if busy(s.phase) {
		s.mu.Unlock()
		return nil
	}
	s.phase = PhaseChecking
	s.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	rel, err := s.engine.Check(ctx)
	defer s.changed() // runs after the unlock below

	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	s.lastChecked = &now
	s.phase = PhaseIdle
	if err != nil {
		s.lastError = "No se pudo buscar actualizaciones: " + err.Error()
		return err
	}
	s.lastError = ""
	s.pending = nil
	if rel == nil {
		return nil
	}
	if rel.Verification == nil || len(rel.Verification.Digest) == 0 {
		s.lastError = fmt.Sprintf("La versión %s no publica el checksum de su descarga (%s): por seguridad no se instalará.", rel.Version, checksumAsset)
		return nil
	}
	s.pending = rel
	return nil
}

func (s *Service) disabled() *shared.AppError {
	if s.engine == nil {
		return shared.NewError(shared.ErrValidation, "las actualizaciones no están disponibles en esta compilación")
	}
	return nil
}

func (s *Service) state() *UpdateState {
	st := &UpdateState{CurrentVersion: s.opts.CurrentVersion}
	if exe, err := s.exe(); err == nil {
		st.Blocked = installBlocker(s.goos, exe)
	} else {
		st.Blocked = "No se pudo determinar dónde está instalada la app: " + err.Error()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st.Phase, st.LastChecked, st.LastError = s.phase, s.lastChecked, s.lastError
	if s.pending != nil {
		st.Available = &ReleaseInfo{
			Version: s.pending.Version, Notes: s.pending.Notes,
			PublishedAt: s.pending.PublishedAt, Size: s.pending.Artifact.Size,
		}
	}
	return st
}

// GetUpdateState returns the current version and whatever update is pending.
func (s *Service) GetUpdateState(_ context.Context) UpdateStateResult {
	return UpdateStateResult{Data: s.state()}
}

// CheckForUpdate checks now (the "Buscar actualizaciones" button).
func (s *Service) CheckForUpdate(ctx context.Context) UpdateStateResult {
	if aerr := s.disabled(); aerr != nil {
		return UpdateStateResult{Error: aerr}
	}
	// A failed check is reported through the state's LastError, not as a Result error.
	_ = s.check(ctx)
	return UpdateStateResult{Data: s.state()}
}

// InstallUpdate starts downloading and verifying the pending release in the
// background and returns at once; progress and the outcome arrive as Wails
// updater events (wails:updater:download-progress, :update-ready, :error).
func (s *Service) InstallUpdate(_ context.Context) OpResult {
	if aerr := s.disabled(); aerr != nil {
		return OpResult{Error: aerr}
	}
	if exe, err := s.exe(); err == nil {
		if reason := installBlocker(s.goos, exe); reason != "" {
			return OpResult{Error: shared.NewError(shared.ErrConflict, reason)}
		}
	}
	s.mu.Lock()
	if s.pending == nil {
		s.mu.Unlock()
		return OpResult{Error: shared.NewError(shared.ErrNotFound, "no hay una actualización disponible")}
	}
	if s.phase != PhaseIdle {
		s.mu.Unlock()
		return OpResult{Error: shared.NewError(shared.ErrConflict, "ya hay una actualización en curso")}
	}
	s.phase = PhaseDownloading
	s.lastError = ""
	s.mu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(s.bgCtx, downloadTimeout)
		defer cancel()
		err := s.engine.DownloadAndInstall(ctx)
		defer s.changed() // runs after the unlock below
		s.mu.Lock()
		defer s.mu.Unlock()
		if err != nil {
			s.phase = PhaseIdle
			s.lastError = "La descarga de la actualización falló: " + err.Error()
			slog.Error("updates: download failed", "err", err)
			return
		}
		s.phase = PhaseReady
	}()
	return OpResult{}
}

// RestartToUpdate backs up (unless skipBackup) and quits into the verified
// update. A failed backup stops the restart so the user can decide.
func (s *Service) RestartToUpdate(ctx context.Context, skipBackup bool) OpResult {
	if aerr := s.disabled(); aerr != nil {
		return OpResult{Error: aerr}
	}
	s.mu.Lock()
	if s.phase != PhaseReady {
		s.mu.Unlock()
		return OpResult{Error: shared.NewError(shared.ErrConflict, "la actualización todavía no está lista")}
	}
	s.phase = PhaseRestarting
	s.mu.Unlock()

	fail := func(aerr *shared.AppError) OpResult {
		s.opts.Restarting.Store(false)
		s.mu.Lock()
		s.phase = PhaseReady
		s.mu.Unlock()
		return OpResult{Error: aerr}
	}

	if !skipBackup && s.opts.BeforeRestart != nil {
		bctx, cancel := context.WithTimeout(ctx, backupTimeout)
		err := s.opts.BeforeRestart(bctx)
		cancel()
		if err != nil {
			return fail(shared.NewError(shared.ErrConflict, "El respaldo previo a la actualización falló: "+err.Error()))
		}
	}
	s.opts.Restarting.Store(true) // OnShutdown must not back up again
	if err := s.engine.Restart(ctx); err != nil {
		if errors.Is(err, updater.ErrNotReady) {
			return fail(shared.NewError(shared.ErrConflict, "la actualización ya no está preparada: vuelve a descargarla"))
		}
		return fail(shared.NewError(shared.ErrInternal, "no se pudo reiniciar para actualizar: "+err.Error()))
	}
	return OpResult{}
}
