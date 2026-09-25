package finance

import (
	"fmt"
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/db/dbtest"
	"github.com/gastonlarap-a11y/app-finance/backend/users"
)

// errOf keeps a nil *AppError from becoming a non-nil error interface.
func errOf(ae *shared.AppError) error {
	if ae == nil {
		return nil
	}
	return ae
}

// Benchmarks over a realistic multi-year history, to measure (not guess) what
// grows with the data: go test -run '^$' -bench . -benchtime 20x ./backend/finance
//
// seedHistory builds `years` of monthly activity ending in 2026-12: salary,
// extras, 40 one-off expenses, 4 twelve-cuota purchases, 8 fixed expenses,
// one card statement a month, and a pending inbox.
func seedHistory(b *testing.B, years int) *FinanceService {
	b.Helper()
	ctx := b.Context()
	s := NewFinanceService(dbtest.OpenMigrated(b), users.NewSession())
	card := s.CreateCard(ctx, "Visa", "5000000", 24, "4321")
	if card.Error != nil {
		b.Fatal(card.Error)
	}
	first := 2027 - years
	for i := range 8 {
		if r := s.CreateFixedExpense(ctx, fmt.Sprintf("Fijo %d", i), "Servicios", nil, fmt.Sprintf("%d-01", first), "25000"); r.Error != nil {
			b.Fatal(r.Error)
		}
	}
	for y := first; y <= 2026; y++ {
		for m := 1; m <= 12; m++ {
			period := fmt.Sprintf("%d-%02d", y, m)
			if r := s.SetSalary(ctx, period, "2500000"); r.Error != nil {
				b.Fatal(r.Error)
			}
			if r := s.CreateIncome(ctx, period, "Extra", "100000"); r.Error != nil {
				b.Fatal(r.Error)
			}
			for d := range 40 {
				date := fmt.Sprintf("%s-%02d", period, d%28+1)
				if r := s.CreateExpense(ctx, date, fmt.Sprintf("Gasto %d", d), fmt.Sprintf("Cat %d", d%10), "", &card.Data.ID, KindUnico, "15000", 1); r.Error != nil {
					b.Fatal(r.Error)
				}
			}
			for c := range 4 {
				date := fmt.Sprintf("%s-%02d", period, c+5)
				if r := s.CreateExpense(ctx, date, fmt.Sprintf("Cuotas %d", c), "Tecnología", "", &card.Data.ID, KindCuotas, "50000", 12); r.Error != nil {
					b.Fatal(r.Error)
				}
			}
			st := nationalStatement()
			st.StatementDate = period + "-25"
			st.PeriodTo = st.StatementDate
			if r := s.ImportCardStatement(ctx, st); r.Error != nil {
				b.Fatal(r.Error)
			}
		}
	}
	items := make([]ImportCandidate, 200)
	for i := range items {
		items[i] = ImportCandidate{Date: fmt.Sprintf("2026-12-%02d", i%28+1), Description: fmt.Sprintf("COMERCIO %d", i), Amount: fmt.Sprintf("%d", 1000+i)}
	}
	if r := s.StageImport(ctx, pdfBatch(items...)); r.Error != nil {
		b.Fatal(r.Error)
	}
	return s
}

func BenchmarkSummaries(b *testing.B) {
	s := seedHistory(b, 5)
	ctx := b.Context()
	for _, bench := range []struct {
		name string
		run  func() error
	}{
		{"MonthlySummary", func() error { return errOf(s.MonthlySummary(ctx, "2026-12").Error) }},
		{"YearSummary", func() error { return errOf(s.YearSummary(ctx, 2026).Error) }},
		{"ListImportItems", func() error { return errOf(s.ListImportItems(ctx, ImportPendiente).Error) }},
		{"ListCardStatements", func() error { return errOf(s.ListCardStatements(ctx, "").Error) }},
		{"CommitmentsForecast", func() error { return errOf(s.CommitmentsForecast(ctx, "2026-12", 12).Error) }},
		{"SpendingTrend", func() error { return errOf(s.SpendingTrend(ctx, "2026-12", 6).Error) }},
	} {
		b.Run(bench.name, func(b *testing.B) {
			for b.Loop() {
				if err := bench.run(); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
