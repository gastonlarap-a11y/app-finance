package shop

import (
	"testing"

	"example.com/app/third_party/bun"
)

func TestAddItem(t *testing.T) {
	if err := newTestService().AddItem("x"); err != nil {
		t.Fatal(err)
	}
}

// newTestService is a test helper: impact must see through it to TestAddItem.
func newTestService() *ShopService { return NewShopService(&bun.DB{}) }
