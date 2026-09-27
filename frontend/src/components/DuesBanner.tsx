import { FinanceService, type Due } from '@/services/finance'
import { useVersion } from '@/atoms/refresh'
import { useQuery } from '@/lib/useQuery'
import { formatCLP, formatDate, todayISO } from '@/lib/format'

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
    <div
      role="status"
      className={`rounded-base px-4 py-3 text-sm ring-1 ${
        overdue ? 'bg-danger/10 text-red-200 ring-danger/30' : 'bg-primary/10 text-slate-200 ring-primary/30'
      }`}
    >
      <div className="mb-1 font-medium">{overdue ? 'Pagos vencidos o por vencer' : 'Próximos vencimientos'}</div>
      <ul className="space-y-0.5">
        {dues.map((d) => (
          <li key={`${d.kind}-${d.refId}-${d.period}`} className="flex flex-wrap justify-between gap-x-3">
            <span>
              {d.kind === 'tarjeta' ? '💳 ' : '📅 '}
              <strong>{d.label}</strong> · {dueWhen(d.dueDate, today)}
            </span>
            <span className={`tabular-nums ${d.overdue ? 'text-danger' : ''}`}>{formatCLP(d.amount)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-slate-400">Desaparecen al marcarlos pagados en el mes correspondiente.</p>
    </div>
  )
}
