// Mirror of backend/shared/db/syncstate_test.go.
import { describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { compareSync, markShared, readSync, type Vector } from '@/engine/db/syncstate'
import { syncNotice } from '@/lib/syncText'

describe('compareSync', () => {
  const here = 'escritorio'
  for (const [name, local, dirty, incoming, want] of [
    ['instalación nueva acepta todo', {}, false, { ipad: 3 }, 'mas-nueva'],
    ['misma copia', { [here]: 1 }, false, { [here]: 1 }, 'igual'],
    ['el iPad agregó cambios', { [here]: 1 }, false, { [here]: 1, ipad: 1 }, 'mas-nueva'],
    ['respaldo antiguo de este equipo', { [here]: 2 }, false, { [here]: 1 }, 'mas-antigua'],
    ['este equipo cambió desde que compartió', { [here]: 1 }, true, { [here]: 1 }, 'mas-antigua'],
    ['ambos cambiaron', { [here]: 1 }, true, { [here]: 1, ipad: 1 }, 'divergente'],
    ['historias sin relación', { [here]: 1 }, false, { ipad: 1 }, 'divergente'],
  ] as [string, Vector, boolean, Vector, string][]) {
    it(name, () => expect(compareSync(local, dirty, here, incoming)).toBe(want))
  }
})

describe('triggers y markShared', () => {
  it('marcan cambios y los cuentan una vez al compartir', async () => {
    const db = await createTestDb()
    expect(readSync(db)).toEqual({ vector: {}, dirty: false })
    for (const stmt of [
      "INSERT INTO categories (user_id, name) VALUES (1, 'Comida')",
      "UPDATE categories SET name = 'Super' WHERE name = 'Comida'",
      'DELETE FROM categories',
    ]) {
      markShared(db, 'x')
      db.exec(stmt)
      expect(readSync(db).dirty, stmt).toBe(true)
    }
    db.exec("INSERT INTO categories (user_id, name) VALUES (1, 'Luz')")
    markShared(db, 'web')
    markShared(db, 'web')
    const { vector, dirty } = readSync(db)
    expect([vector.web, dirty]).toEqual([1, false])
  })
})

describe('syncNotice', () => {
  it('avisa según el riesgo', () => {
    expect(syncNotice('mas-nueva')?.tone).toBe('ok')
    expect(syncNotice('igual')?.tone).toBe('ok')
    expect(syncNotice('mas-antigua')?.tone).toBe('warn')
    expect(syncNotice('divergente')?.tone).toBe('danger')
    expect(syncNotice('')).toBeNull()
  })
})
