DROP TABLE IF EXISTS account_reconciliations;

--bun:split
ALTER TABLE transfers DROP COLUMN mode;
