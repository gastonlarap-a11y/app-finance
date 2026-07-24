import { describe, expect, it } from 'vitest'
import { splitStatements } from '@/engine/db/splitStatements'
import { migrationFiles } from '@/engine/db/migrations'
import { createTestDb } from '@/engine/testing/db'
import { runMigrations } from '@/engine/db/migrator'
import { asString } from '@/engine/db/types'

describe('splitStatements', () => {
  it('separa por líneas --bun:split exactas', () => {
    const sql = 'CREATE TABLE a (id INTEGER);\n--bun:split\nCREATE TABLE b (id INTEGER);\n'
    expect(splitStatements(sql)).toHaveLength(2)
  })
  it('directiva desconocida falla como en bun', () => {
    expect(() => splitStatements('--bun:nope\nSELECT 1;')).toThrow('unknown bun directive')
  })
  it('ignora fragmentos vacíos', () => {
    expect(splitStatements('--bun:split\nSELECT 1;\n')).toHaveLength(1)
  })
})

describe('migrationFiles', () => {
  it('descubre las migraciones reales en orden numérico global', () => {
    const names = migrationFiles().map((f) => f.name)
    expect(names).toEqual([
      '20260628004',
      '20260628005',
      '20260628006',
      '20260630010',
      '20260630011',
      '20260630012',
      '20260702013',
    ])
  })
})

describe('runMigrations', () => {
  it('registra en bun_migrations los mismos nombres que bun y es idempotente', async () => {
    const db = await createTestDb()
    const rows = db.query('SELECT name, group_id FROM bun_migrations ORDER BY id ASC')
    expect(rows.map((r) => asString(r.name))).toEqual(migrationFiles().map((f) => f.name))
    // Todas en un mismo grupo, como un único Migrate() de bun.
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1)

    // Segunda pasada: no-op (igual que RunMigrations en cada arranque desktop).
    expect(runMigrations(db)).toBe(0)
    expect(db.query('SELECT COUNT(*) AS n FROM bun_migrations')[0]?.n).toBe(rows.length)
  })

  it('deja el esquema utilizable (tablas y seed)', async () => {
    const db = await createTestDb()
    // Usuario 1 sembrado por la migración 010.
    expect(db.query('SELECT name FROM users WHERE id = 1')[0]?.name).toBe('Gastón')
    // settings sembrada con una única fila id=1.
    expect(db.query('SELECT default_billing_day FROM settings WHERE id = 1')[0]?.default_billing_day).toBe(24)
  })
})
