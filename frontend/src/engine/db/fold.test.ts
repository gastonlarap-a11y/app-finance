// Mirror of backend/shared/db/fold_test.go.
import { describe, expect, it } from 'vitest'
import { foldText } from '@/engine/db/fold'

describe('foldText', () => {
  it.each([
    ['Café', 'cafe'],
    ['ÑUÑOA', 'nunoa'],
    ['Árbol ÉXITO pingüino', 'arbol exito pinguino'],
    ['100%_off', '100%_off'],
    ['', ''],
  ])('%s → %s', (input, want) => {
    expect(foldText(input)).toBe(want)
  })
})
