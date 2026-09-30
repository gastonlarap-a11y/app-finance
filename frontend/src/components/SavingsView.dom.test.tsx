import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { AccountView, SavingsGoalView } from '@/services/contract'
import { SavingsView } from './SavingsView'

const savingsAccount: AccountView = {
  id: 4,
  userId: 1,
  name: 'Cuenta de ahorro',
  kind: 'ahorro',
  openingBalance: '2000000',
  openingPeriod: '2026-09',
  receivesSalary: false,
  createdAt: '',
  balance: '2150000',
  ingresos: '0',
  gastos: '0',
  transferIn: '150000',
  transferOut: '0',
  conciliacion: null,
}

const goal = (accountId: number | null): SavingsGoalView => ({
  id: 9,
  userId: 1,
  name: 'Fondo de emergencia',
  targetAmount: '5000000',
  targetPeriod: '',
  icon: '',
  accountId,
  createdAt: '',
  saved: accountId === null ? '0' : '2150000',
  remaining: accountId === null ? '5000000' : '2850000',
  monthsLeft: 0,
  monthlyNeeded: '0',
  overdue: false,
  contributions: [],
})

const state = vi.hoisted(() => ({
  goals: [] as SavingsGoalView[],
  linked: [] as unknown[][],
}))

vi.mock('@/services/finance', () => ({
  FinanceService: {
    ListSavingsGoals: () => Promise.resolve(state.goals),
    ListAccounts: () =>
      Promise.resolve({ data: { accounts: [savingsAccount], unassignedIngresos: '0', unassignedGastos: '0', cards: [] } }),
    UpdateSavingsGoal: (id: number) => Promise.resolve({ data: { ...goal(null), id } }),
    SetSavingsGoalAccount: (...args: unknown[]) => {
      state.linked.push(args)
      return Promise.resolve({})
    },
  },
}))

beforeEach(() => {
  state.goals = []
  state.linked = []
})

describe('a goal that follows a savings account', () => {
  it('shows the account it follows and takes no contributions by hand', async () => {
    state.goals = [goal(savingsAccount.id)]
    await render(<SavingsView />)
    await expect.element(page.getByText(/Sigue el saldo de/)).toBeVisible()
    await expect.element(page.getByText('Cuenta de ahorro', { exact: true })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Aporte' })).not.toBeInTheDocument()
  })

  it('links a goal to an account from its form', async () => {
    state.goals = [goal(null)]
    await render(<SavingsView />)
    await page.getByRole('button', { name: 'Acciones de la meta Fondo de emergencia' }).click()
    await page.getByRole('menuitem', { name: 'Editar' }).click()
    await userEvent.selectOptions(page.getByRole('combobox', { name: /Sigue una cuenta de ahorro/ }), String(savingsAccount.id))
    await page.getByRole('button', { name: 'Guardar' }).click()
    await expect.poll(() => state.linked).toEqual([[9, savingsAccount.id]])
  })
})
