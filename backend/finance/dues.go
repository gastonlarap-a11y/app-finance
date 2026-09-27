package finance

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Kinds of Due.
const (
	DueCard  = "tarjeta"
	DueFixed = "fijo"
)

const (
	// maxDueDays caps how far ahead UpcomingDues looks.
	maxDueDays = 60
	// dueLookbackDays keeps a missed due date on the list for a while: it is
	// still unpaid, so it is the most urgent one, until it goes stale.
	dueLookbackDays = 10
)

// Due is a payment coming up (or just missed) that is still unpaid: a card's
// statement (by its "pagar hasta" date) or a fixed expense with a due day.
type Due struct {
	Kind    string        `json:"kind"`    // DueCard | DueFixed
	RefID   int64         `json:"refId"`   // card id | fixed expense id
	Label   string        `json:"label"`   // card name | fixed expense description
	Period  string        `json:"period"`  // YYYY-MM billed
	DueDate string        `json:"dueDate"` // YYYY-MM-DD
	Amount  types.Decimal `json:"amount"`  // still pending, in pesos
	Overdue bool          `json:"overdue"`
}

type DuesResult struct {
	Data  []Due            `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

// UpcomingDues lists what falls due from `today` (YYYY-MM-DD, the caller's
// local date) to `days` days later and is still unpaid, plus what fell due in
// the last dueLookbackDays and is still unpaid, soonest first.
//
// A card falls due on the date its imported statement says; what is owed is
// the card's pending cuotas and fixed charges of the statement's month (a
// paid card drops off). A fixed expense falls due on its DueDay of each month
// it bills in; one on a card is paid with the card, so it only counts there.
func (s *FinanceService) UpcomingDues(ctx context.Context, today string, days int) DuesResult {
	now, err := time.Parse(dateLayout, today)
	if err != nil || !inYearRange(now) {
		return DuesResult{Error: shared.NewError(shared.ErrValidation, "fecha inválida (AAAA-MM-DD)")}
	}
	if days < 0 || days > maxDueDays {
		return DuesResult{Error: shared.NewError(shared.ErrValidation,
			fmt.Sprintf("los días deben estar entre 0 y %d", maxDueDays))}
	}
	w := dueWindow{
		today: today,
		from:  now.AddDate(0, 0, -dueLookbackDays).Format(dateLayout),
		to:    now.AddDate(0, 0, days).Format(dateLayout),
	}
	dues, err := s.upcomingDues(ctx, s.uid(), w)
	if err != nil {
		return DuesResult{Error: internalErr(err)}
	}
	return DuesResult{Data: dues}
}

// dueWindow is the [from, to] range of due dates UpcomingDues reports, as
// YYYY-MM-DD strings (they order lexically).
type dueWindow struct{ today, from, to string }

func (w dueWindow) holds(date string) bool { return date >= w.from && date <= w.to }

func (s *FinanceService) upcomingDues(ctx context.Context, uid int64, w dueWindow) ([]Due, error) {
	var statements []CardStatement
	if err := s.db.NewSelect().Model(&statements).
		Column("card_id", "period", "due_date").
		Where("user_id = ? AND card_id IS NOT NULL", uid).
		Where("due_date BETWEEN ? AND ?", w.from, w.to).
		Scan(ctx); err != nil {
		return nil, fmt.Errorf("loading statements: %w", err)
	}
	// A card's national and international statements of one month are paid
	// together: the earliest date wins.
	type cardMonth struct {
		card   int64
		period string
	}
	cardDue := map[cardMonth]string{}
	for _, st := range statements {
		k := cardMonth{*st.CardID, st.Period}
		if d, ok := cardDue[k]; !ok || st.DueDate < d {
			cardDue[k] = st.DueDate
		}
	}

	// Fixed expenses bill in the months the window touches.
	periods := monthsSpanned(w.from, w.to)
	for k := range cardDue {
		if !slices.Contains(periods, k.period) {
			periods = append(periods, k.period)
		}
	}
	ix, err := s.loadFixedIndex(ctx, uid)
	if err != nil {
		return nil, err
	}

	pendingByCard := map[cardMonth]types.Decimal{}
	if len(cardDue) > 0 {
		var rows []struct {
			CardID int64         `bun:"card_id"`
			Period string        `bun:"period"`
			Amount types.Decimal `bun:"amount"`
		}
		if err := s.db.NewSelect().TableExpr("installments AS i").
			Join("JOIN expenses AS e ON e.id = i.expense_id").
			ColumnExpr("e.card_id AS card_id, i.period, i.amount").
			Where("i.user_id = ? AND i.status = ?", uid, StatusPendiente).
			Where("e.deleted_at IS NULL AND e.card_id IS NOT NULL").
			Where("i.period IN (?)", bun.List(periods)).
			Scan(ctx, &rows); err != nil {
			return nil, fmt.Errorf("loading pending cuotas: %w", err)
		}
		for _, r := range rows {
			k := cardMonth{r.CardID, r.Period}
			pendingByCard[k] = pendingByCard[k].Add(r.Amount)
		}
	}

	var dues []Due
	for _, fe := range ix.fixed {
		for _, p := range periods {
			if !fe.billsIn(p) || ix.paid[fixedMonth{fe.ID, p}] {
				continue
			}
			clp, _, _ := fixedCharge(fe, ix.amounts[fe.ID], ix.uf, p)
			if fe.CardID != nil {
				k := cardMonth{*fe.CardID, p}
				if _, due := cardDue[k]; due {
					pendingByCard[k] = pendingByCard[k].Add(clp)
				}
				continue
			}
			if fe.DueDay == nil {
				continue
			}
			date := dayOfMonth(p, *fe.DueDay)
			if !w.holds(date) {
				continue
			}
			dues = append(dues, Due{
				Kind: DueFixed, RefID: fe.ID, Label: fe.Description, Period: p,
				DueDate: date, Amount: clp, Overdue: date < w.today,
			})
		}
	}

	if len(cardDue) > 0 {
		cards, err := s.cardMapAll(ctx, uid)
		if err != nil {
			return nil, fmt.Errorf("loading cards: %w", err)
		}
		for k, date := range cardDue {
			owed := pendingByCard[k]
			card, ok := cards[k.card]
			if !ok || !owed.IsPositive() {
				continue // paid (or nothing recorded) — nothing to remind
			}
			dues = append(dues, Due{
				Kind: DueCard, RefID: k.card, Label: card.Name, Period: k.period,
				DueDate: date, Amount: owed, Overdue: date < w.today,
			})
		}
	}

	slices.SortFunc(dues, func(a, b Due) int {
		return cmp.Or(cmp.Compare(a.DueDate, b.DueDate), cmp.Compare(a.Label, b.Label), cmp.Compare(a.RefID, b.RefID))
	})
	return dues, nil
}

// monthsSpanned lists the YYYY-MM months from date `from` to date `to`.
func monthsSpanned(from, to string) []string {
	var out []string
	for p := from[:7]; p <= to[:7]; p = addMonths(p, 1) {
		out = append(out, p)
	}
	return out
}

// dayOfMonth is the date of `day` in `period`, or of its last day when the
// month is shorter (31 → 30 de abril).
func dayOfMonth(period string, day int) string {
	t, err := time.Parse(periodLayout, period)
	if err != nil {
		return ""
	}
	last := t.AddDate(0, 1, -1).Day()
	return t.AddDate(0, 0, min(day, last)-1).Format(dateLayout)
}

// SetFixedExpenseDueDay sets the day of the month a fixed expense falls due
// (1–31; nil = no reminder).
func (s *FinanceService) SetFixedExpenseDueDay(ctx context.Context, id int64, day *int) OpResult {
	if day != nil && (*day < 1 || *day > 31) {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "el día de vencimiento debe estar entre 1 y 31")}
	}
	uid := s.uid()
	res, err := s.db.NewUpdate().Model((*FixedExpense)(nil)).Set("due_day = ?", day).
		Where("id = ? AND user_id = ?", id, uid).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "gasto fijo no encontrado")}
}
