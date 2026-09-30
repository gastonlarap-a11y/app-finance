import { describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { Movimiento } from '@/services/contract'
import { formatCLP } from '@/lib/format'
import { CuotaProgress } from './CuotaProgress'

const cuota = (over: Partial<Movimiento>): Movimiento => ({
  source: 'cuota',
  installmentId: 12,
  expenseId: 4,
  fixedId: null,
  refundId: null,
  description: 'Notebook',
  bankDescription: '',
  currency: '',
  originalAmount: '',
  category: 'Tecnología',
  merchant: '',
  cardId: null,
  cardName: '',
  kind: 'cuotas',
  number: 3,
  total: 12,
  amount: '100000',
  status: 'pendiente',
  date: '2026-07-10',
  ufAmount: null,
  estimado: false,
  soFar: '300000',
  remaining: '900000',
  remainingCount: 9,
  tags: [],
  references: [],
  ...over,
})

describe('cuota progress in the month', () => {
  it('says how much the plan has billed so far and how much is left', async () => {
    await render(<CuotaProgress m={cuota({})} />)
    await expect.element(page.getByText(/Cuota 3 de 12 · llevas/)).toBeVisible()
    await expect.element(page.getByText(formatCLP('300000'))).toBeVisible()
    await expect.element(page.getByText(formatCLP('900000'))).toBeVisible()
    await expect.element(page.getByText(/\(9 cuotas\)/)).toBeVisible()
  })

  it('marks the last cuota', async () => {
    await render(<CuotaProgress m={cuota({ number: 12, soFar: '1200000', remaining: '0', remainingCount: 0 })} />)
    await expect.element(page.getByText(/última cuota/)).toBeVisible()
  })

  it('shows nothing for a one-payment expense', async () => {
    const { container } = await render(<CuotaProgress m={cuota({ total: 1, number: 1, soFar: null, remaining: null })} />)
    expect(container.textContent).toBe('')
  })
})
