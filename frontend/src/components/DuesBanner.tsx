import { CalendarClock, CalendarDays, CircleAlert, CreditCard } from 'lucide-react'
import { FinanceService, type Due } from '@/services/finance'
import { useVersion } from '@/atoms/refresh'
import { useQuery } from '@/lib/useQuery'
import { formatCLP, formatDate, todayISO } from '@/lib/format'
import { Callout } from './ui'

// How far ahead the banner looks (the desktop notification looks 3 days).
const BANNER_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

// dueWhen phrases a due date relative to today: "vence mañana", "venció el 5 sept".
function dueWhen(date: string, today: string): string {
  const days = Math.round((Date.parse(date) - Date.parse(today)) / DAY_MS)
  if (days < 0) return `venció el ${formatDate(date)}`
  if (days === 0) return 'vence hoy'
  if (days === 1) return 'vence mañana'
  return `vence el ${formatDate(date)}`
}

// DuesBanner lists the unpaid card statements and fixed expenses falling due
// soon (or just missed). On the web/iPad build it is the only reminder: a push
// to a closed PWA would need a paid push server.
export function DuesBanner() {
  const today = todayISO()
  const version = useVersion('ledger', 'imports')
  const query = useQuery(`${today}:${version}`, async () => {
    const r = await FinanceService.UpcomingDues(today, BANNER_DAYS)
    if (r.error) throw new Error(r.error.message)
    return r.data ?? []
  })
  const dues: Due[] = query.data ?? []
  if (dues.length === 0) return null
  const overdue = dues.some((d) => d.overdue)

  return (
    <Callout
      tone={overdue ? 'negative' : 'info'}
      role="status"
      icon={overdue ? CircleAlert : CalendarClock}
      title={overdue ? 'Pagos vencidos o por vencer' : 'Próximos vencimientos'}
    >
      <ul className="space-y-1">
        {dues.map((d) => {
          const Icon = d.kind === 'tarjeta' ? CreditCard : CalendarDays
          return (
            <li key={`${d.kind}-${d.refId}-${d.period}`} className="flex flex-wrap items-center justify-between gap-x-3">
              <span className="inline-flex flex-wrap items-center gap-x-1.5">
                <Icon aria-hidden="true" className="size-3.5 text-fg-muted" />
                <strong className="font-medium">{d.label}</strong>
                <span className="text-fg-muted">· {dueWhen(d.dueDate, today)}</span>
              </span>
              <span className={`tabular-nums ${d.overdue ? 'font-semibold text-negative-fg' : ''}`}>{formatCLP(d.amount)}</span>
            </li>
          )
        })}
      </ul>
      <p className="text-xs text-fg-muted">Desaparecen al marcarlos pagados en el mes correspondiente.</p>
    </Callout>
  )
}
