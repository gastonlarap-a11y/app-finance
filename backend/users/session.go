package users

import (
	"context"
	"sync"

	"github.com/uptrace/bun"
)

// Session is the in-memory holder of the active user id, shared between the users
// service (which sets it) and the finance service (which reads it on every query).
// Switching user only mutates this id — the SQLite connection is never reopened —
// which is what makes the live switch instant.
type Session struct {
	mu       sync.RWMutex
	activeID int64
}

func NewSession() *Session { return &Session{activeID: 1} }

// Active returns the current user id (defaults to 1, the seeded "Gastón").
func (s *Session) Active() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.activeID
}

// SetActive switches the active user id.
func (s *Session) SetActive(id int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.activeID = id
}

// ResolveActiveID returns the user id to start with: the preferred id when it still
// exists, otherwise the first available user (fallback for a deleted/invalid pref).
// Falls back to 1 if the table cannot be read.
func ResolveActiveID(ctx context.Context, db *bun.DB, preferred int64) int64 {
	if preferred > 0 {
		exists, err := db.NewSelect().Model((*User)(nil)).Where("id = ?", preferred).Exists(ctx)
		if err == nil && exists {
			return preferred
		}
	}
	first := new(User)
	if err := db.NewSelect().Model(first).Order("id ASC").Limit(1).Scan(ctx); err == nil {
		return first.ID
	}
	return 1
}
