package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func mustOK(t *testing.T, what string, err *shared.AppError) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", what, err)
	}
}

func TestDeleteMissingRowIsNotFound(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)

	cat := s.CreateCategory(ctx, "Comida")
	mustOK(t, "CreateCategory", cat.Error)
	mustOK(t, "DeleteCategory", s.DeleteCategory(ctx, cat.Data.ID).Error)

	tests := []struct {
		name string
		run  func() OpResult
	}{
		{"categoría ya eliminada", func() OpResult { return s.DeleteCategory(ctx, cat.Data.ID) }},
		{"tarjeta inexistente", func() OpResult { return s.DeleteCard(ctx, 999) }},
		{"gasto inexistente", func() OpResult { return s.DeleteExpense(ctx, 999) }},
		{"ingreso inexistente", func() OpResult { return s.DeleteIncome(ctx, 999) }},
		{"comercio inexistente", func() OpResult { return s.DeleteMerchant(ctx, 999) }},
		{"gasto fijo inexistente", func() OpResult { return s.DeleteFixedExpense(ctx, 999) }},
		{"cuota inexistente", func() OpResult { return s.SetInstallmentPaid(ctx, 999, true) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if r := tt.run(); r.Error == nil || r.Error.Code != shared.ErrNotFound {
				t.Fatalf("got %+v, want NOT_FOUND", r.Error)
			}
		})
	}
}

func TestRenameCategoryCascadesToFixedExpenses(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)

	cat := s.CreateCategory(ctx, "Servicios")
	mustOK(t, "CreateCategory", cat.Error)
	mustOK(t, "CreateFixedExpense", s.CreateFixedExpense(ctx, "Luz", "Servicios", nil, "2030-01", "30000").Error)
	mustOK(t, "UpdateCategory", s.UpdateCategory(ctx, cat.Data.ID, "Hogar").Error)

	fixed, err := s.ListFixedExpenses(ctx)
	if err != nil || len(fixed) != 1 || fixed[0].Category != "Hogar" {
		t.Fatalf("ListFixedExpenses = %+v (err %v), want category Hogar", fixed, err)
	}
}

func TestYearSummaryCategoryMonths(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)

	// 3 cuotas de 1000 desde marzo (sin tarjeta: no rueda) + fijo de 500 desde febrero.
	mustOK(t, "CreateExpense", s.CreateExpense(ctx, "2030-03-10", "Tele", "Hogar", "", nil, KindCuotas, "1000", 3).Error)
	mustOK(t, "CreateExpense", s.CreateExpense(ctx, "2030-01-05", "Pan", "", "", nil, KindUnico, "200", 1).Error)
	mustOK(t, "CreateFixedExpense", s.CreateFixedExpense(ctx, "Internet", "Hogar", nil, "2030-02", "500").Error)

	res := s.YearSummary(ctx, 2030)
	mustOK(t, "YearSummary", res.Error)
	rows := res.Data.CategoriaMeses
	if len(rows) != 2 {
		t.Fatalf("CategoriaMeses = %+v, want 2 rows", rows)
	}
	hogar := rows[0]
	if hogar.Category != "Hogar" || len(hogar.Months) != 12 {
		t.Fatalf("first row = %+v, want Hogar with 12 months", hogar)
	}
	wantHogar := map[int]string{0: "0", 1: "500", 2: "1500", 3: "1500", 4: "1500", 5: "500", 11: "500"}
	for i, want := range wantHogar {
		if got := hogar.Months[i].String(); got != want {
			t.Fatalf("Hogar month %d = %s, want %s", i+1, got, want)
		}
	}
	if got := hogar.Total.String(); got != "8500" { // 3000 cuotas + 11 × 500
		t.Fatalf("Hogar total = %s, want 8500", got)
	}
	if rows[1].Category != uncategorized || rows[1].Total.String() != "200" {
		t.Fatalf("second row = %+v, want Sin categoría 200", rows[1])
	}
	if res.Data.PorCategoria[0].Category != "Hogar" || res.Data.PorCategoria[0].Total.String() != "8500" {
		t.Fatalf("PorCategoria must agree with CategoriaMeses, got %+v", res.Data.PorCategoria)
	}
}

func TestCategoryBudgets(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)

	cat := s.CreateCategory(ctx, "Comida")
	mustOK(t, "CreateCategory", cat.Error)
	id := cat.Data.ID
	mustOK(t, "SetCategoryBudget 2030-01", s.SetCategoryBudget(ctx, id, "2030-01", "100000").Error)
	mustOK(t, "SetCategoryBudget 2030-03", s.SetCategoryBudget(ctx, id, "2030-03", "80000").Error)
	mustOK(t, "SetCategoryBudget 2030-05 (sin tope)", s.SetCategoryBudget(ctx, id, "2030-05", "0").Error)
	mustOK(t, "CreateExpense", s.CreateExpense(ctx, "2030-03-02", "Super", "Comida", "", nil, KindUnico, "90000", 1).Error)

	tests := []struct {
		name       string
		period     string
		wantBudget string // "" = sin presupuesto vigente
		wantOver   bool
	}{
		{"antes del primer tope", "2029-12", "", false},
		{"primer tope", "2030-02", "100000", false},
		{"cambio desde marzo no reescribe febrero, y se excede", "2030-03", "80000", true},
		{"monto 0 quita el tope", "2030-06", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sum := s.MonthlySummary(ctx, tt.period)
			mustOK(t, "MonthlySummary", sum.Error)
			if tt.wantBudget == "" {
				if len(sum.Data.Presupuestos) != 0 {
					t.Fatalf("Presupuestos = %+v, want none", sum.Data.Presupuestos)
				}
				return
			}
			if len(sum.Data.Presupuestos) != 1 {
				t.Fatalf("Presupuestos = %+v, want 1", sum.Data.Presupuestos)
			}
			b := sum.Data.Presupuestos[0]
			if b.Budget.String() != tt.wantBudget || b.Over != tt.wantOver {
				t.Fatalf("budget = %+v, want budget %s over %v", b, tt.wantBudget, tt.wantOver)
			}
		})
	}

	// Renaming the category keeps its budget (keyed by id), deleting hides it,
	// restoring brings it back.
	mustOK(t, "UpdateCategory", s.UpdateCategory(ctx, id, "Alimentación").Error)
	list := s.ListCategoryBudgets(ctx, "2030-03")
	mustOK(t, "ListCategoryBudgets", list.Error)
	if len(list.Data) != 1 || list.Data[0].Category != "Alimentación" || list.Data[0].EffectiveFrom != "2030-03" {
		t.Fatalf("ListCategoryBudgets after rename = %+v", list.Data)
	}
	mustOK(t, "DeleteCategory", s.DeleteCategory(ctx, id).Error)
	if l := s.ListCategoryBudgets(ctx, "2030-03"); len(l.Data) != 0 {
		t.Fatalf("budgets of a deleted category = %+v, want none", l.Data)
	}
	if r := s.SetCategoryBudget(ctx, id, "2030-03", "1"); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("SetCategoryBudget on deleted category = %+v, want NOT_FOUND", r.Error)
	}
	mustOK(t, "RestoreCategory", s.RestoreCategory(ctx, id).Error)
	if l := s.ListCategoryBudgets(ctx, "2030-03"); len(l.Data) != 1 {
		t.Fatalf("budgets after restore = %+v, want 1", l.Data)
	}
}

func TestCommitmentsForecast(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)

	mustOK(t, "SetSalary", s.SetSalary(ctx, "2029-12", "1000000").Error)
	mustOK(t, "SetSalary", s.SetSalary(ctx, "2030-02", "1200000").Error)
	mustOK(t, "CreateIncome", s.CreateIncome(ctx, "2030-03", "Bono", "50000").Error)
	mustOK(t, "CreateExpense", s.CreateExpense(ctx, "2030-01-10", "Notebook", "Tecno", "", nil, KindCuotas, "100000", 2).Error)
	mustOK(t, "CreateFixedExpense", s.CreateFixedExpense(ctx, "Plan", "Servicios", nil, "2030-02", "20000").Error)

	res := s.CommitmentsForecast(ctx, "2030-01", 3)
	mustOK(t, "CommitmentsForecast", res.Error)
	if len(res.Data) != 3 {
		t.Fatalf("forecast len = %d, want 3", len(res.Data))
	}
	tests := []struct {
		period, cuotas, fijos, ingresos, libre, saldo string
		estimado                                      bool
	}{
		// Saldo inicial = sueldo de 2029-12 (1.000.000).
		{"2030-01", "100000", "0", "1000000", "900000", "1900000", true},
		{"2030-02", "100000", "20000", "1200000", "1080000", "2980000", false},
		{"2030-03", "0", "20000", "1250000", "1230000", "4210000", true},
	}
	for i, want := range tests {
		got := res.Data[i]
		if got.Period != want.period || got.Cuotas.String() != want.cuotas || got.Fijos.String() != want.fijos ||
			got.Ingresos.String() != want.ingresos || got.Libre.String() != want.libre ||
			got.SaldoProyectado.String() != want.saldo || got.IngresoEstimado != want.estimado {
			t.Fatalf("month %d = %+v, want %+v", i, got, want)
		}
	}

	for _, months := range []int{0, 37} {
		if r := s.CommitmentsForecast(ctx, "2030-01", months); r.Error == nil {
			t.Fatalf("CommitmentsForecast(months=%d) = nil error, want validation", months)
		}
	}
}

func TestSearchExpenses(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)

	card := s.CreateCard(ctx, "Visa", "1000000", 24, "")
	mustOK(t, "CreateCard", card.Error)
	mustOK(t, "e1", s.CreateExpense(ctx, "2030-01-05", "Supermercado Lider", "Comida", "Lider", nil, KindUnico, "30000", 1).Error)
	mustOK(t, "e2", s.CreateExpense(ctx, "2030-02-05", "Zapatillas", "Ropa", "Falabella", &card.Data.ID, KindCuotas, "20000", 3).Error)
	mustOK(t, "e3", s.CreateExpense(ctx, "2030-03-05", "Descuento 100%_off", "", "", nil, KindUnico, "1000", 1).Error)
	deleted := s.CreateExpense(ctx, "2030-01-06", "Lider borrado", "Comida", "", nil, KindUnico, "5000", 1)
	mustOK(t, "e4", deleted.Error)
	mustOK(t, "DeleteExpense", s.DeleteExpense(ctx, deleted.Data.ID).Error)

	tests := []struct {
		name  string
		f     ExpenseFilter
		count int
		first string
	}{
		{"sin filtros, el más nuevo primero", ExpenseFilter{}, 3, "Descuento 100%_off"},
		{"texto en comercio, sin mayúsculas", ExpenseFilter{Text: "falabella"}, 1, "Zapatillas"},
		{"texto en descripción excluye borrados", ExpenseFilter{Text: "lider"}, 1, "Supermercado Lider"},
		{"% y _ se buscan literalmente", ExpenseFilter{Text: "100%_"}, 1, "Descuento 100%_off"},
		{"% solo no es comodín", ExpenseFilter{Text: "%"}, 1, "Descuento 100%_off"},
		{"por categoría", ExpenseFilter{Category: "Comida"}, 1, "Supermercado Lider"},
		{"sin categoría", ExpenseFilter{Category: uncategorized}, 1, "Descuento 100%_off"},
		{"por tarjeta", ExpenseFilter{CardID: &card.Data.ID}, 1, "Zapatillas"},
		// Zapatillas: compra 05/02 antes del corte → cuotas en 02, 03 y 04.
		{"rango que sólo toca cuotas posteriores", ExpenseFilter{FromPeriod: "2030-04", ToPeriod: "2030-04"}, 1, "Zapatillas"},
		{"paginado", ExpenseFilter{Limit: 1, Offset: 1}, 3, "Zapatillas"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := s.SearchExpenses(ctx, tt.f)
			mustOK(t, "SearchExpenses", res.Error)
			if res.Data.Count != tt.count {
				t.Fatalf("count = %d, want %d (%+v)", res.Data.Count, tt.count, res.Data.Items)
			}
			if len(res.Data.Items) == 0 || res.Data.Items[0].Expense.Description != tt.first {
				t.Fatalf("first item = %+v, want %q", res.Data.Items, tt.first)
			}
		})
	}

	hit := s.SearchExpenses(ctx, ExpenseFilter{Text: "zapatillas"}).Data.Items[0]
	if hit.CardName != "Visa" || hit.FirstPeriod != "2030-02" || hit.LastPeriod != "2030-04" || hit.Total.String() != "60000" {
		t.Fatalf("hit enrichment = %+v", hit)
	}

	if r := s.SearchExpenses(ctx, ExpenseFilter{FromPeriod: "2030-05", ToPeriod: "2030-01"}); r.Error == nil {
		t.Fatalf("inverted range = nil error, want validation")
	}
}
