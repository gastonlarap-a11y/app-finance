import { describe, expect, it } from 'vitest'
import { greaterThan, isNegative, maxAbs, pctChange, ratio, times } from '@/lib/money'
import { formatCLP } from '@/lib/format'

describe('money helpers', () => {
  it('compara decimales exactos sin pasar por float', () => {
    // 2^53 + 1 vs 2^53: indistinguishable as JS numbers.
    expect(greaterThan('9007199254740993', '9007199254740992')).toBe(true)
    expect(isNegative('-0.01')).toBe(true)
    expect(isNegative('0')).toBe(false)
  })

  it('ratio queda en [0, 1] y tolera total cero', () => {
    expect(ratio('50', '200')).toBe(0.25)
    expect(ratio('300', '200')).toBe(1)
    expect(ratio('-50', '200')).toBe(0.25)
    expect(ratio('10', '0')).toBe(0)
  })

  it('pctChange redondea y no divide por cero', () => {
    expect(pctChange('118', '100')).toBe(18)
    expect(pctChange('95', '100')).toBe(-5)
    expect(pctChange('1', '3')).toBe(-67)
    expect(pctChange('10', '0')).toBeNull()
  })

  it('maxAbs y times', () => {
    expect(maxAbs(['10', '-300', '200'])).toBe('300')
    expect(maxAbs([])).toBe('0')
    expect(times('20000', 3)).toBe('60000')
  })

  it('formatCLP formatea el string sin perder precisión', () => {
    expect(formatCLP('150000')).toBe('$150.000')
    expect(formatCLP('-2500')).toMatch(/2\.500/)
    expect(formatCLP('9007199254740993')).toContain('9.007.199.254.740.993')
    expect(formatCLP('no-es-numero')).toBe('$0')
  })
})
