package index

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
)

// The fixture (testdata/app) is a miniature of this repo: a Wails service
// (stubbed Wails and bun), migrations that create, rename and drop tables, a
// contract with a desktop binding and a web engine, and a React component.

const (
	goShop       = "go:example.com/app/backend/shop."
	contractAdd  = "ts:frontend/src/services/contract.ts#ShopServiceContract.AddItem"
	engineAdd    = "ts:frontend/src/engine/shop/service.ts#createShopService.service.AddItem"
	engineRemove = "ts:frontend/src/engine/shop/service.ts#createShopService.service.RemoveCart"
)

func fixture(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("testdata/app")
	if err != nil {
		t.Fatal(err)
	}
	return root
}

// goOnly indexes the fixture without its frontend.
func goOnly(t *testing.T) *graph.Graph {
	t.Helper()
	root := fixture(t)
	g, err := Build(context.Background(), Options{Root: root, Frontend: filepath.Join(root, "no-frontend")})
	if err != nil {
		t.Fatal(err)
	}
	return g
}

// withTS indexes the fixture with its frontend, using this repo's extractor
// and TypeScript. It skips when Node or frontend/node_modules is missing
// (CI's Go step runs before `npm ci`) unless CODEMAP_REQUIRE_NODE=1.
func withTS(t *testing.T) *graph.Graph {
	t.Helper()
	repo, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	_, nodeErr := exec.LookPath("node")
	_, tsErr := os.Stat(filepath.Join(repo, "frontend", "node_modules", "typescript"))
	if nodeErr != nil || tsErr != nil {
		if os.Getenv("CODEMAP_REQUIRE_NODE") == "1" {
			t.Fatalf("CODEMAP_REQUIRE_NODE=1 but Node or frontend/node_modules/typescript is missing: %v %v", nodeErr, tsErr)
		}
		t.Skip("Node or frontend/node_modules/typescript missing (set CODEMAP_REQUIRE_NODE=1 to fail instead)")
	}
	g, err := Build(context.Background(), Options{
		Root:   fixture(t),
		Script: filepath.Join(repo, "frontend", "scripts", "codemap-ts.ts"),
	})
	if err != nil {
		t.Fatal(err)
	}
	// The fixture's main embeds a missing frontend/dist on purpose: only a
	// TypeScript note means the frontend half failed.
	if slices.ContainsFunc(g.Notes, func(n string) bool { return strings.Contains(n, "TypeScript") }) {
		t.Fatalf("TypeScript half not indexed: %v", g.Notes)
	}
	return g
}

func hasEdge(g *graph.Graph, from, to string, kind graph.EdgeKind) bool {
	return slices.ContainsFunc(g.Out[from], func(e graph.Edge) bool { return e.To == to && e.Kind == kind })
}

func dispatchTo(g *graph.Graph, from, to, target string) bool {
	return slices.ContainsFunc(g.Out[from], func(e graph.Edge) bool {
		return e.To == to && e.Kind == graph.EdgeDispatch && e.Target == target
	})
}

func TestGoIndex(t *testing.T) {
	g := goOnly(t)

	t.Run("bound methods come from application.NewService despite the missing embed dir", func(t *testing.T) {
		for _, m := range []string{"AddItem", "RemoveCart", "Report", "Purge", "Stamp"} {
			if n := g.Nodes[goShop+"ShopService."+m]; n == nil || n.Bound != "ShopService" {
				t.Errorf("%s: node %+v, want Bound ShopService", m, n)
			}
		}
		for _, m := range []string{"ServiceName", "softDelete", "touch"} {
			if n := g.Nodes[goShop+"ShopService."+m]; n == nil || n.Bound != "" {
				t.Errorf("%s: node %+v, want unbound", m, n)
			}
		}
	})

	edges := []struct {
		name     string
		from, to string
		kind     graph.EdgeKind
	}{
		{"bun Model on an insert writes", "ShopService.AddItem", "sql:items", graph.EdgeWrite},
		{"plain call", "ShopService.AddItem", goShop + "ShopService.touch", graph.EdgeCall},
		{"closure belongs to its function; TableExpr reads", "ShopService.touch", "sql:carts", graph.EdgeRead},
		{"model passed as any is resolved at the call site", "ShopService.RemoveCart", "sql:carts", graph.EdgeWrite},
		{"Sprintf'd SQL constant reads", "ShopService.Report", "sql:items", graph.EdgeRead},
		{"Sprintf'd SQL constant joins", "ShopService.Report", "sql:carts", graph.EdgeRead},
		{"interface call reaches the implementer", "ShopService.Stamp", goShop + "fixedClock.Now", graph.EdgeCall},
		{"test calls the method", "TestAddItem", goShop + "ShopService.AddItem", graph.EdgeCall},
	}
	for _, e := range edges {
		t.Run(e.name, func(t *testing.T) {
			if !hasEdge(g, goShop+e.from, e.to, e.kind) {
				t.Errorf("missing %s -%s-> %s; out: %v", e.from, e.kind, e.to, g.Out[goShop+e.from])
			}
		})
	}

	t.Run("a table named at run time is reported, not guessed", func(t *testing.T) {
		if n := g.Nodes[goShop+"ShopService.Purge"]; len(n.Unresolved) == 0 {
			t.Errorf("Purge: no unresolved site")
		}
	})

	t.Run("only live tables, positioned at their create or rename", func(t *testing.T) {
		var tables []string
		for _, n := range g.Nodes {
			if n.Kind == graph.KindTable {
				tables = append(tables, n.Name)
			}
		}
		slices.Sort(tables)
		if !slices.Equal(tables, []string{"carts", "items"}) {
			t.Errorf("tables = %v", tables)
		}
		if p := g.Nodes["sql:carts"].Pos; p.File != "backend/shop/migrations/002_rename_carts.up.sql" || p.Line != 1 {
			t.Errorf("carts at %v, want the rename", p)
		}
	})

	t.Run("kinds, docs and test helpers", func(t *testing.T) {
		if k := g.Nodes[goShop+"TestAddItem"].Kind; k != graph.KindTestFunc {
			t.Errorf("TestAddItem kind = %v", k)
		}
		if d := g.Nodes[goShop+"ShopService.AddItem"].Doc; d != "AddItem stores one item." {
			t.Errorf("AddItem doc = %q (want its first sentence)", d)
		}
		im := g.Impact(g.Nodes[goShop+"NewShopService"], 0)
		if got := im.GoTests["backend/shop"]; !slices.Equal(got, []string{"TestAddItem"}) {
			t.Errorf("impact of NewShopService through the helper reaches tests %v, want [TestAddItem]", got)
		}
	})

	t.Run("missing frontend is a note, not a failure", func(t *testing.T) {
		if !slices.ContainsFunc(g.Notes, func(n string) bool { return strings.Contains(n, "TypeScript not indexed") }) {
			t.Errorf("notes = %v", g.Notes)
		}
	})
}

func TestCrossLanguageLinks(t *testing.T) {
	g := withTS(t)

	t.Run("the contract member dispatches to both builds", func(t *testing.T) {
		if !dispatchTo(g, contractAdd, goShop+"ShopService.AddItem", graph.TargetDesktop) {
			t.Errorf("no desktop dispatch; out: %v", g.Out[contractAdd])
		}
		if !dispatchTo(g, contractAdd, engineAdd, graph.TargetWeb) {
			t.Errorf("no web dispatch; out: %v", g.Out[contractAdd])
		}
	})

	edges := []struct {
		name     string
		from, to string
		kind     graph.EdgeKind
	}{
		{"component handler calls the contract", "ts:frontend/src/components/CartForm.tsx#CartForm.submit", contractAdd, graph.EdgeCall},
		{"anonymous callback belongs to the component", "ts:frontend/src/components/CartForm.tsx#CartForm", "ts:frontend/src/components/CartForm.tsx#CartForm.submit", graph.EdgeCall},
		{"JSX renders", "ts:frontend/src/components/CartForm.tsx#App", "ts:frontend/src/components/CartForm.tsx#CartForm", graph.EdgeRender},
		{"engine helper call", engineAdd, "ts:frontend/src/engine/shop/service.ts#createShopService.insertItem", graph.EdgeCall},
		{"engine SQL writes", "ts:frontend/src/engine/shop/service.ts#createShopService.insertItem", "sql:items", graph.EdgeWrite},
		{"a table literal is a mention", engineRemove, "sql:carts", graph.EdgeMention},
	}
	for _, e := range edges {
		t.Run(e.name, func(t *testing.T) {
			if !hasEdge(g, e.from, e.to, e.kind) {
				t.Errorf("missing %s -%s-> %s; out: %v", e.from, e.kind, e.to, g.Out[e.from])
			}
		})
	}

	t.Run("dynamic table in a template literal is unresolved", func(t *testing.T) {
		if len(g.Nodes[engineRemove].Unresolved) == 0 {
			t.Error("RemoveCart: no unresolved site")
		}
	})

	t.Run("a component reaches the same table on both builds", func(t *testing.T) {
		form := g.Nodes["ts:frontend/src/components/CartForm.tsx#CartForm"]
		for _, target := range []string{graph.TargetDesktop, graph.TargetWeb} {
			if !slices.ContainsFunc(g.Tables(form, target), func(u graph.TableUse) bool { return u.Table.Name == "items" && u.Write }) {
				t.Errorf("%s: CartForm does not write items: %v", target, g.Tables(form, target))
			}
		}
	})

	t.Run("impact keeps engine tests to web-side changes", func(t *testing.T) {
		web := g.Impact(g.Nodes[engineAdd], 0)
		if !slices.Equal(web.TSTests, []string{"frontend/src/engine/shop/service.test.ts"}) {
			t.Errorf("engine impact TS tests = %v", web.TSTests)
		}
		desktop := g.Impact(g.Nodes[goShop+"ShopService.AddItem"], 0)
		if len(desktop.TSTests) != 0 || !slices.Equal(desktop.GoTests["backend/shop"], []string{"TestAddItem"}) {
			t.Errorf("Go impact tests = %v / %v", desktop.GoTests, desktop.TSTests)
		}
		if !slices.ContainsFunc(desktop.UI, func(n *graph.Node) bool { return n.Name == "CartForm" }) {
			t.Errorf("Go impact UI = %v, want CartForm", desktop.UI)
		}
	})
}

func TestIndexRebuildsWhenGoChanges(t *testing.T) {
	root := t.TempDir()
	if err := os.CopyFS(root, os.DirFS(fixture(t))); err != nil {
		t.Fatal(err)
	}
	ix := New(Options{Root: root, Frontend: filepath.Join(root, "no-frontend")})
	ix.recheck = 0
	ctx := context.Background()
	first, err := ix.Graph(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if again, _ := ix.Graph(ctx); again != first {
		t.Fatal("unchanged sources rebuilt the graph")
	}
	extra := "package shop\n\nfunc Added() {}\n"
	if err := os.WriteFile(filepath.Join(root, "backend", "shop", "added.go"), []byte(extra), 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := ix.Graph(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if second == first || second.Nodes[goShop+"Added"] == nil {
		t.Error("a new Go file did not rebuild the graph")
	}
}
