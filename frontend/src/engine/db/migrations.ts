// Shares the Go backend's embedded .up.sql files with the web engine via Vite
// raw imports. New migrations added under backend/*/migrations are picked up by
// the glob automatically — no engine change needed. The windowstate set is
// intentionally not included (native window geometry has no meaning on web).

const modules: Record<string, string> = {
  ...import.meta.glob<string>('../../../../backend/finance/migrations/*.up.sql', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob<string>('../../../../backend/users/migrations/*.up.sql', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
}

export interface MigrationFile {
  // name is what bun records in bun_migrations: the numeric filename prefix.
  name: string
  sql: string
}

// Mirror of bun/migrate's fnameRE.
const FNAME_RE = /^(\d{1,14})_([0-9a-z_-]+)\./

export function migrationFiles(source: Record<string, string> = modules): MigrationFile[] {
  const files = Object.entries(source).map(([path, sql]) => {
    const base = path.split('/').pop() ?? path
    const m = FNAME_RE.exec(base)
    if (!m || m[1] === undefined) {
      throw new Error(`unsupported migration name format: ${base}`)
    }
    return { name: m[1], sql }
  })
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return files
}
