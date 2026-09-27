import { describe, expect, it } from 'vitest'
import { resolveShortcut, type KeyInput, type ShortcutContext } from './shortcuts'

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})
const mac: ShortcutContext = { apple: true, typing: false, dialogOpen: false, periodNav: true }
const pc: ShortcutContext = { ...mac, apple: false }

describe('resolveShortcut', () => {
  it('jumps to sections with ⌘ on Apple keyboards and Ctrl elsewhere', () => {
    expect(resolveShortcut(key('1', { metaKey: true }), mac)).toEqual({ kind: 'navigate', route: { page: 'resumen' } })
    expect(resolveShortcut(key('2', { ctrlKey: true }), pc)).toEqual({ kind: 'navigate', route: { page: 'importar', tab: 'bandeja' } })
    expect(resolveShortcut(key('7', { metaKey: true }), mac)).toEqual({ kind: 'navigate', route: { page: 'ahorro' } })
    expect(resolveShortcut(key('8', { metaKey: true }), mac)).toBeNull()
    // The other platform's modifier does nothing.
    expect(resolveShortcut(key('1', { ctrlKey: true }), mac)).toBeNull()
    expect(resolveShortcut(key('1', { metaKey: true }), pc)).toBeNull()
  })

  it('opens Configuración with ⌘, / Ctrl+,', () => {
    expect(resolveShortcut(key(',', { metaKey: true }), mac)).toEqual({ kind: 'navigate', route: { page: 'config', section: null } })
    expect(resolveShortcut(key(',', { ctrlKey: true }), pc)).toEqual({ kind: 'navigate', route: { page: 'config', section: null } })
    expect(resolveShortcut(key(',', { metaKey: true, shiftKey: true }), mac)).toBeNull()
  })

  it('moves the period with the arrows only where the navigator shows', () => {
    expect(resolveShortcut(key('ArrowLeft'), mac)).toEqual({ kind: 'period', step: -1 })
    expect(resolveShortcut(key('ArrowRight'), mac)).toEqual({ kind: 'period', step: 1 })
    expect(resolveShortcut(key('ArrowRight'), { ...mac, periodNav: false })).toBeNull()
    expect(resolveShortcut(key('ArrowRight', { altKey: true }), mac)).toBeNull()
  })

  it('opens a new expense with N', () => {
    expect(resolveShortcut(key('n'), mac)).toEqual({ kind: 'quick-add' })
    expect(resolveShortcut(key('N', { shiftKey: true }), mac)).toBeNull()
    expect(resolveShortcut(key('n', { metaKey: true }), mac)).toBeNull()
  })

  it('leaves plain keys to form fields', () => {
    const typing = { ...mac, typing: true }
    expect(resolveShortcut(key('n'), typing)).toBeNull()
    expect(resolveShortcut(key('ArrowLeft'), typing)).toBeNull()
    // Command shortcuts still work from a field…
    expect(resolveShortcut(key('3', { metaKey: true }), typing)).toEqual({ kind: 'navigate', route: { page: 'buscar', q: '' } })
  })

  it('does nothing inside a dialog or while composing text', () => {
    expect(resolveShortcut(key('1', { metaKey: true }), { ...mac, dialogOpen: true })).toBeNull()
    expect(resolveShortcut(key('n'), { ...mac, dialogOpen: true })).toBeNull()
    expect(resolveShortcut(key('n', { isComposing: true }), mac)).toBeNull()
  })
})
