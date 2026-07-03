CREATE TABLE IF NOT EXISTS merchants (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER   NOT NULL,
    name       TEXT      NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

--bun:split
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_name ON merchants(user_id, name) WHERE deleted_at IS NULL;

--bun:split
CREATE INDEX IF NOT EXISTS idx_merchants_user ON merchants(user_id);

--bun:split
CREATE INDEX IF NOT EXISTS idx_merchants_deleted_at ON merchants(user_id, deleted_at);

--bun:split
ALTER TABLE expenses ADD COLUMN merchant TEXT NOT NULL DEFAULT '';
