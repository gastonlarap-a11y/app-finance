-- «Sin tope» y «tope $0» (no gastar nada en la categoría) dejan de ser lo
-- mismo: capped = 0 es sin tope; las filas con monto 0 que existían significaban
-- eso, así que se marcan así y nada cambia para el usuario.
ALTER TABLE category_budgets ADD COLUMN capped INTEGER NOT NULL DEFAULT 1;

--bun:split
UPDATE category_budgets SET capped = 0 WHERE CAST(amount AS REAL) = 0;

--bun:split
-- Traspaso de presupuesto: lo no gastado de un mes se suma al tope del siguiente.
ALTER TABLE categories ADD COLUMN rollover INTEGER NOT NULL DEFAULT 0;
