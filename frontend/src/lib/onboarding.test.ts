import { describe, expect, it } from 'vitest'
import { dismissKey, onboardingDone, onboardingSteps, type OnboardingFacts } from './onboarding'

const fresh: OnboardingFacts = {
  cardsOrAccounts: 0,
  categories: 0,
  incomeThisMonth: false,
  anyExpense: false,
  openingBalance: false,
  backupOn: false,
}

describe('onboardingSteps', () => {
  it('a new profile has every step pending, in order', () => {
    const steps = onboardingSteps(fresh, false)
    expect(steps.map((s) => s.id)).toEqual(['tarjeta', 'categorias', 'ingreso', 'gasto', 'saldo', 'respaldo'])
    expect(steps.every((s) => !s.done)).toBe(true)
    expect(onboardingDone(steps)).toBe(false)
  })

  it('marks each step from its fact', () => {
    const steps = onboardingSteps({ ...fresh, cardsOrAccounts: 1, anyExpense: true }, false)
    expect(steps.filter((s) => s.done).map((s) => s.id)).toEqual(['tarjeta', 'gasto'])
  })

  it('is done without the optional opening-balance and backup steps', () => {
    const steps = onboardingSteps({ ...fresh, cardsOrAccounts: 2, categories: 5, incomeThisMonth: true, anyExpense: true }, false)
    expect(steps.filter((s) => s.optional).map((s) => s.id)).toEqual(['saldo', 'respaldo'])
    expect(onboardingDone(steps)).toBe(true)
  })

  it('the opening-balance step opens the Saldo inicial dialog until one is recorded', () => {
    const saldo = (f: OnboardingFacts) => onboardingSteps(f, false).find((s) => s.id === 'saldo')
    expect(saldo(fresh)?.actions.map((a) => a.kind)).toEqual(['opening-balance'])
    expect(saldo({ ...fresh, openingBalance: true })?.done).toBe(true)
  })

  it('words the backup step for each platform', () => {
    expect(onboardingSteps(fresh, true).find((s) => s.id === 'respaldo')?.title).toBe('Exporta un respaldo')
    expect(onboardingSteps(fresh, false).find((s) => s.id === 'respaldo')?.title).toBe('Activa el respaldo')
  })

  it('the first-expense step offers both paths', () => {
    const gasto = onboardingSteps(fresh, false).find((s) => s.id === 'gasto')
    expect(gasto?.actions.map((a) => a.kind)).toEqual(['quick-add', 'route'])
  })

  it('remembers the dismissal per profile', () => {
    expect(dismissKey(3)).not.toBe(dismissKey(4))
  })
})
