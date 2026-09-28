import {
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  Download,
  FileUp,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import type { ConfigSection, Route } from '@/lib/route'
import { fuzzyMatch } from '@/lib/fuzzy'
import type { ThemeMode } from '@/lib/theme'
import { NAV_GROUPS, PAGES, routeTo, shortcutOf } from '../shell/nav'

// The command palette's catalog, built by a pure function from what the app
// can do right now (platform, profiles, Configuración sections), so it is
// tested without a DOM. `run` closes over the actions the shell injects.

export type CommandGroup = 'Recientes' | 'Ir a' | 'Acciones' | 'Configuración' | 'Perfiles' | 'Buscar'

export interface Command {
  id: string
  title: string
  group: CommandGroup
  icon: LucideIcon
  keywords?: readonly string[] // extra words it answers to (synonyms)
  shortcut?: string // shown, not bound: the shell owns the keys
  run: () => void
}

export interface CommandActions {
  navigate: (route: Route) => void
  quickAdd: () => void
  shiftPeriod: (step: -1 | 1) => void
  thisMonth: () => void
  setTheme: (mode: ThemeMode) => void
  switchProfile: (id: number) => void
  backup: () => void // desktop: back up now (Drive when connected)
}

export interface CommandContext {
  apple: boolean
  web: boolean
  sections: readonly { id: ConfigSection; label: string; icon: LucideIcon }[]
  profiles: readonly { id: number; name: string }[]
  activeProfileId: number | null
  actions: CommandActions
}

export function buildCommands(ctx: CommandContext): Command[] {
  const mod = ctx.apple ? '⌘' : 'Ctrl+'
  const { actions } = ctx
  const pages: Command[] = NAV_GROUPS.flatMap((g) => g.pages).map((page) => ({
    id: `go:${page}`,
    title: PAGES[page].label,
    group: 'Ir a',
    icon: PAGES[page].icon,
    shortcut: `${mod}${shortcutOf(page)}`,
    run: () => actions.navigate(routeTo(page)),
  }))
  const statements: Command = {
    id: 'go:importar:estados',
    title: 'Estados de cuenta',
    group: 'Ir a',
    icon: FileUp,
    keywords: ['importar', 'cartola', 'pdf', 'tarjeta'],
    run: () => actions.navigate({ page: 'importar', tab: 'estados' }),
  }
  const config: Command[] = [
    {
      id: 'go:config',
      title: 'Configuración',
      group: 'Configuración',
      icon: Settings,
      keywords: ['ajustes', 'preferencias'],
      shortcut: `${mod},`,
      run: () => actions.navigate({ page: 'config', section: null }),
    },
    ...ctx.sections.map(
      (s): Command => ({
        id: `config:${s.id}`,
        title: s.label,
        group: 'Configuración',
        icon: s.icon,
        run: () => actions.navigate({ page: 'config', section: s.id }),
      }),
    ),
  ]
  const period: Command[] = [
    { id: 'period:prev', title: 'Mes anterior', group: 'Acciones', icon: ChevronLeft, shortcut: '←', run: () => actions.shiftPeriod(-1) },
    { id: 'period:next', title: 'Mes siguiente', group: 'Acciones', icon: ChevronRight, shortcut: '→', run: () => actions.shiftPeriod(1) },
    { id: 'period:now', title: 'Ir al mes actual', group: 'Acciones', icon: CalendarCheck, keywords: ['hoy'], run: () => actions.thisMonth() },
  ]
  const themes: Command[] = [
    { id: 'theme:light', title: 'Tema claro', group: 'Acciones', icon: Sun, keywords: ['apariencia'], run: () => actions.setTheme('light') },
    { id: 'theme:dark', title: 'Tema oscuro', group: 'Acciones', icon: Moon, keywords: ['apariencia', 'noche'], run: () => actions.setTheme('dark') },
    {
      id: 'theme:system',
      title: 'Tema del sistema',
      group: 'Acciones',
      icon: Monitor,
      keywords: ['apariencia', 'automático'],
      run: () => actions.setTheme('system'),
    },
  ]
  const profiles: Command[] = ctx.profiles
    .filter((p) => p.id !== ctx.activeProfileId)
    .map((p) => ({
      id: `profile:${p.id}`,
      title: `Cambiar al perfil «${p.name}»`,
      group: 'Perfiles',
      icon: UserRound,
      keywords: ['usuario', p.name],
      run: () => actions.switchProfile(p.id),
    }))
  return [
    { id: 'quick-add', title: 'Nuevo gasto', group: 'Acciones', icon: Plus, keywords: ['agregar', 'compra'], shortcut: 'N', run: actions.quickAdd },
    ...pages,
    statements,
    ...period,
    ctx.web
      ? {
          // The Share Sheet needs a live tap: the export itself stays on the
          // Respaldo screen, which handles "tap again to share".
          id: 'backup',
          title: 'Exportar datos',
          group: 'Acciones',
          icon: Download,
          keywords: ['respaldo', 'backup'],
          run: () => actions.navigate({ page: 'config', section: 'respaldo' }),
        }
      : { id: 'backup', title: 'Respaldar ahora', group: 'Acciones', icon: CloudUpload, keywords: ['backup', 'drive'], run: actions.backup },
    ...themes,
    ...config,
    ...profiles,
  ]
}

// searchCommand turns the typed text into "Buscar gastos: …" (Buscar with q).
export function searchCommand(query: string, navigate: (route: Route) => void): Command {
  const q = query.trim()
  return { id: 'search', title: `Buscar gastos: «${q}»`, group: 'Buscar', icon: Search, run: () => navigate({ page: 'buscar', q }) }
}

export type RankedCommand = { command: Command; indices: number[] }

const GROUP_ORDER: readonly CommandGroup[] = ['Recientes', 'Acciones', 'Ir a', 'Configuración', 'Perfiles', 'Buscar']

// rankCommands filters by the query (title first, keywords as a weaker match)
// and orders the result. With no query: recents first, then the catalog by
// group. With a query: best score first; "Buscar gastos" always last.
export function rankCommands(commands: readonly Command[], query: string, recentIds: readonly string[]): RankedCommand[] {
  if (query.trim() === '') {
    const byId = new Map(commands.map((c) => [c.id, c]))
    const recents = recentIds.flatMap((id) => {
      const c = byId.get(id)
      return c ? [{ command: { ...c, group: 'Recientes' as const }, indices: [] }] : []
    })
    const recentSet = new Set(recentIds)
    const rest = commands
      .filter((c) => !recentSet.has(c.id))
      .map((c) => ({ command: c, indices: [] }))
      .sort((a, b) => GROUP_ORDER.indexOf(a.command.group) - GROUP_ORDER.indexOf(b.command.group))
    return [...recents, ...rest]
  }
  const scored = commands.flatMap((command, order) => {
    const title = fuzzyMatch(query, command.title)
    const keyword = (command.keywords ?? []).reduce<number | null>((best, k) => {
      const m = fuzzyMatch(query, k)
      return m && (best === null || m.score > best) ? m.score : best
    }, null)
    if (!title && keyword === null) return []
    const score = Math.max(title?.score ?? -Infinity, keyword === null ? -Infinity : keyword - 50)
    return [{ command, indices: title?.indices ?? [], score, order }]
  })
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  return scored.map(({ command, indices }) => ({ command, indices }))
}
