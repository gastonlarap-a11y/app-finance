import { useAtom } from 'jotai'
import { ChartColumn, CircleCheck, CircleX } from 'lucide-react'
import { FinanceService, type CategoryYearRow, type YearSummary } from '@/services/finance'
import { periodAtom } from '@/atoms/finance'
import { navigate } from '@/lib/useRoute'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { useQuery } from '@/lib/useQuery'
import { isNegative, isZero, maxAbs, ratio } from '@/lib/money'
import { formatCLP, monthLabel, yearOf } from '@/lib/format'
import { Bar, Button, EmptyState, LookIcon, QueryError, Section, Skeleton, StatCard, tbl } from './ui'
import { ExportButton } from './ExportButton'
import { useCategoryLooks } from './useCategoryLooks'
import { exportBasename, yearTable } from '@/lib/exportTables'

function signTone(v: string): string {
  return isNegative(v) ? 'text-negative-fg' : 'text-positive-fg'
}

function hasActivity(data: YearSummary): boolean {
  return data.months.some((m) => !isZero(m.ingresos) || !isZero(m.gastos))
}

// Heatmap tint range (percent of the accent over the card). Capped so the
// cell's text keeps AA contrast on the most intense cell in both themes.
const HEAT_MIN = 12
const HEAT_MAX = 70

export function YearView() {
  const [period, setPeriod] = useAtom(periodAtom)
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const year = yearOf(period)

  const query = useQuery(`${year}:${version}`, async () => {
    const res = await FinanceService.YearSummary(year)
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'resumen vacío')
    return res.data
  })

  function goToMonth(p: string) {
    setPeriod(p)
    navigate({ page: 'resumen' })
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={() => invalidate('ledger')} />
  const data = query.data
  if (!data) return <YearSkeleton />
  const stale = query.status === 'loading'

  if (!hasActivity(data)) {
    return (
      <EmptyState
        icon={ChartColumn}
        title={`Sin datos para ${year}`}
        action={
          <Button variant="secondary" onClick={() => navigate({ page: 'resumen' })}>
            Ir al Resumen del mes
          </Button>
        }
      >
        Registra tu sueldo o tus gastos en el Resumen y aquí verás el año completo.
      </EmptyState>
    )
  }

  const barMax = maxAbs(data.months.flatMap((m) => [m.gastos, m.ingresos]))
  const hasSavings = !isZero(data.totalAhorro)

  return (
    <div className={`space-y-6 transition-opacity ${stale ? 'opacity-60' : ''}`} aria-busy={stale}>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={`Ingresos ${year}`} value={formatCLP(data.totalIngresos)} tone="primary" />
        <StatCard label={`Gastos ${year}`} value={formatCLP(data.totalGastos)} />
        <StatCard
          label={`Balance ${year}`}
          value={formatCLP(data.totalBalance)}
          tone={isNegative(data.totalBalance) ? 'danger' : 'success'}
        />
      </div>

      <Section title={`Meses de ${year}`} action={<ExportButton build={() => yearTable(data)} basename={exportBasename('anio', String(year))} />}>
        <div className={tbl.wrap}>
          <table className={tbl.table}>
            <thead className={tbl.thead}>
              <tr>
                <th className={tbl.th}>Mes</th>
                <th className={`${tbl.th} text-right`}>Ingresos</th>
                <th className={`${tbl.th} text-right`}>Gastos</th>
                {hasSavings && <th className={`${tbl.th} text-right`}>Ahorro</th>}
                <th className={`${tbl.th} text-right`}>Balance</th>
                <th className={`${tbl.th} text-right`}>Saldo acum.</th>
                <th className={`${tbl.th} text-center`}>¿Alcanza?</th>
              </tr>
            </thead>
            <tbody>
              {data.months.map((m) => (
                <tr key={m.period} className={tbl.row}>
                  <td className={tbl.td}>
                    <button type="button" onClick={() => goToMonth(m.period)} className="rounded font-medium text-fg hover:text-accent-fg hover:underline">
                      {monthLabel(m.period)}
                    </button>
                  </td>
                  <td className={`${tbl.td} ${tbl.num} text-fg-muted`}>{formatCLP(m.ingresos)}</td>
                  <td className={`${tbl.td} ${tbl.num} text-fg-muted`}>{formatCLP(m.gastos)}</td>
                  {hasSavings && <td className={`${tbl.td} ${tbl.num} text-fg-muted`}>{formatCLP(m.ahorro)}</td>}
                  <td className={`${tbl.td} ${tbl.num} ${signTone(m.balance)}`}>{formatCLP(m.balance)}</td>
                  <td className={`${tbl.td} ${tbl.num} ${signTone(m.saldo)}`}>
                    <span className="inline-flex items-center gap-1">
                      {formatCLP(m.saldo)}
                      {m.conciliado && (
                        <span className="text-fg-subtle" title="Saldo real conciliado con el banco">
                          <CircleCheck aria-hidden="true" className="size-3.5" />
                          <span className="sr-only"> conciliado</span>
                        </span>
                      )}
                    </span>
                  </td>
                  <td className={`${tbl.td} text-center`}>
                    {m.alcanza ? (
                      <CircleCheck aria-label="Sí alcanza" className="mx-auto size-4 text-positive-fg" />
                    ) : (
                      <CircleX aria-label="No alcanza" className="mx-auto size-4 text-negative-fg" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-5 grid grid-cols-12 items-end gap-1" style={{ height: 88 }} aria-hidden="true">
          {data.months.map((m) => (
            <div key={m.period} className="flex flex-col items-center gap-1" title={`${monthLabel(m.period)}: ${formatCLP(m.gastos)}`}>
              <div className="flex h-16 w-full items-end">
                <div
                  className={`w-full rounded-t-md ${m.alcanza ? 'bg-accent' : 'bg-negative-fg'}`}
                  style={{ height: `${Math.round(ratio(m.gastos, barMax) * 100)}%` }}
                />
              </div>
              <span className="text-[10px] text-fg-subtle">{monthLabel(m.period).slice(0, 3)}</span>
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
// spikes stand out at a glance. The amount is always written in the cell.
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
  const looks = useCategoryLooks()
  return (
    <Section title={`Gasto por categoría y mes ${year}`}>
      <div className={tbl.wrap}>
        <table className="w-full border-separate border-spacing-0.5 text-xs">
          <thead className="text-fg-subtle">
            <tr>
              <th className="sticky left-0 bg-panel pb-2 text-left font-medium">Categoría</th>
              {months.map((p) => (
                <th key={p} className="pb-2 text-right font-medium">
                  <button type="button" onClick={() => onMonth(p)} className="rounded hover:text-accent-fg hover:underline">
                    {monthLabel(p).slice(0, 3)}
                  </button>
                </th>
              ))}
              <th className="pb-2 text-right font-medium">Total</th>
              <th className="pb-2 pl-2 text-left">
                <span className="sr-only">Proporción del año</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.category}>
                <th scope="row" className="sticky left-0 max-w-44 bg-panel py-1 pr-2 text-left font-normal text-fg">
                  <span className="flex items-center gap-1.5">
                    <LookIcon look={looks.byName(r.category)} size="sm" />
                    <span className="truncate">{r.category}</span>
                  </span>
                </th>
                {r.months.map((v, i) => (
                  <td
                    key={months[i]}
                    className="rounded px-1.5 py-1 text-right tabular-nums text-fg"
                    style={
                      isZero(v)
                        ? undefined
                        : { backgroundColor: `color-mix(in oklab, var(--color-accent) ${Math.round(HEAT_MIN + ratio(v, cellMax) * (HEAT_MAX - HEAT_MIN))}%, transparent)` }
                    }
                  >
                    {isZero(v) ? <span className="text-fg-subtle">·</span> : formatCLP(v)}
                  </td>
                ))}
                <td className="py-1 pl-2 text-right font-medium tabular-nums text-fg">{formatCLP(r.total)}</td>
                <td className="w-24 py-1 pl-2">
                  <Bar fill={ratio(r.total, total)} />
                </td>
              </tr>
            ))}
            <tr className="text-fg">
              <th scope="row" className="sticky left-0 bg-panel pt-2 text-left">
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

function YearSkeleton() {
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">Cargando el año…</span>
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  )
}
