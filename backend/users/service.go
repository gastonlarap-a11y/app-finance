// Package users is the Wails v3 service for finance profiles. There is no login:
// the active user lives in a shared Session (in memory) and is persisted in prefs so
// it survives restarts. All finance data is scoped by user_id in the same database,
// so switching user is just an in-memory id change + a frontend refetch (instant).
package users

import (
	"context"
	"database/sql"
	"strings"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/prefs"
)

type UsersService struct {
	db      *bun.DB
	session *Session
	appName string
}

func NewService(db *bun.DB, session *Session, appName string) *UsersService {
	return &UsersService{db: db, session: session, appName: appName}
}

func (s *UsersService) ServiceName() string { return "UsersService" }

// ListUsers returns every profile, oldest first.
func (s *UsersService) ListUsers(ctx context.Context) ([]User, error) {
	var users []User
	err := s.db.NewSelect().Model(&users).Order("id ASC").Scan(ctx)
	return users, err
}

// ActiveUser returns the currently selected profile.
func (s *UsersService) ActiveUser(ctx context.Context) UserResult {
	u := new(User)
	if err := s.db.NewSelect().Model(u).Where("id = ?", s.session.Active()).Scan(ctx); err != nil {
		if err == sql.ErrNoRows {
			return UserResult{Error: shared.NewError(shared.ErrNotFound, "usuario activo no encontrado")}
		}
		return UserResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return UserResult{Data: u}
}

// CreateUser adds a profile and switches to it (create-and-enter).
func (s *UsersService) CreateUser(ctx context.Context, name string) UserResult {
	name = strings.TrimSpace(name)
	if name == "" {
		return UserResult{Error: shared.NewError(shared.ErrValidation, "el nombre es obligatorio")}
	}
	u := &User{Name: name}
	if _, err := s.db.NewInsert().Model(u).Returning("*").Exec(ctx); err != nil {
		return UserResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	s.setActive(u.ID)
	return UserResult{Data: u}
}

// SwitchUser changes the active profile (validated to exist) and persists it.
func (s *UsersService) SwitchUser(ctx context.Context, id int64) UserResult {
	u := new(User)
	if err := s.db.NewSelect().Model(u).Where("id = ?", id).Scan(ctx); err != nil {
		if err == sql.ErrNoRows {
			return UserResult{Error: shared.NewError(shared.ErrNotFound, "usuario no encontrado")}
		}
		return UserResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	s.setActive(id)
	return UserResult{Data: u}
}

// RenameUser changes a profile's display name.
func (s *UsersService) RenameUser(ctx context.Context, id int64, name string) UserResult {
	name = strings.TrimSpace(name)
	if name == "" {
		return UserResult{Error: shared.NewError(shared.ErrValidation, "el nombre es obligatorio")}
	}
	res, err := s.db.NewUpdate().Model((*User)(nil)).
		Set("name = ?", name).Where("id = ?", id).Exec(ctx)
	if err != nil {
		return UserResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return UserResult{Error: shared.NewError(shared.ErrNotFound, "usuario no encontrado")}
	}
	return UserResult{Data: &User{ID: id, Name: name}}
}

// setActive updates the in-memory session and persists the choice to prefs.
func (s *UsersService) setActive(id int64) {
	s.session.SetActive(id)
	p := prefs.Load(s.appName)
	p.ActiveUserID = id
	_ = prefs.Save(s.appName, p)
}

// DeleteUser soft-deletes a profile. At least one active user must always
// remain. If the deleted user was active, the session switches to another
// remaining user (instant, no manual step — mirrors SwitchUser's UX).
func (s *UsersService) DeleteUser(ctx context.Context, id int64) UserResult {
	count, err := s.db.NewSelect().Model((*User)(nil)).Count(ctx)
	if err != nil {
		return UserResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if count <= 1 {
		return UserResult{Error: shared.NewError(shared.ErrConflict, "no podés eliminar el último usuario")}
	}
	res, err := s.db.NewDelete().Model((*User)(nil)).Where("id = ?", id).Exec(ctx)
	if err != nil {
		return UserResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return UserResult{Error: shared.NewError(shared.ErrNotFound, "usuario no encontrado")}
	}
	if id != s.session.Active() {
		return UserResult{}
	}
	next := new(User)
	if err := s.db.NewSelect().Model(next).Order("id ASC").Limit(1).Scan(ctx); err != nil {
		return UserResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	s.setActive(next.ID)
	return UserResult{Data: next}
}

// RestoreUser undoes a soft delete.
func (s *UsersService) RestoreUser(ctx context.Context, id int64) OpResult {
	res, err := s.db.NewUpdate().Model((*User)(nil)).WhereAllWithDeleted().
		Set("deleted_at = NULL").Where("id = ? AND deleted_at IS NOT NULL", id).Exec(ctx)
	if err != nil {
		return OpResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return OpResult{Error: shared.NewError(shared.ErrNotFound, "usuario no encontrado o no estaba eliminado")}
	}
	return OpResult{}
}

// ListDeletedUsers returns every soft-deleted profile, oldest first.
func (s *UsersService) ListDeletedUsers(ctx context.Context) ([]User, error) {
	var deleted []User
	err := s.db.NewSelect().Model(&deleted).WhereDeleted().Order("id ASC").Scan(ctx)
	return deleted, err
}
