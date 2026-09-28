import { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { FinanceService, KIND_UNICO, type ExpenseFilter } from '@/services/finance'
import { periodAtom } from '@/atoms/finance'
import { navigate } from '@/lib/useRoute'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { useQuery } from '@/lib/useQuery'
import { formatCLP, formatDate, periodLabel, todayISO } from '@/lib/format'
import { exportBasename, searchTable } from '@/lib/exportTables'
import { SearchX } from 'lucide-react'
import { categoryLooks } from '@/lib/look'
import {
  BankCodes,
  BankDescription,
  Button,
  EmptyState,
  Field,
  LookIcon,
  QueryError,
  Section,
  Select,
  SkeletonRows,
  TagChips,
  inputCls,
  tbl,
} from './ui'
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

// SearchView searches the whole history. `initialText` comes from the route
// (#/buscar?q=…), so a search can be opened from elsewhere already filled in.
export function SearchView({ initialText = '' }: { initialText?: string }) {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const setPeriod = useSetAtom(periodAtom)

  const [text, setText] = useState(initialText)
  const [category, setCategory] = useState('')
  const [tag, setTag] = useState('')
  const [cardId, setCardId] = useState('')
  const [fromPeriod, setFromPeriod] = useState('')
  const [toPeriod, setToPeriod] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const debouncedText = useDebounced(text.trim(), DEBOUNCE_MS)

  const options = useQuery(`options:${version}`, async () => {
    const [cats, cards, tags] = await Promise.all([FinanceService.ListCategories(), FinanceService.ListCards(), FinanceService.ListTags()])
    return { categories: cats.map((c) => c.name), looks: categoryLooks(cats), cards, tags: tags.map((t) => t.name) }
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
  const looks = options.data?.looks ?? categoryLooks([])
  const stale = results.status === 'loading'

  return (
    <div className="space-y-6">
      <Section title="Filtros">
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
          <Button
            variant="quiet"
            size="sm"
            className="mt-3"
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
          </Button>
        )}
      </Section>

      {results.status === 'error' ? (
        <QueryError message={results.error} onRetry={() => invalidate('ledger')} />
      ) : !data ? (
        <Section title="Resultados">
          <SkeletonRows rows={5} label="Buscando…" />
        </Section>
      ) : data.count === 0 ? (
        <EmptyState icon={SearchX} title={hasFilters ? 'Ningún gasto coincide con la búsqueda' : 'Aún no registras gastos'}>
          {hasFilters ? 'Prueba con menos filtros u otra palabra.' : 'Cuando agregues o importes gastos, podrás buscarlos aquí.'}
        </EmptyState>
      ) : (
        <Section
          title={`${data.count} ${data.count === 1 ? 'gasto' : 'gastos'} · total ${formatCLP(data.sum)}`}
          action={<ExportButton build={() => searchTable(data.items)} basename={exportBasename('busqueda', todayISO())} />}
        >
          <div className={`@container ${tbl.wrap} transition-opacity ${stale ? 'opacity-60' : ''}`} aria-busy={stale} aria-live="polite">
            <table className={tbl.table}>
              <thead className={tbl.thead}>
                <tr>
                  <th className={tbl.th}>Fecha</th>
                  <th className={tbl.th}>Descripción</th>
                  <th className={`${tbl.th} hidden @xl:table-cell`}>Categoría</th>
                  <th className={`${tbl.th} hidden @3xl:table-cell`}>Tarjeta</th>
                  <th className={`${tbl.th} hidden @xl:table-cell`}>Cuotas</th>
                  <th className={`${tbl.th} text-right`}>Total</th>
                  <th className={tbl.th}>
                    <span className="sr-only">Ir al mes</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((hit) => {
                  const ex = hit.expense
                  const unico = ex.kind === KIND_UNICO
                  return (
                    <tr key={ex.id} className={tbl.row}>
                      <td className={`${tbl.td} whitespace-nowrap text-fg-muted`}>{formatDate(ex.date)}</td>
                      <td className={tbl.td}>
                        <div className="flex items-start gap-2.5">
                          <LookIcon look={looks.byName(ex.category)} size="sm" />
                          <div className="min-w-0">
                            <div className="font-medium text-fg">{ex.description}</div>
                            {ex.merchant && <div className="text-xs text-fg-subtle">{ex.merchant}</div>}
                            <BankDescription text={hit.expense.bankDescription} />
                            <TagChips tags={hit.tags} />
                            <BankCodes codes={hit.references} />
                          </div>
                        </div>
                      </td>
                      <td className={`${tbl.td} hidden text-fg-muted @xl:table-cell`}>{ex.category || 'Sin categoría'}</td>
                      <td className={`${tbl.td} hidden text-fg-muted @3xl:table-cell`}>{hit.cardName || '—'}</td>
                      <td className={`${tbl.td} hidden text-fg-muted @xl:table-cell`}>
                        {unico ? 'Único' : `${hit.paidCount}/${ex.installmentsTotal} pagadas`}
                        {!unico && hit.firstPeriod && (
                          <div className="text-xs text-fg-subtle">
                            {periodLabel(hit.firstPeriod)} → {periodLabel(hit.lastPeriod)}
                          </div>
                        )}
                      </td>
                      <td className={`${tbl.td} ${tbl.num} text-fg`}>
                        {formatCLP(hit.total)}
                        {!unico && <div className="text-xs text-fg-subtle">{formatCLP(ex.installmentAmount)} / mes</div>}
                      </td>
                      <td className={`${tbl.td} text-right`}>
                        {hit.firstPeriod && (
                          <button
                            type="button"
                            className="whitespace-nowrap text-xs font-medium text-accent-fg underline-offset-2 hover:underline"
                            onClick={() => {
                              setPeriod(hit.firstPeriod)
                              navigate({ page: 'resumen' })
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
            <div className="mt-4 flex items-center justify-center gap-3 text-sm text-fg-muted">
              <span>
                Mostrando {data.items.length} de {data.count}
              </span>
              {limit < MAX_RESULTS ? (
                <Button variant="secondary" size="sm" onClick={() => setLimit((l) => Math.min(MAX_RESULTS, l + PAGE))} loading={stale}>
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
