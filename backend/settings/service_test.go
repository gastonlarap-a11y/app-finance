package settings

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/config"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/db/dbtest"
)

// These cases all return before prefs are saved, so they never touch the real
// app-support folder.
func TestApplyDBFolderRefusals(t *testing.T) {
	live := t.TempDir()
	cfg := &config.Config{DBFilename: "app-finance.db", DataDir: live}
	s := NewService("app-finance-test", dbtest.OpenMigrated(t), cfg, nil, nil, nil)

	occupied := t.TempDir()
	if err := os.WriteFile(filepath.Join(occupied, cfg.DBFilename), []byte("another computer's data"), 0o600); err != nil {
		t.Fatalf("seeding existing DB: %v", err)
	}

	for _, tc := range []struct {
		name     string
		path     string
		wantCode string
	}{
		{name: "empty path", path: "  ", wantCode: shared.ErrValidation},
		{name: "relative path", path: "Documents/finanzas", wantCode: shared.ErrValidation},
		{name: "folder already holding a DB", path: occupied, wantCode: shared.ErrConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := s.ApplyDBFolder(t.Context(), tc.path)
			if res.Error == nil || res.Error.Code != tc.wantCode {
				t.Fatalf("ApplyDBFolder(%q) error = %+v, want %s", tc.path, res.Error, tc.wantCode)
			}
		})
	}

	got, err := os.ReadFile(filepath.Join(occupied, cfg.DBFilename))
	if err != nil || !strings.Contains(string(got), "another computer") {
		t.Fatalf("existing DB was modified: %q, %v", got, err)
	}
}

func TestSameFile(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "app-finance.db")
	if err := os.WriteFile(f, nil, 0o600); err != nil {
		t.Fatalf("seeding: %v", err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if !sameFile(filepath.Join(link, "app-finance.db"), f) {
		t.Fatal("sameFile through a symlinked folder = false, want true")
	}
	if sameFile(filepath.Join(dir, "other.db"), f) {
		t.Fatal("sameFile of different paths = true, want false")
	}
}
