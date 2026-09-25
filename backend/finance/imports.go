package finance

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

const (
	dateLayout = "2006-01-02"

	// reconcileWindowDays: an alert email and its statement line may be dated a
	// day apart (purchase date vs posting date).
	reconcileWindowDays = 1
	// duplicateWindowDays: how far a manually entered expense may be from the
	// detected movement and still be offered as "probably the same purchase".
	duplicateWindowDays = 2
)

// sourceFamily groups sources that describe the same movement independently:
// an email alert and a statement line are two sightings of one purchase, two
// lines of the same statement never are.
func sourceFamily(source string) string {
	if source == ImportSourceEmail {
		return "email"
	}
	return "pdf"
}

// ---------- staging ----------

// StageCandidates records a parser's batch in uid's import inbox, atomically:
// candidates already staged (same external key) are skipped, and a candidate
// matching a movement from the other source family (same amount, currency and
// compatible card within reconcileWindowDays) is stored as conciliado so the
// purchase is never reviewed twice. It is shared by the bound StageImport
// (statements parsed in the frontend) and the desktop mail sync, which passes
// its own transaction so the inbox and its sync watermark commit together.
func StageCandidates(ctx context.Context, db bun.IDB, uid int64, batch ImportBatch) (StageSummary, error) {
	items, aerr := validateBatch(uid, batch)
	if aerr != nil {
		return StageSummary{}, aerr
	}
	var sum StageSummary
	err := db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		var err error
		_, sum, err = stageItems(ctx, tx, uid, items)
		return err
	})
	if err != nil {
		return StageSummary{}, err
	}
	return sum, nil
}

// stageItems inserts validated items inside the caller's transaction and
// returns, per item, the id of the inbox row that now represents it (the new
// row, or the existing one for a duplicate) — card statements link their lines
// to those rows.
func stageItems(ctx context.Context, tx bun.Tx, uid int64, items []ImportItem) ([]int64, StageSummary, error) {
	var sum StageSummary
	ids := make([]int64, len(items))
	for i := range items {
		item := &items[i]
		existing := new(ImportItem)
		err := tx.NewSelect().Model(existing).Column("id").
			Where("user_id = ? AND external_key = ?", uid, item.ExternalKey).Scan(ctx)
		if err == nil {
			ids[i] = existing.ID
			sum.Duplicates++
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, sum, fmt.Errorf("checking import key: %w", err)
		}
		reconciled, err := reconcile(ctx, tx, uid, item)
		if err != nil {
			return nil, sum, err
		}
		if _, err := tx.NewInsert().Model(item).Returning("*").Exec(ctx); err != nil {
			return nil, sum, fmt.Errorf("inserting import item: %w", err)
		}
		ids[i] = item.ID
		if reconciled {
			sum.Reconciled++
		} else {
			sum.Added++
		}
	}
	return ids, sum, nil
}

// reconcile marks item conciliado when the inbox or a card statement already
// accounts for it: a card-bill payment in the cartola that a statement lists
// as a payment, or the other-family sighting of the same purchase.
func reconcile(ctx context.Context, tx bun.Tx, uid int64, item *ImportItem) (bool, error) {
	if item.Hint == HintCardPayment {
		line, err := matchPaymentLine(ctx, tx, uid, item)
		if err != nil || line == nil {
			return false, err
		}
		item.Status = ImportConciliado
		item.StatementLineID = &line.ID
		return true, nil
	}
	match, err := findReconcileMatch(ctx, tx, uid, item)
	if err != nil || match == nil {
		return false, err
	}
	item.Status = ImportConciliado
	item.MatchedItemID = &match.ID
	// A statement knows the installment count an alert may not carry.
	if item.InstallmentsTotal > 1 && match.InstallmentsTotal == 1 {
		if _, err := tx.NewUpdate().Model((*ImportItem)(nil)).
			Set("installments_total = ?", item.InstallmentsTotal).
			Where("id = ? AND user_id = ?", match.ID, uid).Exec(ctx); err != nil {
			return false, fmt.Errorf("updating matched installments: %w", err)
		}
	}
	return true, nil
}

// findReconcileMatch looks for the other-family sighting of item that nothing
// has been matched with yet; the closest date wins, then the oldest row.
func findReconcileMatch(ctx context.Context, db bun.IDB, uid int64, item *ImportItem) (*ImportItem, error) {
	match := new(ImportItem)
	q := db.NewSelect().Model(match).
		Where("user_id = ? AND status <> ? AND amount = ? AND currency = ?",
			uid, ImportConciliado, item.Amount.String(), item.Currency).
		Where("ABS(julianday(date) - julianday(?)) <= ?", item.Date, reconcileWindowDays).
		Where("(card_last_digits = ? OR card_last_digits = '' OR ? = '')", item.CardLastDigits, item.CardLastDigits).
		Where("id NOT IN (SELECT matched_item_id FROM import_items WHERE user_id = ? AND matched_item_id IS NOT NULL)", uid).
		OrderExpr("ABS(julianday(date) - julianday(?)) ASC, id ASC", item.Date).
		Limit(1)
	if sourceFamily(item.Source) == "email" {
		q = q.Where("source <> ?", ImportSourceEmail)
	} else {
		q = q.Where("source = ?", ImportSourceEmail)
	}
	err := q.Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("finding reconcile match: %w", err)
	}
	return match, nil
}

// validateBatch turns a batch into insertable items, rejecting it whole when
// any candidate is invalid (a parser bug must not half-import a statement).
// The external key is built from the candidate's stable fields plus its
// ordinal among identical candidates of the batch, so two equal purchases on
// the same day stay two items while re-importing the same file adds nothing.
func validateBatch(uid int64, batch ImportBatch) ([]ImportItem, *shared.AppError) {
	switch batch.Source {
	case ImportSourceEmail, ImportSourcePDFAccount, ImportSourcePDFCard:
	default:
		return nil, shared.NewError(shared.ErrValidation, "origen de importación inválido: "+batch.Source)
	}
	issuer := strings.ToLower(strings.TrimSpace(batch.Issuer))
	if issuer == "" {
		return nil, shared.NewError(shared.ErrValidation, "el emisor es obligatorio")
	}
	ordinals := map[string]int{}
	items := make([]ImportItem, 0, len(batch.Items))
	for i, c := range batch.Items {
		item, aerr := validateCandidate(c)
		if aerr != nil {
			return nil, shared.NewError(aerr.Code, fmt.Sprintf("movimiento %d: %s", i+1, aerr.Message))
		}
		item.UserID = uid
		item.Source = batch.Source
		item.Issuer = issuer
		item.Status = ImportPendiente
		base := strings.Join([]string{
			issuer, batch.Source, strings.TrimSpace(c.Account), item.Date, item.Amount.String(), item.Currency,
			item.CardLastDigits, normalizeKey(item.Description), strings.TrimSpace(c.Reference),
		}, "|")
		item.ExternalKey = base + "|" + strconv.Itoa(ordinals[base])
		ordinals[base]++
		items = append(items, item)
	}
	return items, nil
}

func validateCandidate(c ImportCandidate) (ImportItem, *shared.AppError) {
	desc := strings.TrimSpace(c.Description)
	if desc == "" {
		return ImportItem{}, shared.NewError(shared.ErrValidation, "la descripción es obligatoria")
	}
	date, err := time.Parse(dateLayout, strings.TrimSpace(c.Date))
	if err != nil {
		return ImportItem{}, shared.NewError(shared.ErrValidation, "fecha inválida (use YYYY-MM-DD): "+c.Date)
	}
	amt, aerr := parseAmount(c.Amount)
	if aerr != nil {
		return ImportItem{}, aerr
	}
	if amt.IsZero() {
		return ImportItem{}, shared.NewError(shared.ErrValidation, "el monto debe ser mayor a 0")
	}
	digits, aerr := validateLastDigits(c.CardLastDigits)
	if aerr != nil {
		return ImportItem{}, aerr
	}
	switch c.Hint {
	case HintNone, HintCardPayment, HintTransfer:
	default:
		return ImportItem{}, shared.NewError(shared.ErrValidation, "pista inválida: "+c.Hint)
	}
	currency := strings.ToUpper(strings.TrimSpace(c.Currency))
	if currency == "" {
		currency = "CLP"
	}
	kind := c.Kind
	switch kind {
	case "":
		kind = ImportKindExpense
	case ImportKindExpense, ImportKindCredit:
	default:
		return ImportItem{}, shared.NewError(shared.ErrValidation, "tipo de movimiento inválido: "+c.Kind)
	}
	total := max(c.InstallmentsTotal, 1)
	number := max(c.InstallmentNumber, 1)
	if number > total {
		return ImportItem{}, shared.NewError(shared.ErrValidation, fmt.Sprintf("cuota %d de %d inválida", number, total))
	}
	cuota := ""
	if strings.TrimSpace(c.InstallmentAmount) != "" {
		v, aerr := parseAmount(c.InstallmentAmount)
		if aerr != nil {
			return ImportItem{}, aerr
		}
		cuota = v.String()
	}
	if c.FirstPeriod != "" && !validPeriod(c.FirstPeriod) {
		return ImportItem{}, shared.NewError(shared.ErrValidation, "período de la primera cuota inválido: "+c.FirstPeriod)
	}
	return ImportItem{
		Date:              date.Format(dateLayout),
		Description:       desc,
		Amount:            amt,
		Currency:          currency,
		CardLastDigits:    digits,
		InstallmentsTotal: total,
		Hint:              c.Hint,
		Kind:              kind,
		InstallmentNumber: number,
		InstallmentAmount: cuota,
		FirstPeriod:       c.FirstPeriod,
	}, nil
}

// StageImport stages a batch the frontend parsed from a bank statement.
func (s *FinanceService) StageImport(ctx context.Context, batch ImportBatch) StageResult {
	sum, err := StageCandidates(ctx, s.db, s.uid(), batch)
	if err != nil {
		return StageResult{Error: appErr(err)}
	}
	return StageResult{Data: &sum}
}

// ---------- review ----------

func validImportStatus(status string) bool {
	switch status {
	case ImportPendiente, ImportConfirmado, ImportDescartado, ImportConciliado:
		return true
	}
	return false
}

// ListImportItems returns the inbox items in `status`, newest first, each with
// the suggestions the review screen needs (see ImportItemView).
func (s *FinanceService) ListImportItems(ctx context.Context, status string) ImportItemsResult {
	if !validImportStatus(status) {
		return ImportItemsResult{Error: shared.NewError(shared.ErrValidation, "estado inválido: "+status)}
	}
	out, err := s.listImportItems(ctx, s.uid(), status)
	if err != nil {
		return ImportItemsResult{Error: internalErr(err)}
	}
	return ImportItemsResult{Data: out}
}

func (s *FinanceService) listImportItems(ctx context.Context, uid int64, status string) ([]ImportItemView, error) {
	var items []ImportItem
	if err := s.db.NewSelect().Model(&items).Where("user_id = ? AND status = ?", uid, status).
		Order("date DESC", "id DESC").Scan(ctx); err != nil {
		return nil, fmt.Errorf("listing import items: %w", err)
	}
	cards, err := s.listCards(ctx, uid)
	if err != nil {
		return nil, fmt.Errorf("listing cards: %w", err)
	}
	cardByDigits := cardsByLastDigits(cards)
	rules, err := s.listMerchantRules(ctx, uid)
	if err != nil {
		return nil, err
	}
	fx, err := latestFxRate(ctx, s.db, uid)
	if err != nil {
		return nil, err
	}

	out := make([]ImportItemView, 0, len(items))
	for _, it := range items {
		v := ImportItemView{ImportItem: it, SuggestedPattern: suggestPattern(it.Description)}
		if c, ok := cardByDigits[it.CardLastDigits]; ok {
			v.CardID, v.CardName = &c.ID, c.Name
		}
		if r, ok := ruleFor(rules, it.Description); ok {
			v.RulePattern, v.SuggestedMerchant, v.SuggestedCategory = r.Pattern, r.Merchant, r.Category
		}
		v.SuggestedAmountClp = suggestClp(it, fx)
		if it.Status == ImportPendiente && it.Kind != ImportKindCredit && it.Currency == "CLP" {
			dup, err := s.findDuplicateExpense(ctx, uid, it, v.CardID)
			if err != nil {
				return nil, err
			}
			if dup != nil {
				v.DuplicateExpenseID, v.DuplicateDescription = &dup.ID, dup.Description
			}
		}
		if it.MatchedItemID != nil {
			matched := new(ImportItem)
			err := s.db.NewSelect().Model(matched).Where("id = ? AND user_id = ?", *it.MatchedItemID, uid).Scan(ctx)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, fmt.Errorf("loading matched item: %w", err)
			}
			v.MatchedSource, v.MatchedDate = matched.Source, matched.Date
		}
		out = append(out, v)
	}
	return out, nil
}

// suggestClp converts a USD item at the given CLP-per-USD rate, rounded to
// whole pesos; "" for CLP items or without a known rate.
func suggestClp(it ImportItem, fx string) string {
	if it.Currency != "USD" || fx == "" {
		return ""
	}
	rate, err := types.New(fx)
	if err != nil {
		return ""
	}
	return it.Amount.Decimal.Mul(rate.Decimal).Round(0).String()
}

// cardsByLastDigits maps last digits to the one live card that has them;
// digits shared by several cards are ambiguous and resolve to none.
func cardsByLastDigits(cards []Card) map[string]Card {
	out := map[string]Card{}
	seen := map[string]int{}
	for _, c := range cards {
		if c.LastDigits == "" {
			continue
		}
		seen[c.LastDigits]++
		out[c.LastDigits] = c
	}
	for digits, n := range seen {
		if n > 1 {
			delete(out, digits)
		}
	}
	return out
}

// findDuplicateExpense returns a live expense, not yet linked to any import
// item, that looks like the same purchase: its date within duplicateWindowDays,
// its cuota or its total equal to the amount and, when the item's card is
// known, on that card. The closest date wins, then the oldest expense.
func (s *FinanceService) findDuplicateExpense(ctx context.Context, uid int64, it ImportItem, cardID *int64) (*Expense, error) {
	var cands []Expense
	q := s.db.NewSelect().Model(&cands).
		Where("user_id = ?", uid).
		Where("ABS(julianday(substr(date, 1, 10)) - julianday(?)) <= ?", it.Date, duplicateWindowDays).
		Where("id NOT IN (SELECT expense_id FROM import_items WHERE user_id = ? AND expense_id IS NOT NULL)", uid).
		OrderExpr("ABS(julianday(substr(date, 1, 10)) - julianday(?)) ASC, id ASC", it.Date)
	if cardID != nil {
		q = q.Where("card_id = ?", *cardID)
	}
	if err := q.Scan(ctx); err != nil {
		return nil, fmt.Errorf("finding duplicate expense: %w", err)
	}
	for i := range cands {
		ex := &cands[i]
		if ex.InstallmentAmount.Cmp(it.Amount) == 0 || ex.InstallmentAmount.MulInt(int64(ex.InstallmentsTotal)).Cmp(it.Amount) == 0 {
			return ex, nil
		}
	}
	return nil, nil
}

// loadPendingItem returns uid's item `id` when it is still pendiente: NotFound
// when it does not exist for uid, Conflict when it was already processed.
func loadPendingItem(ctx context.Context, db bun.IDB, uid, id int64) (*ImportItem, error) {
	item := new(ImportItem)
	err := db.NewSelect().Model(item).Where("id = ? AND user_id = ?", id, uid).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, shared.NewError(shared.ErrNotFound, "movimiento no encontrado")
	}
	if err != nil {
		return nil, fmt.Errorf("loading import item: %w", err)
	}
	if item.Status != ImportPendiente {
		return nil, shared.NewError(shared.ErrConflict, "el movimiento ya fue procesado")
	}
	return item, nil
}

// ConfirmImportItem turns a pending item into an expense (with the values the
// user reviewed) in one transaction. A non-empty rulePattern also saves the
// merchant/category rule for descriptors starting with it.
func (s *FinanceService) ConfirmImportItem(
	ctx context.Context, id int64, dateStr, description, category, merchant string,
	cardID *int64, kind, installmentAmount string, installmentsTotal int, rulePattern string,
) ExpenseResult {
	uid := s.uid()
	ex, aerr := validateExpense(uid, dateStr, description, category, merchant, cardID, kind, installmentAmount, installmentsTotal)
	if aerr != nil {
		return ExpenseResult{Error: aerr}
	}
	pattern, aerr := validateRulePattern(rulePattern)
	if aerr != nil {
		return ExpenseResult{Error: aerr}
	}
	billingDay, aerr := s.billingDayFor(ctx, uid, cardID)
	if aerr != nil {
		return ExpenseResult{Error: aerr}
	}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		item, err := loadPendingItem(ctx, tx, uid, id)
		if err != nil {
			return err
		}
		if _, err := tx.NewInsert().Model(ex).Returning("*").Exec(ctx); err != nil {
			return fmt.Errorf("inserting expense: %w", err)
		}
		// A statement cuota n/N places the purchase exactly: cuota 1 was billed
		// n-1 months before the statement, and those earlier cuotas are paid.
		first, paid := "", 0
		if item.FirstPeriod != "" && ex.Kind == KindCuotas && ex.InstallmentsTotal == item.InstallmentsTotal {
			first, paid = item.FirstPeriod, item.InstallmentNumber-1
		}
		if err := generateInstallmentsFrom(ctx, tx, ex, billingDay, first, paid); err != nil {
			return fmt.Errorf("generating installments: %w", err)
		}
		if _, err := tx.NewUpdate().Model((*ImportItem)(nil)).
			Set("status = ?", ImportConfirmado).Set("expense_id = ?", ex.ID).
			Where("id = ? AND user_id = ?", id, uid).Exec(ctx); err != nil {
			return fmt.Errorf("confirming import item: %w", err)
		}
		if pattern == "" {
			return nil
		}
		return saveMerchantRule(ctx, tx, &MerchantRule{UserID: uid, Pattern: pattern, Merchant: ex.Merchant, Category: ex.Category})
	})
	if err != nil {
		return ExpenseResult{Error: appErr(err)}
	}
	return ExpenseResult{Data: ex}
}

// LinkImportItem marks a pending item as the bank's sighting of an expense the
// user had already entered by hand, instead of creating a duplicate.
func (s *FinanceService) LinkImportItem(ctx context.Context, id, expenseID int64) OpResult {
	uid := s.uid()
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if _, err := loadPendingItem(ctx, tx, uid, id); err != nil {
			return err
		}
		ok, err := tx.NewSelect().Model((*Expense)(nil)).Where("id = ? AND user_id = ?", expenseID, uid).Exists(ctx)
		if err != nil {
			return fmt.Errorf("checking expense: %w", err)
		}
		if !ok {
			return shared.NewError(shared.ErrNotFound, "gasto no encontrado")
		}
		_, err = tx.NewUpdate().Model((*ImportItem)(nil)).
			Set("status = ?", ImportConfirmado).Set("expense_id = ?", expenseID).
			Where("id = ? AND user_id = ?", id, uid).Exec(ctx)
		return err
	})
	if err != nil {
		return OpResult{Error: appErr(err)}
	}
	return OpResult{}
}

// DiscardImportItem drops a pending item from review (a card bill payment, a
// transfer between own accounts…). RestoreImportItem brings it back.
func (s *FinanceService) DiscardImportItem(ctx context.Context, id int64) OpResult {
	return s.moveImportItem(ctx, id, ImportPendiente, ImportDescartado)
}

// RestoreImportItem returns a discarded item to the pending list.
func (s *FinanceService) RestoreImportItem(ctx context.Context, id int64) OpResult {
	return s.moveImportItem(ctx, id, ImportDescartado, ImportPendiente)
}

func (s *FinanceService) moveImportItem(ctx context.Context, id int64, from, to string) OpResult {
	uid := s.uid()
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		item := new(ImportItem)
		err := tx.NewSelect().Model(item).Where("id = ? AND user_id = ?", id, uid).Scan(ctx)
		if errors.Is(err, sql.ErrNoRows) {
			return shared.NewError(shared.ErrNotFound, "movimiento no encontrado")
		}
		if err != nil {
			return fmt.Errorf("loading import item: %w", err)
		}
		if item.Status != from {
			return shared.NewError(shared.ErrConflict, "el movimiento no está "+from)
		}
		_, err = tx.NewUpdate().Model((*ImportItem)(nil)).Set("status = ?", to).
			Where("id = ? AND user_id = ?", id, uid).Exec(ctx)
		return err
	})
	if err != nil {
		return OpResult{Error: appErr(err)}
	}
	return OpResult{}
}

// ---------- merchant rules ----------

// validateRulePattern normalizes a rule pattern the same way descriptors are
// normalized; "" means "do not learn a rule".
func validateRulePattern(pattern string) (string, *shared.AppError) {
	if strings.TrimSpace(pattern) == "" {
		return "", nil
	}
	norm := normalizeDescriptor(pattern)
	if norm == "" {
		return "", shared.NewError(shared.ErrValidation, "el patrón de la regla no tiene palabras válidas")
	}
	return norm, nil
}

// saveMerchantRule creates the rule or, when the pattern already exists,
// replaces its merchant and category with the latest choice.
func saveMerchantRule(ctx context.Context, db bun.IDB, rule *MerchantRule) error {
	_, err := db.NewInsert().Model(rule).
		On("CONFLICT (user_id, pattern) DO UPDATE").
		Set("merchant = EXCLUDED.merchant").Set("category = EXCLUDED.category").Exec(ctx)
	if err != nil {
		return fmt.Errorf("saving merchant rule: %w", err)
	}
	return nil
}

func (s *FinanceService) ListMerchantRules(ctx context.Context) ([]MerchantRule, error) {
	return s.listMerchantRules(ctx, s.uid())
}

func (s *FinanceService) listMerchantRules(ctx context.Context, uid int64) ([]MerchantRule, error) {
	rules := []MerchantRule{}
	if err := s.db.NewSelect().Model(&rules).Where("user_id = ?", uid).Order("pattern ASC", "id ASC").Scan(ctx); err != nil {
		return nil, fmt.Errorf("listing merchant rules: %w", err)
	}
	return rules, nil
}

// DeleteMerchantRule forgets a learned rule for good (it is re-learned by
// confirming a movement with a pattern again).
func (s *FinanceService) DeleteMerchantRule(ctx context.Context, id int64) OpResult {
	res, err := s.db.NewDelete().Model((*MerchantRule)(nil)).Where("id = ? AND user_id = ?", id, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "regla no encontrada")}
}
