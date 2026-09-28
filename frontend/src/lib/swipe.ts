// Horizontal swipe to change the month (or year) on touch screens, decided by
// a pure classifier so the thresholds are tested apart from pointer events.
// A swipe to the left shows the next period, like turning a page.

export type SwipeSample = {
  dx: number // px, end − start (negative = finger moved left)
  dy: number
  ms: number // gesture duration
  startX: number // px from the viewport's left edge where it began
}

export const SWIPE = {
  minDistance: 64, // px of horizontal travel
  axisRatio: 1.5, // |dx| must beat |dy| by this much: a scroll that drifts is not a swipe
  maxMs: 600, // a slow drag still counts if it is fast enough on average…
  minVelocity: 0.3, // …at this many px/ms
  edgeGuard: 24, // iOS's own "back" gesture starts at the left edge
} as const

export function classifySwipe(s: SwipeSample): -1 | 1 | null {
  if (s.startX < SWIPE.edgeGuard) return null
  const ax = Math.abs(s.dx)
  if (ax < SWIPE.minDistance || ax <= SWIPE.axisRatio * Math.abs(s.dy)) return null
  const quick = s.ms < SWIPE.maxMs || ax / Math.max(s.ms, 1) >= SWIPE.minVelocity
  if (!quick) return null
  return s.dx < 0 ? 1 : -1
}

// swipeIgnored: gestures that start on a control, inside a dialog, on content
// that scrolls sideways (tables keep their own pan) or on anything marked
// data-no-swipe never change the period.
export function swipeIgnored(target: EventTarget | null, root: Element): boolean {
  if (!(target instanceof Element)) return true
  if (target.closest('input, textarea, select, [contenteditable="true"], dialog, [data-no-swipe]')) return true
  for (let el: Element | null = target; el && el !== root; el = el.parentElement) {
    const overflowX = getComputedStyle(el).overflowX
    if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth) return true
  }
  return false
}
