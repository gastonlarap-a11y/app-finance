// Package backup makes consistent SQLite snapshots and (when connected) uploads
// them to Google Drive. The live database is never copied directly — VACUUM
// INTO produces a standalone, consistent copy that is safe to upload.
//
// Local snapshots are timestamped and rotated, and each one is written to a
// temp file and renamed into place, so a failed or interrupted backup never
// destroys the previous good copy.
package backup

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/drive"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/prefs"
)

const (
	// keepBackups is how many timestamped local snapshots Run keeps.
	keepBackups = 5
	// keepPreMigrate is how many pre-migration snapshots SnapshotBeforeMigrate keeps.
	keepPreMigrate = 3
	// preMigrateDir is the subfolder of the backup dir holding pre-migration snapshots.
	preMigrateDir = "pre-migrate"
	// stampLayout names each snapshot; it sorts lexically in time order.
	stampLayout = "20060102-150405"
)

// ErrFreshDatabase refuses a backup of a database created empty in this session
// while earlier backups exist: the likely cause is a DB folder that went missing
// (an unsynced cloud folder, an unplugged drive), and backing up the empty
// database would push the good copies out of rotation and overwrite the Drive file.
var ErrFreshDatabase = errors.New("la base de datos se creó vacía al abrir la app y ya hay respaldos anteriores: " +
	"no se respalda para no reemplazarlos (revisa la carpeta de la base de datos en Ajustes)")

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
	// freshDB: the database was created empty this session (see
	// ErrFreshDatabase). Atomic: a restore clears it while a backup may run.
	freshDB atomic.Bool
}

// NewRunner builds the backup runner. freshDB is true when the database file did
// not exist before this session opened it (see ErrFreshDatabase).
func NewRunner(db *bun.DB, appName, dbFile, localDir string, dm *drive.Manager, freshDB bool) *Runner {
	r := &Runner{db: db, appName: appName, dbFile: dbFile, localDir: localDir, drive: dm}
	r.freshDB.Store(freshDB)
	return r
}

// MarkRestored records that the live database now holds restored data: the
// guard against backing up an empty database no longer applies. This is the
// way out of a missing DB folder — restore a backup, and backups resume.
func (r *Runner) MarkRestored() { r.freshDB.Store(false) }

// LocalDir is where local snapshots (and the restore safety copies) live.
func (r *Runner) LocalDir() string { return r.localDir }

// DBFile is the database's file name, which names the snapshots too.
func (r *Runner) DBFile() string { return r.dbFile }

// Snapshot writes a consistent copy of the database to destFile using VACUUM
// INTO. The copy is built next to destFile and renamed over it only once
// complete, so an existing destFile survives a failed snapshot.
func Snapshot(ctx context.Context, db *bun.DB, destFile string) error {
	if err := os.MkdirAll(filepath.Dir(destFile), 0o755); err != nil {
		return fmt.Errorf("creating backup folder: %w", err)
	}
	tmp := destFile + ".tmp"
	// VACUUM INTO requires its target not to exist: clear a leftover temp file.
	if err := os.Remove(tmp); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("removing stale temp snapshot: %w", err)
	}
	if _, err := db.ExecContext(ctx, "VACUUM INTO ?", tmp); err != nil {
		if rmErr := os.Remove(tmp); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
			err = errors.Join(err, rmErr)
		}
		return fmt.Errorf("vacuum into temp snapshot: %w", err)
	}
	if err := os.Rename(tmp, destFile); err != nil {
		return fmt.Errorf("moving snapshot into place: %w", err)
	}
	return nil
}

// SnapshotBeforeMigrate keeps a copy of the database as it was before this
// version's migrations touch it, under <localDir>/pre-migrate/.
func SnapshotBeforeMigrate(ctx context.Context, db *bun.DB, localDir, dbFile string) (string, error) {
	return snapshotRotating(ctx, db, filepath.Join(localDir, preMigrateDir), dbFile, keepPreMigrate)
}

// snapshotRotating writes <dir>/<name>-<stamp><ext> and prunes all but the
// newest keep snapshots of that series. A failed prune only leaves extra
// copies behind, so it is logged instead of failing the backup.
func snapshotRotating(ctx context.Context, db *bun.DB, dir, dbFile string, keep int) (string, error) {
	s := newSeries(dir, dbFile)
	dest := s.path(time.Now())
	if err := Snapshot(ctx, db, dest); err != nil {
		return "", err
	}
	if err := s.prune(keep); err != nil {
		slog.Warn("respaldo: no se pudieron borrar copias antiguas", "dir", dir, "err", err)
	}
	return dest, nil
}

// LastBackup returns when the newest local snapshot was taken, if any.
func (r *Runner) LastBackup() *time.Time {
	files, err := newSeries(r.localDir, r.dbFile).list()
	if err == nil && len(files) > 0 {
		if fi, err := os.Stat(files[len(files)-1]); err == nil {
			t := fi.ModTime()
			return &t
		}
	}
	// Single, untimestamped snapshot written by versions before rotation.
	if fi, err := os.Stat(filepath.Join(r.localDir, r.dbFile)); err == nil {
		t := fi.ModTime()
		return &t
	}
	return nil
}

// Run snapshots the DB locally (rotating the timestamped copies) and, when
// Drive is connected, uploads it (overwriting the single Drive backup file).
// Folder/file ids are cached in prefs.
func (r *Runner) Run(ctx context.Context) (Info, error) {
	if r.freshDB.Load() && r.LastBackup() != nil {
		return Info{}, ErrFreshDatabase
	}
	local, err := snapshotRotating(ctx, r.db, r.localDir, r.dbFile, keepBackups)
	if err != nil {
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
	// Caching the ids only saves a lookup next time; the upload already succeeded.
	prefs.Update(r.appName, func(p *prefs.Prefs) {
		p.DriveFolderID = folderID
		p.DriveFileID = fileID
	})

	info.Uploaded = true
	info.RemoteFolder = p.DriveFolderName
	return info, nil
}

// series is one family of timestamped snapshots of dbFile inside dir:
// "<name>-20260924-153000<ext>" for dbFile "<name><ext>".
type series struct {
	dir, name, ext string
	re             *regexp.Regexp
}

func newSeries(dir, dbFile string) series {
	ext := filepath.Ext(dbFile)
	name := strings.TrimSuffix(dbFile, ext)
	re := regexp.MustCompile(`^` + regexp.QuoteMeta(name) + `-\d{8}-\d{6}` + regexp.QuoteMeta(ext) + `$`)
	return series{dir: dir, name: name, ext: ext, re: re}
}

func (s series) path(at time.Time) string {
	return filepath.Join(s.dir, s.name+"-"+at.Format(stampLayout)+s.ext)
}

// list returns the series' snapshots, oldest first.
func (s series) list() ([]string, error) {
	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("listing %s: %w", s.dir, err)
	}
	var out []string
	for _, e := range entries {
		if e.Type().IsRegular() && s.re.MatchString(e.Name()) {
			out = append(out, filepath.Join(s.dir, e.Name()))
		}
	}
	slices.Sort(out) // the stamp sorts lexically in time order
	return out, nil
}

// prune removes all but the newest keep snapshots.
func (s series) prune(keep int) error {
	files, err := s.list()
	if err != nil {
		return err
	}
	var errs []error
	for _, f := range files[:max(0, len(files)-keep)] {
		if err := os.Remove(f); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
