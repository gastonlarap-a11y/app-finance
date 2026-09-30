-- Sueldo base: el sueldo que se repite cada mes desde effective_from en adelante,
-- hasta la fila siguiente (como los montos de los gastos fijos). Un mes sin
-- sueldo anotado en period_salaries toma el base como «esperado»; el anotado
-- (confirmado) siempre manda. active = 0 termina el sueldo base desde ese mes.
CREATE TABLE IF NOT EXISTS salary_plans (
    user_id        INTEGER NOT NULL,
    effective_from TEXT    NOT NULL, -- YYYY-MM
    amount         TEXT    NOT NULL,
    active         INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, effective_from)
);

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_salary_plans_ins AFTER INSERT ON salary_plans BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_salary_plans_upd AFTER UPDATE ON salary_plans BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_salary_plans_del AFTER DELETE ON salary_plans BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;
