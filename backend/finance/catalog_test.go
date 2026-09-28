package finance

import (
	"strings"
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

// learnRule stores an import rule for the active profile, as confirming a
// movement with «recordar» does.
func learnRule(t *testing.T, s *FinanceService, r MerchantRule) {
	t.Helper()
	r.UserID = s.uid()
	if err := saveMerchantRule(t.Context(), s.db, &r); err != nil {
		t.Fatalf("saving rule %q: %v", r.Pattern, err)
	}
}

// TestCatalogFile guards catalog.json: what ApplyCatalog and the web engine
// rely on (unique names and patterns, known categories, valid looks, patterns
// already in the normalized form descriptors are matched in).
func TestCatalogFile(t *testing.T) {
	cat, err := loadCatalog()
	if err != nil {
		t.Fatalf("catalog.json: %v", err)
	}
	if len(cat.Categories) < 30 || len(cat.Merchants) < 150 {
		t.Fatalf("catalog has %d categories and %d merchants, want at least 30 and 150", len(cat.Categories), len(cat.Merchants))
	}
	categories := map[string]bool{}
	for _, c := range cat.Categories {
		key := strings.ToLower(c.Name)
		if categories[key] {
			t.Errorf("duplicate category %q", c.Name)
		}
		categories[key] = true
		if strings.EqualFold(c.Name, uncategorized) {
			t.Errorf("category %q uses the reserved name", c.Name)
		}
		if aerr := validateLook(c.Icon, c.Color); aerr != nil || c.Icon == "" || c.Color == "" {
			t.Errorf("category %q look %q/%q: %v", c.Name, c.Icon, c.Color, aerr)
		}
	}
	merchants, patterns := map[string]bool{}, map[string]string{}
	for _, m := range cat.Merchants {
		key := strings.ToLower(m.Name)
		if merchants[key] {
			t.Errorf("duplicate merchant %q", m.Name)
		}
		merchants[key] = true
		if m.Category != "" && !categories[strings.ToLower(m.Category)] {
			t.Errorf("merchant %q names unknown category %q", m.Name, m.Category)
		}
		for _, p := range m.Patterns {
			if p == "" || normalizeDescriptor(p) != p {
				t.Errorf("merchant %q pattern %q is not normalized (%q)", m.Name, p, normalizeDescriptor(p))
			}
			if other, dup := patterns[p]; dup {
				t.Errorf("pattern %q used by %q and %q", p, other, m.Name)
			}
			patterns[p] = m.Name
		}
	}
}

func TestApplyCatalog(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	cat, err := loadCatalog()
	if err != nil {
		t.Fatal(err)
	}
	// What the profile already has: a category in another case, a merchant with
	// and one without a usual category, a merchant in the trash, a learned rule.
	mustOK(t, "tecnologia", s.CreateCategory(ctx, "TECNOLOGÍA").Error)
	mustOK(t, "comida", s.CreateCategory(ctx, "Comida").Error)
	cruz := s.CreateMerchant(ctx, "cruz verde")
	mustOK(t, "cruz verde", cruz.Error)
	uber := s.CreateMerchant(ctx, "Uber")
	mustOK(t, "uber", uber.Error)
	mustOK(t, "uber category", s.SetMerchantCategory(ctx, uber.Data.ID, "Comida").Error)
	netflix := s.CreateMerchant(ctx, "Netflix")
	mustOK(t, "netflix", netflix.Error)
	mustOK(t, "trash netflix", s.DeleteMerchant(ctx, netflix.Data.ID).Error)
	learnRule(t, s, MerchantRule{Pattern: "payu *uber", Merchant: "Uber", Category: "Comida"})

	first := s.ApplyCatalog(ctx)
	mustOK(t, "ApplyCatalog", first.Error)
	netflixPatterns := 0
	for _, m := range cat.Merchants {
		if m.Name == "Netflix" {
			netflixPatterns = len(m.Patterns)
		}
	}
	allPatterns := 0
	for _, m := range cat.Merchants {
		allPatterns += len(m.Patterns)
	}
	if want := len(cat.Categories) - 1; first.Data.Categories != want { // Tecnología already there
		t.Errorf("categories added = %d, want %d", first.Data.Categories, want)
	}
	if want := len(cat.Merchants) - 3; first.Data.Merchants != want { // cruz verde, Uber exist; Netflix trashed
		t.Errorf("merchants added = %d, want %d", first.Data.Merchants, want)
	}
	if want := allPatterns - netflixPatterns - 1; first.Data.Rules != want { // Netflix's skipped, "payu *uber" learned
		t.Errorf("rules added = %d, want %d", first.Data.Rules, want)
	}

	// Choices already made stand: the existing merchant keeps its name and
	// category, the learned rule keeps its target, the trashed merchant stays out.
	mers, err := s.ListMerchants(ctx)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]Merchant{}
	for _, m := range mers {
		byName[m.Name] = m
	}
	if byName["cruz verde"].Category != "Farmacia" {
		t.Errorf("cruz verde category = %q, want Farmacia (filled in)", byName["cruz verde"].Category)
	}
	if byName["Uber"].Category != "Comida" {
		t.Errorf("Uber category = %q, want the user's Comida", byName["Uber"].Category)
	}
	if _, ok := byName["Netflix"]; ok {
		t.Error("a trashed merchant came back")
	}
	if byName["Apple Store"].Category != "TECNOLOGÍA" {
		t.Errorf("Apple Store category = %q, want the profile's own spelling", byName["Apple Store"].Category)
	}
	rules, err := s.ListMerchantRules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rules {
		switch r.Pattern {
		case "payu *uber", "uber *trip":
			if r.Merchant != "Uber" || r.Category != "Comida" {
				t.Errorf("rule %q → %q/%q, want Uber/Comida", r.Pattern, r.Merchant, r.Category)
			}
		case "cruz verde":
			if r.Merchant != "cruz verde" || r.Category != "Farmacia" {
				t.Errorf("rule %q → %q/%q, want the existing merchant's name", r.Pattern, r.Merchant, r.Category)
			}
		case "netflix":
			t.Error("a trashed merchant's rule was learned")
		}
	}
	cats, err := s.ListCategories(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cats {
		if c.Name == "Supermercado" && (c.Icon != "shopping-cart" || c.Color != "green") {
			t.Errorf("Supermercado look = %q/%q", c.Icon, c.Color)
		}
		if c.Name == "TECNOLOGÍA" && c.Icon != "" {
			t.Errorf("an existing category's look was changed to %q", c.Icon)
		}
	}

	again := s.ApplyCatalog(ctx)
	mustOK(t, "ApplyCatalog again", again.Error)
	if *again.Data != (CatalogSummary{}) {
		t.Fatalf("second apply added %+v, want nothing", *again.Data)
	}
}

func TestMerchantCategoryAndRenames(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	tech := s.CreateCategory(ctx, "Tecnologia")
	mustOK(t, "category", tech.Error)
	apple := s.CreateMerchant(ctx, "Apple")
	mustOK(t, "merchant", apple.Error)

	tests := []struct {
		name, category, want, wantCode string
	}{
		{"any case, stored as the category is written", "TECNOLOGIA", "Tecnologia", ""},
		{"cleared", "", "", ""},
		{"unknown category", "Juguetes", "", shared.ErrValidation},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := s.SetMerchantCategory(ctx, apple.Data.ID, tc.category)
			if tc.wantCode != "" {
				if res.Error == nil || res.Error.Code != tc.wantCode {
					t.Fatalf("error = %v, want %s", res.Error, tc.wantCode)
				}
				return
			}
			mustOK(t, "SetMerchantCategory", res.Error)
			mers, _ := s.ListMerchants(ctx)
			if mers[0].Category != tc.want {
				t.Fatalf("category = %q, want %q", mers[0].Category, tc.want)
			}
		})
	}
	if r := s.SetMerchantCategory(ctx, 9999, ""); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("unknown merchant: %v", r.Error)
	}

	// Renames reach the merchant's usual category and the import rules.
	mustOK(t, "set", s.SetMerchantCategory(ctx, apple.Data.ID, "Tecnologia").Error)
	learnRule(t, s, MerchantRule{Pattern: "apple store", Merchant: "Apple", Category: "Tecnologia"})
	mustOK(t, "rename category", s.UpdateCategory(ctx, tech.Data.ID, "Tecnología").Error)
	mustOK(t, "rename merchant", s.UpdateMerchant(ctx, apple.Data.ID, "Apple Store").Error)
	mers, _ := s.ListMerchants(ctx)
	rules, _ := s.ListMerchantRules(ctx)
	if mers[0].Category != "Tecnología" || rules[0].Category != "Tecnología" || rules[0].Merchant != "Apple Store" {
		t.Fatalf("after renames: merchant %+v, rule %+v", mers[0], rules[0])
	}

	// An import whose rule names the merchant but no category gets its usual one.
	learnRule(t, s, MerchantRule{Pattern: "apple store", Merchant: "Apple Store"})
	it := stageOne(t, s, ImportCandidate{Date: "2026-09-10", Description: "APPLE STORE PARQUE ARAUCO", Amount: "999990"})
	if it.SuggestedMerchant != "Apple Store" || it.SuggestedCategory != "Tecnología" {
		t.Fatalf("suggestion = %q/%q, want Apple Store/Tecnología", it.SuggestedMerchant, it.SuggestedCategory)
	}
}
