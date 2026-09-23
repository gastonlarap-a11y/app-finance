-- Presupuesto mensual por categoría, con vigencia desde effective_from en adelante
-- (mismo patrón que fixed_expense_amounts): cambiar el tope "de este mes en
-- adelante" no reescribe meses anteriores. amount = '0' significa "sin tope".
-- Sin deleted_at propio: las filas viajan con su categoría a la Papelera y vuelven
-- al restaurarla.
CREATE TABLE IF NOT EXISTS category_budgets (
    user_id        INTEGER NOT NULL,
    category_id    INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    effective_from TEXT    NOT NULL,         -- YYYY-MM
    amount         TEXT    NOT NULL DEFAULT '0',
    PRIMARY KEY (category_id, effective_from)
);

--bun:split
CREATE INDEX IF NOT EXISTS idx_category_budgets_user ON category_budgets(user_id);
