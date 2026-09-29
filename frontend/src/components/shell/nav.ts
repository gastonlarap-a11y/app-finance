import { ChartColumn, House, Inbox, PiggyBank, Repeat, Search, TrendingUp, type LucideIcon } from 'lucide-react'
import type { Page, Route } from '@/lib/route'
import { SECTION_SHORTCUTS } from '@/lib/shortcuts'

// The sidebar's model: the main screens, grouped, in the order ⌘1…⌘7 follows.
// Configuración is not here — it sits apart at the bottom (see Sidebar).

export type MainPage = Exclude<Page, 'config'>

export type PageMeta = {
  label: string // sidebar entry
  title: string // the screen's h1
  subtitle?: string
  icon: LucideIcon
  // Screens whose content follows the selected month or year show the navigator.
  period?: 'month' | 'year'
}

export const PAGES: Record<MainPage, PageMeta> = {
  resumen: { label: 'Resumen', title: 'Resumen del mes', icon: House, period: 'month' },
  importar: {
    label: 'Importar',
    title: 'Importar',
    subtitle: 'Revisa lo que traen tus estados de cuenta y cartolas antes de que cuente.',
    icon: Inbox,
  },
  buscar: { label: 'Buscar', title: 'Buscar gastos', subtitle: 'En todo tu historial.', icon: Search },
  anio: { label: 'Año', title: 'Resumen del año', icon: ChartColumn, period: 'year' },
  proyeccion: {
    label: 'Proyección',
    title: 'Proyección',
    subtitle: 'Lo ya comprometido: cuotas de compras hechas y gastos fijos activos.',
    icon: TrendingUp,
    period: 'month',
  },
  fijos: { label: 'Gastos fijos', title: 'Gastos fijos', icon: Repeat, period: 'month' },
  ahorro: { label: 'Ahorro', title: 'Metas de ahorro', icon: PiggyBank },
}

export type NavGroup = { label?: string; pages: MainPage[] }

export const NAV_GROUPS: readonly NavGroup[] = [
  { pages: ['resumen', 'importar', 'buscar'] },
  { label: 'Análisis', pages: ['anio', 'proyeccion'] },
  { label: 'Planificar', pages: ['fijos', 'ahorro'] },
]

// routeTo is the route a sidebar entry opens (its default tab / empty search).
export function routeTo(page: MainPage): Route {
  const route = SECTION_SHORTCUTS.find((r) => r.page === page)
  if (!route) throw new Error(`no route for page ${page}`)
  return route
}

// shortcutOf is the ⌘/Ctrl digit that opens a page (sidebar order).
export function shortcutOf(page: MainPage): number {
  return SECTION_SHORTCUTS.findIndex((r) => r.page === page) + 1
}
