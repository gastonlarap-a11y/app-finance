package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixtureCopy is a writable copy of the fixture: diagrams are written under
// the indexed root, and the fixture itself must stay untouched.
func fixtureCopy(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.CopyFS(root, os.DirFS(fixtureRoot)); err != nil {
		t.Fatal(err)
	}
	return root
}

// withoutArchify hides any Archify install, so the run stops at the JSON.
func withoutArchify(t *testing.T) {
	t.Setenv("ARCHIFY_BIN", "")
	t.Setenv("HOME", t.TempDir())
}

func TestDiagramWritesArchifyJSON(t *testing.T) {
	withoutArchify(t)
	root := fixtureCopy(t)
	tests := []struct {
		name string
		args []string
		file string
		want []string // fragments of the JSON
	}{
		{"architecture", []string{"diagram", "architecture"}, "architecture.json",
			[]string{`"diagram_type": "architecture"`, `"label": "Servicios Go"`, `"output": ".codemap/diagrams/architecture.html"`}},
		{"sequence of a Go method", []string{"diagram", "sequence", "ShopService.AddItem"}, "sequence-shop-shopservice-additem-desktop.json",
			[]string{`"diagram_type": "sequence"`, `"label": "AddItem: escribe items"`, `"label": "touch: lee carts"`}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var out strings.Builder
			if err := run(context.Background(), append(tt.args, "-root", root), &out); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), "Sin render") {
				t.Errorf("without Archify the run must say how to install it:\n%s", out.String())
			}
			raw, err := os.ReadFile(filepath.Join(root, ".codemap", "diagrams", tt.file))
			if err != nil {
				t.Fatal(err)
			}
			if !json.Valid(raw) {
				t.Fatal("invalid JSON")
			}
			for _, want := range tt.want {
				if !strings.Contains(string(raw), want) {
					t.Errorf("%s lacks %s", tt.file, want)
				}
			}
			if strings.Contains(string(raw), `"repository"`) {
				t.Error("a root that is not a Git checkout's top cannot pin citations")
			}
		})
	}
}

func TestDiagramErrors(t *testing.T) {
	withoutArchify(t)
	root := fixtureCopy(t)
	tests := []struct {
		name string
		args []string
		want string
	}{
		{"no type", []string{"diagram"}, "needs a type"},
		{"unknown type", []string{"diagram", "erd"}, "unknown diagram type"},
		{"sequence without a name", []string{"diagram", "sequence"}, "needs the symbol"},
		{"no data on that build", []string{"diagram", "sequence", "ShopService.Stamp"}, "no llega a ninguna tabla"},
		{"unknown symbol", []string{"diagram", "sequence", "Nowhere"}, "No encontré"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var out strings.Builder
			err := run(context.Background(), append(tt.args, "-root", root), &out)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("err = %v, want it to mention %q", err, tt.want)
			}
		})
	}
}

// TestDiagramRendersWithArchify renders with a real Archify when ARCHIFY_BIN
// points at one (archify/bin/archify.mjs); skipped otherwise.
func TestDiagramRendersWithArchify(t *testing.T) {
	if os.Getenv("ARCHIFY_BIN") == "" {
		t.Skip("set ARCHIFY_BIN to a real archify/bin/archify.mjs to render")
	}
	root := fixtureCopy(t)
	for _, args := range [][]string{
		{"diagram", "architecture"},
		{"diagram", "sequence", "ShopService.AddItem"},
	} {
		var out strings.Builder
		if err := run(context.Background(), append(args, "-root", root), &out); err != nil {
			t.Fatalf("%v: %v\n%s", args, err, out.String())
		}
		if !strings.Contains(out.String(), "HTML: ") {
			t.Errorf("%v rendered nothing:\n%s", args, out.String())
		}
	}
}
