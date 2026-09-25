ALTER TABLE import_items DROP COLUMN income_id;

--bun:split
ALTER TABLE import_items DROP COLUMN first_period;

--bun:split
ALTER TABLE import_items DROP COLUMN installment_amount;

--bun:split
ALTER TABLE import_items DROP COLUMN installment_number;

--bun:split
ALTER TABLE import_items DROP COLUMN statement_line_id;

--bun:split
ALTER TABLE import_items DROP COLUMN kind;

--bun:split
DROP TABLE IF EXISTS card_statement_schedule;

--bun:split
DROP TABLE IF EXISTS card_statement_lines;

--bun:split
DROP TABLE IF EXISTS card_statements;
