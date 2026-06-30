package finance

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// FinanceService is the Wails v3 service for the whole finance domain. Public
// methods are auto-bound to TypeScript by `wails3 generate bindings`.
type FinanceService struct {
	db *bun.DB
}

func NewFinanceService(db *bun.DB) *FinanceService { return &FinanceService{db: db} }

func (s *FinanceService) ServiceName() string { return "FinanceService" }

// ---------- helpers ----------

func parseAmount(s string) (types.Decimal, *shared.AppError) {
	d, err := types.New(strings.TrimSpace(s))
	if err != nil {
		return types.Zero(), shared.NewError(shared.ErrValidation, "monto inválido: "+s)
	}
	if d.IsNegative() {
		return types.Zero(), shared.NewError(shared.ErrValidation, "el monto no puede ser negativo")
	}
	return d, nil
}

func parseDate(s string) (time.Time, *shared.AppError) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{"2006-01-02", time.RFC3339, "02/01/2006"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, shared.NewError(shared.ErrValidation, "fecha inválida: "+s)
}

// ---------- settings ----------

func (s *FinanceService) GetSettings(ctx context.Context) SettingsResult {
	st := new(Settings)
	if err := s.db.NewSelect().Model(st).Where("id = 1").Scan(ctx); err != nil {
		return SettingsResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return SettingsResult{Data: st}
}

// ---------- salary (per month) ----------

// salaryFor returns the salary saved for a period, or zero when none is set.
func (s *FinanceService) salaryFor(ctx context.Context, period string) (types.Decimal, error) {
	ps := new(PeriodSalary)
	err := s.db.NewSelect().Model(ps).Where("period = ?", period).Scan(ctx)
	if err != nil {
		if err == sql.ErrNoRows {
			return types.Zero(), nil
		}
		return types.Zero(), err
	}
	return ps.Amount, nil
}

func (s *FinanceService) GetSalary(ctx context.Context, period string) SalaryResult {
	if !validPeriod(period) {
		return SalaryResult{Error: shared.NewError(shared.ErrValidation, "período inválido (use YYYY-MM)")}
	}
	amt, err := s.salaryFor(ctx, period)
	if err != nil {
		return SalaryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return SalaryResult{Data: &PeriodSalary{Period: period, Amount: amt}}
}

func (s *FinanceService) SetSalary(ctx context.Context, period, amount string) SalaryResult {
	if !validPeriod(period) {
		return SalaryResult{Error: shared.NewError(shared.ErrValidation, "período inválido (use YYYY-MM)")}
	}
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return SalaryResult{Error: aerr}
	}
	ps := &PeriodSalary{Period: period, Amount: amt}
	if _, err := s.db.NewInsert().Model(ps).
		On("CONFLICT (period) DO UPDATE").
		Set("amount = EXCLUDED.amount").Exec(ctx); err != nil {
		return SalaryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return SalaryResult{Data: ps}
}

// ---------- cards ----------

func (s *FinanceService) ListCards(ctx context.Context) ([]Card, error) {
	var cards []Card
	err := s.db.NewSelect().Model(&cards).Order("name ASC").Scan(ctx)
	return cards, err
}

func (s *FinanceService) CreateCard(ctx context.Context, name, creditLimit string, billingDay int) CardResult {
	if strings.TrimSpace(name) == "" {
		return CardResult{Error: shared.NewError(shared.ErrValidation, "el nombre es obligatorio")}
	}
	limit, aerr := parseAmount(creditLimit)
	if aerr != nil {
		return CardResult{Error: aerr}
	}
	if billingDay < 1 || billingDay > 28 {
		billingDay = 24
	}
	card := &Card{Name: strings.TrimSpace(name), CreditLimit: limit, BillingDay: billingDay}
	if _, err := s.db.NewInsert().Model(card).Returning("*").Exec(ctx); err != nil {
		return CardResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return CardResult{Data: card}
}

func (s *FinanceService) UpdateCard(ctx context.Context, id int64, name, creditLimit string, billingDay int) CardResult {
	if strings.TrimSpace(name) == "" {
		return CardResult{Error: shared.NewError(shared.ErrValidation, "el nombre es obligatorio")}
	}
	limit, aerr := parseAmount(creditLimit)
	if aerr != nil {
		return CardResult{Error: aerr}
	}
	if billingDay < 1 || billingDay > 28 {
		billingDay = 24
	}
	res, err := s.db.NewUpdate().Model((*Card)(nil)).
		Set("name = ?", strings.TrimSpace(name)).
		Set("credit_limit = ?", limit).
		Set("billing_day = ?", billingDay).
		Where("id = ?", id).Exec(ctx)
	if err != nil {
		return CardResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return CardResult{Error: shared.NewError(shared.ErrNotFound, "tarjeta no encontrada")}
	}
	card := new(Card)
	if err := s.db.NewSelect().Model(card).Where("id = ?", id).Scan(ctx); err != nil {
		return CardResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return CardResult{Data: card}
}

// DeleteCard unlinks its expenses (card_id = NULL) then removes the card. We do
// not rely on SQLite ON DELETE (foreign keys are not enabled on the connection).
func (s *FinanceService) DeleteCard(ctx context.Context, id int64) OpResult {
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewUpdate().Model((*Expense)(nil)).
			Set("card_id = NULL").Where("card_id = ?", id).Exec(ctx); err != nil {
			return err
		}
		_, err := tx.NewDelete().Model((*Card)(nil)).Where("id = ?", id).Exec(ctx)
		return err
	})
	if err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return OpResult{}
}

// ---------- categories ----------

func (s *FinanceService) ListCategories(ctx context.Context) ([]Category, error) {
	var cats []Category
	err := s.db.NewSelect().Model(&cats).Order("name ASC").Scan(ctx)
	return cats, err
}

func (s *FinanceService) CreateCategory(ctx context.Context, name string) CategoryResult {
	name = strings.TrimSpace(name)
	if name == "" {
		return CategoryResult{Error: shared.NewError(shared.ErrValidation, "el nombre es obligatorio")}
	}
	cat := &Category{Name: name}
	if _, err := s.db.NewInsert().Model(cat).Returning("*").Exec(ctx); err != nil {
		if isUniqueViolation(err) {
			return CategoryResult{Error: shared.NewError(shared.ErrValidation, "la categoría ya existe")}
		}
		return CategoryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return CategoryResult{Data: cat}
}

// UpdateCategory renames a category and cascades the new name to every expense
// that used the old name (expenses store the category as plain text).
func (s *FinanceService) UpdateCategory(ctx context.Context, id int64, name string) CategoryResult {
	name = strings.TrimSpace(name)
	if name == "" {
		return CategoryResult{Error: shared.NewError(shared.ErrValidation, "el nombre es obligatorio")}
	}
	cat := new(Category)
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		old := new(Category)
		if err := tx.NewSelect().Model(old).Where("id = ?", id).Scan(ctx); err != nil {
			if err == sql.ErrNoRows {
				return shared.NewError(shared.ErrNotFound, "categoría no encontrada")
			}
			return err
		}
		if _, err := tx.NewUpdate().Model((*Category)(nil)).
			Set("name = ?", name).Where("id = ?", id).Exec(ctx); err != nil {
			return err
		}
		if old.Name != name {
			if _, err := tx.NewUpdate().Model((*Expense)(nil)).
				Set("category = ?", name).Where("category = ?", old.Name).Exec(ctx); err != nil {
				return err
			}
		}
		return tx.NewSelect().Model(cat).Where("id = ?", id).Scan(ctx)
	})
	if err != nil {
		if ae, ok := err.(*shared.AppError); ok {
			return CategoryResult{Error: ae}
		}
		if isUniqueViolation(err) {
			return CategoryResult{Error: shared.NewError(shared.ErrValidation, "la categoría ya existe")}
		}
		return CategoryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return CategoryResult{Data: cat}
}

// DeleteCategory removes the category from the managed list. Expenses keep their
// category text (history is preserved); the name simply stops being offered.
func (s *FinanceService) DeleteCategory(ctx context.Context, id int64) OpResult {
	if _, err := s.db.NewDelete().Model((*Category)(nil)).Where("id = ?", id).Exec(ctx); err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return OpResult{}
}

// ---------- incomes (extras / bonos) ----------

func (s *FinanceService) ListIncomes(ctx context.Context, period string) ([]Income, error) {
	var incomes []Income
	err := s.db.NewSelect().Model(&incomes).Where("period = ?", period).Order("created_at ASC").Scan(ctx)
	return incomes, err
}

func (s *FinanceService) CreateIncome(ctx context.Context, period, description, amount string) IncomeResult {
	if !validPeriod(period) {
		return IncomeResult{Error: shared.NewError(shared.ErrValidation, "período inválido (use YYYY-MM)")}
	}
	if strings.TrimSpace(description) == "" {
		return IncomeResult{Error: shared.NewError(shared.ErrValidation, "la descripción es obligatoria")}
	}
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return IncomeResult{Error: aerr}
	}
	inc := &Income{Period: period, Description: strings.TrimSpace(description), Amount: amt}
	if _, err := s.db.NewInsert().Model(inc).Returning("*").Exec(ctx); err != nil {
		return IncomeResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return IncomeResult{Data: inc}
}

func (s *FinanceService) DeleteIncome(ctx context.Context, id int64) OpResult {
	if _, err := s.db.NewDelete().Model((*Income)(nil)).Where("id = ?", id).Exec(ctx); err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return OpResult{}
}

// ---------- expenses + installments ----------

func (s *FinanceService) ListExpenses(ctx context.Context, period string) ([]Expense, error) {
	// Expenses that have at least one installment in the given period.
	var expenses []Expense
	err := s.db.NewSelect().Model(&expenses).
		Where("id IN (SELECT expense_id FROM installments WHERE period = ?)", period).
		Order("date DESC").Scan(ctx)
	return expenses, err
}

// billingDayFor returns the cutoff day to use for an expense: the card's billing
// day when on a card, or 0 (no roll) for cash/debit expenses.
func (s *FinanceService) billingDayFor(ctx context.Context, cardID *int64) (int, *shared.AppError) {
	if cardID == nil {
		return 0, nil
	}
	card := new(Card)
	if err := s.db.NewSelect().Model(card).Where("id = ?", *cardID).Scan(ctx); err != nil {
		return 0, shared.NewError(shared.ErrValidation, "la tarjeta indicada no existe")
	}
	return card.BillingDay, nil
}

func (s *FinanceService) CreateExpense(
	ctx context.Context, dateStr, description, category string,
	cardID *int64, kind, installmentAmount string, installmentsTotal int,
) ExpenseResult {
	ex, aerr := s.validateExpense(ctx, dateStr, description, category, cardID, kind, installmentAmount, installmentsTotal)
	if aerr != nil {
		return ExpenseResult{Error: aerr}
	}
	billingDay, aerr := s.billingDayFor(ctx, cardID)
	if aerr != nil {
		return ExpenseResult{Error: aerr}
	}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewInsert().Model(ex).Returning("*").Exec(ctx); err != nil {
			return err
		}
		return generateInstallments(ctx, tx, ex, billingDay, 0)
	})
	if err != nil {
		return ExpenseResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return ExpenseResult{Data: ex}
}

func (s *FinanceService) UpdateExpense(
	ctx context.Context, id int64, dateStr, description, category string,
	cardID *int64, kind, installmentAmount string, installmentsTotal int,
) ExpenseResult {
	ex, aerr := s.validateExpense(ctx, dateStr, description, category, cardID, kind, installmentAmount, installmentsTotal)
	if aerr != nil {
		return ExpenseResult{Error: aerr}
	}
	ex.ID = id
	billingDay, aerr := s.billingDayFor(ctx, cardID)
	if aerr != nil {
		return ExpenseResult{Error: aerr}
	}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		// Preserve how many installments were already paid, then regenerate.
		paidCount, err := tx.NewSelect().Model((*Installment)(nil)).
			Where("expense_id = ? AND status = ?", id, StatusPagado).Count(ctx)
		if err != nil {
			return err
		}
		res, err := tx.NewUpdate().Model(ex).
			Column("date", "description", "category", "card_id", "kind", "installment_amount", "installments_total").
			WherePK().Exec(ctx)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return shared.NewError(shared.ErrNotFound, "gasto no encontrado")
		}
		if _, err := tx.NewDelete().Model((*Installment)(nil)).Where("expense_id = ?", id).Exec(ctx); err != nil {
			return err
		}
		return generateInstallments(ctx, tx, ex, billingDay, paidCount)
	})
	if err != nil {
		if ae, ok := err.(*shared.AppError); ok {
			return ExpenseResult{Error: ae}
		}
		return ExpenseResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return ExpenseResult{Data: ex}
}

func (s *FinanceService) DeleteExpense(ctx context.Context, id int64) OpResult {
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewDelete().Model((*Installment)(nil)).Where("expense_id = ?", id).Exec(ctx); err != nil {
			return err
		}
		_, err := tx.NewDelete().Model((*Expense)(nil)).Where("id = ?", id).Exec(ctx)
		return err
	})
	if err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return OpResult{}
}

func (s *FinanceService) validateExpense(
	ctx context.Context, dateStr, description, category string,
	cardID *int64, kind, installmentAmount string, installmentsTotal int,
) (*Expense, *shared.AppError) {
	if strings.TrimSpace(description) == "" {
		return nil, shared.NewError(shared.ErrValidation, "la descripción es obligatoria")
	}
	date, derr := parseDate(dateStr)
	if derr != nil {
		return nil, derr
	}
	amt, aerr := parseAmount(installmentAmount)
	if aerr != nil {
		return nil, aerr
	}
	if amt.IsZero() {
		return nil, shared.NewError(shared.ErrValidation, "el monto debe ser mayor a 0")
	}
	switch kind {
	case KindUnico:
		installmentsTotal = 1
	case KindCuotas:
		if installmentsTotal < 1 {
			return nil, shared.NewError(shared.ErrValidation, "las cuotas totales deben ser al menos 1")
		}
	default:
		return nil, shared.NewError(shared.ErrValidation, "tipo inválido (use 'unico' o 'cuotas')")
	}
	return &Expense{
		Date:              date,
		Description:       strings.TrimSpace(description),
		Category:          strings.TrimSpace(category),
		CardID:            cardID,
		Kind:              kind,
		InstallmentAmount: amt,
		InstallmentsTotal: installmentsTotal,
	}, nil
}

// generateInstallments creates one row per cuota. The first paidCount cuotas are
// marked pagado (used to preserve progress across an edit).
func generateInstallments(ctx context.Context, tx bun.Tx, ex *Expense, billingDay, paidCount int) error {
	total := ex.InstallmentsTotal
	if ex.Kind == KindUnico {
		total = 1
	}
	first := periodOf(ex.Date, billingDay)
	now := time.Now()
	insts := make([]Installment, 0, total)
	for i := 0; i < total; i++ {
		inst := Installment{
			ExpenseID: ex.ID,
			Number:    i + 1,
			Total:     total,
			Period:    addMonths(first, i),
			Amount:    ex.InstallmentAmount,
			Status:    StatusPendiente,
		}
		if i < paidCount {
			inst.Status = StatusPagado
			paidAt := now
			inst.PaidAt = &paidAt
		}
		insts = append(insts, inst)
	}
	_, err := tx.NewInsert().Model(&insts).Exec(ctx)
	return err
}

func (s *FinanceService) SetInstallmentPaid(ctx context.Context, id int64, paid bool) OpResult {
	q := s.db.NewUpdate().Model((*Installment)(nil)).Where("id = ?", id)
	if paid {
		q = q.Set("status = ?", StatusPagado).Set("paid_at = ?", time.Now())
	} else {
		q = q.Set("status = ?", StatusPendiente).Set("paid_at = NULL")
	}
	if _, err := q.Exec(ctx); err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return OpResult{}
}

// ---------- fixed expenses (recurring) ----------

// loadFixed returns every fixed expense plus its amount history grouped by id.
func (s *FinanceService) loadFixed(ctx context.Context) ([]FixedExpense, map[int64][]FixedExpenseAmount, error) {
	var fixed []FixedExpense
	if err := s.db.NewSelect().Model(&fixed).Scan(ctx); err != nil {
		return nil, nil, err
	}
	byID := map[int64][]FixedExpenseAmount{}
	if len(fixed) > 0 {
		var amounts []FixedExpenseAmount
		if err := s.db.NewSelect().Model(&amounts).Scan(ctx); err != nil {
			return nil, nil, err
		}
		for _, a := range amounts {
			byID[a.FixedExpenseID] = append(byID[a.FixedExpenseID], a)
		}
	}
	return fixed, byID, nil
}

// fixedChargesFor builds the movimientos for every fixed expense billed in `period`,
// resolving the amount in effect and the paid/pending status for that month.
func (s *FinanceService) fixedChargesFor(ctx context.Context, period string) ([]Movimiento, error) {
	fixed, amountsByID, err := s.loadFixed(ctx)
	if err != nil {
		return nil, err
	}
	var pays []FixedExpensePayment
	if err := s.db.NewSelect().Model(&pays).Where("period = ?", period).Scan(ctx); err != nil {
		return nil, err
	}
	paid := make(map[int64]bool, len(pays))
	for _, p := range pays {
		paid[p.FixedExpenseID] = true
	}

	out := make([]Movimiento, 0, len(fixed))
	for _, fe := range fixed {
		if !fe.activeIn(period) {
			continue
		}
		status := StatusPendiente
		if paid[fe.ID] {
			status = StatusPagado
		}
		id := fe.ID
		out = append(out, Movimiento{
			Source:      SourceFijo,
			FixedID:     &id,
			Description: fe.Description,
			Category:    fe.Category,
			CardID:      fe.CardID,
			Kind:        SourceFijo,
			Number:      1,
			Total:       1,
			Amount:      resolveFixedAmount(amountsByID[fe.ID], period),
			Status:      status,
		})
	}
	return out, nil
}

// sumFixedBefore totals every fixed-expense charge for all months strictly before
// `period`, used to carry the running balance forward.
func (s *FinanceService) sumFixedBefore(ctx context.Context, period string) (types.Decimal, error) {
	fixed, amountsByID, err := s.loadFixed(ctx)
	if err != nil {
		return types.Zero(), err
	}
	total := types.Zero()
	last := addMonths(period, -1) // último mes a considerar (inclusive)
	for _, fe := range fixed {
		end := last
		if fe.EndPeriod != "" && fe.EndPeriod < end {
			end = fe.EndPeriod
		}
		for m := fe.StartPeriod; m <= end; m = addMonths(m, 1) {
			total = total.Add(resolveFixedAmount(amountsByID[fe.ID], m))
		}
	}
	return total, nil
}

func (s *FinanceService) ListFixedExpenses(ctx context.Context) ([]FixedExpenseView, error) {
	fixed, amountsByID, err := s.loadFixed(ctx)
	if err != nil {
		return nil, err
	}
	cards, err := s.ListCards(ctx)
	if err != nil {
		return nil, err
	}
	cardByID := make(map[int64]Card, len(cards))
	for _, c := range cards {
		cardByID[c.ID] = c
	}
	now := currentPeriod()
	out := make([]FixedExpenseView, 0, len(fixed))
	for _, fe := range fixed {
		// Future-dated subscriptions resolve at their start so the configured amount shows.
		at := now
		if fe.StartPeriod > at {
			at = fe.StartPeriod
		}
		v := FixedExpenseView{
			FixedExpense:  fe,
			CurrentAmount: resolveFixedAmount(amountsByID[fe.ID], at),
			Active:        fe.activeIn(now),
		}
		if fe.CardID != nil {
			if c, ok := cardByID[*fe.CardID]; ok {
				v.CardName = c.Name
			}
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Description < out[j].Description })
	return out, nil
}

func (s *FinanceService) CreateFixedExpense(
	ctx context.Context, description, category string, cardID *int64, startPeriod, amount string,
) FixedExpenseResult {
	desc := strings.TrimSpace(description)
	if desc == "" {
		return FixedExpenseResult{Error: shared.NewError(shared.ErrValidation, "la descripción es obligatoria")}
	}
	if !validPeriod(startPeriod) {
		return FixedExpenseResult{Error: shared.NewError(shared.ErrValidation, "período inicial inválido (use YYYY-MM)")}
	}
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return FixedExpenseResult{Error: aerr}
	}
	if amt.IsZero() {
		return FixedExpenseResult{Error: shared.NewError(shared.ErrValidation, "el monto debe ser mayor a 0")}
	}
	if cardID != nil {
		if _, aerr := s.billingDayFor(ctx, cardID); aerr != nil {
			return FixedExpenseResult{Error: aerr}
		}
	}
	fe := &FixedExpense{
		Description: desc,
		Category:    strings.TrimSpace(category),
		CardID:      cardID,
		StartPeriod: startPeriod,
	}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewInsert().Model(fe).Returning("*").Exec(ctx); err != nil {
			return err
		}
		row := &FixedExpenseAmount{FixedExpenseID: fe.ID, EffectiveFrom: startPeriod, Amount: amt}
		_, err := tx.NewInsert().Model(row).Exec(ctx)
		return err
	})
	if err != nil {
		return FixedExpenseResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return FixedExpenseResult{Data: fe}
}

func (s *FinanceService) UpdateFixedExpense(
	ctx context.Context, id int64, description, category string, cardID *int64,
) FixedExpenseResult {
	desc := strings.TrimSpace(description)
	if desc == "" {
		return FixedExpenseResult{Error: shared.NewError(shared.ErrValidation, "la descripción es obligatoria")}
	}
	if cardID != nil {
		if _, aerr := s.billingDayFor(ctx, cardID); aerr != nil {
			return FixedExpenseResult{Error: aerr}
		}
	}
	fe := &FixedExpense{ID: id, Description: desc, Category: strings.TrimSpace(category), CardID: cardID}
	res, err := s.db.NewUpdate().Model(fe).
		Column("description", "category", "card_id").WherePK().Exec(ctx)
	if err != nil {
		return FixedExpenseResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return FixedExpenseResult{Error: shared.NewError(shared.ErrNotFound, "gasto fijo no encontrado")}
	}
	return FixedExpenseResult{Data: fe}
}

// SetFixedExpenseAmount sets the amount effective from `fromPeriod` onward without
// touching earlier months (the "edit this month onward" semantics).
func (s *FinanceService) SetFixedExpenseAmount(ctx context.Context, id int64, fromPeriod, amount string) OpResult {
	if !validPeriod(fromPeriod) {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "período inválido (use YYYY-MM)")}
	}
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return OpResult{Error: aerr}
	}
	if amt.IsZero() {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "el monto debe ser mayor a 0")}
	}
	row := &FixedExpenseAmount{FixedExpenseID: id, EffectiveFrom: fromPeriod, Amount: amt}
	if _, err := s.db.NewInsert().Model(row).
		On("CONFLICT (fixed_expense_id, effective_from) DO UPDATE").
		Set("amount = EXCLUDED.amount").Exec(ctx); err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return OpResult{}
}

// EndFixedExpense cancels a fixed expense starting at `fromPeriod`: the last billed
// month becomes the month right before it. Earlier months stay intact.
func (s *FinanceService) EndFixedExpense(ctx context.Context, id int64, fromPeriod string) OpResult {
	if !validPeriod(fromPeriod) {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "período inválido (use YYYY-MM)")}
	}
	end := addMonths(fromPeriod, -1)
	res, err := s.db.NewUpdate().Model((*FixedExpense)(nil)).
		Set("end_period = ?", end).Where("id = ?", id).Exec(ctx)
	if err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return OpResult{Error: shared.NewError(shared.ErrNotFound, "gasto fijo no encontrado")}
	}
	return OpResult{}
}

func (s *FinanceService) DeleteFixedExpense(ctx context.Context, id int64) OpResult {
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewDelete().Model((*FixedExpenseAmount)(nil)).Where("fixed_expense_id = ?", id).Exec(ctx); err != nil {
			return err
		}
		if _, err := tx.NewDelete().Model((*FixedExpensePayment)(nil)).Where("fixed_expense_id = ?", id).Exec(ctx); err != nil {
			return err
		}
		_, err := tx.NewDelete().Model((*FixedExpense)(nil)).Where("id = ?", id).Exec(ctx)
		return err
	})
	if err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return OpResult{}
}

// SetFixedExpensePaid marks (or unmarks) a fixed expense as paid for a single month.
func (s *FinanceService) SetFixedExpensePaid(ctx context.Context, id int64, period string, paid bool) OpResult {
	if !validPeriod(period) {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "período inválido (use YYYY-MM)")}
	}
	if paid {
		now := time.Now()
		row := &FixedExpensePayment{FixedExpenseID: id, Period: period, PaidAt: &now}
		if _, err := s.db.NewInsert().Model(row).
			On("CONFLICT (fixed_expense_id, period) DO UPDATE").
			Set("paid_at = EXCLUDED.paid_at").Exec(ctx); err != nil {
			return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
		}
		return OpResult{}
	}
	if _, err := s.db.NewDelete().Model((*FixedExpensePayment)(nil)).
		Where("fixed_expense_id = ? AND period = ?", id, period).Exec(ctx); err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return OpResult{}
}

// ---------- summaries ----------

// cumulativeBalanceBefore returns the running account balance left over from
// every period strictly before `period`: Σ salaries + Σ extras − Σ gastos. This
// is the amount that carries (positive or negative) into the given month. Sums
// are done in Go with types.Decimal — never SQLite SUM() over TEXT columns.
func (s *FinanceService) cumulativeBalanceBefore(ctx context.Context, period string) (types.Decimal, error) {
	total := types.Zero()

	var salaries []PeriodSalary
	if err := s.db.NewSelect().Model(&salaries).Where("period < ?", period).Scan(ctx); err != nil {
		return types.Zero(), err
	}
	for _, sal := range salaries {
		total = total.Add(sal.Amount)
	}

	var incomes []Income
	if err := s.db.NewSelect().Model(&incomes).Where("period < ?", period).Scan(ctx); err != nil {
		return types.Zero(), err
	}
	for _, inc := range incomes {
		total = total.Add(inc.Amount)
	}

	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).Where("period < ?", period).Scan(ctx); err != nil {
		return types.Zero(), err
	}
	for _, inst := range insts {
		total = total.Sub(inst.Amount)
	}

	// Recurring fixed expenses charged in every month before `period`.
	fixedTotal, err := s.sumFixedBefore(ctx, period)
	if err != nil {
		return types.Zero(), err
	}
	total = total.Sub(fixedTotal)

	return total, nil
}

func (s *FinanceService) MonthlySummary(ctx context.Context, period string) MonthlySummaryResult {
	if !validPeriod(period) {
		return MonthlySummaryResult{Error: shared.NewError(shared.ErrValidation, "período inválido (use YYYY-MM)")}
	}

	salary, err := s.salaryFor(ctx, period)
	if err != nil {
		return MonthlySummaryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	acumulado, err := s.cumulativeBalanceBefore(ctx, period)
	if err != nil {
		return MonthlySummaryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}

	incomes, err := s.ListIncomes(ctx, period)
	if err != nil {
		return MonthlySummaryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}

	cards, err := s.ListCards(ctx)
	if err != nil {
		return MonthlySummaryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	cardByID := make(map[int64]Card, len(cards))
	for _, c := range cards {
		cardByID[c.ID] = c
	}

	// Installments billed this period (with their expense joined in).
	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).Relation("Expense").
		Where("inst.period = ?", period).Order("inst.id ASC").Scan(ctx); err != nil {
		return MonthlySummaryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}

	sum := &MonthlySummary{
		Period:       period,
		Salary:       salary,
		Acumulado:    acumulado,
		Extras:       types.Zero(),
		Gastos:       types.Zero(),
		Pendiente:    types.Zero(),
		Pagado:       types.Zero(),
		Movimientos:  []Movimiento{},
		PorCategoria: []CategoryTotal{},
		PorTarjeta:   []CardDebt{},
		Incomes:      incomes,
	}
	for _, inc := range incomes {
		sum.Extras = sum.Extras.Add(inc.Amount)
	}
	sum.Ingresos = sum.Salary.Add(sum.Extras)
	sum.Disponible = sum.Acumulado.Add(sum.Ingresos)

	catTotals := map[string]types.Decimal{}
	gastoMesByCard := map[int64]types.Decimal{}
	for _, inst := range insts {
		ex := inst.Expense
		mv := Movimiento{
			Source:        SourceCuota,
			InstallmentID: inst.ID,
			Number:        inst.Number,
			Total:         inst.Total,
			Amount:        inst.Amount,
			Status:        inst.Status,
		}
		cat := "Sin categoría"
		if ex != nil {
			mv.ExpenseID = ex.ID
			mv.Description = ex.Description
			mv.Category = ex.Category
			mv.CardID = ex.CardID
			mv.Kind = ex.Kind
			mv.Date = &ex.Date
			if ex.Category != "" {
				cat = ex.Category
			}
			if ex.CardID != nil {
				if c, ok := cardByID[*ex.CardID]; ok {
					mv.CardName = c.Name
				}
				gastoMesByCard[*ex.CardID] = gastoMesByCard[*ex.CardID].Add(inst.Amount)
			}
		}
		mv.Category = cat
		sum.Movimientos = append(sum.Movimientos, mv)
		sum.Gastos = sum.Gastos.Add(inst.Amount)
		if inst.Status == StatusPagado {
			sum.Pagado = sum.Pagado.Add(inst.Amount)
		} else {
			sum.Pendiente = sum.Pendiente.Add(inst.Amount)
		}
		catTotals[cat] = catTotals[cat].Add(inst.Amount)
	}

	// Recurring fixed expenses billed this month (subscriptions, services). They
	// fold into the same totals/movimientos as installments.
	fixedMovs, err := s.fixedChargesFor(ctx, period)
	if err != nil {
		return MonthlySummaryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	for _, mv := range fixedMovs {
		cat := "Sin categoría"
		if mv.Category != "" {
			cat = mv.Category
		}
		mv.Category = cat
		if mv.CardID != nil {
			if c, ok := cardByID[*mv.CardID]; ok {
				mv.CardName = c.Name
			}
			gastoMesByCard[*mv.CardID] = gastoMesByCard[*mv.CardID].Add(mv.Amount)
		}
		sum.Movimientos = append(sum.Movimientos, mv)
		sum.Gastos = sum.Gastos.Add(mv.Amount)
		if mv.Status == StatusPagado {
			sum.Pagado = sum.Pagado.Add(mv.Amount)
		} else {
			sum.Pendiente = sum.Pendiente.Add(mv.Amount)
		}
		catTotals[cat] = catTotals[cat].Add(mv.Amount)
	}

	sum.Balance = sum.Disponible.Sub(sum.Gastos)
	sum.Alcanza = sum.Disponible.GTE(sum.Gastos)
	sum.PorCategoria = sortedCategoryTotals(catTotals)

	// Cupo usado per card = all PENDING installments across every period.
	cupoUsado, err := s.pendingByCard(ctx)
	if err != nil {
		return MonthlySummaryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	for _, c := range cards {
		used := cupoUsado[c.ID]
		sum.PorTarjeta = append(sum.PorTarjeta, CardDebt{
			Card:           c,
			GastoMes:       gastoMesByCard[c.ID],
			CupoUsado:      used,
			CupoDisponible: c.CreditLimit.Sub(used),
		})
	}

	return MonthlySummaryResult{Data: sum}
}

// pendingByCard sums all pending installments grouped by their expense's card.
func (s *FinanceService) pendingByCard(ctx context.Context) (map[int64]types.Decimal, error) {
	var pend []Installment
	if err := s.db.NewSelect().Model(&pend).Relation("Expense").
		Where("inst.status = ?", StatusPendiente).Scan(ctx); err != nil {
		return nil, err
	}
	out := map[int64]types.Decimal{}
	for _, inst := range pend {
		if inst.Expense != nil && inst.Expense.CardID != nil {
			id := *inst.Expense.CardID
			out[id] = out[id].Add(inst.Amount)
		}
	}
	return out, nil
}

func (s *FinanceService) YearSummary(ctx context.Context, year int) YearSummaryResult {
	if year < 2000 || year > 3000 {
		return YearSummaryResult{Error: shared.NewError(shared.ErrValidation, "año inválido")}
	}
	prefix := itoa4(year) + "-"

	// Carry-in from every period before this year.
	saldo, err := s.cumulativeBalanceBefore(ctx, prefix+"01")
	if err != nil {
		return YearSummaryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}

	var salaries []PeriodSalary
	if err := s.db.NewSelect().Model(&salaries).Where("period LIKE ?", prefix+"%").Scan(ctx); err != nil {
		return YearSummaryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	salaryByMonth := map[string]types.Decimal{}
	for _, sal := range salaries {
		salaryByMonth[sal.Period] = sal.Amount
	}

	var incomes []Income
	if err := s.db.NewSelect().Model(&incomes).Where("period LIKE ?", prefix+"%").Scan(ctx); err != nil {
		return YearSummaryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).Relation("Expense").
		Where("inst.period LIKE ?", prefix+"%").Scan(ctx); err != nil {
		return YearSummaryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}

	extrasByMonth := map[string]types.Decimal{}
	for _, inc := range incomes {
		extrasByMonth[inc.Period] = extrasByMonth[inc.Period].Add(inc.Amount)
	}
	gastosByMonth := map[string]types.Decimal{}
	catTotals := map[string]types.Decimal{}
	for _, inst := range insts {
		gastosByMonth[inst.Period] = gastosByMonth[inst.Period].Add(inst.Amount)
		cat := "Sin categoría"
		if inst.Expense != nil && inst.Expense.Category != "" {
			cat = inst.Expense.Category
		}
		catTotals[cat] = catTotals[cat].Add(inst.Amount)
	}

	// Fold recurring fixed expenses into each month's gastos and the category totals.
	fixed, amountsByID, err := s.loadFixed(ctx)
	if err != nil {
		return YearSummaryResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	for m := 1; m <= 12; m++ {
		period := prefix + pad2(m)
		for _, fe := range fixed {
			if !fe.activeIn(period) {
				continue
			}
			amt := resolveFixedAmount(amountsByID[fe.ID], period)
			gastosByMonth[period] = gastosByMonth[period].Add(amt)
			cat := "Sin categoría"
			if fe.Category != "" {
				cat = fe.Category
			}
			catTotals[cat] = catTotals[cat].Add(amt)
		}
	}

	out := &YearSummary{
		Year:          year,
		Months:        make([]YearMonth, 0, 12),
		TotalIngresos: types.Zero(),
		TotalGastos:   types.Zero(),
		TotalBalance:  types.Zero(),
	}
	for m := 1; m <= 12; m++ {
		period := prefix + pad2(m)
		ingresos := salaryByMonth[period].Add(extrasByMonth[period])
		gastos := gastosByMonth[period]
		balance := ingresos.Sub(gastos)
		saldo = saldo.Add(balance) // running account balance at month close
		out.Months = append(out.Months, YearMonth{
			Period:   period,
			Ingresos: ingresos,
			Gastos:   gastos,
			Balance:  balance,
			Saldo:    saldo,
			Alcanza:  saldo.GTE(types.Zero()),
		})
		out.TotalIngresos = out.TotalIngresos.Add(ingresos)
		out.TotalGastos = out.TotalGastos.Add(gastos)
	}
	out.TotalBalance = out.TotalIngresos.Sub(out.TotalGastos)
	out.PorCategoria = sortedCategoryTotals(catTotals)
	return YearSummaryResult{Data: out}
}

// ---------- small helpers ----------

// The zero value of types.Decimal already behaves as 0 (shopspring initialises a
// nil big.Int to zero on use), so map lookups for a missing key are safe to add.

func sortedCategoryTotals(m map[string]types.Decimal) []CategoryTotal {
	out := make([]CategoryTotal, 0, len(m))
	for cat, total := range m {
		out = append(out, CategoryTotal{Category: cat, Total: total})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Total.Decimal.Cmp(out[j].Total.Decimal) > 0
	})
	return out
}

func pad2(n int) string  { return fmt.Sprintf("%02d", n) }
func itoa4(n int) string { return fmt.Sprintf("%04d", n) }

// isUniqueViolation reports whether err is a SQLite UNIQUE constraint failure
// (the categories.name index). Matched by message to stay driver-agnostic.
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}
