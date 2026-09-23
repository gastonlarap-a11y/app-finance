// Package users is the Wails v3 service for finance profiles. There is no login:
// the active user lives in a shared Session (in memory) and is persisted in prefs so
// it survives restarts. All finance data is scoped by user_id in the same database,
// so switching user is just an in-memory id change + a frontend refetch (instant).
package users

import (
	"context"
	"database/sql"
	"errors"
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
		if errors.Is(err, sql.ErrNoRows) {
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
		if errors.Is(err, sql.ErrNoRows) {
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
	if err := requireOne(res, err, "usuario no encontrado"); err != nil {
		return UserResult{Error: err}
	}
	return UserResult{Data: &User{ID: id, Name: name}}
}

// setActive updates the in-memory session and persists the choice to prefs
// (best-effort: a failed save only means the next launch resumes elsewhere).
func (s *UsersService) setActive(id int64) {
	s.session.SetActive(id)
	prefs.Update(s.appName, func(p *prefs.Prefs) { p.ActiveUserID = id })
}

// DeleteUser soft-deletes a profile. At least one active user must always
// remain. If the deleted user was active, the session switches to another
// remaining user (instant, no manual step — mirrors SwitchUser's UX).
func (s *UsersService) DeleteUser(ctx context.Context, id int64) UserResult {
	next := new(User)
	// Count + delete + pick-next run in one transaction so two concurrent
	// deletes can never remove the last remaining profile.
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		count, err := tx.NewSelect().Model((*User)(nil)).Count(ctx)
		if err != nil {
			return err
		}
		if count <= 1 {
			return shared.NewError(shared.ErrConflict, "no podés eliminar el último usuario")
		}
		res, err := tx.NewDelete().Model((*User)(nil)).Where("id = ?", id).Exec(ctx)
		if err != nil {
			return err
		}
		if aerr := requireOne(res, nil, "usuario no encontrado"); aerr != nil {
			return aerr
		}
		return tx.NewSelect().Model(next).Order("id ASC").Limit(1).Scan(ctx)
	})
	if err != nil {
		return UserResult{Error: toAppError(err)}
	}
	if id != s.session.Active() {
		return UserResult{}
	}
	s.setActive(next.ID)
	return UserResult{Data: next}
}

// toAppError surfaces an *AppError raised inside a transaction as-is and wraps
// any other error as internal.
func toAppError(err error) *shared.AppError {
	if ae, ok := errors.AsType[*shared.AppError](err); ok {
		return ae
	}
	return shared.NewError(shared.ErrInternal, err.Error())
}

// RestoreUser undoes a soft delete.
func (s *UsersService) RestoreUser(ctx context.Context, id int64) OpResult {
	res, err := s.db.NewUpdate().Model((*User)(nil)).WhereAllWithDeleted().
		Set("deleted_at = NULL").Where("id = ? AND deleted_at IS NOT NULL", id).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "usuario no encontrado o no estaba eliminado")}
}

// requireOne turns an Exec outcome into a Result error: a system error becomes
// ErrInternal and zero affected rows becomes ErrNotFound with notFoundMsg.
func requireOne(res sql.Result, err error, notFoundMsg string) *shared.AppError {
	if err != nil {
		return shared.NewError(shared.ErrInternal, err.Error())
	}
	n, err := res.RowsAffected()
	if err != nil {
		return shared.NewError(shared.ErrInternal, err.Error())
	}
	if n == 0 {
		return shared.NewError(shared.ErrNotFound, notFoundMsg)
	}
	return nil
}

// ListDeletedUsers returns every soft-deleted profile, oldest first.
func (s *UsersService) ListDeletedUsers(ctx context.Context) ([]User, error) {
	var deleted []User
	err := s.db.NewSelect().Model(&deleted).WhereDeleted().Order("id ASC").Scan(ctx)
	return deleted, err
}
