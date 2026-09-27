ALTER TABLE expenses DROP COLUMN fx_rate;

--bun:split
ALTER TABLE expenses DROP COLUMN original_amount;

--bun:split
ALTER TABLE expenses DROP COLUMN currency;
