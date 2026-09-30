import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { ImportItemView } from '@/services/contract'
import { ImportInboxView } from './ImportInboxView'

const item = (over: Partial<ImportItemView>): ImportItemView => ({
  id: 1,
  userId: 1,
  source: 'csv',
  issuer: 'itaú csv',
  date: '2026-09-15',
  description: 'TRANSFERENCIA A MERCADOPAGO',
  amount: '50000',
  currency: 'CLP',
  cardLastDigits: '',
  installmentsTotal: 1,
  hint: '',
  status: 'pendiente',
  reference: '',
  expenseId: null,
  matchedItemId: null,
  createdAt: '',
  kind: 'gasto',
  statementLineId: null,
  installmentNumber: 1,
  installmentAmount: '',
  firstPeriod: '',
  incomeId: null,
  fixedExpenseId: null,
  fixedPeriod: '',
  refundId: null,
  transferId: null,
  transferPeriod: '',
  cardId: null,
  cardName: '',
  rulePattern: '',
  suggestedMerchant: '',
  suggestedCategory: '',
  suggestedPattern: '',
  duplicateExpenseId: null,
  duplicateDescription: '',
  duplicateDate: '',
  matchedSource: '',
  matchedDate: '',
  suggestedAmountClp: '',
  suggestedFixedId: null,
  suggestedFixedDescription: '',
  suggestedFixedPeriod: '',
  suggestedRefundExpenseId: null,
  suggestedRefundDescription: '',
  suggestedTransferId: null,
  suggestedTransferDescription: '',
  suggestedTransferPeriod: '',
  duplicateItemId: null,
  duplicateItemSource: '',
  duplicateItemStatus: '',
  duplicateItemDescription: '',
  reopenable: false,
  ...over,
})

const state = vi.hoisted(() => ({
  items: [] as ImportItemView[],
  calls: [] as unknown[][],
}))

vi.mock('@/services/finance', () => ({
  KIND_CUOTAS: 'cuotas',
  KIND_UNICO: 'unico',
  FinanceService: {
    ListImportItems: () => Promise.resolve({ data: state.items }),
    ListCards: () => Promise.resolve([]),
    ListCategories: () => Promise.resolve([]),
    ListMerchants: () => Promise.resolve([]),
    ListMerchantRules: () => Promise.resolve([]),
    LinkImportItemToTransfer: (...args: unknown[]) => {
      state.calls.push(['LinkImportItemToTransfer', ...args])
      return Promise.resolve({})
    },
    DiscardImportItem: (...args: unknown[]) => {
      state.calls.push(['DiscardImportItem', ...args])
      return Promise.resolve({})
    },
  },
}))

beforeEach(() => {
  state.items = []
  state.calls = []
})

describe('inbox suggestions for transfers and duplicates', () => {
  it('links a movement to the transfer it looks like', async () => {
    state.items = [item({ suggestedTransferId: 5, suggestedTransferDescription: 'Carga Mercado Pago', suggestedTransferPeriod: '2026-09' })]
    await render(<ImportInboxView tab="bandeja" />)
    await expect.element(page.getByText(/¿Es tu transferencia «Carga Mercado Pago»/)).toBeVisible()
    await page.getByRole('button', { name: 'Sí, es esa transferencia' }).click()
    await expect.poll(() => state.calls).toEqual([['LinkImportItemToTransfer', 1, 5, '2026-09']])
  })

  it('discards a movement already imported from another format', async () => {
    state.items = [
      item({
        id: 7,
        description: 'Compra Panaderia La Espiga',
        duplicateItemId: 3,
        duplicateItemSource: 'pdf_account',
        duplicateItemStatus: 'confirmado',
        duplicateItemDescription: 'COMPRA PANADERIA LA ESPIGA',
      }),
    ]
    await render(<ImportInboxView tab="bandeja" />)
    await expect.element(page.getByText(/ya importaste desde cartola \(«COMPRA PANADERIA LA ESPIGA», confirmado\)/)).toBeVisible()
    await page.getByRole('button', { name: 'Sí, descartar este' }).click()
    await expect.poll(() => state.calls).toEqual([['DiscardImportItem', 7]])
  })
})
