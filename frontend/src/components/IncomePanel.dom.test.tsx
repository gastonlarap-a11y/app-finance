import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { BaseSalary, PeriodSalary } from '@/services/contract'
import { currentPeriod } from '@/lib/format'
import { IncomePanel } from './IncomePanel'

const state = vi.hoisted(() => ({
  salary: null as PeriodSalary | null,
  base: null as BaseSalary | null,
  calls: [] as unknown[][],
}))

vi.mock('@/services/finance', () => ({
  FinanceService: {
    GetSalary: () => Promise.resolve({ data: state.salary }),
    GetBaseSalary: () => Promise.resolve(state.base ? { data: state.base } : {}),
    ListIncomes: () => Promise.resolve([]),
    ListAccounts: () => Promise.resolve({ data: { accounts: [], unassignedIngresos: '0', unassignedGastos: '0', cards: [] } }),
    SetSalary: (...args: unknown[]) => {
      state.calls.push(['SetSalary', ...args])
      return Promise.resolve({})
    },
    SetBaseSalary: (...args: unknown[]) => {
      state.calls.push(['SetBaseSalary', ...args])
      return Promise.resolve({})
    },
  },
}))

beforeEach(() => {
  state.salary = null
  state.base = null
  state.calls = []
})

describe('recurring salary in the Ingresos panel', () => {
  it('shows the expected base salary and confirms it', async () => {
    const period = currentPeriod()
    state.salary = { userId: 1, period, amount: '2300000', expected: true }
    state.base = { effectiveFrom: '2026-09', amount: '2300000' }
    await render(<IncomePanel />)
    await expect.element(page.getByText('Esperado')).toBeVisible()
    await expect.element(page.getByText(/se repite cada mes/)).toBeVisible()
    await page.getByRole('button', { name: 'Confirmar' }).click()
    await expect.poll(() => state.calls).toEqual([['SetSalary', period, '2300000']])
  })

  it('offers to repeat a confirmed salary every month', async () => {
    const period = currentPeriod()
    state.salary = { userId: 1, period, amount: '2300000', expected: false }
    await render(<IncomePanel />)
    await expect.element(page.getByText(/Sin sueldo base/)).toBeVisible()
    await page.getByRole('button', { name: 'Repetir este sueldo cada mes' }).click()
    await expect.poll(() => state.calls).toEqual([['SetBaseSalary', period, '2300000']])
  })
})
