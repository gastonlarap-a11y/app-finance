package finance

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

// Tag is a label across categories (viaje, trabajo, deducible) — Monarch's
// tags, Actual's #tags. An expense carries any number of them (expense_tags);
// SearchExpenses filters and totals by one.
type Tag struct {
	bun.BaseModel `bun:"table:tags,alias:tg"`

	ID        int64     `bun:"id,pk,autoincrement" json:"id"`
	UserID    int64     `bun:"user_id,notnull" json:"userId"`
	Name      string    `bun:"name,notnull" json:"name"`
	NameKey   string    `bun:"name_key,notnull" json:"-"` // lowercase name: "Viaje" and "viaje" are one tag
	CreatedAt time.Time `bun:"created_at,nullzero,default:current_timestamp" json:"createdAt"`
}

// ExpenseTag links an expense to a tag. It has no user_id: it is written only
// after proving both belong to the profile.
type ExpenseTag struct {
	bun.BaseModel `bun:"table:expense_tags,alias:et"`

	ExpenseID int64 `bun:"expense_id,pk"`
	TagID     int64 `bun:"tag_id,pk"`
}

// TagView is a tag with how many live expenses carry it.
type TagView struct {
	Tag
	Count int `bun:"count" json:"count"`
}

const (
	maxTagsPerExpense = 10
	maxTagLen         = 30
)

// tagKey is the case-insensitive identity of a tag name.
func tagKey(name string) string { return strings.ToLower(name) }

// cleanTagName trims a tag name and collapses its inner spaces.
func cleanTagName(name string) (string, *shared.AppError) {
	clean := strings.Join(strings.Fields(name), " ")
	if clean == "" {
		return "", shared.NewError(shared.ErrValidation, "la etiqueta no puede estar vacía")
	}
	if utf8.RuneCountInString(clean) > maxTagLen {
		return "", shared.NewError(shared.ErrValidation, fmt.Sprintf("la etiqueta «%s» supera los %d caracteres", clean, maxTagLen))
	}
	return clean, nil
}

// normalizeTags cleans the names, drops empty ones and case-insensitive
// repeats (the first spelling wins) and caps how many an expense carries.
func normalizeTags(names []string) ([]string, *shared.AppError) {
	out := make([]string, 0, len(names))
	seen := map[string]bool{}
	for _, n := range names {
		if strings.TrimSpace(n) == "" {
			continue
		}
		clean, aerr := cleanTagName(n)
		if aerr != nil {
			return nil, aerr
		}
		if seen[tagKey(clean)] {
			continue
		}
		seen[tagKey(clean)] = true
		out = append(out, clean)
	}
	if len(out) > maxTagsPerExpense {
		return nil, shared.NewError(shared.ErrValidation, fmt.Sprintf("un gasto puede tener hasta %d etiquetas", maxTagsPerExpense))
	}
	return out, nil
}

// SetExpenseTags replaces the tags of a live expense of the profile, creating
// the tags it does not have yet. An empty list removes them all.
func (s *FinanceService) SetExpenseTags(ctx context.Context, expenseID int64, names []string) OpResult {
	clean, aerr := normalizeTags(names)
	if aerr != nil {
		return OpResult{Error: aerr}
	}
	uid := s.uid()
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		owned, err := tx.NewSelect().Model((*Expense)(nil)).Where("id = ? AND user_id = ?", expenseID, uid).Exists(ctx)
		if err != nil {
			return fmt.Errorf("checking expense: %w", err)
		}
		if !owned {
			return shared.NewError(shared.ErrNotFound, "gasto no encontrado")
		}
		links := make([]ExpenseTag, 0, len(clean))
		for _, name := range clean {
			id, err := ensureTag(ctx, tx, uid, name)
			if err != nil {
				return err
			}
			links = append(links, ExpenseTag{ExpenseID: expenseID, TagID: id})
		}
		if _, err := tx.NewDelete().Model((*ExpenseTag)(nil)).Where("expense_id = ?", expenseID).Exec(ctx); err != nil {
			return fmt.Errorf("clearing tags: %w", err)
		}
		if len(links) == 0 {
			return nil
		}
		_, err = tx.NewInsert().Model(&links).Exec(ctx)
		return err
	})
	if err != nil {
		return OpResult{Error: appErr(err)}
	}
	return OpResult{}
}

// ensureTag returns the id of the profile's tag named `name` (any case),
// creating it with that spelling when it does not exist.
func ensureTag(ctx context.Context, tx bun.Tx, uid int64, name string) (int64, error) {
	tag := new(Tag)
	err := tx.NewSelect().Model(tag).Where("user_id = ? AND name_key = ?", uid, tagKey(name)).Scan(ctx)
	if err == nil {
		return tag.ID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("finding tag %q: %w", name, err)
	}
	tag = &Tag{UserID: uid, Name: name, NameKey: tagKey(name)}
	if _, err := tx.NewInsert().Model(tag).Returning("id").Exec(ctx); err != nil {
		return 0, fmt.Errorf("creating tag %q: %w", name, err)
	}
	return tag.ID, nil
}

// ListTags returns the profile's tags by name, with how many live expenses carry each.
func (s *FinanceService) ListTags(ctx context.Context) ([]TagView, error) {
	var out []TagView
	if err := s.db.NewRaw(`
		SELECT tg.*, (
			SELECT COUNT(*) FROM expense_tags AS et JOIN expenses AS e ON e.id = et.expense_id
			WHERE et.tag_id = tg.id AND e.deleted_at IS NULL
		) AS count
		FROM tags AS tg WHERE tg.user_id = ? ORDER BY tg.name_key`, s.uid()).Scan(ctx, &out); err != nil {
		return nil, fmt.Errorf("listing tags: %w", err)
	}
	if out == nil {
		out = []TagView{}
	}
	return out, nil
}

// RenameTag changes a tag's name everywhere it is used; merging two tags by
// renaming one onto the other is refused.
func (s *FinanceService) RenameTag(ctx context.Context, id int64, name string) OpResult {
	clean, aerr := cleanTagName(name)
	if aerr != nil {
		return OpResult{Error: aerr}
	}
	uid := s.uid()
	taken, err := s.db.NewSelect().Model((*Tag)(nil)).
		Where("user_id = ? AND name_key = ? AND id <> ?", uid, tagKey(clean), id).Exists(ctx)
	if err != nil {
		return OpResult{Error: internalErr(err)}
	}
	if taken {
		return OpResult{Error: shared.NewError(shared.ErrConflict, "ya existe una etiqueta con ese nombre")}
	}
	res, err := s.db.NewUpdate().Model((*Tag)(nil)).
		Set("name = ?", clean).Set("name_key = ?", tagKey(clean)).
		Where("id = ? AND user_id = ?", id, uid).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "etiqueta no encontrada")}
}

// DeleteTag removes a tag from every expense (the expenses stay).
func (s *FinanceService) DeleteTag(ctx context.Context, id int64) OpResult {
	res, err := s.db.NewDelete().Model((*Tag)(nil)).Where("id = ? AND user_id = ?", id, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "etiqueta no encontrada")}
}

// tagsByExpense maps each of the given expenses to its tag names, sorted.
func (s *FinanceService) tagsByExpense(ctx context.Context, uid int64, ids []int64) (map[int64][]string, error) {
	out := map[int64][]string{}
	if len(ids) == 0 {
		return out, nil
	}
	var rows []struct {
		ExpenseID int64  `bun:"expense_id"`
		Name      string `bun:"name"`
	}
	if err := s.db.NewRaw(`
		SELECT et.expense_id, tg.name FROM expense_tags AS et JOIN tags AS tg ON tg.id = et.tag_id
		WHERE tg.user_id = ? AND et.expense_id IN (?)`, uid, bun.List(ids)).Scan(ctx, &rows); err != nil {
		return nil, fmt.Errorf("loading expense tags: %w", err)
	}
	for _, r := range rows {
		out[r.ExpenseID] = append(out[r.ExpenseID], r.Name)
	}
	for id := range out {
		slices.SortFunc(out[id], func(a, b string) int { return strings.Compare(tagKey(a), tagKey(b)) })
	}
	return out, nil
}
