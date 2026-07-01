-- Soft delete de perfiles: eliminar un usuario lo marca deleted_at en vez de
-- borrarlo, para poder restaurarlo desde la papelera.
ALTER TABLE users ADD COLUMN deleted_at TIMESTAMP;

--bun:split
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);
