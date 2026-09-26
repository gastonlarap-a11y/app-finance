package db

import (
	"context"
	"fmt"
	"maps"

	"github.com/uptrace/bun"
)

// Desktop ⇄ iPad sync is a handoff of the whole database file (a Drive backup,
// a file in iCloud/Files): no server, so no merge. What keeps it safe is a
// version vector (Parker et al.; the conflict detector of Dynamo and Riak):
// the database counts, per device, how many times it left that device with
// changes. Comparing the vector of an incoming file with the local one tells
// whether importing it keeps every local change (it is newer), would drop some
// (older), or would drop changes made on both sides (diverged).
//
// Tables (migration 20260926026): sync_state.dirty, set by triggers on every
// user-data table, and sync_vector(device_id, edits).

// Vector counts, per device id, how many times the database left it with changes.
type Vector map[string]int64

// How an incoming database relates to the local one.
const (
	SyncSame     = "igual"       // the same changes
	SyncNewer    = "mas-nueva"   // it has every local change and more: importing loses nothing
	SyncOlder    = "mas-antigua" // it lacks local changes: importing drops them
	SyncDiverged = "divergente"  // both have changes the other lacks: importing drops the local ones
)

// ReadSync returns the database's vector and whether it changed since it last
// left this device.
func ReadSync(ctx context.Context, idb bun.IDB) (Vector, bool, error) {
	var rows []struct {
		DeviceID string `bun:"device_id"`
		Edits    int64  `bun:"edits"`
	}
	if err := idb.NewRaw("SELECT device_id, edits FROM sync_vector").Scan(ctx, &rows); err != nil {
		return nil, false, fmt.Errorf("reading sync vector: %w", err)
	}
	v := make(Vector, len(rows))
	for _, r := range rows {
		v[r.DeviceID] = r.Edits
	}
	var dirty int
	if err := idb.NewRaw("SELECT dirty FROM sync_state WHERE id = 1").Scan(ctx, &dirty); err != nil {
		return nil, false, fmt.Errorf("reading sync state: %w", err)
	}
	return v, dirty != 0, nil
}

// MarkShared records that the database is about to leave this device (a
// backup, an export): pending changes become one more edit of deviceID.
// Nothing to record when it did not change since the last time.
func MarkShared(ctx context.Context, db *bun.DB, deviceID string) error {
	return db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		res, err := tx.ExecContext(ctx, "UPDATE sync_state SET dirty = 0 WHERE id = 1 AND dirty = 1")
		if err != nil {
			return fmt.Errorf("clearing sync state: %w", err)
		}
		if n, err := res.RowsAffected(); err != nil || n == 0 {
			return err // not dirty: the vector already describes this data
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO sync_vector (device_id, edits) VALUES (?, 1)
			ON CONFLICT (device_id) DO UPDATE SET edits = edits + 1`, deviceID)
		if err != nil {
			return fmt.Errorf("bumping sync vector: %w", err)
		}
		return nil
	})
}

// CompareSync tells how an incoming vector relates to the local database's.
// Local changes not yet shared count as one more edit of this device.
func CompareSync(local Vector, localDirty bool, deviceID string, incoming Vector) string {
	l := maps.Clone(local)
	if l == nil {
		l = Vector{}
	}
	if localDirty {
		l[deviceID]++
	}
	localCovered := covers(incoming, l)
	incomingCovered := covers(l, incoming)
	switch {
	case localCovered && incomingCovered:
		return SyncSame
	case localCovered:
		return SyncNewer
	case incomingCovered:
		return SyncOlder
	default:
		return SyncDiverged
	}
}

// covers reports whether a holds at least every edit b has.
func covers(a, b Vector) bool {
	for dev, n := range b {
		if a[dev] < n {
			return false
		}
	}
	return true
}
