-- Personalización: ícono y color por categoría, color por tarjeta e ícono por
-- meta de ahorro. Guardan una clave del catálogo backend/finance/looks.json
-- ('' = automático: la app elige según el nombre o el id). Sin CHECK a
-- propósito: el catálogo puede crecer y SQLite no permite cambiar un CHECK; la
-- clave se valida al escribir y una desconocida se muestra como automática.
ALTER TABLE categories ADD COLUMN icon TEXT NOT NULL DEFAULT '';
--bun:split
ALTER TABLE categories ADD COLUMN color TEXT NOT NULL DEFAULT '';
--bun:split
ALTER TABLE cards ADD COLUMN color TEXT NOT NULL DEFAULT '';
--bun:split
ALTER TABLE savings_goals ADD COLUMN icon TEXT NOT NULL DEFAULT '';
