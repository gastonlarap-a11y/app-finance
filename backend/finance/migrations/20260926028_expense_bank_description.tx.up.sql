-- Descripción del banco de un gasto ingresado a mano y luego unido con su
-- movimiento del banco: la del usuario se conserva y ésta se muestra aparte.
ALTER TABLE expenses ADD COLUMN bank_description TEXT NOT NULL DEFAULT '';
