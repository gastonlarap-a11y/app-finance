import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, Inbox, Info, TriangleAlert, type LucideIcon } from 'lucide-react'
import { Button } from './Button'

export type Tone = 'neutral' | 'accent' | 'positive' | 'negative' | 'caution' | 'info'

const BADGE_TONE: Record<Tone, string> = {
  neutral: 'bg-sunken text-fg-muted ring-1 ring-inset ring-line',
  accent: 'bg-accent-soft text-accent-fg',
  positive: 'bg-positive-soft text-positive-fg',
  negative: 'bg-negative-soft text-negative-fg',
  caution: 'bg-caution-soft text-caution-fg',
  info: 'bg-info-soft text-info-fg',
}

// Badge is a short status or count label. Its text carries the meaning; the
// tone only reinforces it (never color alone).
export function Badge({ tone = 'neutral', icon: Icon, children }: { tone?: Tone; icon?: LucideIcon; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_TONE[tone]}`}>
      {Icon && <Icon aria-hidden="true" className="size-3" />}
      {children}
    </span>
  )
}

type CalloutTone = Exclude<Tone, 'accent'>

const CALLOUT: Record<CalloutTone, { box: string; icon: string; glyph: LucideIcon }> = {
  neutral: { box: 'bg-sunken ring-line', icon: 'text-fg-muted', glyph: Info },
  info: { box: 'bg-info-soft ring-info-fg/25', icon: 'text-info-fg', glyph: Info },
  positive: { box: 'bg-positive-soft ring-positive-fg/25', icon: 'text-positive-fg', glyph: CircleCheck },
  caution: { box: 'bg-caution-soft ring-caution-fg/30', icon: 'text-caution-fg', glyph: TriangleAlert },
  negative: { box: 'bg-negative-soft ring-negative-fg/30', icon: 'text-negative-fg', glyph: CircleAlert },
}

// Callout is an inline message box (warnings, results, notes). The icon and
// the optional title say what kind of message it is; the text stays in the
// neutral foreground so it reads at full contrast on every tint.
export function Callout({
  tone = 'info',
  title,
  children,
  action,
  role,
  icon,
  className = '',
}: {
  tone?: CalloutTone
  title?: string
  children?: ReactNode
  action?: ReactNode
  role?: 'status' | 'alert'
  icon?: LucideIcon
  className?: string
}) {
  const look = CALLOUT[tone]
  const Glyph = icon ?? look.glyph
  return (
    <div role={role} className={`flex items-start gap-3 rounded-lg px-4 py-3 text-sm text-fg ring-1 ring-inset ${look.box} ${className}`}>
      <Glyph aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${look.icon}`} />
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

// EmptyState says why a list is empty and offers the action that fills it.
export function EmptyState({
  icon: Icon = Inbox,
  title,
  children,
  action,
}: {
  icon?: LucideIcon
  title?: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-6 py-8 text-center">
      <Icon aria-hidden="true" className="size-8 text-fg-subtle" />
      {title && <p className="font-medium text-fg">{title}</p>}
      {children && <div className="max-w-prose text-sm text-fg-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

// Empty is the compact, text-only empty state (inline lists, small panels).
export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg bg-sunken p-6 text-center text-sm text-fg-muted">{children}</div>
}

// Skeleton is a placeholder block shaped like the content that is loading.
export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div aria-hidden="true" className={`rounded-md bg-sunken motion-safe:animate-pulse ${className}`} />
}

// SkeletonRows stands in for a list or table while it loads, announcing the
// wait to screen readers once.
export function SkeletonRows({ rows = 5, label = 'Cargando…' }: { rows?: number; label?: string }) {
  return (
    <div role="status" className="space-y-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  )
}

// Spinner is the text loading state, for places without a known layout.
export function Spinner() {
  return (
    <div role="status" className="p-6 text-center text-sm text-fg-muted">
      Cargando…
    </div>
  )
}

// QueryError is the inline failure state for a view whose data could not load.
export function QueryError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Callout
      tone="negative"
      role="alert"
      title="No se pudieron cargar los datos"
      action={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Reintentar
        </Button>
      }
    >
      <p className="text-fg-muted">{message}</p>
    </Callout>
  )
}
