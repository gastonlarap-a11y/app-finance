import type { ReactNode } from 'react'
import { CloudUpload, CreditCard, Landmark, Palette, RefreshCw, Shapes, Store, Tag, Trash, Users, WandSparkles, type LucideIcon } from 'lucide-react'
import { IS_WEB } from '@/lib/platform'
import { CONFIG_SECTIONS, DESKTOP_ONLY_SECTIONS, type ConfigSection } from '@/lib/route'
import { AccountsSettings } from '../Accounts'
import { CardsView } from '../CardsView'
import { CategoriesView } from '../CategoriesView'
import { MerchantsView } from '../MerchantsView'
import { BackupSettings } from '../SettingsView'
import { TagsSection } from '../TagsSection'
import { TrashView } from '../TrashView'
import { UpdatesSettings } from '../UpdateNotice'
import { AppearanceSettings } from './AppearanceSettings'
import { ImportRulesSettings } from './ImportRulesSettings'
import { ProfilesSettings } from './ProfilesSettings'

export type ConfigGroup = 'Finanzas' | 'Datos' | 'App'

type SectionDef = {
  group: ConfigGroup
  label: string
  description: string
  icon: LucideIcon
  render: () => ReactNode
}

// Every Configuración section: what you set up once, grouped like the
// Settings app of macOS/iPadOS. A Record keyed by ConfigSection, so a new
// route section cannot ship without its screen.
const SECTIONS: Record<ConfigSection, SectionDef> = {
  tarjetas: {
    group: 'Finanzas',
    label: 'Tarjetas',
    description: 'Cupo, día de corte y cuenta de pago',
    icon: CreditCard,
    render: () => <CardsView />,
  },
  cuentas: {
    group: 'Finanzas',
    label: 'Cuentas',
    description: 'Corriente, vista, efectivo y ahorro',
    icon: Landmark,
    render: () => <AccountsSettings />,
  },
  categorias: {
    group: 'Finanzas',
    label: 'Categorías y presupuestos',
    description: 'Topes mensuales y traspaso de lo no gastado',
    icon: Shapes,
    render: () => <CategoriesView />,
  },
  etiquetas: {
    group: 'Finanzas',
    label: 'Etiquetas',
    description: 'Viaje, trabajo… a través de categorías',
    icon: Tag,
    render: () => <TagsSection />,
  },
  comercios: { group: 'Finanzas', label: 'Comercios', description: 'Dónde compras', icon: Store, render: () => <MerchantsView /> },
  reglas: {
    group: 'Finanzas',
    label: 'Reglas de importación',
    description: 'Comercio y categoría que se completan solos',
    icon: WandSparkles,
    render: () => <ImportRulesSettings />,
  },
  respaldo: {
    group: 'Datos',
    label: IS_WEB ? 'Respaldo' : 'Respaldo y Google Drive',
    description: IS_WEB ? 'Exportar e importar tus datos' : 'Carpeta de datos, Drive y restaurar',
    icon: CloudUpload,
    render: () => <BackupSettings />,
  },
  perfiles: { group: 'Datos', label: 'Perfiles', description: 'Quién usa la app', icon: Users, render: () => <ProfilesSettings /> },
  papelera: { group: 'Datos', label: 'Papelera', description: 'Restaurar lo eliminado', icon: Trash, render: () => <TrashView /> },
  apariencia: { group: 'App', label: 'Apariencia', description: 'Tema y barra lateral', icon: Palette, render: () => <AppearanceSettings /> },
  actualizaciones: {
    group: 'App',
    label: 'Actualizaciones',
    description: 'Versión instalada y nuevas versiones',
    icon: RefreshCw,
    render: () => <UpdatesSettings />,
  },
}

export type SectionEntry = SectionDef & { id: ConfigSection }

// The sections this build offers, in route order.
export const AVAILABLE_SECTIONS: readonly SectionEntry[] = CONFIG_SECTIONS.filter((id) => !(IS_WEB && DESKTOP_ONLY_SECTIONS.has(id))).map(
  (id) => ({ id, ...SECTIONS[id] }),
)

export const CONFIG_GROUPS: readonly ConfigGroup[] = ['Finanzas', 'Datos', 'App']
