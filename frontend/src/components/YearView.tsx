import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { FinanceService, type CategoryYearRow, type YearSummary } from '@/services/finance'
import { periodAtom, refreshAtom, tabAtom } from '@/atoms/finance'
import { useQuery } from '@/lib/useQuery'
import { isNegative, isZero, maxAbs, ratio } from '@/lib/money'
import { formatCLP, monthLabel, yearOf } from '@/lib/format'
import { Bar, Empty, QueryError, Section, Spinner, StatCard } from './ui'

function signTone(v: string): string {
  return isNegative(v) ? 'text-danger' : 'text-success'
}

function hasActivity(data: YearSummary): boolean {
  return data.months.some((m) => !isZero(m.ingresos) || !isZero(m.gastos))
}

export function YearView() {
  const [period, setPeriod] = useAtom(periodAtom)
  const refresh = useAtomValue(refreshAtom)
  const bump = useSetAtom(refreshAtom)
  const setTab = useSetAtom(tabAtom)
  const year = yearOf(period)

  const query = useQuery(`${year}:${refresh}`, async () => {
    const res = await FinanceService.YearSummary(year)
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'resumen vacío')
    return res.data
  })

  function goToMonth(p: string) {
    setPeriod(p)
    setTab('mes')
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={() => bump((n) => n + 1)} />
  const data = query.data
  if (!data) return <Spinner />
  const stale = query.status === 'loading'

  if (!hasActivity(data)) {
    return <Empty>Sin datos para {year}. Registra sueldo o gastos en la pestaña Mes.</Empty>
  }

  const barMax = maxAbs(data.months.flatMap((m) => [m.gastos, m.ingresos]))

  return (
    <div className={`space-y-5 transition-opacity ${stale ? 'opacity-60' : ''}`} aria-busy={stale}>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatCard label={`Ingresos ${year}`} value={formatCLP(data.totalIngresos)} tone="primary" />
        <StatCard label={`Gastos ${year}`} value={formatCLP(data.totalGastos)} />
        <StatCard
          label={`Balance ${year}`}
          value={formatCLP(data.totalBalance)}
          tone={isNegative(data.totalBalance) ? 'danger' : 'success'}
        />
      </div>

      <Section title={`Meses de ${year}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="pb-2">Mes</th>
                <th className="pb-2 text-right">Ingresos</th>
                <th className="pb-2 text-right">Gastos</th>
                <th className="pb-2 text-right">Balance</th>
                <th className="pb-2 text-right">Saldo acum.</th>
                <th className="pb-2 text-center">¿Alcanza?</th>
              </tr>
            </thead>
            <tbody>
              {data.months.map((m) => (
                <tr key={m.period} className="border-t border-slate-800">
                  <td className="py-2">
                    <button
                      type="button"
                      onClick={() => goToMonth(m.period)}
                      className="rounded font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      {monthLabel(m.period)}
                    </button>
                  </td>
                  <td className="py-2 text-right tabular-nums text-slate-300">{formatCLP(m.ingresos)}</td>
                  <td className="py-2 text-right tabular-nums text-slate-300">{formatCLP(m.gastos)}</td>
                  <td className={`py-2 text-right tabular-nums ${signTone(m.balance)}`}>{formatCLP(m.balance)}</td>
                  <td className={`py-2 text-right tabular-nums ${signTone(m.saldo)}`}>{formatCLP(m.saldo)}</td>
                  <td className="py-2 text-center">
                    <span aria-label={m.alcanza ? 'Sí alcanza' : 'No alcanza'}>{m.alcanza ? '✓' : '✕'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 grid grid-cols-12 items-end gap-1" style={{ height: 80 }} aria-hidden="true">
          {data.months.map((m) => (
            <div key={m.period} className="flex flex-col items-center gap-1" title={`${monthLabel(m.period)}: ${formatCLP(m.gastos)}`}>
              <div className="flex h-16 w-full items-end">
                <div
                  className={`w-full rounded-t ${m.alcanza ? 'bg-primary' : 'bg-danger'}`}
                  style={{ height: `${Math.round(ratio(m.gastos, barMax) * 100)}%` }}
                />
              </div>
              <span className="text-[10px] text-slate-500">{monthLabel(m.period).slice(0, 3)}</span>
            </div>
          ))}
        </div>
      </Section>

      {data.categoriaMeses.length > 0 && (
        <CategoryHeatmap
          year={year}
          rows={data.categoriaMeses}
          months={data.months.map((m) => m.period)}
          monthTotals={data.months.map((m) => m.gastos)}
          total={data.totalGastos}
          onMonth={goToMonth}
        />
      )}
    </div>
  )
}

// CategoryHeatmap is the category × month spending table: each cell's tint is
// proportional to the largest cell of the year, so the months where a category
// spikes stand out at a glance.
function CategoryHeatmap({
  year,
  rows,
  months,
  monthTotals,
  total,
  onMonth,
}: {
  year: number
  rows: CategoryYearRow[]
  months: string[]
  monthTotals: string[]
  total: string
  onMonth: (period: string) => void
}) {
  const cellMax = maxAbs(rows.flatMap((r) => r.months))
  return (
    <Section title={`Gasto por categoría y mes ${year}`}>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0.5 text-xs">
          <thead className="text-slate-400">
            <tr>
              <th className="sticky left-0 bg-surface-alt pb-2 text-left">Categoría</th>
              {months.map((p) => (
                <th key={p} className="pb-2 text-right font-medium">
                  <button type="button" onClick={() => onMonth(p)} className="rounded hover:text-primary focus-visible:outline-2 focus-visible:outline-primary">
                    {monthLabel(p).slice(0, 3)}
                  </button>
                </th>
              ))}
              <th className="pb-2 text-right">Total</th>
              <th className="pb-2 pl-2 text-left">
                <span className="sr-only">Proporción del año</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.category}>
                <th scope="row" className="sticky left-0 max-w-40 truncate bg-surface-alt py-1 pr-2 text-left font-normal text-slate-300">
                  {r.category}
                </th>
                {r.months.map((v, i) => (
                  <td
                    key={months[i]}
                    className="rounded px-1.5 py-1 text-right tabular-nums"
                    style={isZero(v) ? undefined : { backgroundColor: `color-mix(in oklab, var(--color-primary) ${Math.round(15 + ratio(v, cellMax) * 70)}%, transparent)` }}
                    title={`${r.category} · ${monthLabel(months[i] ?? '')}: ${formatCLP(v)}`}
                  >
                    {isZero(v) ? <span className="text-slate-600">·</span> : formatCLP(v)}
                  </td>
                ))}
                <td className="py-1 pl-2 text-right font-medium tabular-nums">{formatCLP(r.total)}</td>
                <td className="w-24 py-1 pl-2">
                  <Bar fill={ratio(r.total, total)} />
                </td>
              </tr>
            ))}
            <tr className="text-slate-300">
              <th scope="row" className="sticky left-0 bg-surface-alt pt-2 text-left">
                Total
              </th>
              {monthTotals.map((v, i) => (
                <td key={months[i]} className="px-1.5 pt-2 text-right font-medium tabular-nums">
                  {formatCLP(v)}
                </td>
              ))}
              <td className="pl-2 pt-2 text-right font-semibold tabular-nums">{formatCLP(total)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </Section>
  )
}
