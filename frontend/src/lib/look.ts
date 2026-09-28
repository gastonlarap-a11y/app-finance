// Personalization looks: the icon and color a category, card or savings goal
// shows. The stored keys come from backend/finance/looks.json ('' = automatic);
// look.test.ts proves ICONS and COLORS below hold exactly those keys. An
// automatic look is derived from the name (icon) or a stable seed (color), and
// a key this copy does not know (written by a newer device) counts as automatic.
import {
  Baby,
  Bike,
  BookOpen,
  Briefcase,
  Bus,
  Car,
  Coffee,
  CreditCard,
  Droplet,
  Dumbbell,
  Film,
  Flame,
  Fuel,
  Gamepad2,
  Gift,
  GraduationCap,
  HeartPulse,
  House,
  Landmark,
  Laptop,
  Music,
  PartyPopper,
  PawPrint,
  PiggyBank,
  Pill,
  Plane,
  Receipt,
  Scissors,
  ShieldCheck,
  Shirt,
  ShoppingBag,
  ShoppingCart,
  Smartphone,
  Sofa,
  Sprout,
  Tag,
  Target,
  Ticket,
  TrainFront,
  TreePalm,
  Trophy,
  Tv,
  Umbrella,
  Utensils,
  Wallet,
  Wifi,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'

// Static imports (tree-shaken), each with the Spanish name the picker reads out.
export const ICONS = {
  'shopping-cart': { icon: ShoppingCart, label: 'Carro de supermercado' },
  'shopping-bag': { icon: ShoppingBag, label: 'Bolsa de compras' },
  utensils: { icon: Utensils, label: 'Cubiertos' },
  coffee: { icon: Coffee, label: 'Café' },
  car: { icon: Car, label: 'Auto' },
  bus: { icon: Bus, label: 'Bus' },
  fuel: { icon: Fuel, label: 'Bencina' },
  'train-front': { icon: TrainFront, label: 'Tren' },
  bike: { icon: Bike, label: 'Bicicleta' },
  plane: { icon: Plane, label: 'Avión' },
  'tree-palm': { icon: TreePalm, label: 'Palmera' },
  house: { icon: House, label: 'Casa' },
  sofa: { icon: Sofa, label: 'Sillón' },
  wrench: { icon: Wrench, label: 'Llave' },
  zap: { icon: Zap, label: 'Rayo' },
  droplet: { icon: Droplet, label: 'Gota' },
  flame: { icon: Flame, label: 'Llama' },
  wifi: { icon: Wifi, label: 'Wifi' },
  smartphone: { icon: Smartphone, label: 'Celular' },
  tv: { icon: Tv, label: 'Televisión' },
  laptop: { icon: Laptop, label: 'Computador' },
  'heart-pulse': { icon: HeartPulse, label: 'Salud' },
  pill: { icon: Pill, label: 'Remedio' },
  dumbbell: { icon: Dumbbell, label: 'Pesa' },
  scissors: { icon: Scissors, label: 'Tijeras' },
  shirt: { icon: Shirt, label: 'Polera' },
  'graduation-cap': { icon: GraduationCap, label: 'Birrete' },
  'book-open': { icon: BookOpen, label: 'Libro' },
  baby: { icon: Baby, label: 'Bebé' },
  'paw-print': { icon: PawPrint, label: 'Huella' },
  sprout: { icon: Sprout, label: 'Planta' },
  'gamepad-2': { icon: Gamepad2, label: 'Control de juegos' },
  music: { icon: Music, label: 'Música' },
  film: { icon: Film, label: 'Película' },
  ticket: { icon: Ticket, label: 'Entrada' },
  gift: { icon: Gift, label: 'Regalo' },
  'party-popper': { icon: PartyPopper, label: 'Fiesta' },
  briefcase: { icon: Briefcase, label: 'Maletín' },
  landmark: { icon: Landmark, label: 'Banco' },
  receipt: { icon: Receipt, label: 'Boleta' },
  'credit-card': { icon: CreditCard, label: 'Tarjeta' },
  wallet: { icon: Wallet, label: 'Billetera' },
  'piggy-bank': { icon: PiggyBank, label: 'Alcancía' },
  'shield-check': { icon: ShieldCheck, label: 'Escudo' },
  umbrella: { icon: Umbrella, label: 'Paraguas' },
  target: { icon: Target, label: 'Diana' },
  trophy: { icon: Trophy, label: 'Trofeo' },
  tag: { icon: Tag, label: 'Etiqueta' },
} as const satisfies Record<string, { icon: LucideIcon; label: string }>

export const COLORS = {
  red: 'Rojo',
  orange: 'Naranjo',
  amber: 'Ámbar',
  lime: 'Lima',
  green: 'Verde',
  teal: 'Verde azulado',
  cyan: 'Celeste',
  blue: 'Azul',
  indigo: 'Índigo',
  violet: 'Violeta',
  pink: 'Rosado',
  gray: 'Gris',
} as const satisfies Record<string, string>

export type IconKey = keyof typeof ICONS
export type ColorKey = keyof typeof COLORS

export interface Look {
  icon: IconKey
  color: ColorKey
}

function isIconKey(key: string): key is IconKey {
  return Object.hasOwn(ICONS, key)
}

export function isColorKey(key: string): key is ColorKey {
  return Object.hasOwn(COLORS, key)
}

// Gray is reserved for an explicit choice: automatic colors should tell rows apart.
const AUTO_COLORS = (Object.keys(COLORS) as ColorKey[]).filter((c) => c !== 'gray')

// autoColor maps a stable seed (a row id, or a name when there is no row) to a
// palette color. The multiplier is coprime with the palette size, so
// consecutive ids land on distant hues.
export function autoColor(seed: number | string): ColorKey {
  const n = typeof seed === 'number' ? seed : hashString(seed)
  return AUTO_COLORS[(Math.abs(n) * 5) % AUTO_COLORS.length]!
}

function hashString(s: string): number {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) | 0
  return h
}

function normalize(name: string): string {
  return name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

// Words (plural tolerant) and phrases that suggest an icon, checked in order.
const ICON_RULES: readonly (readonly [IconKey, readonly string[]])[] = [
  ['house', ['arriendo', 'dividendo', 'hipoteca', 'casa', 'hogar', 'gastos comunes', 'depto', 'departamento']],
  ['shopping-cart', ['supermercado', 'super', 'mercado', 'almacen', 'feria', 'jumbo', 'lider', 'unimarc', 'tottus']],
  ['utensils', ['comida', 'restaurant', 'restaurante', 'almuerzo', 'cena', 'delivery', 'rappi', 'pedidos ya']],
  ['coffee', ['cafe', 'cafeteria']],
  ['fuel', ['bencina', 'combustible', 'gasolina', 'copec', 'petrobras']],
  ['car', ['auto', 'autos', 'estacionamiento', 'peaje', 'autopista', 'mecanico']],
  ['bus', ['transporte', 'metro', 'micro', 'bus', 'uber', 'taxi', 'bip', 'locomocion']],
  ['plane', ['viaje', 'vuelo', 'avion', 'pasaje', 'aeropuerto']],
  ['tree-palm', ['vacacion', 'vacaciones', 'playa']],
  ['sofa', ['mueble', 'decoracion']],
  ['wrench', ['mantencion', 'reparacion', 'arreglo', 'ferreteria']],
  ['zap', ['luz', 'electricidad', 'enel']],
  ['droplet', ['agua']],
  ['flame', ['gas', 'calefaccion', 'parafina']],
  ['wifi', ['internet', 'wifi', 'fibra']],
  ['smartphone', ['celular', 'telefono', 'movil']],
  ['music', ['musica', 'spotify']],
  ['tv', ['streaming', 'netflix', 'television', 'tv', 'cable', 'disney', 'hbo', 'suscripcion']],
  ['laptop', ['computador', 'tecnologia', 'notebook', 'software']],
  ['pill', ['farmacia', 'remedio', 'medicamento']],
  ['heart-pulse', ['salud', 'medico', 'doctor', 'clinica', 'isapre', 'fonasa', 'dental', 'dentista', 'examen']],
  ['dumbbell', ['gimnasio', 'gym', 'deporte']],
  ['scissors', ['peluqueria', 'belleza', 'barberia', 'cuidado personal']],
  ['shirt', ['ropa', 'vestuario', 'zapato', 'zapatos', 'zapatilla']],
  ['graduation-cap', ['educacion', 'colegio', 'universidad', 'curso', 'estudio', 'estudios', 'matricula']],
  ['book-open', ['libro', 'libreria']],
  ['baby', ['hijo', 'hija', 'hijos', 'bebe', 'guagua', 'nino', 'ninos', 'jardin infantil']],
  ['paw-print', ['mascota', 'veterinaria', 'veterinario', 'perro', 'gato']],
  ['sprout', ['jardin', 'planta', 'plantas']],
  ['gamepad-2', ['juego', 'videojuego', 'gaming']],
  ['film', ['cine', 'pelicula']],
  ['ticket', ['entretencion', 'concierto', 'evento', 'entrada', 'panorama']],
  ['gift', ['regalo']],
  ['party-popper', ['fiesta', 'cumpleanos', 'celebracion']],
  ['briefcase', ['trabajo', 'oficina', 'negocio']],
  ['landmark', ['banco', 'impuesto', 'contribucion', 'credito', 'prestamo', 'comision']],
  ['shield-check', ['seguro']],
  ['umbrella', ['emergencia', 'imprevisto', 'imprevistos']],
  ['piggy-bank', ['ahorro', 'inversion']],
  ['credit-card', ['tarjeta']],
  ['receipt', ['cuenta', 'servicio', 'boleta']],
  ['shopping-bag', ['compras', 'tienda', 'mall']],
]

function matches(words: readonly string[], text: string, keyword: string): boolean {
  if (keyword.includes(' ')) return text.includes(keyword)
  return words.some((w) => w === keyword || w === `${keyword}s` || w === `${keyword}es`)
}

// autoIcon guesses an icon from a name ("Supermercado" → cart, "Arriendo" →
// house); `fallback` when nothing matches.
export function autoIcon(name: string, fallback: IconKey): IconKey {
  const text = normalize(name)
  const words = text.split(/[^a-z0-9]+/).filter(Boolean)
  for (const [icon, keywords] of ICON_RULES) {
    if (keywords.some((k) => matches(words, text, k))) return icon
  }
  return fallback
}

// resolveLook turns a row's stored keys into what to show: its own choice when
// this copy knows the key, the automatic look otherwise.
export function resolveLook(row: { id: number; name: string; icon?: string; color?: string }, fallbackIcon: IconKey = 'tag'): Look {
  return {
    icon: row.icon && isIconKey(row.icon) ? row.icon : autoIcon(row.name, fallbackIcon),
    color: row.color && isColorKey(row.color) ? row.color : autoColor(row.id),
  }
}

export function categoryLook(c: { id: number; name: string; icon: string; color: string }): Look {
  return resolveLook(c)
}

export function cardColor(c: { id: number; color: string }): ColorKey {
  return isColorKey(c.color) ? c.color : autoColor(c.id)
}

// A goal stores only an icon; its color is always the automatic one (by id).
export function goalLook(g: { id: number; name: string; icon: string }): Look {
  return resolveLook({ id: g.id, name: g.name, icon: g.icon }, 'piggy-bank')
}

// nameLook is the look of a category known only by name (an expense whose
// category was deleted or never created): automatic, seeded by the name.
export function nameLook(name: string): Look {
  return { icon: autoIcon(name, 'tag'), color: autoColor(name) }
}

export interface CategoryLooks {
  // Expenses and budgets name their category (case-insensitively unique); an
  // unknown name still gets a stable automatic look.
  byName: (name: string) => Look
  byId: (id: number) => Look | undefined
}

type CategoryRow = { id: number; name: string; icon: string; color: string }

export function categoryLooks(categories: readonly CategoryRow[]): CategoryLooks {
  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), categoryLook(c)]))
  const byId = new Map(categories.map((c) => [c.id, categoryLook(c)]))
  return {
    byName: (name) => byName.get(name.toLowerCase()) ?? nameLook(name),
    byId: (id) => byId.get(id),
  }
}
