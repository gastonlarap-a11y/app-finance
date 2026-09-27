import { describe, expect, it } from 'vitest'
import initScript from '../../public/theme-init.js?raw'
import { THEME_LIGHT_ENABLED, THEME_STORAGE_KEY, parseThemeMode, resolveTheme } from './theme'

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
    // mode, system dark, light enabled, resolved
    ['light', false, true, 'light'],
    ['light', true, true, 'light'],
    ['dark', false, true, 'dark'],
    ['system', false, true, 'light'],
    ['system', true, true, 'dark'],
    // Light theme gated off: 'system' stays dark, explicit choices still apply.
    ['system', false, false, 'dark'],
    ['light', false, false, 'light'],
  ] as const)('%s (systemDark=%s, lightEnabled=%s) → %s', (mode, systemDark, lightEnabled, want) => {
    expect(resolveTheme(mode, systemDark, lightEnabled)).toBe(want)
  })
})

describe('public/theme-init.js', () => {
  it('uses the same storage key and light-theme gate as lib/theme.ts', () => {
    expect(initScript).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`)
    expect(initScript).toContain(`var LIGHT_ENABLED = ${THEME_LIGHT_ENABLED}`)
  })
})
