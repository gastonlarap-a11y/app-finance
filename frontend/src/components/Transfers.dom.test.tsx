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
  conciliacion: null,
})

const state = vi.hoisted(() => ({
  accounts: [] as AccountView[],
  transfers: [] as Transfer[],
  created: [] as unknown[][],
  edited: [] as Array<[string, ...unknown[]]>,
}))

vi.mock('@/services/finance', () => ({
  FinanceService: {
    ListTransfers: () => Promise.resolve(state.transfers),
    ListAccounts: () => Promise.resolve({ data: { accounts: state.accounts, unassignedIngresos: '0', unassignedGastos: '0', cards: [] } }),
    CreateTransfer: (...args: unknown[]) => {
      state.created.push(args)
      return Promise.resolve({ data: { id: 1 } })
    },
    UpdateTransfer: (...args: unknown[]) => {
      state.edited.push(['UpdateTransfer', ...args])
      return Promise.resolve({ data: { id: 7 } })
    },
    ChangeTransferFrom: (...args: unknown[]) => {
      state.edited.push(['ChangeTransferFrom', ...args])
      return Promise.resolve({ data: { id: 8 } })
    },
  },
}))

const monthlySalary: Transfer = {
  id: 7,
  userId: 1,
  fromAccountId: 2,
  toAccountId: 1,
  description: 'Sueldo',
  mode: 'fixed',
  amount: '1500000',
  startPeriod: '2026-08',
  endPeriod: '',
  createdAt: '',
}

beforeEach(() => {
  state.accounts = []
  state.transfers = []
  state.created = []
  state.edited = []
})

describe('editing a monthly transfer', () => {
  async function openEdit() {
    state.accounts = [account(1, 'Itaú'), account(2, 'Banco de Chile', true)]
    state.transfers = [monthlySalary]
    await render(<TransfersSection period="2026-10" />)
    await page.getByRole('button', { name: 'Acciones de la transferencia Banco de Chile a Itaú' }).click()
    await page.getByRole('menuitem', { name: 'Editar' }).click()
    await userEvent.fill(page.getByRole('textbox', { name: 'Monto' }), '1600000')
  }

  it('applies from the month on screen, keeping the months before', async () => {
    await openEdit()
    await expect.element(page.getByLabelText('Aplicar desde')).toHaveValue('2026-10')
    await page.getByRole('button', { name: 'Guardar' }).click()
    await expect.poll(() => state.edited).toEqual([['ChangeTransferFrom', 7, 2, 1, 'Sueldo', 'fixed', '1600000', '2026-10']])
  })

  it('changes every month when applied from its first month', async () => {
    await openEdit()
    await userEvent.fill(page.getByLabelText('Aplicar desde'), '2026-08')
    await page.getByRole('button', { name: 'Guardar' }).click()
    await expect.poll(() => state.edited).toEqual([['UpdateTransfer', 7, 2, 1, 'Sueldo', 'fixed', '1600000']])
  })
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
    await expect.poll(() => state.created).toEqual([[2, 1, 'Sueldo a Itaú', 'fixed', '1500000', '2026-09', true]])
  })

  it('passes on the rest of the salary, keeping an amount in the salary account', async () => {
    state.accounts = [account(1, 'Itaú'), account(2, 'Banco de Chile', true)]
    await render(<TransfersSection period="2026-09" />)
    await page.getByRole('button', { name: 'Agregar una transferencia' }).click()
    await page.getByRole('radio', { name: 'Resto del sueldo' }).click()
    await userEvent.fill(page.getByRole('textbox', { name: 'Se queda en Banco de Chile' }), '470000')
    await page.getByRole('button', { name: 'Guardar' }).click()
    await expect.poll(() => state.created).toEqual([[2, 1, '', 'salary_rest', '470000', '2026-09', true]])
  })

  it('offers the rest of the salary only from the salary account', async () => {
    state.accounts = [account(1, 'Itaú'), account(2, 'Banco de Chile', true)]
    await render(<TransfersSection period="2026-09" />)
    await page.getByRole('button', { name: 'Agregar una transferencia' }).click()
    await expect.element(page.getByRole('radiogroup', { name: 'Cuánto pasa' })).toBeVisible()
    await page.getByRole('combobox', { name: 'Desde' }).selectOptions('1')
    await expect.element(page.getByRole('radiogroup', { name: 'Cuánto pasa' })).not.toBeInTheDocument()
  })

  it('lists a salary-rest transfer as the salary minus what stays', async () => {
    state.accounts = [account(1, 'Itaú'), account(2, 'Banco de Chile', true)]
    state.transfers = [
      {
        id: 8,
        userId: 1,
        fromAccountId: 2,
        toAccountId: 1,
        description: '',
        mode: 'salary_rest',
        amount: '470000',
        startPeriod: '2026-09',
        endPeriod: '',
        createdAt: '',
      },
    ]
    await render(<TransfersSection period="2026-09" />)
    await expect.element(page.getByText(/Sueldo − \$470\.000/)).toBeVisible()
  })

  it('lists a transfer with its accounts, amount and span', async () => {
    state.accounts = [account(1, 'Itaú'), account(2, 'Banco de Chile', true)]
    state.transfers = [
      {
        id: 7,
        userId: 1,
        fromAccountId: 2,
        toAccountId: 1,
        description: 'Sueldo',
        mode: 'fixed',
        amount: '1500000',
        startPeriod: '2026-08',
        endPeriod: '',
        createdAt: '',
      },
    ]
    await render(<TransfersSection period="2026-09" />)
    await expect.element(page.getByText('Mensual')).toBeVisible()
    await expect.element(page.getByText(/Sueldo · cada mes desde/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Acciones de la transferencia Banco de Chile a Itaú' })).toBeVisible()
  })
})
