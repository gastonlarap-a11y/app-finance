import { describe, expect, it, vi } from 'vitest'
import { CreditCard, Palette } from 'lucide-react'
import { buildCommands, rankCommands, searchCommand, type CommandActions, type CommandContext } from './commands'
import { INITIAL_PALETTE, paletteReducer, pushRecent } from './state'

function context(overrides: Partial<CommandContext> = {}): CommandContext & { actions: { [K in keyof CommandActions]: ReturnType<typeof vi.fn> } } {
  const actions = {
    navigate: vi.fn(),
    quickAdd: vi.fn(),
    shiftPeriod: vi.fn(),
    thisMonth: vi.fn(),
    setTheme: vi.fn(),
    switchProfile: vi.fn(),
    backup: vi.fn(),
  }
  return {
    apple: true,
    web: false,
    sections: [
      { id: 'tarjetas', label: 'Tarjetas', icon: CreditCard },
      { id: 'apariencia', label: 'Apariencia', icon: Palette },
    ],
    profiles: [
      { id: 1, name: 'Gastón' },
      { id: 2, name: 'Camila' },
    ],
    activeProfileId: 1,
    ...overrides,
    actions,
  }
}

const titles = (ctx: CommandContext, query: string, recent: string[] = []) =>
  rankCommands(buildCommands(ctx), query, recent).map((r) => r.command.title)

describe('buildCommands', () => {
  it('offers every screen with its shortcut, and the platform backup', () => {
    const cmds = buildCommands(context())
    expect(cmds.find((c) => c.id === 'go:resumen')).toMatchObject({ title: 'Resumen', shortcut: '⌘1' })
    expect(cmds.find((c) => c.id === 'go:ahorro')?.shortcut).toBe('⌘7')
    expect(cmds.find((c) => c.id === 'backup')?.title).toBe('Respaldar ahora')
    expect(buildCommands(context({ web: true, apple: false })).find((c) => c.id === 'backup')?.title).toBe('Exportar datos')
    expect(buildCommands(context({ apple: false })).find((c) => c.id === 'go:config')?.shortcut).toBe('Ctrl+,')
  })

  it('lists only the other profiles', () => {
    const profiles = buildCommands(context()).filter((c) => c.group === 'Perfiles')
    expect(profiles.map((c) => c.title)).toEqual(['Cambiar al perfil «Camila»'])
  })

  it('runs the injected actions', () => {
    const ctx = context()
    const byId = new Map(buildCommands(ctx).map((c) => [c.id, c]))
    byId.get('config:apariencia')?.run()
    expect(ctx.actions.navigate).toHaveBeenCalledWith({ page: 'config', section: 'apariencia' })
    byId.get('profile:2')?.run()
    expect(ctx.actions.switchProfile).toHaveBeenCalledWith(2)
    byId.get('theme:dark')?.run()
    expect(ctx.actions.setTheme).toHaveBeenCalledWith('dark')
    byId.get('period:prev')?.run()
    expect(ctx.actions.shiftPeriod).toHaveBeenCalledWith(-1)
    byId.get('go:importar:estados')?.run()
    expect(ctx.actions.navigate).toHaveBeenCalledWith({ page: 'importar', tab: 'estados' })
    byId.get('backup')?.run()
    expect(ctx.actions.backup).toHaveBeenCalled()
  })

  it('on the web, "Exportar datos" opens Respaldo instead of exporting blind', () => {
    const ctx = context({ web: true })
    buildCommands(ctx)
      .find((c) => c.id === 'backup')
      ?.run()
    expect(ctx.actions.backup).not.toHaveBeenCalled()
    expect(ctx.actions.navigate).toHaveBeenCalledWith({ page: 'config', section: 'respaldo' })
  })

  it('searchCommand opens Buscar with the text', () => {
    const navigate = vi.fn()
    const cmd = searchCommand('  jumbo ', navigate)
    expect(cmd.title).toBe('Buscar gastos: «jumbo»')
    cmd.run()
    expect(navigate).toHaveBeenCalledWith({ page: 'buscar', q: 'jumbo' })
  })
})

describe('rankCommands', () => {
  it('without a query: recents first (relabeled), then the rest by group', () => {
    const ranked = rankCommands(buildCommands(context()), '', ['theme:dark', 'gone'])
    expect(ranked[0]?.command).toMatchObject({ id: 'theme:dark', group: 'Recientes' })
    expect(ranked.filter((r) => r.command.id === 'theme:dark')).toHaveLength(1)
    expect(ranked[1]?.command.group).toBe('Acciones')
  })

  it('with a query: the best title match first, accents ignored', () => {
    expect(titles(context(), 'proyeccion')[0]).toBe('Proyección')
    expect(titles(context(), 'ano')[0]).toBe('Año')
    expect(titles(context(), 'config')[0]).toBe('Configuración')
  })

  it('answers to keywords, below a direct title match', () => {
    const found = titles(context(), 'respaldo')
    expect(found).toContain('Respaldar ahora')
    expect(titles(context(), 'noche')[0]).toBe('Tema oscuro')
  })

  it('returns nothing for text that matches no command', () => {
    expect(titles(context(), 'zzzz')).toEqual([])
  })
})

describe('paletteReducer', () => {
  it('typing resets to the first result', () => {
    expect(paletteReducer({ query: 'a', active: 3 }, { type: 'type', query: 'ab' })).toEqual({ query: 'ab', active: 0 })
  })

  it('arrows wrap and Home/End jump', () => {
    const s = { ...INITIAL_PALETTE, active: 0 }
    expect(paletteReducer(s, { type: 'move', delta: -1, count: 4 }).active).toBe(3)
    expect(paletteReducer({ ...s, active: 3 }, { type: 'move', delta: 1, count: 4 }).active).toBe(0)
    expect(paletteReducer(s, { type: 'edge', to: 'last', count: 4 }).active).toBe(3)
    expect(paletteReducer(s, { type: 'move', delta: 1, count: 0 })).toBe(s)
  })

  it('recents keep the latest first, without duplicates, up to five', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    expect(pushRecent(['a', 'b', 'c', 'd', 'e'], 'f')).toEqual(['f', 'a', 'b', 'c', 'd'])
  })
})
