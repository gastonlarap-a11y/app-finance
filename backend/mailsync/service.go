// Package mailsync reads the bank's purchase-alert emails from the profile's
// mailbox over IMAP (desktop only: a browser cannot open IMAP connections) and
// stages the movements its parsers extract in the finance import inbox.
//
// Syncs are incremental: the server is asked only for the bank's emails above
// the stored UID watermark, and each chunk's movements and watermark commit in
// one transaction. They run on a single background worker — on demand
// (SyncNow), at startup and every autoSyncEvery while the app is open — and
// report through EventSyncDone.
package mailsync

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/uptrace/bun"
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/background"
	"github.com/gastonlarap-a11y/app-finance/backend/users"
)

// EventSyncDone is emitted to the frontend after every sync (SyncEvent payload).
const EventSyncDone = "mailsync:done"

const (
	autoSyncEvery = 15 * time.Minute
	// firstAutoSync lets the window open before the first network round-trip.
	firstAutoSync  = 10 * time.Second
	connectTimeout = 30 * time.Second
	defaultPort    = 993
	defaultFolder  = "INBOX"
)

type Service struct {
	db      *bun.DB
	session *users.Session
	secrets SecretStore
	parsers []EmailParser
	dial    Dialer
	emit    func(name string, data any)

	worker   *background.Worker
	stopLoop context.CancelFunc
	loopDone chan struct{}
	inFlight sync.Map // account id → struct{}: a sync is queued or running
}

// NewService wires the mailbox sync. emit forwards events to the frontend
// (main.go passes the Wails event manager; tests pass a recorder).
func NewService(db *bun.DB, session *users.Session, secrets SecretStore, parsers []EmailParser, emit func(name string, data any)) *Service {
	return &Service{db: db, session: session, secrets: secrets, parsers: parsers, dial: dialTLS, emit: emit}
}

func (s *Service) ServiceName() string { return "MailSyncService" }

// ServiceStartup starts the sync worker and the auto-sync loop; both stop in
// ServiceShutdown.
func (s *Service) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	s.worker = background.New(16)
	s.worker.Start(ctx, 1) // one at a time: syncs of the same mailbox never overlap
	loopCtx, cancel := context.WithCancel(ctx)
	s.stopLoop = cancel
	s.loopDone = make(chan struct{})
	go func() {
		defer close(s.loopDone)
		s.autoSyncLoop(loopCtx)
	}()
	return nil
}

func (s *Service) ServiceShutdown() error {
	if s.stopLoop != nil {
		s.stopLoop()
		<-s.loopDone
	}
	if s.worker != nil {
		s.worker.Stop()
	}
	return nil
}

func (s *Service) autoSyncLoop(ctx context.Context) {
	timer := time.NewTimer(firstAutoSync)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			s.enqueueAutoSyncs(ctx)
			timer.Reset(autoSyncEvery)
		}
	}
}

// enqueueAutoSyncs queues every profile's mailbox with auto-sync on; each sync
// runs with its own account's user id, whatever profile is active.
func (s *Service) enqueueAutoSyncs(ctx context.Context) {
	var accounts []MailAccount
	if err := s.db.NewSelect().Model(&accounts).Where("auto_sync = ?", true).Scan(ctx); err != nil {
		slog.Error("mailsync: listing accounts", "err", err)
		return
	}
	for _, acc := range accounts {
		if err := s.enqueue(acc.ID); err != nil && !errors.Is(err, errBusy) {
			slog.Error("mailsync: queueing auto-sync", "account", acc.ID, "err", err)
		}
	}
}

var errBusy = errors.New("sync already queued or running")

func (s *Service) enqueue(accountID int64) error {
	if s.worker == nil {
		return errors.New("mail sync worker not started")
	}
	if _, busy := s.inFlight.LoadOrStore(accountID, struct{}{}); busy {
		return errBusy
	}
	err := s.worker.Enqueue(func(ctx context.Context) error {
		defer s.inFlight.Delete(accountID)
		return s.runSync(ctx, accountID)
	})
	if err != nil {
		s.inFlight.Delete(accountID)
		return fmt.Errorf("queueing mail sync: %w", err)
	}
	return nil
}

// runSync syncs one account (re-read, so the watermark is fresh), records the
// outcome on it and tells the frontend.
func (s *Service) runSync(ctx context.Context, accountID int64) error {
	acc := new(MailAccount)
	if err := s.db.NewSelect().Model(acc).Where("id = ?", accountID).Scan(ctx); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil // disconnected while queued
		}
		return fmt.Errorf("loading mail account: %w", err)
	}
	sum, syncErr := s.syncAccount(ctx, acc)
	if err := s.recordOutcome(ctx, acc.ID, sum, syncErr); err != nil {
		return err
	}
	ev := SyncEvent{UserID: acc.UserID, Summary: &sum}
	if syncErr != nil {
		ev.Error = errorText(syncErr)
	}
	if s.emit != nil {
		s.emit(EventSyncDone, ev)
	}
	return syncErr
}

func (s *Service) recordOutcome(ctx context.Context, accountID int64, sum SyncSummary, syncErr error) error {
	q := s.db.NewUpdate().Model((*MailAccount)(nil)).Where("id = ?", accountID)
	if syncErr != nil {
		q = q.Set("last_error = ?", errorText(syncErr))
	} else {
		q = q.Set("last_error = ''").Set("last_synced_at = ?", time.Now()).
			Set("last_messages = ?", sum.Messages).Set("last_recognized = ?", sum.Recognized).Set("last_added = ?", sum.Added)
	}
	if _, err := q.Exec(ctx); err != nil {
		return fmt.Errorf("recording sync outcome: %w", err)
	}
	return nil
}

// ---------- bound methods (all scoped to the active profile) ----------

// accountOf returns uid's mailbox, or nil when none is configured.
func (s *Service) accountOf(ctx context.Context, uid int64) (*MailAccount, error) {
	acc := new(MailAccount)
	err := s.db.NewSelect().Model(acc).Where("user_id = ?", uid).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("loading mail account: %w", err)
	}
	return acc, nil
}

func notConfigured() *shared.AppError {
	return shared.NewError(shared.ErrNotFound, "no hay un correo configurado para este perfil")
}

func (s *Service) GetMailState(ctx context.Context) MailStateResult {
	acc, err := s.accountOf(ctx, s.session.Active())
	if err != nil {
		return MailStateResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	st := &MailState{Issuers: make([]string, 0, len(s.parsers))}
	for _, p := range s.parsers {
		st.Issuers = append(st.Issuers, p.Issuer())
	}
	if acc == nil {
		return MailStateResult{Data: st}
	}
	_, syncing := s.inFlight.Load(acc.ID)
	st.Configured, st.Host, st.Port, st.Username = true, acc.Host, acc.Port, acc.Username
	st.Folder, st.SenderFilter, st.StartDate, st.AutoSync = acc.Folder, acc.SenderFilter, acc.StartDate, acc.AutoSync
	st.Syncing, st.LastSyncedAt, st.LastError = syncing, acc.LastSyncedAt, acc.LastError
	st.LastMessages, st.LastRecognized, st.LastAdded = acc.LastMessages, acc.LastRecognized, acc.LastAdded
	return MailStateResult{Data: st}
}

func validateInput(in MailAccountInput) (MailAccountInput, *shared.AppError) {
	in.Host = strings.TrimSpace(in.Host)
	in.Username = strings.TrimSpace(in.Username)
	in.Folder = strings.TrimSpace(in.Folder)
	in.SenderFilter = strings.TrimSpace(in.SenderFilter)
	in.StartDate = strings.TrimSpace(in.StartDate)
	switch {
	case in.Host == "":
		return in, shared.NewError(shared.ErrValidation, "el servidor IMAP es obligatorio")
	case in.Username == "":
		return in, shared.NewError(shared.ErrValidation, "el usuario es obligatorio")
	case in.SenderFilter == "":
		return in, shared.NewError(shared.ErrValidation, "indica el remitente del banco (p. ej. itau.cl) para no revisar todo el correo")
	}
	if in.Port == 0 {
		in.Port = defaultPort
	}
	if in.Port < 1 || in.Port > 65535 {
		return in, shared.NewError(shared.ErrValidation, "puerto inválido: "+strconv.Itoa(in.Port))
	}
	if in.Folder == "" {
		in.Folder = defaultFolder
	}
	// Google shows app passwords as four groups ("abcd efgh ijkl mnop"); they
	// never contain spaces, so a pasted one is accepted either way.
	if strings.Contains(strings.ToLower(in.Host), "gmail") {
		in.Password = strings.Join(strings.Fields(in.Password), "")
	}
	if _, err := time.Parse(dateLayout, in.StartDate); err != nil {
		return in, shared.NewError(shared.ErrValidation, "fecha de inicio inválida (use YYYY-MM-DD)")
	}
	return in, nil
}

// SaveMailAccount creates or updates the active profile's mailbox. The
// password goes to the OS keychain; changing where mail is read from (server,
// user, folder, sender) restarts the incremental sync from the start date.
func (s *Service) SaveMailAccount(ctx context.Context, in MailAccountInput) OpResult {
	in, aerr := validateInput(in)
	if aerr != nil {
		return OpResult{Error: aerr}
	}
	uid := s.session.Active()
	acc, err := s.accountOf(ctx, uid)
	if err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if acc == nil && in.Password == "" {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "la contraseña de aplicación es obligatoria")}
	}
	if acc == nil {
		acc = &MailAccount{UserID: uid}
	}
	moved := acc.Host != in.Host || acc.Username != in.Username || acc.Folder != in.Folder ||
		acc.SenderFilter != in.SenderFilter || acc.StartDate != in.StartDate
	acc.Host, acc.Port, acc.Username, acc.Folder = in.Host, in.Port, in.Username, in.Folder
	acc.SenderFilter, acc.StartDate, acc.AutoSync = in.SenderFilter, in.StartDate, in.AutoSync
	if moved {
		acc.UIDValidity, acc.LastUID, acc.LastSyncedAt = 0, 0, nil
	}

	err = s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if acc.ID == 0 {
			_, err := tx.NewInsert().Model(acc).Returning("*").Exec(ctx)
			if err != nil {
				return fmt.Errorf("creating mail account: %w", err)
			}
		} else if _, err := tx.NewUpdate().Model(acc).WherePK().Where("user_id = ?", uid).Exec(ctx); err != nil {
			return fmt.Errorf("updating mail account: %w", err)
		}
		// The keychain write goes last: if it fails the row rolls back too.
		if in.Password != "" {
			return s.secrets.Set(acc.secretKey(), in.Password)
		}
		return nil
	})
	if err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return OpResult{}
}

// TestMailConnection logs in and opens the folder, without fetching mail.
func (s *Service) TestMailConnection(ctx context.Context) OpResult {
	acc, err := s.accountOf(ctx, s.session.Active())
	if err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if acc == nil {
		return OpResult{Error: notConfigured()}
	}
	ctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	sess, err := s.open(ctx, acc)
	if err != nil {
		if ae, ok := errors.AsType[*shared.AppError](err); ok {
			return OpResult{Error: ae}
		}
		return OpResult{Error: shared.NewError(shared.ErrValidation, "no se pudo conectar: "+err.Error())}
	}
	// Logout is best-effort: the connection test already succeeded.
	_ = sess.client.Logout().Wait()
	_ = sess.client.Close()
	return OpResult{}
}

// SyncNow queues a sync of the active profile's mailbox and returns at once;
// the outcome arrives as EventSyncDone.
func (s *Service) SyncNow(ctx context.Context) OpResult {
	acc, err := s.accountOf(ctx, s.session.Active())
	if err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if acc == nil {
		return OpResult{Error: notConfigured()}
	}
	if err := s.enqueue(acc.ID); errors.Is(err, errBusy) {
		return OpResult{Error: shared.NewError(shared.ErrConflict, "ya hay una revisión del correo en curso")}
	} else if err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return OpResult{}
}

// ResyncMailFrom forgets the watermark so the next sync reads the bank's
// emails again from `since` (e.g. after support for a new format was added).
// Movements already in the inbox are not duplicated.
func (s *Service) ResyncMailFrom(ctx context.Context, since string) OpResult {
	if _, err := time.Parse(dateLayout, since); err != nil {
		return OpResult{Error: shared.NewError(shared.ErrValidation, "fecha inválida (use YYYY-MM-DD)")}
	}
	res, err := s.db.NewUpdate().Model((*MailAccount)(nil)).
		Set("start_date = ?", since).Set("uid_validity = 0").Set("last_uid = 0").Set("last_synced_at = NULL").
		Where("user_id = ?", s.session.Active()).Exec(ctx)
	if err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		return OpResult{Error: notConfigured()}
	}
	return OpResult{}
}

// DisconnectMail removes the active profile's mailbox and its keychain entry.
// Movements already imported stay in the inbox.
func (s *Service) DisconnectMail(ctx context.Context) OpResult {
	acc, err := s.accountOf(ctx, s.session.Active())
	if err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if acc == nil {
		return OpResult{Error: notConfigured()}
	}
	if err := s.secrets.Delete(acc.secretKey()); err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if _, err := s.db.NewDelete().Model(acc).WherePK().Exec(ctx); err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return OpResult{}
}
