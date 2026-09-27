-- Día del mes en que vence un gasto fijo (arriendo, dividendo…), para avisar
-- antes de que venza. NULL = sin recordatorio. Un día mayor que el largo del
-- mes vence el último día (31 → 30 de abril).
ALTER TABLE fixed_expenses ADD COLUMN due_day INTEGER CHECK (due_day BETWEEN 1 AND 31);
