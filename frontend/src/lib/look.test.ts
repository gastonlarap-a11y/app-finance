import { describe, expect, it } from 'vitest'
import { LOOK_COLORS, LOOK_ICONS } from '@/engine/finance/looks'
import { COLORS, ICONS, autoColor, autoIcon, cardColor, categoryLooks, goalLook, nameLook, resolveLook } from './look'

describe('catalog', () => {
  it('ICONS and COLORS hold exactly the keys of looks.json', () => {
    expect(Object.keys(ICONS).sort()).toEqual([...LOOK_ICONS].sort())
    expect(Object.keys(COLORS).sort()).toEqual([...LOOK_COLORS].sort())
  })

  it('every icon has a distinct Spanish label', () => {
    const labels = Object.values(ICONS).map((i) => i.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('autoColor', () => {
  it('is stable, never gray, and spreads consecutive ids', () => {
    expect(autoColor(7)).toBe(autoColor(7))
    expect(autoColor('Comida')).toBe(autoColor('Comida'))
    const firstEleven = Array.from({ length: 11 }, (_, i) => autoColor(i + 1))
    expect(new Set(firstEleven).size).toBe(11)
    expect(firstEleven).not.toContain('gray')
    expect(autoColor(-3)).not.toBe('gray')
  })
})

describe('autoIcon', () => {
  it.each([
    ['Supermercado', 'shopping-cart'],
    ['Súper', 'shopping-cart'],
    ['Arriendo', 'house'],
    ['Gastos comunes', 'house'],
    ['Luz', 'zap'],
    ['Agua', 'droplet'],
    ['Gas', 'flame'],
    ['Farmacia', 'pill'],
    ['Transporte', 'bus'],
    ['Bencina', 'fuel'],
    ['Comida y restaurantes', 'utensils'],
    ['Educación', 'graduation-cap'],
    ['Mascotas', 'paw-print'],
    ['Suscripciones', 'tv'],
    ['Vacaciones', 'tree-palm'],
    ['Fondo de emergencia', 'umbrella'],
  ] as const)('%s → %s', (name, icon) => {
    expect(autoIcon(name, 'tag')).toBe(icon)
  })

  it('matches whole words: "Gastos varios" is not gas', () => {
    expect(autoIcon('Gastos varios', 'tag')).toBe('tag')
  })

  it('falls back when nothing matches', () => {
    expect(autoIcon('Xyz', 'piggy-bank')).toBe('piggy-bank')
  })
})

describe('resolveLook', () => {
  it('keeps a known choice', () => {
    expect(resolveLook({ id: 1, name: 'Comida', icon: 'coffee', color: 'pink' })).toEqual({ icon: 'coffee', color: 'pink' })
  })

  it('treats "" and keys unknown to this copy as automatic', () => {
    const auto = { icon: 'utensils', color: autoColor(4) }
    expect(resolveLook({ id: 4, name: 'Comida', icon: '', color: '' })).toEqual(auto)
    expect(resolveLook({ id: 4, name: 'Comida', icon: 'rocket', color: 'magenta' })).toEqual(auto)
  })

  it('card colors and goal icons follow the same rule', () => {
    expect(cardColor({ id: 2, color: 'teal' })).toBe('teal')
    expect(cardColor({ id: 2, color: '' })).toBe(autoColor(2))
    expect(goalLook({ id: 3, name: 'Ahorro', icon: '' }).icon).toBe('piggy-bank')
    expect(goalLook({ id: 3, name: 'Viaje a Japón', icon: '' }).icon).toBe('plane')
    expect(goalLook({ id: 3, name: 'Otra', icon: 'trophy' }).icon).toBe('trophy')
  })

  it('a category known only by name gets a look seeded by the name', () => {
    expect(nameLook('Luz')).toEqual({ icon: 'zap', color: autoColor('Luz') })
  })
})

describe('categoryLooks', () => {
  it('finds a category by name (any case) or id, and falls back by name', () => {
    const looks = categoryLooks([{ id: 9, name: 'Comida', icon: 'coffee', color: 'pink' }])
    expect(looks.byName('comida')).toEqual({ icon: 'coffee', color: 'pink' })
    expect(looks.byId(9)).toEqual({ icon: 'coffee', color: 'pink' })
    expect(looks.byId(10)).toBeUndefined()
    expect(looks.byName('Luz')).toEqual(nameLook('Luz'))
  })
})
