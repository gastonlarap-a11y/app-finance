package mailsync

import (
	"time"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

// Concrete Result types (no generics — safest for the Wails binding generator).

type OpResult struct {
	Error *shared.AppError `json:"error,omitempty"`
}

// MailAccountInput is what the settings form saves. An empty Password keeps
// the one already stored in the keychain.
type MailAccountInput struct {
	Host         string `json:"host"`
	Port         int    `json:"port"`
	Username     string `json:"username"`
	Password     string `json:"password"`
	Folder       string `json:"folder"`
	SenderFilter string `json:"senderFilter"`
	StartDate    string `json:"startDate"` // YYYY-MM-DD
	AutoSync     bool   `json:"autoSync"`
}

// MailState is the active profile's mailbox configuration plus the outcome of
// its last sync, for the settings screen and the import inbox.
type MailState struct {
	Configured     bool       `json:"configured"`
	Host           string     `json:"host"`
	Port           int        `json:"port"`
	Username       string     `json:"username"`
	Folder         string     `json:"folder"`
	SenderFilter   string     `json:"senderFilter"`
	StartDate      string     `json:"startDate"`
	AutoSync       bool       `json:"autoSync"`
	Syncing        bool       `json:"syncing"`
	LastSyncedAt   *time.Time `json:"lastSyncedAt"`
	LastError      string     `json:"lastError"`
	LastMessages   int        `json:"lastMessages"`
	LastRecognized int        `json:"lastRecognized"`
	LastAdded      int        `json:"lastAdded"`
	Issuers        []string   `json:"issuers"` // banks whose alert format is supported
}

type MailStateResult struct {
	Data  *MailState       `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

// SyncEvent is the payload of EventSyncDone, emitted after every sync.
type SyncEvent struct {
	UserID  int64        `json:"userId"`
	Summary *SyncSummary `json:"summary,omitempty"`
	Error   string       `json:"error,omitempty"`
}
