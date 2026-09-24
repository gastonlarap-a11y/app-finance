package mailsync

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-imap/v2/imapserver/imapmemserver"
	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/sqlitedialect"
	"github.com/uptrace/bun/driver/sqliteshim"

	"github.com/gastonlarap-a11y/app-finance/backend/finance"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/db"
	"github.com/gastonlarap-a11y/app-finance/backend/users"
)

// ---------- fixtures ----------

func openTestDB(t *testing.T) *bun.DB {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db") + "?_journal=WAL&_foreign_keys=on"
	sqldb, err := sql.Open(sqliteshim.ShimName, dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	sqldb.SetMaxOpenConns(1)
	bdb := bun.NewDB(sqldb, sqlitedialect.New())
	if err := db.RunMigrations(t.Context(), bdb); err != nil {
		t.Fatalf("migrations: %v", err)
	}
	t.Cleanup(func() { bdb.Close() })
	return bdb
}

// memSecrets is an in-memory SecretStore.
type memSecrets struct {
	mu sync.Mutex
	m  map[string]string
}

func (s *memSecrets) Set(k, v string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[k] = v
	return nil
}

func (s *memSecrets) Get(k string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.m[k]
	if !ok {
		return "", ErrSecretNotFound
	}
	return v, nil
}

func (s *memSecrets) Delete(k string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, k)
	return nil
}

// alertParser reads the synthetic alert format used by these tests (the real
// bank formats get their own parsers, tested against their own samples).
type alertParser struct{}

var (
	reAmount   = regexp.MustCompile(`Monto: \$([\d.]+)`)
	reMerchant = regexp.MustCompile(`Comercio: (.+)`)
)

func (alertParser) Issuer() string { return "banco" }

func (alertParser) Matches(msg Message) bool {
	return strings.HasSuffix(msg.From, "@banco.test") && strings.Contains(msg.Subject, "Compra")
}

func (alertParser) Parse(msg Message) ([]finance.ImportCandidate, error) {
	amount, merchant := reAmount.FindStringSubmatch(msg.Text), reMerchant.FindStringSubmatch(msg.Text)
	if amount == nil || merchant == nil {
		return nil, errors.New("formato inesperado")
	}
	return []finance.ImportCandidate{{
		Date:        msg.Date.Format(dateLayout),
		Description: merchant[1],
		Amount:      strings.ReplaceAll(amount[1], ".", ""),
	}}, nil
}

// pipeListener hands the server the far end of in-process pipes: no ports.
type pipeListener struct {
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

func (l *pipeListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *pipeListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (l *pipeListener) Addr() net.Addr { return &net.UnixAddr{Name: "pipe", Net: "pipe"} }

type harness struct {
	svc    *Service
	user   *imapmemserver.User
	events []SyncEvent
}

const (
	testUser     = "yo@correo.test"
	testPassword = "app-password"
)

func newHarness(t *testing.T) *harness {
	t.Helper()
	mem := imapmemserver.New()
	user := imapmemserver.NewUser(testUser, testPassword)
	if err := user.Create("INBOX", nil); err != nil {
		t.Fatalf("create INBOX: %v", err)
	}
	mem.AddUser(user)
	srv := imapserver.New(&imapserver.Options{
		NewSession: func(*imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return mem.NewSession(), nil, nil
		},
		Caps:         imap.CapSet{imap.CapIMAP4rev1: {}},
		InsecureAuth: true, // plain pipe, test only
	})
	ln := &pipeListener{conns: make(chan net.Conn), done: make(chan struct{})}
	served := make(chan struct{})
	go func() {
		defer close(served)
		_ = srv.Serve(ln) // returns net.ErrClosed once the listener closes
	}()
	t.Cleanup(func() {
		_ = ln.Close() // never fails
		<-served
	})

	h := &harness{user: user}
	h.svc = NewService(openTestDB(t), users.NewSession(), &memSecrets{m: map[string]string{}},
		[]EmailParser{alertParser{}}, func(_ string, data any) {
			if ev, ok := data.(SyncEvent); ok {
				h.events = append(h.events, ev)
			}
		})
	h.svc.dial = func(ctx context.Context, _ string) (*imapclient.Client, error) {
		client, server := net.Pipe()
		select {
		case ln.conns <- server:
			return imapclient.New(client, nil), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return h
}

var msgSeq int

// deliver appends an email to INBOX with the given internal date.
func (h *harness) deliver(t *testing.T, from, subject, body string, at time.Time) {
	t.Helper()
	msgSeq++
	raw := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <m%d@test>\r\n"+
		"Content-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n",
		from, testUser, subject, at.Format(time.RFC1123Z), msgSeq, body)
	if _, err := h.user.Append("INBOX", bytes.NewReader([]byte(raw)), &imap.AppendOptions{Time: at}); err != nil {
		t.Fatalf("append: %v", err)
	}
}

func (h *harness) configure(t *testing.T, startDate string) *MailAccount {
	t.Helper()
	r := h.svc.SaveMailAccount(t.Context(), MailAccountInput{
		Host: "imap.test", Username: testUser, Password: testPassword,
		SenderFilter: "banco.test", StartDate: startDate, AutoSync: true,
	})
	if r.Error != nil {
		t.Fatalf("SaveMailAccount: %v", r.Error)
	}
	return h.account(t)
}

func (h *harness) account(t *testing.T) *MailAccount {
	t.Helper()
	acc, err := h.svc.accountOf(t.Context(), h.svc.session.Active())
	if err != nil || acc == nil {
		t.Fatalf("accountOf = %v, %v", acc, err)
	}
	return acc
}

func (h *harness) sync(t *testing.T) SyncSummary {
	t.Helper()
	if err := h.svc.runSync(t.Context(), h.account(t).ID); err != nil {
		t.Fatalf("runSync: %v", err)
	}
	return *h.events[len(h.events)-1].Summary
}

func (h *harness) pending(t *testing.T) []finance.ImportItemView {
	t.Helper()
	r := finance.NewFinanceService(h.svc.db, h.svc.session).ListImportItems(t.Context(), finance.ImportPendiente)
	if r.Error != nil {
		t.Fatalf("ListImportItems: %v", r.Error)
	}
	return r.Data
}

var day = func(s string) time.Time {
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		panic(err) // test literal
	}
	return t.Add(12 * time.Hour)
}

// ---------- tests ----------

func TestSyncIsIncrementalAndReadOnly(t *testing.T) {
	h := newHarness(t)
	h.deliver(t, "alertas@banco.test", "Compra con tarjeta", "Monto: $16.182\nComercio: CRUZ VERDE", day("2026-07-17"))
	h.deliver(t, "amigo@otro.test", "Compra de pan", "Monto: $1.000\nComercio: PANADERIA", day("2026-07-18"))
	h.deliver(t, "alertas@banco.test", "Compra con tarjeta", "Monto: $5.990\nComercio: ENTEL", day("2026-07-19"))
	h.deliver(t, "alertas@banco.test", "Compra antigua", "Monto: $9\nComercio: VIEJA", day("2026-01-01"))
	h.configure(t, "2026-07-01")

	first := h.sync(t)
	if first != (SyncSummary{Messages: 2, Recognized: 2, Added: 2}) {
		t.Fatalf("first sync = %+v, want only the 2 bank emails since the start date", first)
	}
	acc := h.account(t)
	if acc.LastUID != 4 || acc.UIDValidity == 0 || acc.LastSyncedAt == nil || acc.LastAdded != 2 {
		t.Fatalf("watermark after first sync = %+v, want last_uid 4 (UIDNEXT-1)", acc)
	}
	items := h.pending(t)
	if len(items) != 2 || items[0].Source != finance.ImportSourceEmail || items[0].Description != "ENTEL" || items[0].Amount.String() != "5990" {
		t.Fatalf("pending = %+v", items)
	}

	if again := h.sync(t); again != (SyncSummary{}) {
		t.Fatalf("second sync without new mail = %+v, want nothing fetched", again)
	}

	h.deliver(t, "alertas@banco.test", "Compra con tarjeta", "Monto: $2.000\nComercio: NOTARIO", day("2026-07-24"))
	if next := h.sync(t); next != (SyncSummary{Messages: 1, Recognized: 1, Added: 1}) {
		t.Fatalf("sync after a new alert = %+v, want just that one", next)
	}

	// Fetching used BODY.PEEK[]: nothing was marked as read.
	c, err := h.svc.dial(t.Context(), "")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	if err := c.Login(testUser, testPassword).Wait(); err != nil {
		t.Fatalf("login: %v", err)
	}
	if _, err := c.Select("INBOX", nil).Wait(); err != nil {
		t.Fatalf("select: %v", err)
	}
	seen, err := c.UIDSearch(&imap.SearchCriteria{Flag: []imap.Flag{imap.FlagSeen}}, nil).Wait()
	if err != nil {
		t.Fatalf("search seen: %v", err)
	}
	if n := len(seen.AllUIDs()); n != 0 {
		t.Fatalf("%d messages marked \\Seen by the sync, want 0", n)
	}
}

func TestSyncReportsUnrecognizedAndUnreadableAndMovesOn(t *testing.T) {
	h := newHarness(t)
	h.deliver(t, "alertas@banco.test", "Estado de cuenta disponible", "Su estado de cuenta está listo", day("2026-07-10"))
	h.deliver(t, "alertas@banco.test", "Compra con tarjeta", "Formato nuevo sin monto", day("2026-07-11"))
	h.deliver(t, "alertas@banco.test", "Compra con tarjeta", "Monto: $0\nComercio: GRATIS", day("2026-07-12")) // inbox rejects 0
	h.configure(t, "2026-07-01")

	got := h.sync(t)
	if got != (SyncSummary{Messages: 3, Unrecognized: 1, Unreadable: 2}) {
		t.Fatalf("sync = %+v, want 1 unrecognized + 2 unreadable", got)
	}
	if acc := h.account(t); acc.LastUID != 3 {
		t.Fatalf("last_uid = %d, want 3: unreadable emails must not block later ones", acc.LastUID)
	}
}

func TestSyncFallsBackToDateWhenUIDsReset(t *testing.T) {
	h := newHarness(t)
	h.deliver(t, "alertas@banco.test", "Compra con tarjeta", "Monto: $16.182\nComercio: CRUZ VERDE", day("2026-07-17"))
	h.deliver(t, "alertas@banco.test", "Compra con tarjeta", "Monto: $5.990\nComercio: ENTEL", time.Now())
	h.configure(t, "2026-07-01")
	if first := h.sync(t); first.Added != 2 {
		t.Fatalf("first sync = %+v, want 2 added", first)
	}

	// The server reset its UIDs: the watermark no longer applies, so the sync
	// searches by date from the day before the last sync — the July email is
	// not read again, today's is, and the inbox absorbs it as a duplicate.
	if _, err := h.svc.db.NewUpdate().Model((*MailAccount)(nil)).Set("uid_validity = 999").Where("id > 0").Exec(t.Context()); err != nil {
		t.Fatalf("simulate reset: %v", err)
	}
	if got := h.sync(t); got != (SyncSummary{Messages: 1, Recognized: 1, Duplicates: 1}) {
		t.Fatalf("sync after UIDVALIDITY change = %+v, want only today's email, as a duplicate", got)
	}
	if n := len(h.pending(t)); n != 2 {
		t.Fatalf("pending = %d, want 2", n)
	}
}

func TestSyncWithWrongPasswordRecordsTheError(t *testing.T) {
	h := newHarness(t)
	h.configure(t, "2026-07-01")
	if r := h.svc.SaveMailAccount(t.Context(), MailAccountInput{
		Host: "imap.test", Username: testUser, Password: "otra", SenderFilter: "banco.test", StartDate: "2026-07-01",
	}); r.Error != nil {
		t.Fatalf("SaveMailAccount: %v", r.Error)
	}
	if err := h.svc.runSync(t.Context(), h.account(t).ID); err == nil {
		t.Fatal("runSync with a wrong password = nil error")
	}
	if ev := h.events[len(h.events)-1]; ev.Error == "" || ev.UserID != 1 {
		t.Fatalf("event = %+v, want the login error for user 1", ev)
	}
	if acc := h.account(t); !strings.Contains(acc.LastError, "contraseña") || acc.LastSyncedAt != nil {
		t.Fatalf("account after failed sync = %+v", acc)
	}
	if acc := h.account(t); strings.HasPrefix(acc.LastError, "VALIDATION_ERROR") || strings.HasPrefix(h.events[len(h.events)-1].Error, "VALIDATION_ERROR") {
		t.Fatalf("the user-facing error leaks the internal code: %q", acc.LastError)
	}
	if r := h.svc.TestMailConnection(t.Context()); r.Error == nil {
		t.Fatal("TestMailConnection with a wrong password = ok")
	}
}

func TestGmailAppPasswordSpacesAreDropped(t *testing.T) {
	tests := []struct {
		host, password, want string
	}{
		{"imap.gmail.com", "abcd efgh ijkl mnop", "abcdefghijklmnop"},
		{"IMAP.GMAIL.COM", " abcd efgh ijkl mnop ", "abcdefghijklmnop"},
		{"imap.otro.cl", "clave con espacios", "clave con espacios"}, // other servers keep it verbatim
	}
	for _, tt := range tests {
		t.Run(tt.host, func(t *testing.T) {
			in, aerr := validateInput(MailAccountInput{
				Host: tt.host, Username: "u", Password: tt.password, SenderFilter: "itau.cl", StartDate: "2026-07-01",
			})
			if aerr != nil || in.Password != tt.want {
				t.Fatalf("password = %q (err %v), want %q", in.Password, aerr, tt.want)
			}
		})
	}
}

func TestLoginErrorExplainsGmailAppPasswords(t *testing.T) {
	tests := []struct {
		name, server, want string
	}{
		{
			"gmail with the account password",
			"imap: NO [ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)",
			"contraseña de aplicación",
		},
		{"wrong password elsewhere", "imap: NO [AUTHENTICATIONFAILED] Invalid credentials", "rechazó el usuario o la contraseña"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ae := loginError(errors.New(tt.server))
			if ae.Code != "VALIDATION_ERROR" || !strings.Contains(ae.Message, tt.want) {
				t.Fatalf("loginError = %+v, want a validation error mentioning %q", ae, tt.want)
			}
			if got := errorText(ae); got != ae.Message {
				t.Fatalf("errorText = %q, want only the message", got)
			}
		})
	}
	if got := errorText(errors.New("dial tcp: timeout")); got != "dial tcp: timeout" {
		t.Fatalf("errorText(system error) = %q", got)
	}
}

func TestMailAccountSettings(t *testing.T) {
	ctx := t.Context()
	h := newHarness(t)
	secrets, ok := h.svc.secrets.(*memSecrets)
	if !ok {
		t.Fatal("harness secrets are not memSecrets")
	}

	invalid := []struct {
		name string
		in   MailAccountInput
		want string
	}{
		{"sin servidor", MailAccountInput{Username: "u", Password: "p", SenderFilter: "x", StartDate: "2026-07-01"}, "servidor"},
		{"sin remitente", MailAccountInput{Host: "h", Username: "u", Password: "p", StartDate: "2026-07-01"}, "remitente"},
		{"fecha", MailAccountInput{Host: "h", Username: "u", Password: "p", SenderFilter: "x", StartDate: "01/07/2026"}, "fecha"},
		{"puerto", MailAccountInput{Host: "h", Port: 70000, Username: "u", Password: "p", SenderFilter: "x", StartDate: "2026-07-01"}, "puerto"},
		{"sin contraseña", MailAccountInput{Host: "h", Username: "u", SenderFilter: "x", StartDate: "2026-07-01"}, "contraseña"},
	}
	for _, tt := range invalid {
		t.Run(tt.name, func(t *testing.T) {
			r := h.svc.SaveMailAccount(ctx, tt.in)
			if r.Error == nil || !strings.Contains(r.Error.Message, tt.want) {
				t.Fatalf("SaveMailAccount = %+v, want error about %q", r.Error, tt.want)
			}
		})
	}

	acc := h.configure(t, "2026-07-01")
	if acc.Port != defaultPort || acc.Folder != defaultFolder {
		t.Fatalf("defaults = %d / %q", acc.Port, acc.Folder)
	}
	if pw, _ := secrets.Get(acc.secretKey()); pw != testPassword {
		t.Fatalf("keychain password = %q", pw)
	}
	var stored string
	if err := h.svc.db.NewRaw("SELECT group_concat(host || username || folder) FROM mail_accounts").Scan(ctx, &stored); err != nil || strings.Contains(stored, testPassword) {
		t.Fatalf("the password leaked into the database (%q, %v)", stored, err)
	}

	// Saving without a password keeps the stored one and the watermark.
	h.deliver(t, "alertas@banco.test", "Compra con tarjeta", "Monto: $1\nComercio: X", day("2026-07-02"))
	h.sync(t)
	if r := h.svc.SaveMailAccount(ctx, MailAccountInput{
		Host: "imap.test", Username: testUser, SenderFilter: "banco.test", StartDate: "2026-07-01", AutoSync: false,
	}); r.Error != nil {
		t.Fatalf("SaveMailAccount without password: %v", r.Error)
	}
	if acc := h.account(t); acc.LastUID != 1 || acc.AutoSync {
		t.Fatalf("after re-save = %+v, want watermark kept and auto-sync off", acc)
	}
	if pw, _ := secrets.Get(acc.secretKey()); pw != testPassword {
		t.Fatal("re-saving without a password dropped it")
	}

	st := h.svc.GetMailState(ctx)
	if st.Error != nil || !st.Data.Configured || st.Data.LastRecognized != 1 || len(st.Data.Issuers) != 1 {
		t.Fatalf("GetMailState = %+v", st.Data)
	}

	if r := h.svc.ResyncMailFrom(ctx, "2026-06-01"); r.Error != nil {
		t.Fatalf("ResyncMailFrom: %v", r.Error)
	}
	if acc := h.account(t); acc.LastUID != 0 || acc.StartDate != "2026-06-01" || acc.LastSyncedAt != nil {
		t.Fatalf("after ResyncMailFrom = %+v", acc)
	}

	if r := h.svc.DisconnectMail(ctx); r.Error != nil {
		t.Fatalf("DisconnectMail: %v", r.Error)
	}
	if _, err := secrets.Get(acc.secretKey()); !errors.Is(err, ErrSecretNotFound) {
		t.Fatal("DisconnectMail left the password in the keychain")
	}
	if st := h.svc.GetMailState(ctx); st.Data.Configured {
		t.Fatal("still configured after DisconnectMail")
	}
	if r := h.svc.SyncNow(ctx); r.Error == nil || r.Error.Code != "NOT_FOUND" {
		t.Fatalf("SyncNow without account = %+v, want NOT_FOUND", r.Error)
	}
}

func TestMailAccountIsPerProfile(t *testing.T) {
	ctx := t.Context()
	h := newHarness(t)
	h.configure(t, "2026-07-01")
	usr := users.NewService(h.svc.db, h.svc.session, "test-app-finance-mailsync")
	if r := usr.CreateUser(ctx, "Camila"); r.Error != nil { // switches to her
		t.Fatalf("CreateUser: %v", r.Error)
	}
	if st := h.svc.GetMailState(ctx); st.Error != nil || st.Data.Configured {
		t.Fatalf("Camila sees Gastón's mailbox: %+v", st.Data)
	}
	for name, r := range map[string]OpResult{
		"TestMailConnection": h.svc.TestMailConnection(ctx),
		"SyncNow":            h.svc.SyncNow(ctx),
		"ResyncMailFrom":     h.svc.ResyncMailFrom(ctx, "2026-01-01"),
		"DisconnectMail":     h.svc.DisconnectMail(ctx),
	} {
		if r.Error == nil || r.Error.Code != "NOT_FOUND" {
			t.Errorf("Camila %s = %+v, want NOT_FOUND", name, r.Error)
		}
	}
	if r := usr.SwitchUser(ctx, 1); r.Error != nil {
		t.Fatalf("SwitchUser: %v", r.Error)
	}
	if st := h.svc.GetMailState(ctx); !st.Data.Configured || st.Data.StartDate != "2026-07-01" {
		t.Fatalf("Gastón's mailbox changed: %+v", st.Data)
	}
}
