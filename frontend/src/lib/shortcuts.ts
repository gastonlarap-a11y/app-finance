import type { Route } from '@/lib/route'

// Keyboard shortcuts, resolved by a pure function so the rules are tested
// apart from the DOM. One listener in the shell (useAppShortcuts) applies them.
//   ⌘1…⌘7 / Ctrl+1…7  main sections, in sidebar order
//   ⌘, / Ctrl+,        Configuración (the platform's "Settings" shortcut)
//   N                   new expense
//   ← / →               previous / next month (or year) on screens with a period
// None fires inside an open dialog (it would drop a half-filled form), and the
// plain keys never fire while typing.

export type ShortcutAction = { kind: 'navigate'; route: Route } | { kind: 'period'; step: -1 | 1 } | { kind: 'quick-add' }

export type KeyInput = {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

export type ShortcutContext = {
  apple: boolean // ⌘ on Apple keyboards, Ctrl elsewhere
  typing: boolean
  dialogOpen: boolean
  periodNav: boolean // the current screen shows the month/year navigator
}

// Sidebar order; ⌘1 is the first.
export const SECTION_SHORTCUTS: readonly Route[] = [
  { page: 'resumen' },
  { page: 'importar', tab: 'bandeja' },
  { page: 'buscar', q: '' },
  { page: 'anio' },
  { page: 'proyeccion' },
  { page: 'fijos' },
  { page: 'ahorro' },
]

export function resolveShortcut(e: KeyInput, ctx: ShortcutContext): ShortcutAction | null {
  if (e.isComposing || ctx.dialogOpen) return null
  const command = ctx.apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (command) {
    if (e.altKey || e.shiftKey) return null
    if (e.key === ',') return { kind: 'navigate', route: { page: 'config', section: null } }
    const route = /^[1-9]$/.test(e.key) ? SECTION_SHORTCUTS[Number(e.key) - 1] : undefined
    return route ? { kind: 'navigate', route } : null
  }
  if (e.metaKey || e.ctrlKey || e.altKey || ctx.typing) return null
  if (e.key === 'n' && !e.shiftKey) return { kind: 'quick-add' }
  if (ctx.periodNav && e.key === 'ArrowLeft') return { kind: 'period', step: -1 }
  if (ctx.periodNav && e.key === 'ArrowRight') return { kind: 'period', step: 1 }
  return null
}

// isTyping: plain-key shortcuts must never steal keys from a form field.
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}
