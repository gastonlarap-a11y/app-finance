-- Una transferencia puede seguir al sueldo: con mode = 'salary_rest' pasa cada
-- mes el sueldo de ese mes menos `amount`, que se queda en la cuenta de origen
-- (el dividendo que se paga desde la cuenta donde cae el sueldo). 'fixed' mueve
-- `amount` tal cual, como hasta ahora.
ALTER TABLE transfers ADD COLUMN mode TEXT NOT NULL DEFAULT 'fixed';

--bun:split
-- Saldo real de una cuenta al cierre de un mes, como lo muestra su banco. Desde
-- el mes siguiente el saldo de la cuenta parte de aquí en vez de sumar todo
-- desde la apertura. Es una vista: no cambia el resumen del mes. Una por cuenta
-- y mes; puede ser negativo (sobregiro). Borrar la cuenta borra sus conciliaciones.
CREATE TABLE IF NOT EXISTS account_reconciliations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER   NOT NULL,
    account_id INTEGER   NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    period     TEXT      NOT NULL,
    balance    TEXT      NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (account_id, period)
);

--bun:split
CREATE INDEX IF NOT EXISTS idx_account_reconciliations_user ON account_reconciliations(user_id);

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_account_reconciliations_ins AFTER INSERT ON account_reconciliations BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_account_reconciliations_upd AFTER UPDATE ON account_reconciliations BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_account_reconciliations_del AFTER DELETE ON account_reconciliations BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;
