package finance

import (
	"testing"
)

func dues(t *testing.T, s *FinanceService, today string, days int) []Due {
	t.Helper()
	r := s.UpcomingDues(t.Context(), today, days)
	mustOK(t, "UpcomingDues", r.Error)
	return r.Data
}

func TestUpcomingDuesListsWhatIsStillUnpaid(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Visa", "1000000", 26, "4321")
	mustOK(t, "CreateCard", card.Error)
	in := nationalStatement() // due 2026-09-08
	in.Lines, in.Schedule = nil, nil
	importStatement(t, s, in)
	var st CardStatement
	if err := s.db.NewSelect().Model(&st).Where("user_id = ?", s.uid()).Scan(ctx); err != nil {
		t.Fatal(err)
	}
	period := st.Period

	// A purchase and a fixed charge on the card, billed in the statement's month.
	buy := s.CreateExpense(ctx, period+"-01", "Super", "", "", &card.Data.ID, KindUnico, "50000", 1)
	mustOK(t, "CreateExpense", buy.Error)
	streaming := s.CreateFixedExpense(ctx, "Streaming", "", &card.Data.ID, period, "10000", 1, CurrencyCLP)
	mustOK(t, "CreateFixedExpense", streaming.Error)
	day := 5
	mustOK(t, "SetFixedExpenseDueDay", s.SetFixedExpenseDueDay(ctx, streaming.Data.ID, &day).Error)
	// Rent falls due on the 5th of every month.
	rent := s.CreateFixedExpense(ctx, "Arriendo", "", nil, "2026-07", "400000", 1, CurrencyCLP)
	mustOK(t, "CreateFixedExpense", rent.Error)
	mustOK(t, "SetFixedExpenseDueDay", s.SetFixedExpenseDueDay(ctx, rent.Data.ID, &day).Error)
	// Without a due day a fixed expense has no reminder.
	mustOK(t, "CreateFixedExpense", s.CreateFixedExpense(ctx, "Gimnasio", "", nil, "2026-07", "30000", 1, CurrencyCLP).Error)

	got := dues(t, s, "2026-09-03", 7)
	if len(got) != 2 {
		t.Fatalf("dues = %+v", got)
	}
	// August's rent (the 5th) is older than the look-back window.
	if d := got[0]; d.Kind != DueFixed || d.Label != "Arriendo" || d.DueDate != "2026-09-05" || d.Amount.String() != "400000" || d.Overdue {
		t.Fatalf("rent due = %+v", d)
	}
	// The card's statement date; the streaming charge is paid with the card.
	if d := got[1]; d.Kind != DueCard || d.RefID != card.Data.ID || d.DueDate != "2026-09-08" || d.Amount.String() != "60000" || d.Period != period {
		t.Fatalf("card due = %+v", d)
	}

	// Past its date and still unpaid: overdue.
	if got := dues(t, s, "2026-09-07", 3); len(got) != 2 || !got[0].Overdue || got[1].Overdue {
		t.Fatalf("dues on the 7th = %+v", got)
	}

	// Paying drops them off.
	var inst Installment
	if err := s.db.NewSelect().Model(&inst).Where("expense_id = ?", buy.Data.ID).Scan(ctx); err != nil {
		t.Fatal(err)
	}
	mustOK(t, "SetInstallmentPaid", s.SetInstallmentPaid(ctx, inst.ID, true).Error)
	if got := dues(t, s, "2026-09-03", 7); len(got) != 2 || got[1].Amount.String() != "10000" {
		t.Fatalf("after paying the purchase = %+v", got)
	}
	mustOK(t, "SetFixedExpensePaid", s.SetFixedExpensePaid(ctx, streaming.Data.ID, period, true).Error)
	mustOK(t, "SetFixedExpensePaid", s.SetFixedExpensePaid(ctx, rent.Data.ID, "2026-09", true).Error)
	if got := dues(t, s, "2026-09-03", 7); len(got) != 0 {
		t.Fatalf("after paying everything = %+v", got)
	}

	// Clearing the due day silences it; a new one moves it.
	mustOK(t, "SetFixedExpenseDueDay", s.SetFixedExpenseDueDay(ctx, rent.Data.ID, nil).Error)
	if got := dues(t, s, "2026-10-01", 10); len(got) != 0 {
		t.Fatalf("without a due day = %+v", got)
	}
	late := 20
	mustOK(t, "SetFixedExpenseDueDay", s.SetFixedExpenseDueDay(ctx, rent.Data.ID, &late).Error)
	if got := dues(t, s, "2026-10-15", 10); len(got) != 1 || got[0].DueDate != "2026-10-20" {
		t.Fatalf("october = %+v", got)
	}
	// A trashed fixed expense reminds nothing.
	mustOK(t, "DeleteFixedExpense", s.DeleteFixedExpense(ctx, rent.Data.ID).Error)
	if got := dues(t, s, "2026-10-15", 10); len(got) != 0 {
		t.Fatalf("after trashing = %+v", got)
	}
}

func TestUpcomingDuesValidation(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	for _, tc := range []struct {
		name  string
		today string
		days  int
	}{
		{"not a date", "2026-9-3", 7},
		{"out of range year", "1999-01-01", 7},
		{"negative days", "2026-09-03", -1},
		{"too many days", "2026-09-03", maxDueDays + 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if r := s.UpcomingDues(ctx, tc.today, tc.days); r.Error == nil {
				t.Fatalf("UpcomingDues(%q, %d) accepted", tc.today, tc.days)
			}
		})
	}
	fe := s.CreateFixedExpense(ctx, "Arriendo", "", nil, "2026-07", "400000", 1, CurrencyCLP)
	mustOK(t, "CreateFixedExpense", fe.Error)
	for _, day := range []int{0, 32} {
		if r := s.SetFixedExpenseDueDay(ctx, fe.Data.ID, &day); r.Error == nil {
			t.Fatalf("due day %d accepted", day)
		}
	}
}

func TestDayOfMonthClampsToTheMonthsEnd(t *testing.T) {
	for _, tc := range []struct {
		period string
		day    int
		want   string
	}{
		{"2026-09", 5, "2026-09-05"},
		{"2026-04", 31, "2026-04-30"},
		{"2027-02", 30, "2027-02-28"},
		{"2028-02", 31, "2028-02-29"},
	} {
		if got := dayOfMonth(tc.period, tc.day); got != tc.want {
			t.Errorf("dayOfMonth(%s, %d) = %s, want %s", tc.period, tc.day, got, tc.want)
		}
	}
}
