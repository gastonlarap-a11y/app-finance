import { useState, type SubmitEvent } from 'react'
import { useAtomValue } from 'jotai'
import { FinanceService, type Account, type AccountView } from '@/services/finance'
import { periodAtom } from '@/atoms/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { isNegative } from '@/lib/money'
import { currentPeriod, formatCLP, periodLabel } from '@/lib/format'
import { Link } from './Link'
import { Button, Empty, Field, Modal, MoneyInput, QueryError, Section, Select, Spinner, inputCls } from './ui'

const KIND_LABEL: Record<string, string> = {
  corriente: 'Cuenta corriente',
  vista: 'Cuenta vista / RUT',
  efectivo: 'Efectivo',
  ahorro: 'Cuenta de ahorro',
  otra: 'Otra',
}

// useAccounts lists the profile's accounts (for the selects of forms).
export function useAccounts(): Account[] {
  const version = useVersion('ledger')
  const period = useAtomValue(periodAtom)
  const query = useQuery(`accounts:${period}:${version}`, async () => (await FinanceService.ListAccounts(period)).data?.accounts ?? [])
  return query.data ?? []
}

// AccountSelect picks the account a movement belongs to ('' = none). Hidden
// while the profile has no accounts.
export function AccountSelect({
  accounts,
  value,
  onChange,
  label = 'Cuenta',
  noneLabel = 'Sin cuenta',
}: {
  accounts: readonly Account[]
  value: number | null
  onChange: (id: number | null) => void
  label?: string
  noneLabel?: string
}) {
  if (accounts.length === 0) return null
  return (
    <Field label={label}>
      <Select value={value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
        <option value="">{noneLabel}</option>
        {accounts.map((a) => (
          <option key={a.id} value={String(a.id)}>
            {a.name}
          </option>
        ))}
      </Select>
    </Field>
  )
}

// AccountsSettings is Configuración › Cuentas: the accounts, with their
// balance at the close of the current month (month by month they show in the
// Resumen panel, AccountBalancesPanel).
export function AccountsSettings() {
  return <AccountsSection period={currentPeriod()} />
}

// AccountBalancesPanel shows, in the Resumen, each account at the close of the
// month on screen. Nothing while the profile has no accounts.
export function AccountBalancesPanel({ period }: { period: string }) {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const query = useQuery(`account-balances:${period}:${version}`, async () => {
    const res = await FinanceService.ListAccounts(period)
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'cuentas no disponibles')
    return res.data.accounts
  })
  if (query.status !== 'error' && (query.data?.length ?? 0) === 0) return null
  return (
    <Section title="Cuentas" action={<Link to={{ page: 'config', section: 'cuentas' }}>Administrar</Link>}>
      {query.status === 'error' ? (
        <QueryError message={query.error} onRetry={() => invalidate('ledger')} />
      ) : (
        <ul className="space-y-2 text-sm">
          {(query.data ?? []).map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-fg-muted">{a.name}</span>
              <strong className={`tabular-nums ${isNegative(a.balance) ? 'text-negative-fg' : 'text-fg'}`}>{formatCLP(a.balance)}</strong>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

// AccountsSection shows every account at the close of `period`: a lens on the
// same ledger (the app's total balance does not change).
function AccountsSection({ period }: { period: string }) {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const [editing, setEditing] = useState<Account | null | undefined>(undefined)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const query = useQuery(`accounts-view:${period}:${version}`, async () => {
    const res = await FinanceService.ListAccounts(period)
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'cuentas no disponibles')
    return res.data
  })

  async function remove(id: number) {
    setConfirmId(null)
    if (!failed(await FinanceService.DeleteAccount(id))) invalidate('ledger')
  }

  return (
    <Section title={`Cuentas · saldo a ${periodLabel(period)}`} action={<Button onClick={() => setEditing(null)}>+ Nueva cuenta</Button>}>
      {query.status === 'error' ? (
        <QueryError message={query.error} onRetry={() => invalidate('ledger')} />
      ) : !query.data ? (
        <Spinner />
      ) : query.data.accounts.length === 0 ? (
        <Empty>
          Agrega tus cuentas (corriente, vista, efectivo) para ver cuánto hay en cada una. Luego indica en tus gastos, ingresos y
          tarjetas de qué cuenta salen.
        </Empty>
      ) : (
        <>
          <ul className="space-y-2">
            {query.data.accounts.map((a: AccountView) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-base bg-surface p-3 ring-1 ring-slate-800">
                <div>
                  <div className="font-medium">
                    {a.name}
                    {a.receivesSalary && <span className="ml-2 text-xs text-slate-500">recibe el sueldo</span>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {KIND_LABEL[a.kind] ?? a.kind} · este mes +{formatCLP(a.ingresos)} / −{formatCLP(a.gastos)}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <strong className={`tabular-nums ${isNegative(a.balance) ? 'text-danger' : ''}`}>{formatCLP(a.balance)}</strong>
                  {confirmId === a.id ? (
                    <>
                      <Button variant="danger" onClick={() => void remove(a.id)}>
                        Eliminar
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmId(null)}>
                        No
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="ghost" onClick={() => setEditing(a)}>
                        Editar
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmId(a.id)}>
                        Eliminar
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500">
            Sin cuenta este mes: +{formatCLP(query.data.unassignedIngresos)} / −{formatCLP(query.data.unassignedGastos)}. Eliminar
            una cuenta deja sus movimientos sin cuenta.
          </p>
        </>
      )}
      {editing !== undefined && (
        <AccountForm account={editing} defaultPeriod={period} onClose={() => setEditing(undefined)} onSaved={() => invalidate('ledger')} />
      )}
    </Section>
  )
}

function AccountForm({
  account,
  defaultPeriod,
  onClose,
  onSaved,
}: {
  account: Account | null
  defaultPeriod: string
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(account?.name ?? '')
  const [kind, setKind] = useState(account?.kind ?? 'corriente')
  const [opening, setOpening] = useState(account?.openingBalance ?? '0')
  const [openingPeriod, setOpeningPeriod] = useState(account?.openingPeriod ?? defaultPeriod)
  const [salary, setSalary] = useState(account?.receivesSalary ?? false)
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const res = account
        ? await FinanceService.UpdateAccount(account.id, name, kind, opening || '0', openingPeriod, salary)
        : await FinanceService.CreateAccount(name, kind, opening || '0', openingPeriod, salary)
      if (failed(res)) return
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={account ? 'Editar cuenta' : 'Nueva cuenta'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nombre">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Cuenta Itaú" required autoFocus />
          </Field>
          <Field label="Tipo">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Saldo al inicio del mes">
            <MoneyInput value={opening} onChange={setOpening} placeholder="0" />
          </Field>
          <Field label="Mes">
            <input type="month" className={inputCls} value={openingPeriod} onChange={(e) => setOpeningPeriod(e.target.value)} required />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={salary} onChange={(e) => setSalary(e.target.checked)} />
          Aquí cae mi sueldo
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
