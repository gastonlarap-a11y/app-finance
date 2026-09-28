import { useId, useState } from 'react'
import { Search } from 'lucide-react'
import { COLORS, ICONS, type ColorKey, type IconKey, type Look } from '@/lib/look'
import { inputCls } from './form'

const ICON_BOX = { sm: 'size-6', md: 'size-8', lg: 'size-10' } as const
const ICON_GLYPH = { sm: 'size-3.5', md: 'size-4', lg: 'size-5' } as const

// LookIcon is a row's icon on its tinted chip (category, goal). Decorative:
// the name always sits next to it.
export function LookIcon({ look, size = 'md' }: { look: Look; size?: keyof typeof ICON_BOX }) {
  const Icon = ICONS[look.icon].icon
  return (
    <span
      data-look={look.color}
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full bg-(--look-soft) text-(--look) ${ICON_BOX[size]}`}
    >
      <Icon className={ICON_GLYPH[size]} />
    </span>
  )
}

// ColorDot marks a card's color next to its name.
export function ColorDot({ color }: { color: ColorKey }) {
  return <span data-look={color} aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-full bg-(--look)" />
}

// Radio options are native inputs (arrow keys and grouping for free), drawn by
// the span after them; the peer-focus ring stands in for the hidden input's.
const focusRing = 'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus'

// ColorPicker chooses a color key ('' = automatic, previewed as `auto`; a row
// not created yet has no automatic color to preview, so it shows neutral).
export function ColorPicker({ value, onChange, auto }: { value: string; onChange: (key: string) => void; auto?: ColorKey }) {
  const name = useId()
  const options: { key: string; swatch: ColorKey | undefined; label: string }[] = [
    { key: '', swatch: auto, label: 'Automático' },
    ...(Object.keys(COLORS) as ColorKey[]).map((c) => ({ key: c, swatch: c, label: COLORS[c] })),
  ]
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-fg-muted">Color</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <label key={o.key || 'auto'} className="relative cursor-pointer">
            <input
              type="radio"
              name={name}
              className="peer sr-only"
              checked={value === o.key}
              onChange={() => onChange(o.key)}
            />
            <span
              data-look={o.swatch}
              aria-hidden="true"
              className={`flex size-8 items-center justify-center rounded-full text-[10px] font-bold ring-offset-2 ring-offset-panel peer-checked:ring-2 peer-checked:ring-fg pointer-coarse:size-11 ${
                o.swatch ? 'bg-(--look) text-panel' : 'bg-sunken text-fg-muted ring-1 ring-inset ring-line-input'
              } ${focusRing}`}
            >
              {o.key === '' && 'A'}
            </span>
            <span className="sr-only">{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

// IconPicker chooses an icon key ('' = automatic, previewed as `auto`), drawn
// in `color` so the choice looks as it will in the lists.
export function IconPicker({
  value,
  onChange,
  auto,
  color,
}: {
  value: string
  onChange: (key: string) => void
  auto: IconKey
  color: ColorKey
}) {
  const name = useId()
  const [filter, setFilter] = useState('')
  const q = normalize(filter.trim())
  const keys = (Object.keys(ICONS) as IconKey[]).filter((k) => q === '' || normalize(ICONS[k].label).includes(q) || k.includes(q))
  const options: { key: string; icon: IconKey; label: string }[] = [
    ...(q === '' ? [{ key: '', icon: auto, label: `Automático (${ICONS[auto].label})` }] : []),
    ...keys.map((k) => ({ key: k, icon: k, label: ICONS[k].label })),
  ]
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-fg-muted">Ícono</legend>
      <div className="relative mb-2">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
        <input
          type="search"
          aria-label="Buscar ícono"
          placeholder="Buscar ícono…"
          className={`${inputCls} pl-9`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {options.length === 0 ? (
        <p className="py-2 text-sm text-fg-subtle">Ningún ícono coincide.</p>
      ) : (
        <div data-look={color} className="grid max-h-48 grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1 overflow-y-auto p-1">
          {options.map((o) => {
            const Icon = ICONS[o.icon].icon
            return (
              <label key={o.key || 'auto'} className="relative cursor-pointer">
                <input
                  type="radio"
                  name={name}
                  className="peer sr-only"
                  checked={value === o.key}
                  onChange={() => onChange(o.key)}
                />
                <span
                  className={`relative flex h-11 items-center justify-center rounded-lg text-fg-muted hover:bg-sunken peer-checked:bg-(--look-soft) peer-checked:text-(--look) peer-checked:ring-2 peer-checked:ring-(--look) ${focusRing}`}
                >
                  <Icon aria-hidden="true" className="size-5" />
                  {o.key === '' && (
                    <span aria-hidden="true" className="absolute bottom-0.5 right-1 text-[9px] font-bold">
                      A
                    </span>
                  )}
                </span>
                <span className="sr-only">{o.label}</span>
              </label>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}
