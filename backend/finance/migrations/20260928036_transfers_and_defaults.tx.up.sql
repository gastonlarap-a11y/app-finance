-- Transferencias entre cuentas propias (el sueldo que cae en una cuenta y se
-- pasa a otra, la carga de una cuenta digital): mueven plata de una cuenta a
-- otra sin ser gasto ni ingreso, así que no tocan el saldo total de la app, solo
-- el de cada cuenta. start_period = end_period: una sola vez; end_period = '':
-- todos los meses desde start_period. Borrar una cuenta borra sus transferencias.
CREATE TABLE IF NOT EXISTS transfers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER   NOT NULL,
    from_account_id INTEGER   NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    to_account_id   INTEGER   NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    description     TEXT      NOT NULL DEFAULT '',
    amount          TEXT      NOT NULL,
    start_period    TEXT      NOT NULL,
    end_period      TEXT      NOT NULL DEFAULT '',
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (from_account_id <> to_account_id)
);

--bun:split
CREATE INDEX IF NOT EXISTS idx_transfers_user ON transfers(user_id);

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_transfers_ins AFTER INSERT ON transfers BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_transfers_upd AFTER UPDATE ON transfers BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_transfers_del AFTER DELETE ON transfers BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
-- Un gasto fijo que no se paga con tarjeta (el dividendo por PAC) sale de una cuenta.
ALTER TABLE fixed_expenses ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;

--bun:split
-- Categoría habitual de un comercio (Apple → Tecnología): la propone al elegirlo
-- en un gasto y al importar un movimiento suyo. '' = sin categoría habitual.
ALTER TABLE merchants ADD COLUMN category TEXT NOT NULL DEFAULT '';
