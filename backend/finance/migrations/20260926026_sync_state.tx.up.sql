-- Sincronización escritorio ⇄ iPad por entrega de archivo, con vectores de
-- versión (ver backend/shared/db/syncstate.go).
-- sync_state.dirty: esta base cambió desde la última vez que salió del
--   dispositivo (respaldo o exportación). Lo marcan los triggers de abajo, así
--   ningún camino de escritura (Go o motor web) se escapa.
-- sync_vector: cuántas veces salió con cambios desde cada dispositivo; al
--   importar se compara con el de la base local para no pisar cambios.
CREATE TABLE IF NOT EXISTS sync_state (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    dirty INTEGER NOT NULL DEFAULT 0
);

--bun:split
CREATE TABLE IF NOT EXISTS sync_vector (
    device_id TEXT PRIMARY KEY,
    edits     INTEGER NOT NULL
);

--bun:split
-- Una base que ya tiene datos arranca con cambios sin sincronizar; una recién
-- creada (sólo el perfil sembrado), sin cambios.
INSERT OR IGNORE INTO sync_state (id, dirty) VALUES (1, CASE WHEN
    EXISTS (SELECT 1 FROM expenses) OR EXISTS (SELECT 1 FROM incomes) OR
    EXISTS (SELECT 1 FROM period_salaries) OR EXISTS (SELECT 1 FROM fixed_expenses) OR
    EXISTS (SELECT 1 FROM cards) OR EXISTS (SELECT 1 FROM categories) OR
    EXISTS (SELECT 1 FROM savings_goals) OR EXISTS (SELECT 1 FROM import_items)
    THEN 1 ELSE 0 END);

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_users_ins AFTER INSERT ON users BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_users_upd AFTER UPDATE ON users BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_users_del AFTER DELETE ON users BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_expenses_ins AFTER INSERT ON expenses BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_expenses_upd AFTER UPDATE ON expenses BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_expenses_del AFTER DELETE ON expenses BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_installments_ins AFTER INSERT ON installments BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_installments_upd AFTER UPDATE ON installments BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_installments_del AFTER DELETE ON installments BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_incomes_ins AFTER INSERT ON incomes BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_incomes_upd AFTER UPDATE ON incomes BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_incomes_del AFTER DELETE ON incomes BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_period_salaries_ins AFTER INSERT ON period_salaries BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_period_salaries_upd AFTER UPDATE ON period_salaries BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_period_salaries_del AFTER DELETE ON period_salaries BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_cards_ins AFTER INSERT ON cards BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_cards_upd AFTER UPDATE ON cards BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_cards_del AFTER DELETE ON cards BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_categories_ins AFTER INSERT ON categories BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_categories_upd AFTER UPDATE ON categories BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_categories_del AFTER DELETE ON categories BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_category_budgets_ins AFTER INSERT ON category_budgets BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_category_budgets_upd AFTER UPDATE ON category_budgets BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_category_budgets_del AFTER DELETE ON category_budgets BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_merchants_ins AFTER INSERT ON merchants BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_merchants_upd AFTER UPDATE ON merchants BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_merchants_del AFTER DELETE ON merchants BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_merchant_rules_ins AFTER INSERT ON merchant_rules BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_merchant_rules_upd AFTER UPDATE ON merchant_rules BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_merchant_rules_del AFTER DELETE ON merchant_rules BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_fixed_expenses_ins AFTER INSERT ON fixed_expenses BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_fixed_expenses_upd AFTER UPDATE ON fixed_expenses BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_fixed_expenses_del AFTER DELETE ON fixed_expenses BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_fixed_expense_amounts_ins AFTER INSERT ON fixed_expense_amounts BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_fixed_expense_amounts_upd AFTER UPDATE ON fixed_expense_amounts BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_fixed_expense_amounts_del AFTER DELETE ON fixed_expense_amounts BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_fixed_expense_payments_ins AFTER INSERT ON fixed_expense_payments BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_fixed_expense_payments_upd AFTER UPDATE ON fixed_expense_payments BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_fixed_expense_payments_del AFTER DELETE ON fixed_expense_payments BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_savings_goals_ins AFTER INSERT ON savings_goals BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_savings_goals_upd AFTER UPDATE ON savings_goals BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_savings_goals_del AFTER DELETE ON savings_goals BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_savings_contributions_ins AFTER INSERT ON savings_contributions BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_savings_contributions_upd AFTER UPDATE ON savings_contributions BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_savings_contributions_del AFTER DELETE ON savings_contributions BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_import_items_ins AFTER INSERT ON import_items BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_import_items_upd AFTER UPDATE ON import_items BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_import_items_del AFTER DELETE ON import_items BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_card_statements_ins AFTER INSERT ON card_statements BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_card_statements_upd AFTER UPDATE ON card_statements BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_card_statements_del AFTER DELETE ON card_statements BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_card_statement_lines_ins AFTER INSERT ON card_statement_lines BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_card_statement_lines_upd AFTER UPDATE ON card_statement_lines BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_card_statement_lines_del AFTER DELETE ON card_statement_lines BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_card_statement_schedule_ins AFTER INSERT ON card_statement_schedule BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_card_statement_schedule_upd AFTER UPDATE ON card_statement_schedule BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_card_statement_schedule_del AFTER DELETE ON card_statement_schedule BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_settings_ins AFTER INSERT ON settings BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_settings_upd AFTER UPDATE ON settings BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_settings_del AFTER DELETE ON settings BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_reconciliations_ins AFTER INSERT ON reconciliations BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_reconciliations_upd AFTER UPDATE ON reconciliations BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_reconciliations_del AFTER DELETE ON reconciliations BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_refunds_ins AFTER INSERT ON refunds BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_refunds_upd AFTER UPDATE ON refunds BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_refunds_del AFTER DELETE ON refunds BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_tags_ins AFTER INSERT ON tags BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_tags_upd AFTER UPDATE ON tags BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_tags_del AFTER DELETE ON tags BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_expense_tags_ins AFTER INSERT ON expense_tags BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_expense_tags_upd AFTER UPDATE ON expense_tags BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;

--bun:split
CREATE TRIGGER IF NOT EXISTS sync_dirty_expense_tags_del AFTER DELETE ON expense_tags BEGIN UPDATE sync_state SET dirty = 1 WHERE id = 1 AND dirty = 0; END;
