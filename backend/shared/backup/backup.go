// Package backup makes consistent SQLite snapshots and (when connected) uploads
// them to Google Drive. The live WAL database is never synced directly — VACUUM
// INTO produces a standalone, consistent copy that is safe to upload.
package backup

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/drive"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/prefs"
)

// Info describes the result of a backup run.
type Info struct {
	LocalPath    string    `json:"localPath"`
	RemoteFolder string    `json:"remoteFolder"`
	Uploaded     bool      `json:"uploaded"`
	At           time.Time `json:"at"`
}

type Runner struct {
	db       *bun.DB
	appName  string
	dbFile   string
	localDir string
	drive    *drive.Manager
}

func NewRunner(db *bun.DB, appName, dbFile, localDir string, dm *drive.Manager) *Runner {
	return &Runner{db: db, appName: appName, dbFile: dbFile, localDir: localDir, drive: dm}
}

// Snapshot writes a consistent copy of the database to destFile using VACUUM INTO.
func Snapshot(ctx context.Context, db *bun.DB, destFile string) error {
	if err := os.MkdirAll(filepath.Dir(destFile), 0o755); err != nil {
		return err
	}
	// VACUUM INTO requires the destination not to exist.
	if err := os.Remove(destFile); err != nil && !os.IsNotExist(err) {
		return err
	}
	_, err := db.ExecContext(ctx, "VACUUM INTO ?", destFile)
	return err
}

// LocalPath is where the local snapshot is written before upload.
func (r *Runner) LocalPath() string { return filepath.Join(r.localDir, r.dbFile) }

// LastBackup returns the mtime of the local snapshot, if any.
func (r *Runner) LastBackup() *time.Time {
	if fi, err := os.Stat(r.LocalPath()); err == nil {
		t := fi.ModTime()
		return &t
	}
	return nil
}

// Run snapshots the DB locally and, when Drive is connected, uploads it
// (overwriting the single backup file). Folder/file ids are cached in prefs.
func (r *Runner) Run(ctx context.Context) (Info, error) {
	local := r.LocalPath()
	if err := Snapshot(ctx, r.db, local); err != nil {
		return Info{}, err
	}
	info := Info{LocalPath: local, At: time.Now()}

	if r.drive == nil || !r.drive.IsConnected() {
		return info, nil // local-only snapshot
	}
	p := prefs.Load(r.appName)
	folderID, fileID, err := r.drive.Upload(ctx, local, p.DriveFolderName, r.dbFile, p.DriveFolderID, p.DriveFileID)
	if err != nil {
		return info, err
	}
	p.DriveFolderID = folderID
	p.DriveFileID = fileID
	_ = prefs.Save(r.appName, p)

	info.Uploaded = true
	info.RemoteFolder = p.DriveFolderName
	return info, nil
}
