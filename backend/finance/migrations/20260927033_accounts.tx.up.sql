-- Cuentas (corriente, vista, efectivo, ahorro): de dónde sale y adónde llega la
-- plata. Versión liviana: cada gasto, ingreso o tarjeta puede indicar su
-- cuenta y se ve el saldo por cuenta; el saldo total de la app y su
-- conciliación no cambian. receives_salary: la cuenta donde cae el sueldo.
CREATE TABLE IF NOT EXISTS accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER   NOT NULL,
    name            TEXT      NOT NULL,
    kind            TEXT      NOT NULL DEFAULT 'corriente', -- corriente | vista | efectivo | ahorro | otra
    opening_balance TEXT      NOT NULL DEFAULT '0',
    opening_period  TEXT      NOT NULL,                     -- YYYY-MM desde el que cuenta el saldo
    receives_salary INTEGER   NOT NULL DEFAULT 0,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

--bun:split
ALTER TABLE expenses ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;

--bun:split
ALTER TABLE incomes ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;

--bun:split
ALTER TABLE cards ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_accounts_ins AFTER INSERT ON accounts BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_accounts_upd AFTER UPDATE ON accounts BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_accounts_del AFTER DELETE ON accounts BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;
