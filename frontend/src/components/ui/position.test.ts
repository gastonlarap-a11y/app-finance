import { describe, expect, it } from 'vitest'
import { placeFloating, type Box } from './position'

const viewport = { width: 1000, height: 800 }
const layer = { width: 200, height: 150 }
const at = (top: number, left: number, width = 40, height = 32): Box => ({ top, left, right: left + width, bottom: top + height })

describe('placeFloating', () => {
  it('opens below the trigger, aligned to its start edge', () => {
    expect(placeFloating(at(100, 300), layer, viewport)).toEqual({ top: 136, left: 300, side: 'below' })
  })

  it('aligns the layer end with the trigger end', () => {
    expect(placeFloating(at(100, 300), layer, viewport, 'end')).toEqual({ top: 136, left: 140, side: 'below' })
  })

  it('flips above when there is no room below', () => {
    expect(placeFloating(at(700, 300), layer, viewport)).toEqual({ top: 546, left: 300, side: 'above' })
  })

  it('keeps the layer inside the right edge', () => {
    expect(placeFloating(at(100, 950), layer, viewport).left).toBe(1000 - 8 - 200)
  })

  it('keeps the layer inside the left edge when end-aligned near it', () => {
    expect(placeFloating(at(100, 10), layer, viewport, 'end').left).toBe(8)
  })

  it('uses the roomier side and clamps when it fits on neither', () => {
    const tall = { width: 200, height: 500 }
    const nearTop = placeFloating(at(350, 300), tall, viewport)
    expect(nearTop.side).toBe('below')
    expect(nearTop.top).toBe(800 - 8 - 500)
    const nearBottom = placeFloating(at(560, 300), tall, viewport)
    expect(nearBottom.side).toBe('above')
    expect(nearBottom.top).toBe(56)
  })

  it('pins a layer taller than the viewport to the top margin', () => {
    expect(placeFloating(at(300, 300), { width: 200, height: 900 }, viewport).top).toBe(8)
  })
})
