import { describe, expect, it } from 'vitest'
import { fuzzyMatch } from './fuzzy'

describe('fuzzyMatch', () => {
  it('matches anything with an empty query', () => {
    expect(fuzzyMatch('  ', 'Resumen')).toEqual({ score: 0, indices: [] })
  })

  it('ignores case and accents, keeping positions of the original text', () => {
    expect(fuzzyMatch('ano', 'Año')?.indices).toEqual([0, 1, 2])
    expect(fuzzyMatch('CONFIG', 'Configuración')?.indices).toEqual([0, 1, 2, 3, 4, 5])
    expect(fuzzyMatch('proyeccion', 'Proyección')).not.toBeNull()
  })

  it('ranks prefix > word start > inside > scattered letters', () => {
    const prefix = fuzzyMatch('fij', 'Fijos')!.score
    const wordStart = fuzzyMatch('fij', 'Gastos fijos')!.score
    const inside = fuzzyMatch('ijo', 'Gastos fijos')!.score
    const scattered = fuzzyMatch('gsf', 'Gastos fijos')!.score
    expect(prefix).toBeGreaterThan(wordStart)
    expect(wordStart).toBeGreaterThan(inside)
    expect(inside).toBeGreaterThan(scattered)
  })

  it('finds a word start and reports where', () => {
    expect(fuzzyMatch('fij', 'Gastos fijos')?.indices).toEqual([7, 8, 9])
  })

  it('matches letters in order across words, and rejects the wrong order', () => {
    expect(fuzzyMatch('nvg', 'Nuevo gasto')?.indices).toEqual([0, 3, 6])
    expect(fuzzyMatch('gvn', 'Nuevo gasto')).toBeNull()
  })

  it('prefers the tighter of two scattered matches', () => {
    expect(fuzzyMatch('ab', 'a-b')!.score).toBeGreaterThan(fuzzyMatch('ab', 'a------b')!.score)
  })
})
