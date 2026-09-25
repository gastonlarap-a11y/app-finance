package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/db/dbtest"
)

const dbFile = "app-finance.db"

func TestSnapshotKeepsPreviousCopyOnFailure(t *testing.T) {
	bdb := dbtest.OpenMigrated(t)
	dest := filepath.Join(t.TempDir(), dbFile)
	if err := Snapshot(t.Context(), bdb, dest); err != nil {
		t.Fatalf("first snapshot: %v", err)
	}
	before, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("reading snapshot: %v", err)
	}

	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	if err := Snapshot(canceled, bdb, dest); err == nil {
		t.Fatal("snapshot with a canceled context succeeded, want an error")
	}
	after, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("previous snapshot gone after a failed one: %v", err)
	}
	if string(after) != string(before) {
		t.Fatal("previous snapshot changed by a failed one")
	}
	if _, err := os.Stat(dest + ".tmp"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temp file left behind: %v", err)
	}
}

func TestSeriesPruneKeepsNewest(t *testing.T) {
	dir := t.TempDir()
	s := newSeries(dir, dbFile)
	base := time.Date(2026, 9, 24, 10, 0, 0, 0, time.Local)
	var stamped []string
	for i := range 7 {
		p := s.path(base.Add(time.Duration(i) * time.Minute))
		stamped = append(stamped, p)
		writeFile(t, p)
	}
	// Files outside the series must survive pruning.
	legacy := filepath.Join(dir, dbFile)
	other := filepath.Join(dir, "app-finance-notes.db")
	writeFile(t, legacy)
	writeFile(t, other)

	if err := s.prune(keepBackups); err != nil {
		t.Fatalf("prune: %v", err)
	}
	got, err := s.list()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	want := stamped[len(stamped)-keepBackups:]
	if len(got) != len(want) {
		t.Fatalf("kept %d snapshots, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("kept %v, want the newest %v", got, want)
		}
	}
	for _, p := range []string{legacy, other} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s outside the series was touched: %v", p, err)
		}
	}
}

func TestRunRefusesFreshDatabaseOverExistingBackups(t *testing.T) {
	for _, tc := range []struct {
		name          string
		freshDB       bool
		earlierBackup bool
		wantErr       error
	}{
		{name: "existing DB backs up", freshDB: false, earlierBackup: true},
		{name: "first run backs up", freshDB: true, earlierBackup: false},
		{name: "fresh DB over earlier backups is refused", freshDB: true, earlierBackup: true, wantErr: ErrFreshDatabase},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if tc.earlierBackup {
				writeFile(t, filepath.Join(dir, dbFile)) // pre-rotation single backup
			}
			r := NewRunner(dbtest.OpenMigrated(t), "app-finance-test", dbFile, dir, nil, tc.freshDB)

			info, err := r.Run(t.Context())
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("Run error = %v, want %v", err, tc.wantErr)
			}
			if tc.wantErr != nil {
				return
			}
			if _, err := os.Stat(info.LocalPath); err != nil {
				t.Fatalf("snapshot %q missing: %v", info.LocalPath, err)
			}
			if info.Uploaded {
				t.Fatal("uploaded without a Drive manager")
			}
			if last := r.LastBackup(); last == nil {
				t.Fatal("LastBackup = nil after a successful run")
			}
		})
	}
}

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(path), 0o600); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}
