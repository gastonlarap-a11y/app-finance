package index

import (
	"maps"
	"slices"
	"testing"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
)

func TestClassifySQL(t *testing.T) {
	tables := tableSet{"expenses": {}, "installments": {}, "cards": {}, "items": {}}
	tests := []struct {
		name    string
		sql     string
		want    []tableAccess
		dynamic bool
	}{
		{"select reads", "SELECT * FROM expenses WHERE id = ?", []tableAccess{{"expenses", graph.EdgeRead}}, false},
		{"join reads both", "SELECT 1 FROM expenses e JOIN cards c ON c.id = e.card_id",
			[]tableAccess{{"expenses", graph.EdgeRead}, {"cards", graph.EdgeRead}}, false},
		{"insert writes", "INSERT INTO installments (n) VALUES (?)", []tableAccess{{"installments", graph.EdgeWrite}}, false},
		{"insert or ignore writes", "INSERT OR IGNORE INTO cards (id) VALUES (1)", []tableAccess{{"cards", graph.EdgeWrite}}, false},
		{"update writes, upsert clause ignored", "INSERT INTO cards (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET x = 1",
			[]tableAccess{{"cards", graph.EdgeWrite}}, false},
		{"delete from writes, not reads", "DELETE FROM expenses WHERE id = ?", []tableAccess{{"expenses", graph.EdgeWrite}}, false},
		{"subquery reads", "user_id = ? AND id IN (SELECT id FROM installments)", []tableAccess{{"installments", graph.EdgeRead}}, false},
		{"quoted name", `SELECT * FROM "cards"`, []tableAccess{{"cards", graph.EdgeRead}}, false},
		{"unknown table ignored", "SELECT name FROM sqlite_master", nil, false},
		{"prose is not SQL", "could not read from expenses", nil, false},
		{"exact table name is a mention", "items", []tableAccess{{"items", graph.EdgeMention}}, false},
		{"concatenated name is dynamic", "SELECT count(*) FROM ", nil, true},
		{"template placeholder is dynamic", "UPDATE ? SET deleted = 1", nil, true},
		{"printf verb is dynamic", "DELETE FROM %s WHERE id = ?", nil, true},
		{"from subquery is not dynamic", "SELECT * FROM (SELECT 1)", nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, dynamic := classifySQL(tt.sql, tables)
			if !slices.Equal(got, tt.want) || dynamic != tt.dynamic {
				t.Errorf("classifySQL(%q) = %v, dynamic %v; want %v, dynamic %v", tt.sql, got, dynamic, tt.want, tt.dynamic)
			}
		})
	}
}

func TestApplyDDL(t *testing.T) {
	tables := tableSet{}
	applyDDL(tables, "001.up.sql", "CREATE TABLE IF NOT EXISTS items (id INT);\n-- DROP TABLE items;\nCREATE TABLE old_carts (id INT);\nCREATE TABLE legacy (id INT);")
	applyDDL(tables, "002.up.sql", "ALTER TABLE old_carts RENAME TO carts;\nDROP TABLE IF EXISTS legacy;")

	want := map[string]graph.Pos{
		"items": {File: "001.up.sql", Line: 1},
		"carts": {File: "002.up.sql", Line: 1},
	}
	if len(tables) != len(want) {
		t.Fatalf("tables = %v, want %v", tables, want)
	}
	for name, pos := range want {
		if tables[name] != pos {
			t.Errorf("tables[%q] = %v, want %v", name, tables[name], pos)
		}
	}
}

func TestReplayMigrationsOrdersByVersion(t *testing.T) {
	tables, err := replayMigrations("testdata/app")
	if err != nil {
		t.Fatal(err)
	}
	got := slices.Sorted(maps.Keys(tables))
	if want := []string{"carts", "items"}; !slices.Equal(got, want) {
		t.Errorf("live tables = %v, want %v", got, want)
	}
}
