import { describe, expect, it } from 'vitest'
import { Money, parseAmount } from '@/engine/decimal'

describe('Money', () => {
  it('round-trips the TEXT values Go writes (CLP integers)', () => {
    for (const v of ['0', '150000', '1234567890123', '-45000']) {
      expect(Money.fromString(v).toString()).toBe(v)
    }
  })
  it('suma y resta sin pérdida de precisión', () => {
    const a = Money.fromString('999999999999999999')
    const b = Money.fromString('1')
    expect(a.add(b).toString()).toBe('1000000000000000000')
    expect(a.sub(a).toString()).toBe('0')
  })
  it('gte y cmp', () => {
    expect(Money.fromString('10').gte(Money.fromString('10'))).toBe(true)
    expect(Money.fromString('9').gte(Money.fromString('10'))).toBe(false)
    expect(Money.fromString('20').cmp(Money.fromString('10'))).toBeGreaterThan(0)
  })
  it('zero e isNegative', () => {
    expect(Money.zero().isZero()).toBe(true)
    expect(Money.fromString('-1').isNegative()).toBe(true)
  })
})

describe('parseAmount', () => {
  it('acepta montos válidos con espacios', () => {
    expect(parseAmount(' 15000 ')?.toString()).toBe('15000')
  })
  it('rechaza negativos e inválidos', () => {
    expect(parseAmount('-5')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
  })
})
