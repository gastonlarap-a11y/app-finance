-- Un cargo del banco puede ser la cuota mensual de un gasto fijo (Netflix,
-- Entel, un seguro). Enlazarlo marca ese mes del gasto fijo como pagado en vez
-- de crear un gasto duplicado; el ítem recuerda a qué gasto fijo y mes se
-- enlazó.
ALTER TABLE import_items ADD COLUMN fixed_expense_id INTEGER REFERENCES fixed_expenses(id) ON DELETE SET NULL;

--bun:split
ALTER TABLE import_items ADD COLUMN fixed_period TEXT NOT NULL DEFAULT '';   -- YYYY-MM marcado como pagado
