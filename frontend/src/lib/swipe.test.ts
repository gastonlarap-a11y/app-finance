import { describe, expect, it } from 'vitest'
import { classifySwipe, type SwipeSample } from './swipe'

const swipe = (s: Partial<SwipeSample>): SwipeSample => ({ dx: -120, dy: 10, ms: 250, startX: 300, ...s })

describe('classifySwipe', () => {
  it('left shows the next period, right the previous one', () => {
    expect(classifySwipe(swipe({ dx: -120 }))).toBe(1)
    expect(classifySwipe(swipe({ dx: 120 }))).toBe(-1)
  })

  it('needs enough horizontal travel', () => {
    expect(classifySwipe(swipe({ dx: -63 }))).toBeNull()
    expect(classifySwipe(swipe({ dx: -64, dy: 0 }))).toBe(1)
  })

  it('ignores a mostly vertical gesture (a scroll that drifts)', () => {
    expect(classifySwipe(swipe({ dx: -120, dy: 80 }))).toBeNull()
    expect(classifySwipe(swipe({ dx: -121, dy: 80 }))).toBe(1)
  })

  it('ignores a slow drag, unless it moved far enough for its duration', () => {
    expect(classifySwipe(swipe({ dx: -120, ms: 900 }))).toBeNull()
    expect(classifySwipe(swipe({ dx: -300, ms: 900 }))).toBe(1)
  })

  it('leaves the left edge to the system back gesture', () => {
    expect(classifySwipe(swipe({ dx: 150, startX: 10 }))).toBeNull()
    expect(classifySwipe(swipe({ dx: 150, startX: 24 }))).toBe(-1)
  })
})
