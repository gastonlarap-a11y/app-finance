// The palette's UI state as a pure reducer: the typed query and which result
// is active (aria-activedescendant). Typing resets to the first result; the
// arrows wrap around, Home/End jump to the ends.

export type PaletteState = { query: string; active: number }

export type PaletteAction =
  | { type: 'type'; query: string }
  | { type: 'move'; delta: 1 | -1; count: number }
  | { type: 'edge'; to: 'first' | 'last'; count: number }
  | { type: 'point'; index: number }

export const INITIAL_PALETTE: PaletteState = { query: '', active: 0 }

export function paletteReducer(state: PaletteState, action: PaletteAction): PaletteState {
  switch (action.type) {
    case 'type':
      return { query: action.query, active: 0 }
    case 'move':
      if (action.count === 0) return state
      return { ...state, active: (state.active + action.delta + action.count) % action.count }
    case 'edge':
      return { ...state, active: action.to === 'first' || action.count === 0 ? 0 : action.count - 1 }
    case 'point':
      return { ...state, active: action.index }
  }
}

// Recently run commands, most recent first, per device (a convenience: lost
// storage just means no recents).
const RECENT_KEY = 'app-finance:palette-recent'
const MAX_RECENT = 5

export function readRecent(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

export function pushRecent(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, MAX_RECENT)
}

export function saveRecent(recent: readonly string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
  } catch {
    // Storage blocked: recents are a convenience only.
  }
}
