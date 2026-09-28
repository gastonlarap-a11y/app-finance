package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

func TestLooksCatalog(t *testing.T) {
	if len(looks.colors) != 12 {
		t.Fatalf("looks.json has %d colors, want 12", len(looks.colors))
	}
	if len(looks.icons) < 40 {
		t.Fatalf("looks.json has %d icons, want at least 40", len(looks.icons))
	}
	for _, key := range []string{"", "blue", "gray"} {
		if !validColor(key) {
			t.Errorf("validColor(%q) = false", key)
		}
	}
	for _, key := range []string{"", "shopping-cart", "piggy-bank", "tag"} {
		if !validIcon(key) {
			t.Errorf("validIcon(%q) = false", key)
		}
	}
	// Keys are exact: no case folding, no palette shades, no arbitrary CSS.
	for _, key := range []string{"Blue", "blue-500", "#ff0000", " blue"} {
		if validColor(key) {
			t.Errorf("validColor(%q) = true", key)
		}
	}
	if validIcon("ShoppingCart") || validIcon("skull") {
		t.Error("validIcon accepted a key outside the catalog")
	}
}

func TestSetCategoryLook(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	cat := s.CreateCategory(ctx, "Supermercado")
	mustOK(t, "CreateCategory", cat.Error)
	if cat.Data.Icon != "" || cat.Data.Color != "" {
		t.Fatalf("new category look = %q/%q, want automatic", cat.Data.Icon, cat.Data.Color)
	}
	trashed := s.CreateCategory(ctx, "Vieja")
	mustOK(t, "CreateCategory trashed", trashed.Error)
	mustOK(t, "DeleteCategory", s.DeleteCategory(ctx, trashed.Data.ID).Error)

	tests := []struct {
		name        string
		id          int64
		icon, color string
		wantCode    string // "" = success
	}{
		{"set both", cat.Data.ID, "shopping-cart", "green", ""},
		{"back to automatic", cat.Data.ID, "", "", ""},
		{"icon only", cat.Data.ID, "utensils", "", ""},
		{"unknown icon", cat.Data.ID, "skull", "green", shared.ErrValidation},
		{"unknown color", cat.Data.ID, "utensils", "magenta", shared.ErrValidation},
		{"missing category", 9999, "utensils", "green", shared.ErrNotFound},
		{"trashed category", trashed.Data.ID, "utensils", "green", shared.ErrNotFound},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := s.SetCategoryLook(ctx, tc.id, tc.icon, tc.color)
			if tc.wantCode == "" {
				mustOK(t, "SetCategoryLook", res.Error)
				return
			}
			if res.Error == nil || res.Error.Code != tc.wantCode {
				t.Fatalf("error = %v, want code %s", res.Error, tc.wantCode)
			}
		})
	}

	// The last successful write sticks, rejected ones change nothing, and a
	// rename keeps the look.
	mustOK(t, "UpdateCategory", s.UpdateCategory(ctx, cat.Data.ID, "Súper").Error)
	list, err := s.ListCategories(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("ListCategories = %+v, %v", list, err)
	}
	if list[0].Icon != "utensils" || list[0].Color != "" {
		t.Fatalf("look = %q/%q, want utensils/automatic", list[0].Icon, list[0].Color)
	}
}

func TestSetCardColor(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	card := s.CreateCard(ctx, "Visa", "1000000", 24, "")
	mustOK(t, "CreateCard", card.Error)
	if card.Data.Color != "" {
		t.Fatalf("new card color = %q, want automatic", card.Data.Color)
	}

	mustOK(t, "SetCardColor", s.SetCardColor(ctx, card.Data.ID, "indigo").Error)
	if r := s.SetCardColor(ctx, card.Data.ID, "shopping-cart"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("icon key as color: %v, want validation error", r.Error)
	}
	// Editing the card's data keeps its color.
	mustOK(t, "UpdateCard", s.UpdateCard(ctx, card.Data.ID, "Visa Oro", "2000000", 24, "1234").Error)
	cards, err := s.ListCards(ctx)
	if err != nil || len(cards) != 1 || cards[0].Color != "indigo" {
		t.Fatalf("ListCards = %+v, %v; want color indigo", cards, err)
	}

	mustOK(t, "DeleteCard", s.DeleteCard(ctx, card.Data.ID).Error)
	if r := s.SetCardColor(ctx, card.Data.ID, "red"); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("trashed card: %v, want not found", r.Error)
	}
}

func TestSetSavingsGoalIcon(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	goal := s.CreateSavingsGoal(ctx, "Vacaciones", "1500000", "")
	mustOK(t, "CreateSavingsGoal", goal.Error)
	if goal.Data.Icon != "" {
		t.Fatalf("new goal icon = %q, want automatic", goal.Data.Icon)
	}

	mustOK(t, "SetSavingsGoalIcon", s.SetSavingsGoalIcon(ctx, goal.Data.ID, "tree-palm").Error)
	if r := s.SetSavingsGoalIcon(ctx, goal.Data.ID, "green"); r.Error == nil || r.Error.Code != shared.ErrValidation {
		t.Fatalf("color key as icon: %v, want validation error", r.Error)
	}
	mustOK(t, "UpdateSavingsGoal", s.UpdateSavingsGoal(ctx, goal.Data.ID, "Viaje al sur", "2000000", "").Error)
	goals, err := s.ListSavingsGoals(ctx)
	if err != nil || len(goals) != 1 || goals[0].Icon != "tree-palm" {
		t.Fatalf("ListSavingsGoals = %+v, %v; want icon tree-palm", goals, err)
	}

	mustOK(t, "DeleteSavingsGoal", s.DeleteSavingsGoal(ctx, goal.Data.ID).Error)
	if r := s.SetSavingsGoalIcon(ctx, goal.Data.ID, "car"); r.Error == nil || r.Error.Code != shared.ErrNotFound {
		t.Fatalf("trashed goal: %v, want not found", r.Error)
	}
}
