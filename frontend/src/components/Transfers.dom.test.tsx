import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { AccountView, Transfer } from '@/services/contract'
import { TransfersSection } from './Transfers'

const account = (id: number, name: string, receivesSalary = false): AccountView => ({
  id,
  userId: 1,
  name,
  kind: 'corriente',
  openingBalance: '0',
  openingPeriod: '2026-09',
  receivesSalary,
  createdAt: '',
  balance: '0',
  ingresos: '0',
  gastos: '0',
  transferIn: '0',
  transferOut: '0',
})

const state = vi.hoisted(() => ({
  accounts: [] as AccountView[],
  transfers: [] as Transfer[],
  created: [] as unknown[][],
}))

vi.mock('@/services/finance', () => ({
  FinanceService: {
    ListTransfers: () => Promise.resolve(state.transfers),
    ListAccounts: () => Promise.resolve({ data: { accounts: state.accounts, unassignedIngresos: '0', unassignedGastos: '0' } }),
    CreateTransfer: (...args: unknown[]) => {
      state.created.push(args)
      return Promise.resolve({ data: { id: 1 } })
    },
  },
}))

beforeEach(() => {
  state.accounts = []
  state.transfers = []
  state.created = []
})

describe('TransfersSection', () => {
  it('asks for two accounts before offering transfers', async () => {
    state.accounts = [account(1, 'Itaú')]
    await render(<TransfersSection period="2026-09" />)
    await expect.element(page.getByText('Agrega al menos dos cuentas')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Nueva transferencia' })).not.toBeInTheDocument()
  })

  it('creates a monthly transfer from the salary account by default', async () => {
    state.accounts = [account(1, 'Itaú'), account(2, 'Banco de Chile', true)]
    await render(<TransfersSection period="2026-09" />)
    await page.getByRole('button', { name: 'Agregar una transferencia' }).click()
    await expect.element(page.getByRole('combobox', { name: 'Desde' })).toHaveValue('2')
    await expect.element(page.getByRole('switch', { name: /Repetir todos los meses/ })).toBeChecked()
    await userEvent.fill(page.getByRole('textbox', { name: 'Monto' }), '1500000')
    await userEvent.fill(page.getByRole('textbox', { name: /Descripción/ }), 'Sueldo a Itaú')
    await page.getByRole('button', { name: 'Guardar' }).click()
    await expect.poll(() => state.created).toEqual([[2, 1, 'Sueldo a Itaú', '1500000', '2026-09', true]])
  })

  it('lists a transfer with its accounts, amount and span', async () => {
    state.accounts = [account(1, 'Itaú'), account(2, 'Banco de Chile', true)]
    state.transfers = [
      { id: 7, userId: 1, fromAccountId: 2, toAccountId: 1, description: 'Sueldo', amount: '1500000', startPeriod: '2026-08', endPeriod: '', createdAt: '' },
    ]
    await render(<TransfersSection period="2026-09" />)
    await expect.element(page.getByText('Mensual')).toBeVisible()
    await expect.element(page.getByText(/Sueldo · cada mes desde/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Acciones de la transferencia Banco de Chile a Itaú' })).toBeVisible()
  })
})
