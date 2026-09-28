package finance

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

// catalog.json is the suggested starting set for a Chilean household: the
// usual categories (with an icon and color from looks.json) and well-known
// merchants with their usual category and the bank-descriptor prefixes that
// identify them in imports. The web engine reads the same file
// (frontend/src/engine/finance/catalog.ts).
//
//go:embed catalog.json
var catalogJSON []byte

type catalogCategory struct {
	Name  string `json:"name"`
	Icon  string `json:"icon"`
	Color string `json:"color"`
}

type catalogMerchant struct {
	Name     string   `json:"name"`
	Category string   `json:"category"` // "" = sells everything (a department store): no usual category
	Patterns []string `json:"patterns"` // normalized descriptor prefixes (see normalizeDescriptor)
}

type catalogFile struct {
	Categories []catalogCategory `json:"categories"`
	Merchants  []catalogMerchant `json:"merchants"`
}

// loadCatalog parses the embedded file once; TestCatalogFile checks its shape.
var loadCatalog = sync.OnceValues(func() (catalogFile, error) {
	var f catalogFile
	if err := json.Unmarshal(catalogJSON, &f); err != nil {
		return catalogFile{}, fmt.Errorf("parsing catalog.json: %w", err)
	}
	return f, nil
})

// CatalogSummary is what applying the catalog added.
type CatalogSummary struct {
	Categories int `json:"categories"`
	Merchants  int `json:"merchants"`
	Rules      int `json:"rules"`
}

type CatalogResult struct {
	Data  *CatalogSummary  `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

// ApplyCatalog adds to the profile what it lacks from the suggested catalog,
// and never changes a choice already made: names are compared in any case,
// a name in the trash counts as taken (it was removed on purpose), an existing
// merchant only gets a usual category when it had none, and an existing rule
// pattern is left alone. Applying it twice adds nothing the second time.
func (s *FinanceService) ApplyCatalog(ctx context.Context) CatalogResult {
	cat, err := loadCatalog()
	if err != nil {
		return CatalogResult{Error: internalErr(err)}
	}
	uid := s.uid()
	sum := &CatalogSummary{}
	err = s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		categoryOf, err := applyCatalogCategories(ctx, tx, uid, cat.Categories, sum)
		if err != nil {
			return err
		}
		return applyCatalogMerchants(ctx, tx, uid, cat.Merchants, categoryOf, sum)
	})
	if err != nil {
		return CatalogResult{Error: appErr(err)}
	}
	return CatalogResult{Data: sum}
}

// applyCatalogCategories creates the missing categories and returns the live
// name each lowercased catalog name resolves to ("" when it is in the trash).
func applyCatalogCategories(ctx context.Context, tx bun.Tx, uid int64, want []catalogCategory, sum *CatalogSummary) (map[string]string, error) {
	var have []Category
	if err := tx.NewSelect().Model(&have).WhereAllWithDeleted().Where("user_id = ?", uid).Scan(ctx); err != nil {
		return nil, fmt.Errorf("listing categories: %w", err)
	}
	taken := map[string]bool{}
	live := map[string]string{}
	for _, c := range have {
		key := strings.ToLower(c.Name)
		taken[key] = true
		if c.DeletedAt == nil {
			live[key] = c.Name
		}
	}
	var add []Category
	for _, c := range want {
		key := strings.ToLower(c.Name)
		if taken[key] {
			continue
		}
		taken[key], live[key] = true, c.Name
		add = append(add, Category{UserID: uid, Name: c.Name, Icon: c.Icon, Color: c.Color})
	}
	if len(add) > 0 {
		if _, err := tx.NewInsert().Model(&add).Exec(ctx); err != nil {
			return nil, fmt.Errorf("adding catalog categories: %w", err)
		}
	}
	sum.Categories = len(add)
	return live, nil
}

// applyCatalogMerchants creates the missing merchants, gives an existing one
// without a usual category the catalog's, and learns the missing rules.
func applyCatalogMerchants(
	ctx context.Context, tx bun.Tx, uid int64, want []catalogMerchant, categoryOf map[string]string, sum *CatalogSummary,
) error {
	var have []Merchant
	if err := tx.NewSelect().Model(&have).WhereAllWithDeleted().Where("user_id = ?", uid).Scan(ctx); err != nil {
		return fmt.Errorf("listing merchants: %w", err)
	}
	trashed := map[string]bool{}
	live := map[string]*Merchant{}
	for i := range have {
		key := strings.ToLower(have[i].Name)
		if have[i].DeletedAt != nil {
			trashed[key] = true
		} else {
			live[key] = &have[i]
		}
	}
	var rules []MerchantRule
	if err := tx.NewSelect().Model(&rules).Where("user_id = ?", uid).Scan(ctx); err != nil {
		return fmt.Errorf("listing merchant rules: %w", err)
	}
	patternTaken := map[string]bool{}
	for _, r := range rules {
		patternTaken[r.Pattern] = true
	}

	var addMerchants []Merchant
	var addRules []MerchantRule
	for _, m := range want {
		key := strings.ToLower(m.Name)
		if trashed[key] && live[key] == nil {
			continue // removed on purpose: neither it nor its rules come back
		}
		category := categoryOf[strings.ToLower(m.Category)]
		name := m.Name
		if cur := live[key]; cur != nil {
			name = cur.Name
			if cur.Category == "" && category != "" {
				if _, err := tx.NewUpdate().Model((*Merchant)(nil)).Set("category = ?", category).
					Where("id = ? AND user_id = ?", cur.ID, uid).Exec(ctx); err != nil {
					return fmt.Errorf("setting the category of merchant %q: %w", cur.Name, err)
				}
				cur.Category = category
			}
			category = cur.Category
		} else {
			// Catalog names are unique (TestCatalogFile), so no later entry looks this one up.
			addMerchants = append(addMerchants, Merchant{UserID: uid, Name: m.Name, Category: category})
		}
		for _, p := range m.Patterns {
			if patternTaken[p] {
				continue
			}
			patternTaken[p] = true
			addRules = append(addRules, MerchantRule{UserID: uid, Pattern: p, Merchant: name, Category: category})
		}
	}
	if len(addMerchants) > 0 {
		if _, err := tx.NewInsert().Model(&addMerchants).Exec(ctx); err != nil {
			return fmt.Errorf("adding catalog merchants: %w", err)
		}
	}
	if len(addRules) > 0 {
		if _, err := tx.NewInsert().Model(&addRules).Exec(ctx); err != nil {
			return fmt.Errorf("adding catalog rules: %w", err)
		}
	}
	sum.Merchants, sum.Rules = len(addMerchants), len(addRules)
	return nil
}
