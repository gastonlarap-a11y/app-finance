-- Multi-usuario: una sola base de datos, cada fila pertenece a un usuario.
-- Las filas existentes se asignan al usuario 1 ("Gastón") vía DEFAULT 1.
CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT      NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
INSERT INTO users (id, name) VALUES (1, 'Gastón')
ON CONFLICT(id) DO NOTHING;

--bun:split
ALTER TABLE cards ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;

--bun:split
ALTER TABLE incomes ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;

--bun:split
ALTER TABLE expenses ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;

--bun:split
ALTER TABLE installments ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;

--bun:split
ALTER TABLE categories ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;

--bun:split
ALTER TABLE fixed_expenses ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;

--bun:split
CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(user_id);

--bun:split
CREATE INDEX IF NOT EXISTS idx_incomes_user ON incomes(user_id);

--bun:split
CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses(user_id);

--bun:split
CREATE INDEX IF NOT EXISTS idx_installments_user ON installments(user_id);

--bun:split
CREATE INDEX IF NOT EXISTS idx_fixed_expenses_user ON fixed_expenses(user_id);

--bun:split
-- period_salaries tiene `period` como PRIMARY KEY; para hacerla por-usuario hay que
-- reconstruir la tabla con PK compuesta (user_id, period).
CREATE TABLE period_salaries_new (
    user_id INTEGER NOT NULL DEFAULT 1,
    period  TEXT    NOT NULL,
    amount  TEXT    NOT NULL DEFAULT '0',
    PRIMARY KEY (user_id, period)
);

--bun:split
INSERT INTO period_salaries_new (user_id, period, amount)
    SELECT 1, period, amount FROM period_salaries;

--bun:split
DROP TABLE period_salaries;

--bun:split
ALTER TABLE period_salaries_new RENAME TO period_salaries;

--bun:split
-- La unicidad de categorías pasa a ser por usuario.
DROP INDEX IF EXISTS idx_categories_name;

--bun:split
CREATE UNIQUE INDEX idx_categories_name ON categories(user_id, name);
