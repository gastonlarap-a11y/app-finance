package finance

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/uptrace/bun"
)

// billingWindow is one billing period a card statement printed: purchases
// dated from..to (inclusive, YYYY-MM-DD) are billed in period.
type billingWindow struct {
	from, to, period string
}

// cardCutoff places a card purchase in its billing month. Banks move the
// cutoff with weekends and holidays (Itaú closed one statement on the 25th
// and the next on the 23rd), so the windows the card's own statements printed
// decide first — each statement's billed period, then the next period it
// announces — and the card's billing day only covers dates no statement
// reached yet. The zero value is a purchase without a card: billed in its own
// month.
type cardCutoff struct {
	billingDay int
	windows    []billingWindow // billed periods before announced ones: a real close beats a forecast
}

// periodOf is the billing month of a purchase made on date.
func (c cardCutoff) periodOf(date time.Time) string {
	day := date.Format(dateLayout)
	for _, w := range c.windows {
		if w.from <= day && day <= w.to {
			return w.period
		}
	}
	return periodOf(date, c.billingDay)
}

// cutoffsFor loads the cutoff of uid's cards (all of them when no id is
// given; trashed ones included, an edit may keep one), keyed by card id.
func cutoffsFor(ctx context.Context, db bun.IDB, uid int64, cardIDs ...int64) (map[int64]cardCutoff, error) {
	var cards []Card
	q := db.NewSelect().Model(&cards).WhereAllWithDeleted().Where("user_id = ?", uid)
	if len(cardIDs) > 0 {
		q = q.Where("id IN (?)", bun.List(cardIDs))
	}
	if err := q.Scan(ctx); err != nil {
		return nil, fmt.Errorf("loading cards: %w", err)
	}
	out := make(map[int64]cardCutoff, len(cards))
	if len(cards) == 0 {
		return out, nil
	}
	ids := make([]int64, 0, len(cards))
	for _, c := range cards {
		out[c.ID] = cardCutoff{billingDay: c.BillingDay}
		ids = append(ids, c.ID)
	}
	var sts []CardStatement
	if err := db.NewSelect().Model(&sts).
		Column("card_id", "period", "period_from", "period_to", "next_period_from", "next_period_to").
		Where("user_id = ? AND card_id IN (?)", uid, bun.List(ids)).
		Order("statement_date DESC").Scan(ctx); err != nil {
		return nil, fmt.Errorf("loading statement windows: %w", err)
	}
	billed := map[int64][]billingWindow{}
	announced := map[int64][]billingWindow{}
	for _, st := range sts {
		if st.CardID == nil {
			continue
		}
		id := *st.CardID
		if validWindow(st.PeriodFrom, st.PeriodTo) {
			billed[id] = append(billed[id], billingWindow{st.PeriodFrom, st.PeriodTo, st.Period})
		}
		if validWindow(st.NextPeriodFrom, st.NextPeriodTo) {
			announced[id] = append(announced[id], billingWindow{st.NextPeriodFrom, st.NextPeriodTo, addMonths(st.Period, 1)})
		}
	}
	for id, c := range out {
		c.windows = slices.Concat(billed[id], announced[id])
		out[id] = c
	}
	return out, nil
}

func validWindow(from, to string) bool {
	return from != "" && to != "" && from <= to
}
