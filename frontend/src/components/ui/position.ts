// placeFloating positions a floating layer (menu, toggletip) next to its
// trigger, in viewport coordinates for `position: fixed`. CSS anchor
// positioning is not available on the WebKit this app supports (Safari 17.6 on
// macOS 12), so the math lives here, pure and tested.

export type Box = { top: number; left: number; right: number; bottom: number }
export type Size = { width: number; height: number }
export type Align = 'start' | 'end'
export type Placement = { top: number; left: number; side: 'below' | 'above' }

const GAP = 4 // between trigger and layer
const MARGIN = 8 // kept free at the viewport edges

export function placeFloating(anchor: Box, layer: Size, viewport: Size, align: Align = 'start'): Placement {
  const below = anchor.bottom + GAP
  const above = anchor.top - GAP - layer.height
  const fitsBelow = below + layer.height <= viewport.height - MARGIN
  const fitsAbove = above >= MARGIN
  const roomBelow = viewport.height - anchor.bottom
  const side = fitsBelow || (!fitsAbove && roomBelow >= anchor.top) ? 'below' : 'above'
  const top = clamp(side === 'below' ? below : above, MARGIN, viewport.height - MARGIN - layer.height)

  const preferred = align === 'start' ? anchor.left : anchor.right - layer.width
  const left = clamp(preferred, MARGIN, viewport.width - MARGIN - layer.width)
  return { top: Math.round(top), left: Math.round(left), side }
}

// clamp keeps value in [min, max]; a layer larger than the viewport pins to min.
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}
