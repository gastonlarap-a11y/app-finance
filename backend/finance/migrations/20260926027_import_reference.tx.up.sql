-- Código de referencia de cada movimiento de la bandeja, tal como lo imprime el
-- banco: es lo que se cita al reclamar un cargo. Antes sólo vivía dentro de la
-- clave de deduplicación.
ALTER TABLE import_items ADD COLUMN reference TEXT NOT NULL DEFAULT '';

--bun:split
-- Los ítems que vinieron de un estado de cuenta toman la referencia de su línea.
UPDATE import_items
SET reference = COALESCE((SELECT l.reference FROM card_statement_lines l WHERE l.id = import_items.statement_line_id), '')
WHERE statement_line_id IS NOT NULL;

--bun:split
-- Una compra en cuotas reaparece en cada estado de cuenta: se busca por fecha.
CREATE INDEX IF NOT EXISTS idx_card_statement_lines_user_date ON card_statement_lines(user_id, operation_date);
