package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

// cardOwed returns what `card` still owed at the close of period, if anything.
func cardOwed(t *testing.T, s *FinanceService, period string, card int64) (CardOwed, bool) {
	t.Helper()
	r := s.ListAccounts(t.Context(), period)
	mustOK(t, "ListAccounts", r.Error)
	for _, c := range r.Data.Cards {
		if c.CardID == card {
			return c, true
		}
	}
	return CardOwed{}, false
}

// A card purchase is August's spending, but it leaves the account that pays the
// card when its statement is paid: in September by default, in the month of the
// card's payment day when that comes after the cutoff, and in the month of an
// imported statement's «pagar hasta» above all.
func TestCardChargesLeaveTheAccountWhenTheStatementIsPaid(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	itau := s.CreateAccount(ctx, "Itaú", "corriente", "1000000", "2026-08", false)
	mustOK(t, "CreateAccount", itau.Error)
	card := s.CreateCard(ctx, "Itaú Mastercard", "2000000", 24, "1234")
	mustOK(t, "CreateCard", card.Error)
	mustOK(t, "SetCardAccount", s.SetCardAccount(ctx, card.Data.ID, &itau.Data.ID).Error)
	mustOK(t, "card purchase", s.CreateExpense(ctx, "2026-08-10", "Zapatillas", "", "", &card.Data.ID, KindUnico, "100000", 1).Error)
	mustOK(t, "card fixed", s.CreateFixedExpense(ctx, "Netflix", "", &card.Data.ID, "2026-08", "10000", 1, CurrencyCLP).Error)
	cash := s.CreateExpense(ctx, "2026-08-15", "Feria", "", "", nil, KindUnico, "5000", 1)
	mustOK(t, "cash purchase", cash.Error)
	mustOK(t, "SetExpenseAccount", s.SetExpenseAccount(ctx, cash.Data.ID, &itau.Data.ID).Error)

	// The month's spending does not move: the card counts in August.
	wantMoney(t, "August gastos", monthly(t, s, "2026-08").Gastos, "115000")

	aug := accountByName(t, s, "2026-08", "Itaú")
	wantMoney(t, "August balance", aug.Balance, "995000")
	wantMoney(t, "August account gastos", aug.Gastos, "5000")
	owed, ok := cardOwed(t, s, "2026-08", card.Data.ID)
	if !ok || owed.Owed.String() != "110000" || owed.PaymentPeriod != "2026-09" || owed.Name != "Itaú Mastercard" {
		t.Fatalf("owed at August's close = %+v (%v), want 110.000 paid in 2026-09", owed, ok)
	}
	sep := accountByName(t, s, "2026-09", "Itaú")
	wantMoney(t, "September account gastos", sep.Gastos, "110000")
	wantMoney(t, "September balance", sep.Balance, "885000")
	if owed, _ := cardOwed(t, s, "2026-09", card.Data.ID); owed.Owed.String() != "10000" || owed.PaymentPeriod != "2026-10" {
		t.Fatalf("owed at September's close = %+v, want September's Netflix paid in 2026-10", owed)
	}

	// Paid on the 28th, after the 24th cutoff: the same month.
	day := 28
	mustOK(t, "SetCardPaymentDay", s.SetCardPaymentDay(ctx, card.Data.ID, &day).Error)
	wantMoney(t, "August balance, paid the same month", accountByName(t, s, "2026-08", "Itaú").Balance, "885000")
	if owed, ok := cardOwed(t, s, "2026-08", card.Data.ID); ok {
		t.Fatalf("owed = %+v, want nothing: paid within the month", owed)
	}

	// An imported statement's «pagar hasta» wins over the payment day.
	imp := s.ImportCardStatement(ctx, CardStatementInput{
		Issuer: "itau", Kind: StatementNational, Currency: "CLP", CardLastDigits: "1234",
		StatementDate: "2026-08-24", PeriodTo: "2026-08-24", DueDate: "2026-10-02",
	})
	mustOK(t, "ImportCardStatement", imp.Error)
	wantMoney(t, "September balance, paid in October", accountByName(t, s, "2026-09", "Itaú").Balance, "985000")
	if owed, _ := cardOwed(t, s, "2026-09", card.Data.ID); owed.Owed.String() != "110000" || owed.PaymentPeriod != "2026-10" {
		t.Fatalf("owed at September's close = %+v, want August's statement due in 2026-10", owed)
	}
}

func TestSetCardPaymentDayValidation(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Visa", "500000", 20, "")
	mustOK(t, "CreateCard", card.Error)
	for _, bad := range []int{0, 32} {
		wantCode(t, "SetCardPaymentDay", s.SetCardPaymentDay(ctx, card.Data.ID, &bad).Error, shared.ErrValidation)
	}
	day := 5
	wantCode(t, "unknown card", s.SetCardPaymentDay(ctx, 999, &day).Error, shared.ErrNotFound)
	mustOK(t, "SetCardPaymentDay", s.SetCardPaymentDay(ctx, card.Data.ID, &day).Error)
	cards, err := s.ListCards(ctx)
	if err != nil || len(cards) != 1 || cards[0].PaymentDay == nil || *cards[0].PaymentDay != 5 {
		t.Fatalf("ListCards = %+v (err %v), want payment day 5", cards, err)
	}
	mustOK(t, "clear", s.SetCardPaymentDay(ctx, card.Data.ID, nil).Error)
	if cards, _ := s.ListCards(ctx); cards[0].PaymentDay != nil {
		t.Fatalf("payment day = %v, want cleared", *cards[0].PaymentDay)
	}
}

// A cutoff of 29–31 is kept (shorter months close on their last day,
// TestPeriodOf); a day outside the month is refused, never swapped for another.
func TestCardBillingDayValidation(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "CMR", "500000", 31, "")
	mustOK(t, "CreateCard day 31", card.Error)
	if card.Data.BillingDay != 31 {
		t.Fatalf("billing day = %d, want 31", card.Data.BillingDay)
	}
	for _, bad := range []int{0, 32, 99} {
		wantCode(t, "CreateCard", s.CreateCard(ctx, "Visa", "0", bad, "").Error, shared.ErrValidation)
		wantCode(t, "UpdateCard", s.UpdateCard(ctx, card.Data.ID, "CMR", "500000", bad, "").Error, shared.ErrValidation)
	}
	mustOK(t, "UpdateCard day 29", s.UpdateCard(ctx, card.Data.ID, "CMR", "500000", 29, "").Error)
}
