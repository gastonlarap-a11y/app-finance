package finance

import (
	"context"
	"fmt"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// A card purchase is spending of the month its statement bills it (the month
// view and the carried balance), but the money leaves the account that pays
// the card when that statement is paid — the way YNAB, Monarch and Copilot
// book a card payment: a transfer out of the checking account on the day it is
// paid. The accounts view follows the payment; the rest of the app does not
// change.

// cardPaymentLookback is how many months before a range the accounts view
// looks for card charges paid inside it (a statement is paid within a month or
// two of its close).
const cardPaymentLookback = 2

// cardPeriod is one card's statement month.
type cardPeriod struct {
	card   int64
	period string
}

// cardPayments knows when each card's statements are paid.
type cardPayments struct {
	cards map[int64]Card
	due   map[cardPeriod]string // month of the imported statement's «pagar hasta»
}

// loadCardPayments loads uid's cards (trashed ones too: their history is still
// paid) and the payment month of every imported statement. A card's national
// and international statements of one month are paid together: the earliest
// date wins.
func loadCardPayments(ctx context.Context, idb bun.IDB, uid int64) (cardPayments, error) {
	var cards []Card
	if err := idb.NewSelect().Model(&cards).WhereAllWithDeleted().Where("user_id = ?", uid).Scan(ctx); err != nil {
		return cardPayments{}, fmt.Errorf("loading cards: %w", err)
	}
	var sts []CardStatement
	if err := idb.NewSelect().Model(&sts).Column("card_id", "period", "due_date").
		Where("user_id = ? AND card_id IS NOT NULL AND due_date <> ''", uid).Scan(ctx); err != nil {
		return cardPayments{}, fmt.Errorf("loading statement due dates: %w", err)
	}
	p := cardPayments{cards: make(map[int64]Card, len(cards)), due: map[cardPeriod]string{}}
	for _, c := range cards {
		p.cards[c.ID] = c
	}
	earliest := map[cardPeriod]string{}
	for _, st := range sts {
		k := cardPeriod{*st.CardID, st.Period}
		if d, ok := earliest[k]; !ok || st.DueDate < d {
			earliest[k] = st.DueDate
		}
	}
	for k, date := range earliest {
		// A due date before the month it bills is a misread one: the card's rule decides.
		if len(date) >= len(periodLayout) && date[:len(periodLayout)] >= k.period {
			p.due[k] = date[:len(periodLayout)]
		}
	}
	return p, nil
}

// paymentPeriod is the month card's statement of `period` is paid in: the month
// of its imported «pagar hasta»; else, with the card's payment day, the same
// month when that day comes after the cutoff and the next one otherwise; else
// the next month.
func (p cardPayments) paymentPeriod(card int64, period string) string {
	if due, ok := p.due[cardPeriod{card, period}]; ok {
		return due
	}
	if c, ok := p.cards[card]; ok && c.PaymentDay != nil && *c.PaymentDay > c.BillingDay {
		return period
	}
	return addMonths(period, 1)
}

// CardOwed is what a card's statements billed up to a month and had not been
// paid by its close: a liability of the account that pays the card.
type CardOwed struct {
	CardID        int64         `json:"cardId"`
	Name          string        `json:"name"`
	Owed          types.Decimal `json:"owed"`
	PaymentPeriod string        `json:"paymentPeriod"` // YYYY-MM the earliest of it is paid
}

// SetCardPaymentDay sets the day of the month a card's statement is paid
// (1–31; nil = the month after its cutoff). The accounts view charges the
// card's purchases to the account that pays it in that month; an imported
// statement's «pagar hasta» always wins.
func (s *FinanceService) SetCardPaymentDay(ctx context.Context, cardID int64, day *int) OpResult {
	if day != nil && (*day < 1 || *day > 31) {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "el día de pago debe estar entre 1 y 31")}
	}
	res, err := s.db.NewUpdate().Model((*Card)(nil)).Set("payment_day = ?", day).
		Where("id = ? AND user_id = ?", cardID, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "tarjeta no encontrada")}
}
