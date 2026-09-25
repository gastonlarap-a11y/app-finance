import { describe, expect, it } from 'vitest'
import { formatThousands, parseThousands } from '@/lib/format'

describe('formatThousands', () => {
  it.each([
    ['', ''],
    ['0', '0'],
    ['1500', '1.500'],
    ['1234567', '1.234.567'],
    ['0012', '12'],
    // Past 2^53: exact digits, where Number() used to round.
    ['12345678901234567', '12.345.678.901.234.567'],
    // A stored decimal is rounded to whole pesos, not read as more thousands.
    ['15000.5', '15.001'],
    ['15000.4', '15.000'],
    ['999.9', '1.000'],
  ])('%s → %s', (value, want) => {
    expect(formatThousands(value)).toBe(want)
  })
})

describe('parseThousands', () => {
  it.each([
    ['', ''],
    ['1.234.567', '1234567'],
    ['1500', '1500'],
    // es-CL decimals round to whole pesos (it used to give 123450).
    ['1.234,50', '1235'],
    ['1.234,49', '1234'],
    ['9.999,9', '10000'],
    ['1.234,', '1234'],
    ['$ 15.000', '15000'],
    // Amounts are never negative here; the sign is dropped.
    ['-5.000', '5000'],
  ])('%s → %s', (typed, want) => {
    expect(parseThousands(typed)).toBe(want)
  })

  it('lo que se muestra vuelve a leerse igual', () => {
    for (const v of ['1', '999', '1000', '1234567', '12345678901234567']) {
      expect(parseThousands(formatThousands(v))).toBe(v)
    }
  })
})
