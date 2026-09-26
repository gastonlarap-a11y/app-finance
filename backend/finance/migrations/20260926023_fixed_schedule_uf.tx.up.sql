-- Gastos fijos no mensuales y en UF.
-- interval_months: cada cuántos meses se cobra, contando desde start_period
-- (1 mensual, 3 trimestral, 6 semestral, 12 anual…). Se fija al crear el gasto:
-- cambiarlo movería los cobros ya registrados.
ALTER TABLE fixed_expenses ADD COLUMN interval_months INTEGER NOT NULL DEFAULT 1;

--bun:split
-- currency: moneda de sus montos (fixed_expense_amounts). 'UF' se convierte a
-- pesos con el valor de la UF del mes (uf_values).
ALTER TABLE fixed_expenses ADD COLUMN currency TEXT NOT NULL DEFAULT 'CLP';

--bun:split
-- Valor en pesos de la Unidad de Fomento el día 1 de cada mes. Dato público
-- (no pertenece a un perfil): lo descarga la app desde mindicador.cl.
CREATE TABLE IF NOT EXISTS uf_values (
    period     TEXT PRIMARY KEY,                    -- YYYY-MM
    value      TEXT      NOT NULL,                  -- pesos por UF (con decimales)
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
