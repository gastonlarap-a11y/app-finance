import { describe, expect, it } from 'vitest'
import { SECTION_SHORTCUTS } from '@/lib/shortcuts'
import { NAV_GROUPS, PAGES, routeTo, shortcutOf } from './nav'

describe('sidebar model', () => {
  const inSidebar = NAV_GROUPS.flatMap((g) => g.pages)

  it('lists every main page exactly once', () => {
    expect([...inSidebar].sort()).toEqual(Object.keys(PAGES).sort())
  })

  it('numbers the ⌘ shortcuts in sidebar order', () => {
    expect(inSidebar.map(shortcutOf)).toEqual(inSidebar.map((_, i) => i + 1))
    expect(SECTION_SHORTCUTS.map((r) => r.page)).toEqual(inSidebar)
  })

  it('opens each page on its default view', () => {
    expect(routeTo('importar')).toEqual({ page: 'importar', tab: 'bandeja' })
    expect(routeTo('buscar')).toEqual({ page: 'buscar', q: '' })
    expect(routeTo('resumen')).toEqual({ page: 'resumen' })
  })
})
