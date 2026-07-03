ALTER TABLE expenses DROP COLUMN merchant;

--bun:split
DROP INDEX IF EXISTS idx_merchants_deleted_at;

--bun:split
DROP INDEX IF EXISTS idx_merchants_user;

--bun:split
DROP INDEX IF EXISTS idx_merchants_name;

--bun:split
DROP TABLE IF EXISTS merchants;
