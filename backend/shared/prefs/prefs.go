// Package prefs persists user preferences to a JSON file in a fixed OS location
// (app-support dir), independent of the SQLite database location — because the DB
// folder is itself one of the preferences (chicken-and-egg).
package prefs

import (
	"encoding/json"
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
func Load(appName string) Prefs {
	p := defaults()
	b, err := os.ReadFile(filePath(appName))
	if err != nil {
		return p
	}
	_ = json.Unmarshal(b, &p)
	if p.DriveFolderName == "" {
		p.DriveFolderName = DefaultDriveFolder
	}
	return p
}

// Save writes prefs (0600) to the app-support dir.
func Save(appName string, p Prefs) error {
	if err := os.MkdirAll(Dir(appName), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filePath(appName), b, 0o600)
}
