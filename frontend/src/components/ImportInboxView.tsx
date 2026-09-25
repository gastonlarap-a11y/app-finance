import { useState, type ReactNode, type SubmitEvent } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  FinanceService,
  KIND_CUOTAS,
  KIND_UNICO,
  type Card,
  type ImportItemView,
  type MerchantRule,
  type OpResult,
} from '@/services/finance'
import type { ImportStatus } from '@/services/contract'
import { refreshAtom, tabAtom } from '@/atoms/finance'
import { MailSyncService } from '@/services/mailsync'
import { IS_WEB } from '@/lib/platform'
import { syncStatusText } from './MailSettings'
import { errMsg, failed } from '@/lib/result'
import { notify } from '@/lib/notify'
import { perInstallment } from '@/lib/money'
import { errorText, useQuery } from '@/lib/useQuery'
import { formatAmount, formatCLP, formatDate } from '@/lib/format'
import { ExpenseForm } from './ExpenseForm'
import { StatementImport } from './StatementImport'
import { Button, Empty, Field, Modal, MoneyInput, QueryError, Section, Spinner, inputCls } from './ui'

const STATUSES: { id: ImportStatus; label: string }[] = [
  { id: 'pendiente', label: 'Por revisar' },
  { id: 'conciliado', label: 'Conciliados' },
  { id: 'confirmado', label: 'Confirmados' },
  { id: 'descartado', label: 'Descartados' },
]

const EMPTY_TEXT: Record<ImportStatus, string> = {
  pendiente: IS_WEB
    ? 'No hay movimientos por revisar. Aparecen aquí al importar un estado de cuenta en PDF.'
    : 'No hay movimientos por revisar. Aparecen aquí al importar un estado de cuenta en PDF o al revisar tu correo de alertas (Ajustes).',
  conciliado: 'Aún no hay movimientos conciliados: son los que el banco informó dos veces (alerta de correo y estado de cuenta).',
  confirmado: 'Aún no confirmas movimientos. Al confirmarlos se convierten en gastos del mes.',
  descartado: 'No hay movimientos descartados.',
}

const SOURCE_LABEL: Record<string, string> = {
  email: 'Correo',
  pdf_account: 'Cartola',
  pdf_card: 'Estado de cuenta TC',
}

const isCredit = (it: ImportItemView) => it.kind === 'abono'

// ready reports whether an item can be confirmed in bulk as suggested: a rule
// already names its merchant, nothing looks like a duplicate, it is not a card
// payment (double counting), and it is a CLP expense (credits become income
// and USD amounts need a reviewed CLP value).
function ready(it: ImportItemView): boolean {
  return (
    it.rulePattern !== '' && it.duplicateExpenseId == null && it.hint !== 'card_payment' && !isCredit(it) && it.currency === 'CLP'
  )
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

// PendingImportsBadge shows on the Importar tab how many movements await
// review; it renders nothing when the inbox is empty or cannot be read.
export function PendingImportsBadge() {
  const refresh = useAtomValue(refreshAtom)
  const query = useQuery(String(refresh), async () => (await FinanceService.ListImportItems('pendiente')).data?.length ?? 0)
  const n = query.data ?? 0
  if (n === 0) return null
  return (
    <>
      <span aria-hidden="true" className="ml-1.5 rounded-full bg-amber-500 px-1.5 text-xs font-bold text-slate-900">
        {n}
      </span>
      <span className="sr-only">, {n} por revisar</span>
    </>
  )
}

export function ImportInboxView() {
  const refresh = useAtomValue(refreshAtom)
  const bump = useSetAtom(refreshAtom)
  const reload = () => bump((n) => n + 1)
  const [status, setStatus] = useState<ImportStatus>('pendiente')
  const [confirming, setConfirming] = useState<ImportItemView | null>(null)
  const [asIncome, setAsIncome] = useState<ImportItemView | null>(null)
  const [busyId, setBusyId] = useState<number | 'bulk' | null>(null)

  const query = useQuery(`${status}:${refresh}`, async () => {
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
  if (!query.data) return <Spinner />
  const { items, cards, categories, merchants, rules } = query.data
  const readyItems = status === 'pendiente' ? items.filter(ready) : []

  return (
    <div className="space-y-6">
      <Section
        title="Bandeja de importación"
        action={
          readyItems.length > 0 && (
            <Button onClick={() => confirmReady(readyItems)} disabled={busyId !== null}>
              {busyId === 'bulk' ? 'Confirmando…' : `Confirmar sugeridos (${readyItems.length})`}
            </Button>
          )
        }
      >
        <div className="mb-4 space-y-3">
          {!IS_WEB && <MailSyncStatus refresh={refresh} onSynced={reload} />}
          <StatementImport onImported={reload} />
        </div>

        <div role="tablist" aria-label="Estado de los movimientos" className="mb-4 flex flex-wrap gap-1">
          {STATUSES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={status === s.id}
              onClick={() => setStatus(s.id)}
              className={`rounded px-3 py-1.5 text-sm font-medium ring-1 transition focus-visible:outline-2 focus-visible:outline-primary ${
                status === s.id ? 'bg-primary text-white ring-primary' : 'text-slate-300 ring-slate-700 hover:text-white'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {items.length === 0 ? (
          <Empty>{EMPTY_TEXT[status]}</Empty>
        ) : (
          <ul className={`space-y-2 ${query.status === 'loading' ? 'opacity-60' : ''}`}>
            {items.map((it) => (
              <ImportRow
                key={it.id}
                item={it}
                cards={cards}
                busy={busyId !== null}
                onConfirm={() => (isCredit(it) ? setAsIncome(it) : setConfirming(it))}
                onDiscard={() => run(it.id, () => FinanceService.DiscardImportItem(it.id))}
                onRestore={() => run(it.id, () => FinanceService.RestoreImportItem(it.id))}
                onLink={(expenseId) => run(it.id, () => FinanceService.LinkImportItem(it.id, expenseId))}
              />
            ))}
          </ul>
        )}
      </Section>

      <RulesSection rules={rules} onChanged={reload} />

      {confirming && (
        <ExpenseForm
          cards={cards}
          categories={categories}
          merchants={merchants}
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
        <p className="rounded bg-surface px-3 py-2 text-sm text-slate-300 ring-1 ring-slate-800">
          Abono del banco: <span className="font-mono text-slate-100">{item.description}</span> ·{' '}
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
          <p id="income-form-error" role="alert" className="rounded bg-danger/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Guardando…' : 'Registrar ingreso'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// MailSyncStatus shows when the bank's alert emails were last read and lets
// the user read them now (desktop only; the outcome arrives as an event).
function MailSyncStatus({ refresh, onSynced }: { refresh: number; onSynced: () => void }) {
  const setTab = useSetAtom(tabAtom)
  const [requested, setRequested] = useState(false)
  const query = useQuery(String(refresh), async () => (await MailSyncService.GetMailState()).data ?? null)
  const st = query.data
  if (!st) return null
  if (!st.configured) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
        <span>Conecta tu correo para traer las alertas de compra automáticamente.</span>
        <Button variant="ghost" onClick={() => setTab('ajustes')}>
          Configurar correo
        </Button>
      </div>
    )
  }

  async function syncNow() {
    setRequested(true)
    try {
      if (!failed(await MailSyncService.SyncNow())) onSynced()
    } finally {
      setRequested(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Button variant="ghost" onClick={syncNow} disabled={requested || st.syncing}>
        {st.syncing ? 'Revisando correo…' : 'Revisar correo ahora'}
      </Button>
      <span className="text-xs text-slate-500">
        {syncStatusText(st)}
        {st.lastError && <span className="text-red-300"> · Último error: {st.lastError}</span>}
      </span>
    </div>
  )
}

function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'warn' }) {
  const cls = tone === 'warn' ? 'bg-amber-500/15 text-amber-200 ring-amber-500/40' : 'bg-surface text-slate-300 ring-slate-700'
  return <span className={`rounded px-1.5 py-0.5 text-xs ring-1 ${cls}`}>{children}</span>
}

function ImportRow({
  item: it,
  cards,
  busy,
  onConfirm,
  onDiscard,
  onRestore,
  onLink,
}: {
  item: ImportItemView
  cards: Card[]
  busy: boolean
  onConfirm: () => void
  onDiscard: () => void
  onRestore: () => void
  onLink: (expenseId: number) => void
}) {
  const cardLabel =
    it.cardName !== ''
      ? it.cardName
      : it.cardLastDigits !== ''
        ? `Tarjeta •••• ${it.cardLastDigits}${cards.length > 0 ? ' (sin asociar)' : ''}`
        : null
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-base bg-surface p-3 ring-1 ring-slate-800">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span>{formatDate(it.date)}</span>
          <Badge>{SOURCE_LABEL[it.source] ?? it.source}</Badge>
          {cardLabel && <Badge>{cardLabel}</Badge>}
          {it.installmentsTotal > 1 && (
            <Badge>
              {it.installmentNumber > 1 ? `Cuota ${it.installmentNumber} de ${it.installmentsTotal}` : `${it.installmentsTotal} cuotas`}
            </Badge>
          )}
          {it.currency !== 'CLP' && <Badge tone="warn">{it.currency}</Badge>}
          {isCredit(it) && <Badge>Abono del banco: se registra como ingreso</Badge>}
          {it.hint === 'card_payment' && <Badge tone="warn">⚠ Pago de tarjeta: sus compras ya se cuentan aparte</Badge>}
        </div>
        <div className="truncate font-mono text-sm text-slate-100" title={it.description}>
          {it.description}
        </div>
        {it.rulePattern !== '' && (
          <div className="text-xs text-slate-400">
            Sugerido: <span className="text-slate-200">{it.suggestedMerchant || '—'}</span>
            {it.suggestedCategory !== '' && <> · {it.suggestedCategory}</>} <span className="text-slate-500">(regla «{it.rulePattern}»)</span>
          </div>
        )}
        {it.status === 'conciliado' && it.matchedSource !== '' && (
          <div className="text-xs text-slate-400">
            Mismo movimiento que {SOURCE_LABEL[it.matchedSource]?.toLowerCase() ?? it.matchedSource} del {formatDate(it.matchedDate)}
          </div>
        )}
        {it.duplicateExpenseId != null && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-amber-200">
            <span>¿Ya lo registraste como «{it.duplicateDescription}»?</span>
            <Button variant="ghost" disabled={busy} onClick={() => onLink(it.duplicateExpenseId!)}>
              Sí, enlazar
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-2">
        <span className={`font-semibold tabular-nums ${isCredit(it) ? 'text-success' : ''}`}>
          {isCredit(it) && '+'}
          {formatAmount(it.amount, it.currency)}
        </span>
        {it.currency !== 'CLP' && it.suggestedAmountClp !== '' && (
          <span className="text-xs tabular-nums text-slate-400">≈ {formatCLP(it.suggestedAmountClp)}</span>
        )}
        {it.status === 'pendiente' && (
          <div className="flex gap-2">
            <Button variant="ghost" disabled={busy} onClick={onDiscard}>
              Descartar
            </Button>
            <Button disabled={busy} onClick={onConfirm}>
              {isCredit(it) ? 'Registrar como ingreso' : 'Confirmar'}
            </Button>
          </div>
        )}
        {it.status === 'descartado' && (
          <Button variant="ghost" disabled={busy} onClick={onRestore}>
            Restaurar
          </Button>
        )}
      </div>
    </li>
  )
}

function RulesSection({ rules, onChanged }: { rules: MerchantRule[]; onChanged: () => void }) {
  const [confirmId, setConfirmId] = useState<number | null>(null)

  async function remove(id: number) {
    setConfirmId(null)
    if (!failed(await FinanceService.DeleteMerchantRule(id))) onChanged()
  }

  return (
    <Section title="Reglas aprendidas">
      {rules.length === 0 ? (
        <Empty>Al confirmar un movimiento puedes pedir que se recuerde su comercio y categoría para las próximas glosas iguales.</Empty>
      ) : (
        <ul className="space-y-2">
          {rules.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 rounded-base bg-surface p-3 ring-1 ring-slate-800">
              <div className="min-w-0 text-sm">
                <span className="font-mono text-slate-100">«{r.pattern}…»</span>{' '}
                <span className="text-slate-400">
                  → {r.merchant || 'sin comercio'} · {r.category || 'Sin categoría'}
                </span>
              </div>
              {confirmId === r.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-danger">¿Olvidar?</span>
                  <Button variant="danger" onClick={() => remove(r.id)}>
                    Sí
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmId(null)}>
                    No
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" onClick={() => setConfirmId(r.id)}>
                  Olvidar
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
