// Mirror of backend/finance/look_test.go: same scenarios, same outcomes.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import { LOOK_COLORS, LOOK_ICONS, validColor, validIcon } from '@/engine/finance/looks'
import type { FinanceServiceContract } from '@/services/contract'

let finance: FinanceServiceContract

beforeEach(async () => {
  const db = await createTestDb()
  finance = createFinanceService(db, createSession(db))
})

function ok<T extends { error?: unknown }>(r: T): T {
  expect(r.error).toBeUndefined()
  return r
}

describe('looks.json', () => {
  it('has the palette and the icon catalog', () => {
    expect(LOOK_COLORS).toHaveLength(12)
    expect(LOOK_ICONS.length).toBeGreaterThanOrEqual(40)
    expect(new Set(LOOK_ICONS).size).toBe(LOOK_ICONS.length)
  })

  it('accepts only exact keys, and "" as automatic', () => {
    for (const key of ['', 'blue', 'gray']) expect(validColor(key)).toBe(true)
    for (const key of ['', 'shopping-cart', 'piggy-bank', 'tag']) expect(validIcon(key)).toBe(true)
    for (const key of ['Blue', 'blue-500', '#ff0000', ' blue']) expect(validColor(key)).toBe(false)
    expect(validIcon('ShoppingCart')).toBe(false)
    expect(validIcon('skull')).toBe(false)
  })
})

describe('SetCategoryLook', () => {
  it('validates, keeps the last write and survives a rename', async () => {
    const cat = ok(await finance.CreateCategory('Supermercado')).data!
    expect([cat.icon, cat.color]).toEqual(['', ''])
    const trashed = ok(await finance.CreateCategory('Vieja')).data!
    ok(await finance.DeleteCategory(trashed.id))

    const cases: Array<[string, number, string, string, string | undefined]> = [
      ['set both', cat.id, 'shopping-cart', 'green', undefined],
      ['back to automatic', cat.id, '', '', undefined],
      ['icon only', cat.id, 'utensils', '', undefined],
      ['unknown icon', cat.id, 'skull', 'green', 'VALIDATION_ERROR'],
      ['unknown color', cat.id, 'utensils', 'magenta', 'VALIDATION_ERROR'],
      ['missing category', 9999, 'utensils', 'green', 'NOT_FOUND'],
      ['trashed category', trashed.id, 'utensils', 'green', 'NOT_FOUND'],
    ]
    for (const [name, id, icon, color, code] of cases) {
      expect((await finance.SetCategoryLook(id, icon, color)).error?.code, name).toBe(code)
    }

    ok(await finance.UpdateCategory(cat.id, 'Súper'))
    const list = await finance.ListCategories()
    expect(list.map((c) => [c.name, c.icon, c.color])).toEqual([['Súper', 'utensils', '']])
  })
})

describe('SetCardColor', () => {
  it('validates and survives an edit of the card', async () => {
    const card = ok(await finance.CreateCard('Visa', '1000000', 24, '')).data!
    expect(card.color).toBe('')

    ok(await finance.SetCardColor(card.id, 'indigo'))
    expect((await finance.SetCardColor(card.id, 'shopping-cart')).error?.code).toBe('VALIDATION_ERROR')
    ok(await finance.UpdateCard(card.id, 'Visa Oro', '2000000', 24, '1234'))
    expect((await finance.ListCards()).map((c) => c.color)).toEqual(['indigo'])

    ok(await finance.DeleteCard(card.id))
    expect((await finance.SetCardColor(card.id, 'red')).error?.code).toBe('NOT_FOUND')
  })
})

describe('SetSavingsGoalIcon', () => {
  it('validates and survives an edit of the goal', async () => {
    const goal = ok(await finance.CreateSavingsGoal('Vacaciones', '1500000', '')).data!
    expect(goal.icon).toBe('')

    ok(await finance.SetSavingsGoalIcon(goal.id, 'tree-palm'))
    expect((await finance.SetSavingsGoalIcon(goal.id, 'green')).error?.code).toBe('VALIDATION_ERROR')
    ok(await finance.UpdateSavingsGoal(goal.id, 'Viaje al sur', '2000000', ''))
    expect((await finance.ListSavingsGoals()).map((g) => g.icon)).toEqual(['tree-palm'])

    ok(await finance.DeleteSavingsGoal(goal.id))
    expect((await finance.SetSavingsGoalIcon(goal.id, 'car')).error?.code).toBe('NOT_FOUND')
  })
})
