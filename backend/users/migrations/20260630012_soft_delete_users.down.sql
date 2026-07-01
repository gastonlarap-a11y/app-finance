DROP INDEX IF EXISTS idx_users_deleted_at;

--bun:split
ALTER TABLE users DROP COLUMN deleted_at;
