package main

import (
	"context"
	"embed"
	"log/slog"
	"os"
	goruntime "runtime"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/gastonlarap-a11y/app-finance/backend/diagnostics"
	"github.com/gastonlarap-a11y/app-finance/backend/finance"
	"github.com/gastonlarap-a11y/app-finance/backend/reports"
	"github.com/gastonlarap-a11y/app-finance/backend/settings"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/backup"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/config"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/db"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/drive"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/logger"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/prefs"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/windowstate"
	"github.com/gastonlarap-a11y/app-finance/backend/users"
)

// Placeholder dist is generated so this embed compiles before the first
// `cd frontend && npm run build`. Wails serves the vite dev server in `wails3 dev`.
//
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	cfg := config.MustLoad()
	logger.Setup(cfg.LogLevel)

	appName := cfg.DisplayName
	// The DB folder chosen in the Settings view (prefs) takes precedence.
	if p := prefs.Load(appName); p.DBFolder != "" {
		cfg.DataDir = p.DBFolder
	}

	bdb := db.MustConnect(cfg)
	if err := db.RunMigrations(context.Background(), bdb); err != nil {
		slog.Error("migration failed", "err", err)
		os.Exit(1)
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
	backupRunner := backup.NewRunner(bdb, appName, cfg.DBFilename, cfg.BackupLocalDirResolved(), driveMgr)
	settingsSvc := settings.NewService(appName, bdb, cfg, driveMgr, backupRunner)

	services := []application.Service{
		application.NewService(financeSvc),
		application.NewService(usersSvc),
		application.NewService(settingsSvc),
		application.NewService(diagnostics.NewDiagnosticsService()),
		application.NewService(reports.NewReportsService()),
		// add new services here as you create new domains
	}

	app := application.New(application.Options{
		Name:     cfg.DisplayName,
		LogLevel: slog.LevelInfo,
		Services: services,
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		// Back up when the app closes (snapshot + upload to Drive if connected).
		// Failures (offline, not connected) are logged but never block shutdown.
		OnShutdown: func() {
			if !prefs.Load(appName).BackupOnClose {
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
			defer cancel()
			if info, err := backupRunner.Run(ctx); err != nil {
				slog.Error("respaldo al cerrar falló", "err", err)
			} else {
				slog.Info("respaldo al cerrar", "local", info.LocalPath, "subido", info.Uploaded)
			}
		},
	})

	st := windowstate.Load(context.Background(), bdb)
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
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
		_ = windowstate.Save(context.Background(), bdb, windowstate.State{X: x, Y: y, W: w, H: h})
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
