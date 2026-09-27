import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type ToggleEvent } from 'react'
import { Ellipsis, Info, type LucideIcon } from 'lucide-react'
import { placeFloating, type Align } from './position'

// Floating layers use the native Popover API (popover="auto"): top layer (also
// above a modal <dialog>), light dismiss, Escape to close and focus back to the
// trigger come from the browser. The layer is shown from the click handler and
// placed in the same task, so it never paints at the wrong spot.
function useAnchoredPopover(align: Align) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  function place(layer: HTMLDivElement) {
    const trigger = triggerRef.current
    if (!trigger) return
    const p = placeFloating(
      trigger.getBoundingClientRect(),
      { width: layer.offsetWidth, height: layer.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      align,
    )
    layer.style.top = `${p.top}px`
    layer.style.left = `${p.left}px`
  }

  // show opens the layer (if closed) and returns it, placed.
  function show(): HTMLDivElement | null {
    const layer = layerRef.current
    if (!layer) return null
    if (!layer.matches(':popover-open')) layer.showPopover()
    place(layer)
    return layer
  }

  function toggle(): HTMLDivElement | null {
    const layer = layerRef.current
    if (layer?.matches(':popover-open')) {
      layer.hidePopover()
      return null
    }
    return show()
  }

  function onToggle(e: ToggleEvent<HTMLDivElement>) {
    setOpen(e.newState === 'open')
  }

  return { triggerRef, layerRef, open, show, toggle, onToggle }
}

const layerCls = 'fixed inset-auto m-0 rounded-lg border-0 bg-raised p-1 text-fg shadow-lg ring-1 ring-line'

export type MenuAction = {
  label: string
  icon?: LucideIcon
  onSelect: () => void
  tone?: 'default' | 'danger'
  disabled?: boolean
}

// Menu is a menu button (WAI-ARIA APG): the trigger opens a list of actions;
// arrows move between them, Enter/Space runs one, Tab or Escape closes it.
// Without `trigger` it renders an icon-only "⋯" button named by `label`.
export function Menu({
  label,
  items,
  align = 'end',
  icon: TriggerIcon = Ellipsis,
  trigger,
  triggerClassName = 'text-fg-muted hover:bg-sunken hover:text-fg',
}: {
  label: string
  items: readonly MenuAction[]
  align?: Align
  icon?: LucideIcon
  // Visible trigger content (a name, an avatar…); `label` stays its accessible name.
  trigger?: ReactNode
  triggerClassName?: string
}) {
  const menuId = useId()
  const { triggerRef, layerRef, open, show, toggle, onToggle } = useAnchoredPopover(align)

  function itemButtons(layer: HTMLElement): HTMLButtonElement[] {
    return Array.from(layer.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
  }

  function openAndFocus(which: 'first' | 'last') {
    const layer = show()
    if (!layer) return
    const buttons = itemButtons(layer)
    ;(which === 'first' ? buttons[0] : buttons.at(-1))?.focus()
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      openAndFocus(e.key === 'ArrowDown' ? 'first' : 'last')
    }
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const layer = layerRef.current
    if (!layer) return
    if (e.key === 'Tab') {
      layer.hidePopover()
      return
    }
    const buttons = itemButtons(layer)
    const current = buttons.findIndex((b) => b === document.activeElement)
    const moves: Record<string, number> = {
      ArrowDown: (current + 1) % buttons.length,
      ArrowUp: (current - 1 + buttons.length) % buttons.length,
      Home: 0,
      End: buttons.length - 1,
    }
    const next = moves[e.key]
    if (next === undefined) return
    e.preventDefault()
    buttons[next]?.focus()
  }

  function select(item: MenuAction) {
    layerRef.current?.hidePopover()
    item.onSelect()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={trigger ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          const layer = toggle()
          if (layer) itemButtons(layer)[0]?.focus()
        }}
        onKeyDown={onTriggerKeyDown}
        className={`inline-flex shrink-0 items-center gap-2 rounded-md transition-colors pointer-coarse:min-w-11 ${
          trigger ? 'px-2 py-1' : 'size-8 justify-center'
        } ${triggerClassName}`}
      >
        {trigger ?? <TriggerIcon aria-hidden="true" className="size-4" />}
      </button>
      <div
        ref={layerRef}
        id={menuId}
        popover="auto"
        role="menu"
        tabIndex={-1}
        aria-label={label}
        onToggle={onToggle}
        onKeyDown={onMenuKeyDown}
        className={`${layerCls} min-w-48`}
      >
        {items.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => select(item)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-sunken focus-visible:bg-sunken disabled:cursor-not-allowed disabled:opacity-50 ${
                item.tone === 'danger' ? 'text-negative-fg' : 'text-fg'
              }`}
            >
              {Icon && <Icon aria-hidden="true" className="size-4 shrink-0" />}
              {item.label}
            </button>
          )
        })}
      </div>
    </>
  )
}

// Toggletip reveals a short explanation on click or tap — unlike a `title`
// tooltip, it works on touch screens and with a keyboard.
export function Toggletip({ label = 'Más información', children }: { label?: string; children: ReactNode }) {
  const tipId = useId()
  const { triggerRef, layerRef, open, toggle, onToggle } = useAnchoredPopover('start')
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={tipId}
        onClick={() => {
          toggle()
        }}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full align-middle text-fg-subtle transition-colors hover:text-fg pointer-coarse:size-11"
      >
        <Info aria-hidden="true" className="size-4" />
      </button>
      <div ref={layerRef} id={tipId} popover="auto" onToggle={onToggle} className={`${layerCls} max-w-xs px-3 py-2 text-sm`}>
        {children}
      </div>
    </>
  )
}
