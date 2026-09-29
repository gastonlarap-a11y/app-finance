import { useState, type ReactNode, type SubmitEvent } from 'react'
import { CheckCheck, FileText, Inbox, TriangleAlert } from 'lucide-react'
import {
  FinanceService,
  KIND_CUOTAS,
  KIND_UNICO,
  type Card,
  type ImportItemView,
  type OpResult,
} from '@/services/finance'
import type { ImportStatus } from '@/services/contract'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import type { ImportTab } from '@/lib/route'
import { navigate } from '@/lib/useRoute'
import { CardStatementsSection } from './CardStatements'
import { Link } from './Link'
import { errMsg, failed } from '@/lib/result'
import { notify } from '@/lib/notify'
import { perInstallment } from '@/lib/money'
import { errorText, useQuery } from '@/lib/useQuery'
import { formatAmount, formatCLP, formatDate, periodLabel } from '@/lib/format'
import { ExpenseForm } from './ExpenseForm'
import { StatementImport } from './StatementImport'
import { cardColor } from '@/lib/look'
import {
  Badge,
  ColorDot,
  Button,
  Callout,
  EmptyState,
  Field,
  Modal,
  MoneyInput,
  QueryError,
  Section,
  SegmentedControl,
  SkeletonRows,
  TabPanel,
  Tabs,
  inputCls,
} from './ui'

const STATUSES = [
  { value: 'pendiente', label: 'Por revisar' },
  { value: 'conciliado', label: 'Conciliados' },
  { value: 'confirmado', label: 'Confirmados' },
  { value: 'descartado', label: 'Descartados' },
] as const satisfies readonly { value: ImportStatus; label: string }[]

const EMPTY_TEXT: Record<ImportStatus, string> = {
  pendiente: 'Aparecen aquí al importar un estado de cuenta en PDF o una cartola.',
  conciliado:
    'Aún no hay movimientos conciliados: son los que el banco informó dos veces (el pago de la tarjeta en la cartola y en el estado de cuenta).',
  confirmado: 'Aún no confirmas movimientos. Al confirmarlos se convierten en gastos del mes.',
  descartado: 'No hay movimientos descartados.',
}

const SOURCE_LABEL: Record<string, string> = {
  email: 'Correo',
  pdf_account: 'Cartola',
  pdf_card: 'Estado de cuenta TC',
  csv: 'Cartola CSV',
}

const isCredit = (it: ImportItemView) => it.kind === 'abono'

// ready reports whether an item can be confirmed in bulk as suggested: a rule
// already names its merchant, nothing looks like a duplicate (of an expense or
// of another imported movement), it is neither a card payment nor a transfer
// between own accounts (double counting), and it is a CLP expense (credits
// become income and USD amounts need a reviewed CLP value).
function ready(it: ImportItemView): boolean {
  return (
    it.rulePattern !== '' &&
    it.duplicateExpenseId == null &&
    it.duplicateItemId == null &&
    it.suggestedTransferId == null &&
    it.hint !== 'card_payment' &&
    !isCredit(it) &&
    it.currency === 'CLP'
  )
}

const ITEM_STATUS_LABEL: Record<string, string> = {
  pendiente: 'por revisar',
  confirmado: 'confirmado',
  conciliado: 'conciliado',
}

function confirmAsSuggested(it: ImportItemView) {
  const cuotas = it.installmentsTotal > 1
  // A card statement knows the bank's exact cuota (which may not be total/N).
  const cuota = it.installmentAmount !== '' ? it.installmentAmount : perInstallment(it.amount, it.installmentsTotal)
  return FinanceService.ConfirmImportItem(
    it.id,
    it.date,
    it.suggestedMerchant || it.description,
    it.suggestedCategory,
    it.suggestedMerchant,
    it.cardId,
    cuotas ? KIND_CUOTAS : KIND_UNICO,
    cuotas ? cuota : it.amount,
    it.installmentsTotal,
    '', // the rule that suggested these values already exists
  )
}

const IMPORT_TABS = [
  { value: 'bandeja', label: 'Bandeja', icon: Inbox },
  { value: 'estados', label: 'Estados de cuenta', icon: FileText },
] as const satisfies readonly { value: ImportTab; label: string; icon: typeof Inbox }[]

// ImportInboxView is the Importar screen: the inbox of bank movements waiting
// for review, and the imported credit-card statements. The tab is part of the
// route (#/importar, #/importar/estados).
export function ImportInboxView({ tab }: { tab: ImportTab }) {
  return (
    <div>
      <Tabs label="Importar" idBase="importar" value={tab} tabs={IMPORT_TABS} onChange={(t) => navigate({ page: 'importar', tab: t })} />
      <TabPanel idBase="importar" value={tab}>
        {tab === 'estados' ? <CardStatementsSection /> : <InboxPanel />}
      </TabPanel>
    </div>
  )
}

function InboxPanel() {
  const version = useVersion('imports', 'ledger')
  const invalidate = useInvalidate()
  // Confirming, linking or importing writes expenses/incomes/payments too.
  const reload = () => invalidate('imports', 'ledger')
  const [status, setStatus] = useState<ImportStatus>('pendiente')
  const [confirming, setConfirming] = useState<ImportItemView | null>(null)
  const [asIncome, setAsIncome] = useState<ImportItemView | null>(null)
  const [busyId, setBusyId] = useState<number | 'bulk' | null>(null)

  const query = useQuery(`${status}:${version}`, async () => {
    const [items, cards, categories, merchants, rules] = await Promise.all([
      FinanceService.ListImportItems(status),
      FinanceService.ListCards(),
      FinanceService.ListCategories(),
      FinanceService.ListMerchants(),
      FinanceService.ListMerchantRules(),
    ])
    if (items.error) throw new Error(items.error.message)
    return {
      items: items.data ?? [],
      cards: cards ?? [],
      categories: (categories ?? []).map((c) => c.name),
      merchants: (merchants ?? []).map((m) => m.name),
      rules: rules ?? [],
    }
  })

  async function run(id: number, op: () => Promise<OpResult>) {
    setBusyId(id)
    try {
      if (!failed(await op())) reload()
    } finally {
      setBusyId(null)
    }
  }

  async function confirmReady(items: ImportItemView[]) {
    setBusyId('bulk')
    let done = 0
    try {
      for (const it of items) {
        if (failed(await confirmAsSuggested(it))) break
        done++
      }
    } finally {
      setBusyId(null)
      if (done > 0) notify(`${done} movimiento${done === 1 ? '' : 's'} confirmado${done === 1 ? '' : 's'}.`, 'success')
      reload()
    }
  }

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  const data = query.data
  const readyItems = data && status === 'pendiente' ? data.items.filter(ready) : []

  return (
    <div className="space-y-6">
      <Section
        title="Bandeja de importación"
        action={
          readyItems.length > 0 && (
            <Button icon={CheckCheck} onClick={() => void confirmReady(readyItems)} loading={busyId === 'bulk'} disabled={busyId !== null}>
              Confirmar sugeridos ({readyItems.length})
            </Button>
          )
        }
      >
        <div className="mb-5">
          <StatementImport onImported={reload} />
        </div>

        <div className="mb-4">
          <SegmentedControl label="Estado de los movimientos" value={status} options={STATUSES} onChange={setStatus} />
        </div>

        {!data ? (
          <SkeletonRows rows={4} />
        ) : data.items.length === 0 ? (
          status === 'pendiente' ? (
            <EmptyState icon={CheckCheck} title="Todo al día: nada por revisar">
              {EMPTY_TEXT[status]}
            </EmptyState>
          ) : (
            <EmptyState icon={Inbox}>{EMPTY_TEXT[status]}</EmptyState>
          )
        ) : (
          <ul className={`space-y-2 transition-opacity ${query.status === 'loading' ? 'opacity-60' : ''}`} aria-busy={query.status === 'loading'}>
            {data.items.map((it) => (
              <ImportRow
                key={it.id}
                item={it}
                cards={data.cards}
                busy={busyId !== null}
                onConfirm={() => (isCredit(it) ? setAsIncome(it) : setConfirming(it))}
                onDiscard={() => void run(it.id, () => FinanceService.DiscardImportItem(it.id))}
                onRestore={() => void run(it.id, () => FinanceService.RestoreImportItem(it.id))}
                onLink={(expenseId) => void run(it.id, () => FinanceService.LinkImportItem(it.id, expenseId))}
                onLinkFixed={(fixedId, period) => void run(it.id, () => FinanceService.LinkImportItemToFixed(it.id, fixedId, period))}
                onLinkTransfer={(transferId, period) =>
                  void run(it.id, () => FinanceService.LinkImportItemToTransfer(it.id, transferId, period))
                }
                // The credit's own month and amount: a reversal lands when the bank posts it.
                onRefund={(expenseId) =>
                  void run(it.id, () => FinanceService.ConfirmImportItemAsRefund(it.id, expenseId, it.date.slice(0, 7), it.amount))
                }
              />
            ))}
          </ul>
        )}
      </Section>

      {data && (
        <p className="text-sm text-fg-muted">
          {data.rules.length === 0
            ? 'Al confirmar un movimiento puedes pedir que se recuerde su comercio y categoría. '
            : `${data.rules.length} regla${data.rules.length === 1 ? '' : 's'} aprendida${data.rules.length === 1 ? '' : 's'} completa${data.rules.length === 1 ? '' : 'n'} los movimientos que llegan. `}
          <Link to={{ page: 'config', section: 'reglas' }}>Ver reglas de importación</Link>
        </p>
      )}

      {confirming && data && (
        <ExpenseForm
          cards={data.cards}
          categories={data.categories}
          merchants={data.merchants}
          target={{ mode: 'confirm', item: confirming }}
          onClose={() => setConfirming(null)}
          onSaved={reload}
        />
      )}
      {asIncome && <IncomeConfirmForm item={asIncome} onClose={() => setAsIncome(null)} onSaved={reload} />}
    </div>
  )
}

// IncomeConfirmForm records a bank credit (cashback, points redemption) as an
// extra income of the month the user picks — by default the credit's month.
function IncomeConfirmForm({ item, onClose, onSaved }: { item: ImportItemView; onClose: () => void; onSaved: () => void }) {
  const [description, setDescription] = useState(item.description)
  const [period, setPeriod] = useState(item.date.slice(0, 7))
  const [amount, setAmount] = useState(item.currency === 'CLP' ? item.amount : item.suggestedAmountClp)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await FinanceService.ConfirmImportItemAsIncome(item.id, period, description, amount)
      const msg = errMsg(res)
      if (msg) {
        setError(msg)
        return
      }
      notify('Registrado como ingreso extra.', 'success')
      onSaved()
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Registrar como ingreso extra" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" aria-describedby={error ? 'income-form-error' : undefined}>
        <p className="rounded-lg bg-sunken px-3 py-2 text-sm text-fg-muted ring-1 ring-inset ring-line">
          Abono del banco: <span className="font-mono text-fg">{item.description}</span> ·{' '}
          <span className="tabular-nums">{formatAmount(item.amount, item.currency)}</span>. Suma a los ingresos del mes, no descuenta gastos.
        </p>
        <Field label="Descripción">
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Mes">
            <input className={inputCls} type="month" value={period} onChange={(e) => setPeriod(e.target.value)} required />
          </Field>
          <Field label="Monto (pesos)">
            <MoneyInput value={amount} onChange={setAmount} required />
          </Field>
        </div>
        {error && (
          <div id="income-form-error">
            <Callout tone="negative" role="alert">
              {error}
            </Callout>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy}>
            Registrar ingreso
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// Suggestion is a yes/no question the inbox asks about an item (merge with an
// expense typed by hand, pay a fixed expense, refund an expense).
function Suggestion({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-caution-soft px-2.5 py-1.5 text-xs text-fg">
      <span>{children}</span>
      {action}
    </div>
  )
}

function ImportRow({
  item: it,
  cards,
  busy,
  onConfirm,
  onDiscard,
  onRestore,
  onLink,
  onLinkFixed,
  onLinkTransfer,
  onRefund,
}: {
  item: ImportItemView
  cards: Card[]
  busy: boolean
  onConfirm: () => void
  onDiscard: () => void
  onRestore: () => void
  onLink: (expenseId: number) => void
  onLinkFixed: (fixedId: number, period: string) => void
  onLinkTransfer: (transferId: number, period: string) => void
  onRefund: (expenseId: number) => void
}) {
  const card = it.cardId != null ? cards.find((c) => c.id === it.cardId) : undefined
  const cardDot = card ? cardColor(card) : null
  const cardLabel =
    it.cardName !== ''
      ? it.cardName
      : it.cardLastDigits !== ''
        ? `Tarjeta •••• ${it.cardLastDigits}${cards.length > 0 ? ' (sin asociar)' : ''}`
        : null
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-lg bg-sunken p-3 ring-1 ring-inset ring-line">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
          <span className="mr-1">{formatDate(it.date)}</span>
          <Badge>{SOURCE_LABEL[it.source] ?? it.source}</Badge>
          {cardLabel && (
            <Badge>
              {cardDot && <ColorDot color={cardDot} />}
              {cardLabel}
            </Badge>
          )}
          {it.installmentsTotal > 1 && (
            <Badge>
              {it.installmentNumber > 1
                ? `Cuota ${it.installmentNumber} de ${it.installmentsTotal}`
                : `${it.installmentsTotal} cuotas${it.firstPeriod !== '' ? ` desde ${periodLabel(it.firstPeriod)}` : ''}`}
            </Badge>
          )}
          {it.reference !== '' && (
            // The bank's reference: the proof to quote in a dispute.
            <span>
              Cód. banco <span className="select-all font-mono">{it.reference}</span>
            </span>
          )}
          {it.currency !== 'CLP' && <Badge tone="caution">{it.currency}</Badge>}
          {isCredit(it) && <Badge tone="info">Abono del banco: ingreso o reembolso de un gasto</Badge>}
          {it.hint === 'card_payment' && (
            <Badge tone="caution" icon={TriangleAlert}>
              Pago de tarjeta: sus compras ya se cuentan aparte
            </Badge>
          )}
        </div>
        <div className="break-words font-mono text-sm text-fg">{it.description}</div>
        {it.rulePattern !== '' && (
          <div className="text-xs text-fg-muted">
            Sugerido: <span className="text-fg">{it.suggestedMerchant || '—'}</span>
            {it.suggestedCategory !== '' && <> · {it.suggestedCategory}</>} <span className="text-fg-subtle">(regla «{it.rulePattern}»)</span>
          </div>
        )}
        {it.status === 'conciliado' && it.matchedSource !== '' && (
          <div className="text-xs text-fg-muted">
            Mismo movimiento que {SOURCE_LABEL[it.matchedSource]?.toLowerCase() ?? it.matchedSource} del {formatDate(it.matchedDate)}
          </div>
        )}
        {it.duplicateExpenseId != null && (
          <Suggestion
            action={
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => onLink(it.duplicateExpenseId!)}>
                Sí, unir
              </Button>
            }
          >
            ¿Ya lo registraste como «{it.duplicateDescription}»
            {it.duplicateDate !== '' && it.duplicateDate !== it.date && <> el {formatDate(it.duplicateDate)}</>}?{' '}
            <span className="text-fg-muted">Se usan la fecha y el monto del banco; tu descripción se conserva.</span>
          </Suggestion>
        )}
        {it.suggestedFixedId != null && (
          <Suggestion
            action={
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => onLinkFixed(it.suggestedFixedId!, it.suggestedFixedPeriod)}>
                Sí, marcarlo pagado
              </Button>
            }
          >
            ¿Es el cobro de tu gasto fijo «{it.suggestedFixedDescription}» de {periodLabel(it.suggestedFixedPeriod)}?
          </Suggestion>
        )}
        {it.duplicateItemId != null && (
          <Suggestion
            action={
              <Button variant="secondary" size="sm" disabled={busy} onClick={onDiscard}>
                Sí, descartar este
              </Button>
            }
          >
            ¿Es el mismo movimiento que ya importaste desde {SOURCE_LABEL[it.duplicateItemSource]?.toLowerCase() ?? it.duplicateItemSource}{' '}
            («{it.duplicateItemDescription}», {ITEM_STATUS_LABEL[it.duplicateItemStatus] ?? it.duplicateItemStatus})?
          </Suggestion>
        )}
        {it.suggestedTransferId != null && (
          <Suggestion
            action={
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => onLinkTransfer(it.suggestedTransferId!, it.suggestedTransferPeriod)}
              >
                Sí, es esa transferencia
              </Button>
            }
          >
            ¿Es tu transferencia «{it.suggestedTransferDescription}» de {periodLabel(it.suggestedTransferPeriod)}?{' '}
            <span className="text-fg-muted">No cuenta como gasto ni como ingreso: solo mueve plata entre tus cuentas.</span>
          </Suggestion>
        )}
        {it.suggestedRefundExpenseId != null && (
          <Suggestion
            action={
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => onRefund(it.suggestedRefundExpenseId!)}>
                Sí, registrar como reembolso
              </Button>
            }
          >
            ¿Es la devolución de «{it.suggestedRefundDescription}»?
          </Suggestion>
        )}
        {it.fixedPeriod !== '' && <div className="text-xs text-fg-muted">Pagó el gasto fijo de {periodLabel(it.fixedPeriod)}</div>}
        {it.transferPeriod !== '' && it.transferId != null && (
          <div className="text-xs text-fg-muted">Transferencia entre tus cuentas de {periodLabel(it.transferPeriod)}</div>
        )}
      </div>
      <div className="flex flex-col items-end gap-2">
        <span className={`font-semibold tabular-nums ${isCredit(it) ? 'text-positive-fg' : 'text-fg'}`}>
          {isCredit(it) && '+'}
          {formatAmount(it.amount, it.currency)}
        </span>
        {it.currency !== 'CLP' && it.suggestedAmountClp !== '' && (
          <span className="text-xs tabular-nums text-fg-muted">≈ {formatCLP(it.suggestedAmountClp)}</span>
        )}
        {it.status === 'pendiente' && (
          <div className="flex gap-2">
            <Button variant="quiet" size="sm" disabled={busy} onClick={onDiscard}>
              Descartar
            </Button>
            <Button size="sm" disabled={busy} onClick={onConfirm}>
              {isCredit(it) ? 'Registrar como ingreso' : 'Confirmar'}
            </Button>
          </div>
        )}
        {it.status === 'descartado' && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onRestore}>
            Restaurar
          </Button>
        )}
        {it.status === 'confirmado' && it.reopenable && (
          <div className="flex flex-col items-end gap-1">
            <span className="text-xs text-fg-muted">Lo que registró está en la papelera o se eliminó</span>
            <Button variant="secondary" size="sm" disabled={busy} onClick={onRestore}>
              Volver a revisar
            </Button>
          </div>
        )}
      </div>
    </li>
  )
}
