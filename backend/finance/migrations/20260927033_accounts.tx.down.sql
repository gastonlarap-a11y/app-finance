ALTER TABLE cards DROP COLUMN account_id;

--bun:split
ALTER TABLE incomes DROP COLUMN account_id;

--bun:split
ALTER TABLE expenses DROP COLUMN account_id;

--bun:split
DROP TRIGGER IF EXISTS sync_dirty_accounts_ins;

--bun:split
DROP TRIGGER IF EXISTS sync_dirty_accounts_upd;

--bun:split
DROP TRIGGER IF EXISTS sync_dirty_accounts_del;

--bun:split
DROP TABLE IF EXISTS accounts;
