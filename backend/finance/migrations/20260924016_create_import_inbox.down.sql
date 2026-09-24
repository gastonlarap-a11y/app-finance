ALTER TABLE cards DROP COLUMN last_digits;

--bun:split
DROP TABLE IF EXISTS merchant_rules;

--bun:split
DROP TABLE IF EXISTS import_items;
