// Package reminders sends a native notification (desktop only) when a card or
// a fixed expense of the active profile falls due soon, or fell due, and is
// still unpaid (finance.UpcomingDues). At most one a day: the check runs
// shortly after the app opens and every hour while it stays open.
//
// The notifier is Wails' notifications service, started here rather than
// registered with the app: its startup fails where notifications cannot work
// (macOS without a bundle identifier, as in `wails3 dev`), and a missing
// reminder must never keep the app from opening. The web/iPad build shows the
// same dues in the app only — a push to a closed PWA needs a paid push server.
package reminders

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"

	"github.com/gastonlarap-a11y/app-finance/backend/finance"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/prefs"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

const (
	// firstCheck lets the window open (and the UF sync run) first.
	firstCheck = 20 * time.Second
	checkEvery = time.Hour
	// daysAhead is how early a due date is announced.
	daysAhead = 3
	// maxListed caps the lines in the notification body.
	maxListed = 3
	dayLayout = "2006-01-02"
)

// Notifier shows one notification; main wiring uses the native one.
type Notifier interface {
	Notify(id, title, body string) error
}

// errNotAuthorized: the user turned the app's notifications off. Not retried
// until tomorrow.
var errNotAuthorized = errors.New("notificaciones no autorizadas")

type Service struct {
	dues     func(ctx context.Context, today string, days int) finance.DuesResult
	notifier Notifier
	now      func() time.Time
	lastSent func() string
	markSent func(day string)

	stop     context.CancelFunc
	loopDone chan struct{}
}

// NewService reminds of the active profile's dues; the day of the last
// reminder is kept in the installation's prefs.
func NewService(fin *finance.FinanceService, appName string) *Service {
	return &Service{
		dues:     fin.UpcomingDues,
		now:      time.Now,
		lastSent: func() string { return prefs.Load(appName).LastDueReminder },
		markSent: func(day string) { prefs.Update(appName, func(p *prefs.Prefs) { p.LastDueReminder = day }) },
	}
}

func (s *Service) ServiceName() string { return "RemindersService" }

// ServiceStartup starts the native notifier and the check loop. It never
// fails: without notifications the app simply does not remind.
func (s *Service) ServiceStartup(ctx context.Context, opts application.ServiceOptions) error {
	if s.notifier == nil {
		n, err := startNative(ctx, opts)
		if err != nil {
			slog.Warn("recordatorios desactivados: notificaciones no disponibles", "err", err)
			return nil
		}
		s.notifier = n
	}
	loopCtx, cancel := context.WithCancel(ctx)
	s.stop = cancel
	s.loopDone = make(chan struct{})
	go func() {
		defer close(s.loopDone)
		s.loop(loopCtx)
	}()
	return nil
}

func (s *Service) ServiceShutdown() error {
	if s.stop != nil {
		s.stop()
		<-s.loopDone
	}
	if n, ok := s.notifier.(*native); ok {
		return n.ns.ServiceShutdown()
	}
	return nil
}

func (s *Service) loop(ctx context.Context) {
	timer := time.NewTimer(firstCheck)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			s.check(ctx)
			timer.Reset(checkEvery)
		}
	}
}

// check notifies today's dues unless today's reminder already went out. A day
// with nothing due is not marked: a statement imported later that day may
// still bring one.
func (s *Service) check(ctx context.Context) {
	today := s.now().Format(dayLayout)
	if s.lastSent() == today {
		return
	}
	r := s.dues(ctx, today, daysAhead)
	if r.Error != nil {
		slog.Error("recordatorios: leyendo vencimientos", "err", r.Error)
		return
	}
	if len(r.Data) == 0 {
		return
	}
	err := s.notifier.Notify("vencimientos-"+today, title(r.Data), body(r.Data, today))
	switch {
	case errors.Is(err, errNotAuthorized):
		slog.Info("recordatorios: el usuario no autorizó las notificaciones")
	case err != nil:
		slog.Warn("recordatorios: no se pudo notificar", "err", err)
		return // try again at the next check
	}
	s.markSent(today)
}

func title(dues []finance.Due) string {
	for _, d := range dues {
		if d.Overdue {
			return "Tienes pagos vencidos"
		}
	}
	if len(dues) == 1 {
		return "1 pago por vencer"
	}
	return fmt.Sprintf("%d pagos por vencer", len(dues))
}

// body lists the dues, soonest first: "Visa: $60.000, vence mañana".
func body(dues []finance.Due, today string) string {
	lines := make([]string, 0, maxListed+1)
	for i, d := range dues {
		if i == maxListed {
			lines = append(lines, fmt.Sprintf("y %d más", len(dues)-maxListed))
			break
		}
		lines = append(lines, fmt.Sprintf("%s: %s, %s", d.Label, pesos(d.Amount), when(d.DueDate, today)))
	}
	return strings.Join(lines, "\n")
}

// when phrases a due date relative to today.
func when(date, today string) string {
	d, errD := time.Parse(dayLayout, date)
	t, errT := time.Parse(dayLayout, today)
	if errD != nil || errT != nil {
		return "vence el " + date
	}
	short := fmt.Sprintf("%d/%d", d.Day(), int(d.Month()))
	switch days := int(d.Sub(t).Hours() / 24); {
	case days < 0:
		return "venció el " + short
	case days == 0:
		return "vence hoy"
	case days == 1:
		return "vence mañana"
	default:
		return "vence el " + short
	}
}

// pesos formats a whole-peso amount the Chilean way: $1.234.567.
func pesos(amount types.Decimal) string {
	digits := amount.Round(0).Abs().StringFixed(0)
	var b strings.Builder
	if amount.Round(0).IsNegative() {
		b.WriteByte('-')
	}
	b.WriteByte('$')
	for i, c := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteRune(c)
	}
	return b.String()
}

// native is the Wails notifications service.
type native struct {
	ns *notifications.NotificationService
}

func startNative(ctx context.Context, opts application.ServiceOptions) (*native, error) {
	ns := notifications.New()
	if err := ns.ServiceStartup(ctx, opts); err != nil {
		return nil, fmt.Errorf("starting notifications: %w", err)
	}
	return &native{ns: ns}, nil
}

// Notify asks for permission the first time (macOS shows its prompt; Windows
// and Linux always allow) and then shows the notification.
func (n *native) Notify(id, title, body string) error {
	ok, err := n.ns.CheckNotificationAuthorization()
	if err == nil && !ok {
		ok, err = n.ns.RequestNotificationAuthorization()
	}
	if err != nil {
		return fmt.Errorf("notification authorization: %w", err)
	}
	if !ok {
		return errNotAuthorized
	}
	if err := n.ns.SendNotification(notifications.NotificationOptions{ID: id, Title: title, Body: body}); err != nil {
		return fmt.Errorf("sending notification: %w", err)
	}
	return nil
}
