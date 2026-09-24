package finance

import (
	"strings"
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func pdfBatch(items ...ImportCandidate) ImportBatch {
	return ImportBatch{Source: ImportSourcePDFAccount, Issuer: "Itau", Items: items}
}

func mustStage(t *testing.T, s *FinanceService, batch ImportBatch) StageSummary {
	t.Helper()
	r := s.StageImport(t.Context(), batch)
	mustOK(t, "StageImport", r.Error)
	return *r.Data
}

func mustList(t *testing.T, s *FinanceService, status string) []ImportItemView {
	t.Helper()
	r := s.ListImportItems(t.Context(), status)
	mustOK(t, "ListImportItems", r.Error)
	return r.Data
}

func TestNormalizeDescriptor(t *testing.T) {
	tests := []struct {
		in, norm, pattern string
	}{
		{"CRUZ VERDE L9093 CHILLAN  C", "cruz verde chillan", "cruz verde"},
		{"ENTEL PCS PAGO ENSANTIAGO C", "entel pcs pago ensantiago", "entel pcs"},
		{"TRANSFERENCIA A JUAN SOTO", "transferencia juan soto", "transferencia juan"},
		{"UBER *TRIP 4521", "uber *trip", "uber *trip"},
		{"  9093  C ", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := normalizeDescriptor(tt.in); got != tt.norm {
				t.Errorf("normalizeDescriptor = %q, want %q", got, tt.norm)
			}
			if got := suggestPattern(tt.in); got != tt.pattern {
				t.Errorf("suggestPattern = %q, want %q", got, tt.pattern)
			}
		})
	}
}

func TestRuleForPicksLongestWordPrefix(t *testing.T) {
	rules := []MerchantRule{
		{Pattern: "cruz verde", Merchant: "Cruz Verde"},
		{Pattern: "cruz verde chillan", Merchant: "Cruz Verde Chillán"},
		{Pattern: "cruz", Merchant: "Cruz"},
	}
	tests := []struct {
		desc, want string
		found      bool
	}{
		{"CRUZ VERDE L9093 CHILLAN C", "Cruz Verde Chillán", true},
		{"CRUZ VERDE L1 SANTIAGO C", "Cruz Verde", true},
		{"CRUZADA SPA", "", false}, // "cruz" must end at a word boundary
		{"FARMACIA AHUMADA", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.desc, func(t *testing.T) {
			r, ok := ruleFor(rules, tt.desc)
			if ok != tt.found || r.Merchant != tt.want {
				t.Fatalf("ruleFor = (%q, %v), want (%q, %v)", r.Merchant, ok, tt.want, tt.found)
			}
		})
	}
}

func TestStageImportDeduplicatesReimports(t *testing.T) {
	s := newTestService(t)
	batch := pdfBatch(
		ImportCandidate{Date: "2026-07-31", Description: "TRANSFERENCIA A LAURA MUNOZ", Amount: "2172638", Account: "0222222255", Reference: "100000010"},
		// Two identical purchases the same day are two items, not a duplicate.
		ImportCandidate{Date: "2026-07-17", Description: "CRUZ VERDE L9093 CHILLAN C", Amount: "16182", Account: "0222222255"},
		ImportCandidate{Date: "2026-07-17", Description: "CRUZ VERDE L9093 CHILLAN C", Amount: "16182", Account: "0222222255"},
	)
	if got := mustStage(t, s, batch); got != (StageSummary{Added: 3}) {
		t.Fatalf("first import = %+v, want 3 added", got)
	}
	if got := mustStage(t, s, batch); got != (StageSummary{Duplicates: 3}) {
		t.Fatalf("re-import = %+v, want 3 duplicates", got)
	}
	items := mustList(t, s, ImportPendiente)
	if len(items) != 3 || items[0].Issuer != "itau" || items[0].Currency != "CLP" || items[0].InstallmentsTotal != 1 {
		t.Fatalf("pending = %+v, want 3 normalized items", items)
	}
}

func TestStageImportRejectsInvalidBatches(t *testing.T) {
	s := newTestService(t)
	valid := ImportCandidate{Date: "2026-07-17", Description: "CRUZ VERDE", Amount: "16182"}
	with := func(f func(*ImportCandidate)) ImportBatch {
		c := valid
		f(&c)
		return pdfBatch(valid, c)
	}
	tests := []struct {
		name  string
		batch ImportBatch
		want  string
	}{
		{"origen desconocido", ImportBatch{Source: "fax", Issuer: "itau"}, "origen"},
		{"sin emisor", ImportBatch{Source: ImportSourceEmail, Issuer: " "}, "emisor"},
		{"fecha dd/mm", with(func(c *ImportCandidate) { c.Date = "17/07/2026" }), "movimiento 2: fecha"},
		{"monto con puntos", with(func(c *ImportCandidate) { c.Amount = "16.182.000" }), "movimiento 2: monto"},
		{"monto cero", with(func(c *ImportCandidate) { c.Amount = "0" }), "mayor a 0"},
		{"sin glosa", with(func(c *ImportCandidate) { c.Description = " " }), "descripción"},
		{"dígitos de tarjeta", with(func(c *ImportCandidate) { c.CardLastDigits = "12a4" }), "4 números"},
		{"pista desconocida", with(func(c *ImportCandidate) { c.Hint = "otro" }), "pista"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := s.StageImport(t.Context(), tt.batch)
			if r.Error == nil || r.Error.Code != shared.ErrValidation || !strings.Contains(r.Error.Message, tt.want) {
				t.Fatalf("StageImport = %+v, want VALIDATION containing %q", r.Error, tt.want)
			}
		})
	}
	// A rejected batch stages nothing, not even its valid candidates.
	if items := mustList(t, s, ImportPendiente); len(items) != 0 {
		t.Fatalf("pending after rejected batches = %d, want 0", len(items))
	}
}

func TestStageImportReconcilesAlertWithStatement(t *testing.T) {
	s := newTestService(t)
	alert := ImportBatch{Source: ImportSourceEmail, Issuer: "itau", Items: []ImportCandidate{
		{Date: "2026-07-10", Description: "COMPRA FALABELLA", Amount: "90000", CardLastDigits: "1234", Reference: "<msg-1@itau.cl>"},
	}}
	if got := mustStage(t, s, alert); got != (StageSummary{Added: 1}) {
		t.Fatalf("alert = %+v, want 1 added", got)
	}
	statement := ImportBatch{Source: ImportSourcePDFCard, Issuer: "itau", Items: []ImportCandidate{
		// Another card never matches, even with the same date and amount.
		{Date: "2026-07-10", Description: "COMPRA FALABELLA", Amount: "90000", CardLastDigits: "9999"},
		// Posted a day later, now with its cuotas: the same purchase.
		{Date: "2026-07-11", Description: "FALABELLA PARQUE ARAUCO", Amount: "90000", CardLastDigits: "1234", InstallmentsTotal: 3},
		// Same amount again: the alert is already matched, so this is new.
		{Date: "2026-07-11", Description: "FALABELLA PARQUE ARAUCO", Amount: "90000", CardLastDigits: "1234", InstallmentsTotal: 3},
	}}
	if got := mustStage(t, s, statement); got != (StageSummary{Added: 2, Reconciled: 1}) {
		t.Fatalf("statement = %+v, want 2 added + 1 reconciled", got)
	}

	conc := mustList(t, s, ImportConciliado)
	if len(conc) != 1 || conc[0].MatchedSource != ImportSourceEmail || conc[0].MatchedDate != "2026-07-10" {
		t.Fatalf("conciliado = %+v, want the statement line matched to the alert", conc)
	}
	for _, it := range mustList(t, s, ImportPendiente) {
		if it.Source == ImportSourceEmail && it.InstallmentsTotal != 3 {
			t.Fatalf("alert installments = %d, want 3 learned from the statement", it.InstallmentsTotal)
		}
	}
}

func TestConfirmImportItemCreatesExpenseAndLearnsRule(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Itaú Visa", "1000000", 24, "1234")
	mustOK(t, "CreateCard", card.Error)
	mustStage(t, s, ImportBatch{Source: ImportSourceEmail, Issuer: "itau", Items: []ImportCandidate{
		{Date: "2026-07-17", Description: "CRUZ VERDE L9093 CHILLAN C", Amount: "16182", CardLastDigits: "1234"},
	}})

	item := mustList(t, s, ImportPendiente)[0]
	if item.CardID == nil || *item.CardID != card.Data.ID || item.CardName != "Itaú Visa" || item.SuggestedPattern != "cruz verde" {
		t.Fatalf("pending view = %+v, want card resolved by last digits and pattern 'cruz verde'", item)
	}

	res := s.ConfirmImportItem(ctx, item.ID, item.Date, "Farmacia", "Salud", "Cruz Verde",
		item.CardID, KindUnico, item.Amount.String(), 1, "  CRUZ VERDE ")
	mustOK(t, "ConfirmImportItem", res.Error)
	sum := s.MonthlySummary(ctx, "2026-07")
	mustOK(t, "MonthlySummary", sum.Error)
	if sum.Data.Gastos.String() != "16182" {
		t.Fatalf("gastos 2026-07 = %s, want 16182 from the confirmed item", sum.Data.Gastos)
	}
	confirmed := mustList(t, s, ImportConfirmado)
	if len(confirmed) != 1 || confirmed[0].ExpenseID == nil || *confirmed[0].ExpenseID != res.Data.ID {
		t.Fatalf("confirmed = %+v, want linked to expense %d", confirmed, res.Data.ID)
	}

	again := s.ConfirmImportItem(ctx, item.ID, item.Date, "Farmacia", "", "", nil, KindUnico, "1", 1, "")
	if again.Error == nil || again.Error.Code != shared.ErrConflict {
		t.Fatalf("second confirm = %+v, want CONFLICT", again.Error)
	}

	// The learned rule now suggests merchant and category for another branch.
	mustStage(t, s, ImportBatch{Source: ImportSourceEmail, Issuer: "itau", Items: []ImportCandidate{
		{Date: "2026-07-20", Description: "CRUZ VERDE L0001 SANTIAGO C", Amount: "5990", CardLastDigits: "1234"},
	}})
	next := mustList(t, s, ImportPendiente)[0]
	if next.RulePattern != "cruz verde" || next.SuggestedMerchant != "Cruz Verde" || next.SuggestedCategory != "Salud" {
		t.Fatalf("suggestions = %+v, want rule 'cruz verde' → Cruz Verde / Salud", next)
	}
}

func TestConfirmImportItemRejectsEmptyPattern(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	mustStage(t, s, pdfBatch(ImportCandidate{Date: "2026-07-17", Description: "X", Amount: "1"}))
	item := mustList(t, s, ImportPendiente)[0]
	r := s.ConfirmImportItem(ctx, item.ID, item.Date, "X", "", "", nil, KindUnico, "1", 1, "123 C")
	if r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("confirm with pattern of only ids = %+v, want VALIDATION", r.Error)
	}
	if items := mustList(t, s, ImportPendiente); len(items) != 1 {
		t.Fatalf("pending after rejected confirm = %d, want 1 (nothing committed)", len(items))
	}
}

func TestListImportItemsSuggestsManualDuplicateAndLinks(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	manual := s.CreateExpense(ctx, "2026-07-16", "Remedios", "Salud", "", nil, KindUnico, "16182", 1)
	mustOK(t, "CreateExpense", manual.Error)
	cuotas := s.CreateExpense(ctx, "2026-07-01", "Notebook", "Tecnología", "", nil, KindCuotas, "100000", 6)
	mustOK(t, "CreateExpense", cuotas.Error)
	mustStage(t, s, pdfBatch(
		ImportCandidate{Date: "2026-07-17", Description: "CRUZ VERDE L9093 CHILLAN C", Amount: "16182"},
		ImportCandidate{Date: "2026-07-02", Description: "PARIS.CL", Amount: "600000"},                  // cuota × cuotas
		ImportCandidate{Date: "2026-07-25", Description: "CRUZ VERDE L9093 CHILLAN C", Amount: "16182"}, // too far
	))

	byDate := map[string]ImportItemView{}
	for _, it := range mustList(t, s, ImportPendiente) {
		byDate[it.Date] = it
	}
	if d := byDate["2026-07-17"].DuplicateExpenseID; d == nil || *d != manual.Data.ID || byDate["2026-07-17"].DuplicateDescription != "Remedios" {
		t.Fatalf("07-17 duplicate = %v, want manual expense %d", d, manual.Data.ID)
	}
	if d := byDate["2026-07-02"].DuplicateExpenseID; d == nil || *d != cuotas.Data.ID {
		t.Fatalf("07-02 duplicate = %v, want the cuotas expense by its total", d)
	}
	if d := byDate["2026-07-25"].DuplicateExpenseID; d != nil {
		t.Fatalf("07-25 duplicate = %v, want none (outside the window)", *d)
	}

	mustOK(t, "LinkImportItem", s.LinkImportItem(ctx, byDate["2026-07-17"].ID, manual.Data.ID).Error)
	if r := s.LinkImportItem(ctx, byDate["2026-07-25"].ID, 999); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("link to missing expense = %+v, want NOT_FOUND", r.Error)
	}
	// A linked expense is no longer offered for another item.
	mustStage(t, s, pdfBatch(ImportCandidate{Date: "2026-07-16", Description: "OTRA", Amount: "16182"}))
	for _, it := range mustList(t, s, ImportPendiente) {
		if it.Date == "2026-07-16" && it.DuplicateExpenseID != nil {
			t.Fatalf("already linked expense offered again: %+v", it)
		}
	}
}

func TestDiscardAndRestoreImportItem(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	mustStage(t, s, pdfBatch(ImportCandidate{Date: "2026-07-31", Description: "PAGO DEUDA INTER. TC CTA CLP", Amount: "137150", Hint: HintCardPayment}))
	item := mustList(t, s, ImportPendiente)[0]
	if item.Hint != HintCardPayment {
		t.Fatalf("hint = %q, want card_payment", item.Hint)
	}

	mustOK(t, "DiscardImportItem", s.DiscardImportItem(ctx, item.ID).Error)
	if r := s.DiscardImportItem(ctx, item.ID); r.Error == nil || r.Error.Code != shared.ErrConflict {
		t.Fatalf("discard twice = %+v, want CONFLICT", r.Error)
	}
	if len(mustList(t, s, ImportDescartado)) != 1 {
		t.Fatal("discarded item missing from descartado")
	}
	mustOK(t, "RestoreImportItem", s.RestoreImportItem(ctx, item.ID).Error)
	if len(mustList(t, s, ImportPendiente)) != 1 {
		t.Fatal("restored item missing from pendiente")
	}
	if r := s.DiscardImportItem(ctx, 999); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("discard missing = %+v, want NOT_FOUND", r.Error)
	}
	if r := s.ListImportItems(ctx, "todos"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("list unknown status = %+v, want VALIDATION", r.Error)
	}
}

func TestCardLastDigits(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	if r := s.CreateCard(ctx, "Visa", "0", 24, "12a4"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("CreateCard with bad digits = %+v, want VALIDATION", r.Error)
	}
	c := s.CreateCard(ctx, "Visa", "0", 24, " 4321 ")
	mustOK(t, "CreateCard", c.Error)
	if c.Data.LastDigits != "4321" {
		t.Fatalf("LastDigits = %q, want 4321", c.Data.LastDigits)
	}
	u := s.UpdateCard(ctx, c.Data.ID, "Visa", "0", 24, "")
	mustOK(t, "UpdateCard", u.Error)
	if u.Data.LastDigits != "" {
		t.Fatalf("LastDigits after clearing = %q, want empty", u.Data.LastDigits)
	}
}

func TestCardsByLastDigitsIgnoresAmbiguousDigits(t *testing.T) {
	got := cardsByLastDigits([]Card{
		{ID: 1, LastDigits: "1111"}, {ID: 2, LastDigits: "2222"}, {ID: 3, LastDigits: "2222"}, {ID: 4},
	})
	if len(got) != 1 || got["1111"].ID != 1 {
		t.Fatalf("cardsByLastDigits = %+v, want only 1111 → card 1", got)
	}
}
