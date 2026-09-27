import { useSyncExternalStore } from 'react'

// Theme preference: per device (localStorage), never in the DB — it is UI state,
// not finance data, so it needs no binding and no Go⇄TS parity.
// public/theme-init.js applies it before the first paint; this module keeps it
// applied afterwards (OS appearance changes, other tabs, the Apariencia
// setting). THEME_STORAGE_KEY and THEME_LIGHT_ENABLED are mirrored in
// public/theme-init.js; theme.test.ts keeps both in sync.

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'app-finance:theme'

// The light theme stays off until every view uses the semantic tokens
// (src/styles/rawclasses.test.ts at zero): 'system' resolves to dark meanwhile.
// An explicit 'light' saved by hand still applies, to preview the migration.
export const THEME_LIGHT_ENABLED = false

// The canvas token of each theme in sRGB, for the browser/OS chrome.
const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#f9fafd', dark: '#0b0f18' }

export function parseThemeMode(raw: string | null | undefined): ThemeMode {
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean, lightEnabled = THEME_LIGHT_ENABLED): ResolvedTheme {
  if (mode !== 'system') return mode
  return systemDark || !lightEnabled ? 'dark' : 'light'
}

function readStoredMode(): ThemeMode {
  try {
    return parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'system' // storage blocked (private mode, sandboxed webview): follow the OS
  }
}

function systemPrefersDark(): MediaQueryList {
  return window.matchMedia('(prefers-color-scheme: dark)')
}

function applyTheme(mode: ThemeMode): void {
  const resolved = resolveTheme(mode, systemPrefersDark().matches)
  document.documentElement.dataset.theme = resolved
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved])
}

const listeners = new Set<() => void>()
let current: ThemeMode | null = null

function currentMode(): ThemeMode {
  current ??= readStoredMode()
  return current
}

function changeMode(mode: ThemeMode): void {
  current = mode
  applyTheme(mode)
  listeners.forEach((notify) => notify())
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    if (mode === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
    else localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // Not persisted: the choice still applies for this session.
  }
  changeMode(mode)
}

// startThemeSync keeps the theme applied after the first paint: OS appearance
// changes (for 'system') and a choice made in another tab. Call once at startup.
export function startThemeSync(): void {
  applyTheme(currentMode())
  systemPrefersDark().addEventListener('change', () => applyTheme(currentMode()))
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_STORAGE_KEY) changeMode(parseThemeMode(e.newValue))
  })
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, currentMode)
}
