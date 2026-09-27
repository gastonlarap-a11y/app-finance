package finance

import (
	"context"
	"fmt"

	"github.com/uptrace/bun"
)

// The bank's reference codes of an expense — what the user quotes to dispute
// a charge — come from three places: the inbox item it was confirmed from, the
// statement lines that billed its cuotas (linked to an installment), and the
// later statement lines that reported the same purchase again (linked to that
// item). One purchase gets a code per statement, as the issuer prints it.
//
// expenseReferencesSQL lists them as (expense_id, reference); `%[1]s` is an
// extra condition on the expense id column (ii.expense_id / i.expense_id) and
// every "?" is uid followed by that condition's arguments.
const expenseReferencesSQL = `
SELECT ii.expense_id AS expense_id, ii.reference AS reference
  FROM import_items AS ii
  WHERE ii.user_id = ? AND ii.expense_id IS NOT NULL AND ii.reference <> '' AND %[1]s
UNION
SELECT i.expense_id, l.reference
  FROM card_statement_lines AS l JOIN installments AS i ON i.id = l.installment_id
  WHERE l.user_id = ? AND i.user_id = l.user_id AND l.reference <> '' AND %[2]s
UNION
SELECT ii.expense_id, l.reference
  FROM card_statement_lines AS l JOIN import_items AS ii ON ii.id = l.import_item_id
  WHERE l.user_id = ? AND ii.user_id = l.user_id AND ii.expense_id IS NOT NULL AND l.reference <> '' AND %[1]s`

// referencesByExpense maps each of the given expenses to its reference codes,
// sorted (always a list for expenses that have any).
func (s *FinanceService) referencesByExpense(ctx context.Context, uid int64, ids []int64) (map[int64][]string, error) {
	out := map[int64][]string{}
	if len(ids) == 0 {
		return out, nil
	}
	list := bun.List(ids)
	query := fmt.Sprintf(expenseReferencesSQL, "ii.expense_id IN (?)", "i.expense_id IN (?)") + " ORDER BY expense_id, reference"
	var rows []struct {
		ExpenseID int64  `bun:"expense_id"`
		Reference string `bun:"reference"`
	}
	if err := s.db.NewRaw(query, uid, list, uid, list, uid, list).Scan(ctx, &rows); err != nil {
		return nil, fmt.Errorf("loading references: %w", err)
	}
	for _, r := range rows {
		out[r.ExpenseID] = append(out[r.ExpenseID], r.Reference)
	}
	return out, nil
}

// referenceMatch is a condition on ex.id: the expense has a reference code
// containing the LIKE pattern (escaped with '\').
func referenceMatch(uid int64, pattern string) (string, []any) {
	inner := fmt.Sprintf(expenseReferencesSQL, "1 = 1", "1 = 1")
	return "ex.id IN (SELECT expense_id FROM (" + inner + `) WHERE reference LIKE ? ESCAPE '\')`,
		[]any{uid, uid, uid, pattern}
}
