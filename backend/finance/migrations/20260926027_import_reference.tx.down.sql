DROP INDEX IF EXISTS idx_card_statement_lines_user_date;

--bun:split
ALTER TABLE import_items DROP COLUMN reference;
