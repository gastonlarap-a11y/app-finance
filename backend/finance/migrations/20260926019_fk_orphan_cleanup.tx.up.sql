-- Hasta la versión 0.3.2 el escritorio abría SQLite con claves foráneas
-- desactivadas (el DSN usaba parámetros que el driver ignoraba), así que los
-- ON DELETE CASCADE / SET NULL nunca corrieron: borrar un estado de cuenta dejó
-- sus líneas y su calendario, y regenerar las cuotas de un gasto dejó líneas
-- apuntando a cuotas que ya no existen. Esto aplica ahora lo que esas reglas
-- habrían hecho, antes de que empiecen a regir. En una BD sin huérfanos (la web
-- siempre tuvo las claves activas) no cambia nada.

-- ON DELETE CASCADE
DELETE FROM card_statement_lines WHERE statement_id NOT IN (SELECT id FROM card_statements);

--bun:split
DELETE FROM card_statement_schedule WHERE statement_id NOT IN (SELECT id FROM card_statements);

--bun:split
DELETE FROM installments WHERE expense_id NOT IN (SELECT id FROM expenses);

--bun:split
DELETE FROM fixed_expense_amounts WHERE fixed_expense_id NOT IN (SELECT id FROM fixed_expenses);

--bun:split
DELETE FROM fixed_expense_payments WHERE fixed_expense_id NOT IN (SELECT id FROM fixed_expenses);

--bun:split
DELETE FROM category_budgets WHERE category_id NOT IN (SELECT id FROM categories);

--bun:split
DELETE FROM savings_contributions WHERE goal_id NOT IN (SELECT id FROM savings_goals);

-- ON DELETE SET NULL
--bun:split
UPDATE card_statement_lines SET installment_id = NULL
WHERE installment_id IS NOT NULL AND installment_id NOT IN (SELECT id FROM installments);

--bun:split
UPDATE card_statement_lines SET import_item_id = NULL
WHERE import_item_id IS NOT NULL AND import_item_id NOT IN (SELECT id FROM import_items);

--bun:split
UPDATE import_items SET statement_line_id = NULL
WHERE statement_line_id IS NOT NULL AND statement_line_id NOT IN (SELECT id FROM card_statement_lines);

--bun:split
UPDATE import_items SET expense_id = NULL
WHERE expense_id IS NOT NULL AND expense_id NOT IN (SELECT id FROM expenses);

--bun:split
UPDATE import_items SET income_id = NULL
WHERE income_id IS NOT NULL AND income_id NOT IN (SELECT id FROM incomes);

--bun:split
UPDATE import_items SET matched_item_id = NULL
WHERE matched_item_id IS NOT NULL AND matched_item_id NOT IN (SELECT id FROM import_items);

--bun:split
UPDATE expenses SET card_id = NULL
WHERE card_id IS NOT NULL AND card_id NOT IN (SELECT id FROM cards);

--bun:split
UPDATE fixed_expenses SET card_id = NULL
WHERE card_id IS NOT NULL AND card_id NOT IN (SELECT id FROM cards);

--bun:split
UPDATE card_statements SET card_id = NULL
WHERE card_id IS NOT NULL AND card_id NOT IN (SELECT id FROM cards);
