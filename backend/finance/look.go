package finance

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"sync"

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

// loadLooks parses the embedded catalog once. It can only fail if the file
// shipped broken, which TestLooksCatalog catches before a release.
var loadLooks = sync.OnceValues(func() (lookCatalog, error) { return parseLooks(looksJSON) })

func parseLooks(raw []byte) (lookCatalog, error) {
	var file struct {
		Colors []string `json:"colors"`
		Icons  []string `json:"icons"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return lookCatalog{}, fmt.Errorf("parsing looks.json: %w", err)
	}
	cat := lookCatalog{colors: make(map[string]bool, len(file.Colors)), icons: make(map[string]bool, len(file.Icons))}
	for _, c := range file.Colors {
		cat.colors[c] = true
	}
	for _, i := range file.Icons {
		cat.icons[i] = true
	}
	return cat, nil
}

// validateLook checks an icon and a color key against the catalog; "" is
// automatic and always valid, so a setter of only one of them passes "" for
// the other.
func validateLook(icon, color string) *shared.AppError {
	cat, err := loadLooks()
	if err != nil {
		return internalErr(err)
	}
	if icon != "" && !cat.icons[icon] {
		return shared.NewError(shared.ErrValidation, "ícono no válido")
	}
	if color != "" && !cat.colors[color] {
		return shared.NewError(shared.ErrValidation, "color no válido")
	}
	return nil
}

// SetCategoryLook sets the icon and color of a live category of the profile
// ("" = automatic). Expenses reference categories by name, so the look follows
// a rename with no extra work.
func (s *FinanceService) SetCategoryLook(ctx context.Context, categoryID int64, icon, color string) OpResult {
	if aerr := validateLook(icon, color); aerr != nil {
		return OpResult{Error: aerr}
	}
	res, err := s.db.NewUpdate().Model((*Category)(nil)).Set("icon = ?", icon).Set("color = ?", color).
		Where("id = ? AND user_id = ?", categoryID, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "categoría no encontrada")}
}

// SetCardColor sets the color of a live card of the profile ("" = automatic).
func (s *FinanceService) SetCardColor(ctx context.Context, cardID int64, color string) OpResult {
	if aerr := validateLook("", color); aerr != nil {
		return OpResult{Error: aerr}
	}
	res, err := s.db.NewUpdate().Model((*Card)(nil)).Set("color = ?", color).
		Where("id = ? AND user_id = ?", cardID, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "tarjeta no encontrada")}
}

// SetSavingsGoalIcon sets the icon of a live savings goal of the profile
// ("" = automatic).
func (s *FinanceService) SetSavingsGoalIcon(ctx context.Context, goalID int64, icon string) OpResult {
	if aerr := validateLook(icon, ""); aerr != nil {
		return OpResult{Error: aerr}
	}
	res, err := s.db.NewUpdate().Model((*SavingsGoal)(nil)).Set("icon = ?", icon).
		Where("id = ? AND user_id = ?", goalID, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "meta no encontrada")}
}
