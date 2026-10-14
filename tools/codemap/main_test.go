package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixtureRoot is the miniature app the index tests use. The CLI looks for the
// TypeScript extractor inside it, where there is none, so these runs cover the
// Go half only and do not depend on Node.
const fixtureRoot = "internal/index/testdata/app"

func runCLI(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var out strings.Builder
	err := run(context.Background(), append(args, "-root", fixtureRoot), &out)
	return out.String(), err
}

func TestRunCommands(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want []string
	}{
		{"overview lists the bound service", []string{"overview"}, []string{
			"Servicios Wails", "ShopService  backend/shop  5 métodos", "items", "carts",
		}},
		{"search", []string{"search", "-lang", "go", "softDel"}, []string{"shop.ShopService.softDelete [go method]"}},
		{"symbol explains callers, callees and tables", []string{"symbol", "ShopService.AddItem"}, []string{
			"shop.ShopService.AddItem [go method · bound ShopService]",
			"Doc: AddItem stores one item.",
			"call shop.ShopService.touch",
			"escribe items  (directo)",
			"lee carts  (vía shop.ShopService.touch)",
		}},
		{"trace walks down to the tables", []string{"trace", "ShopService.AddItem"}, []string{
			"write items", "call shop.ShopService.touch", "read carts",
		}},
		{"impact names the tests to run", []string{"impact", "shop.ShopService.touch"}, []string{
			"shop.ShopService.AddItem", "go test -race -run '^(TestAddItem)$' ./backend/shop",
		}},
		{"impact says when no test covers it", []string{"impact", "shop.ShopService.softDelete"}, []string{
			"shop.ShopService.RemoveCart", "Ningún test lo alcanza",
		}},
		{"flags after the name", []string{"trace", "ShopService.AddItem", "-full"}, []string{"todas las ramas"}},
		{"ambiguous names list candidates", []string{"symbol", "Now"}, []string{"shop.fixedClock.Now"}},
		{"a partial index says so", []string{"symbol", "ShopService.Purge"}, []string{"⚠ Índice parcial"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := runCLI(t, tt.args...)
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range tt.want {
				if !strings.Contains(got, want) {
					t.Errorf("output lacks %q:\n%s", want, got)
				}
			}
		})
	}
}

func TestRunErrors(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{"no command", nil, "usage"},
		{"unknown command", []string{"explode"}, "unknown command"},
		{"missing name", []string{"symbol"}, "needs a name"},
		{"bad target", []string{"trace", "-target", "mobile", "X"}, "-target must be"},
		{"bad kind", []string{"search", "-kind", "widget", "X"}, "unknown kind"},
		{"bad lang", []string{"search", "-lang", "rust", "X"}, "unknown lang"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var out strings.Builder
			err := run(context.Background(), tt.args, &out)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("err = %v, want it to mention %q", err, tt.want)
			}
		})
	}
}

func TestRepoRootFindsGoMod(t *testing.T) {
	want, err := filepath.Abs(fixtureRoot)
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(filepath.Join(fixtureRoot, "backend", "shop"))
	got, err := repoRoot("")
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Errorf("repoRoot = %s, want %s", got, want)
	}
	if _, err := os.Stat(filepath.Join(got, "go.mod")); err != nil {
		t.Error(err)
	}
}
