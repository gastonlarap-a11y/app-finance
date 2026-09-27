import { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { FinanceService, KIND_UNICO, type ExpenseFilter } from '@/services/finance'
import { periodAtom, tabAtom } from '@/atoms/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { useQuery } from '@/lib/useQuery'
import { formatCLP, formatDate, periodLabel, todayISO } from '@/lib/format'
import { exportBasename, searchTable } from '@/lib/exportTables'
import { BankCodes, Button, Empty, Field, QueryError, Section, Select, TagChips, inputCls } from './ui'
import { ExportButton } from './ExportButton'

const PAGE = 50
const MAX_RESULTS = 200 // backend cap per request
const DEBOUNCE_MS = 250

// useDebounced returns `value` once it has stopped changing for `ms`.
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

export function SearchView() {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const setPeriod = useSetAtom(periodAtom)
  const setTab = useSetAtom(tabAtom)

  const [text, setText] = useState('')
  const [category, setCategory] = useState('')
  const [tag, setTag] = useState('')
  const [cardId, setCardId] = useState('')
  const [fromPeriod, setFromPeriod] = useState('')
  const [toPeriod, setToPeriod] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const debouncedText = useDebounced(text.trim(), DEBOUNCE_MS)

  const options = useQuery(`options:${version}`, async () => {
    const [cats, cards, tags] = await Promise.all([FinanceService.ListCategories(), FinanceService.ListCards(), FinanceService.ListTags()])
    return { categories: cats.map((c) => c.name), cards, tags: tags.map((t) => t.name) }
  })

  const filter: ExpenseFilter = {
    text: debouncedText,
    category,
    tag,
    cardId: cardId === '' ? null : Number(cardId),
    fromPeriod,
    toPeriod,
    limit,
    offset: 0,
  }
  const results = useQuery(`${JSON.stringify(filter)}:${version}`, async () => {
    const res = await FinanceService.SearchExpenses(filter)
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'búsqueda vacía')
    return res.data
  })

  // Any filter change starts again from the first page.
  function changeFilter<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v)
      setLimit(PAGE)
    }
  }

  const hasFilters = text !== '' || category !== '' || tag !== '' || cardId !== '' || fromPeriod !== '' || toPeriod !== ''
  const data = results.data
  const stale = results.status === 'loading'

  return (
    <div className="space-y-5">
      <Section title="Buscar gastos">
        <form role="search" onSubmit={(e) => e.preventDefault()} className="grid gap-3 md:grid-cols-2 lg:grid-cols-6">
          <div className="lg:col-span-2">
            <Field label="Texto (descripción, comercio o código del banco)">
              <input
                type="search"
                className={inputCls}
                value={text}
                onChange={(e) => changeFilter(setText)(e.target.value)}
                placeholder="Ej: supermercado, Falabella, 12345678…"
              />
            </Field>
          </div>
          <Field label="Categoría">
            <Select value={category} onChange={(e) => changeFilter(setCategory)(e.target.value)}>
              <option value="">Todas</option>
              <option value="Sin categoría">Sin categoría</option>
              {options.data?.categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Etiqueta">
            <Select value={tag} onChange={(e) => changeFilter(setTag)(e.target.value)}>
              <option value="">Todas</option>
              {options.data?.tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tarjeta">
            <Select value={cardId} onChange={(e) => changeFilter(setCardId)(e.target.value)}>
              <option value="">Todas</option>
              {options.data?.cards.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Desde">
              <input type="month" className={inputCls} value={fromPeriod} onChange={(e) => changeFilter(setFromPeriod)(e.target.value)} />
            </Field>
            <Field label="Hasta">
              <input type="month" className={inputCls} value={toPeriod} onChange={(e) => changeFilter(setToPeriod)(e.target.value)} />
            </Field>
          </div>
        </form>
        {hasFilters && (
          <button
            type="button"
            className="mt-3 text-xs text-slate-400 hover:text-slate-200"
            onClick={() => {
              setText('')
              setCategory('')
              setTag('')
              setCardId('')
              setFromPeriod('')
              setToPeriod('')
              setLimit(PAGE)
            }}
          >
            Limpiar filtros
          </button>
        )}
      </Section>

      {results.status === 'error' ? (
        <QueryError message={results.error} onRetry={() => invalidate('ledger')} />
      ) : !data ? (
        <Empty>Buscando…</Empty>
      ) : data.count === 0 ? (
        <Empty>{hasFilters ? 'Ningún gasto coincide con la búsqueda.' : 'Aún no registras gastos.'}</Empty>
      ) : (
        <Section
          title={`${data.count} ${data.count === 1 ? 'gasto' : 'gastos'} · total ${formatCLP(data.sum)}`}
          action={<ExportButton build={() => searchTable(data.items)} basename={exportBasename('busqueda', todayISO())} />}
        >
          <div className={`overflow-x-auto transition-opacity ${stale ? 'opacity-60' : ''}`} aria-busy={stale} aria-live="polite">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-400">
                <tr>
                  <th className="pb-2">Fecha</th>
                  <th className="pb-2">Descripción</th>
                  <th className="hidden pb-2 md:table-cell">Categoría</th>
                  <th className="hidden pb-2 lg:table-cell">Tarjeta</th>
                  <th className="hidden pb-2 md:table-cell">Cuotas</th>
                  <th className="pb-2 text-right">Total</th>
                  <th className="pb-2">
                    <span className="sr-only">Ir al mes</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((hit) => {
                  const ex = hit.expense
                  const unico = ex.kind === KIND_UNICO
                  return (
                    <tr key={ex.id} className="border-t border-slate-800">
                      <td className="py-2 text-slate-400">{formatDate(ex.date)}</td>
                      <td className="py-2">
                        <div className="font-medium">{ex.description}</div>
                        {ex.merchant && <div className="text-xs text-slate-500">{ex.merchant}</div>}
                        <TagChips tags={hit.tags} />
                        <BankCodes codes={hit.references} />
                      </td>
                      <td className="hidden py-2 text-slate-400 md:table-cell">{ex.category || 'Sin categoría'}</td>
                      <td className="hidden py-2 text-slate-400 lg:table-cell">{hit.cardName || '—'}</td>
                      <td className="hidden py-2 text-slate-400 md:table-cell">
                        {unico ? 'Único' : `${hit.paidCount}/${ex.installmentsTotal} pagadas`}
                        {!unico && hit.firstPeriod && (
                          <div className="text-xs text-slate-500">
                            {periodLabel(hit.firstPeriod)} → {periodLabel(hit.lastPeriod)}
                          </div>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatCLP(hit.total)}
                        {!unico && <div className="text-xs text-slate-500">{formatCLP(ex.installmentAmount)} / mes</div>}
                      </td>
                      <td className="py-2 text-right">
                        {hit.firstPeriod && (
                          <button
                            type="button"
                            className="text-xs text-primary hover:underline"
                            onClick={() => {
                              setPeriod(hit.firstPeriod)
                              setTab('mes')
                            }}
                          >
                            Ver mes
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {data.items.length < data.count && (
            <div className="mt-4 flex items-center justify-center gap-3 text-sm text-slate-400">
              <span>
                Mostrando {data.items.length} de {data.count}
              </span>
              {limit < MAX_RESULTS ? (
                <Button variant="ghost" onClick={() => setLimit((l) => Math.min(MAX_RESULTS, l + PAGE))} disabled={stale}>
                  Cargar más
                </Button>
              ) : (
                <span>· Refina la búsqueda para ver el resto.</span>
              )}
            </div>
          )}
        </Section>
      )}
    </div>
  )
}
