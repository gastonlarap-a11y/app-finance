package db_test

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/db"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/db/dbtest"
)

// orphanCleanup is the migration that applies the cascades desktop builds
// skipped while foreign keys were off.
const orphanCleanup = "20260926019"

func TestOpenAppliesPragmas(t *testing.T) {
	bdb := dbtest.OpenMigrated(t)
	for _, tc := range []struct {
		pragma string
		want   int
	}{
		{"foreign_keys", 1},
		{"busy_timeout", 5000},
	} {
		t.Run(tc.pragma, func(t *testing.T) {
			var got int
			if err := bdb.QueryRowContext(t.Context(), "PRAGMA "+tc.pragma).Scan(&got); err != nil {
				t.Fatalf("reading %s: %v", tc.pragma, err)
			}
			if got != tc.want {
				t.Fatalf("PRAGMA %s = %d, want %d", tc.pragma, got, tc.want)
			}
		})
	}
}

func TestPendingMigrations(t *testing.T) {
	ctx := t.Context()
	bdb, err := db.Open(ctx, filepath.Join(t.TempDir(), "fresh.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = bdb.Close() }) // test cleanup: a close error changes nothing

	before, err := db.PendingMigrations(ctx, bdb)
	if err != nil || before == 0 {
		t.Fatalf("PendingMigrations on a fresh DB = %d, %v; want > 0", before, err)
	}
	if err := db.RunMigrations(ctx, bdb); err != nil {
		t.Fatalf("RunMigrations: %v", err)
	}
	if after, err := db.PendingMigrations(ctx, bdb); err != nil || after != 0 {
		t.Fatalf("PendingMigrations after migrating = %d, %v; want 0", after, err)
	}
}

func TestMigrationsRefuseNewerSchema(t *testing.T) {
	ctx := t.Context()
	bdb := dbtest.OpenMigrated(t)
	// What a newer app version leaves behind: a migration this binary lacks.
	if _, err := bdb.ExecContext(ctx, "INSERT INTO bun_migrations (name, group_id) VALUES ('99991231999', 99)"); err != nil {
		t.Fatalf("seeding unknown migration: %v", err)
	}
	if _, err := db.PendingMigrations(ctx, bdb); !errors.Is(err, db.ErrNewerSchema) {
		t.Fatalf("PendingMigrations = %v, want ErrNewerSchema", err)
	}
	if err := db.RunMigrations(ctx, bdb); !errors.Is(err, db.ErrNewerSchema) {
		t.Fatalf("RunMigrations = %v, want ErrNewerSchema", err)
	}
}

// Databases created from the original template still record its removed
// migrations (20260628001/002); they must open normally.
func TestMigrationsIgnoreRetiredOnes(t *testing.T) {
	ctx := t.Context()
	bdb := dbtest.OpenMigrated(t)
	mustExec(t, bdb, "INSERT INTO bun_migrations (name, group_id) VALUES ('20260628001', 1), ('20260628002', 1)")
	if pending, err := db.PendingMigrations(ctx, bdb); err != nil || pending != 0 {
		t.Fatalf("PendingMigrations = %d, %v; want 0, nil", pending, err)
	}
	if err := db.RunMigrations(ctx, bdb); err != nil {
		t.Fatalf("RunMigrations with retired migrations recorded: %v", err)
	}
}

// TestOrphanCleanupMigration seeds the rows a desktop DB accumulated while its
// foreign keys were off, then re-runs the cleanup migration over them.
func TestOrphanCleanupMigration(t *testing.T) {
	ctx := t.Context()
	bdb := dbtest.OpenMigrated(t)

	mustExec(t, bdb, "PRAGMA foreign_keys = OFF")
	mustExec(t, bdb, `INSERT INTO card_statement_lines
		(user_id, statement_id, position, section, operation_date, description, installment_id)
		VALUES (1, 404, 1, 'compra', '2026-09-01', 'LINEA HUERFANA', NULL)`)
	mustExec(t, bdb, `INSERT INTO card_statement_schedule (statement_id, period, amount) VALUES (404, '2026-10', '1000')`)
	mustExec(t, bdb, `INSERT INTO fixed_expense_payments (fixed_expense_id, period) VALUES (404, '2026-09')`)
	mustExec(t, bdb, `INSERT INTO import_items
		(user_id, source, issuer, external_key, date, description, amount, statement_line_id)
		VALUES (1, 'test', 'itau', 'k1', '2026-09-01', 'ITEM', '1000', 404)`)
	mustExec(t, bdb, "PRAGMA foreign_keys = ON")
	mustExec(t, bdb, "DELETE FROM bun_migrations WHERE name = ?", orphanCleanup)

	if err := db.RunMigrations(ctx, bdb); err != nil {
		t.Fatalf("re-running the cleanup: %v", err)
	}

	var violations []struct {
		Table  string `bun:"table"`
		RowID  int64  `bun:"rowid"`
		Parent string `bun:"parent"`
		FKID   int64  `bun:"fkid"`
	}
	if err := bdb.NewRaw("PRAGMA foreign_key_check").Scan(ctx, &violations); err != nil {
		t.Fatalf("foreign_key_check: %v", err)
	}
	if len(violations) != 0 {
		t.Fatalf("foreign_key_check after cleanup = %+v, want none", violations)
	}
	var kept int
	if err := bdb.NewRaw("SELECT count(*) FROM import_items WHERE external_key = 'k1'").Scan(ctx, &kept); err != nil || kept != 1 {
		t.Fatalf("staged item = %d (err %v), want it kept with its link cleared", kept, err)
	}
}

func mustExec(t *testing.T, bdb *bun.DB, query string, args ...any) {
	t.Helper()
	if _, err := bdb.ExecContext(t.Context(), query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}
