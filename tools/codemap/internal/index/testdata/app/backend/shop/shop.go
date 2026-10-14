// Package shop is the fixture's only domain: one bound service whose methods
// cover every way codemap finds a call or a table.
package shop

import (
	"fmt"

	"example.com/app/third_party/bun"
)

type Item struct {
	bun.BaseModel `bun:"table:items,alias:i"`
	ID            int64
	Name          string
}

type Cart struct {
	bun.BaseModel `bun:"table:carts"`
	ID            int64
}

// Clock is the only interface: Stamp reaches fixedClock.Now through it.
type Clock interface{ Now() int64 }

type fixedClock struct{}

func (fixedClock) Now() int64 { return 1 }

// ShopService is the bound service of the fixture.
type ShopService struct {
	db    *bun.DB
	clock Clock
}

func NewShopService(db *bun.DB) *ShopService { return &ShopService{db: db, clock: fixedClock{}} }

func (s *ShopService) ServiceName() string { return "ShopService" }

// AddItem stores one item. It also touches the carts.
func (s *ShopService) AddItem(name string) error {
	s.db.NewInsert().Model(&Item{Name: name})
	s.touch()
	return nil
}

// RemoveCart deletes a cart through the generic helper.
func (s *ShopService) RemoveCart(id int64) error { return s.softDelete((*Cart)(nil), id) }

// Report runs a Sprintf'd SQL constant.
func (s *ShopService) Report() error {
	return s.db.NewRaw(fmt.Sprintf(reportSQL, "items.name")).Scan(nil)
}

// Purge deletes from a table named at run time.
func (s *ShopService) Purge(table string) { s.db.NewDelete().TableExpr(table) }

// Stamp asks the clock through its interface.
func (s *ShopService) Stamp() int64 { return s.clock.Now() }

func (s *ShopService) softDelete(model any, id int64) error {
	s.db.NewDelete().Model(model)
	return nil
}

// touch reads the carts inside a closure.
func (s *ShopService) touch() {
	func() { s.db.NewSelect().TableExpr("carts AS c") }()
}

const reportSQL = `SELECT %s FROM items JOIN carts ON carts.id = items.id`
