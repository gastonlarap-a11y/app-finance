// Package prefs persists user preferences to a JSON file in a fixed OS location
// (app-support dir), independent of the SQLite database location — because the DB
// folder is itself one of the preferences (chicken-and-egg).
package prefs

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
)

const DefaultDriveFolder = "App Finance Backups"

// Prefs are user-configurable settings edited from the Settings view.
type Prefs struct {
	DBFolder          string `json:"dbFolder"`          // explicit folder for the live DB (empty = use config)
	DriveFolderName   string `json:"driveFolderName"`   // backup folder name in Google Drive
	DriveFolderID     string `json:"driveFolderId"`     // cached Drive folder id
	DriveFileID       string `json:"driveFileId"`       // cached Drive backup file id
	DriveEmail        string `json:"driveEmail"`        // connected account email (for display)
	BackupOnClose     bool   `json:"backupOnClose"`     // run backup when the app closes
	OAuthClientID     string `json:"oauthClientId"`     // optional override of the baked-in client
	OAuthClientSecret string `json:"oauthClientSecret"` // optional override of the baked-in client
	ActiveUserID      int64  `json:"activeUserId"`      // selected finance profile (0 = default to first user)
}

func defaults() Prefs {
	return Prefs{
		DriveFolderName: DefaultDriveFolder,
		BackupOnClose:   true,
	}
}

// Dir is the fixed app-support directory where prefs and the Google token live.
func Dir(appName string) string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("APPDATA"), appName)
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support", appName)
	default:
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".local", "share", appName)
	}
}

func filePath(appName string) string { return filepath.Join(Dir(appName), "prefs.json") }

// TokenPath is where the Google OAuth token is stored (per machine, never shared).
func TokenPath(appName string) string { return filepath.Join(Dir(appName), "google-token.json") }

// Load returns the saved prefs, or sensible defaults when the file is absent.
// An unreadable or corrupt file is logged and falls back to defaults.
func Load(appName string) Prefs {
	p := defaults()
	b, err := os.ReadFile(filePath(appName))
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("prefs: no se pudo leer, usando valores por defecto", "err", err)
		}
		return p
	}
	if err := json.Unmarshal(b, &p); err != nil {
		slog.Warn("prefs: archivo corrupto, usando valores por defecto", "err", err)
		return defaults()
	}
	if p.DriveFolderName == "" {
		p.DriveFolderName = DefaultDriveFolder
	}
	return p
}

// Save writes prefs (0600) to the app-support dir. It writes a temp file and
// renames it over the old one, so a crash mid-write never leaves a torn file.
func Save(appName string, p Prefs) error {
	if err := os.MkdirAll(Dir(appName), 0o755); err != nil {
		return fmt.Errorf("prefs: crear carpeta: %w", err)
	}
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return fmt.Errorf("prefs: serializar: %w", err)
	}
	tmp, err := os.CreateTemp(Dir(appName), "prefs-*.json")
	if err != nil {
		return fmt.Errorf("prefs: archivo temporal: %w", err)
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return fmt.Errorf("prefs: escribir: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("prefs: cerrar: %w", err)
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("prefs: permisos: %w", err)
	}
	if err := os.Rename(tmp.Name(), filePath(appName)); err != nil {
		return fmt.Errorf("prefs: reemplazar: %w", err)
	}
	return nil
}

// Update loads the prefs, applies fn and saves them. Failures are logged rather
// than returned: callers use it after the real operation already succeeded, where
// losing a remembered preference must not turn success into an error.
func Update(appName string, fn func(*Prefs)) {
	p := Load(appName)
	fn(&p)
	if err := Save(appName, p); err != nil {
		slog.Warn("prefs: no se pudo guardar", "err", err)
	}
}
