-- Estados de cuenta de tarjeta de crédito, completos. Un registro por
-- (usuario, tarjeta, tipo nacional/internacional, fecha del estado): reimportar
-- el mismo PDF no duplica. Montos como TEXT decimal (pueden ser negativos:
-- pagos y abonos); tasas como TEXT decimal en porcentaje ("2.56" = 2,56%).
CREATE TABLE IF NOT EXISTS card_statements (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                INTEGER   NOT NULL,
    card_id                INTEGER   REFERENCES cards(id) ON DELETE SET NULL,
    issuer                 TEXT      NOT NULL,
    kind                   TEXT      NOT NULL,                  -- nacional | internacional
    currency               TEXT      NOT NULL,                  -- CLP | USD
    card_last_digits       TEXT      NOT NULL,
    statement_date         TEXT      NOT NULL,                  -- YYYY-MM-DD (fecha estado de cuenta)
    period                 TEXT      NOT NULL,                  -- YYYY-MM facturado (mes de period_to)
    period_from            TEXT      NOT NULL DEFAULT '',
    period_to              TEXT      NOT NULL DEFAULT '',
    due_date               TEXT      NOT NULL DEFAULT '',       -- pagar hasta
    previous_period_from   TEXT      NOT NULL DEFAULT '',
    previous_period_to     TEXT      NOT NULL DEFAULT '',
    next_period_from       TEXT      NOT NULL DEFAULT '',
    next_period_to         TEXT      NOT NULL DEFAULT '',
    credit_limit           TEXT      NOT NULL DEFAULT '0',      -- cupo total
    credit_used            TEXT      NOT NULL DEFAULT '0',
    credit_available       TEXT      NOT NULL DEFAULT '0',
    cash_limit             TEXT      NOT NULL DEFAULT '0',      -- cupo avance en efectivo
    cash_used              TEXT      NOT NULL DEFAULT '0',
    cash_available         TEXT      NOT NULL DEFAULT '0',
    previous_balance_start TEXT      NOT NULL DEFAULT '0',      -- saldo adeudado inicio período anterior
    previous_billed        TEXT      NOT NULL DEFAULT '0',      -- (A) facturado período anterior / saldo anterior
    previous_paid          TEXT      NOT NULL DEFAULT '0',      -- pagado período anterior / abono realizado
    previous_balance_end   TEXT      NOT NULL DEFAULT '0',
    transfer_from_national TEXT      NOT NULL DEFAULT '0',      -- internacional: traspaso deuda nacional
    total_operations       TEXT      NOT NULL DEFAULT '0',      -- (B)
    voluntary_products     TEXT      NOT NULL DEFAULT '0',      -- (C)
    charges_net            TEXT      NOT NULL DEFAULT '0',      -- (D) cargos, comisiones, impuestos y abonos
    total_billed           TEXT      NOT NULL DEFAULT '0',      -- monto total facturado a pagar / deuda total
    minimum_payment        TEXT      NOT NULL DEFAULT '0',
    prepayment_cost        TEXT      NOT NULL DEFAULT '0',      -- costo monetario prepago
    automatic_charge       TEXT      NOT NULL DEFAULT '0',
    unbilled_balance       TEXT      NOT NULL DEFAULT '0',      -- deuda aún no facturada («ACTUAL»)
    rate_revolving         TEXT      NOT NULL DEFAULT '',
    rate_installments      TEXT      NOT NULL DEFAULT '',
    rate_cash_advance      TEXT      NOT NULL DEFAULT '',
    cae_revolving          TEXT      NOT NULL DEFAULT '',
    cae_installments       TEXT      NOT NULL DEFAULT '',
    cae_cash_advance       TEXT      NOT NULL DEFAULT '',
    cae_prepayment         TEXT      NOT NULL DEFAULT '',
    late_interest_rate     TEXT      NOT NULL DEFAULT '',       -- interés moratorio
    fx_rate                TEXT      NOT NULL DEFAULT '',       -- CLP por USD implícito del pago internacional
    file_hash              TEXT      NOT NULL DEFAULT '',
    imported_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
CREATE UNIQUE INDEX IF NOT EXISTS idx_card_statements_key
    ON card_statements(user_id, card_last_digits, kind, statement_date);

--bun:split
CREATE INDEX IF NOT EXISTS idx_card_statements_period ON card_statements(user_id, period);

--bun:split
-- Cada movimiento del estado, tal como viene: pagos, compras (con su cuota
-- n/N), productos voluntarios, cargos y abonos.
CREATE TABLE IF NOT EXISTS card_statement_lines (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL,
    statement_id       INTEGER NOT NULL REFERENCES card_statements(id) ON DELETE CASCADE,
    position           INTEGER NOT NULL,                        -- orden en el PDF
    section            TEXT    NOT NULL,                        -- pago | compra | voluntario | cargo | abono
    place              TEXT    NOT NULL DEFAULT '',             -- lugar de operación
    city               TEXT    NOT NULL DEFAULT '',
    country            TEXT    NOT NULL DEFAULT '',
    operation_date     TEXT    NOT NULL,                        -- YYYY-MM-DD
    reference          TEXT    NOT NULL DEFAULT '',
    description        TEXT    NOT NULL,
    interest_rate      TEXT    NOT NULL DEFAULT '',             -- «TASA INT. x%» de la compra
    operation_amount   TEXT    NOT NULL DEFAULT '0',            -- monto operación o cobro
    total_amount       TEXT    NOT NULL DEFAULT '0',            -- monto total a pagar
    installment_number INTEGER NOT NULL DEFAULT 1,
    installments_total INTEGER NOT NULL DEFAULT 1,
    installment_amount TEXT    NOT NULL DEFAULT '0',            -- cargo del mes (valor cuota) / monto US$
    origin_amount      TEXT    NOT NULL DEFAULT '',             -- internacional: monto moneda origen
    import_item_id     INTEGER REFERENCES import_items(id) ON DELETE SET NULL,
    installment_id     INTEGER REFERENCES installments(id) ON DELETE SET NULL
);

--bun:split
CREATE INDEX IF NOT EXISTS idx_card_statement_lines_statement ON card_statement_lines(statement_id, position);

--bun:split
-- Vencimientos que el banco proyecta para los próximos meses.
CREATE TABLE IF NOT EXISTS card_statement_schedule (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_id INTEGER NOT NULL REFERENCES card_statements(id) ON DELETE CASCADE,
    period       TEXT    NOT NULL,                              -- YYYY-MM
    amount       TEXT    NOT NULL DEFAULT '0'
);

--bun:split
CREATE INDEX IF NOT EXISTS idx_card_statement_schedule_statement ON card_statement_schedule(statement_id);

--bun:split
-- La bandeja conoce la línea de estado de cuenta de la que viene cada ítem y
-- lo necesario para crear el gasto con sus cuotas exactas o un ingreso extra.
ALTER TABLE import_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'gasto';        -- gasto | abono

--bun:split
ALTER TABLE import_items ADD COLUMN statement_line_id INTEGER REFERENCES card_statement_lines(id) ON DELETE SET NULL;

--bun:split
ALTER TABLE import_items ADD COLUMN installment_number INTEGER NOT NULL DEFAULT 1;

--bun:split
ALTER TABLE import_items ADD COLUMN installment_amount TEXT NOT NULL DEFAULT '';   -- valor cuota exacto del banco

--bun:split
ALTER TABLE import_items ADD COLUMN first_period TEXT NOT NULL DEFAULT '';          -- YYYY-MM de la cuota 1

--bun:split
ALTER TABLE import_items ADD COLUMN income_id INTEGER REFERENCES incomes(id) ON DELETE SET NULL;
