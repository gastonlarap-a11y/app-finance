import { useEffect, useId, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { Search } from 'lucide-react'
import { paletteOpenAtom, periodAtom, quickAddAtom } from '@/atoms/finance'
import { useInvalidate } from '@/atoms/refresh'
import { currentPeriod, shiftPeriod } from '@/lib/format'
import { IS_APPLE, IS_WEB } from '@/lib/platform'
import { setThemeMode } from '@/lib/theme'
import { navigate } from '@/lib/useRoute'
import { AVAILABLE_SECTIONS } from '../config/sections'
import { useProfileActions, useProfiles } from '../shell/profiles'
import { requestBackup } from '../shell/backupNow'
import { buildCommands, rankCommands, searchCommand, type CommandContext, type RankedCommand } from './commands'
import { INITIAL_PALETTE, paletteReducer, pushRecent, readRecent, saveRecent } from './state'

// CommandPaletteHost mounts the palette while it is open (⌘K / Ctrl+K, or the
// sidebar's "Ir a…"), like QuickAddHost does for the new-expense dialog.
export function CommandPaletteHost() {
  const [open, setOpen] = useAtom(paletteOpenAtom)
  if (!open) return null
  return <CommandPalette onClose={() => setOpen(false)} />
}

// useCommandContext wires the catalog to the app's real actions.
function useCommandContext(): CommandContext {
  const setPeriod = useSetAtom(periodAtom)
  const setQuickAdd = useSetAtom(quickAddAtom)
  const invalidate = useInvalidate()
  const { users, active } = useProfiles()
  const { switchTo } = useProfileActions()
  return {
    apple: IS_APPLE,
    web: IS_WEB,
    sections: AVAILABLE_SECTIONS,
    profiles: users,
    activeProfileId: active?.id ?? null,
    actions: {
      navigate,
      quickAdd: () => setQuickAdd(true),
      shiftPeriod: (step) => setPeriod((p) => shiftPeriod(p, step)),
      thisMonth: () => setPeriod(currentPeriod()),
      setTheme: setThemeMode,
      switchProfile: (id) => void switchTo(id),
      backup: () => void requestBackup().then(() => invalidate('settings')),
    },
  }
}

// Highlight draws the matched letters of a title.
function Highlight({ text, indices }: { text: string; indices: readonly number[] }) {
  if (indices.length === 0) return <>{text}</>
  const hit = new Set(indices)
  return (
    <>
      {Array.from(text).map((ch, i) =>
        hit.has(i) ? (
          // Keyed by position: a title's characters never reorder.
          <mark key={i} className="bg-transparent font-semibold text-accent-fg">
            {ch}
          </mark>
        ) : (
          ch
        ),
      )}
    </>
  )
}

// CommandPalette: a native <dialog> (focus trap, Escape, inert page) around an
// ARIA 1.2 combobox — focus stays in the input while the arrows move the
// active option (aria-activedescendant), Enter runs it.
function CommandPalette({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const [state, dispatch] = useReducer(paletteReducer, INITIAL_PALETTE)
  const [recent, setRecent] = useState(readRecent)
  const ctx = useCommandContext()

  const ranked = rankCommands(buildCommands(ctx), state.query, recent)
  const results: RankedCommand[] =
    state.query.trim() === '' ? ranked : [...ranked, { command: searchCommand(state.query, ctx.actions.navigate), indices: [] }]
  const active = Math.min(state.active, Math.max(results.length - 1, 0))
  const optionId = (i: number) => `${id}-opt-${i}`

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    dialog.querySelector('input')?.focus()
    return () => dialog.close()
  }, [])

  useEffect(() => {
    listRef.current?.querySelector(`[id="${optionId(active)}"]`)?.scrollIntoView({ block: 'nearest' })
  })

  function run(r: RankedCommand) {
    if (r.command.id !== 'search') {
      const next = pushRecent(recent, r.command.id)
      setRecent(next)
      saveRecent(next)
    }
    // Close first: an action may open another dialog (a new expense).
    onClose()
    r.command.run()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const count = results.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      dispatch({ type: 'move', delta: e.key === 'ArrowDown' ? 1 : -1, count })
    } else if ((e.key === 'Home' || e.key === 'End') && e.ctrlKey) {
      e.preventDefault()
      dispatch({ type: 'edge', to: e.key === 'Home' ? 'first' : 'last', count })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = results[active]
      if (r) run(r)
    }
  }

  // Consecutive results of the same group share one labeled group.
  const groups: { label: string; items: { r: RankedCommand; index: number }[] }[] = []
  results.forEach((r, index) => {
    const last = groups.at(-1)
    if (last && last.label === r.command.group) last.items.push({ r, index })
    else groups.push({ label: r.command.group, items: [{ r, index }] })
  })

  return (
    // Tapping outside the box (on the dialog's backdrop area) closes it;
    // keyboard users have Escape.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={ref}
      aria-label="Paleta de comandos"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-xl bg-raised p-0 text-fg shadow-2xl ring-1 ring-line backdrop:bg-scrim"
    >
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={results.length > 0 ? optionId(active) : undefined}
          aria-label="Buscar pantallas, acciones o gastos"
          placeholder="Pantalla, acción o gasto…"
          value={state.query}
          onChange={(e) => dispatch({ type: 'type', query: e.target.value })}
          onKeyDown={onKeyDown}
          className="h-12 min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-subtle"
        />
      </div>
      <div ref={listRef} id={`${id}-list`} role="listbox" aria-label="Resultados" className="max-h-[min(60vh,28rem)] overflow-y-auto p-2">
        {results.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-fg-muted">Nada coincide con «{state.query}».</p>
        ) : (
          groups.map((g, gi) => (
            <div key={`${g.label}-${gi}`} role="group" aria-labelledby={`${id}-g${gi}`} className="py-1">
              <div id={`${id}-g${gi}`} role="presentation" className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
                {g.label}
              </div>
              {g.items.map(({ r, index }) => {
                const Icon = r.command.icon
                const selected = index === active
                return (
                  // Options are chosen from the input (aria-activedescendant); the
                  // pointer path is mouse move + click, like a native listbox.
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                  <div
                    key={r.command.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    onMouseMove={() => !selected && dispatch({ type: 'point', index })}
                    onClick={() => run(r)}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm pointer-coarse:min-h-11 ${
                      selected ? 'bg-accent-soft text-fg' : 'text-fg'
                    }`}
                  >
                    <Icon aria-hidden="true" className={`size-4 shrink-0 ${selected ? 'text-accent-fg' : 'text-fg-muted'}`} />
                    <span className="min-w-0 flex-1 truncate">
                      <Highlight text={r.command.title} indices={r.indices} />
                    </span>
                    {r.command.shortcut && (
                      <kbd className="rounded bg-sunken px-1.5 py-0.5 font-sans text-[11px] text-fg-muted ring-1 ring-inset ring-line">
                        {r.command.shortcut}
                      </kbd>
                    )}
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
      <p aria-hidden="true" className="border-t border-line px-4 py-2 text-[11px] text-fg-subtle pointer-coarse:hidden">
        ↑ ↓ para moverte · Enter para abrir · Esc para cerrar
      </p>
    </dialog>
  )
}
