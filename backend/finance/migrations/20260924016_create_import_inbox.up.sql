-- Bandeja de importación: movimientos detectados en correos de alerta y estados
-- de cuenta del banco. Quedan pendientes de revisión y sólo se vuelven gastos
-- cuando el usuario los confirma (o los enlaza a un gasto ya registrado).
CREATE TABLE IF NOT EXISTS import_items (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER   NOT NULL,
    source             TEXT      NOT NULL,                  -- email | pdf_account | pdf_card
    issuer             TEXT      NOT NULL,                  -- emisor (itau)
    external_key       TEXT      NOT NULL,                  -- clave estable: reimportar no duplica
    date               TEXT      NOT NULL,                  -- YYYY-MM-DD de la operación
    description        TEXT      NOT NULL,                  -- glosa tal como la envía el banco
    amount             TEXT      NOT NULL DEFAULT '0',
    currency           TEXT      NOT NULL DEFAULT 'CLP',
    card_last_digits   TEXT      NOT NULL DEFAULT '',
    installments_total INTEGER   NOT NULL DEFAULT 1,
    hint               TEXT      NOT NULL DEFAULT '',       -- card_payment | transfer | ''
    status             TEXT      NOT NULL DEFAULT 'pendiente', -- pendiente | confirmado | descartado | conciliado
    expense_id         INTEGER   REFERENCES expenses(id) ON DELETE SET NULL,
    matched_item_id    INTEGER   REFERENCES import_items(id) ON DELETE SET NULL,
    created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
CREATE UNIQUE INDEX IF NOT EXISTS idx_import_items_key ON import_items(user_id, external_key);

--bun:split
CREATE INDEX IF NOT EXISTS idx_import_items_status ON import_items(user_id, status, date);

--bun:split
-- Reglas aprendidas al confirmar: una glosa que empieza con `pattern`
-- (normalizada) sugiere ese comercio y esa categoría.
CREATE TABLE IF NOT EXISTS merchant_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER   NOT NULL,
    pattern    TEXT      NOT NULL,
    merchant   TEXT      NOT NULL DEFAULT '',
    category   TEXT      NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_rules_pattern ON merchant_rules(user_id, pattern);

--bun:split
-- Últimos 4 dígitos: enlazan "tarjeta terminada en 1234" de un correo o estado
-- de cuenta con la tarjeta registrada.
ALTER TABLE cards ADD COLUMN last_digits TEXT NOT NULL DEFAULT '';
