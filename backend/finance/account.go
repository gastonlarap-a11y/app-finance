package finance

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Accounts (checking, savings, cash) say where money leaves from and lands
// in. They are a lens on the same ledger — the app's total balance and its
// reconciliation do not change: each expense, income or card may name an
// account, and every account shows its own balance and month. An expense's
// own account wins over its card's (the account the card is paid from).
type Account struct {
	bun.BaseModel `bun:"table:accounts,alias:acc"`

	ID             int64         `bun:"id,pk,autoincrement" json:"id"`
	UserID         int64         `bun:"user_id,notnull" json:"userId"`
	Name           string        `bun:"name,notnull" json:"name"`
	Kind           string        `bun:"kind,notnull" json:"kind"` // corriente | vista | efectivo | ahorro | otra
	OpeningBalance types.Decimal `bun:"opening_balance,notnull" json:"openingBalance"`
	OpeningPeriod  string        `bun:"opening_period,notnull" json:"openingPeriod"` // YYYY-MM the balance counts from
	ReceivesSalary bool          `bun:"receives_salary,notnull" json:"receivesSalary"`
	CreatedAt      time.Time     `bun:"created_at,nullzero,default:current_timestamp" json:"createdAt"`
}

var accountKinds = []string{"corriente", "vista", "efectivo", "ahorro", "otra"}

// AccountView is an account at the close of a month: its balance and what
// came in and went out that month.
type AccountView struct {
	Account
	Balance  types.Decimal `json:"balance"`
	Ingresos types.Decimal `json:"ingresos"`
	Gastos   types.Decimal `json:"gastos"`
}

// AccountsSummary is every account at a month plus the month's movements no
// account claims.
type AccountsSummary struct {
	Accounts          []AccountView `json:"accounts"`
	UnassignedIngreso types.Decimal `json:"unassignedIngresos"`
	UnassignedGastos  types.Decimal `json:"unassignedGastos"`
}

type AccountResult struct {
	Data  *Account         `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

type AccountsResult struct {
	Data  *AccountsSummary `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

func validAccount(name, kind, opening, openingPeriod string) (string, types.Decimal, *shared.AppError) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", types.Zero(), shared.NewError(shared.ErrValidation, "el nombre es obligatorio")
	}
	if !slices.Contains(accountKinds, kind) {
		return "", types.Zero(), shared.NewError(shared.ErrValidation, "tipo de cuenta inválido: "+kind)
	}
	if !validPeriod(openingPeriod) {
		return "", types.Zero(), invalidPeriod()
	}
	bal, err := types.New(strings.TrimSpace(opening))
	if err != nil {
		return "", types.Zero(), shared.NewError(shared.ErrValidation, "saldo inicial inválido: "+opening)
	}
	return name, bal, nil
}

// CreateAccount adds an account with its balance at the start of openingPeriod
// (it may be negative: an overdrawn checking account).
func (s *FinanceService) CreateAccount(ctx context.Context, name, kind, openingBalance, openingPeriod string, receivesSalary bool) AccountResult {
	name, bal, aerr := validAccount(name, kind, openingBalance, openingPeriod)
	if aerr != nil {
		return AccountResult{Error: aerr}
	}
	uid := s.uid()
	acc := &Account{UserID: uid, Name: name, Kind: kind, OpeningBalance: bal, OpeningPeriod: openingPeriod, ReceivesSalary: receivesSalary}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if _, err := tx.NewInsert().Model(acc).Returning("*").Exec(ctx); err != nil {
			return err
		}
		return s.keepOneSalaryAccount(ctx, tx, uid, acc)
	})
	if err != nil {
		return AccountResult{Error: appErr(err)}
	}
	return AccountResult{Data: acc}
}

// UpdateAccount changes an account's details.
func (s *FinanceService) UpdateAccount(ctx context.Context, id int64, name, kind, openingBalance, openingPeriod string, receivesSalary bool) AccountResult {
	name, bal, aerr := validAccount(name, kind, openingBalance, openingPeriod)
	if aerr != nil {
		return AccountResult{Error: aerr}
	}
	uid := s.uid()
	acc := &Account{ID: id, UserID: uid, Name: name, Kind: kind, OpeningBalance: bal, OpeningPeriod: openingPeriod, ReceivesSalary: receivesSalary}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		res, err := tx.NewUpdate().Model(acc).
			Column("name", "kind", "opening_balance", "opening_period", "receives_salary").
			WherePK().Where("user_id = ?", uid).Exec(ctx)
		if aerr := requireOne(res, err, "cuenta no encontrada"); aerr != nil {
			return aerr
		}
		return s.keepOneSalaryAccount(ctx, tx, uid, acc)
	})
	if err != nil {
		return AccountResult{Error: appErr(err)}
	}
	return AccountResult{Data: acc}
}

// keepOneSalaryAccount: the salary lands in one account only.
func (s *FinanceService) keepOneSalaryAccount(ctx context.Context, tx bun.Tx, uid int64, acc *Account) error {
	if !acc.ReceivesSalary {
		return nil
	}
	_, err := tx.NewUpdate().Model((*Account)(nil)).Set("receives_salary = ?", false).
		Where("user_id = ? AND id <> ?", uid, acc.ID).Exec(ctx)
	return err
}

// DeleteAccount removes an account; what named it is left without one.
func (s *FinanceService) DeleteAccount(ctx context.Context, id int64) OpResult {
	res, err := s.db.NewDelete().Model((*Account)(nil)).Where("id = ? AND user_id = ?", id, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "cuenta no encontrada")}
}

// ownAccount checks that accountID (nil = none) is one of uid's accounts.
func ownAccount(ctx context.Context, idb bun.IDB, uid int64, accountID *int64) *shared.AppError {
	if accountID == nil {
		return nil
	}
	ok, err := idb.NewSelect().Model((*Account)(nil)).Where("id = ? AND user_id = ?", *accountID, uid).Exists(ctx)
	if err != nil {
		return internalErr(err)
	}
	if !ok {
		return shared.NewError(shared.ErrNotFound, "cuenta no encontrada")
	}
	return nil
}

// setAccountOf names the account (nil = none) of one row of model.
func (s *FinanceService) setAccountOf(ctx context.Context, model any, id int64, accountID *int64, notFound string) OpResult {
	uid := s.uid()
	if aerr := ownAccount(ctx, s.db, uid, accountID); aerr != nil {
		return OpResult{Error: aerr}
	}
	res, err := s.db.NewUpdate().Model(model).Set("account_id = ?", accountID).
		Where("id = ? AND user_id = ?", id, uid).Exec(ctx)
	return OpResult{Error: requireOne(res, err, notFound)}
}

// SetExpenseAccount names the account an expense is paid from (nil = none, or
// its card's).
func (s *FinanceService) SetExpenseAccount(ctx context.Context, expenseID int64, accountID *int64) OpResult {
	return s.setAccountOf(ctx, (*Expense)(nil), expenseID, accountID, "gasto no encontrado")
}

// SetIncomeAccount names the account an extra income lands in.
func (s *FinanceService) SetIncomeAccount(ctx context.Context, incomeID int64, accountID *int64) OpResult {
	return s.setAccountOf(ctx, (*Income)(nil), incomeID, accountID, "ingreso no encontrado")
}

// SetCardAccount names the account a card is paid from: its expenses without
// an account of their own, and its fixed expenses, count there.
func (s *FinanceService) SetCardAccount(ctx context.Context, cardID int64, accountID *int64) OpResult {
	return s.setAccountOf(ctx, (*Card)(nil), cardID, accountID, "tarjeta no encontrada")
}

// accountFlow is what one account (0 = none) received and spent in a month.
type accountFlow struct{ in, out types.Decimal }

// ListAccounts returns every account at the close of `period` and the month's
// movements no account claims.
func (s *FinanceService) ListAccounts(ctx context.Context, period string) AccountsResult {
	if !validPeriod(period) {
		return AccountsResult{Error: invalidPeriod()}
	}
	uid := s.uid()
	var accs []Account
	if err := s.db.NewSelect().Model(&accs).Where("user_id = ?", uid).Order("name ASC").Scan(ctx); err != nil {
		return AccountsResult{Error: internalErr(err)}
	}
	from := period
	for _, a := range accs {
		from = min(from, a.OpeningPeriod)
	}
	flows, err := s.accountFlows(ctx, uid, accs, from, period)
	if err != nil {
		return AccountsResult{Error: internalErr(err)}
	}
	out := &AccountsSummary{Accounts: make([]AccountView, 0, len(accs))}
	for _, a := range accs {
		v := AccountView{Account: a, Balance: types.Zero(), Ingresos: types.Zero(), Gastos: types.Zero()}
		if a.OpeningPeriod <= period {
			v.Balance = a.OpeningBalance
			for m := a.OpeningPeriod; m <= period; m = addMonths(m, 1) {
				f := flows[a.ID][m]
				v.Balance = v.Balance.Add(f.in).Sub(f.out)
			}
		}
		f := flows[a.ID][period]
		v.Ingresos, v.Gastos = v.Ingresos.Add(f.in), v.Gastos.Add(f.out)
		out.Accounts = append(out.Accounts, v)
	}
	none := flows[0][period]
	out.UnassignedIngreso, out.UnassignedGastos = types.Zero().Add(none.in), types.Zero().Add(none.out)
	return AccountsResult{Data: out}
}

// accountFlows sums, per account (0 = none) and month in [from, to], the same
// flows as a month's balance: salary (to the salary account), extra incomes,
// cuotas and fixed charges (the expense's account, else its card's) and
// refunds (back to where the expense was paid from).
func (s *FinanceService) accountFlows(ctx context.Context, uid int64, accs []Account, from, to string) (map[int64]map[string]accountFlow, error) {
	out := map[int64]map[string]accountFlow{}
	add := func(acc int64, period string, in, outAmt types.Decimal) {
		if out[acc] == nil {
			out[acc] = map[string]accountFlow{}
		}
		f := out[acc][period]
		f.in, f.out = f.in.Add(in), f.out.Add(outAmt)
		out[acc][period] = f
	}
	var salaryAcc int64
	for _, a := range accs {
		if a.ReceivesSalary {
			salaryAcc = a.ID
		}
	}
	type row struct {
		Period  string        `bun:"period"`
		Amount  types.Decimal `bun:"amount"`
		Account *int64        `bun:"account"`
	}
	scan := func(what, query string, args ...any) ([]row, error) {
		var rows []row
		if err := s.db.NewRaw(query, args...).Scan(ctx, &rows); err != nil {
			return nil, fmt.Errorf("%s: %w", what, err)
		}
		return rows, nil
	}
	acct := func(r row) int64 {
		if r.Account == nil {
			return 0
		}
		return *r.Account
	}

	salaries, err := scan("salaries", `SELECT period, amount, NULL AS account FROM period_salaries
		WHERE user_id = ? AND period >= ? AND period <= ?`, uid, from, to)
	if err != nil {
		return nil, err
	}
	for _, r := range salaries {
		add(salaryAcc, r.Period, r.Amount, types.Zero())
	}
	incomes, err := scan("incomes", `SELECT period, amount, account_id AS account FROM incomes
		WHERE user_id = ? AND deleted_at IS NULL AND period >= ? AND period <= ?`, uid, from, to)
	if err != nil {
		return nil, err
	}
	for _, r := range incomes {
		add(acct(r), r.Period, r.Amount, types.Zero())
	}
	cuotas, err := scan("cuotas", `SELECT inst.period AS period, inst.amount AS amount, COALESCE(ex.account_id, c.account_id) AS account
		FROM installments AS inst JOIN expenses AS ex ON ex.id = inst.expense_id AND ex.deleted_at IS NULL
		LEFT JOIN cards AS c ON c.id = ex.card_id
		WHERE inst.user_id = ? AND inst.period >= ? AND inst.period <= ?`, uid, from, to)
	if err != nil {
		return nil, err
	}
	for _, r := range cuotas {
		add(acct(r), r.Period, types.Zero(), r.Amount)
	}
	refunds, err := scan("refunds", `SELECT rf.period AS period, rf.amount AS amount, COALESCE(ex.account_id, c.account_id) AS account
		FROM refunds AS rf JOIN expenses AS ex ON ex.id = rf.expense_id AND ex.deleted_at IS NULL
		LEFT JOIN cards AS c ON c.id = ex.card_id
		WHERE rf.user_id = ? AND rf.period >= ? AND rf.period <= ?`, uid, from, to)
	if err != nil {
		return nil, err
	}
	for _, r := range refunds {
		add(acct(r), r.Period, types.Zero(), types.Zero().Sub(r.Amount))
	}

	fixed, amountsByID, err := s.loadFixed(ctx, uid, false)
	if err != nil {
		return nil, err
	}
	uf, err := s.loadUF(ctx)
	if err != nil {
		return nil, err
	}
	cardAcc := map[int64]int64{}
	var cards []Card
	if err := s.db.NewSelect().Model(&cards).WhereAllWithDeleted().Where("user_id = ?", uid).Scan(ctx); err != nil {
		return nil, err
	}
	for _, c := range cards {
		if c.AccountID != nil {
			cardAcc[c.ID] = *c.AccountID
		}
	}
	for m := from; m <= to; m = addMonths(m, 1) {
		for _, fe := range fixed {
			if !fe.billsIn(m) {
				continue
			}
			amt, _, _ := fixedCharge(fe, amountsByID[fe.ID], uf, m)
			var acc int64
			if fe.CardID != nil {
				acc = cardAcc[*fe.CardID]
			}
			add(acc, m, types.Zero(), amt)
		}
	}
	return out, nil
}
