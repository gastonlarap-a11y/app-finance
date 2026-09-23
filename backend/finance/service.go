package finance

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
	"github.com/gastonlarap-a11y/app-finance/backend/users"
)

// FinanceService is the Wails v3 service for the whole finance domain. Public
// methods are auto-bound to TypeScript by `wails3 generate bindings`. Every query
// is scoped to the active user (session.Active()) so each profile sees only its data.
//
// Each bound method reads the active user id ONCE (uid := s.uid()) and threads it
// through its helpers, so a concurrent SwitchUser can never mix two profiles'
// rows within a single call.
type FinanceService struct {
	db      *bun.DB
	session *users.Session
}

func NewFinanceService(db *bun.DB, session *users.Session) *FinanceService {
	return &FinanceService{db: db, session: session}
}

func (s *FinanceService) ServiceName() string { return "FinanceService" }

// uid is the active user id; every query filters/sets user_id with it.
func (s *FinanceService) uid() int64 { return s.session.Active() }

// ---------- helpers ----------

// uncategorized is the bucket for expenses without a category.
const uncategorized = "Sin categoría"

func categoryOrDefault(c string) string {
	if c == "" {
		return uncategorized
	}
	return c
}

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

func invalidPeriod() *shared.AppError {
	return shared.NewError(shared.ErrValidation, "período inválido (use YYYY-MM)")
}

// internalErr wraps a system error for a Result's Error field.
func internalErr(err error) *shared.AppError {
	return shared.NewError(shared.ErrInternal, err.Error())
}

// appErr surfaces an *AppError raised inside a transaction as-is, and wraps any
// other error as internal.
func appErr(err error) *shared.AppError {
	if ae, ok := errors.AsType[*shared.AppError](err); ok {
		return ae
	}
	return internalErr(err)
}

// requireOne turns an Exec outcome into a Result error: a system error becomes
// ErrInternal and zero affected rows becomes ErrNotFound with notFoundMsg.
func requireOne(res sql.Result, err error, notFoundMsg string) *shared.AppError {
	if err != nil {
		return internalErr(err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return internalErr(err)
	}
	if n == 0 {
		return shared.NewError(shared.ErrNotFound, notFoundMsg)
	}
	return nil
}

// softDelete soft-deletes one of the user's rows (bun turns the DELETE into
// UPDATE deleted_at); deleting a missing or already-deleted row is NotFound.
func (s *FinanceService) softDelete(ctx context.Context, model any, id int64, notFoundMsg string) OpResult {
	res, err := s.db.NewDelete().Model(model).Where("id = ? AND user_id = ?", id, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, notFoundMsg)}
}

// restore undoes a soft delete. conflictMsg, when set, maps a UNIQUE violation
// (an active row now uses the same name) to ErrConflict.
func (s *FinanceService) restore(ctx context.Context, model any, id int64, notFoundMsg, conflictMsg string) OpResult {
	res, err := s.db.NewUpdate().Model(model).WhereAllWithDeleted().
		Set("deleted_at = NULL").Where("id = ? AND user_id = ? AND deleted_at IS NOT NULL", id, s.uid()).Exec(ctx)
	if err != nil && conflictMsg != "" && isUniqueViolation(err) {
		return OpResult{Error: shared.NewError(shared.ErrConflict, conflictMsg)}
	}
	return OpResult{Error: requireOne(res, err, notFoundMsg)}
}

// ---------- settings ----------

func (s *FinanceService) GetSettings(ctx context.Context) SettingsResult {
	st := new(Settings)
	if err := s.db.NewSelect().Model(st).Where("id = 1").Scan(ctx); err != nil {
		return SettingsResult{Error: internalErr(err)}
	}
	return SettingsResult{Data: st}
}

// ---------- salary (per month) ----------

// salaryFor returns the salary saved for a period, or zero when none is set.
func (s *FinanceService) salaryFor(ctx context.Context, uid int64, period string) (types.Decimal, error) {
	ps := new(PeriodSalary)
	err := s.db.NewSelect().Model(ps).Where("user_id = ? AND period = ?", uid, period).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return types.Zero(), nil
	}
	if err != nil {
		return types.Zero(), err
	}
	return ps.Amount, nil
}

func (s *FinanceService) GetSalary(ctx context.Context, period string) SalaryResult {
	if !validPeriod(period) {
		return SalaryResult{Error: invalidPeriod()}
	}
	amt, err := s.salaryFor(ctx, s.uid(), period)
	if err != nil {
		return SalaryResult{Error: internalErr(err)}
	}
	return SalaryResult{Data: &PeriodSalary{Period: period, Amount: amt}}
}

func (s *FinanceService) SetSalary(ctx context.Context, period, amount string) SalaryResult {
	if !validPeriod(period) {
		return SalaryResult{Error: invalidPeriod()}
	}
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return SalaryResult{Error: aerr}
	}
	ps := &PeriodSalary{UserID: s.uid(), Period: period, Amount: amt}
	if _, err := s.db.NewInsert().Model(ps).
		On("CONFLICT (user_id, period) DO UPDATE").
		Set("amount = EXCLUDED.amount").Exec(ctx); err != nil {
		return SalaryResult{Error: internalErr(err)}
	}
	return SalaryResult{Data: ps}
}

// ---------- cards ----------

func (s *FinanceService) ListCards(ctx context.Context) ([]Card, error) {
	return s.listCards(ctx, s.uid())
}

func (s *FinanceService) listCards(ctx context.Context, uid int64) ([]Card, error) {
	var cards []Card
	err := s.db.NewSelect().Model(&cards).Where("user_id = ?", uid).Order("name ASC").Scan(ctx)
	return cards, err
}

// normalizeBillingDay keeps the cutoff day in 1..28 (every month has it),
// falling back to the 24th.
func normalizeBillingDay(day int) int {
	if day < 1 || day > 28 {
		return 24
	}
	return day
}

func (s *FinanceService) CreateCard(ctx context.Context, name, creditLimit string, billingDay int) CardResult {
	if strings.TrimSpace(name) == "" {
		return CardResult{Error: shared.NewError(shared.ErrValidation, "el nombre es obligatorio")}
	}
	limit, aerr := parseAmount(creditLimit)
	if aerr != nil {
		return CardResult{Error: aerr}
	}
	card := &Card{UserID: s.uid(), Name: strings.TrimSpace(name), CreditLimit: limit, BillingDay: normalizeBillingDay(billingDay)}
	if _, err := s.db.NewInsert().Model(card).Returning("*").Exec(ctx); err != nil {
		return CardResult{Error: internalErr(err)}
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
	uid := s.uid()
	card := new(Card)
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		res, err := tx.NewUpdate().Model((*Card)(nil)).
			Set("name = ?", strings.TrimSpace(name)).
			Set("credit_limit = ?", limit).
			Set("billing_day = ?", normalizeBillingDay(billingDay)).
			Where("id = ? AND user_id = ?", id, uid).Exec(ctx)
		if aerr := requireOne(res, err, "tarjeta no encontrada"); aerr != nil {
			return aerr
		}
		return tx.NewSelect().Model(card).Where("id = ? AND user_id = ?", id, uid).Scan(ctx)
	})
	if err != nil {
		return CardResult{Error: appErr(err)}
	}
	return CardResult{Data: card}
}

// DeleteCard soft-deletes the card. Expenses keep their card_id pointing at it so
// history (e.g. the card's name on old movimientos) survives; see cardMapAll.
func (s *FinanceService) DeleteCard(ctx context.Context, id int64) OpResult {
	return s.softDelete(ctx, (*Card)(nil), id, "tarjeta no encontrada")
}

// RestoreCard undoes a soft delete.
func (s *FinanceService) RestoreCard(ctx context.Context, id int64) OpResult {
	return s.restore(ctx, (*Card)(nil), id, "tarjeta no encontrada", "")
}

// cardMapAll returns every card (including soft-deleted ones) keyed by id, for
// resolving a card's name on historical movimientos even after it was deleted.
func (s *FinanceService) cardMapAll(ctx context.Context, uid int64) (map[int64]Card, error) {
	var cards []Card
	if err := s.db.NewSelect().Model(&cards).WhereAllWithDeleted().Where("user_id = ?", uid).Scan(ctx); err != nil {
		return nil, err
	}
	out := make(map[int64]Card, len(cards))
	for _, c := range cards {
		out[c.ID] = c
	}
	return out, nil
}

// ---------- categories ----------

func (s *FinanceService) ListCategories(ctx context.Context) ([]Category, error) {
	var cats []Category
	err := s.db.NewSelect().Model(&cats).Where("user_id = ?", s.uid()).Order("name ASC").Scan(ctx)
	return cats, err
}

func (s *FinanceService) CreateCategory(ctx context.Context, name string) CategoryResult {
	name = strings.TrimSpace(name)
	if name == "" {
		return CategoryResult{Error: shared.NewError(shared.ErrValidation, "el nombre es obligatorio")}
	}
	cat := &Category{UserID: s.uid(), Name: name}
	if _, err := s.db.NewInsert().Model(cat).Returning("*").Exec(ctx); err != nil {
		if isUniqueViolation(err) {
			return CategoryResult{Error: shared.NewError(shared.ErrValidation, "la categoría ya existe")}
		}
		return CategoryResult{Error: internalErr(err)}
	}
	return CategoryResult{Data: cat}
}

// UpdateCategory renames a category and cascades the new name to every expense
// and fixed expense that used the old name (both store the category as text).
func (s *FinanceService) UpdateCategory(ctx context.Context, id int64, name string) CategoryResult {
	name = strings.TrimSpace(name)
	if name == "" {
		return CategoryResult{Error: shared.NewError(shared.ErrValidation, "el nombre es obligatorio")}
	}
	uid := s.uid()
	cat := new(Category)
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		old := new(Category)
		if err := tx.NewSelect().Model(old).Where("id = ? AND user_id = ?", id, uid).Scan(ctx); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return shared.NewError(shared.ErrNotFound, "categoría no encontrada")
			}
			return err
		}
		if _, err := tx.NewUpdate().Model((*Category)(nil)).
			Set("name = ?", name).Where("id = ? AND user_id = ?", id, uid).Exec(ctx); err != nil {
			return err
		}
		if old.Name != name {
			if _, err := tx.NewUpdate().Model((*Expense)(nil)).
				Set("category = ?", name).Where("category = ? AND user_id = ?", old.Name, uid).Exec(ctx); err != nil {
				return err
			}
			if _, err := tx.NewUpdate().Model((*FixedExpense)(nil)).
				Set("category = ?", name).Where("category = ? AND user_id = ?", old.Name, uid).Exec(ctx); err != nil {
				return err
			}
		}
		return tx.NewSelect().Model(cat).Where("id = ? AND user_id = ?", id, uid).Scan(ctx)
	})
	if err != nil {
		if isUniqueViolation(err) {
			return CategoryResult{Error: shared.NewError(shared.ErrValidation, "la categoría ya existe")}
		}
		return CategoryResult{Error: appErr(err)}
	}
	return CategoryResult{Data: cat}
}

// DeleteCategory removes the category from the managed list. Expenses keep their
// category text (history is preserved); the name simply stops being offered.
func (s *FinanceService) DeleteCategory(ctx context.Context, id int64) OpResult {
	return s.softDelete(ctx, (*Category)(nil), id, "categoría no encontrada")
}

// RestoreCategory undoes a soft delete. Fails with ErrConflict if an active
// category now uses the same name (the unique index only allows one active row).
func (s *FinanceService) RestoreCategory(ctx context.Context, id int64) OpResult {
	return s.restore(ctx, (*Category)(nil), id, "categoría no encontrada", "ya existe una categoría activa con ese nombre")
}

// ---------- merchants (comercios) ----------

func (s *FinanceService) ListMerchants(ctx context.Context) ([]Merchant, error) {
	var mers []Merchant
	err := s.db.NewSelect().Model(&mers).Where("user_id = ?", s.uid()).Order("name ASC").Scan(ctx)
	return mers, err
}

func (s *FinanceService) CreateMerchant(ctx context.Context, name string) MerchantResult {
	name = strings.TrimSpace(name)
	if name == "" {
		return MerchantResult{Error: shared.NewError(shared.ErrValidation, "el nombre es obligatorio")}
	}
	mer := &Merchant{UserID: s.uid(), Name: name}
	if _, err := s.db.NewInsert().Model(mer).Returning("*").Exec(ctx); err != nil {
		if isUniqueViolation(err) {
			return MerchantResult{Error: shared.NewError(shared.ErrValidation, "el comercio ya existe")}
		}
		return MerchantResult{Error: internalErr(err)}
	}
	return MerchantResult{Data: mer}
}

// UpdateMerchant renames a merchant and cascades the new name to every expense
// that used the old name (expenses store the merchant as plain text).
func (s *FinanceService) UpdateMerchant(ctx context.Context, id int64, name string) MerchantResult {
	name = strings.TrimSpace(name)
	if name == "" {
		return MerchantResult{Error: shared.NewError(shared.ErrValidation, "el nombre es obligatorio")}
	}
	uid := s.uid()
	mer := new(Merchant)
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		old := new(Merchant)
		if err := tx.NewSelect().Model(old).Where("id = ? AND user_id = ?", id, uid).Scan(ctx); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return shared.NewError(shared.ErrNotFound, "comercio no encontrado")
			}
			return err
		}
		if _, err := tx.NewUpdate().Model((*Merchant)(nil)).
			Set("name = ?", name).Where("id = ? AND user_id = ?", id, uid).Exec(ctx); err != nil {
			return err
		}
		if old.Name != name {
			if _, err := tx.NewUpdate().Model((*Expense)(nil)).
				Set("merchant = ?", name).Where("merchant = ? AND user_id = ?", old.Name, uid).Exec(ctx); err != nil {
				return err
			}
		}
		return tx.NewSelect().Model(mer).Where("id = ? AND user_id = ?", id, uid).Scan(ctx)
	})
	if err != nil {
		if isUniqueViolation(err) {
			return MerchantResult{Error: shared.NewError(shared.ErrValidation, "el comercio ya existe")}
		}
		return MerchantResult{Error: appErr(err)}
	}
	return MerchantResult{Data: mer}
}

// DeleteMerchant removes the merchant from the managed list. Expenses keep their
// merchant text (history is preserved); the name simply stops being offered.
func (s *FinanceService) DeleteMerchant(ctx context.Context, id int64) OpResult {
	return s.softDelete(ctx, (*Merchant)(nil), id, "comercio no encontrado")
}

// RestoreMerchant undoes a soft delete. Fails with ErrConflict if an active
// merchant now uses the same name (the unique index only allows one active row).
func (s *FinanceService) RestoreMerchant(ctx context.Context, id int64) OpResult {
	return s.restore(ctx, (*Merchant)(nil), id, "comercio no encontrado", "ya existe un comercio activo con ese nombre")
}

// ---------- incomes (extras / bonos) ----------

func (s *FinanceService) ListIncomes(ctx context.Context, period string) ([]Income, error) {
	return s.listIncomes(ctx, s.uid(), period)
}

func (s *FinanceService) listIncomes(ctx context.Context, uid int64, period string) ([]Income, error) {
	var incomes []Income
	err := s.db.NewSelect().Model(&incomes).Where("user_id = ? AND period = ?", uid, period).Order("created_at ASC").Scan(ctx)
	return incomes, err
}

func (s *FinanceService) CreateIncome(ctx context.Context, period, description, amount string) IncomeResult {
	if !validPeriod(period) {
		return IncomeResult{Error: invalidPeriod()}
	}
	if strings.TrimSpace(description) == "" {
		return IncomeResult{Error: shared.NewError(shared.ErrValidation, "la descripción es obligatoria")}
	}
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return IncomeResult{Error: aerr}
	}
	inc := &Income{UserID: s.uid(), Period: period, Description: strings.TrimSpace(description), Amount: amt}
	if _, err := s.db.NewInsert().Model(inc).Returning("*").Exec(ctx); err != nil {
		return IncomeResult{Error: internalErr(err)}
	}
	return IncomeResult{Data: inc}
}

func (s *FinanceService) DeleteIncome(ctx context.Context, id int64) OpResult {
	return s.softDelete(ctx, (*Income)(nil), id, "ingreso no encontrado")
}

// RestoreIncome undoes a soft delete.
func (s *FinanceService) RestoreIncome(ctx context.Context, id int64) OpResult {
	return s.restore(ctx, (*Income)(nil), id, "ingreso no encontrado", "")
}

// ---------- expenses + installments ----------

func (s *FinanceService) ListExpenses(ctx context.Context, period string) ([]Expense, error) {
	// Expenses that have at least one installment in the given period.
	uid := s.uid()
	var expenses []Expense
	err := s.db.NewSelect().Model(&expenses).
		Where("user_id = ?", uid).
		Where("id IN (SELECT expense_id FROM installments WHERE period = ? AND user_id = ?)", period, uid).
		Order("date DESC").Scan(ctx)
	return expenses, err
}

// billingDayFor returns the cutoff day to use for an expense: the card's billing
// day when on a card, or 0 (no roll) for cash/debit expenses.
func (s *FinanceService) billingDayFor(ctx context.Context, uid int64, cardID *int64) (int, *shared.AppError) {
	if cardID == nil {
		return 0, nil
	}
	card := new(Card)
	err := s.db.NewSelect().Model(card).Where("id = ? AND user_id = ?", *cardID, uid).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, shared.NewError(shared.ErrValidation, "la tarjeta indicada no existe")
	}
	if err != nil {
		return 0, internalErr(err)
	}
	return card.BillingDay, nil
}

func (s *FinanceService) CreateExpense(
	ctx context.Context, dateStr, description, category, merchant string,
	cardID *int64, kind, installmentAmount string, installmentsTotal int,
) ExpenseResult {
	uid := s.uid()
	ex, aerr := validateExpense(uid, dateStr, description, category, merchant, cardID, kind, installmentAmount, installmentsTotal)
	if aerr != nil {
		return ExpenseResult{Error: aerr}
	}
	billingDay, aerr := s.billingDayFor(ctx, uid, cardID)
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
		return ExpenseResult{Error: internalErr(err)}
	}
	return ExpenseResult{Data: ex}
}

func (s *FinanceService) UpdateExpense(
	ctx context.Context, id int64, dateStr, description, category, merchant string,
	cardID *int64, kind, installmentAmount string, installmentsTotal int,
) ExpenseResult {
	uid := s.uid()
	ex, aerr := validateExpense(uid, dateStr, description, category, merchant, cardID, kind, installmentAmount, installmentsTotal)
	if aerr != nil {
		return ExpenseResult{Error: aerr}
	}
	ex.ID = id
	billingDay, aerr := s.billingDayFor(ctx, uid, cardID)
	if aerr != nil {
		return ExpenseResult{Error: aerr}
	}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		// Preserve how many installments were already paid, then regenerate.
		paidCount, err := tx.NewSelect().Model((*Installment)(nil)).
			Where("expense_id = ? AND user_id = ? AND status = ?", id, uid, StatusPagado).Count(ctx)
		if err != nil {
			return err
		}
		res, err := tx.NewUpdate().Model(ex).
			Column("date", "description", "category", "merchant", "card_id", "kind", "installment_amount", "installments_total").
			WherePK().Where("user_id = ?", uid).Exec(ctx)
		if aerr := requireOne(res, err, "gasto no encontrado"); aerr != nil {
			return aerr
		}
		if _, err := tx.NewDelete().Model((*Installment)(nil)).Where("expense_id = ? AND user_id = ?", id, uid).Exec(ctx); err != nil {
			return err
		}
		if err := generateInstallments(ctx, tx, ex, billingDay, paidCount); err != nil {
			return err
		}
		return tx.NewSelect().Model(ex).Where("id = ? AND user_id = ?", id, uid).Scan(ctx)
	})
	if err != nil {
		return ExpenseResult{Error: appErr(err)}
	}
	return ExpenseResult{Data: ex}
}

// DeleteExpense soft-deletes the expense. Its installments stay physically
// intact (they have no deleted_at of their own) so restoring brings them all
// back unchanged; queries that sum installments must filter out ones whose
// parent expense is deleted (see the explicit subqueries below).
func (s *FinanceService) DeleteExpense(ctx context.Context, id int64) OpResult {
	return s.softDelete(ctx, (*Expense)(nil), id, "gasto no encontrado")
}

// RestoreExpense undoes a soft delete.
func (s *FinanceService) RestoreExpense(ctx context.Context, id int64) OpResult {
	return s.restore(ctx, (*Expense)(nil), id, "gasto no encontrado", "")
}

func validateExpense(
	uid int64, dateStr, description, category, merchant string,
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
		UserID:            uid,
		Date:              date,
		Description:       strings.TrimSpace(description),
		Category:          strings.TrimSpace(category),
		Merchant:          strings.TrimSpace(merchant),
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
	for i := range total {
		inst := Installment{
			UserID:    ex.UserID,
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
	q := s.db.NewUpdate().Model((*Installment)(nil)).Where("id = ? AND user_id = ?", id, s.uid())
	if paid {
		q = q.Set("status = ?", StatusPagado).Set("paid_at = ?", time.Now())
	} else {
		q = q.Set("status = ?", StatusPendiente).Set("paid_at = NULL")
	}
	res, err := q.Exec(ctx)
	return OpResult{Error: requireOne(res, err, "cuota no encontrada")}
}

// ---------- fixed expenses (recurring) ----------

// loadFixed returns every fixed expense plus its amount history grouped by id.
// deletedOnly selects only soft-deleted fixed expenses (used by ListTrash); the
// amount/payment history tables have no deleted_at of their own and ride along
// with the parent automatically.
func (s *FinanceService) loadFixed(ctx context.Context, uid int64, deletedOnly bool) ([]FixedExpense, map[int64][]FixedExpenseAmount, error) {
	var fixed []FixedExpense
	q := s.db.NewSelect().Model(&fixed).Where("user_id = ?", uid)
	if deletedOnly {
		q = q.WhereDeleted()
	}
	if err := q.Scan(ctx); err != nil {
		return nil, nil, err
	}
	byID := map[int64][]FixedExpenseAmount{}
	if len(fixed) > 0 {
		ids := make([]int64, len(fixed))
		for i, fe := range fixed {
			ids[i] = fe.ID
		}
		var amounts []FixedExpenseAmount
		if err := s.db.NewSelect().Model(&amounts).
			Where("fixed_expense_id IN (?)", bun.List(ids)).Scan(ctx); err != nil {
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
func (s *FinanceService) fixedChargesFor(ctx context.Context, uid int64, period string) ([]Movimiento, error) {
	fixed, amountsByID, err := s.loadFixed(ctx, uid, false)
	if err != nil {
		return nil, err
	}
	var pays []FixedExpensePayment
	if err := s.db.NewSelect().Model(&pays).
		Where("period = ?", period).
		Where("fixed_expense_id IN (SELECT id FROM fixed_expenses WHERE user_id = ?)", uid).
		Scan(ctx); err != nil {
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
			Amount:      resolveAsOf(amountsByID[fe.ID], period),
			Status:      status,
		})
	}
	return out, nil
}

// sumFixedBefore totals every fixed-expense charge for all months strictly before
// `period`, used to carry the running balance forward. Each amount stretch is
// multiplied out (sumAsOf), so the cost does not grow with the months elapsed.
func (s *FinanceService) sumFixedBefore(ctx context.Context, uid int64, period string) (types.Decimal, error) {
	fixed, amountsByID, err := s.loadFixed(ctx, uid, false)
	if err != nil {
		return types.Zero(), err
	}
	total := types.Zero()
	last := addMonths(period, -1) // último mes a considerar (inclusive)
	for _, fe := range fixed {
		if !validPeriod(fe.StartPeriod) {
			continue
		}
		end := last
		if fe.EndPeriod != "" {
			end = min(end, fe.EndPeriod)
		}
		total = total.Add(sumAsOf(amountsByID[fe.ID], fe.StartPeriod, end))
	}
	return total, nil
}

// fixedDisplayPeriod is the month whose amount represents a fixed expense "now":
// today, or its start when it is future-dated (so the configured amount shows).
func fixedDisplayPeriod(fe FixedExpense, now string) string {
	return max(now, fe.StartPeriod)
}

func (s *FinanceService) ListFixedExpenses(ctx context.Context) ([]FixedExpenseView, error) {
	uid := s.uid()
	fixed, amountsByID, err := s.loadFixed(ctx, uid, false)
	if err != nil {
		return nil, err
	}
	// cardMapAll (not ListCards) so a fixed expense still shows the name of a
	// card that was since soft-deleted.
	cardByID, err := s.cardMapAll(ctx, uid)
	if err != nil {
		return nil, err
	}
	now := currentPeriod()
	out := make([]FixedExpenseView, 0, len(fixed))
	for _, fe := range fixed {
		v := FixedExpenseView{
			FixedExpense:  fe,
			CurrentAmount: resolveAsOf(amountsByID[fe.ID], fixedDisplayPeriod(fe, now)),
			Active:        fe.activeIn(now),
		}
		if fe.CardID != nil {
			if c, ok := cardByID[*fe.CardID]; ok {
				v.CardName = c.Name
			}
		}
		out = append(out, v)
	}
	slices.SortFunc(out, func(a, b FixedExpenseView) int { return strings.Compare(a.Description, b.Description) })
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
	uid := s.uid()
	if _, aerr := s.billingDayFor(ctx, uid, cardID); aerr != nil {
		return FixedExpenseResult{Error: aerr}
	}
	fe := &FixedExpense{
		UserID:      uid,
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
		return FixedExpenseResult{Error: internalErr(err)}
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
	uid := s.uid()
	if _, aerr := s.billingDayFor(ctx, uid, cardID); aerr != nil {
		return FixedExpenseResult{Error: aerr}
	}
	fe := &FixedExpense{ID: id, Description: desc, Category: strings.TrimSpace(category), CardID: cardID}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		res, err := tx.NewUpdate().Model(fe).
			Column("description", "category", "card_id").WherePK().Where("user_id = ?", uid).Exec(ctx)
		if aerr := requireOne(res, err, "gasto fijo no encontrado"); aerr != nil {
			return aerr
		}
		return tx.NewSelect().Model(fe).Where("id = ? AND user_id = ?", id, uid).Scan(ctx)
	})
	if err != nil {
		return FixedExpenseResult{Error: appErr(err)}
	}
	return FixedExpenseResult{Data: fe}
}

// ownFixedExpense fails with NotFound unless the (non-deleted) fixed expense id
// belongs to uid. The amount/payment tables carry no user_id of their own, so
// every write to them must pass through this check first.
func ownFixedExpense(ctx context.Context, db bun.IDB, uid, id int64) error {
	ok, err := db.NewSelect().Model((*FixedExpense)(nil)).Where("id = ? AND user_id = ?", id, uid).Exists(ctx)
	if err != nil {
		return err
	}
	if !ok {
		return shared.NewError(shared.ErrNotFound, "gasto fijo no encontrado")
	}
	return nil
}

// SetFixedExpenseAmount sets the amount effective from `fromPeriod` onward without
// touching earlier months (the "edit this month onward" semantics).
func (s *FinanceService) SetFixedExpenseAmount(ctx context.Context, id int64, fromPeriod, amount string) OpResult {
	if !validPeriod(fromPeriod) {
		return OpResult{Error: invalidPeriod()}
	}
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return OpResult{Error: aerr}
	}
	if amt.IsZero() {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "el monto debe ser mayor a 0")}
	}
	uid := s.uid()
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if err := ownFixedExpense(ctx, tx, uid, id); err != nil {
			return err
		}
		row := &FixedExpenseAmount{FixedExpenseID: id, EffectiveFrom: fromPeriod, Amount: amt}
		_, err := tx.NewInsert().Model(row).
			On("CONFLICT (fixed_expense_id, effective_from) DO UPDATE").
			Set("amount = EXCLUDED.amount").Exec(ctx)
		return err
	})
	if err != nil {
		return OpResult{Error: appErr(err)}
	}
	return OpResult{}
}

// EndFixedExpense cancels a fixed expense starting at `fromPeriod`: the last billed
// month becomes the month right before it. Earlier months stay intact.
func (s *FinanceService) EndFixedExpense(ctx context.Context, id int64, fromPeriod string) OpResult {
	if !validPeriod(fromPeriod) {
		return OpResult{Error: invalidPeriod()}
	}
	res, err := s.db.NewUpdate().Model((*FixedExpense)(nil)).
		Set("end_period = ?", addMonths(fromPeriod, -1)).Where("id = ? AND user_id = ?", id, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "gasto fijo no encontrado")}
}

// DeleteFixedExpense soft-deletes the fixed expense. Its amount/payment history
// rows are never touched, so restoring brings the full history back untouched.
func (s *FinanceService) DeleteFixedExpense(ctx context.Context, id int64) OpResult {
	return s.softDelete(ctx, (*FixedExpense)(nil), id, "gasto fijo no encontrado")
}

// RestoreFixedExpense undoes a soft delete.
func (s *FinanceService) RestoreFixedExpense(ctx context.Context, id int64) OpResult {
	return s.restore(ctx, (*FixedExpense)(nil), id, "gasto fijo no encontrado", "")
}

// SetFixedExpensePaid marks (or unmarks) a fixed expense as paid for a single month.
func (s *FinanceService) SetFixedExpensePaid(ctx context.Context, id int64, period string, paid bool) OpResult {
	if !validPeriod(period) {
		return OpResult{Error: invalidPeriod()}
	}
	uid := s.uid()
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if err := ownFixedExpense(ctx, tx, uid, id); err != nil {
			return err
		}
		if paid {
			now := time.Now()
			row := &FixedExpensePayment{FixedExpenseID: id, Period: period, PaidAt: &now}
			_, err := tx.NewInsert().Model(row).
				On("CONFLICT (fixed_expense_id, period) DO UPDATE").
				Set("paid_at = EXCLUDED.paid_at").Exec(ctx)
			return err
		}
		_, err := tx.NewDelete().Model((*FixedExpensePayment)(nil)).
			Where("fixed_expense_id = ? AND period = ?", id, period).Exec(ctx)
		return err
	})
	if err != nil {
		return OpResult{Error: appErr(err)}
	}
	return OpResult{}
}

// ---------- summaries ----------

// cumulativeBalanceBefore returns the running account balance left over from
// every period strictly before `period`: Σ salaries + Σ extras − Σ gastos. This
// is the amount that carries (positive or negative) into the given month. Sums
// are done in Go with types.Decimal — never SQLite SUM() over TEXT columns.
func (s *FinanceService) cumulativeBalanceBefore(ctx context.Context, uid int64, period string) (types.Decimal, error) {
	total := types.Zero()

	var salaries []PeriodSalary
	if err := s.db.NewSelect().Model(&salaries).Where("user_id = ? AND period < ?", uid, period).Scan(ctx); err != nil {
		return types.Zero(), err
	}
	for _, sal := range salaries {
		total = total.Add(sal.Amount)
	}

	var incomes []Income
	if err := s.db.NewSelect().Model(&incomes).Where("user_id = ? AND period < ?", uid, period).Scan(ctx); err != nil {
		return types.Zero(), err
	}
	for _, inc := range incomes {
		total = total.Add(inc.Amount)
	}

	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).
		Where("user_id = ? AND period < ?", uid, period).
		Where("expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)").
		Scan(ctx); err != nil {
		return types.Zero(), err
	}
	for _, inst := range insts {
		total = total.Sub(inst.Amount)
	}

	// Recurring fixed expenses charged in every month before `period`.
	fixedTotal, err := s.sumFixedBefore(ctx, uid, period)
	if err != nil {
		return types.Zero(), err
	}
	return total.Sub(fixedTotal), nil
}

func (s *FinanceService) MonthlySummary(ctx context.Context, period string) MonthlySummaryResult {
	if !validPeriod(period) {
		return MonthlySummaryResult{Error: invalidPeriod()}
	}
	sum, err := s.monthlySummary(ctx, s.uid(), period)
	if err != nil {
		return MonthlySummaryResult{Error: internalErr(err)}
	}
	return MonthlySummaryResult{Data: sum}
}

func (s *FinanceService) monthlySummary(ctx context.Context, uid int64, period string) (*MonthlySummary, error) {
	salary, err := s.salaryFor(ctx, uid, period)
	if err != nil {
		return nil, err
	}
	acumulado, err := s.cumulativeBalanceBefore(ctx, uid, period)
	if err != nil {
		return nil, err
	}
	incomes, err := s.listIncomes(ctx, uid, period)
	if err != nil {
		return nil, err
	}
	cards, err := s.listCards(ctx, uid)
	if err != nil {
		return nil, err
	}
	// cardMapAll (not listCards) so a movimiento still shows the name of a card
	// that was since soft-deleted.
	cardByID, err := s.cardMapAll(ctx, uid)
	if err != nil {
		return nil, err
	}

	// Installments billed this period (with their expense joined in). A
	// soft-deleted expense's installments are excluded explicitly: the
	// Relation("Expense") join leaves Expense nil for them rather than
	// dropping the row, which would otherwise leak into the totals below.
	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).Relation("Expense").
		Where("inst.user_id = ? AND inst.period = ?", uid, period).
		Where("inst.expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)").
		Order("inst.id ASC").Scan(ctx); err != nil {
		return nil, err
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
		Presupuestos: []BudgetStatus{},
	}
	for _, inc := range incomes {
		sum.Extras = sum.Extras.Add(inc.Amount)
	}
	sum.Ingresos = sum.Salary.Add(sum.Extras)
	sum.Disponible = sum.Acumulado.Add(sum.Ingresos)

	catTotals := map[string]types.Decimal{}
	gastoMesByCard := map[int64]types.Decimal{}
	add := func(mv Movimiento) {
		mv.Category = categoryOrDefault(mv.Category)
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
		catTotals[mv.Category] = catTotals[mv.Category].Add(mv.Amount)
	}

	for _, inst := range insts {
		mv := Movimiento{
			Source:        SourceCuota,
			InstallmentID: inst.ID,
			Number:        inst.Number,
			Total:         inst.Total,
			Amount:        inst.Amount,
			Status:        inst.Status,
		}
		if ex := inst.Expense; ex != nil {
			mv.ExpenseID = ex.ID
			mv.Description = ex.Description
			mv.Category = ex.Category
			mv.Merchant = ex.Merchant
			mv.CardID = ex.CardID
			mv.Kind = ex.Kind
			mv.Date = &ex.Date
		}
		add(mv)
	}

	// Recurring fixed expenses billed this month (subscriptions, services). They
	// fold into the same totals/movimientos as installments.
	fixedMovs, err := s.fixedChargesFor(ctx, uid, period)
	if err != nil {
		return nil, err
	}
	for _, mv := range fixedMovs {
		add(mv)
	}

	sum.Balance = sum.Disponible.Sub(sum.Gastos)
	sum.Alcanza = sum.Disponible.GTE(sum.Gastos)
	sum.PorCategoria = sortedCategoryTotals(catTotals)

	budgets, err := s.budgetStatuses(ctx, uid, period, catTotals)
	if err != nil {
		return nil, err
	}
	sum.Presupuestos = budgets

	// Cupo usado per card = all PENDING installments across every period.
	cupoUsado, err := s.pendingByCard(ctx, uid)
	if err != nil {
		return nil, err
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
	return sum, nil
}

// pendingByCard sums all pending installments of non-deleted expenses grouped by
// their expense's card.
func (s *FinanceService) pendingByCard(ctx context.Context, uid int64) (map[int64]types.Decimal, error) {
	var pend []Installment
	if err := s.db.NewSelect().Model(&pend).Relation("Expense").
		Where("inst.user_id = ? AND inst.status = ?", uid, StatusPendiente).Scan(ctx); err != nil {
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
	out, err := s.yearSummary(ctx, s.uid(), year)
	if err != nil {
		return YearSummaryResult{Error: internalErr(err)}
	}
	return YearSummaryResult{Data: out}
}

func (s *FinanceService) yearSummary(ctx context.Context, uid int64, year int) (*YearSummary, error) {
	prefix := itoa4(year) + "-"

	// Carry-in from every period before this year.
	saldo, err := s.cumulativeBalanceBefore(ctx, uid, prefix+"01")
	if err != nil {
		return nil, err
	}

	var salaries []PeriodSalary
	if err := s.db.NewSelect().Model(&salaries).Where("user_id = ? AND period LIKE ?", uid, prefix+"%").Scan(ctx); err != nil {
		return nil, err
	}
	salaryByMonth := map[string]types.Decimal{}
	for _, sal := range salaries {
		salaryByMonth[sal.Period] = sal.Amount
	}

	var incomes []Income
	if err := s.db.NewSelect().Model(&incomes).Where("user_id = ? AND period LIKE ?", uid, prefix+"%").Scan(ctx); err != nil {
		return nil, err
	}
	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).Relation("Expense").
		Where("inst.user_id = ? AND inst.period LIKE ?", uid, prefix+"%").
		Where("inst.expense_id IN (SELECT id FROM expenses WHERE deleted_at IS NULL)").
		Scan(ctx); err != nil {
		return nil, err
	}

	extrasByMonth := map[string]types.Decimal{}
	for _, inc := range incomes {
		extrasByMonth[inc.Period] = extrasByMonth[inc.Period].Add(inc.Amount)
	}

	gastosByMonth := map[string]types.Decimal{}
	byCat := newCategoryMonths()
	for _, inst := range insts {
		gastosByMonth[inst.Period] = gastosByMonth[inst.Period].Add(inst.Amount)
		cat := ""
		if inst.Expense != nil {
			cat = inst.Expense.Category
		}
		byCat.add(cat, inst.Period, inst.Amount)
	}

	// Fold recurring fixed expenses into each month's gastos and the category totals.
	fixed, amountsByID, err := s.loadFixed(ctx, uid, false)
	if err != nil {
		return nil, err
	}
	for m := 1; m <= 12; m++ {
		period := prefix + pad2(m)
		for _, fe := range fixed {
			if !fe.activeIn(period) {
				continue
			}
			amt := resolveAsOf(amountsByID[fe.ID], period)
			gastosByMonth[period] = gastosByMonth[period].Add(amt)
			byCat.add(fe.Category, period, amt)
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
	out.PorCategoria, out.CategoriaMeses = byCat.rows()
	return out, nil
}

// categoryMonths accumulates a year's spending per category and month (1..12).
type categoryMonths map[string]*[12]types.Decimal

func newCategoryMonths() categoryMonths { return categoryMonths{} }

func (c categoryMonths) add(category, period string, amount types.Decimal) {
	category = categoryOrDefault(category)
	month := monthOf(period)
	if month < 1 {
		return
	}
	row, ok := c[category]
	if !ok {
		row = new([12]types.Decimal)
		c[category] = row
	}
	row[month-1] = row[month-1].Add(amount)
}

// rows returns the per-category year totals and the per-month breakdown, both
// ordered by total descending (ties by name, for a stable order).
func (c categoryMonths) rows() ([]CategoryTotal, []CategoryYearRow) {
	rows := make([]CategoryYearRow, 0, len(c))
	for cat, months := range c {
		total := types.Zero()
		for _, v := range months {
			total = total.Add(v)
		}
		rows = append(rows, CategoryYearRow{Category: cat, Months: months[:], Total: total})
	}
	slices.SortFunc(rows, func(a, b CategoryYearRow) int {
		return cmp.Or(b.Total.Cmp(a.Total), strings.Compare(a.Category, b.Category))
	})
	totals := make([]CategoryTotal, len(rows))
	for i, r := range rows {
		totals[i] = CategoryTotal{Category: r.Category, Total: r.Total}
	}
	return totals, rows
}

// monthOf returns the month number (1..12) of a YYYY-MM period, or 0 if invalid.
func monthOf(period string) int {
	t, err := time.Parse(periodLayout, period)
	if err != nil {
		return 0
	}
	return int(t.Month())
}

// ---------- trash (papelera) ----------

// ListTrash returns every soft-deleted record for the active user across all
// entity types, newest deletion first.
func (s *FinanceService) ListTrash(ctx context.Context) TrashResult {
	uid := s.uid()
	var out []TrashItem

	var cards []Card
	if err := s.db.NewSelect().Model(&cards).WhereDeleted().Where("user_id = ?", uid).Scan(ctx); err != nil {
		return TrashResult{Error: internalErr(err)}
	}
	for _, c := range cards {
		out = append(out, TrashItem{Type: "card", ID: c.ID, Description: c.Name, DeletedAt: *c.DeletedAt})
	}

	var cats []Category
	if err := s.db.NewSelect().Model(&cats).WhereDeleted().Where("user_id = ?", uid).Scan(ctx); err != nil {
		return TrashResult{Error: internalErr(err)}
	}
	for _, c := range cats {
		out = append(out, TrashItem{Type: "category", ID: c.ID, Description: c.Name, DeletedAt: *c.DeletedAt})
	}

	var mers []Merchant
	if err := s.db.NewSelect().Model(&mers).WhereDeleted().Where("user_id = ?", uid).Scan(ctx); err != nil {
		return TrashResult{Error: internalErr(err)}
	}
	for _, m := range mers {
		out = append(out, TrashItem{Type: "merchant", ID: m.ID, Description: m.Name, DeletedAt: *m.DeletedAt})
	}

	var incomes []Income
	if err := s.db.NewSelect().Model(&incomes).WhereDeleted().Where("user_id = ?", uid).Scan(ctx); err != nil {
		return TrashResult{Error: internalErr(err)}
	}
	for _, inc := range incomes {
		amt := inc.Amount
		out = append(out, TrashItem{Type: "income", ID: inc.ID, Description: inc.Description, Amount: &amt, Period: inc.Period, DeletedAt: *inc.DeletedAt})
	}

	var expenses []Expense
	if err := s.db.NewSelect().Model(&expenses).WhereDeleted().Where("user_id = ?", uid).Scan(ctx); err != nil {
		return TrashResult{Error: internalErr(err)}
	}
	for _, ex := range expenses {
		amt := ex.InstallmentAmount
		out = append(out, TrashItem{Type: "expense", ID: ex.ID, Description: ex.Description, Amount: &amt, DeletedAt: *ex.DeletedAt})
	}

	fixed, amountsByID, err := s.loadFixed(ctx, uid, true)
	if err != nil {
		return TrashResult{Error: internalErr(err)}
	}
	now := currentPeriod()
	for _, fe := range fixed {
		amt := resolveAsOf(amountsByID[fe.ID], fixedDisplayPeriod(fe, now))
		out = append(out, TrashItem{Type: "fixedexpense", ID: fe.ID, Description: fe.Description, Amount: &amt, DeletedAt: *fe.DeletedAt})
	}

	slices.SortFunc(out, func(a, b TrashItem) int { return b.DeletedAt.Compare(a.DeletedAt) })
	return TrashResult{Data: out}
}

// ---------- small helpers ----------

// The zero value of types.Decimal already behaves as 0 (shopspring initialises a
// nil big.Int to zero on use), so map lookups for a missing key are safe to add.

func sortedCategoryTotals(m map[string]types.Decimal) []CategoryTotal {
	out := make([]CategoryTotal, 0, len(m))
	for cat, total := range m {
		out = append(out, CategoryTotal{Category: cat, Total: total})
	}
	slices.SortFunc(out, func(a, b CategoryTotal) int {
		return cmp.Or(b.Total.Cmp(a.Total), strings.Compare(a.Category, b.Category))
	})
	return out
}

func pad2(n int) string  { return fmt.Sprintf("%02d", n) }
func itoa4(n int) string { return fmt.Sprintf("%04d", n) }

// isUniqueViolation reports whether err is a SQLite UNIQUE constraint failure.
// Matched by message on purpose: sqliteshim picks a different driver (cgo
// mattn vs pure-Go modernc) per build, each with its own error type, and the
// message is the one thing both share.
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}
