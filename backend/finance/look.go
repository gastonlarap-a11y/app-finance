package finance

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

// looks.json is the catalog of the icon and color keys a category, card or
// savings goal may store. The web engine reads the same file
// (frontend/src/engine/finance/looks.ts), so both sides accept the same keys.
//
//go:embed looks.json
var looksJSON []byte

// lookCatalog holds the allowed keys as sets. "" (automatic: the app picks
// from the name or id) is always allowed.
type lookCatalog struct {
	colors map[string]bool
	icons  map[string]bool
}

var looks = mustParseLooks(looksJSON)

func mustParseLooks(raw []byte) lookCatalog {
	var file struct {
		Colors []string `json:"colors"`
		Icons  []string `json:"icons"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		panic(fmt.Sprintf("finance: invalid looks.json: %v", err)) // embedded at build time: a bad file is a build bug
	}
	cat := lookCatalog{colors: make(map[string]bool, len(file.Colors)), icons: make(map[string]bool, len(file.Icons))}
	for _, c := range file.Colors {
		cat.colors[c] = true
	}
	for _, i := range file.Icons {
		cat.icons[i] = true
	}
	return cat
}

func validColor(key string) bool { return key == "" || looks.colors[key] }
func validIcon(key string) bool  { return key == "" || looks.icons[key] }

func invalidLook(what string) *shared.AppError {
	return shared.NewError(shared.ErrValidation, what+" no válido")
}

// SetCategoryLook sets the icon and color of a live category of the profile
// ("" = automatic). Expenses reference categories by name, so the look follows
// a rename with no extra work.
func (s *FinanceService) SetCategoryLook(ctx context.Context, categoryID int64, icon, color string) OpResult {
	if !validIcon(icon) {
		return OpResult{Error: invalidLook("ícono")}
	}
	if !validColor(color) {
		return OpResult{Error: invalidLook("color")}
	}
	res, err := s.db.NewUpdate().Model((*Category)(nil)).Set("icon = ?", icon).Set("color = ?", color).
		Where("id = ? AND user_id = ?", categoryID, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "categoría no encontrada")}
}

// SetCardColor sets the color of a live card of the profile ("" = automatic).
func (s *FinanceService) SetCardColor(ctx context.Context, cardID int64, color string) OpResult {
	if !validColor(color) {
		return OpResult{Error: invalidLook("color")}
	}
	res, err := s.db.NewUpdate().Model((*Card)(nil)).Set("color = ?", color).
		Where("id = ? AND user_id = ?", cardID, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "tarjeta no encontrada")}
}

// SetSavingsGoalIcon sets the icon of a live savings goal of the profile
// ("" = automatic).
func (s *FinanceService) SetSavingsGoalIcon(ctx context.Context, goalID int64, icon string) OpResult {
	if !validIcon(icon) {
		return OpResult{Error: invalidLook("ícono")}
	}
	res, err := s.db.NewUpdate().Model((*SavingsGoal)(nil)).Set("icon = ?", icon).
		Where("id = ? AND user_id = ?", goalID, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "meta no encontrada")}
}
