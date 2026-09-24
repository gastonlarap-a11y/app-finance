package mailsync

import (
	"strconv"
	"time"

	"github.com/uptrace/bun"
)

// MailAccount is the IMAP mailbox a profile reads its bank alerts from (one
// per profile). UIDValidity + LastUID are the incremental-sync watermark: the
// next sync asks the server only for messages above LastUID in Folder, unless
// the server reset its UIDs (UIDValidity changed). The password is not here —
// it lives in the OS keychain (see SecretStore).
type MailAccount struct {
	bun.BaseModel `bun:"table:mail_accounts,alias:ma"`

	ID             int64      `bun:"id,pk,autoincrement"`
	UserID         int64      `bun:"user_id,notnull"`
	Host           string     `bun:"host,notnull"`
	Port           int        `bun:"port,notnull"`
	Username       string     `bun:"username,notnull"`
	Folder         string     `bun:"folder,notnull"`
	SenderFilter   string     `bun:"sender_filter,notnull"`
	StartDate      string     `bun:"start_date,notnull"` // YYYY-MM-DD
	AutoSync       bool       `bun:"auto_sync,notnull"`
	UIDValidity    uint32     `bun:"uid_validity,notnull"`
	LastUID        uint32     `bun:"last_uid,notnull"`
	LastSyncedAt   *time.Time `bun:"last_synced_at"`
	LastError      string     `bun:"last_error,notnull"`
	LastMessages   int        `bun:"last_messages,notnull"`
	LastRecognized int        `bun:"last_recognized,notnull"`
	LastAdded      int        `bun:"last_added,notnull"`
	CreatedAt      time.Time  `bun:"created_at,notnull,default:current_timestamp"`
}

// secretKey names the account's password in the keychain.
func (a *MailAccount) secretKey() string { return "mail-account-" + strconv.FormatInt(a.ID, 10) }
