package db

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"strings"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/migrate"

	financemigrations "github.com/gastonlarap-a11y/app-finance/backend/finance/migrations"
	mailsyncmigrations "github.com/gastonlarap-a11y/app-finance/backend/mailsync/migrations"
	windowstatemigrations "github.com/gastonlarap-a11y/app-finance/backend/shared/windowstate/migrations"
	usersmigrations "github.com/gastonlarap-a11y/app-finance/backend/users/migrations"
)

// ErrNewerSchema means the database was migrated by a newer version of the app:
// this binary does not know every applied migration, so its queries may not
// match the schema. Opening it anyway risks writing rows the newer version
// cannot read.
var ErrNewerSchema = errors.New("la base de datos fue actualizada por una versión más nueva de la app")

// newMigrator discovers every domain's SQL migrations, creates bun's bookkeeping
// tables and refuses a database that is ahead of this binary.
// ADD a new domain's embed.FS to the slice below when you create a feature domain.
// The numeric prefix in each SQL filename determines execution order globally.
func newMigrator(ctx context.Context, bdb *bun.DB) (*migrate.Migrator, error) {
	m := migrate.NewMigrations()

	for _, fsys := range []embed.FS{
		financemigrations.Migrations,
		mailsyncmigrations.Migrations, // desktop only: the web engine does not load it
		windowstatemigrations.Migrations,
		usersmigrations.Migrations,
	} {
		if err := m.Discover(fsys); err != nil {
			return nil, fmt.Errorf("discovering migrations: %w", err)
		}
	}

	// Record a migration only after it ran: a failed one is retried on the next
	// start instead of being skipped with a half-applied schema. Files named
	// *.tx.up.sql also run inside a transaction, so they either apply whole or
	// not at all.
	migrator := migrate.NewMigrator(bdb, m, migrate.WithMarkAppliedOnSuccess(true))
	if err := migrator.Init(ctx); err != nil {
		return nil, fmt.Errorf("init migrator: %w", err)
	}

	newer, err := newerThanKnown(ctx, migrator, m)
	if err != nil {
		return nil, err
	}
	if len(newer) > 0 {
		return nil, fmt.Errorf("%w (migraciones desconocidas: %s)", ErrNewerSchema, strings.Join(newer, ", "))
	}
	return migrator, nil
}

// newerThanKnown lists applied migrations this binary does not know and that
// sort after the last one it knows — the mark of a newer app version, since
// prefixes grow over time. Unknown migrations that sort before it are retired
// ones, e.g. the template's 20260628001/002 that early databases still record
// after those domains were removed; they say nothing about the schema's age.
func newerThanKnown(ctx context.Context, migrator *migrate.Migrator, known *migrate.Migrations) ([]string, error) {
	unknown, err := migrator.MissingMigrations(ctx)
	if err != nil {
		return nil, fmt.Errorf("reading applied migrations: %w", err)
	}
	sorted := known.Sorted()
	if len(sorted) == 0 {
		return nil, nil
	}
	latest := sorted[len(sorted)-1].Name
	var newer []string
	for _, u := range unknown {
		if u.Name > latest {
			newer = append(newer, u.Name)
		}
	}
	return newer, nil
}

// PendingMigrations reports how many migrations RunMigrations would apply, so
// the caller can snapshot the database first. It fails with ErrNewerSchema when
// the database is ahead of this binary.
func PendingMigrations(ctx context.Context, bdb *bun.DB) (int, error) {
	migrator, err := newMigrator(ctx, bdb)
	if err != nil {
		return 0, err
	}
	ms, err := migrator.MigrationsWithStatus(ctx)
	if err != nil {
		return 0, fmt.Errorf("reading migration status: %w", err)
	}
	return len(ms.Unapplied()), nil
}

// RunMigrations applies every pending migration. It fails with ErrNewerSchema
// when the database is ahead of this binary.
func RunMigrations(ctx context.Context, bdb *bun.DB) error {
	migrator, err := newMigrator(ctx, bdb)
	if err != nil {
		return err
	}
	if _, err := migrator.Migrate(ctx); err != nil {
		return fmt.Errorf("running migrations: %w", err)
	}
	return nil
}
