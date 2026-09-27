import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export type ChoiceOption<T extends string> = {
  value: T
  label: string
  icon?: LucideIcon
  // Extra content after the label (e.g. a count Badge).
  badge?: ReactNode
}

// nextIndex implements the arrow-key model shared by radiogroups and tablists:
// arrows move and wrap, Home/End jump to the ends. null = not a navigation key.
function nextIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % count
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

// useRovingChoice selects and focuses the option an arrow key lands on, so the
// group is a single Tab stop (WAI-ARIA radio group / tabs with automatic activation).
function useRovingChoice<T extends string>(options: readonly ChoiceOption<T>[], value: T, onChange: (v: T) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const current = options.findIndex((o) => o.value === value)
    const next = nextIndex(e.key, Math.max(current, 0), options.length)
    if (next === null) return
    e.preventDefault()
    const option = options[next]
    if (!option) return
    onChange(option.value)
    refs.current[next]?.focus()
  }
  return { refs, onKeyDown }
}

function OptionContent({ option }: { option: ChoiceOption<string> }) {
  const Icon = option.icon
  return (
    <>
      {Icon && <Icon aria-hidden="true" className="size-4 shrink-0" />}
      {option.label}
      {option.badge}
    </>
  )
}

const segmentCls = (selected: boolean) =>
  `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
    selected ? 'bg-panel text-fg shadow-xs ring-1 ring-line' : 'text-fg-muted hover:text-fg'
  }`

// SegmentedControl picks one of a few mutually exclusive values (a filter, a
// horizon). It is a radiogroup: one Tab stop, arrows change the value.
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly ChoiceOption<T>[]
  onChange: (value: T) => void
}) {
  const { refs, onKeyDown } = useRovingChoice(options, value, onChange)
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-lg bg-sunken p-1 ring-1 ring-inset ring-line">
      {options.map((o, i) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={onKeyDown}
            className={segmentCls(selected)}
          >
            <OptionContent option={o} />
          </button>
        )
      })}
    </div>
  )
}

export const tabId = (idBase: string, value: string) => `${idBase}-tab-${value}`
export const tabPanelId = (idBase: string) => `${idBase}-panel`

// Tabs switches between panels of one view. Pair it with <TabPanel> using the
// same idBase; the panel is labelled by the selected tab.
export function Tabs<T extends string>({
  label,
  idBase,
  value,
  tabs,
  onChange,
}: {
  label: string
  idBase: string
  value: T
  tabs: readonly ChoiceOption<T>[]
  onChange: (value: T) => void
}) {
  const { refs, onKeyDown } = useRovingChoice(tabs, value, onChange)
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 border-b border-line">
      {tabs.map((t, i) => {
        const selected = t.value === value
        return (
          <button
            key={t.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            id={tabId(idBase, t.value)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={tabPanelId(idBase)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.value)}
            onKeyDown={onKeyDown}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              selected ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg'
            }`}
          >
            <OptionContent option={t} />
          </button>
        )
      })}
    </div>
  )
}

export function TabPanel({ idBase, value, children }: { idBase: string; value: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={tabPanelId(idBase)} aria-labelledby={tabId(idBase, value)} className="pt-4">
      {children}
    </div>
  )
}
