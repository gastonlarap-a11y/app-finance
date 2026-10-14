// Package bun stubs the query builders of github.com/uptrace/bun that codemap
// reads table access from.
package bun

type BaseModel struct{}

type DB struct{}

type (
	SelectQuery struct{}
	InsertQuery struct{}
	UpdateQuery struct{}
	DeleteQuery struct{}
	RawQuery    struct{}
)

func (db *DB) NewSelect() *SelectQuery                    { return &SelectQuery{} }
func (db *DB) NewInsert() *InsertQuery                    { return &InsertQuery{} }
func (db *DB) NewUpdate() *UpdateQuery                    { return &UpdateQuery{} }
func (db *DB) NewDelete() *DeleteQuery                    { return &DeleteQuery{} }
func (db *DB) NewRaw(query string, args ...any) *RawQuery { return &RawQuery{} }

func (q *SelectQuery) Model(model any) *SelectQuery                { return q }
func (q *SelectQuery) TableExpr(expr string) *SelectQuery          { return q }
func (q *SelectQuery) Where(cond string, args ...any) *SelectQuery { return q }
func (q *InsertQuery) Model(model any) *InsertQuery                { return q }
func (q *UpdateQuery) Model(model any) *UpdateQuery                { return q }
func (q *DeleteQuery) Model(model any) *DeleteQuery                { return q }
func (q *DeleteQuery) TableExpr(expr string) *DeleteQuery          { return q }
func (q *RawQuery) Scan(dest any) error                            { return nil }
