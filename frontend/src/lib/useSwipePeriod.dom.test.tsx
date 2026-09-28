import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useSwipePeriod } from './useSwipePeriod'

function Area({ onStep }: { onStep: (step: -1 | 1) => void }) {
  const swipe = useSwipePeriod(onStep)
  return (
    <div {...swipe} data-testid="area" className="touch-pan-y" style={{ width: 600, height: 300, position: 'relative' }}>
      <p data-testid="text">Resumen</p>
      <input data-testid="field" aria-label="Monto" />
      <div data-testid="scroller" style={{ width: 200, overflowX: 'auto' }}>
        <div style={{ width: 800 }}>tabla ancha</div>
      </div>
    </div>
  )
}

type Pointer = { type: string; x: number; y?: number; pointerType?: string; id?: number }

function fire(el: Element, { type, x, y = 100, pointerType = 'touch', id = 1 }: Pointer) {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, pointerId: id, pointerType, clientX: x, clientY: y }))
}

function gesture(el: Element, from: number, to: number, pointerType = 'touch') {
  fire(el, { type: 'pointerdown', x: from, pointerType })
  fire(el, { type: 'pointerup', x: to, pointerType })
}

async function setup() {
  const onStep = vi.fn()
  const screen = await render(<Area onStep={onStep} />)
  const el = (id: string) => screen.getByTestId(id).element()
  return { onStep, el }
}

describe('useSwipePeriod', () => {
  it('a left swipe asks for the next period, a right one for the previous', async () => {
    const { onStep, el } = await setup()
    gesture(el('text'), 400, 250)
    expect(onStep).toHaveBeenLastCalledWith(1)
    gesture(el('text'), 250, 400)
    expect(onStep).toHaveBeenLastCalledWith(-1)
  })

  it('ignores the mouse', async () => {
    const { onStep, el } = await setup()
    gesture(el('text'), 400, 250, 'mouse')
    expect(onStep).not.toHaveBeenCalled()
  })

  it('leaves sideways-scrolling content and form fields alone', async () => {
    const { onStep, el } = await setup()
    gesture(el('scroller'), 400, 250)
    gesture(el('field'), 400, 250)
    expect(onStep).not.toHaveBeenCalled()
  })

  it('does nothing when the browser takes over the gesture (pointercancel)', async () => {
    const { onStep, el } = await setup()
    fire(el('text'), { type: 'pointerdown', x: 400 })
    fire(el('text'), { type: 'pointercancel', x: 300 })
    fire(el('text'), { type: 'pointerup', x: 250 })
    expect(onStep).not.toHaveBeenCalled()
  })

  it('ignores a short or vertical move', async () => {
    const { onStep, el } = await setup()
    gesture(el('text'), 400, 360)
    fire(el('text'), { type: 'pointerdown', x: 400, y: 50 })
    fire(el('text'), { type: 'pointerup', x: 300, y: 250 })
    expect(onStep).not.toHaveBeenCalled()
  })
})
