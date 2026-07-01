-- Revertir multi-usuario. Vuelve categorías a unicidad global y period_salaries a
-- PK por period, y quita las columnas user_id.
DROP INDEX IF EXISTS idx_categories_name;

--bun:split
CREATE UNIQUE INDEX idx_categories_name ON categories(name);

--bun:split
CREATE TABLE period_salaries_old (
    period TEXT PRIMARY KEY,
    amount TEXT NOT NULL DEFAULT '0'
);

--bun:split
INSERT OR IGNORE INTO period_salaries_old (period, amount)
    SELECT period, amount FROM period_salaries WHERE user_id = 1;

--bun:split
DROP TABLE period_salaries;

--bun:split
ALTER TABLE period_salaries_old RENAME TO period_salaries;

--bun:split
DROP INDEX IF EXISTS idx_fixed_expenses_user;

--bun:split
DROP INDEX IF EXISTS idx_installments_user;

--bun:split
DROP INDEX IF EXISTS idx_expenses_user;

--bun:split
DROP INDEX IF EXISTS idx_incomes_user;

--bun:split
DROP INDEX IF EXISTS idx_cards_user;

--bun:split
ALTER TABLE fixed_expenses DROP COLUMN user_id;

--bun:split
ALTER TABLE categories DROP COLUMN user_id;

--bun:split
ALTER TABLE installments DROP COLUMN user_id;

--bun:split
ALTER TABLE expenses DROP COLUMN user_id;

--bun:split
ALTER TABLE incomes DROP COLUMN user_id;

--bun:split
ALTER TABLE cards DROP COLUMN user_id;

--bun:split
DROP TABLE IF EXISTS users;
