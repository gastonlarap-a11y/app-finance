-- Índices compuestos para las consultas de cada resumen: la igualdad primero
-- (user_id) y luego el rango o el segundo filtro, como pide el planificador de
-- SQLite. Sin ellos cada consulta usaba sólo user_id y recorría el resto.

-- Resumen del mes, saldo arrastrado, proyección: installments por mes.
CREATE INDEX IF NOT EXISTS idx_installments_user_period ON installments(user_id, period);

--bun:split
-- Cupo usado por tarjeta: cuotas pendientes.
CREATE INDEX IF NOT EXISTS idx_installments_user_status ON installments(user_id, status);

--bun:split
-- Ingresos por mes (resumen y saldo arrastrado).
CREATE INDEX IF NOT EXISTS idx_incomes_user_period ON incomes(user_id, period);

--bun:split
-- Bandeja: gastos cerca de la fecha de un movimiento (posible duplicado).
CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date);

--bun:split
-- "Aún no enlazado": subconsultas NOT IN sobre los vínculos de la bandeja y de
-- las líneas de estado de cuenta.
CREATE INDEX IF NOT EXISTS idx_import_items_user_expense ON import_items(user_id, expense_id);

--bun:split
CREATE INDEX IF NOT EXISTS idx_card_statement_lines_user_installment ON card_statement_lines(user_id, installment_id);
