CREATE TABLE IF NOT EXISTS fixed_expenses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    description  TEXT      NOT NULL,
    category     TEXT      NOT NULL DEFAULT '',
    card_id      INTEGER   REFERENCES cards(id) ON DELETE SET NULL,
    start_period TEXT      NOT NULL,           -- YYYY-MM: primer mes cobrado
    end_period   TEXT,                         -- YYYY-MM: último mes cobrado (NULL = activo)
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
-- Monto vigente desde effective_from en adelante. El monto de un mes M se resuelve
-- tomando la fila con el effective_from más reciente que sea <= M, de modo que editar
-- "de este mes en adelante" no toca los meses anteriores.
CREATE TABLE IF NOT EXISTS fixed_expense_amounts (
    fixed_expense_id INTEGER NOT NULL REFERENCES fixed_expenses(id) ON DELETE CASCADE,
    effective_from   TEXT    NOT NULL,         -- YYYY-MM
    amount           TEXT    NOT NULL DEFAULT '0',
    PRIMARY KEY (fixed_expense_id, effective_from)
);

--bun:split
-- Marca de pago por mes (sparse): si existe la fila el cargo está pagado, si no, pendiente.
CREATE TABLE IF NOT EXISTS fixed_expense_payments (
    fixed_expense_id INTEGER NOT NULL REFERENCES fixed_expenses(id) ON DELETE CASCADE,
    period           TEXT    NOT NULL,         -- YYYY-MM
    paid_at          TIMESTAMP,
    PRIMARY KEY (fixed_expense_id, period)
);
