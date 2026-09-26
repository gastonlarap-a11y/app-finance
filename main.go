package main

import (
	"context"
	"embed"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	goruntime "runtime"
	"sync/atomic"
	"time"

	"github.com/uptrace/bun"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/updater"

	"github.com/gastonlarap-a11y/app-finance/backend/diagnostics"
	"github.com/gastonlarap-a11y/app-finance/backend/finance"
	"github.com/gastonlarap-a11y/app-finance/backend/mailsync"
	"github.com/gastonlarap-a11y/app-finance/backend/reports"
	"github.com/gastonlarap-a11y/app-finance/backend/settings"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/backup"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/config"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/db"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/drive"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/logger"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/prefs"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/windowstate"
	"github.com/gastonlarap-a11y/app-finance/backend/updates"
	"github.com/gastonlarap-a11y/app-finance/backend/users"
)

// Placeholder dist is generated so this embed compiles before the first
// `cd frontend && npm run build`. Wails serves the vite dev server in `wails3 dev`.
//
//go:embed all:frontend/dist
var assets embed.FS

// buildConfig carries info.version, the version the updater compares releases against.
//
//go:embed build/config.yml
var buildConfig []byte

// updateFeed is the GitHub repository whose releases update the app.
const updateFeed = "gastonlarap-a11y/app-finance"

func main() {
	// When relaunched as the updater's helper (to swap in a new version), do only
	// that and exit — before touching config, logs or the database while the
	// app being replaced is still shutting down.
	updater.HandleHelperMode()

	cfg := config.MustLoad()
	logger.Setup(cfg.LogLevel, cfg.LogDir())

	appName := cfg.DisplayName
	// The DB folder chosen in the Settings view (prefs) takes precedence.
	if p := prefs.Load(appName); p.DBFolder != "" {
		cfg.DataDir = p.DBFolder
	}

	// Assigned once the services exist; the shutdown hook may fire earlier
	// (a startup failure quits through the app), so it checks for nil.
	var backupOnClose func(ctx context.Context) error
	var window *application.WebviewWindow
	// Raised when quitting into an update: its backup already ran (see updates.Options).
	restartingToUpdate := new(atomic.Bool)

	// The app is created before the database is touched: SingleInstance is
	// enforced inside application.New, and a second copy must exit before it
	// opens, migrates or backs up the DB the first one is using. Services are
	// registered below with RegisterService, which Wails allows until Run.
	app := application.New(application.Options{
		Name:     cfg.DisplayName,
		LogLevel: slog.LevelInfo,
		// Without a Logger, release builds discard Wails' own log: binding-call
		// errors and recovered panics never reached app.log.
		Logger: slog.Default(),
		PanicHandler: func(p *application.PanicDetails) {
			slog.Error("panic", "err", p.Error, "stack", p.FullStackTrace)
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.gastonlarap.app-finance", // info.productIdentifier in build/config.yml
			OnSecondInstanceLaunch: func(application.SecondInstanceData) {
				if window != nil {
					window.Show()
					window.Focus()
				}
			},
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		// Back up when the app closes (snapshot + upload to Drive if connected).
		// Failures (offline, not connected) are logged but never block shutdown.
		// Quitting into an update skips it: RestartToUpdate already backed up, and
		// the updater's helper gives up if the app takes over 30 s to exit.
		OnShutdown: func() {
			if restartingToUpdate.Load() || backupOnClose == nil {
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
			defer cancel()
			if err := backupOnClose(ctx); err != nil {
				slog.Error("respaldo al cerrar falló", "err", err)
			}
		},
	})

	// Opening a missing file creates an empty DB. When a DB folder was chosen but
	// holds no DB (an unsynced cloud folder, an unplugged drive), that empty DB
	// must not replace the good backups: the backup runner refuses it.
	freshDB := !db.Exists(cfg.DBPath())
	if freshDB {
		slog.Warn("no existe la base de datos: se crea una vacía", "carpetaElegida", prefs.Load(appName).DBFolder != "")
	}

	bdb, err := db.Connect(context.Background(), cfg)
	if err != nil {
		exitWithDialog(app, cfg.LogDir(), "No se pudo abrir la base de datos", err)
	}
	if err := migrateDB(bdb, cfg, freshDB); err != nil {
		exitWithDialog(app, cfg.LogDir(), "No se pudo preparar la base de datos", err)
	}

	// Restore the last selected finance profile (defaults to the seeded "Gastón").
	session := users.NewSession()
	session.SetActive(users.ResolveActiveID(context.Background(), bdb, prefs.Load(appName).ActiveUserID))

	financeSvc := finance.NewFinanceService(bdb, session)
	usersSvc := users.NewService(bdb, session, appName)
	driveMgr := drive.NewManager(appName, func() (string, string) {
		p := prefs.Load(appName)
		return p.OAuthClientID, p.OAuthClientSecret
	})
	backupRunner := backup.NewRunner(bdb, appName, cfg.DBFilename, cfg.BackupLocalDirResolved(), driveMgr, freshDB)
	// After a restore, the active profile may not exist in the restored data.
	afterRestore := func(ctx context.Context) {
		session.SetActive(users.ResolveActiveID(ctx, bdb, prefs.Load(appName).ActiveUserID))
	}
	settingsSvc := settings.NewService(appName, bdb, cfg, driveMgr, backupRunner, afterRestore)
	// Syncs run in the background and report through a frontend event; the app
	// exists by the time the first one finishes (it starts after ServiceStartup).
	mailSvc := mailsync.NewService(bdb, session, mailsync.NewKeychain(appName), mailsync.DefaultParsers(),
		func(name string, data any) { application.Get().Event.Emit(name, data) })

	version, err := updates.VersionFromConfig(buildConfig)
	if err != nil {
		slog.Error("versión desconocida: actualizaciones desactivadas", "err", err)
	}
	backupOnClose = func(ctx context.Context) error {
		if !prefs.Load(appName).BackupOnClose {
			return nil
		}
		info, err := backupRunner.Run(ctx)
		if err != nil {
			return err
		}
		slog.Info("respaldo", "local", info.LocalPath, "subido", info.Uploaded)
		return nil
	}
	updatesSvc := updates.NewService(updates.Options{
		Emit:           func(name string, data any) { application.Get().Event.Emit(name, data) },
		Repository:     updateFeed,
		CurrentVersion: version,
		BeforeRestart:  backupOnClose,
		Restarting:     restartingToUpdate,
	})

	for _, svc := range []application.Service{
		application.NewService(financeSvc),
		application.NewService(usersSvc),
		application.NewService(settingsSvc),
		application.NewService(mailSvc),
		application.NewService(updatesSvc),
		application.NewService(diagnostics.NewDiagnosticsService()),
		application.NewService(reports.NewReportsService()),
		// add new services here as you create new domains
	} {
		app.RegisterService(svc)
	}

	st := windowstate.Load(context.Background(), bdb)
	window = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:           cfg.DisplayName,
		Width:           st.W,
		Height:          st.H,
		X:               st.X,
		Y:               st.Y,
		InitialPosition: application.WindowXY,
	})

	saveWindowState := func() {
		w, h := window.Size()
		x, y := window.Position()
		if err := windowstate.Save(context.Background(), bdb, windowstate.State{X: x, Y: y, W: w, H: h}); err != nil {
			slog.Warn("no se pudo guardar la posición de la ventana", "err", err)
		}
	}

	if goruntime.GOOS == "darwin" {
		// macOS: la X oculta la ventana en vez de destruirla; el handler nativo de
		// Wails (ApplicationShouldHandleReopen) la vuelve a mostrar al hacer clic en
		// el Dock. Cmd+Q sí cierra: Quit() no emite WindowClosing, así que el hook
		// no lo bloquea. El hook corre antes que el listener interno que destruye
		// la ventana, y cancelar el evento también omite los listeners.
		window.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
			saveWindowState()
			window.Hide()
			e.Cancel()
		})
	} else {
		window.OnWindowEvent(events.Common.WindowClosing, func(e *application.WindowEvent) {
			saveWindowState()
		})
	}

	if err := app.Run(); err != nil {
		slog.Error("app exited with error", "err", err)
		os.Exit(1)
	}
}

// migrateDB brings the schema up to date. Before touching an existing DB it
// keeps a snapshot, so a migration that fails (or misbehaves) can be undone by
// hand; a DB newer than this binary is refused before anything is written.
func migrateDB(bdb *bun.DB, cfg *config.Config, freshDB bool) error {
	ctx := context.Background()
	pending, err := db.PendingMigrations(ctx, bdb)
	if err != nil {
		return err
	}
	if pending > 0 && !freshDB {
		path, err := backup.SnapshotBeforeMigrate(ctx, bdb, cfg.BackupLocalDirResolved(), cfg.DBFilename)
		if err != nil {
			return fmt.Errorf("no se pudo respaldar antes de actualizar la base de datos: %w", err)
		}
		slog.Info("respaldo previo a migrar", "path", path, "pendientes", pending)
	}
	return db.RunMigrations(ctx, bdb)
}

// exitWithDialog shows a startup failure in a native dialog, then exits. A
// packaged app has no console: it used to just vanish, leaving the reason in
// a log file nobody knew to open. The dialog runs on the app's own loop (Show
// dispatches to the main thread), so Run is started and quits once it closes.
func exitWithDialog(app *application.App, logDir, title string, err error) {
	slog.Error(title, "err", err)
	go func() {
		app.Dialog.Error().SetTitle(title).
			SetMessage(fmt.Sprintf("%v\n\nEl detalle quedó en %s.", err, filepath.Join(logDir, "app.log"))).Show()
		app.Quit()
	}()
	if runErr := app.Run(); runErr != nil {
		slog.Error("app exited with error", "err", runErr)
	}
	os.Exit(1)
}
