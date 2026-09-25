// Web-engine counterpart of backend/finance/bench_test.go: the same kind of
// multi-year history, to measure what grows with the data on sqlite-wasm.
// Opt-in (seeding takes a while): BENCH=1 npx vitest run src/engine/finance/summaries.perf.test.ts
import { describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import { blankStatement, statementLine as line } from '@/engine/testing/cardStatement'
import type { FinanceServiceContract } from '@/services/contract'

const YEARS = 3
const FIRST = 2027 - YEARS

async function seed(): Promise<FinanceServiceContract> {
  const db = await createTestDb()
  const f = createFinanceService(db, createSession(db))
  const card = (await f.CreateCard('Visa', '5000000', 24, '4321')).data!
  for (let i = 0; i < 8; i++) await f.CreateFixedExpense(`Fijo ${i}`, 'Servicios', null, `${FIRST}-01`, '25000')
  for (let y = FIRST; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      const period = `${y}-${String(m).padStart(2, '0')}`
      await f.SetSalary(period, '2500000')
      await f.CreateIncome(period, 'Extra', '100000')
      for (let d = 0; d < 40; d++) {
        const date = `${period}-${String((d % 28) + 1).padStart(2, '0')}`
        await f.CreateExpense(date, `Gasto ${d}`, `Cat ${d % 10}`, '', card.id, 'unico', '15000', 1)
      }
      for (let c = 0; c < 4; c++) {
        await f.CreateExpense(`${period}-0${c + 5}`, `Cuotas ${c}`, 'Tecnología', '', card.id, 'cuotas', '50000', 12)
      }
      await f.ImportCardStatement({
        ...blankStatement,
        issuer: 'itau', kind: 'nacional', currency: 'CLP', cardLastDigits: '4321',
        statementDate: `${period}-25`, periodTo: `${period}-25`, totalBilled: '2340',
        lines: [line({ section: 'compra', operationDate: `${period}-12`, reference: period, description: 'TAXI',
          operationAmount: '2340', installmentAmount: '2340' })],
      })
    }
  }
  await f.StageImport({
    source: 'pdf_account',
    issuer: 'Itau',
    items: Array.from({ length: 200 }, (_, i) => ({
      date: `2026-12-${String((i % 28) + 1).padStart(2, '0')}`, description: `COMERCIO ${i}`, amount: String(1000 + i),
      currency: '', cardLastDigits: '', account: '', reference: '', installmentsTotal: 0, hint: '',
    })),
  })
  return f
}

// msPerCall averages `runs` calls after one warm-up.
async function msPerCall(runs: number, call: () => Promise<{ error?: unknown }>): Promise<number> {
  expect((await call()).error).toBeUndefined()
  const start = performance.now()
  for (let i = 0; i < runs; i++) await call()
  return (performance.now() - start) / runs
}

// vitest runs in Node, but the app's tsconfig carries no Node types: read the
// opt-in flag through a structural cast of globalThis.process.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

describe.runIf(env.BENCH)(`web engine, ${YEARS} years of history`, () => {
  it('reports ms per call', { timeout: 600_000 }, async () => {
    const finance = await seed()
    const report = {
      MonthlySummary: await msPerCall(10, () => finance.MonthlySummary('2026-12')),
      ListImportItems: await msPerCall(10, () => finance.ListImportItems('pendiente')),
      ListCardStatements: await msPerCall(3, () => finance.ListCardStatements('')),
    }
    console.log(Object.entries(report).map(([k, v]) => `${k}: ${v.toFixed(1)} ms`).join(' | '))
  })
})
