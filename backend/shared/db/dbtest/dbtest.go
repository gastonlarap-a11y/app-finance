// Package dbtest opens throwaway SQLite databases for tests with exactly the
// production connection settings (db.Open) and the real migrations, so tests
// exercise the same pragmas — foreign keys and their cascades included.
package dbtest

import (
	"path/filepath"
	"testing"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/db"
)

// OpenMigrated opens a fresh temp database and runs every migration on it.
func OpenMigrated(t testing.TB) *bun.DB {
	t.Helper()
	bdb, err := db.Open(t.Context(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() {
		if err := bdb.Close(); err != nil {
			t.Errorf("closing test db: %v", err)
		}
	})
	if err := db.RunMigrations(t.Context(), bdb); err != nil {
		t.Fatalf("migrations: %v", err)
	}
	return bdb
}
