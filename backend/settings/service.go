// Package settings is the Wails service that drives ALL configuration from the UI:
// the local DB folder (native folder picker), the Google Drive connection (visual
// OAuth login), the Drive backup folder, and manual/automatic backups. No commands,
// no external installs.
package settings

import (
	"context"
	"path/filepath"
	"strings"

	"github.com/uptrace/bun"
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/backup"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/config"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/drive"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/prefs"
)

type Service struct {
	appName string
	db      *bun.DB
	cfg     *config.Config
	drive   *drive.Manager
	runner  *backup.Runner
}

func NewService(appName string, db *bun.DB, cfg *config.Config, dm *drive.Manager, runner *backup.Runner) *Service {
	return &Service{appName: appName, db: db, cfg: cfg, drive: dm, runner: runner}
}

func (s *Service) ServiceName() string { return "SettingsService" }

func (s *Service) GetState(ctx context.Context) StateResult {
	p := prefs.Load(s.appName)
	dbFolder := p.DBFolder
	if dbFolder == "" {
		dbFolder = s.cfg.DataDirEffective()
	}
	return StateResult{Data: &State{
		DBFolder:           dbFolder,
		BackupLocalDir:     s.cfg.BackupLocalDirResolved(),
		DriveConnected:     s.drive.IsConnected(),
		DriveEmail:         p.DriveEmail,
		DriveFolderName:    p.DriveFolderName,
		BackupOnClose:      p.BackupOnClose,
		ClientIDConfigured: s.drive.HasClientID(),
		LastBackup:         s.runner.LastBackup(),
	}}
}

// ChooseDBFolder opens a native folder picker and returns the chosen path (not applied).
func (s *Service) ChooseDBFolder(ctx context.Context) ChooseFolderResult {
	path, err := application.Get().Dialog.OpenFile().
		CanChooseDirectories(true).
		CanChooseFiles(false).
		CanCreateDirectories(true).
		SetTitle("Elige la carpeta para la base de datos").
		PromptForSingleSelection()
	if err != nil {
		return ChooseFolderResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if strings.TrimSpace(path) == "" {
		return ChooseFolderResult{Canceled: true}
	}
	return ChooseFolderResult{Path: path}
}

// ApplyDBFolder copies the current DB into the chosen folder and persists it as the
// new DB location (applied on next launch — the live DB is not hot-swapped).
func (s *Service) ApplyDBFolder(ctx context.Context, path string) ApplyFolderResult {
	path = strings.TrimSpace(path)
	if path == "" {
		return ApplyFolderResult{Error: shared.NewError(shared.ErrValidation, "ruta vacía")}
	}
	dest := filepath.Join(path, s.cfg.DBFilename)
	sameAsCurrent := filepath.Clean(dest) == filepath.Clean(s.cfg.DBPath())

	if !sameAsCurrent {
		if err := backup.Snapshot(ctx, s.db, dest); err != nil {
			return ApplyFolderResult{Error: shared.NewError(shared.ErrInternal, "no se pudo copiar la BD: "+err.Error())}
		}
	}
	p := prefs.Load(s.appName)
	p.DBFolder = path
	if err := prefs.Save(s.appName, p); err != nil {
		return ApplyFolderResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return ApplyFolderResult{Path: path, NeedsRestart: !sameAsCurrent}
}

// ConnectDrive runs the visual OAuth login (opens the browser) and caches the
// connected account email for display.
func (s *Service) ConnectDrive(ctx context.Context) OpResult {
	err := s.drive.Connect(ctx, func(u string) error { return application.Get().Browser.OpenURL(u) })
	if err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	p := prefs.Load(s.appName)
	p.DriveEmail = s.drive.AccountEmail(ctx)
	_ = prefs.Save(s.appName, p)
	return OpResult{}
}

func (s *Service) DisconnectDrive(ctx context.Context) OpResult {
	if err := s.drive.Disconnect(); err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	p := prefs.Load(s.appName)
	p.DriveFolderID = ""
	p.DriveFileID = ""
	p.DriveEmail = ""
	_ = prefs.Save(s.appName, p)
	return OpResult{}
}

func (s *Service) SetDriveFolderName(ctx context.Context, name string) OpResult {
	name = strings.TrimSpace(name)
	if name == "" {
		name = prefs.DefaultDriveFolder
	}
	p := prefs.Load(s.appName)
	if p.DriveFolderName != name {
		p.DriveFolderName = name
		// reset cached ids so the next backup creates/finds the new folder
		p.DriveFolderID = ""
		p.DriveFileID = ""
	}
	if err := prefs.Save(s.appName, p); err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return OpResult{}
}

func (s *Service) SetBackupOnClose(ctx context.Context, enabled bool) OpResult {
	p := prefs.Load(s.appName)
	p.BackupOnClose = enabled
	if err := prefs.Save(s.appName, p); err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return OpResult{}
}

// SetOAuthClient lets a user paste their own OAuth client (fallback when none is baked in).
func (s *Service) SetOAuthClient(ctx context.Context, clientID, clientSecret string) OpResult {
	p := prefs.Load(s.appName)
	p.OAuthClientID = strings.TrimSpace(clientID)
	p.OAuthClientSecret = strings.TrimSpace(clientSecret)
	if err := prefs.Save(s.appName, p); err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return OpResult{}
}

func (s *Service) BackupNow(ctx context.Context) BackupResult {
	info, err := s.runner.Run(ctx)
	if err != nil {
		return BackupResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return BackupResult{Data: &info}
}
