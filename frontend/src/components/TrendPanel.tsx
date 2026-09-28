import { Equal, TrendingDown, TrendingUp } from 'lucide-react'
import { FinanceService, type TrendMonth } from '@/services/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { useQuery } from '@/lib/useQuery'
import { maxAbs, pctChange, ratio } from '@/lib/money'
import { formatCLP, monthLabel } from '@/lib/format'
import { LookIcon, QueryError, Section, Skeleton, tbl } from './ui'
import { useCategoryLooks } from './useCategoryLooks'

const WINDOW = 6

// Delta renders a percent change; for spending, going up is bad. The words
// ("más", "menos") carry the meaning, the color only reinforces it.
function Delta({ current, base, label }: { current: string; base: string; label: string }) {
  const pct = pctChange(current, base)
  if (pct === null) return <span className="text-fg-subtle">sin datos {label}</span>
  const Icon = pct > 0 ? TrendingUp : pct < 0 ? TrendingDown : Equal
  const tone = pct > 0 ? 'text-negative-fg' : pct < 0 ? 'text-positive-fg' : 'text-fg-muted'
  const words = pct > 0 ? `${pct}% más` : pct < 0 ? `${Math.abs(pct)}% menos` : 'igual'
  return (
    <span className={`inline-flex items-center gap-1 ${tone}`}>
      <Icon aria-hidden="true" className="size-3.5" />
      {words} {label}
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
        stroke="var(--color-accent-fg)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {last && <circle cx={last[0]} cy={last[1]} r="3.5" fill="var(--color-accent-fg)" />}
    </svg>
  )
}

// TrendPanel compares the month's spending with the previous month and the
// average of the months before it — overall and per category.
export function TrendPanel({ period }: { period: string }) {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const looks = useCategoryLooks()
  const query = useQuery(`${period}:${version}`, async () => {
    const res = await FinanceService.SpendingTrend(period, WINDOW)
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'tendencia vacía')
    return res.data
  })

  if (query.status === 'error') return <QueryError message={query.error} onRetry={() => invalidate('ledger')} />
  const tr = query.data
  if (!tr) {
    return (
      <Section title={`Tendencia (${WINDOW} meses)`}>
        <Skeleton className="h-20 w-full" />
      </Section>
    )
  }
  // Backend sorts by this month's spend; the top rows are the ones worth reading.
  const movers = tr.categories.slice(0, 6)

  return (
    <Section title={`Tendencia (${WINDOW} meses)`}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1 text-sm">
          <div className="text-fg">
            Este mes: <strong className="tabular-nums">{formatCLP(tr.current)}</strong>
          </div>
          <div>
            <Delta current={tr.current} base={tr.previous} label="que el mes anterior" />{' '}
            <span className="text-fg-subtle">({formatCLP(tr.previous)})</span>
          </div>
          <div>
            <Delta current={tr.current} base={tr.average} label="que el promedio" />{' '}
            <span className="text-fg-subtle">({formatCLP(tr.average)})</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Sparkline months={tr.months} />
          <div className="flex w-full max-w-60 justify-between text-[10px] text-fg-subtle" aria-hidden="true">
            {tr.months.map((m) => (
              <span key={m.period}>{monthLabel(m.period).slice(0, 3)}</span>
            ))}
          </div>
        </div>
      </div>

      {movers.length > 0 && (
        <div className={`mt-4 ${tbl.wrap}`}>
          <table className={tbl.table}>
            <thead className={tbl.thead}>
              <tr>
                <th className={tbl.th}>Categoría</th>
                <th className={`${tbl.th} text-right`}>Este mes</th>
                <th className={`${tbl.th} hidden text-right sm:table-cell`}>Promedio</th>
                <th className={`${tbl.th} text-right`}>Cambio</th>
              </tr>
            </thead>
            <tbody>
              {movers.map((c) => (
                <tr key={c.category} className={tbl.row}>
                  <td className={`${tbl.td} text-fg`}>
                    <span className="flex items-center gap-2">
                      <LookIcon look={looks.byName(c.category)} size="sm" />
                      {c.category}
                    </span>
                  </td>
                  <td className={`${tbl.td} ${tbl.num}`}>{formatCLP(c.current)}</td>
                  <td className={`${tbl.td} ${tbl.num} hidden text-fg-muted sm:table-cell`}>{formatCLP(c.average)}</td>
                  <td className={`${tbl.td} text-right text-xs`}>
                    <Delta current={c.current} base={c.average} label="" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
