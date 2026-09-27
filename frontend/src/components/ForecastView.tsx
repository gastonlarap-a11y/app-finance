import { useState } from 'react'
import { useAtom } from 'jotai'
import { FinanceService } from '@/services/finance'
import { periodAtom } from '@/atoms/finance'
import { navigate } from '@/lib/useRoute'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { useQuery } from '@/lib/useQuery'
import { compare, isNegative, isZero, maxAbs, ratio, sum } from '@/lib/money'
import { formatCLP, periodLabel } from '@/lib/format'
import { QueryError, Section, SegmentedControl, Skeleton, StatCard, tbl } from './ui'

const HORIZONS = [
  { value: '6', label: '6 meses' },
  { value: '12', label: '12 meses' },
  { value: '24', label: '24 meses' },
] as const
type Horizon = (typeof HORIZONS)[number]['value']

// ForecastView answers "how much of my future income is already spoken for?":
// remaining installments + active fixed expenses per month, against the salary
// (the last known one when a month has none yet).
export function ForecastView() {
  const [period, setPeriod] = useAtom(periodAtom)
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const [horizon, setHorizon] = useState<Horizon>('12')
  const months = Number(horizon)

  const query = useQuery(`${period}:${months}:${version}`, async () => {
    const res = await FinanceService.CommitmentsForecast(period, months)
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'proyección vacía')
    return res.data
  })

  if (query.status === 'error') return <QueryError message={query.error} onRetry={() => invalidate('ledger')} />
  const data = query.data
  if (!data) return <ForecastSkeleton />
  const stale = query.status === 'loading'

  const scale = maxAbs(data.flatMap((m) => [m.comprometido, m.ingresos]))
  const last = data[data.length - 1]
  const tightest = data.reduce<(typeof data)[number] | undefined>(
    (min, m) => (min === undefined || compare(m.libre, min.libre) < 0 ? m : min),
    undefined,
  )
  const anyEstimated = data.some((m) => m.ingresoEstimado)
  const anySavings = data.some((m) => !isZero(m.ahorro))

  return (
    <div className={`space-y-6 transition-opacity ${stale ? 'opacity-60' : ''}`} aria-busy={stale}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">
          Desde <strong className="text-fg">{periodLabel(period)}</strong>, para los próximos:
        </p>
        <SegmentedControl label="Horizonte" value={horizon} options={HORIZONS} onChange={setHorizon} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {tightest && (
          <StatCard
            label="Mes más ajustado"
            value={formatCLP(tightest.libre)}
            tone={isNegative(tightest.libre) ? 'danger' : 'default'}
            hint={`${periodLabel(tightest.period)} · libre tras lo comprometido`}
          />
        )}
        {last && (
          <StatCard
            label={`Saldo proyectado a ${periodLabel(last.period)}`}
            value={formatCLP(last.saldoProyectado)}
            tone={isNegative(last.saldoProyectado) ? 'danger' : 'success'}
            hint="Si sólo ocurriera lo ya comprometido"
          />
        )}
        <StatCard label="Cuotas por pagar" value={formatCLP(sum(data.map((m) => m.cuotas)))} hint={`En los próximos ${months} meses`} />
      </div>

      <Section title="Mes a mes">
        <div className={`@container ${tbl.wrap}`}>
          <table className={tbl.table}>
            <thead className={tbl.thead}>
              <tr>
                <th className={tbl.th}>Mes</th>
                <th className={`${tbl.th} text-right`}>Cuotas</th>
                <th className={`${tbl.th} text-right`}>Fijos</th>
                {anySavings && <th className={`${tbl.th} text-right`}>Ahorro</th>}
                <th className={`${tbl.th} text-right`}>Ingresos</th>
                <th className={`${tbl.th} text-right`}>Libre</th>
                <th className={`${tbl.th} hidden text-right @2xl:table-cell`}>Saldo proy.</th>
                <th className={`${tbl.th} hidden w-1/4 @4xl:table-cell`}>
                  <span className="sr-only">Comprometido vs ingresos</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.period} className={tbl.row}>
                  <td className={`${tbl.td} whitespace-nowrap`}>
                    <button
                      type="button"
                      className="rounded font-medium text-fg hover:text-accent-fg hover:underline"
                      onClick={() => {
                        setPeriod(m.period)
                        navigate({ page: 'resumen' })
                      }}
                    >
                      {periodLabel(m.period)}
                    </button>
                  </td>
                  <td className={`${tbl.td} ${tbl.num} text-fg-muted`}>{formatCLP(m.cuotas)}</td>
                  <td className={`${tbl.td} ${tbl.num} text-fg-muted`}>{formatCLP(m.fijos)}</td>
                  {anySavings && <td className={`${tbl.td} ${tbl.num} text-fg-muted`}>{formatCLP(m.ahorro)}</td>}
                  <td className={`${tbl.td} ${tbl.num} ${m.ingresoEstimado ? 'italic text-fg-subtle' : 'text-fg-muted'}`}>
                    {formatCLP(m.ingresos)}
                    {m.ingresoEstimado && <span className="sr-only"> (estimado)</span>}
                  </td>
                  <td className={`${tbl.td} ${tbl.num} font-medium ${isNegative(m.libre) ? 'text-negative-fg' : 'text-positive-fg'}`}>
                    {formatCLP(m.libre)}
                  </td>
                  <td className={`${tbl.td} ${tbl.num} hidden @2xl:table-cell ${isNegative(m.saldoProyectado) ? 'text-negative-fg' : 'text-fg-muted'}`}>
                    {formatCLP(m.saldoProyectado)}
                  </td>
                  <td className={`${tbl.td} hidden @4xl:table-cell`} aria-hidden="true">
                    <div className="relative h-3 w-full overflow-hidden rounded-full bg-sunken">
                      <div className="absolute inset-y-0 left-0 flex" style={{ width: `${ratio(m.comprometido, scale) * 100}%` }}>
                        <div className="h-full bg-accent" style={{ width: `${ratio(m.cuotas, m.comprometido) * 100}%` }} />
                        <div className="h-full flex-1 bg-caution-fg" />
                      </div>
                      <div className="absolute inset-y-0 w-0.5 bg-positive-fg" style={{ left: `${ratio(m.ingresos, scale) * 100}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-fg-muted">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-2 rounded-full bg-accent" /> Cuotas
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-2 rounded-full bg-caution-fg" /> Fijos
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-2.5 w-0.5 bg-positive-fg" /> Ingresos
          </span>
          {anyEstimated && <span className="italic">Ingresos en cursiva: estimados con el último sueldo registrado.</span>}
        </div>
      </Section>
    </div>
  )
}

function ForecastSkeleton() {
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">Cargando la proyección…</span>
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  )
}
