package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/sqlitedialect"
	"github.com/uptrace/bun/driver/sqliteshim"
	"github.com/uptrace/bun/extra/bundebug"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/config"
)

// busyTimeoutMs is how long a statement waits for another connection's lock
// (a second app instance, an external sqlite3 shell) before failing with BUSY.
const busyTimeoutMs = 5000

// DSN builds the connection string for the SQLite file at path.
//
// sqliteshim resolves to modernc.org/sqlite on every platform this app ships
// for (darwin/amd64, darwin/arm64, windows/amd64), and modernc only honors
// `_pragma=name(value)` — the mattn-style `_foreign_keys=on` / `_journal=WAL`
// keys are silently ignored. The pragmas run on every new connection.
//
// The journal stays in SQLite's default DELETE mode on purpose: the DB folder
// may live in iCloud/Dropbox/OneDrive, and WAL's side files (-wal, -shm) synced
// out of step with the main file can corrupt it.
func DSN(path string) string {
	return fmt.Sprintf("%s?_pragma=busy_timeout(%d)&_pragma=foreign_keys(1)&_txlock=immediate", path, busyTimeoutMs)
}

// Open opens the SQLite file at path with the app's connection settings and
// verifies they took effect. It does not run migrations.
func Open(ctx context.Context, path string) (*bun.DB, error) {
	sqldb, err := sql.Open(sqliteshim.ShimName, DSN(path))
	if err != nil {
		return nil, fmt.Errorf("opening %s: %w", path, err)
	}
	// SQLite: single writer. One connection also keeps every pragma above on
	// the connection that actually runs the queries.
	sqldb.SetMaxOpenConns(1)
	sqldb.SetMaxIdleConns(1)
	sqldb.SetConnMaxLifetime(0)

	bdb := bun.NewDB(sqldb, sqlitedialect.New())
	if err := verifyPragmas(ctx, bdb); err != nil {
		return nil, errors.Join(err, bdb.Close())
	}
	return bdb, nil
}

// verifyPragmas fails when the driver ignored the DSN pragmas, so a driver
// swap can never again silently turn referential integrity off.
func verifyPragmas(ctx context.Context, bdb *bun.DB) error {
	var fk int
	if err := bdb.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fk); err != nil {
		return fmt.Errorf("reading foreign_keys pragma: %w", err)
	}
	if fk != 1 {
		return fmt.Errorf("foreign keys are off (PRAGMA foreign_keys = %d): the SQLite driver ignored the DSN", fk)
	}
	return nil
}

// Exists reports whether the SQLite file at path is already there. main.go
// checks it before connecting: opening a missing path creates an empty DB.
func Exists(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular()
}

// MustConnect opens the database and configures bun. It exits the process on a
// hard connection failure (only ever called from main.go, never from a service).
func MustConnect(cfg *config.Config) *bun.DB {
	if err := os.MkdirAll(filepath.Dir(cfg.DBPath()), 0o755); err != nil {
		slog.Error("creating data dir failed", "err", err)
		os.Exit(1)
	}
	bdb, err := Open(context.Background(), cfg.DBPath())
	if err != nil {
		slog.Error("db open failed", "err", err)
		os.Exit(1)
	}
	if cfg.LogLevel == "debug" {
		bdb.AddQueryHook(bundebug.NewQueryHook(bundebug.WithVerbose(true)))
	}
	return bdb
}
