-- Por cobrar: la parte de un gasto que otra persona te debe (una cuenta
-- dividida, algo que pagaste por otro). Al cobrarla se registra como reembolso
-- del gasto en el mes en que llega, así tu gasto neto queda en tu parte; borrar
-- ese reembolso la deja pendiente de nuevo (refund_id vuelve a NULL). Sin soft
-- delete propio: viaja con su gasto a la Papelera.
CREATE TABLE IF NOT EXISTS receivables (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER   NOT NULL,
    expense_id INTEGER   NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    person     TEXT      NOT NULL,
    amount     TEXT      NOT NULL DEFAULT '0',   -- positivo
    refund_id  INTEGER   REFERENCES refunds(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
CREATE INDEX IF NOT EXISTS idx_receivables_user ON receivables(user_id);

--bun:split
CREATE INDEX IF NOT EXISTS idx_receivables_expense ON receivables(expense_id);

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_receivables_ins AFTER INSERT ON receivables BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_receivables_upd AFTER UPDATE ON receivables BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_receivables_del AFTER DELETE ON receivables BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;
