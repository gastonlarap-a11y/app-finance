package finance

import (
	"context"
	"regexp"
	"strings"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Purchases in another currency. The app budgets in pesos: an expense's
// cuotas are always CLP (every total, budget and balance uses them). A foreign
// purchase also keeps what the bank charged in its own currency and the rate
// used, so the user can see and dispute it — the way YNAB and Monarch record
// foreign transactions in the account's currency with the original as a note.

var isoCurrency = regexp.MustCompile(`^[A-Z]{3}$`)

// FxRateResult is the last CLP-per-USD rate the card statements taught.
type FxRateResult struct {
	Data  string           `json:"data"` // "" = none known yet
	Error *shared.AppError `json:"error,omitempty"`
}

// LatestFxRate returns the CLP per USD rate implied by the last international
// card payment (learned from the statements), to suggest when a purchase in
// dollars is entered by hand.
func (s *FinanceService) LatestFxRate(ctx context.Context) FxRateResult {
	rate, err := latestFxRate(ctx, s.db, s.uid())
	if err != nil {
		return FxRateResult{Error: internalErr(err)}
	}
	return FxRateResult{Data: rate}
}

// SetExpenseCurrency records that an expense was bought in `currency` for
// `originalAmount` (its total) at `fxRate` pesos per unit. The expense's pesos
// do not change. "CLP" clears it.
func (s *FinanceService) SetExpenseCurrency(ctx context.Context, expenseID int64, currency, originalAmount, fxRate string) OpResult {
	currency = strings.ToUpper(strings.TrimSpace(currency))
	if !isoCurrency.MatchString(currency) {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "moneda inválida (use un código de 3 letras, ej. USD)")}
	}
	original, rate := "", ""
	if currency != CurrencyCLP {
		o, aerr := positiveAmount(originalAmount, "el monto original")
		if aerr != nil {
			return OpResult{Error: aerr}
		}
		r, aerr := positiveAmount(fxRate, "la tasa")
		if aerr != nil {
			return OpResult{Error: aerr}
		}
		original, rate = o.String(), r.String()
	}
	res, err := s.db.NewUpdate().Model((*Expense)(nil)).
		Set("currency = ?", currency).Set("original_amount = ?", original).Set("fx_rate = ?", rate).
		Where("id = ? AND user_id = ?", expenseID, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "gasto no encontrado")}
}

func positiveAmount(s, what string) (types.Decimal, *shared.AppError) {
	d, aerr := parseAmount(s)
	if aerr != nil {
		return d, aerr
	}
	if !d.GT(types.Zero()) {
		return d, shared.NewError(shared.ErrValidation, what+" debe ser mayor a 0")
	}
	return d, nil
}

// recordItemCurrency keeps a confirmed foreign bank item's original on its
// expense: the item's amount in its currency and the rate the user's pesos
// imply (4 decimals).
func recordItemCurrency(ctx context.Context, tx bun.Tx, uid int64, item *ImportItem, ex *Expense) error {
	if item.Currency == "" || item.Currency == CurrencyCLP || !item.Amount.GT(types.Zero()) {
		return nil
	}
	pesos := ex.InstallmentAmount.MulInt(int64(max(ex.InstallmentsTotal, 1)))
	rate := pesos.Decimal.DivRound(item.Amount.Decimal, 4)
	_, err := tx.NewUpdate().Model((*Expense)(nil)).
		Set("currency = ?", item.Currency).Set("original_amount = ?", item.Amount.String()).Set("fx_rate = ?", rate.String()).
		Where("id = ? AND user_id = ?", ex.ID, uid).Exec(ctx)
	return err
}
