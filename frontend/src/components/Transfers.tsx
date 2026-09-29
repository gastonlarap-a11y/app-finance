import { useState, type SubmitEvent } from 'react'
import { ArrowRight, ArrowRightLeft, CalendarX, Pencil, Plus, Trash } from 'lucide-react'
import { FinanceService, type Account, type Transfer } from '@/services/finance'
import type { TransferMode } from '@/services/contract'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { shiftPeriod } from '@/lib/format'
import { transferAmount, transferSpan } from '@/lib/wording'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Menu,
  Modal,
  MoneyInput,
  QueryError,
  Section,
  SegmentedControl,
  Select,
  SkeletonRows,
  Switch,
  inputCls,
  type MenuAction,
} from './ui'

type Editing = { kind: 'new' } | { kind: 'edit'; transfer: Transfer } | { kind: 'end'; transfer: Transfer } | { kind: 'delete'; transfer: Transfer }

const MODES = [
  { value: 'fixed', label: 'Monto fijo' },
  { value: 'salary_rest', label: 'Resto del sueldo' },
] as const satisfies readonly { value: TransferMode; label: string }[]

// TransfersSection is Configuración › Cuentas › Transferencias: money moved
// between two own accounts (the salary passed on, a digital wallet topped
// up). It is neither spending nor income: only the accounts' balances move.
export function TransfersSection({ period }: { period: string }) {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const reload = () => invalidate('ledger')
  const [editing, setEditing] = useState<Editing | null>(null)
  const query = useQuery(`transfers:${period}:${version}`, async () => {
    const [transfers, accounts] = await Promise.all([FinanceService.ListTransfers(), FinanceService.ListAccounts(period)])
    if (accounts.error || !accounts.data) throw new Error(accounts.error?.message ?? 'cuentas no disponibles')
    return { transfers, accounts: accounts.data.accounts }
  })

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  const data = query.data
  const nameOf = (id: number) => data?.accounts.find((a) => a.id === id)?.name ?? 'Cuenta eliminada'
  const canTransfer = (data?.accounts.length ?? 0) >= 2

  function actions(t: Transfer): MenuAction[] {
    return [
      { label: 'Editar', icon: Pencil, onSelect: () => setEditing({ kind: 'edit', transfer: t }) },
      ...(t.endPeriod === '' ? [{ label: 'Terminar…', icon: CalendarX, onSelect: () => setEditing({ kind: 'end', transfer: t }) }] : []),
      { label: 'Eliminar…', icon: Trash, tone: 'danger' as const, onSelect: () => setEditing({ kind: 'delete', transfer: t }) },
    ]
  }

  return (
    <Section
      title="Transferencias entre tus cuentas"
      action={
        canTransfer && (
          <Button icon={Plus} onClick={() => setEditing({ kind: 'new' })}>
            Nueva transferencia
          </Button>
        )
      }
    >
      {!data ? (
        <SkeletonRows rows={2} />
      ) : !canTransfer ? (
        <EmptyState icon={ArrowRightLeft} title="Agrega al menos dos cuentas">
          Una transferencia mueve plata entre dos de tus cuentas, como el sueldo que pasas del banco donde cae al que usas a
          diario, o la carga de Mercado Pago.
        </EmptyState>
      ) : data.transfers.length === 0 ? (
        <EmptyState
          icon={ArrowRightLeft}
          title="Aún no tienes transferencias"
          action={
            <Button icon={Plus} onClick={() => setEditing({ kind: 'new' })}>
              Agregar una transferencia
            </Button>
          }
        >
          Registra el sueldo que pasas a otra cuenta o lo que cargas en Mercado Pago. No cuenta como gasto ni ingreso: solo
          mueve el saldo de cada cuenta.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {data.transfers.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 font-medium text-fg">
                  {nameOf(t.fromAccountId)}
                  <ArrowRight aria-label="a" className="size-4 text-fg-subtle" />
                  {nameOf(t.toAccountId)}
                  {t.endPeriod === '' && <Badge tone="info">Mensual</Badge>}
                </div>
                <div className="text-xs text-fg-muted">
                  {t.description !== '' && <>{t.description} · </>}
                  {transferSpan(t)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <strong className="tabular-nums text-fg">{transferAmount(t)}</strong>
                <Menu label={`Acciones de la transferencia ${nameOf(t.fromAccountId)} a ${nameOf(t.toAccountId)}`} items={actions(t)} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {data && editing?.kind === 'new' && (
        <TransferForm accounts={data.accounts} defaultPeriod={period} onClose={() => setEditing(null)} onSaved={reload} />
      )}
      {data && editing?.kind === 'edit' && (
        <TransferForm
          accounts={data.accounts}
          transfer={editing.transfer}
          defaultPeriod={period}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
      {editing?.kind === 'end' && (
        <EndTransferForm transfer={editing.transfer} defaultPeriod={period} onClose={() => setEditing(null)} onSaved={reload} />
      )}
      {editing?.kind === 'delete' && (
        <ConfirmDialog
          title="Eliminar la transferencia"
          confirmLabel="Eliminar"
          onConfirm={async () => {
            if (!failed(await FinanceService.DeleteTransfer(editing.transfer.id))) reload()
          }}
          onClose={() => setEditing(null)}
        >
          Se quita de todos los meses que cubría ({transferSpan(editing.transfer)}). Para dejar de repetirla sin tocar los meses
          pasados, usa «Terminar».
        </ConfirmDialog>
      )}
    </Section>
  )
}

function TransferForm({
  accounts,
  transfer,
  defaultPeriod,
  onClose,
  onSaved,
}: {
  accounts: readonly Account[]
  transfer?: Transfer
  defaultPeriod: string
  onClose: () => void
  onSaved: () => void
}) {
  const salaryAccount = accounts.find((a) => a.receivesSalary)
  const [from, setFrom] = useState(transfer?.fromAccountId ?? salaryAccount?.id ?? accounts[0]!.id)
  const [to, setTo] = useState(transfer?.toAccountId ?? accounts.find((a) => a.id !== from)!.id)
  const [mode, setMode] = useState<TransferMode>(transfer?.mode === 'salary_rest' ? 'salary_rest' : 'fixed')
  const [amount, setAmount] = useState(transfer?.amount ?? '')
  const [description, setDescription] = useState(transfer?.description ?? '')
  const [startPeriod, setStartPeriod] = useState(transfer?.startPeriod ?? defaultPeriod)
  const [monthly, setMonthly] = useState(transfer ? transfer.endPeriod !== transfer.startPeriod : true)
  const [busy, setBusy] = useState(false)
  // Only the salary's own account can pass on "the rest of the salary".
  const source = accounts.find((a) => a.id === from)
  const followsSalary = source?.receivesSalary === true && mode === 'salary_rest'

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    setBusy(true)
    const sent: TransferMode = followsSalary ? 'salary_rest' : 'fixed'
    try {
      const res = transfer
        ? await FinanceService.UpdateTransfer(transfer.id, from, to, description, sent, amount)
        : await FinanceService.CreateTransfer(from, to, description, sent, amount, startPeriod, monthly)
      if (failed(res)) return
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const options = accounts.map((a) => (
    <option key={a.id} value={String(a.id)}>
      {a.name}
    </option>
  ))
  return (
    <Modal title={transfer ? 'Editar transferencia' : 'Nueva transferencia'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Desde">
            <Select value={String(from)} onChange={(e) => setFrom(Number(e.target.value))}>
              {options}
            </Select>
          </Field>
          <Field label="Hacia">
            <Select value={String(to)} onChange={(e) => setTo(Number(e.target.value))}>
              {options}
            </Select>
          </Field>
        </div>
        {from === to && <p className="-mt-2 text-xs text-negative-fg">Elige dos cuentas distintas.</p>}
        {source?.receivesSalary && (
          <SegmentedControl label="Cuánto pasa" value={mode} options={MODES} onChange={setMode} />
        )}
        {followsSalary ? (
          <Field
            label={`Se queda en ${source.name}`}
            hint="Cada mes pasa el sueldo de ese mes menos este monto (por ejemplo, el dividendo que se paga desde esa cuenta). Pon 0 para pasarlo entero."
          >
            <MoneyInput value={amount} onChange={setAmount} placeholder="470000" required autoFocus />
          </Field>
        ) : (
          <Field label="Monto">
            <MoneyInput value={amount} onChange={setAmount} placeholder="1500000" required autoFocus />
          </Field>
        )}
        <Field label="Descripción (opcional)">
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Sueldo a Itaú" />
        </Field>
        {transfer ? (
          <p className="text-xs text-fg-subtle">
            Cambia todos los meses que cubre ({transferSpan(transfer)}). Para cambiar el monto desde un mes, termínala y crea
            otra.
          </p>
        ) : (
          <>
            <Field label={monthly ? 'Desde el mes' : 'Mes'}>
              <input type="month" className={inputCls} value={startPeriod} onChange={(e) => setStartPeriod(e.target.value)} required />
            </Field>
            <Switch
              label="Repetir todos los meses"
              description="Como el sueldo que siempre pasas a otra cuenta. Puedes terminarla cuando quieras."
              checked={monthly}
              onChange={setMonthly}
            />
          </>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy} disabled={from === to}>
            Guardar
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function EndTransferForm({
  transfer,
  defaultPeriod,
  onClose,
  onSaved,
}: {
  transfer: Transfer
  defaultPeriod: string
  onClose: () => void
  onSaved: () => void
}) {
  // The month before the one on screen is the usual "last one it happened".
  const suggested = shiftPeriod(defaultPeriod, -1)
  const [last, setLast] = useState(suggested < transfer.startPeriod ? transfer.startPeriod : suggested)
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      if (failed(await FinanceService.EndTransfer(transfer.id, last))) return
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Terminar la transferencia" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Último mes en que se hizo">
          <input
            type="month"
            className={inputCls}
            min={transfer.startPeriod}
            value={last}
            onChange={(e) => setLast(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <p className="text-xs text-fg-subtle">Los meses hasta ese quedan como estaban; desde el siguiente ya no se repite.</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy}>
            Terminar
          </Button>
        </div>
      </form>
    </Modal>
  )
}
