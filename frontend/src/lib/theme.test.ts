import { describe, expect, it } from 'vitest'
import initScript from '../../public/theme-init.js?raw'
import { THEME_STORAGE_KEY, parseThemeMode, resolveTheme } from './theme'

describe('parseThemeMode', () => {
  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', 'system'],
    [null, 'system'],
    [undefined, 'system'],
    ['', 'system'],
    ['Dark', 'system'],
    ['sepia', 'system'],
  ] as const)('%s → %s', (raw, want) => {
    expect(parseThemeMode(raw)).toBe(want)
  })
})

describe('resolveTheme', () => {
  it.each([
    // mode, system dark, resolved
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['system', false, 'light'],
    ['system', true, 'dark'],
  ] as const)('%s (systemDark=%s) → %s', (mode, systemDark, want) => {
    expect(resolveTheme(mode, systemDark)).toBe(want)
  })
})

describe('public/theme-init.js', () => {
  it('uses the same storage key and resolution as lib/theme.ts', () => {
    expect(initScript).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`)
    expect(initScript).toContain(`mode === 'dark' || (mode === 'system' && systemDark)`)
  })
})
