import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

// Section is the card that groups one topic of a view.
export function Section({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl bg-panel p-5 shadow-xs ring-1 ring-line">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title ? <h2 className="text-lg font-semibold text-fg">{title}</h2> : <span />}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

// Banner is the app-wide strip above the page (a new version to install). It
// lines up with <main>'s width and gutters; its buttons follow the message.
export function Banner({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div role="status" className="border-b border-line bg-accent-soft text-fg">
      <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 text-sm sm:px-6 lg:px-8">
        <Icon aria-hidden="true" className="size-4 shrink-0 text-accent-fg" />
        {children}
      </div>
    </div>
  )
}

type StatTone = 'default' | 'success' | 'danger' | 'primary' | 'caution'

const STAT_TONE: Record<StatTone, string> = {
  default: 'text-fg',
  success: 'text-positive-fg',
  danger: 'text-negative-fg',
  primary: 'text-accent-fg',
  caution: 'text-caution-fg',
}

// StatCard is one headline figure (KPI) with its label and an optional hint.
export function StatCard({
  label,
  value,
  tone = 'default',
  hint,
  icon: Icon,
}: {
  label: string
  value: string
  tone?: StatTone
  hint?: string
  icon?: LucideIcon
}) {
  return (
    <div className="rounded-xl bg-panel p-4 shadow-xs ring-1 ring-line">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
        {Icon && <Icon aria-hidden="true" className="size-3.5" />}
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${STAT_TONE[tone]}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-fg-subtle">{hint}</div>}
    </div>
  )
}

// PageHeader titles a view (its only h1). The heading takes programmatic focus
// after navigation so screen readers announce the new page.
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 tabIndex={-1} className="text-2xl font-semibold tracking-tight text-fg outline-none">
          {title}
        </h1>
        {subtitle && <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}
