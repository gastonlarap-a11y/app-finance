package updates

import (
	"time"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

// Update flow phases, as the UI shows them.
const (
	PhaseIdle        = "idle"        // nothing in progress (an update may be available)
	PhaseChecking    = "checking"    // asking GitHub for the latest release
	PhaseDownloading = "downloading" // downloading + verifying; progress arrives as updater events
	PhaseReady       = "ready"       // verified and staged: restart to apply
	PhaseRestarting  = "restarting"  // backing up, then quitting into the new version
)

type OpResult struct {
	Error *shared.AppError `json:"error,omitempty"`
}

// ReleaseInfo is the newer release this app can update to.
type ReleaseInfo struct {
	Version     string    `json:"version"`
	Notes       string    `json:"notes"` // markdown, as published on GitHub
	PublishedAt time.Time `json:"publishedAt"`
	Size        int64     `json:"size"` // bytes to download
}

// UpdateState is everything the update banner and the settings section show.
type UpdateState struct {
	CurrentVersion string       `json:"currentVersion"`
	Phase          string       `json:"phase"`
	Available      *ReleaseInfo `json:"available"` // nil = up to date (or not checked yet)
	LastChecked    *time.Time   `json:"lastChecked"`
	LastError      string       `json:"lastError"`
	Blocked        string       `json:"blocked"` // why this copy cannot update itself; "" = it can
}

type UpdateStateResult struct {
	Data  *UpdateState     `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}
