// Package settings is the Wails service that drives ALL configuration from the UI:
// the local DB folder (native folder picker), the Google Drive connection (visual
// OAuth login), the Drive backup folder, and manual/automatic backups. No commands,
// no external installs.
package settings

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/uptrace/bun"
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/backup"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/config"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/db"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/drive"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/prefs"
)

type Service struct {
	appName string
	db      *bun.DB
	cfg     *config.Config
	drive   *drive.Manager
	runner  *backup.Runner
	// afterRestore re-reads what other services keep in memory from the
	// database (the active profile), once a restore replaced it.
	afterRestore func(ctx context.Context)
}

func NewService(appName string, db *bun.DB, cfg *config.Config, dm *drive.Manager, runner *backup.Runner,
	afterRestore func(ctx context.Context),
) *Service {
	return &Service{appName: appName, db: db, cfg: cfg, drive: dm, runner: runner, afterRestore: afterRestore}
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
// new DB location (applied on next launch — the live DB is not hot-swapped). It
// never replaces a database already in that folder: it could be this profile's
// data from another computer, and there is no way back from overwriting it.
func (s *Service) ApplyDBFolder(ctx context.Context, path string) ApplyFolderResult {
	path = strings.TrimSpace(path)
	if path == "" {
		return ApplyFolderResult{Error: shared.NewError(shared.ErrValidation, "ruta vacía")}
	}
	if !filepath.IsAbs(path) {
		return ApplyFolderResult{Error: shared.NewError(shared.ErrValidation, "la carpeta debe ser una ruta absoluta")}
	}
	dest := filepath.Join(path, s.cfg.DBFilename)
	sameAsCurrent := sameFile(dest, s.cfg.DBPath())
	if !sameAsCurrent && db.Exists(dest) {
		return ApplyFolderResult{Error: shared.NewError(shared.ErrConflict,
			"ya hay una base de datos en esa carpeta: muévela o elige otra carpeta para no reemplazarla")}
	}

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

// sameFile reports whether a and b name the same file. os.SameFile sees through
// case-insensitive file systems (APFS, NTFS) and symlinks, where comparing the
// path strings would miss that the live DB is the destination.
func sameFile(a, b string) bool {
	fa, errA := os.Stat(a)
	fb, errB := os.Stat(b)
	if errA == nil && errB == nil {
		return os.SameFile(fa, fb)
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

// ConnectDrive runs the visual OAuth login (opens the browser) and caches the
// connected account email for display.
func (s *Service) ConnectDrive(ctx context.Context) OpResult {
	err := s.drive.Connect(ctx, func(u string) error { return application.Get().Browser.OpenURL(u) })
	if err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	email := s.drive.AccountEmail(ctx)
	prefs.Update(s.appName, func(p *prefs.Prefs) { p.DriveEmail = email })
	return OpResult{}
}

func (s *Service) DisconnectDrive(ctx context.Context) OpResult {
	if err := s.drive.Disconnect(); err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	prefs.Update(s.appName, func(p *prefs.Prefs) {
		p.DriveFolderID = ""
		p.DriveFileID = ""
		p.DriveEmail = ""
	})
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

// ---------- restore ----------

// ListBackups returns the restorable backups on this computer, newest first.
func (s *Service) ListBackups(ctx context.Context) BackupFilesResult {
	files, err := backup.List(s.runner.LocalDir(), s.runner.DBFile())
	if err != nil {
		return BackupFilesResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return BackupFilesResult{Data: files}
}

// ChooseBackupFile opens a native file picker for a backup kept elsewhere (a
// copy downloaded from Drive, a file exported by the iPad app).
func (s *Service) ChooseBackupFile(ctx context.Context) ChooseFolderResult {
	path, err := application.Get().Dialog.OpenFile().
		CanChooseFiles(true).
		CanChooseDirectories(false).
		AddFilter("Respaldo de App Finance", "*.db;*.sqlite;*.sqlite3").
		SetTitle("Elige el respaldo a restaurar").
		PromptForSingleSelection()
	if err != nil {
		return ChooseFolderResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if strings.TrimSpace(path) == "" {
		return ChooseFolderResult{Canceled: true}
	}
	return ChooseFolderResult{Path: path}
}

// DownloadDriveBackup downloads the Google Drive backup to a temp file and
// returns its path, ready for InspectBackup/RestoreBackup.
func (s *Service) DownloadDriveBackup(ctx context.Context) ChooseFolderResult {
	f, err := os.CreateTemp("", "app-finance-drive-*.db")
	if err != nil {
		return ChooseFolderResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	path := f.Name()
	if err := f.Close(); err != nil {
		return ChooseFolderResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if err := s.drive.Download(ctx, s.runner.DBFile(), prefs.Load(s.appName).DriveFileID, path); err != nil {
		_ = os.Remove(path) // nothing usable was downloaded
		return ChooseFolderResult{Error: restoreError(err)}
	}
	return ChooseFolderResult{Path: path}
}

// InspectBackup checks a backup and reports what it holds; nothing changes.
func (s *Service) InspectBackup(ctx context.Context, path string) InspectResult {
	summary, err := backup.Inspect(ctx, s.cfg.DBPath(), strings.TrimSpace(path))
	if err != nil {
		return InspectResult{Error: restoreError(err)}
	}
	return InspectResult{Data: &summary}
}

// RestoreBackup replaces the current data with the backup at path, keeping a
// copy of what it replaces. The frontend reloads afterwards: every view and
// the active profile change with the data.
func (s *Service) RestoreBackup(ctx context.Context, path string) RestoreResult {
	summary, safety, err := backup.Restore(ctx, s.db, s.cfg.DBPath(), s.runner.LocalDir(), s.runner.DBFile(), strings.TrimSpace(path))
	if err != nil {
		return RestoreResult{Error: restoreError(err)}
	}
	s.runner.MarkRestored()
	if s.afterRestore != nil {
		s.afterRestore(ctx)
	}
	return RestoreResult{Data: &Restored{Summary: summary, SafetyCopy: safety}}
}

// restoreError turns a restore failure into what the UI shows: the reasons a
// file cannot be restored, or Drive cannot provide one, are the user's to act
// on; anything else is internal.
func restoreError(err error) *shared.AppError {
	switch {
	case errors.Is(err, backup.ErrInvalidBackup),
		errors.Is(err, drive.ErrNoRemoteBackup),
		errors.Is(err, drive.ErrReconnect):
		return shared.NewError(shared.ErrValidation, err.Error())
	default:
		return shared.NewError(shared.ErrInternal, err.Error())
	}
}
