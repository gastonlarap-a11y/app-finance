package backup

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/db"
)

// openAt opens (creating and migrating) an App Finance database at path.
func openAt(t *testing.T, path string) *bun.DB {
	t.Helper()
	bdb, err := db.Open(t.Context(), path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	t.Cleanup(func() {
		if err := bdb.Close(); err != nil {
			t.Errorf("closing %s: %v", path, err)
		}
	})
	if err := db.RunMigrations(t.Context(), bdb); err != nil {
		t.Fatalf("migrations: %v", err)
	}
	return bdb
}

func addExpense(t *testing.T, bdb *bun.DB, description string) {
	t.Helper()
	res, err := bdb.ExecContext(t.Context(), `INSERT INTO expenses
		(user_id, date, description, category, merchant, kind, installment_amount, installments_total)
		VALUES (1, '2026-07-10 00:00:00+00:00', ?, '', '', 'unico', '1000', 1)`, description)
	if err != nil {
		t.Fatalf("insert expense: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bdb.ExecContext(t.Context(), `INSERT INTO installments
		(user_id, expense_id, number, total, period, amount, status) VALUES (1, ?, 1, 1, '2026-07', '1000', 'pendiente')`, id); err != nil {
		t.Fatalf("insert installment: %v", err)
	}
}

func descriptions(t *testing.T, bdb *bun.DB) []string {
	t.Helper()
	var out []string
	if err := bdb.NewRaw("SELECT description FROM expenses ORDER BY id").Scan(t.Context(), &out); err != nil {
		t.Fatalf("reading expenses: %v", err)
	}
	return out
}

// backupFile builds a backup holding one expense, as a snapshot file.
func backupFile(t *testing.T, description string) string {
	t.Helper()
	src := openAt(t, filepath.Join(t.TempDir(), "other.db"))
	addExpense(t, src, description)
	path := filepath.Join(t.TempDir(), "backup.db")
	if err := Snapshot(t.Context(), src, path); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	return path
}

func TestRestoreReplacesTheLiveDatabase(t *testing.T) {
	ctx := t.Context()
	dir := t.TempDir()
	livePath := filepath.Join(dir, "app-finance.db")
	live := openAt(t, livePath)
	addExpense(t, live, "lo de hoy")
	localDir := filepath.Join(dir, "backups")

	summary, safety, err := Restore(ctx, live, livePath, localDir, "app-finance.db", backupFile(t, "lo del respaldo"))
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if got := descriptions(t, live); len(got) != 1 || got[0] != "lo del respaldo" {
		t.Fatalf("live expenses after restore = %v, want the backup's", got)
	}
	if summary.Profiles != 1 || summary.Expenses != 1 || summary.FirstPeriod != "2026-07" || summary.Migrations != 0 {
		t.Fatalf("summary = %+v", summary)
	}

	// The same connection keeps working, with its pragmas.
	var fk int
	if err := live.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fk); err != nil || fk != 1 {
		t.Fatalf("foreign_keys after restore = %d, %v", fk, err)
	}
	addExpense(t, live, "después de restaurar")

	// What was replaced is kept aside, and restoring it undoes the restore.
	if filepath.Dir(safety) != filepath.Join(localDir, preRestoreDir) {
		t.Fatalf("safety copy at %s, want under pre-restore/", safety)
	}
	if _, _, err := Restore(ctx, live, livePath, localDir, "app-finance.db", safety); err != nil {
		t.Fatalf("restoring the safety copy: %v", err)
	}
	if got := descriptions(t, live); len(got) != 1 || got[0] != "lo de hoy" {
		t.Fatalf("after undoing = %v, want the original data back", got)
	}
}

func TestRestoreMigratesAnOlderBackup(t *testing.T) {
	src := openAt(t, filepath.Join(t.TempDir(), "old.db"))
	// An older backup lacks the latest migration (an idempotent index set).
	if _, err := src.ExecContext(t.Context(), "DELETE FROM bun_migrations WHERE name = '20260926021'"); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "old-backup.db")
	if err := Snapshot(t.Context(), src, path); err != nil {
		t.Fatal(err)
	}
	summary, err := Inspect(t.Context(), filepath.Join(t.TempDir(), "live.db"), path)
	if err != nil || summary.Migrations != 1 {
		t.Fatalf("Inspect = %+v, %v; want 1 migration to apply", summary, err)
	}
}

func TestInspectRefusesWhatCannotBeRestored(t *testing.T) {
	dir := t.TempDir()
	livePath := filepath.Join(dir, "app-finance.db")
	openAt(t, livePath) // the live DB, in use while backups are inspected

	text := filepath.Join(dir, "notas.txt")
	if err := os.WriteFile(text, []byte("no es una base"), 0o600); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(dir, "otra.db")
	other, err := db.Open(t.Context(), foreign)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.ExecContext(t.Context(), "CREATE TABLE notas (id INTEGER PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	if err := other.Close(); err != nil {
		t.Fatal(err)
	}
	newer := backupFile(t, "x")
	nb, err := db.Open(t.Context(), newer)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := nb.ExecContext(t.Context(), "INSERT INTO bun_migrations (name, group_id) VALUES ('99991231999', 99)"); err != nil {
		t.Fatal(err)
	}
	if err := nb.Close(); err != nil {
		t.Fatal(err)
	}
	corrupt := backupFile(t, "y")
	b, err := os.ReadFile(corrupt)
	if err != nil {
		t.Fatal(err)
	}
	for i := 4096; i < 8192 && i < len(b); i++ {
		b[i] = 0xff
	}
	if err := os.WriteFile(corrupt, b, 0o600); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct{ name, path string }{
		{"missing file", filepath.Join(dir, "no-existe.db")},
		{"not a database", text},
		{"a database of another app", foreign},
		{"from a newer app version", newer},
		{"corrupt", corrupt},
		{"the live database itself", livePath},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Inspect(t.Context(), livePath, tc.path); !errors.Is(err, ErrInvalidBackup) {
				t.Fatalf("Inspect = %v, want ErrInvalidBackup", err)
			}
		})
	}
}

func TestListBackupsNewestFirst(t *testing.T) {
	dir := t.TempDir()
	s := newSeries(dir, "app-finance.db")
	old := s.path(time.Date(2026, 9, 1, 10, 0, 0, 0, time.Local))
	recent := s.path(time.Date(2026, 9, 20, 10, 0, 0, 0, time.Local))
	pre := newSeries(filepath.Join(dir, preMigrateDir), "app-finance.db").path(time.Date(2026, 9, 10, 10, 0, 0, 0, time.Local))
	for i, p := range []string{old, recent, pre} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		writeFile(t, p)
		at := time.Date(2026, 9, []int{1, 20, 10}[i], 10, 0, 0, 0, time.Local)
		if err := os.Chtimes(p, at, at); err != nil {
			t.Fatal(err)
		}
	}
	files, err := List(dir, "app-finance.db")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 3 || files[0].Path != recent || files[1].Kind != "antes-de-migrar" || files[2].Path != old {
		t.Fatalf("List = %+v, want recent, pre-migrate, old", files)
	}
}

func TestMarkRestoredLiftsTheFreshDatabaseGuard(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, dbFile)) // an earlier backup exists
	r := NewRunner(openAt(t, filepath.Join(t.TempDir(), "live.db")), "app-finance-test", dbFile, dir, nil, true)
	if _, err := r.Run(t.Context()); !errors.Is(err, ErrFreshDatabase) {
		t.Fatalf("Run on a fresh database = %v, want ErrFreshDatabase", err)
	}
	r.MarkRestored()
	if _, err := r.Run(t.Context()); err != nil {
		t.Fatalf("Run after a restore: %v", err)
	}
}
