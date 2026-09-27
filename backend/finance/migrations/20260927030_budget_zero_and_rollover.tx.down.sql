ALTER TABLE categories DROP COLUMN rollover;

--bun:split
UPDATE category_budgets SET amount = '0' WHERE capped = 0;

--bun:split
ALTER TABLE category_budgets DROP COLUMN capped;
