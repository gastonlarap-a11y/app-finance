package reminders

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/gastonlarap-a11y/app-finance/backend/finance"
	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

type sent struct{ id, title, body string }

type fakeNotifier struct {
	sent []sent
	err  error
}

func (f *fakeNotifier) Notify(id, title, body string) error {
	if f.err != nil {
		return f.err
	}
	f.sent = append(f.sent, sent{id, title, body})
	return nil
}

func amount(t *testing.T, s string) types.Decimal {
	t.Helper()
	d, err := types.New(s)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// testService reminds of `dues` on 2026-09-07, with an in-memory "last sent".
func testService(dues []finance.Due, derr *shared.AppError, n Notifier) (*Service, *string) {
	last := new(string)
	return &Service{
		dues: func(context.Context, string, int) finance.DuesResult {
			return finance.DuesResult{Data: dues, Error: derr}
		},
		notifier: n,
		now:      func() time.Time { return time.Date(2026, 9, 7, 9, 0, 0, 0, time.Local) },
		lastSent: func() string { return *last },
		markSent: func(day string) { *last = day },
	}, last
}

func TestCheckNotifiesOnceADay(t *testing.T) {
	dues := []finance.Due{
		{Kind: finance.DueFixed, Label: "Arriendo", DueDate: "2026-09-05", Amount: amount(t, "400000"), Overdue: true},
		{Kind: finance.DueCard, Label: "Visa", DueDate: "2026-09-08", Amount: amount(t, "60000.4")},
	}
	n := &fakeNotifier{}
	s, last := testService(dues, nil, n)
	s.check(t.Context())
	s.check(t.Context())
	if len(n.sent) != 1 || *last != "2026-09-07" {
		t.Fatalf("sent = %+v, last = %q; want one notification today", n.sent, *last)
	}
	want := sent{
		id:    "vencimientos-2026-09-07",
		title: "Tienes pagos vencidos",
		body:  "Arriendo: $400.000, venció el 5/9\nVisa: $60.000, vence mañana",
	}
	if n.sent[0] != want {
		t.Fatalf("notification = %+v, want %+v", n.sent[0], want)
	}
}

func TestCheckSkipsQuietDaysAndRetriesFailures(t *testing.T) {
	t.Run("nothing due leaves the day open", func(t *testing.T) {
		n := &fakeNotifier{}
		s, last := testService(nil, nil, n)
		s.check(t.Context())
		if len(n.sent) != 0 || *last != "" {
			t.Fatalf("sent = %+v, last = %q", n.sent, *last)
		}
	})
	due := []finance.Due{{Label: "Visa", DueDate: "2026-09-10", Amount: amount(t, "1")}}
	t.Run("a failed send is retried", func(t *testing.T) {
		s, last := testService(due, nil, &fakeNotifier{err: errors.New("boom")})
		s.check(t.Context())
		if *last != "" {
			t.Fatalf("last = %q, want the day still open", *last)
		}
	})
	t.Run("denied permission waits until tomorrow", func(t *testing.T) {
		s, last := testService(due, nil, &fakeNotifier{err: errNotAuthorized})
		s.check(t.Context())
		if *last != "2026-09-07" {
			t.Fatalf("last = %q, want today", *last)
		}
	})
	t.Run("a read error sends nothing", func(t *testing.T) {
		n := &fakeNotifier{}
		s, last := testService(nil, shared.NewError(shared.ErrInternal, "x"), n)
		s.check(t.Context())
		if len(n.sent) != 0 || *last != "" {
			t.Fatalf("sent = %+v, last = %q", n.sent, *last)
		}
	})
}

func TestBodyCapsTheList(t *testing.T) {
	var dues []finance.Due
	for _, date := range []string{"2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-10"} {
		dues = append(dues, finance.Due{Label: "X", DueDate: date, Amount: amount(t, "1234567")})
	}
	got := body(dues, "2026-09-07")
	want := "X: $1.234.567, vence hoy\nX: $1.234.567, vence mañana\nX: $1.234.567, vence el 9/9\ny 2 más"
	if got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if got := title(dues); got != "5 pagos por vencer" {
		t.Fatalf("title = %q", got)
	}
	if got := title(dues[:1]); got != "1 pago por vencer" {
		t.Fatalf("title = %q", got)
	}
}

func TestPesos(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"0", "$0"}, {"999", "$999"}, {"1000", "$1.000"}, {"123456.6", "$123.457"}, {"-5000", "-$5.000"},
	} {
		if got := pesos(amount(t, tc.in)); got != tc.want {
			t.Errorf("pesos(%s) = %s, want %s", tc.in, got, tc.want)
		}
	}
}
