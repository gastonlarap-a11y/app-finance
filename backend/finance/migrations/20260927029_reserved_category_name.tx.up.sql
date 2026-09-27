-- «Sin categoría» agrupa los gastos sin categoría: una categoría real con ese
-- nombre se sumaría junto a ellos. Se renombra (con sus gastos y gastos fijos,
-- que guardan la categoría como texto) y desde ahora el nombre está reservado.
UPDATE expenses SET category = 'Sin categoría (propia)'
WHERE lower(category) = lower('Sin categoría')
  AND user_id IN (SELECT user_id FROM categories WHERE lower(name) = lower('Sin categoría'));

--bun:split
UPDATE fixed_expenses SET category = 'Sin categoría (propia)'
WHERE lower(category) = lower('Sin categoría')
  AND user_id IN (SELECT user_id FROM categories WHERE lower(name) = lower('Sin categoría'));

--bun:split
UPDATE categories SET name = 'Sin categoría (propia)' WHERE lower(name) = lower('Sin categoría');
