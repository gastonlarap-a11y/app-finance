package logger

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The log file goes to the absolute directory given, whatever the working
// directory is (a packaged app runs with "/" as its working directory).
func TestSetupWritesToTheGivenDirectory(t *testing.T) {
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })
	dir := filepath.Join(t.TempDir(), "App Finance", "logs")

	Setup("info", dir)
	slog.Info("hello from the test", "k", "v")

	data, err := os.ReadFile(filepath.Join(dir, "app.log"))
	if err != nil {
		t.Fatalf("reading log file: %v", err)
	}
	if !strings.Contains(string(data), "hello from the test") {
		t.Fatalf("log file = %q, want the record", data)
	}
}
