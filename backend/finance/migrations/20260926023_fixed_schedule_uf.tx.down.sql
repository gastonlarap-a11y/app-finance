DROP TABLE IF EXISTS uf_values;

--bun:split
ALTER TABLE fixed_expenses DROP COLUMN currency;

--bun:split
ALTER TABLE fixed_expenses DROP COLUMN interval_months;
