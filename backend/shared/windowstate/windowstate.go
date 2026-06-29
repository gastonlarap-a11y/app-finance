package windowstate

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/uptrace/bun"
)

// State is the persisted window geometry.
type State struct {
	X, Y, W, H int
	Maximized  bool
}

func defaultState() State { return State{X: 100, Y: 100, W: 1200, H: 800} }

// appSetting is a tiny key/value row in the shared app_settings table.
type appSetting struct {
	bun.BaseModel `bun:"table:app_settings,alias:s"`

	Key   string `bun:"key,pk"`
	Value string `bun:"value,notnull"`
}

const stateKey = "window_state"

// Load returns the saved window state, falling back to sensible defaults on any error.
func Load(ctx context.Context, db *bun.DB) State {
	st := defaultState()
	var row appSetting
	if err := db.NewSelect().Model(&row).Where("key = ?", stateKey).Scan(ctx); err != nil {
		return st
	}
	var loaded State
	if err := json.Unmarshal([]byte(row.Value), &loaded); err != nil {
		slog.Warn("windowstate: corrupt value, using defaults", "err", err)
		return st
	}
	if loaded.W <= 0 || loaded.H <= 0 {
		return st
	}
	return loaded
}

// Save upserts the window state. Call it on the WindowClosing event.
func Save(ctx context.Context, db *bun.DB, s State) error {
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	row := appSetting{Key: stateKey, Value: string(data)}
	_, err = db.NewInsert().Model(&row).
		On("CONFLICT (key) DO UPDATE").
		Set("value = EXCLUDED.value").
		Exec(ctx)
	return err
}
