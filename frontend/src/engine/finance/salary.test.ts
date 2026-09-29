// Mirror of backend/finance/salary_test.go: same scenarios, same numbers.
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '@/engine/testing/db'
import { createFinanceService } from '@/engine/finance/service'
import { createSession } from '@/engine/users/service'
import type { FinanceServiceContract, MonthlySummary } from '@/services/contract'

let finance: FinanceServiceContract

beforeEach(async () => {
  const db = await createTestDb()
  finance = createFinanceService(db, createSession(db))
})

function ok<T extends { error?: unknown }>(r: T): T {
  expect(r.error).toBeUndefined()
  return r
}

async function monthly(period: string): Promise<MonthlySummary> {
  return ok(await finance.MonthlySummary(period)).data!
}

describe('sueldo base', () => {
  it('se espera cada mes, el confirmado manda, y llega a todas las vistas', async () => {
    ok(await finance.SetBaseSalary('2030-01', '1000000'))
    expect(await monthly('2030-03')).toMatchObject({ salary: '1000000', salaryExpected: true })
    expect(ok(await finance.GetSalary('2030-03')).data).toMatchObject({ amount: '1000000', expected: true })
    expect((await monthly('2029-12')).salary).toBe('0')

    ok(await finance.SetSalary('2030-03', '1050000'))
    expect(await monthly('2030-03')).toMatchObject({ salary: '1050000', salaryExpected: false })
    expect((await monthly('2030-04')).acumulado).toBe('3050000')

    ok(await finance.EndBaseSalary('2030-05'))
    expect((await monthly('2030-05')).salary).toBe('0')
    expect(ok(await finance.YearSummary(2030)).data!.totalIngresos).toBe('4050000')
    const fc = ok(await finance.CommitmentsForecast('2030-04', 2)).data!
    expect(fc[0]).toMatchObject({ ingresos: '1000000', ingresoEstimado: true })
    expect(fc[1]!.ingresos).toBe('0')

    ok(await finance.SetBaseSalary('2030-07', '1200000'))
    expect((await monthly('2030-06')).salary).toBe('0')
    expect((await monthly('2030-07')).salary).toBe('1200000')
    expect(ok(await finance.GetBaseSalary('2030-08')).data).toEqual({ effectiveFrom: '2030-07', amount: '1200000' })
    expect(ok(await finance.GetBaseSalary('2030-06')).data).toBeUndefined()

    ok(await finance.DeleteSalary('2030-03'))
    expect(await monthly('2030-03')).toMatchObject({ salary: '1000000', salaryExpected: true })
    expect((await finance.DeleteSalary('2030-03')).error?.code).toBe('NOT_FOUND')
  })

  it('llega a la cuenta del sueldo y el «resto del sueldo» lo pasa', async () => {
    const chile = ok(await finance.CreateAccount('Banco de Chile', 'corriente', '0', '2030-01', true)).data!
    const itau = ok(await finance.CreateAccount('Itaú', 'corriente', '0', '2030-01', false)).data!
    ok(await finance.CreateTransfer(chile.id, itau.id, 'Sueldo a Itaú', 'salary_rest', '470000', '2030-01', true))
    ok(await finance.SetBaseSalary('2030-01', '2300000'))
    const c = ok(await finance.ListAccounts('2030-01')).data!.accounts.find((a) => a.name === 'Banco de Chile')!
    expect([c.ingresos, c.transferOut, c.balance]).toEqual(['2300000', '1830000', '470000'])
  })

  it('valida', async () => {
    for (const [period, amount] of [
      ['2030-13', '1000'],
      ['2030-01', '0'],
      ['2030-01', '-5'],
    ] as const) {
      expect((await finance.SetBaseSalary(period, amount)).error?.code).toBe('VALIDATION_ERROR')
    }
    expect((await finance.EndBaseSalary('2030-01')).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.GetBaseSalary('2030-1')).error?.code).toBe('VALIDATION_ERROR')
    expect((await finance.DeleteSalary('2030-01')).error?.code).toBe('NOT_FOUND')
  })
})
