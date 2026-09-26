package mailsync

import (
	"fmt"
	"os"
	"testing"
)

// TestMain points the per-user app-support folder (prefs.Dir) at a temp dir:
// the harness switches profiles through users.Service, which persists the
// active one to prefs.json — the tests used to write it into the developer's
// real ~/Library/Application Support.
func TestMain(m *testing.M) {
	os.Exit(runWithTempHome(m))
}

func runWithTempHome(m *testing.M) int {
	home, err := os.MkdirTemp("", "app-finance-test-home-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "temp home:", err)
		return 1
	}
	defer os.RemoveAll(home)                          // best-effort cleanup of a temp dir
	for _, key := range []string{"HOME", "APPDATA"} { // APPDATA: prefs.Dir on Windows
		if err := os.Setenv(key, home); err != nil {
			fmt.Fprintln(os.Stderr, "set", key+":", err)
			return 1
		}
	}
	return m.Run()
}
