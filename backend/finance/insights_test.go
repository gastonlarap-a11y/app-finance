package finance

import (
	"slices"
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func TestSavingsGoalsCountAsMonthlyOutflow(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)

	mustOK(t, "SetSalary", s.SetSalary(ctx, "2030-01", "1000000").Error)
	mustOK(t, "SetSalary", s.SetSalary(ctx, "2030-02", "1000000").Error)
	mustOK(t, "CreateExpense", s.CreateExpense(ctx, "2030-01-05", "Super", "Comida", "", nil, KindUnico, "200000", 1).Error)
	goal := s.CreateSavingsGoal(ctx, "Vacaciones", "1200000", "2030-12")
	mustOK(t, "CreateSavingsGoal", goal.Error)
	mustOK(t, "AddSavingsContribution", s.AddSavingsContribution(ctx, goal.Data.ID, "2030-01", "100000").Error)

	jan := s.MonthlySummary(ctx, "2030-01")
	mustOK(t, "MonthlySummary", jan.Error)
	if jan.Data.Ahorro.String() != "100000" || jan.Data.Balance.String() != "700000" || !jan.Data.Alcanza {
		t.Fatalf("enero ahorro/balance/alcanza = %s/%s/%v, want 100000/700000/true", jan.Data.Ahorro, jan.Data.Balance, jan.Data.Alcanza)
	}
	if jan.Data.Gastos.String() != "200000" {
		t.Fatalf("gastos = %s, want 200000 (el ahorro no es gasto)", jan.Data.Gastos)
	}
	feb := s.MonthlySummary(ctx, "2030-02")
	mustOK(t, "MonthlySummary feb", feb.Error)
	if feb.Data.Acumulado.String() != "700000" {
		t.Fatalf("acumulado feb = %s, want 700000 (arrastra el aporte)", feb.Data.Acumulado)
	}

	goals, err := s.listSavingsGoals(ctx, s.uid(), "2030-01")
	if err != nil || len(goals) != 1 {
		t.Fatalf("listSavingsGoals = %+v (err %v)", goals, err)
	}
	g := goals[0]
	// 1.100.000 restantes en 12 meses (ene..dic) → 91.666,67 → 91.667.
	if g.Saved.String() != "100000" || g.Remaining.String() != "1100000" || g.MonthsLeft != 12 || g.MonthlyNeeded.String() != "91667" {
		t.Fatalf("goal view = saved %s remaining %s months %d needed %s", g.Saved, g.Remaining, g.MonthsLeft, g.MonthlyNeeded)
	}

	year := s.YearSummary(ctx, 2030)
	mustOK(t, "YearSummary", year.Error)
	if year.Data.TotalAhorro.String() != "100000" || year.Data.Months[0].Balance.String() != "700000" {
		t.Fatalf("year ahorro %s / enero balance %s", year.Data.TotalAhorro, year.Data.Months[0].Balance)
	}
	fc := s.CommitmentsForecast(ctx, "2030-01", 1)
	mustOK(t, "CommitmentsForecast", fc.Error)
	// Libre = 1.000.000 ingresos − 200.000 comprometido − 100.000 ahorro.
	if fc.Data[0].Ahorro.String() != "100000" || fc.Data[0].Libre.String() != "700000" {
		t.Fatalf("forecast = %+v, want ahorro 100000 libre 700000", fc.Data[0])
	}

	// Trashing the goal takes its contributions out of every total; restoring brings them back.
	mustOK(t, "DeleteSavingsGoal", s.DeleteSavingsGoal(ctx, goal.Data.ID).Error)
	if r := s.AddSavingsContribution(ctx, goal.Data.ID, "2030-02", "1"); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("contribution to trashed goal = %+v, want NOT_FOUND", r.Error)
	}
	if got := s.MonthlySummary(ctx, "2030-02").Data.Acumulado.String(); got != "800000" {
		t.Fatalf("acumulado feb con meta en papelera = %s, want 800000", got)
	}
	trash := s.ListTrash(ctx)
	if !slices.ContainsFunc(trash.Data, func(it TrashItem) bool { return it.Type == "savingsgoal" && it.ID == goal.Data.ID }) {
		t.Fatalf("ListTrash = %+v, want the savings goal", trash.Data)
	}
	mustOK(t, "RestoreSavingsGoal", s.RestoreSavingsGoal(ctx, goal.Data.ID).Error)
	if got := s.MonthlySummary(ctx, "2030-02").Data.Acumulado.String(); got != "700000" {
		t.Fatalf("acumulado feb tras restaurar = %s, want 700000", got)
	}
}

func TestSavingsGoalValidation(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	tests := []struct {
		name, goal, target, period string
	}{
		{"sin nombre", " ", "1000", ""},
		{"monto cero", "Auto", "0", ""},
		{"monto negativo", "Auto", "-5", ""},
		{"período inválido", "Auto", "1000", "2030-13"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if r := s.CreateSavingsGoal(ctx, tt.goal, tt.target, tt.period); r.Error == nil || r.Error.Code != shared.ErrValidation {
				t.Fatalf("CreateSavingsGoal = %+v, want VALIDATION_ERROR", r.Error)
			}
		})
	}
	g := s.CreateSavingsGoal(ctx, "Auto", "1000", "")
	mustOK(t, "CreateSavingsGoal", g.Error)
	if r := s.AddSavingsContribution(ctx, g.Data.ID, "2030-01", "0"); r.Error == nil {
		t.Fatalf("zero contribution accepted")
	}
	c := s.AddSavingsContribution(ctx, g.Data.ID, "2030-01", "300")
	mustOK(t, "AddSavingsContribution", c.Error)
	mustOK(t, "DeleteSavingsContribution", s.DeleteSavingsContribution(ctx, c.Data.ID).Error)
	if r := s.DeleteSavingsContribution(ctx, c.Data.ID); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("second delete = %+v, want NOT_FOUND", r.Error)
	}
}

func TestSpendingTrend(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	for _, e := range []struct{ date, cat, amount string }{
		{"2030-01-05", "Comida", "100"},
		{"2030-02-05", "Comida", "200"},
		{"2030-03-05", "Comida", "300"},
		{"2030-03-06", "Ropa", "50"},
	} {
		mustOK(t, "CreateExpense", s.CreateExpense(ctx, e.date, "x", e.cat, "", nil, KindUnico, e.amount, 1).Error)
	}
	mustOK(t, "CreateFixedExpense", s.CreateFixedExpense(ctx, "Luz", "Servicios", nil, "2030-02", "10").Error)

	res := s.SpendingTrend(ctx, "2030-03", 3)
	mustOK(t, "SpendingTrend", res.Error)
	tr := res.Data
	var months []string
	for _, m := range tr.Months {
		months = append(months, m.Period+"="+m.Gastos.String())
	}
	if want := []string{"2030-01=100", "2030-02=210", "2030-03=360"}; !slices.Equal(months, want) {
		t.Fatalf("months = %v, want %v", months, want)
	}
	if tr.Current.String() != "360" || tr.Previous.String() != "210" || tr.Average.String() != "155" {
		t.Fatalf("current/previous/average = %s/%s/%s, want 360/210/155", tr.Current, tr.Previous, tr.Average)
	}
	var cats []string
	for _, c := range tr.Categories {
		cats = append(cats, c.Category+":"+c.Current.String()+"/"+c.Previous.String()+"/"+c.Average.String())
	}
	if want := []string{"Comida:300/200/150", "Ropa:50/0/0", "Servicios:10/10/5"}; !slices.Equal(cats, want) {
		t.Fatalf("categories = %v, want %v", cats, want)
	}
	for _, months := range []int{1, 25} {
		if r := s.SpendingTrend(ctx, "2030-03", months); r.Error == nil {
			t.Fatalf("SpendingTrend(months=%d) = nil error", months)
		}
	}
}

func TestDetectRecurring(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	add := func(date, desc, merchant, kind, amount string, n int) {
		t.Helper()
		mustOK(t, "CreateExpense "+desc, s.CreateExpense(ctx, date, desc, "Servicios", merchant, nil, kind, amount, n).Error)
	}
	// Spotify: 4 months, same amount → suggested.
	for _, m := range []string{"01", "02", "03", "04"} {
		add("2030-"+m+"-10", "Spotify", "Spotify", KindUnico, "5990", 1)
	}
	// Uber: 3 months but amounts too far apart → not recurring.
	add("2030-01-11", "Viaje", "Uber", KindUnico, "3000", 1)
	add("2030-02-11", "Viaje", "Uber", KindUnico, "9000", 1)
	add("2030-03-11", "Viaje", "Uber", KindUnico, "15000", 1)
	// Netflix: recurring but already a fixed expense → excluded.
	for _, m := range []string{"01", "02", "03"} {
		add("2030-"+m+"-12", "Netflix", "", KindUnico, "8990", 1)
	}
	mustOK(t, "CreateFixedExpense", s.CreateFixedExpense(ctx, "netflix", "Servicios", nil, "2030-04", "8990").Error)
	// Gimnasio in cuotas: never a candidate (only one-off expenses count).
	add("2030-01-13", "Gimnasio", "Gym", KindCuotas, "20000", 4)

	res := s.DetectRecurring(ctx, "2030-04")
	mustOK(t, "DetectRecurring", res.Error)
	if len(res.Data) != 1 {
		t.Fatalf("suggestions = %+v, want only Spotify", res.Data)
	}
	got := res.Data[0]
	if got.Description != "Spotify" || got.Amount.String() != "5990" || got.NextPeriod != "2030-05" ||
		!slices.Equal(got.Periods, []string{"2030-01", "2030-02", "2030-03", "2030-04"}) {
		t.Fatalf("suggestion = %+v", got)
	}
}
