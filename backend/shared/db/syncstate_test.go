package db_test

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared/db"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/db/dbtest"
)

func TestCompareSync(t *testing.T) {
	const here = "escritorio"
	tests := []struct {
		name     string
		local    db.Vector
		dirty    bool
		incoming db.Vector
		want     string
	}{
		{"fresh install takes anything", db.Vector{}, false, db.Vector{"ipad": 3}, db.SyncNewer},
		{"same copy", db.Vector{here: 1}, false, db.Vector{here: 1}, db.SyncSame},
		{"the iPad added changes on top", db.Vector{here: 1}, false, db.Vector{here: 1, "ipad": 1}, db.SyncNewer},
		{"an older backup of this computer", db.Vector{here: 2}, false, db.Vector{here: 1}, db.SyncOlder},
		{"this computer changed since sharing", db.Vector{here: 1}, true, db.Vector{here: 1}, db.SyncOlder},
		{"both changed", db.Vector{here: 1}, true, db.Vector{here: 1, "ipad": 1}, db.SyncDiverged},
		{"unrelated histories", db.Vector{here: 1}, false, db.Vector{"ipad": 1}, db.SyncDiverged},
		{"a nil local vector", nil, false, db.Vector{}, db.SyncSame},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := db.CompareSync(tt.local, tt.dirty, here, tt.incoming); got != tt.want {
				t.Fatalf("CompareSync = %s, want %s", got, tt.want)
			}
		})
	}
}

func TestTriggersMarkChangesAndMarkSharedCountsThem(t *testing.T) {
	ctx := t.Context()
	bdb := dbtest.OpenMigrated(t)

	read := func() (db.Vector, bool) {
		t.Helper()
		v, dirty, err := db.ReadSync(ctx, bdb)
		if err != nil {
			t.Fatal(err)
		}
		return v, dirty
	}
	if v, dirty := read(); dirty || len(v) != 0 {
		t.Fatalf("a fresh database = %v dirty %v, want empty and clean", v, dirty)
	}

	for _, stmt := range []string{
		`INSERT INTO categories (user_id, name) VALUES (1, 'Comida')`,
		`UPDATE categories SET name = 'Super' WHERE name = 'Comida'`,
		`DELETE FROM categories`,
	} {
		t.Run(stmt, func(t *testing.T) {
			if err := db.MarkShared(ctx, bdb, "x"); err != nil { // start clean
				t.Fatal(err)
			}
			if _, err := bdb.ExecContext(ctx, stmt); err != nil {
				t.Fatal(err)
			}
			if _, dirty := read(); !dirty {
				t.Fatalf("%s did not mark the database as changed", stmt)
			}
		})
	}

	// Sharing counts the pending changes once; sharing again without changes adds nothing.
	if _, err := bdb.ExecContext(ctx, `INSERT INTO categories (user_id, name) VALUES (1, 'Luz')`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := db.MarkShared(ctx, bdb, "escritorio"); err != nil {
			t.Fatal(err)
		}
	}
	v, dirty := read()
	if dirty || v["escritorio"] != 1 {
		t.Fatalf("after sharing: %v dirty %v, want escritorio:1 and clean", v, dirty)
	}
}
