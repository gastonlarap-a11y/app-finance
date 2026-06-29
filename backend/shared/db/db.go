package db

import (
	"database/sql"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/sqlitedialect"
	"github.com/uptrace/bun/driver/sqliteshim"
	"github.com/uptrace/bun/extra/bundebug"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/config"
)

// MustConnect opens the database and configures bun. It exits the process on a
// hard connection failure (only ever called from main.go, never from a service).
func MustConnect(cfg *config.Config) *bun.DB {
	if err := os.MkdirAll(filepath.Dir(cfg.DBPath()), 0o755); err != nil {
		slog.Error("creating data dir failed", "err", err)
		os.Exit(1)
	}
	dsn := cfg.DBPath() + "?_journal=WAL&_timeout=5000&_foreign_keys=on"
	sqldb, err := sql.Open(sqliteshim.ShimName, dsn)
	if err != nil {
		slog.Error("db open failed", "err", err)
		os.Exit(1)
	}
	// SQLite: single writer, multiple readers.
	sqldb.SetMaxOpenConns(1)
	sqldb.SetMaxIdleConns(1)
	sqldb.SetConnMaxLifetime(0)

	bdb := bun.NewDB(sqldb, sqlitedialect.New())
	if cfg.LogLevel == "debug" {
		bdb.AddQueryHook(bundebug.NewQueryHook(bundebug.WithVerbose(true)))
	}
	return bdb
}
