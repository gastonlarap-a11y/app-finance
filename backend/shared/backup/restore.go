package backup

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/uptrace/bun"
	"modernc.org/sqlite"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/db"
)

// Restoring replaces the live database with a backup, without restarting the
// app. The backup is never trusted as is: it is copied to a temp file, checked
// (integrity, App Finance tables, not from a newer app version) and migrated
// there. Only then is the live database copied aside (pre-restore/) and
// overwritten through SQLite's online backup API, which takes an exclusive lock
// on the destination and replaces its pages whole — on the app's single
// connection, held for the duration so nothing else can touch it.

const (
	// preRestoreDir holds the copy of the live DB taken before each restore.
	preRestoreDir = "pre-restore"
	// keepPreRestore is how many of those copies are kept.
	keepPreRestore = 3
)

// ErrInvalidBackup wraps every reason a file cannot be restored; its message
// is a sentence for the user.
var ErrInvalidBackup = errors.New("respaldo no válido")

// requiredTables are in every App Finance database since its first migrations.
var requiredTables = []string{"bun_migrations", "users", "expenses", "installments"}

// Summary is what a backup holds, shown before the user confirms a restore.
type Summary struct {
	Profiles    int    `json:"profiles"`
	Expenses    int    `json:"expenses"`
	Incomes     int    `json:"incomes"`
	FirstPeriod string `json:"firstPeriod"` // YYYY-MM of the oldest movement; "" when none
	LastPeriod  string `json:"lastPeriod"`
	Migrations  int    `json:"migrations"` // schema updates applied to bring it up to date
}

// File is one restorable backup found on this computer.
type File struct {
	Path string    `json:"path"`
	Kind string    `json:"kind"` // respaldo | antes-de-migrar | antes-de-restaurar | anterior
	At   time.Time `json:"at"`
	Size int64     `json:"size"`
}

// List returns the backups under localDir, newest first: the rotating
// snapshots, the copies taken before migrating and before restoring, and the
// single snapshot older versions wrote.
func List(localDir, dbFile string) ([]File, error) {
	var out []File
	for _, src := range []struct{ dir, kind string }{
		{localDir, "respaldo"},
		{filepath.Join(localDir, preMigrateDir), "antes-de-migrar"},
		{filepath.Join(localDir, preRestoreDir), "antes-de-restaurar"},
	} {
		paths, err := newSeries(src.dir, dbFile).list()
		if err != nil {
			return nil, err
		}
		for _, p := range paths {
			if f, ok := fileInfo(p, src.kind); ok {
				out = append(out, f)
			}
		}
	}
	if f, ok := fileInfo(filepath.Join(localDir, dbFile), "anterior"); ok {
		out = append(out, f)
	}
	slices.SortFunc(out, func(a, b File) int { return b.At.Compare(a.At) })
	return out, nil
}

func fileInfo(path, kind string) (File, bool) {
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return File{}, false
	}
	return File{Path: path, Kind: kind, At: fi.ModTime(), Size: fi.Size()}, true
}

// Inspect checks a backup and reports what it holds, without touching the live
// database.
func Inspect(ctx context.Context, livePath, path string) (Summary, error) {
	staged, summary, err := stage(ctx, livePath, path)
	if err != nil {
		return Summary{}, err
	}
	removeQuietly(staged)
	return summary, nil
}

// Restore replaces the live database with the backup at path. Before touching
// it, the live database is copied to <localDir>/pre-restore/; that path is
// returned so the user knows how to undo.
func Restore(ctx context.Context, live *bun.DB, livePath, localDir, dbFile, path string) (Summary, string, error) {
	staged, summary, err := stage(ctx, livePath, path)
	if err != nil {
		return Summary{}, "", err
	}
	defer removeQuietly(staged)

	safety, err := snapshotRotating(ctx, live, filepath.Join(localDir, preRestoreDir), dbFile, keepPreRestore)
	if err != nil {
		return Summary{}, "", fmt.Errorf("copying the current data aside: %w", err)
	}
	if err := restoreInto(ctx, live, staged); err != nil {
		return Summary{}, safety, fmt.Errorf("restoring: %w", err)
	}
	return summary, safety, nil
}

// stage copies path to a temp file, validates it and migrates it there. The
// caller removes the returned temp file.
func stage(ctx context.Context, livePath, path string) (string, Summary, error) {
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return "", Summary{}, fmt.Errorf("%w: el archivo no existe o no es un archivo", ErrInvalidBackup)
	}
	if lf, err := os.Stat(livePath); err == nil && os.SameFile(fi, lf) {
		return "", Summary{}, fmt.Errorf("%w: es la base de datos que estás usando", ErrInvalidBackup)
	}
	staged, err := copyToTemp(path)
	if err != nil {
		return "", Summary{}, err
	}
	summary, err := checkAndMigrate(ctx, staged)
	if err != nil {
		removeQuietly(staged)
		return "", Summary{}, err
	}
	return staged, summary, nil
}

func copyToTemp(path string) (string, error) {
	src, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("opening the backup: %w", err)
	}
	defer src.Close()
	dst, err := os.CreateTemp("", "app-finance-restore-*.db")
	if err != nil {
		return "", fmt.Errorf("creating a temp copy: %w", err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		return "", errors.Join(fmt.Errorf("copying the backup: %w", err), dst.Close(), os.Remove(dst.Name()))
	}
	if err := dst.Close(); err != nil {
		return "", errors.Join(fmt.Errorf("copying the backup: %w", err), os.Remove(dst.Name()))
	}
	return dst.Name(), nil
}

// sqliteHeader starts every SQLite database file.
var sqliteHeader = []byte("SQLite format 3\x00")

func checkAndMigrate(ctx context.Context, path string) (Summary, error) {
	head := make([]byte, len(sqliteHeader))
	f, err := os.Open(path)
	if err != nil {
		return Summary{}, fmt.Errorf("reading the backup: %w", err)
	}
	_, err = io.ReadFull(f, head)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil || string(head) != string(sqliteHeader) {
		return Summary{}, fmt.Errorf("%w: el archivo no es una base de datos SQLite", ErrInvalidBackup)
	}

	bdb, err := db.Open(ctx, path)
	if err != nil {
		return Summary{}, fmt.Errorf("%w: no se pudo abrir (%w)", ErrInvalidBackup, err)
	}
	defer func() { _ = bdb.Close() }() // a temp copy: nothing to flush

	var check string
	if err := bdb.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&check); err != nil || check != "ok" {
		return Summary{}, fmt.Errorf("%w: el archivo está dañado (integrity_check: %s)", ErrInvalidBackup, orText(check, err))
	}
	var tables int
	if err := bdb.NewRaw("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN (?)",
		bun.List(requiredTables)).Scan(ctx, &tables); err != nil {
		return Summary{}, fmt.Errorf("reading the backup's tables: %w", err)
	}
	if tables != len(requiredTables) {
		return Summary{}, fmt.Errorf("%w: es una base de datos, pero no de App Finance", ErrInvalidBackup)
	}
	pending, err := db.PendingMigrations(ctx, bdb)
	if errors.Is(err, db.ErrNewerSchema) {
		return Summary{}, fmt.Errorf("%w: es de una versión más nueva de la app; actualízala antes de restaurarlo", ErrInvalidBackup)
	}
	if err != nil {
		return Summary{}, fmt.Errorf("checking the backup's schema: %w", err)
	}
	if err := db.RunMigrations(ctx, bdb); err != nil {
		return Summary{}, fmt.Errorf("%w: no se pudo poner al día con esta versión (%w)", ErrInvalidBackup, err)
	}
	summary, err := summarize(ctx, bdb)
	summary.Migrations = pending
	return summary, err
}

func orText(s string, err error) string {
	if err != nil {
		return err.Error()
	}
	return s
}

// summarize counts what the backup holds, ignoring rows in the trash (they
// would inflate a "your data is here" number).
func summarize(ctx context.Context, bdb *bun.DB) (Summary, error) {
	var s Summary
	for _, c := range []struct {
		dst   *int
		table string
	}{{&s.Profiles, "users"}, {&s.Expenses, "expenses"}, {&s.Incomes, "incomes"}} {
		if err := bdb.NewRaw("SELECT count(*) FROM "+c.table+" WHERE deleted_at IS NULL").Scan(ctx, c.dst); err != nil {
			return s, fmt.Errorf("counting %s: %w", c.table, err)
		}
	}
	var first, last sql.NullString
	if err := bdb.QueryRowContext(ctx, `
		SELECT MIN(period), MAX(period) FROM (
			SELECT i.period FROM installments i JOIN expenses e ON e.id = i.expense_id WHERE e.deleted_at IS NULL
			UNION ALL
			SELECT period FROM incomes WHERE deleted_at IS NULL)`).Scan(&first, &last); err != nil {
		return s, fmt.Errorf("reading the period range: %w", err)
	}
	s.FirstPeriod, s.LastPeriod = first.String, last.String
	return s, nil
}

// restorer is the part of modernc's driver connection used here.
type restorer interface {
	NewRestore(srcURI string) (*sqlite.Backup, error)
}

// restoreInto overwrites the live database with the file at src through the
// online backup API, on a connection held for the whole copy: SQLite requires
// that nothing else use the destination connection meanwhile, and the app has
// a single one, so every other query waits.
func restoreInto(ctx context.Context, live *bun.DB, src string) error {
	conn, err := live.DB.Conn(ctx)
	if err != nil {
		return fmt.Errorf("taking the connection: %w", err)
	}
	defer func() { _ = conn.Close() }() // returns it to the pool
	return conn.Raw(func(driverConn any) error {
		r, ok := driverConn.(restorer)
		if !ok {
			return errors.New("este driver de SQLite no permite restaurar con la app abierta")
		}
		b, err := r.NewRestore(src)
		if err != nil {
			return fmt.Errorf("starting the restore: %w", err)
		}
		if _, err := b.Step(-1); err != nil {
			return errors.Join(fmt.Errorf("copying pages: %w", err), b.Finish())
		}
		return b.Finish()
	})
}

func removeQuietly(path string) {
	_ = os.Remove(path) // a temp file: the OS cleans it up anyway
}
