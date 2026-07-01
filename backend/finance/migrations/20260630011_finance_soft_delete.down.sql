-- Revertir soft delete: vuelve la unicidad de categorías a (user_id, name) sin
-- partial index, quita los índices de deleted_at y las columnas.
DROP INDEX IF EXISTS idx_fixed_expenses_deleted_at;

--bun:split
DROP INDEX IF EXISTS idx_expenses_deleted_at;

--bun:split
DROP INDEX IF EXISTS idx_incomes_deleted_at;

--bun:split
DROP INDEX IF EXISTS idx_categories_deleted_at;

--bun:split
DROP INDEX IF EXISTS idx_cards_deleted_at;

--bun:split
DROP INDEX IF EXISTS idx_categories_name;

--bun:split
CREATE UNIQUE INDEX idx_categories_name ON categories(user_id, name);

--bun:split
ALTER TABLE fixed_expenses DROP COLUMN deleted_at;

--bun:split
ALTER TABLE expenses DROP COLUMN deleted_at;

--bun:split
ALTER TABLE incomes DROP COLUMN deleted_at;

--bun:split
ALTER TABLE categories DROP COLUMN deleted_at;

--bun:split
ALTER TABLE cards DROP COLUMN deleted_at;
