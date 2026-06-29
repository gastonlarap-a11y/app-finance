package db

import (
	"context"
	"embed"
	"fmt"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/migrate"

	financemigrations "github.com/gastonlarap-a11y/app-finance/backend/finance/migrations"
	windowstatemigrations "github.com/gastonlarap-a11y/app-finance/backend/shared/windowstate/migrations"
)

// RunMigrations discovers and applies every domain's SQL migrations.
// ADD a new domain's embed.FS to the slice below when you create a feature domain.
// The numeric prefix in each SQL filename determines execution order globally.
func RunMigrations(ctx context.Context, bdb *bun.DB) error {
	m := migrate.NewMigrations()

	for _, fsys := range []embed.FS{
		financemigrations.Migrations,
		windowstatemigrations.Migrations,
	} {
		if err := m.Discover(fsys); err != nil {
			return fmt.Errorf("discovering migrations: %w", err)
		}
	}

	migrator := migrate.NewMigrator(bdb, m)
	if err := migrator.Init(ctx); err != nil {
		return fmt.Errorf("init migrator: %w", err)
	}
	if _, err := migrator.Migrate(ctx); err != nil {
		return fmt.Errorf("running migrations: %w", err)
	}
	return nil
}
