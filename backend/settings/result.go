package settings

import (
	"time"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/backup"
)

// State is the full settings snapshot shown in the Settings view.
type State struct {
	DBFolder           string     `json:"dbFolder"`           // carpeta efectiva donde vive la BD ahora
	BackupLocalDir     string     `json:"backupLocalDir"`     // dónde se guardan los snapshots locales
	DriveConnected     bool       `json:"driveConnected"`     // hay token guardado
	DriveEmail         string     `json:"driveEmail"`         // cuenta conectada (para mostrar)
	DriveFolderName    string     `json:"driveFolderName"`    // carpeta de respaldos en Drive
	BackupOnClose      bool       `json:"backupOnClose"`      // respaldar al cerrar
	ClientIDConfigured bool       `json:"clientIdConfigured"` // hay Client ID (embebido/env/UI)
	LastBackup         *time.Time `json:"lastBackup"`
}

type StateResult struct {
	Data  *State           `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

type ChooseFolderResult struct {
	Path     string           `json:"path"`
	Canceled bool             `json:"canceled"`
	Error    *shared.AppError `json:"error,omitempty"`
}

type ApplyFolderResult struct {
	Path         string           `json:"path"`
	NeedsRestart bool             `json:"needsRestart"`
	Error        *shared.AppError `json:"error,omitempty"`
}

type BackupResult struct {
	Data  *backup.Info     `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

type OpResult struct {
	Error *shared.AppError `json:"error,omitempty"`
}
