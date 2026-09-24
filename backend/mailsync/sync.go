package mailsync

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"slices"
	"strconv"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/finance"
	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

const (
	dialTimeout = 30 * time.Second
	syncTimeout = 5 * time.Minute
	// fetchChunk bounds how many messages are fetched and committed at once, so
	// an interrupted first sync keeps the progress of the chunks before it.
	fetchChunk = 25
	dateLayout = "2006-01-02"
)

// Dialer opens a (not yet authenticated) IMAP connection to host:port.
type Dialer func(ctx context.Context, address string) (*imapclient.Client, error)

// dialTLS connects with implicit TLS (port 993), honoring ctx while dialing
// and during the handshake.
func dialTLS(ctx context.Context, address string) (*imapclient.Client, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("invalid address %q: %w", address, err)
	}
	conn, err := (&net.Dialer{Timeout: dialTimeout}).DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, fmt.Errorf("connecting to %s: %w", address, err)
	}
	tlsConn := tls.Client(conn, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		_ = conn.Close() // the handshake error is the one worth reporting
		return nil, fmt.Errorf("TLS handshake with %s: %w", address, err)
	}
	return imapclient.New(tlsConn, nil), nil
}

// SyncSummary reports one sync of one mailbox: how many bank emails were
// fetched and what became of them.
type SyncSummary struct {
	Messages     int `json:"messages"`     // emails from the bank's sender
	Recognized   int `json:"recognized"`   // read by a parser
	Unrecognized int `json:"unrecognized"` // no parser for their format
	Unreadable   int `json:"unreadable"`   // a parser matched but could not read them
	Added        int `json:"added"`
	Duplicates   int `json:"duplicates"`
	Reconciled   int `json:"reconciled"`
}

// bodySection fetches the whole message without setting \Seen: syncing must
// never change what the user sees as read in their mail client.
var bodySection = &imap.FetchItemBodySection{Peek: true}

// session is an authenticated connection with the account's folder open read-only.
type session struct {
	client *imapclient.Client
	folder *imap.SelectData
}

func (s *Service) open(ctx context.Context, acc *MailAccount) (*session, error) {
	password, err := s.secrets.Get(acc.secretKey())
	if errors.Is(err, ErrSecretNotFound) {
		return nil, shared.NewError(shared.ErrValidation, "falta la contraseña del correo: vuelve a guardarla en Ajustes")
	}
	if err != nil {
		return nil, err
	}
	c, err := s.dial(ctx, net.JoinHostPort(acc.Host, strconv.Itoa(acc.Port)))
	if err != nil {
		return nil, err
	}
	if err := c.Login(acc.Username, password).Wait(); err != nil {
		_ = c.Close() // the login error is the one worth reporting
		return nil, shared.NewError(shared.ErrValidation, "el servidor rechazó el usuario o la contraseña: "+err.Error())
	}
	folder, err := c.Select(acc.Folder, &imap.SelectOptions{ReadOnly: true}).Wait()
	if err != nil {
		_ = c.Close() // the select error is the one worth reporting
		return nil, shared.NewError(shared.ErrValidation, fmt.Sprintf("no se pudo abrir la carpeta %q: %v", acc.Folder, err))
	}
	return &session{client: c, folder: folder}, nil
}

// searchCriteria asks the server only for the bank's emails that are new: by
// UID above the watermark when it is still valid, otherwise by date (the first
// sync, or after the server reset its UIDs).
func searchCriteria(acc *MailAccount, resumable bool) *imap.SearchCriteria {
	c := &imap.SearchCriteria{}
	if acc.SenderFilter != "" {
		c.Header = []imap.SearchCriteriaHeaderField{{Key: "From", Value: acc.SenderFilter}}
	}
	if resumable {
		var uids imap.UIDSet
		uids.AddRange(imap.UID(acc.LastUID+1), 0) // 0 = "*"
		c.UID = []imap.UIDSet{uids}
	} else {
		c.Since = searchSince(acc)
	}
	return c
}

// searchSince is the start date, or a day before the last sync when there was
// one (dedup absorbs the overlap).
func searchSince(acc *MailAccount) time.Time {
	start, err := time.Parse(dateLayout, acc.StartDate)
	if err != nil {
		start = time.Now().AddDate(0, -1, 0)
	}
	if acc.LastSyncedAt != nil {
		if d := acc.LastSyncedAt.AddDate(0, 0, -1); d.After(start) {
			return d
		}
	}
	return start
}

// syncAccount fetches the bank's new emails, stages what the parsers read and
// advances the watermark chunk by chunk — each chunk's items and watermark
// commit together, so a failure never skips an email nor stages one twice.
func (s *Service) syncAccount(ctx context.Context, acc *MailAccount) (SyncSummary, error) {
	ctx, cancel := context.WithTimeout(ctx, syncTimeout)
	defer cancel()
	sess, err := s.open(ctx, acc)
	if err != nil {
		return SyncSummary{}, err
	}
	defer sess.client.Close()
	// imapclient commands take no context: closing the connection unblocks them.
	stop := context.AfterFunc(ctx, func() { _ = sess.client.Close() }) // Close error is irrelevant once cancelled
	defer stop()

	resumable := acc.UIDValidity == sess.folder.UIDValidity && acc.LastUID > 0
	found, err := sess.client.UIDSearch(searchCriteria(acc, resumable), nil).Wait()
	if err != nil {
		return SyncSummary{}, fmt.Errorf("searching the mailbox: %w", err)
	}
	after := imap.UID(0)
	if resumable {
		after = imap.UID(acc.LastUID)
	}
	uids := newUIDs(found.AllUIDs(), after)

	var sum SyncSummary
	for chunk := range slices.Chunk(uids, fetchChunk) {
		msgs, err := sess.client.Fetch(imap.UIDSetNum(chunk...), &imap.FetchOptions{
			UID:         true,
			BodySection: []*imap.FetchItemBodySection{bodySection},
		}).Collect()
		if err != nil {
			return sum, fmt.Errorf("fetching messages: %w", err)
		}
		batches := s.readMessages(msgs, &sum)
		if err := s.commitChunk(ctx, acc, sess.folder.UIDValidity, chunk[len(chunk)-1], batches, &sum); err != nil {
			return sum, err
		}
	}

	// Everything below UIDNext was covered by the search: the next sync can
	// start there even when no bank email arrived.
	if next := sess.folder.UIDNext; next > 1 {
		if err := advanceWatermark(ctx, s.db, acc.ID, sess.folder.UIDValidity, uint32(next-1)); err != nil {
			return sum, err
		}
	}
	return sum, nil
}

// newUIDs keeps the UIDs above `after`, ascending. "UID n:*" always returns the
// last message even when its UID is below n, so the filter is required.
func newUIDs(all []imap.UID, after imap.UID) []imap.UID {
	out := make([]imap.UID, 0, len(all))
	for _, uid := range all {
		if uid > after {
			out = append(out, uid)
		}
	}
	slices.Sort(out)
	return out
}

// readMessages parses each fetched email into the batch its parser reads.
func (s *Service) readMessages(msgs []*imapclient.FetchMessageBuffer, sum *SyncSummary) []finance.ImportBatch {
	var batches []finance.ImportBatch
	for _, m := range msgs {
		sum.Messages++
		msg, err := parseMessage(m.FindBodySection(bodySection))
		if err != nil {
			sum.Unreadable++
			continue
		}
		p := parserFor(s.parsers, msg)
		if p == nil {
			sum.Unrecognized++
			continue
		}
		items, err := p.Parse(msg)
		if err != nil {
			sum.Unreadable++
			continue
		}
		for i := range items {
			if items[i].Reference == "" {
				items[i].Reference = msg.MessageID
			}
		}
		sum.Recognized++
		batches = append(batches, finance.ImportBatch{Source: finance.ImportSourceEmail, Issuer: p.Issuer(), Items: items})
	}
	return batches
}

// commitChunk stages the chunk's batches and moves the watermark to its last
// UID in one transaction. A batch the inbox rejects (a parser bug) counts as
// unreadable instead of blocking every later email.
func (s *Service) commitChunk(
	ctx context.Context, acc *MailAccount, uidValidity uint32, lastUID imap.UID,
	batches []finance.ImportBatch, sum *SyncSummary,
) error {
	return s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		for _, b := range batches {
			st, err := finance.StageCandidates(ctx, tx, acc.UserID, b)
			if _, invalid := errors.AsType[*shared.AppError](err); invalid {
				sum.Recognized--
				sum.Unreadable++
				continue
			}
			if err != nil {
				return fmt.Errorf("staging email movements: %w", err)
			}
			sum.Added += st.Added
			sum.Duplicates += st.Duplicates
			sum.Reconciled += st.Reconciled
		}
		return advanceWatermark(ctx, tx, acc.ID, uidValidity, uint32(lastUID))
	})
}

// advanceWatermark records that every UID up to lastUID was handled; it never
// moves backwards within the same UIDVALIDITY (the SET expressions read the
// row's previous values).
func advanceWatermark(ctx context.Context, db bun.IDB, accountID int64, uidValidity, lastUID uint32) error {
	_, err := db.NewUpdate().Model((*MailAccount)(nil)).
		Set("last_uid = CASE WHEN uid_validity = ? AND last_uid > ? THEN last_uid ELSE ? END", uidValidity, lastUID, lastUID).
		Set("uid_validity = ?", uidValidity).
		Where("id = ?", accountID).Exec(ctx)
	if err != nil {
		return fmt.Errorf("saving the sync watermark: %w", err)
	}
	return nil
}
