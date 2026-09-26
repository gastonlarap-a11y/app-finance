-- Reembolsos: plata devuelta por un gasto concreto (devolución en tienda,
-- reverso del banco), parcial o total. Rebaja los gastos del mes en que llega,
-- en la categoría (y tarjeta) del gasto, así el presupuesto y el saldo quedan
-- netos. Sin soft delete propio: viajan con su gasto a la Papelera.
CREATE TABLE IF NOT EXISTS refunds (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER   NOT NULL,
    expense_id  INTEGER   NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    period      TEXT      NOT NULL,                 -- YYYY-MM en que llegó
    amount      TEXT      NOT NULL DEFAULT '0',     -- positivo
    description TEXT      NOT NULL DEFAULT '',
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
CREATE INDEX IF NOT EXISTS idx_refunds_user_period ON refunds(user_id, period);

--bun:split
CREATE INDEX IF NOT EXISTS idx_refunds_expense ON refunds(expense_id);

--bun:split
-- Un abono del banco confirmado como reembolso de un gasto.
ALTER TABLE import_items ADD COLUMN refund_id INTEGER REFERENCES refunds(id) ON DELETE SET NULL;
