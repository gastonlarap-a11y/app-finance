-- Metas de ahorro. Soft delete (Papelera) como el resto de entidades del usuario.
CREATE TABLE IF NOT EXISTS savings_goals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER   NOT NULL,
    name          TEXT      NOT NULL,
    target_amount TEXT      NOT NULL DEFAULT '0',
    target_period TEXT      NOT NULL DEFAULT '',  -- YYYY-MM de la fecha objetivo; '' = sin fecha
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at    TIMESTAMP
);

--bun:split
CREATE INDEX IF NOT EXISTS idx_savings_goals_user ON savings_goals(user_id, deleted_at);

--bun:split
-- Aportes a una meta. Cuentan como salida del mes (bajan el disponible y el
-- arrastre) pero se muestran aparte de los gastos. Sin soft delete propio:
-- viajan con su meta a la Papelera.
CREATE TABLE IF NOT EXISTS savings_contributions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER   NOT NULL,
    goal_id    INTEGER   NOT NULL REFERENCES savings_goals(id) ON DELETE CASCADE,
    period     TEXT      NOT NULL,                 -- YYYY-MM
    amount     TEXT      NOT NULL DEFAULT '0',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
CREATE INDEX IF NOT EXISTS idx_savings_contributions_user_period ON savings_contributions(user_id, period);
