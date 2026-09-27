-- Gastos en otra moneda: el gasto sigue en pesos para todos los totales
-- (installment_amount), y además guarda la moneda, el monto original (total)
-- y la tasa usada (pesos por unidad). CLP = gasto en pesos, sin conversión.
ALTER TABLE expenses ADD COLUMN currency TEXT NOT NULL DEFAULT 'CLP';

--bun:split
ALTER TABLE expenses ADD COLUMN original_amount TEXT NOT NULL DEFAULT '';

--bun:split
ALTER TABLE expenses ADD COLUMN fx_rate TEXT NOT NULL DEFAULT '';
