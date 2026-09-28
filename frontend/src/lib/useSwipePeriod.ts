import { useRef, type PointerEvent } from 'react'
import { classifySwipe, swipeIgnored } from './swipe'

type Start = { id: number; x: number; y: number; t: number }

// useSwipePeriod returns pointer handlers that turn a horizontal touch swipe
// into onStep(±1). Touch only (a mouse drag selects text); the element should
// allow vertical panning only (touch-pan-y) so the browser leaves horizontal
// moves to us — a pan it does take over arrives as pointercancel.
export function useSwipePeriod(onStep: (step: -1 | 1) => void) {
  const start = useRef<Start | null>(null)
  return {
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (e.pointerType !== 'touch' || !e.isPrimary || swipeIgnored(e.target, e.currentTarget)) {
        start.current = null
        return
      }
      start.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp }
    },
    onPointerUp(e: PointerEvent<HTMLElement>) {
      const s = start.current
      start.current = null
      if (!s || s.id !== e.pointerId) return
      const step = classifySwipe({ dx: e.clientX - s.x, dy: e.clientY - s.y, ms: e.timeStamp - s.t, startX: s.x })
      if (step) onStep(step)
    },
    onPointerCancel() {
      start.current = null
    },
  }
}
