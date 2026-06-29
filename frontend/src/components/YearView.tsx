import { useEffect, useState } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { FinanceService, type YearSummary } from '@/services/finance'
import { periodAtom, refreshAtom, tabAtom } from '@/atoms/finance'
import { formatCLP, monthLabel, yearOf } from '@/lib/format'
import { Bar, Empty, Section, Spinner, StatCard } from './ui'

export function YearView() {
  const [period, setPeriod] = useAtom(periodAtom)
  const [refresh] = useAtom(refreshAtom)
  const setTab = useSetAtom(tabAtom)
  const year = yearOf(period)

  const [data, setData] = useState<YearSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    FinanceService.YearSummary(year)
      .then((res) => {
        if (!active) return
        if (res.error) window.alert(res.error.message)
        setData(res.data ?? null)
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [year, refresh])

  function goToMonth(p: string) {
    setPeriod(p)
    setTab('mes')
  }

  if (loading && !data) return <Spinner />
  if (!data) return <Empty>No se pudo cargar el resumen anual.</Empty>

  const maxAbs = Math.max(
    1,
    ...data.months.map((m) => Math.abs(Number(m.gastos) || 0)),
    ...data.months.map((m) => Math.abs(Number(m.ingresos) || 0)),
  )

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatCard label={`Ingresos ${year}`} value={formatCLP(data.totalIngresos)} tone="primary" />
        <StatCard label={`Gastos ${year}`} value={formatCLP(data.totalGastos)} />
        <StatCard
          label={`Balance ${year}`}
          value={formatCLP(data.totalBalance)}
          tone={(Number(data.totalBalance) || 0) >= 0 ? 'success' : 'danger'}
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
              {data.months.map((m) => {
                const bal = Number(m.balance) || 0
                const saldo = Number(m.saldo) || 0
                return (
                  <tr key={m.period} className="border-t border-slate-800">
                    <td className="py-2">
                      <button onClick={() => goToMonth(m.period)} className="font-medium hover:text-primary">
                        {monthLabel(m.period)}
                      </button>
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-300">{formatCLP(m.ingresos)}</td>
                    <td className="py-2 text-right tabular-nums text-slate-300">{formatCLP(m.gastos)}</td>
                    <td className={`py-2 text-right tabular-nums ${bal >= 0 ? 'text-success' : 'text-danger'}`}>
                      {formatCLP(m.balance)}
                    </td>
                    <td className={`py-2 text-right tabular-nums ${saldo >= 0 ? 'text-success' : 'text-danger'}`}>
                      {formatCLP(m.saldo)}
                    </td>
                    <td className="py-2 text-center">{m.alcanza ? '✓' : '✕'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-4 grid grid-cols-12 items-end gap-1" style={{ height: 80 }}>
          {data.months.map((m) => {
            const g = Number(m.gastos) || 0
            const h = Math.round((Math.abs(g) / maxAbs) * 100)
            return (
              <div key={m.period} className="flex flex-col items-center gap-1" title={`${monthLabel(m.period)}: ${formatCLP(m.gastos)}`}>
                <div className="flex h-16 w-full items-end">
                  <div className={`w-full rounded-t ${m.alcanza ? 'bg-primary' : 'bg-danger'}`} style={{ height: `${h}%` }} />
                </div>
                <span className="text-[10px] text-slate-500">{monthLabel(m.period).slice(0, 3)}</span>
              </div>
            )
          })}
        </div>
      </Section>

      {data.porCategoria.length > 0 && (
        <Section title={`Gastos por categoría ${year}`}>
          <ul className="space-y-2">
            {data.porCategoria.map((c) => (
              <li key={c.category} className="flex items-center justify-between gap-3 text-sm">
                <span className="w-40 shrink-0 truncate text-slate-300">{c.category}</span>
                <div className="flex-1">
                  <Bar value={Number(c.total)} max={Number(data.totalGastos) || 1} />
                </div>
                <span className="w-28 shrink-0 text-right tabular-nums">{formatCLP(c.total)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}
