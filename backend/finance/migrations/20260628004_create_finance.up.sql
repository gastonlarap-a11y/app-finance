CREATE TABLE IF NOT EXISTS settings (
    id                  INTEGER PRIMARY KEY,
    base_salary         TEXT    NOT NULL DEFAULT '0',
    default_billing_day INTEGER NOT NULL DEFAULT 24
);

--bun:split
INSERT INTO settings (id, base_salary, default_billing_day)
VALUES (1, '0', 24)
ON CONFLICT(id) DO NOTHING;

--bun:split
CREATE TABLE IF NOT EXISTS cards (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT      NOT NULL,
    credit_limit TEXT      NOT NULL DEFAULT '0',
    billing_day  INTEGER   NOT NULL DEFAULT 24,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
CREATE TABLE IF NOT EXISTS incomes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    period      TEXT      NOT NULL,
    description TEXT      NOT NULL,
    amount      TEXT      NOT NULL DEFAULT '0',
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
CREATE INDEX IF NOT EXISTS idx_incomes_period ON incomes(period);

--bun:split
CREATE TABLE IF NOT EXISTS expenses (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    date               TIMESTAMP NOT NULL,
    description        TEXT      NOT NULL,
    category           TEXT      NOT NULL DEFAULT '',
    card_id            INTEGER   REFERENCES cards(id) ON DELETE SET NULL,
    kind               TEXT      NOT NULL DEFAULT 'unico',
    installment_amount TEXT      NOT NULL DEFAULT '0',
    installments_total INTEGER   NOT NULL DEFAULT 1,
    created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
CREATE TABLE IF NOT EXISTS installments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_id INTEGER   NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    number     INTEGER   NOT NULL,
    total      INTEGER   NOT NULL,
    period     TEXT      NOT NULL,
    amount     TEXT      NOT NULL DEFAULT '0',
    status     TEXT      NOT NULL DEFAULT 'pendiente',
    paid_at    TIMESTAMP
);

--bun:split
CREATE INDEX IF NOT EXISTS idx_installments_period ON installments(period);

--bun:split
CREATE INDEX IF NOT EXISTS idx_installments_expense ON installments(expense_id);
