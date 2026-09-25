package mailsync

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2/imapclient"

	"github.com/gastonlarap-a11y/app-finance/backend/users"
)

// A server that accepts the connection and then never answers must not hang
// LOGIN: the deadline closes the connection and open reports a timeout.
func TestOpenGivesUpOnAStalledServer(t *testing.T) {
	h := newHarness(t)
	acc := h.configure(t, "2026-07-01")
	h.svc.dial = func(context.Context, string) (*imapclient.Client, error) {
		client, server := net.Pipe()
		go func() { _, _ = io.Copy(io.Discard, server) }() // reads everything, answers nothing
		t.Cleanup(func() { _ = server.Close() })
		return imapclient.New(client, nil), nil
	}

	ctx, cancel := context.WithTimeout(t.Context(), 300*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := h.svc.open(ctx, acc)
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, errServerTimeout) {
			t.Fatalf("open on a stalled server = %v, want errServerTimeout", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("open hung on a server that never answers")
	}
	if h.svc.authPaused(acc.ID) {
		t.Fatal("a timeout counted as a rejected password")
	}
}

func TestAutoSyncPausesAfterRejectedLogins(t *testing.T) {
	h := newHarness(t)
	h.configure(t, "2026-07-01")
	if r := h.svc.SaveMailAccount(t.Context(), MailAccountInput{
		Host: "imap.test", Username: testUser, Password: "otra", SenderFilter: "banco.test", StartDate: "2026-07-01", AutoSync: true,
	}); r.Error != nil {
		t.Fatalf("SaveMailAccount: %v", r.Error)
	}
	acc := h.account(t)
	for i := range maxAuthFailures {
		if h.svc.authPaused(acc.ID) {
			t.Fatalf("paused after %d failures, want %d", i, maxAuthFailures)
		}
		if _, err := h.svc.open(t.Context(), acc); err == nil {
			t.Fatal("open with a wrong password succeeded")
		}
	}
	if !h.svc.authPaused(acc.ID) {
		t.Fatalf("not paused after %d rejected logins", maxAuthFailures)
	}

	// New credentials lift the pause.
	if r := h.svc.SaveMailAccount(t.Context(), MailAccountInput{
		Host: "imap.test", Username: testUser, Password: testPassword, SenderFilter: "banco.test", StartDate: "2026-07-01", AutoSync: true,
	}); r.Error != nil {
		t.Fatalf("SaveMailAccount: %v", r.Error)
	}
	if h.svc.authPaused(acc.ID) {
		t.Fatal("still paused after saving new credentials")
	}
}

func TestAutoSyncSkipsProfilesInTheTrash(t *testing.T) {
	h := newHarness(t)
	acc := h.configure(t, "2026-07-01") // user 1's mailbox
	if ids, err := h.svc.autoSyncAccounts(t.Context()); err != nil || len(ids) != 1 || ids[0] != acc.ID {
		t.Fatalf("autoSyncAccounts = %v, %v; want the live profile's mailbox", ids, err)
	}
	usr := users.NewService(h.svc.db, h.svc.session, "test-app-finance-mailsync")
	other := usr.CreateUser(t.Context(), "Otra")
	if other.Error != nil {
		t.Fatalf("CreateUser: %v", other.Error)
	}
	if r := usr.SwitchUser(t.Context(), 1); r.Error != nil {
		t.Fatalf("SwitchUser: %v", r.Error)
	}
	if r := usr.DeleteUser(t.Context(), 1); r.Error != nil {
		t.Fatalf("DeleteUser: %v", r.Error)
	}

	if ids, err := h.svc.autoSyncAccounts(t.Context()); err != nil || len(ids) != 0 {
		t.Fatalf("autoSyncAccounts after trashing the profile = %v, %v; want none", ids, err)
	}
}
