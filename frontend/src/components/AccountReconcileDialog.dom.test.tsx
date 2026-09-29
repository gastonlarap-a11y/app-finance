import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { AccountView } from '@/services/contract'
import { formatCLP } from '@/lib/format'
import { AccountBalancesPanel } from './Accounts'

const account = (conciliacion: AccountView['conciliacion'] = null): AccountView => ({
  id: 3,
  userId: 1,
  name: 'Itaú',
  kind: 'corriente',
  openingBalance: '0',
  openingPeriod: '2026-07',
  receivesSalary: false,
  createdAt: '',
  balance: '2100000',
  ingresos: '0',
  gastos: '0',
  transferIn: '0',
  transferOut: '0',
  conciliacion,
})

const state = vi.hoisted(() => ({
  accounts: [] as AccountView[],
  saved: [] as unknown[][],
  deleted: [] as unknown[][],
}))

vi.mock('@/services/finance', () => ({
  FinanceService: {
    ListAccounts: () => Promise.resolve({ data: { accounts: state.accounts, unassignedIngresos: '0', unassignedGastos: '0' } }),
    SetAccountReconciliation: (...args: unknown[]) => {
      state.saved.push(args)
      return Promise.resolve({})
    },
    DeleteAccountReconciliation: (...args: unknown[]) => {
      state.deleted.push(args)
      return Promise.resolve({})
    },
  },
}))

beforeEach(() => {
  state.accounts = []
  state.saved = []
  state.deleted = []
})

describe('account reconciliation from the Resumen panel', () => {
  it('records the bank balance at the close of the month, showing the difference', async () => {
    state.accounts = [account()]
    await render(<AccountBalancesPanel period="2026-08" />)
    await page.getByRole('button', { name: 'Acciones de la cuenta Itaú' }).click()
    await page.getByRole('menuitem', { name: /Conciliar/ }).click()
    await userEvent.fill(page.getByRole('textbox', { name: 'Saldo real al cierre' }), '1950000')
    await expect.element(page.getByText(formatCLP('-150000'))).toBeVisible()
    await page.getByRole('button', { name: 'Guardar' }).click()
    await expect.poll(() => state.saved).toEqual([[3, '2026-08', '1950000']])
  })

  it('sends an overdraft as a negative balance', async () => {
    state.accounts = [account()]
    await render(<AccountBalancesPanel period="2026-08" />)
    await page.getByRole('button', { name: 'Acciones de la cuenta Itaú' }).click()
    await page.getByRole('menuitem', { name: /Conciliar/ }).click()
    await userEvent.fill(page.getByRole('textbox', { name: 'Saldo real al cierre' }), '25000')
    await page.getByRole('checkbox', { name: /Saldo negativo/ }).click()
    await page.getByRole('button', { name: 'Guardar' }).click()
    await expect.poll(() => state.saved).toEqual([[3, '2026-08', '-25000']])
  })

  it('shows a reconciled account and lets the user remove it', async () => {
    state.accounts = [account({ saldoReal: '1950000', calculado: '2100000', diferencia: '-150000' })]
    await render(<AccountBalancesPanel period="2026-08" />)
    await expect.element(page.getByText('Conciliada')).toBeVisible()
    await expect.element(page.getByText(/El banco dice \$1\.950\.000; la app calculaba \$2\.100\.000/)).toBeVisible()
    await page.getByRole('button', { name: 'Acciones de la cuenta Itaú' }).click()
    await page.getByRole('menuitem', { name: /Editar conciliación/ }).click()
    await page.getByRole('button', { name: 'Quitar conciliación' }).click()
    await expect.poll(() => state.deleted).toEqual([[3, '2026-08']])
  })

  it('offers no reconciliation for a month that has not started', async () => {
    state.accounts = [account()]
    await render(<AccountBalancesPanel period="2099-01" />)
    await expect.element(page.getByText('Itaú')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Acciones de la cuenta Itaú' })).not.toBeInTheDocument()
  })
})
