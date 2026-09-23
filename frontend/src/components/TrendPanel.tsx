import { useSetAtom } from 'jotai'
import { FinanceService, type TrendMonth } from '@/services/finance'
import { refreshAtom } from '@/atoms/finance'
import { useQuery } from '@/lib/useQuery'
import { maxAbs, pctChange, ratio } from '@/lib/money'
import { formatCLP, monthLabel } from '@/lib/format'
import { QueryError, Section } from './ui'

const WINDOW = 6

// Delta renders a percent change; for spending, going up is bad (danger).
function Delta({ current, base, label }: { current: string; base: string; label: string }) {
  const pct = pctChange(current, base)
  if (pct === null) return <span className="text-slate-500">sin datos {label}</span>
  const tone = pct > 0 ? 'text-danger' : pct < 0 ? 'text-success' : 'text-slate-400'
  return (
    <span className={tone}>
      {pct > 0 ? '▲' : pct < 0 ? '▼' : '='} {Math.abs(pct)}% {label}
    </span>
  )
}

// Sparkline is a small SVG line of monthly spending (display only).
function Sparkline({ months }: { months: TrendMonth[] }) {
  const w = 240
  const h = 56
  const pad = 4
  const top = maxAbs(months.map((m) => m.gastos))
  const step = months.length > 1 ? (w - pad * 2) / (months.length - 1) : 0
  const points = months.map((m, i) => [pad + i * step, h - pad - ratio(m.gastos, top) * (h - pad * 2)] as const)
  const last = points[points.length - 1]
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full max-w-60" role="img" aria-label="Gasto de los últimos meses">
      <polyline
        points={points.map(([x, y]) => `${x},${y}`).join(' ')}
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {last && <circle cx={last[0]} cy={last[1]} r="3" fill="var(--color-primary)" />}
    </svg>
  )
}

// TrendPanel compares the month's spending with the previous month and the
// average of the months before it — overall and per category.
export function TrendPanel({ period, refresh }: { period: string; refresh: number }) {
  const bump = useSetAtom(refreshAtom)
  const query = useQuery(`${period}:${refresh}`, async () => {
    const res = await FinanceService.SpendingTrend(period, WINDOW)
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'tendencia vacía')
    return res.data
  })

  if (query.status === 'error') return <QueryError message={query.error} onRetry={() => bump((n) => n + 1)} />
  const tr = query.data
  if (!tr) return null
  // Backend sorts by this month's spend; the top rows are the ones worth reading.
  const movers = tr.categories.slice(0, 6)

  return (
    <Section title={`Tendencia (${WINDOW} meses)`}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1 text-sm">
          <div>
            Este mes: <strong className="tabular-nums">{formatCLP(tr.current)}</strong>
          </div>
          <div>
            <Delta current={tr.current} base={tr.previous} label="vs mes anterior" />{' '}
            <span className="text-slate-500">({formatCLP(tr.previous)})</span>
          </div>
          <div>
            <Delta current={tr.current} base={tr.average} label="vs promedio" />{' '}
            <span className="text-slate-500">({formatCLP(tr.average)})</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Sparkline months={tr.months} />
          <div className="flex w-full max-w-60 justify-between text-[10px] text-slate-500" aria-hidden="true">
            {tr.months.map((m) => (
              <span key={m.period}>{monthLabel(m.period).slice(0, 3)}</span>
            ))}
          </div>
        </div>
      </div>

      {movers.length > 0 && (
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-400">
            <tr>
              <th className="pb-2">Categoría</th>
              <th className="pb-2 text-right">Este mes</th>
              <th className="hidden pb-2 text-right sm:table-cell">Promedio</th>
              <th className="pb-2 text-right">Cambio</th>
            </tr>
          </thead>
          <tbody>
            {movers.map((c) => (
              <tr key={c.category} className="border-t border-slate-800">
                <td className="py-1.5 text-slate-300">{c.category}</td>
                <td className="py-1.5 text-right tabular-nums">{formatCLP(c.current)}</td>
                <td className="hidden py-1.5 text-right tabular-nums text-slate-400 sm:table-cell">{formatCLP(c.average)}</td>
                <td className="py-1.5 text-right text-xs">
                  <Delta current={c.current} base={c.average} label="" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}
