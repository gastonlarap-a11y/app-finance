import { describe, expect, it } from 'vitest'
import { periodLabel } from './format'
import { catalogMessage, transferSpan } from './wording'

describe('transferSpan', () => {
  it('names a one-off, an open monthly and an ended monthly transfer', () => {
    expect(transferSpan({ startPeriod: '2026-09', endPeriod: '2026-09' })).toBe(`una vez, ${periodLabel('2026-09')}`)
    expect(transferSpan({ startPeriod: '2026-08', endPeriod: '' })).toBe(`cada mes desde ${periodLabel('2026-08')}`)
    expect(transferSpan({ startPeriod: '2026-08', endPeriod: '2026-12' })).toBe(
      `cada mes, de ${periodLabel('2026-08')} a ${periodLabel('2026-12')}`,
    )
  })
})

describe('catalogMessage', () => {
  it.each([
    [{ categories: 0, merchants: 0, rules: 0 }, 'Ya tienes todo el catálogo sugerido.'],
    [{ categories: 1, merchants: 0, rules: 0 }, 'Se agregaron 1 categoría.'],
    [{ categories: 0, merchants: 2, rules: 1 }, 'Se agregaron 2 comercios y 1 regla de importación.'],
    [{ categories: 34, merchants: 210, rules: 261 }, 'Se agregaron 34 categorías, 210 comercios y 261 reglas de importación.'],
  ])('%o → %s', (counts, want) => {
    expect(catalogMessage(counts)).toBe(want)
  })
})
