-- Un cargo o abono de la cartola puede ser una transferencia entre cuentas
-- propias (la carga de Mercado Pago, el ahorro del mes): enlazado a esa
-- transferencia y a su mes, queda confirmado sin contar como gasto ni ingreso,
-- como las dos patas de una transferencia en Actual Budget. Borrar la
-- transferencia deja el movimiento listo para volver a revisarlo.
ALTER TABLE import_items ADD COLUMN transfer_id INTEGER REFERENCES transfers(id) ON DELETE SET NULL;

--bun:split
ALTER TABLE import_items ADD COLUMN transfer_period TEXT NOT NULL DEFAULT '';
