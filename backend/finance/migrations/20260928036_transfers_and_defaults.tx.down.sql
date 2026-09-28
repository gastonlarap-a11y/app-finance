ALTER TABLE merchants DROP COLUMN category;
--bun:split
ALTER TABLE fixed_expenses DROP COLUMN account_id;
--bun:split
DROP TABLE IF EXISTS transfers;
