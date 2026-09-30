import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { AccountView } from '@/services/contract'
import { AccountsSettings } from './Accounts'

const state = vi.hoisted(() => ({
  accounts: [] as AccountView[],
  saved: [] as unknown[][],
}))

vi.mock('@/services/finance', () => ({
  FinanceService: {
    ListTransfers: () => Promise.resolve([]),
    ListAccounts: () => Promise.resolve({ data: { accounts: state.accounts, unassignedIngresos: '0', unassignedGastos: '0', cards: [] } }),
    CreateAccount: (...args: unknown[]) => {
      state.saved.push(args)
      return Promise.resolve({ data: { id: 1 } })
    },
    UpdateAccount: (...args: unknown[]) => {
      state.saved.push(args)
      return Promise.resolve({ data: { id: 1 } })
    },
  },
}))

beforeEach(() => {
  state.accounts = []
  state.saved = []
})

describe('AccountForm', () => {
  it('starts an overdrawn account with a negative opening balance', async () => {
    await render(<AccountsSettings />)
    await page.getByRole('button', { name: 'Agregar una cuenta' }).click()
    await userEvent.fill(page.getByRole('textbox', { name: 'Nombre' }), 'Cuenta corriente')
    await userEvent.fill(page.getByRole('textbox', { name: /Saldo al inicio del mes/ }), '250000')
    await page.getByRole('checkbox', { name: /Saldo negativo/ }).click()
    await page.getByRole('button', { name: 'Guardar' }).click()
    await expect.poll(() => state.saved[0]?.slice(0, 3)).toEqual(['Cuenta corriente', 'corriente', '-250000'])
  })

  it('edits a negative opening balance as its magnitude and the sign apart', async () => {
    state.accounts = [
      {
        id: 4,
        userId: 1,
        name: 'Itaú',
        kind: 'corriente',
        openingBalance: '-80000',
        openingPeriod: '2026-09',
        receivesSalary: false,
        createdAt: '',
        balance: '-80000',
        ingresos: '0',
        gastos: '0',
        transferIn: '0',
        transferOut: '0',
        conciliacion: null,
      },
    ]
    await render(<AccountsSettings />)
    await page.getByRole('button', { name: 'Editar' }).click()
    await expect.element(page.getByRole('checkbox', { name: /Saldo negativo/ })).toBeChecked()
    await page.getByRole('checkbox', { name: /Saldo negativo/ }).click()
    await page.getByRole('button', { name: 'Guardar' }).click()
    await expect.poll(() => state.saved[0]?.slice(0, 4)).toEqual([4, 'Itaú', 'corriente', '80000'])
  })
})
