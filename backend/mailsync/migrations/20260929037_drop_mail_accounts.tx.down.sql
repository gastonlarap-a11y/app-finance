CREATE TABLE IF NOT EXISTS mail_accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER   NOT NULL,
    host            TEXT      NOT NULL,
    port            INTEGER   NOT NULL DEFAULT 993,
    username        TEXT      NOT NULL,
    folder          TEXT      NOT NULL DEFAULT 'INBOX',
    sender_filter   TEXT      NOT NULL DEFAULT '',
    start_date      TEXT      NOT NULL,
    auto_sync       INTEGER   NOT NULL DEFAULT 1,
    uid_validity    INTEGER   NOT NULL DEFAULT 0,
    last_uid        INTEGER   NOT NULL DEFAULT 0,
    last_synced_at  TIMESTAMP,
    last_error      TEXT      NOT NULL DEFAULT '',
    last_messages   INTEGER   NOT NULL DEFAULT 0,
    last_recognized INTEGER   NOT NULL DEFAULT 0,
    last_added      INTEGER   NOT NULL DEFAULT 0,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_accounts_user ON mail_accounts(user_id);
