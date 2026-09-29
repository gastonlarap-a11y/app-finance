DROP TRIGGER IF EXISTS sync_dirty_salary_plans_ins;

--bun:split
DROP TRIGGER IF EXISTS sync_dirty_salary_plans_upd;

--bun:split
DROP TRIGGER IF EXISTS sync_dirty_salary_plans_del;

--bun:split
DROP TABLE IF EXISTS salary_plans;
