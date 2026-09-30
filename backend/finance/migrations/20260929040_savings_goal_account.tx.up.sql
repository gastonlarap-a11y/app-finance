-- Una meta de ahorro puede seguir a una cuenta de ahorro real (como las metas
-- vinculadas a cuentas de Monarch y Copilot): lo ahorrado es el saldo de esa
-- cuenta y las transferencias hacia ella son el «Ahorro» de cada mes, en vez de
-- aportes anotados a mano. NULL = meta con aportes a mano. Borrar la cuenta deja
-- la meta sin cuenta.
ALTER TABLE savings_goals ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;

--bun:split
-- Una cuenta respalda como mucho una meta viva.
CREATE UNIQUE INDEX IF NOT EXISTS idx_savings_goals_account ON savings_goals(account_id)
    WHERE account_id IS NOT NULL AND deleted_at IS NULL;
