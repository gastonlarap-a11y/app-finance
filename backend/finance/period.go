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

// currentPeriod is today's YYYY-MM.
func currentPeriod() string { return time.Now().Format(periodLayout) }

// validPeriod reports whether s parses as YYYY-MM.
func validPeriod(s string) bool {
	_, err := time.Parse(periodLayout, s)
	return err == nil
}
