package finance

import (
	"slices"
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func cuotaAmounts(t *testing.T, s *FinanceService, expenseID int64) []string {
	t.Helper()
	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).Where("expense_id = ?", expenseID).Order("number ASC").Scan(t.Context()); err != nil {
		t.Fatal(err)
	}
	out := make([]string, len(insts))
	for i, inst := range insts {
		out[i] = inst.Amount.String()
	}
	return out
}

func TestConfirmSettlesTheBanksRoundingInTheLastCuota(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Itaú", "1000000", 26, "4321")
	mustOK(t, "CreateCard", card.Error)
	importStatement(t, s, nationalStatement())
	// TIENDA DOS: 60.001 in 6 cuotas of 10.000.
	dos := pendingByDescription(t, s)["TIENDA DOS"]
	ex := s.ConfirmImportItem(ctx, dos.ID, dos.Date, "Tienda dos", "", "", &card.Data.ID, KindCuotas, dos.InstallmentAmount, 6, "")
	mustOK(t, "ConfirmImportItem", ex.Error)
	want := []string{"10000", "10000", "10000", "10000", "10000", "10001"}
	if got := cuotaAmounts(t, s, ex.Data.ID); !slices.Equal(got, want) {
		t.Fatalf("cuotas = %v, want %v", got, want)
	}
}

// Editing a statement purchase's words keeps the bank's rounded last cuota:
// the plan must still add up to what the bank charges.
func TestEditKeepsTheBanksRoundedLastCuota(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Itaú", "1000000", 26, "4321")
	mustOK(t, "CreateCard", card.Error)
	importStatement(t, s, nationalStatement())
	dos := pendingByDescription(t, s)["TIENDA DOS"]
	ex := s.ConfirmImportItem(ctx, dos.ID, dos.Date, "Tienda dos", "", "", &card.Data.ID, KindCuotas, dos.InstallmentAmount, 6, "")
	mustOK(t, "ConfirmImportItem", ex.Error)
	periods := installmentPeriods(t, s, ex.Data.ID)

	mustOK(t, "UpdateExpense", s.UpdateExpense(ctx, ex.Data.ID, dos.Date, "Tienda dos", "Hogar", "", &card.Data.ID,
		KindCuotas, dos.InstallmentAmount, 6).Error)
	want := []string{"10000", "10000", "10000", "10000", "10000", "10001"}
	if got := cuotaAmounts(t, s, ex.Data.ID); !slices.Equal(got, want) {
		t.Fatalf("cuotas after a category edit = %v, want %v", got, want)
	}
	if got := installmentPeriods(t, s, ex.Data.ID); !slices.Equal(got, periods) {
		t.Fatalf("periods after a category edit = %v, want %v", got, periods)
	}
}

// Editing a plan keeps what was done to it: a prepayment's months and a cuota
// set by hand stay; a new cuota amount still reaches every pending cuota, and
// a longer plan grows after its last cuota.
func TestEditKeepsPrepaidMonthsAndUnevenCuotas(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := s.CreateExpense(ctx, "2030-01-10", "Notebook", "", "", nil, KindCuotas, "100000", 4)
	mustOK(t, "CreateExpense", ex.Error)
	id := ex.Data.ID
	plan := cuotas(t, s, id)
	mustOK(t, "SetInstallmentPaid", s.SetInstallmentPaid(ctx, plan[0].ID, true).Error)
	mustOK(t, "SetInstallmentAmount", s.SetInstallmentAmount(ctx, plan[3].ID, "100001").Error)
	mustOK(t, "PrepayExpense", s.PrepayExpense(ctx, id, "2030-02").Error)
	prepaid := []string{"2030-01", "2030-02", "2030-02", "2030-02"}

	edit := func(amount string, total int) {
		t.Helper()
		mustOK(t, "UpdateExpense", s.UpdateExpense(ctx, id, "2030-01-10", "Notebook gamer", "Tecnología", "", nil,
			KindCuotas, amount, total).Error)
	}
	edit("100000", 4)
	if got := installmentPeriods(t, s, id); !slices.Equal(got, prepaid) {
		t.Fatalf("periods after a words edit = %v, want the prepayment %v kept", got, prepaid)
	}
	if got := cuotaAmounts(t, s, id); !slices.Equal(got, []string{"100000", "100000", "100000", "100001"}) {
		t.Fatalf("cuotas after a words edit = %v, want the cuota set by hand kept", got)
	}

	edit("90000", 4)
	if got := cuotaAmounts(t, s, id); !slices.Equal(got, []string{"100000", "90000", "90000", "90000"}) {
		t.Fatalf("cuotas after a new amount = %v, want it on every pending cuota", got)
	}
	if got := installmentPeriods(t, s, id); !slices.Equal(got, prepaid) {
		t.Fatalf("periods after a new amount = %v, want %v", got, prepaid)
	}

	edit("90000", 5)
	if got := installmentPeriods(t, s, id); !slices.Equal(got, append(prepaid, "2030-03")) {
		t.Fatalf("periods after growing = %v, want a fifth cuota after the last one", got)
	}
}

// A plan's row in the month says what its cuotas billed up to that month add
// up to and what is left, by month and at the cuotas' real amounts.
func TestCuotaProgressByMonth(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := s.CreateExpense(ctx, "2030-01-10", "Notebook", "", "", nil, KindCuotas, "100000", 4) // Jan..Apr
	mustOK(t, "CreateExpense", ex.Error)
	mustOK(t, "single", s.CreateExpense(ctx, "2030-02-05", "Café", "", "", nil, KindUnico, "3000", 1).Error)
	plan := cuotas(t, s, ex.Data.ID)
	mustOK(t, "settled last cuota", s.SetInstallmentAmount(ctx, plan[3].ID, "100001").Error)

	rows := func(period string) (planRows []Movimiento, single Movimiento) {
		t.Helper()
		for _, m := range monthly(t, s, period).Movimientos {
			if m.ExpenseID == ex.Data.ID {
				planRows = append(planRows, m)
			} else {
				single = m
			}
		}
		return planRows, single
	}
	feb, oneOff := rows("2030-02")
	if len(feb) != 1 || feb[0].SoFar == nil || feb[0].Remaining == nil {
		t.Fatalf("February plan rows = %+v, want one with its progress", feb)
	}
	wantMoney(t, "so far (cuotas 1-2)", *feb[0].SoFar, "200000")
	wantMoney(t, "remaining (cuotas 3-4)", *feb[0].Remaining, "200001")
	if feb[0].RemainingCount != 2 {
		t.Fatalf("remaining cuotas = %d, want 2", feb[0].RemainingCount)
	}
	if oneOff.SoFar != nil || oneOff.Remaining != nil || oneOff.RemainingCount != 0 {
		t.Fatalf("a one-payment expense carries progress: %+v", oneOff)
	}

	// Paid off in March: everything is behind it.
	mustOK(t, "pay cuota 1", s.SetInstallmentPaid(ctx, plan[0].ID, true).Error)
	mustOK(t, "pay cuota 2", s.SetInstallmentPaid(ctx, plan[1].ID, true).Error)
	mustOK(t, "PrepayExpense", s.PrepayExpense(ctx, ex.Data.ID, "2030-03").Error)
	mar, _ := rows("2030-03")
	if len(mar) != 2 {
		t.Fatalf("March plan rows = %d, want cuotas 3 and 4", len(mar))
	}
	for _, m := range mar {
		wantMoney(t, "so far after prepaying", *m.SoFar, "400001")
		wantMoney(t, "nothing left", *m.Remaining, "0")
		if m.RemainingCount != 0 {
			t.Fatalf("remaining cuotas after prepaying = %d", m.RemainingCount)
		}
	}
}

func TestSetInstallmentAmountOnlyOnPendingCuotas(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := s.CreateExpense(ctx, "2030-01-10", "Notebook", "", "", nil, KindCuotas, "100000", 3)
	mustOK(t, "CreateExpense", ex.Error)
	var insts []Installment
	if err := s.db.NewSelect().Model(&insts).Where("expense_id = ?", ex.Data.ID).Order("number ASC").Scan(ctx); err != nil {
		t.Fatal(err)
	}
	mustOK(t, "SetInstallmentAmount", s.SetInstallmentAmount(ctx, insts[2].ID, "99998").Error)
	if got := cuotaAmounts(t, s, ex.Data.ID); !slices.Equal(got, []string{"100000", "100000", "99998"}) {
		t.Fatalf("cuotas = %v", got)
	}
	mustOK(t, "SetInstallmentPaid", s.SetInstallmentPaid(ctx, insts[0].ID, true).Error)
	if r := s.SetInstallmentAmount(ctx, insts[0].ID, "1"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("a paid cuota = %+v, want VALIDATION", r.Error)
	}
	if r := s.SetInstallmentAmount(ctx, insts[1].ID, "0"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("zero = %+v, want VALIDATION", r.Error)
	}
	if r := s.SetInstallmentAmount(ctx, 999, "1"); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("unknown cuota = %+v, want NOT_FOUND", r.Error)
	}
}

func TestPrepayMovesOnlyPendingCuotas(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	ex := s.CreateExpense(ctx, "2030-01-10", "Notebook", "", "", nil, KindCuotas, "100000", 4)
	mustOK(t, "CreateExpense", ex.Error)
	var first Installment
	if err := s.db.NewSelect().Model(&first).Where("expense_id = ? AND number = 1", ex.Data.ID).Scan(ctx); err != nil {
		t.Fatal(err)
	}
	mustOK(t, "SetInstallmentPaid", s.SetInstallmentPaid(ctx, first.ID, true).Error)

	mustOK(t, "PrepayExpense", s.PrepayExpense(ctx, ex.Data.ID, "2030-02").Error)
	want := []string{"2030-01", "2030-02", "2030-02", "2030-02"}
	if got := installmentPeriods(t, s, ex.Data.ID); !slices.Equal(got, want) {
		t.Fatalf("periods = %v, want %v", got, want)
	}
	sum := s.MonthlySummary(ctx, "2030-02")
	mustOK(t, "MonthlySummary", sum.Error)
	if sum.Data.Gastos.String() != "300000" {
		t.Fatalf("february gastos = %s, want the 300.000 balance", sum.Data.Gastos)
	}
	if r := s.PrepayExpense(ctx, 999, "2030-02"); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("unknown expense = %+v, want NOT_FOUND", r.Error)
	}
	if r := s.PrepayExpense(ctx, ex.Data.ID, "2030-2"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("bad period = %+v, want VALIDATION", r.Error)
	}
	if r := s.PrepayExpense(ctx, ex.Data.ID, "2029-12"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("before the first cuota = %+v, want VALIDATION", r.Error)
	}
}
