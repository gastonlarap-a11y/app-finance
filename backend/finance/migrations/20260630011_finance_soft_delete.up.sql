-- Soft delete: en vez de borrar filas, se marca deleted_at y se filtran las listas.
-- Habilita la papelera (ver vista "Papelera") con opción de restaurar.
ALTER TABLE cards ADD COLUMN deleted_at TIMESTAMP;

--bun:split
ALTER TABLE categories ADD COLUMN deleted_at TIMESTAMP;

--bun:split
ALTER TABLE incomes ADD COLUMN deleted_at TIMESTAMP;

--bun:split
ALTER TABLE expenses ADD COLUMN deleted_at TIMESTAMP;

--bun:split
ALTER TABLE fixed_expenses ADD COLUMN deleted_at TIMESTAMP;

--bun:split
-- Unicidad de categorías sólo entre las activas: una eliminada no bloquea reusar
-- su nombre, y restaurarla no choca con una activa que reutilizó el nombre.
DROP INDEX IF EXISTS idx_categories_name;

--bun:split
CREATE UNIQUE INDEX idx_categories_name ON categories(user_id, name) WHERE deleted_at IS NULL;

--bun:split
CREATE INDEX IF NOT EXISTS idx_cards_deleted_at ON cards(user_id, deleted_at);

--bun:split
CREATE INDEX IF NOT EXISTS idx_categories_deleted_at ON categories(user_id, deleted_at);

--bun:split
CREATE INDEX IF NOT EXISTS idx_incomes_deleted_at ON incomes(user_id, deleted_at);

--bun:split
CREATE INDEX IF NOT EXISTS idx_expenses_deleted_at ON expenses(user_id, deleted_at);

--bun:split
CREATE INDEX IF NOT EXISTS idx_fixed_expenses_deleted_at ON fixed_expenses(user_id, deleted_at);
