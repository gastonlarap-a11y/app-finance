import type { Route } from '@/lib/route'

// The Guía de inicio: the first steps of a new profile, derived from facts the
// app already knows (no stored progress). Pure, so the rules are tested apart
// from the queries that feed them.

export interface OnboardingFacts {
  cardsOrAccounts: number
  categories: number
  incomeThisMonth: boolean
  anyExpense: boolean // in the whole history, entered or imported
  openingBalance: boolean // a reconciled close the carried balance restarts from
  backupOn: boolean // desktop: Drive connected or backup on close; web: an export was made
}

export type StepId = 'tarjeta' | 'categorias' | 'ingreso' | 'gasto' | 'saldo' | 'respaldo'

export type StepAction =
  | { kind: 'route'; route: Route; label: string }
  | { kind: 'quick-add'; label: string }
  | { kind: 'opening-balance'; label: string }

export interface OnboardingStep {
  id: StepId
  title: string
  description: string
  done: boolean
  optional: boolean
  actions: StepAction[]
}

export function onboardingSteps(f: OnboardingFacts, web: boolean): OnboardingStep[] {
  return [
    {
      id: 'tarjeta',
      title: 'Agrega tu tarjeta o cuenta',
      description: 'Con su día de corte, cada compra en cuotas cae en el mes que corresponde.',
      done: f.cardsOrAccounts > 0,
      optional: false,
      actions: [{ kind: 'route', route: { page: 'config', section: 'tarjetas' }, label: 'Agregar tarjeta' }],
    },
    {
      id: 'categorias',
      title: 'Crea tus categorías',
      description: 'Supermercado, transporte, salud… para ver en qué se va la plata y ponerle topes.',
      done: f.categories > 0,
      optional: false,
      actions: [{ kind: 'route', route: { page: 'config', section: 'categorias' }, label: 'Crear categorías' }],
    },
    {
      id: 'ingreso',
      title: 'Anota tu sueldo del mes',
      description: 'En el panel «Ingresos» de este resumen: así sabes si te alcanza.',
      done: f.incomeThisMonth,
      optional: false,
      actions: [],
    },
    {
      id: 'gasto',
      title: 'Registra tu primer gasto',
      description: 'A mano, o importando el estado de cuenta de tu tarjeta.',
      done: f.anyExpense,
      optional: false,
      actions: [
        { kind: 'quick-add', label: 'Agregar gasto' },
        { kind: 'route', route: { page: 'importar', tab: 'estados' }, label: 'Importar estado de cuenta' },
      ],
    },
    {
      // Cuotas already running when you start (an imported 5/12) fall in past
      // months with no salary: the opening balance keeps them out of the carry.
      id: 'saldo',
      title: 'Anota con cuánto partes',
      description: 'El saldo real con que empiezas el mes. Así lo de meses anteriores, como cuotas ya en curso, no descuadra lo que arrastras.',
      done: f.openingBalance,
      optional: true,
      actions: [{ kind: 'opening-balance', label: 'Anotar saldo inicial' }],
    },
    {
      id: 'respaldo',
      title: web ? 'Exporta un respaldo' : 'Activa el respaldo',
      description: web
        ? 'Tus datos viven solo en este dispositivo: guarda una copia en Archivos o iCloud.'
        : 'Conecta Google Drive o respalda al cerrar la app, para no perder nada.',
      done: f.backupOn,
      optional: true,
      actions: [{ kind: 'route', route: { page: 'config', section: 'respaldo' }, label: web ? 'Exportar' : 'Configurar respaldo' }],
    },
  ]
}

// The guide is done when every required step is; the optional one never keeps it open.
export function onboardingDone(steps: readonly OnboardingStep[]): boolean {
  return steps.every((s) => s.done || s.optional)
}

// Hiding the guide is remembered per profile and device.
export function dismissKey(userId: number): string {
  return `app-finance:onboarding-dismissed:${userId}`
}
