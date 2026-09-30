DROP INDEX IF EXISTS idx_savings_goals_account;

--bun:split
ALTER TABLE savings_goals DROP COLUMN account_id;
