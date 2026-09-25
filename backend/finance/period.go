package finance

import "time"

const periodLayout = "2006-01" // YYYY-MM

// periodOf returns the billing period (YYYY-MM) a purchase falls into. When the
// purchase is on a card and date.Day >= billingDay (cutoff is exclusive), it rolls
// to the next month. Pass billingDay <= 0 for non-card expenses (no roll).
func periodOf(date time.Time, billingDay int) string {
	y, m, _ := date.Date()
	t := time.Date(y, m, 1, 0, 0, 0, 0, time.UTC)
	if billingDay > 0 && date.Day() >= billingDay {
		t = t.AddDate(0, 1, 0)
	}
	return t.Format(periodLayout)
}

// addMonths advances a YYYY-MM period by n months.
func addMonths(period string, n int) string {
	t, err := time.Parse(periodLayout, period)
	if err != nil {
		return period
	}
	return t.AddDate(0, n, 0).Format(periodLayout)
}

// monthsBetween returns how many months b is after a (negative when b < a).
// Both must be valid periods; an unparseable one counts as 0 months apart.
func monthsBetween(a, b string) int {
	ta, errA := time.Parse(periodLayout, a)
	tb, errB := time.Parse(periodLayout, b)
	if errA != nil || errB != nil {
		return 0
	}
	return (tb.Year()-ta.Year())*12 + int(tb.Month()-ta.Month())
}

// currentPeriod is today's YYYY-MM.
func currentPeriod() string { return time.Now().Format(periodLayout) }

// The years a date or period may fall in. Periods are compared as strings, which
// only orders correctly while every year has exactly four digits; the bounds keep
// typos like 0226 or 9999 out, and even the last cuota of the longest plan
// (maxInstallments) started in maxYear stays four-digit.
const (
	minYear = 2000
	maxYear = 2099
)

// inYearRange reports whether t falls inside [minYear, maxYear].
func inYearRange(t time.Time) bool {
	return t.Year() >= minYear && t.Year() <= maxYear
}

// validPeriod reports whether s parses as YYYY-MM inside the supported years.
func validPeriod(s string) bool {
	t, err := time.Parse(periodLayout, s)
	return err == nil && inYearRange(t)
}
