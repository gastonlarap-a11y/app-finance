import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { AccountsClosing, MonthlySummary } from '@/services/contract'
import { formatCLP } from '@/lib/format'
import { ReconcileDialog } from './ReconcileDialog'

const summary: MonthlySummary = {
  period: '2026-08',
  salary: '0',
  salaryExpected: false,
  extras: '0',
  ingresos: '0',
  acumulado: '0',
  disponible: '0',
  gastos: '0',
  pendiente: '0',
  pagado: '0',
  ahorro: '0',
  balance: '900000',
  alcanza: true,
  porCategoria: [],
  porTarjeta: [],
  movimientos: [],
  incomes: [],
  presupuestos: [],
  acumuladoDesde: '',
  conciliacion: null,
}

const closing = (over: Partial<AccountsClosing>): AccountsClosing => ({
  complete: true,
  missing: [],
  accounts: '1010000',
  cardsOwed: '100000',
  total: '910000',
  saved: '2000000',
  unassignedIngresos: '0',
  unassignedGastos: '0',
  ...over,
})

const state = vi.hoisted(() => ({
  closing: null as AccountsClosing | null,
  saved: [] as unknown[][],
}))

vi.mock('@/services/finance', () => ({
  FinanceService: {
    AccountsClosing: () => Promise.resolve({ data: state.closing }),
    SetReconciliation: (...args: unknown[]) => {
      state.saved.push(args)
      return Promise.resolve({})
    },
  },
}))

beforeEach(() => {
  state.closing = null
  state.saved = []
})

describe('the month close from the accounts', () => {
  it('fills the real balance from the reconciled accounts minus the cards owed', async () => {
    state.closing = closing({})
    await render(<ReconcileDialog mode="cierre" summary={summary} onClose={() => {}} onSaved={() => {}} />)
    await expect.element(page.getByText(/Según tus cuentas conciliadas/)).toBeVisible()
    await page.getByRole('button', { name: 'Usar este saldo' }).click()
    await expect.element(page.getByText(formatCLP('10000'))).toBeVisible() // difference: 910.000 − 900.000
    await page.getByRole('button', { name: 'Guardar' }).click()
    await expect.poll(() => state.saved).toEqual([['2026-08', '910000']])
  })

  it('names the accounts still to reconcile', async () => {
    state.closing = closing({ complete: false, missing: ['Itaú', 'Mercado Pago'] })
    await render(<ReconcileDialog mode="cierre" summary={summary} onClose={() => {}} onSaved={() => {}} />)
    await expect.element(page.getByText(/concilia también Itaú, Mercado Pago/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Usar este saldo' })).not.toBeInTheDocument()
  })
})
