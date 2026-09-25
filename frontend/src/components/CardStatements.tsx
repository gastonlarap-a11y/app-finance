import { useState, type ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  FinanceService,
  type CardStatementLineView,
  type CardStatementView,
} from '@/services/finance'
import { refreshAtom, tabAtom } from '@/atoms/finance'
import { failed } from '@/lib/result'
import { compare, isZero, subtract } from '@/lib/money'
import { useQuery } from '@/lib/useQuery'
import { formatAmount, formatCLP, formatDate, periodLabel } from '@/lib/format'
import { Button, Empty, Modal, QueryError, Section, Spinner } from './ui'

const KIND_LABEL: Record<string, string> = { nacional: 'Nacional', internacional: 'Internacional' }

const SECTION_LABEL: Record<string, string> = {
  pago: 'Pagos a la cuenta',
  compra: 'Compras',
  voluntario: 'Productos o servicios voluntarios',
  cargo: 'Cargos, comisiones e impuestos',
  abono: 'Abonos del banco',
}

const ITEM_STATUS_LABEL: Record<string, string> = {
  pendiente: 'Por revisar',
  confirmado: 'Confirmado',
  descartado: 'Descartado',
  conciliado: 'Conciliado',
}

function statementTitle(st: CardStatementView): string {
  return `${KIND_LABEL[st.kind] ?? st.kind} ${st.cardName || 'Tarjeta'} ••${st.cardLastDigits}`
}

function periodRange(st: CardStatementView): string {
  return st.periodFrom !== '' ? `${formatDate(st.periodFrom)} – ${formatDate(st.periodTo)}` : formatDate(st.statementDate)
}

// ComparisonLine says in words how the bank's charges (purchases, products and
// charges billed this period) compare with what the app has on that card.
function ComparisonLine({ st }: { st: CardStatementView }) {
  if (st.appCharges === null) {
    return (
      <span className="text-slate-500">
        {st.currency === 'CLP'
          ? 'Asocia los últimos 4 dígitos a una tarjeta para compararlo con tus gastos.'
          : 'Las compras en dólares se comparan en la bandeja, una por una.'}
      </span>
    )
  }
  const cmp = compare(st.bankCharges, st.appCharges)
  return (
    <span className={cmp === 0 ? 'text-success' : 'text-amber-200'}>
      Banco {formatCLP(st.bankCharges)} en compras y cargos · en la app {formatCLP(st.appCharges)}
      {cmp === 0 ? ' · cuadra' : ` · diferencia ${formatCLP(subtract(st.bankCharges, st.appCharges))}`}
    </span>
  )
}

// CardStatementsSection lists the imported credit-card statements, newest
// first, each compared with what the app has for that card and month.
export function CardStatementsSection() {
  const refresh = useAtomValue(refreshAtom)
  const bump = useSetAtom(refreshAtom)
  const reload = () => bump((n) => n + 1)
  const [open, setOpen] = useState<number | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const query = useQuery(String(refresh), async () => {
    const res = await FinanceService.ListCardStatements('')
    if (res.error) throw new Error(res.error.message)
    return res.data ?? []
  })

  async function remove(id: number) {
    setConfirmId(null)
    if (!failed(await FinanceService.DeleteCardStatement(id))) reload()
  }

  return (
    <Section title="Estados de cuenta">
      {query.status === 'error' ? (
        <QueryError message={query.error} onRetry={reload} />
      ) : !query.data ? (
        <Spinner />
      ) : query.data.length === 0 ? (
        <Empty>
          Aún no importas estados de cuenta. Hazlo desde Importar con el PDF que envía el banco: se guarda completo y sus compras se
          comparan con tus gastos.
        </Empty>
      ) : (
        <ul className="space-y-2">
          {query.data.map((st) => (
            <li key={st.id} className="flex flex-wrap items-start justify-between gap-3 rounded-base bg-surface p-3 ring-1 ring-slate-800">
              <div className="min-w-0 flex-1 space-y-1 text-sm">
                <div className="font-medium">
                  {statementTitle(st)} · {periodLabel(st.period)}
                </div>
                <div className="text-xs text-slate-400">
                  Período {periodRange(st)} · total a pagar{' '}
                  <strong className="tabular-nums text-slate-200">{formatAmount(st.totalBilled, st.currency)}</strong>
                  {st.dueDate !== '' && <> hasta el {formatDate(st.dueDate)}</>}
                  {st.pendingItems > 0 && <> · {st.pendingItems} por revisar en Importar</>}
                </div>
                <div className="text-xs">
                  <ComparisonLine st={st} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => setOpen(st.id)}>
                  Ver detalle
                </Button>
                {confirmId === st.id ? (
                  <>
                    <span className="text-sm text-danger">¿Eliminar?</span>
                    <Button variant="danger" onClick={() => remove(st.id)}>
                      Sí
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmId(null)}>
                      No
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" onClick={() => setConfirmId(st.id)}>
                    Eliminar
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {query.data && query.data.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          Eliminar un estado de cuenta no borra sus movimientos de la bandeja ni los gastos confirmados; sirve para volver a importarlo.
        </p>
      )}
      {open !== null && <CardStatementDetailModal id={open} onClose={() => setOpen(null)} />}
    </Section>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="tabular-nums text-slate-100">{children}</dd>
    </div>
  )
}

const pct = (v: string) => (v === '' ? '—' : `${v.replace('.', ',')}%`)

// lineOutcome says what became of a line in the app.
function lineOutcome(l: CardStatementLineView): string {
  if (l.section === 'pago') return ''
  if (l.expenseId != null && l.installmentId != null) return `Cuota de «${l.expenseDescription}»`
  if (l.expenseId != null) return `Gasto «${l.expenseDescription}»`
  const status = ITEM_STATUS_LABEL[l.itemStatus] ?? ''
  return l.redeemedPurchase !== '' ? `${status} · canje de «${l.redeemedPurchase}»` : status
}

function CardStatementDetailModal({ id, onClose }: { id: number; onClose: () => void }) {
  const refresh = useAtomValue(refreshAtom)
  const setTab = useSetAtom(tabAtom)
  const query = useQuery(`${id}:${refresh}`, async () => {
    const res = await FinanceService.GetCardStatement(id)
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'estado de cuenta no disponible')
    return res.data
  })
  const d = query.data
  const money = (v: string) => formatAmount(v, d?.statement.currency ?? 'CLP')

  return (
    <Modal title={d ? `${statementTitle(d.statement)} · ${periodLabel(d.statement.period)}` : 'Estado de cuenta'} onClose={onClose} wide>
      {query.status === 'error' ? (
        <p role="alert" className="text-sm text-red-200">
          No se pudo cargar: {query.error}
        </p>
      ) : !d ? (
        <Spinner />
      ) : (
        <div className="space-y-5 text-sm">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Fact label="Fecha del estado">{formatDate(d.statement.statementDate)}</Fact>
            <Fact label="Período facturado">{periodRange(d.statement)}</Fact>
            <Fact label="Pagar hasta">{d.statement.dueDate !== '' ? formatDate(d.statement.dueDate) : '—'}</Fact>
            <Fact label="Total a pagar">{money(d.statement.totalBilled)}</Fact>
            {d.statement.kind === 'nacional' && <Fact label="Monto mínimo">{money(d.statement.minimumPayment)}</Fact>}
            <Fact label="Cupo total">{money(d.statement.creditLimit)}</Fact>
            <Fact label="Cupo utilizado">{money(d.statement.creditUsed)}</Fact>
            <Fact label="Cupo disponible">{money(d.statement.creditAvailable)}</Fact>
            {d.statement.kind === 'nacional' && (
              <>
                <Fact label="Deuda aún no facturada">{money(d.statement.unbilledBalance)}</Fact>
                <Fact label="Costo prepago">{money(d.statement.prepaymentCost)}</Fact>
                <Fact label="Tasa rotativo / cuotas / avance">
                  {pct(d.statement.rateRevolving)} / {pct(d.statement.rateInstallments)} / {pct(d.statement.rateCashAdvance)}
                </Fact>
                <Fact label="CAE rotativo / cuotas / avance">
                  {pct(d.statement.caeRevolving)} / {pct(d.statement.caeInstallments)} / {pct(d.statement.caeCashAdvance)}
                </Fact>
                <Fact label="CAE prepago">{pct(d.statement.caePrepayment)}</Fact>
                <Fact label="Interés moratorio">{pct(d.statement.lateInterestRate)}</Fact>
              </>
            )}
            <Fact label="Facturado período anterior">{money(d.statement.previousBilled)}</Fact>
            <Fact label="Pagado período anterior">{money(d.statement.previousPaid)}</Fact>
          </dl>

          <p className="text-xs">
            <ComparisonLine st={d.statement} />
            {d.statement.pendingItems > 0 && (
              <>
                {' '}
                ·{' '}
                <button
                  type="button"
                  className="text-primary underline"
                  onClick={() => {
                    onClose()
                    setTab('importar')
                  }}
                >
                  revisar {d.statement.pendingItems} en Importar
                </button>
              </>
            )}
          </p>

          {Object.keys(SECTION_LABEL)
            .map((section) => [section, d.lines.filter((l) => l.section === section)] as const)
            .filter(([, lines]) => lines.length > 0)
            .map(([section, lines]) => (
              <div key={section}>
                <h4 className="mb-1 font-medium text-slate-200">{SECTION_LABEL[section]}</h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="py-1 pr-2 font-normal">Fecha</th>
                        <th className="py-1 pr-2 font-normal">Descripción</th>
                        <th className="py-1 pr-2 font-normal">Cuota</th>
                        <th className="py-1 pr-2 text-right font-normal">Cargo del mes</th>
                        <th className="py-1 font-normal">En la app</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l) => (
                        <tr key={l.id} className="border-t border-slate-800">
                          <td className="py-1 pr-2 whitespace-nowrap">{formatDate(l.operationDate)}</td>
                          <td className="py-1 pr-2 font-mono text-slate-100">
                            {l.description}
                            {(l.city || l.place) && <span className="text-slate-500"> · {l.city || l.place}</span>}
                            {l.originAmount !== '' && d.statement.currency !== 'CLP' && !isZero(l.originAmount) && l.originAmount !== l.installmentAmount && (
                              <span className="text-slate-500"> · origen {l.originAmount}</span>
                            )}
                          </td>
                          <td className="py-1 pr-2 whitespace-nowrap">
                            {l.installmentsTotal > 1 ? `${l.installmentNumber}/${l.installmentsTotal}` : ''}
                          </td>
                          <td className="py-1 pr-2 text-right tabular-nums whitespace-nowrap">{money(l.installmentAmount)}</td>
                          <td className="py-1 text-slate-400">{lineOutcome(l)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

          {d.schedule.length > 0 && (
            <div>
              <h4 className="mb-1 font-medium text-slate-200">Próximos vencimientos según el banco</h4>
              <ul className="flex flex-wrap gap-3 text-xs">
                {d.schedule.map((e) => (
                  <li key={e.id} className="rounded bg-surface px-2 py-1 ring-1 ring-slate-800">
                    {periodLabel(e.period)}: <span className="tabular-nums text-slate-100">{formatCLP(e.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

// StatementBanner compares, in the month view, what each card's statement
// bills for the period with what the app has on that card.
export function StatementBanner({ period, refresh }: { period: string; refresh: number }) {
  const query = useQuery(`${period}:${refresh}`, async () => (await FinanceService.ListCardStatements(period)).data ?? [])
  const statements = (query.data ?? []).filter((st) => st.currency === 'CLP')
  if (statements.length === 0) return null
  return (
    <div className="space-y-1 rounded-base bg-surface p-3 text-sm ring-1 ring-slate-800">
      {statements.map((st) => (
        <p key={st.id}>
          <span className="font-medium">Estado de cuenta {st.cardName || `••${st.cardLastDigits}`}</span>: total a pagar{' '}
          <strong className="tabular-nums">{formatCLP(st.totalBilled)}</strong>
          {st.dueDate !== '' && <> hasta el {formatDate(st.dueDate)}</>}.{' '}
          <span className="text-xs">
            <ComparisonLine st={st} />
          </span>
        </p>
      ))}
    </div>
  )
}
