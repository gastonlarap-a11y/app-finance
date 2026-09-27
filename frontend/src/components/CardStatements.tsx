import { useState, type ReactNode } from 'react'
import { CircleCheck, Eye, FileText } from 'lucide-react'
import {
  FinanceService,
  type CardStatementLineView,
  type CardStatementView,
} from '@/services/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { navigate } from '@/lib/useRoute'
import { failed } from '@/lib/result'
import { compare, isZero, subtract } from '@/lib/money'
import { useQuery } from '@/lib/useQuery'
import { formatAmount, formatCLP, formatDate, periodLabel } from '@/lib/format'
import { Button, Callout, ConfirmAction, EmptyState, Modal, QueryError, Section, SkeletonRows } from './ui'

const KIND_LABEL: Record<string, string> = { nacional: 'Nacional', internacional: 'Internacional' }

const SECTION_LABEL: Record<string, string> = {
  pago: 'Pagos a la cuenta',
  compra: 'Compras',
  voluntario: 'Productos o servicios voluntarios',
  cargo: 'Cargos, comisiones e impuestos',
  abono: 'Abonos del banco',
  diferida: 'Compras en cuotas que comienzan el próximo período',
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
      <span className="text-fg-subtle">
        {st.cardName === ''
          ? `Sin tarjeta: escribe ${st.cardLastDigits} como últimos 4 dígitos de tu tarjeta (en Configuración › Tarjetas) y se asociarán sus estados nacional e internacional.`
          : 'Las compras en dólares se comparan en la bandeja, una por una.'}
      </span>
    )
  }
  const matches = compare(st.bankCharges, st.appCharges) === 0
  return (
    <span className={`inline-flex flex-wrap items-center gap-x-1 ${matches ? 'text-positive-fg' : 'text-caution-fg'}`}>
      {matches && <CircleCheck aria-hidden="true" className="size-3.5" />}
      Banco {formatCLP(st.bankCharges)} en compras y cargos · en la app {formatCLP(st.appCharges)}
      {matches ? ' · cuadra' : ` · diferencia ${formatCLP(subtract(st.bankCharges, st.appCharges))}`}
    </span>
  )
}

// CardStatementsSection lists the imported credit-card statements, newest
// first, each compared with what the app has for that card and month.
export function CardStatementsSection() {
  const version = useVersion('imports', 'ledger')
  const invalidate = useInvalidate()
  // Deleting a statement unlinks its lines from cuotas and drops its inbox items.
  const reload = () => invalidate('imports', 'ledger')
  const [open, setOpen] = useState<number | null>(null)
  const query = useQuery(version, async () => {
    const res = await FinanceService.ListCardStatements('')
    if (res.error) throw new Error(res.error.message)
    return res.data ?? []
  })

  async function remove(id: number) {
    if (!failed(await FinanceService.DeleteCardStatement(id))) reload()
  }

  return (
    <Section title="Estados de cuenta">
      {query.status === 'error' ? (
        <QueryError message={query.error} onRetry={reload} />
      ) : !query.data ? (
        <SkeletonRows rows={3} />
      ) : query.data.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="Aún no importas estados de cuenta"
          action={
            <Button variant="secondary" onClick={() => navigate({ page: 'importar', tab: 'bandeja' })}>
              Ir a la Bandeja
            </Button>
          }
        >
          Impórtalos desde la Bandeja con el PDF de la tarjeta (Itaú, el del correo o el de su web, o Banco de Chile): se guardan
          completos y sus compras se comparan con tus gastos.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {query.data.map((st) => (
            <li key={st.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg bg-sunken p-3 ring-1 ring-inset ring-line">
              <div className="min-w-0 flex-1 space-y-1 text-sm">
                <div className="font-medium text-fg">
                  {statementTitle(st)} · {periodLabel(st.period)}
                </div>
                <div className="text-xs text-fg-muted">
                  Período {periodRange(st)} · total a pagar{' '}
                  <strong className="tabular-nums text-fg">{formatAmount(st.totalBilled, st.currency)}</strong>
                  {st.dueDate !== '' && <> hasta el {formatDate(st.dueDate)}</>}
                  {st.pendingItems > 0 && <> · {st.pendingItems} por revisar en la Bandeja</>}
                </div>
                <div className="text-xs">
                  <ComparisonLine st={st} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" icon={Eye} onClick={() => setOpen(st.id)}>
                  Ver detalle
                </Button>
                <ConfirmAction label={`Eliminar el estado ${statementTitle(st)} de ${periodLabel(st.period)}`} iconOnly onConfirm={() => remove(st.id)} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {query.data && query.data.length > 0 && (
        <p className="mt-3 text-xs text-fg-subtle">
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
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="tabular-nums text-fg">{children}</dd>
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

const cell = 'py-1.5 pr-3'

function CardStatementDetailModal({ id, onClose }: { id: number; onClose: () => void }) {
  const version = useVersion('imports', 'ledger')
  const query = useQuery(`${id}:${version}`, async () => {
    const res = await FinanceService.GetCardStatement(id)
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'estado de cuenta no disponible')
    return res.data
  })
  const d = query.data
  const money = (v: string) => formatAmount(v, d?.statement.currency ?? 'CLP')

  return (
    <Modal title={d ? `${statementTitle(d.statement)} · ${periodLabel(d.statement.period)}` : 'Estado de cuenta'} onClose={onClose} wide>
      {query.status === 'error' ? (
        <Callout tone="negative" role="alert">
          No se pudo cargar: {query.error}
        </Callout>
      ) : !d ? (
        <SkeletonRows rows={6} />
      ) : (
        <div className="space-y-5 text-sm">
          <dl className="grid grid-cols-2 gap-3 rounded-lg bg-sunken p-4 sm:grid-cols-4">
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
                  className="font-medium text-accent-fg underline-offset-2 hover:underline"
                  onClick={() => {
                    onClose()
                    navigate({ page: 'importar', tab: 'bandeja' })
                  }}
                >
                  revisar {d.statement.pendingItems} en la Bandeja
                </button>
              </>
            )}
          </p>

          {Object.keys(SECTION_LABEL)
            .map((section) => [section, d.lines.filter((l) => l.section === section)] as const)
            .filter(([, lines]) => lines.length > 0)
            .map(([section, lines]) => (
              <div key={section}>
                <h4 className="mb-1 font-semibold text-fg">{SECTION_LABEL[section]}</h4>
                <div className="relative overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-fg-subtle">
                      <tr>
                        <th className={`${cell} font-medium`}>Fecha</th>
                        <th className={`${cell} font-medium`}>Código</th>
                        <th className={`${cell} font-medium`}>Descripción</th>
                        <th className={`${cell} font-medium`}>Cuota</th>
                        <th className={`${cell} text-right font-medium`}>Cargo del mes</th>
                        <th className="py-1.5 font-medium">En la app</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l) => (
                        <tr key={l.id} className="border-t border-line">
                          <td className={`${cell} whitespace-nowrap text-fg-muted`}>{formatDate(l.operationDate)}</td>
                          {/* The bank's code, quoted to dispute a charge: one click selects it whole. */}
                          <td className={`${cell} select-all whitespace-nowrap font-mono text-fg-muted`}>{l.reference}</td>
                          <td className={`${cell} font-mono text-fg`}>
                            {l.description}
                            {(l.city || l.place) && <span className="text-fg-subtle"> · {l.city || l.place}</span>}
                            {l.originAmount !== '' && d.statement.currency !== 'CLP' && !isZero(l.originAmount) && l.originAmount !== l.installmentAmount && (
                              <span className="text-fg-subtle"> · origen {l.originAmount}</span>
                            )}
                          </td>
                          <td className={`${cell} whitespace-nowrap text-fg-muted`}>
                            {l.installmentsTotal > 1 ? `${l.installmentNumber}/${l.installmentsTotal}` : ''}
                          </td>
                          <td className={`${cell} whitespace-nowrap text-right tabular-nums text-fg`}>{money(l.installmentAmount)}</td>
                          <td className="py-1.5 text-fg-muted">{lineOutcome(l)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

          {d.schedule.length > 0 && (
            <div>
              <h4 className="mb-1 font-semibold text-fg">Próximos vencimientos según el banco</h4>
              <ul className="flex flex-wrap gap-2 text-xs">
                {d.schedule.map((e) => (
                  <li key={e.id} className="rounded-md bg-sunken px-2 py-1 text-fg-muted ring-1 ring-inset ring-line">
                    {periodLabel(e.period)}: <span className="tabular-nums text-fg">{formatCLP(e.amount)}</span>
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
export function StatementBanner({ period }: { period: string }) {
  const version = useVersion('imports', 'ledger')
  const query = useQuery(`${period}:${version}`, async () => (await FinanceService.ListCardStatements(period)).data ?? [])
  const statements = (query.data ?? []).filter((st) => st.currency === 'CLP')
  if (statements.length === 0) return null
  return (
    <div className="space-y-1.5 rounded-xl bg-panel px-4 py-3 text-sm shadow-xs ring-1 ring-line">
      {statements.map((st) => (
        <p key={st.id} className="flex flex-wrap items-start gap-x-2">
          <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
          <span className="min-w-0 flex-1 text-fg">
            <span className="font-medium">Estado de cuenta {st.cardName || `••${st.cardLastDigits}`}</span>: total a pagar{' '}
            <strong className="tabular-nums">{formatCLP(st.totalBilled)}</strong>
            {st.dueDate !== '' && <> hasta el {formatDate(st.dueDate)}</>}.{' '}
            <span className="text-xs">
              <ComparisonLine st={st} />
            </span>
          </span>
        </p>
      ))}
    </div>
  )
}
