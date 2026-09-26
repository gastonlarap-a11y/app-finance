package backup

import (
	"fmt"
	"os"
	"testing"
)

// TestMain points the per-user app-support folder (prefs.Dir) at a temp dir:
// Runner.Run records this computer's sync id in prefs.json (prefs.DeviceID),
// which must never land in the developer's real ~/Library/Application Support.
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
