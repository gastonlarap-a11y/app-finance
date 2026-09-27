// The app's screens as a typed route, kept in the URL hash (#/importar/estados,
// #/config/tarjetas…): the URL is the single source of truth for navigation,
// so a reload or the browser/iPad back gesture keeps the user where they were.
// Pure — parsing and formatting only; lib/useRoute.ts binds it to the window.

export const CONFIG_SECTIONS = [
  'tarjetas',
  'cuentas',
  'categorias',
  'etiquetas',
  'comercios',
  'reglas',
  'respaldo',
  'correo',
  'perfiles',
  'papelera',
  'apariencia',
  'actualizaciones',
] as const

export type ConfigSection = (typeof CONFIG_SECTIONS)[number]

// Sections that only exist on the desktop build (native mail sync, updater).
export const DESKTOP_ONLY_SECTIONS: ReadonlySet<ConfigSection> = new Set(['correo', 'actualizaciones'])

export type ImportTab = 'bandeja' | 'estados'

export type Route =
  | { page: 'resumen' }
  | { page: 'importar'; tab: ImportTab }
  | { page: 'buscar'; q: string }
  | { page: 'anio' }
  | { page: 'proyeccion' }
  | { page: 'fijos' }
  | { page: 'ahorro' }
  | { page: 'config'; section: ConfigSection | null }

export type Page = Route['page']

export const HOME: Route = { page: 'resumen' }

function isConfigSection(s: string | undefined): s is ConfigSection {
  return (CONFIG_SECTIONS as readonly string[]).includes(s ?? '')
}

// parseHash reads a location hash. Anything unknown lands on the home screen;
// a desktop-only section on the web build lands on the Configuración list.
export function parseHash(hash: string, isWeb: boolean): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?')
  const [page, sub] = path.split('/')
  switch (page) {
    case 'importar':
      return { page: 'importar', tab: sub === 'estados' ? 'estados' : 'bandeja' }
    case 'buscar':
      return { page: 'buscar', q: new URLSearchParams(query).get('q') ?? '' }
    case 'anio':
    case 'proyeccion':
    case 'fijos':
    case 'ahorro':
    case 'resumen':
      return { page }
    case 'config': {
      if (!isConfigSection(sub) || (isWeb && DESKTOP_ONLY_SECTIONS.has(sub))) return { page: 'config', section: null }
      return { page: 'config', section: sub }
    }
    default:
      return HOME
  }
}

export function formatHash(route: Route): string {
  switch (route.page) {
    case 'importar':
      return route.tab === 'estados' ? '#/importar/estados' : '#/importar'
    case 'buscar':
      return route.q === '' ? '#/buscar' : `#/buscar?${new URLSearchParams({ q: route.q }).toString()}`
    case 'config':
      return route.section ? `#/config/${route.section}` : '#/config'
    default:
      return `#/${route.page}`
  }
}
