ALTER TABLE import_items DROP COLUMN refund_id;

--bun:split
DROP INDEX IF EXISTS idx_refunds_expense;

--bun:split
DROP INDEX IF EXISTS idx_refunds_user_period;

--bun:split
DROP TABLE IF EXISTS refunds;
