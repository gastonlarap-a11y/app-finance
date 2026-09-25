package finance

import "testing"

// cardChargesIn and pendingByCard replace full-row scans on hot paths; they
// must keep returning exactly what MonthlySummary's per-card figures showed.
func TestCardTotalsMatchTheMonthlySummary(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	a := s.CreateCard(ctx, "A", "1000000", 24, "")
	mustOK(t, "CreateCard", a.Error)
	b := s.CreateCard(ctx, "B", "1000000", 10, "")
	mustOK(t, "CreateCard", b.Error)
	mustOK(t, "cuotas on A", s.CreateExpense(ctx, "2026-06-10", "Tele", "", "", &a.Data.ID, KindCuotas, "30000", 6).Error)
	mustOK(t, "one-off on B", s.CreateExpense(ctx, "2026-07-02", "Cena", "", "", &b.Data.ID, KindUnico, "45000", 1).Error)
	mustOK(t, "cash", s.CreateExpense(ctx, "2026-07-03", "Feria", "", "", nil, KindUnico, "8000", 1).Error)
	gone := s.CreateExpense(ctx, "2026-07-04", "Borrado", "", "", &a.Data.ID, KindUnico, "99000", 1)
	mustOK(t, "trashed", gone.Error)
	mustOK(t, "DeleteExpense", s.DeleteExpense(ctx, gone.Data.ID).Error)
	mustOK(t, "fixed on B", s.CreateFixedExpense(ctx, "Seguro", "", &b.Data.ID, "2026-06", "12000").Error)
	paid := s.CreateExpense(ctx, "2026-06-10", "Pagado", "", "", &a.Data.ID, KindCuotas, "5000", 3)
	mustOK(t, "paid cuotas", paid.Error)
	first := cuotas(t, s, paid.Data.ID)[0]
	mustOK(t, "SetInstallmentPaid", s.SetInstallmentPaid(ctx, first.ID, true).Error)

	for _, period := range []string{"2026-06", "2026-07", "2026-08", "2026-12"} {
		sum := s.MonthlySummary(ctx, period)
		mustOK(t, "MonthlySummary", sum.Error)
		charges, err := s.cardChargesIn(ctx, 1, period)
		if err != nil {
			t.Fatal(err)
		}
		pending, err := s.pendingByCard(ctx, 1)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range sum.Data.PorTarjeta {
			if got := charges[d.Card.ID]; got.Cmp(d.GastoMes) != 0 {
				t.Errorf("%s card %s: cardChargesIn = %s, summary GastoMes = %s", period, d.Card.Name, got, d.GastoMes)
			}
			if got := pending[d.Card.ID]; got.Cmp(d.CupoUsado) != 0 {
				t.Errorf("%s card %s: pendingByCard = %s, summary CupoUsado = %s", period, d.Card.Name, got, d.CupoUsado)
			}
		}
	}
}
