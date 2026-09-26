-- Conciliación: el saldo real de la cuenta al cierre de un mes, tal como lo
-- muestra el banco. Desde ese cierre el saldo arrastrado parte de este monto
-- (no de la suma de toda la historia), y la diferencia con lo calculado se
-- muestra en el mes. El "saldo inicial" es un cierre en el mes anterior al
-- primero registrado. Uno por mes y perfil; el monto puede ser negativo.
CREATE TABLE IF NOT EXISTS reconciliations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER   NOT NULL,
    period     TEXT      NOT NULL,                 -- YYYY-MM del cierre
    amount     TEXT      NOT NULL DEFAULT '0',     -- saldo real al cierre (puede ser negativo)
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--bun:split
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliations_user_period ON reconciliations(user_id, period);
