import { useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { FinanceService } from '@/services/finance'
import { periodAtom, refreshAtom, tabAtom } from '@/atoms/finance'
import { useQuery } from '@/lib/useQuery'
import { compare, isNegative, maxAbs, ratio, sum } from '@/lib/money'
import { formatCLP, periodLabel } from '@/lib/format'
import { QueryError, Section, Spinner, StatCard } from './ui'

const HORIZONS = [6, 12, 24] as const
type Horizon = (typeof HORIZONS)[number]

// ForecastView answers "how much of my future income is already spoken for?":
// remaining installments + active fixed expenses per month, against the salary
// (the last known one when a month has none yet).
export function ForecastView() {
  const [period, setPeriod] = useAtom(periodAtom)
  const refresh = useAtomValue(refreshAtom)
  const bump = useSetAtom(refreshAtom)
  const setTab = useSetAtom(tabAtom)
  const [months, setMonths] = useState<Horizon>(12)

  const query = useQuery(`${period}:${months}:${refresh}`, async () => {
    const res = await FinanceService.CommitmentsForecast(period, months)
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'proyección vacía')
    return res.data
  })

  if (query.status === 'error') return <QueryError message={query.error} onRetry={() => bump((n) => n + 1)} />
  const data = query.data
  if (!data) return <Spinner />
  const stale = query.status === 'loading'

  const scale = maxAbs(data.flatMap((m) => [m.comprometido, m.ingresos]))
  const last = data[data.length - 1]
  const tightest = data.reduce<(typeof data)[number] | undefined>(
    (min, m) => (min === undefined || compare(m.libre, min.libre) < 0 ? m : min),
    undefined,
  )
  const anyEstimated = data.some((m) => m.ingresoEstimado)

  return (
    <div className={`space-y-5 transition-opacity ${stale ? 'opacity-60' : ''}`} aria-busy={stale}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-400">
          Lo ya comprometido desde <strong className="text-slate-200">{periodLabel(period)}</strong>: cuotas de compras hechas y
          gastos fijos activos.
        </p>
        <div role="radiogroup" aria-label="Horizonte" className="flex gap-1 rounded-base bg-surface-alt p-1">
          {HORIZONS.map((h) => (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={months === h}
              onClick={() => setMonths(h)}
              className={`rounded px-3 py-1 text-sm ${months === h ? 'bg-primary text-white' : 'text-slate-300 hover:text-white'}`}
            >
              {h} meses
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
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
        <StatCard
          label="Cuotas por pagar"
          value={formatCLP(sum(data.map((m) => m.cuotas)))}
          hint={`En los próximos ${months} meses`}
        />
      </div>

      <Section title="Mes a mes">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="pb-2">Mes</th>
                <th className="pb-2 text-right">Cuotas</th>
                <th className="pb-2 text-right">Fijos</th>
                <th className="pb-2 text-right">Ingresos</th>
                <th className="pb-2 text-right">Libre</th>
                <th className="hidden pb-2 text-right md:table-cell">Saldo proy.</th>
                <th className="hidden w-1/4 pb-2 pl-4 lg:table-cell">
                  <span className="sr-only">Comprometido vs ingresos</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.period} className="border-t border-slate-800">
                  <td className="py-2">
                    <button
                      type="button"
                      className="rounded font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
                      onClick={() => {
                        setPeriod(m.period)
                        setTab('mes')
                      }}
                    >
                      {periodLabel(m.period)}
                    </button>
                  </td>
                  <td className="py-2 text-right tabular-nums text-slate-300">{formatCLP(m.cuotas)}</td>
                  <td className="py-2 text-right tabular-nums text-slate-300">{formatCLP(m.fijos)}</td>
                  <td className={`py-2 text-right tabular-nums ${m.ingresoEstimado ? 'italic text-slate-400' : 'text-slate-300'}`}>
                    {formatCLP(m.ingresos)}
                    {m.ingresoEstimado && <span className="sr-only"> (estimado)</span>}
                  </td>
                  <td className={`py-2 text-right font-medium tabular-nums ${isNegative(m.libre) ? 'text-danger' : 'text-success'}`}>
                    {formatCLP(m.libre)}
                  </td>
                  <td
                    className={`hidden py-2 text-right tabular-nums md:table-cell ${
                      isNegative(m.saldoProyectado) ? 'text-danger' : 'text-slate-300'
                    }`}
                  >
                    {formatCLP(m.saldoProyectado)}
                  </td>
                  <td className="hidden py-2 pl-4 lg:table-cell" aria-hidden="true">
                    <div className="relative h-3 w-full overflow-hidden rounded-full bg-surface">
                      <div className="absolute inset-y-0 left-0 flex" style={{ width: `${ratio(m.comprometido, scale) * 100}%` }}>
                        <div className="h-full bg-primary" style={{ width: `${ratio(m.cuotas, m.comprometido) * 100}%` }} />
                        <div className="h-full flex-1 bg-warning" />
                      </div>
                      <div className="absolute inset-y-0 w-0.5 bg-success" style={{ left: `${ratio(m.ingresos, scale) * 100}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-500">
          <span>
            <span className="mr-1 inline-block size-2 rounded-full bg-primary" /> Cuotas
          </span>
          <span>
            <span className="mr-1 inline-block size-2 rounded-full bg-warning" /> Fijos
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-0.5 bg-success" /> Ingresos
          </span>
          {anyEstimated && <span className="italic">Ingresos en cursiva: estimados con el último sueldo registrado.</span>}
        </div>
      </Section>
    </div>
  )
}
