import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { Card } from '@/services/contract'
import { ExpenseForm } from './ExpenseForm'

const state = vi.hoisted(() => ({ calls: [] as Array<[string, ...unknown[]]> }))

vi.mock('@/services/finance', () => ({
  KIND_CUOTAS: 'cuotas',
  KIND_UNICO: 'unico',
  FinanceService: {
    ListTags: () => Promise.resolve([]),
    LatestFxRate: () => Promise.resolve({ data: '' }),
    ListAccounts: () => Promise.resolve({ data: { accounts: [], unassignedIngresos: '0', unassignedGastos: '0', cards: [] } }),
    ListCategories: () => Promise.resolve([]),
    ListMerchants: () => Promise.resolve([]),
    CreateExpense: (...args: unknown[]) => {
      state.calls.push(['CreateExpense', ...args])
      return Promise.resolve({ data: { id: 7 } })
    },
    DeferExpense: (...args: unknown[]) => {
      state.calls.push(['DeferExpense', ...args])
      return Promise.resolve({})
    },
  },
}))

const visa: Card = {
  id: 3,
  userId: 1,
  name: 'Visa',
  creditLimit: '1000000',
  billingDay: 24,
  lastDigits: '',
  paymentDay: null,
  accountId: null,
  color: '',
  createdAt: '',
  deletedAt: null,
}

beforeEach(() => {
  state.calls = []
})

describe('ExpenseForm', () => {
  it('saves a purchase whose first cuota the bank postponed, then moves its plan', async () => {
    await render(
      <ExpenseForm cards={[visa]} categories={[]} merchants={[]} target={{ mode: 'create' }} onClose={() => {}} onSaved={() => {}} />,
    )
    await userEvent.fill(page.getByRole('textbox', { name: 'Descripción' }), 'Refrigerador')
    await userEvent.fill(page.getByRole('textbox', { name: /Monto por cuota/ }), '50000')
    await page.getByRole('combobox', { name: 'Tarjeta' }).selectOptions('3')
    await userEvent.fill(page.getByLabelText('Fecha de compra'), '2030-01-26')
    // Bought after the 24th cutoff: billed in February.
    await expect.element(page.getByText(/Primera cuota en:/)).toHaveTextContent('Primera cuota en: Febrero de 2030')

    await page.getByRole('checkbox', { name: 'El banco posterga la primera cuota' }).click()
    const first = page.getByLabelText('Primera cuota en')
    await expect.element(first).toHaveValue('2030-03')
    await userEvent.fill(first, '2030-05')
    await page.getByRole('button', { name: 'Agregar' }).click()

    await expect.poll(() => state.calls.map((c) => c[0])).toEqual(['CreateExpense', 'DeferExpense'])
    expect(state.calls[1]).toEqual(['DeferExpense', 7, '2030-05'])
  })

  it('does not move the plan when the postponement is left unchecked', async () => {
    await render(
      <ExpenseForm cards={[visa]} categories={[]} merchants={[]} target={{ mode: 'create' }} onClose={() => {}} onSaved={() => {}} />,
    )
    await userEvent.fill(page.getByRole('textbox', { name: 'Descripción' }), 'Notebook')
    await userEvent.fill(page.getByRole('textbox', { name: /Monto por cuota/ }), '100000')
    await page.getByRole('button', { name: 'Agregar' }).click()
    await expect.poll(() => state.calls.map((c) => c[0])).toEqual(['CreateExpense'])
  })
})
