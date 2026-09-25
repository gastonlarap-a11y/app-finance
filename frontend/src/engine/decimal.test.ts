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
  it('acepta la misma gramática que shopspring', () => {
    for (const [input, want] of [
      ['+15', '15'],
      ['12.50', '12.5'],
      ['5.', '5'],
      ['.5', '0.5'],
      ['-.5', '-0.5'],
      ['1e3', '1000'],
      ['1.5E+2', '150'],
    ] as const) {
      expect(Money.fromString(input).toString()).toBe(want)
    }
  })
  it('rechaza lo que decimal.js acepta pero Go no', () => {
    for (const input of ['NaN', 'Infinity', '-Infinity', '0x10', '0b11', '0o7', '', '.', '1e', '1 000', ' 5']) {
      expect(() => Money.fromString(input), input).toThrow()
    }
  })
  it('lee -0 como 0, igual que Go', () => {
    const m = Money.fromString('-0')
    expect(m.isNegative()).toBe(false)
    expect(m.toString()).toBe('0')
  })
})

describe('parseAmount', () => {
  it('acepta montos válidos con espacios', () => {
    expect(parseAmount(' 15000 ')?.toString()).toBe('15000')
  })
  it('rechaza negativos e inválidos', () => {
    expect(parseAmount('-5')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount('NaN')).toBeNull()
  })
  it('acepta -0 como 0 (Go no lo trata como negativo)', () => {
    expect(parseAmount('-0')?.toString()).toBe('0')
  })
})
