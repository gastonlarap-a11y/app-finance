// Package users is the Wails v3 service for finance profiles. There is no login:
// the active user lives in a shared Session (in memory) and is persisted in prefs so
// it survives restarts. All finance data is scoped by user_id in the same database,
// so switching user is just an in-memory id change + a frontend refetch (instant).
package users

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/prefs"
)

type UsersService struct {
	db         *bun.DB
	session    *Session
	appName    string
	purgeHooks []PurgeHook
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

// PurgeHook forgets what a profile keeps outside the database (the mail
// password in the OS keychain) before its rows go. Set by main.go, so users
// needs no dependency on the domains that own those secrets.
type PurgeHook func(ctx context.Context, tx bun.Tx, userID int64) error

// AddPurgeHook registers a hook PurgeUser runs inside its transaction. A
// package function, not a method: every exported method of a service becomes
// a frontend binding.
func AddPurgeHook(s *UsersService, h PurgeHook) { s.purgeHooks = append(s.purgeHooks, h) }

// PurgeUser deletes a profile in the trash for good: its row and every row of
// every table that carries its user_id (found in the schema, so a table added
// later is never forgotten); children without user_id go by ON DELETE
// CASCADE. Only a trashed profile can be purged — the trash is the confirm step.
func (s *UsersService) PurgeUser(ctx context.Context, id int64) OpResult {
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		trashed, err := tx.NewSelect().Model((*User)(nil)).WhereDeleted().Where("id = ?", id).Exists(ctx)
		if err != nil {
			return err
		}
		if !trashed {
			return shared.NewError(shared.ErrNotFound, "el perfil no está en la papelera")
		}
		for _, h := range s.purgeHooks {
			if err := h(ctx, tx, id); err != nil {
				return err
			}
		}
		var tables []string
		if err := tx.NewRaw(`SELECT m.name FROM sqlite_master AS m JOIN pragma_table_info(m.name) AS p
			WHERE m.type = 'table' AND p.name = 'user_id' AND m.name <> 'users' ORDER BY m.name`).Scan(ctx, &tables); err != nil {
			return fmt.Errorf("finding profile tables: %w", err)
		}
		for _, t := range tables {
			if _, err := tx.NewDelete().TableExpr(t).Where("user_id = ?", id).Exec(ctx); err != nil {
				return fmt.Errorf("purging %s: %w", t, err)
			}
		}
		_, err = tx.NewDelete().Model((*User)(nil)).WhereDeleted().Where("id = ?", id).ForceDelete().Exec(ctx)
		return err
	})
	return OpResult{Error: toAppErrorOrNil(err)}
}

// toAppErrorOrNil is toAppError that keeps a nil error nil.
func toAppErrorOrNil(err error) *shared.AppError {
	if err == nil {
		return nil
	}
	return toAppError(err)
}

// ListDeletedUsers returns every soft-deleted profile, oldest first.
func (s *UsersService) ListDeletedUsers(ctx context.Context) ([]User, error) {
	var deleted []User
	err := s.db.NewSelect().Model(&deleted).WhereDeleted().Order("id ASC").Scan(ctx)
	return deleted, err
}
