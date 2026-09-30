import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { ImportBatch } from '@/services/contract'
import { parseCsv } from '@/lib/statements/csv'
import { CsvImportDialog } from './CsvImport'

const state = vi.hoisted(() => ({ staged: [] as ImportBatch[] }))

vi.mock('@/services/finance', () => ({
  FinanceService: {
    StageImport: (batch: ImportBatch) => {
      state.staged.push(batch)
      return Promise.resolve({ data: { added: batch.items.length, duplicates: 0, reconciled: 0 } })
    },
  },
}))

beforeEach(() => {
  state.staged = []
})

const open = (csv: string) =>
  render(<CsvImportDialog fileName="cartola.csv" rows={parseCsv(csv)} onClose={() => {}} onImported={() => {}} />)

describe('CsvImportDialog', () => {
  it('reads a US-locale export as such: month first, commas grouping thousands', async () => {
    await open('Fecha;Detalle;Monto\n9/5/2026;UBER;-1,234\n9/25/2026;NETFLIX;-8,990')
    await expect.element(page.getByRole('combobox', { name: 'Fechas' })).toHaveValue('mdy')
    await expect.element(page.getByRole('combobox', { name: 'Números' })).toHaveValue('us')
    await expect.element(page.getByText('Por sus valores')).not.toBeInTheDocument()
    await userEvent.fill(page.getByRole('textbox', { name: 'Banco' }), 'Banco X')
    await page.getByRole('button', { name: 'Enviar 2 a la bandeja' }).click()
    await expect.poll(() => state.staged[0]?.items.map((i) => [i.date, i.amount])).toEqual([
      ['2026-09-05', '1234'],
      ['2026-09-25', '8990'],
    ])
  })

  it('asks to check the preview when the values read both ways, and a pick overrides', async () => {
    await open('Fecha;Detalle;Monto\n05/09/2026;UBER;-8500')
    await expect.element(page.getByText(/Por sus valores/)).toBeVisible()
    await page.getByRole('combobox', { name: 'Fechas' }).selectOptions('mdy')
    await expect.element(page.getByText(/Por sus valores/)).not.toBeInTheDocument()
    await userEvent.fill(page.getByRole('textbox', { name: 'Banco' }), 'Banco X')
    await page.getByRole('button', { name: 'Enviar 1 a la bandeja' }).click()
    await expect.poll(() => state.staged[0]?.items[0]?.date).toBe('2026-05-09')
  })
})
