import { useState, type SubmitEvent } from 'react'
import { useAtomValue } from 'jotai'
import { FinanceService, type Account, type AccountView, type CardOwed } from '@/services/finance'
import { periodAtom } from '@/atoms/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { isNegative, isZero, withSign } from '@/lib/money'
import { currentPeriod, formatCLP, periodLabel } from '@/lib/format'
import { Link } from './Link'
import { TransfersSection } from './Transfers'
import { AccountReconcileDialog } from './AccountReconcileDialog'
import { CircleCheck, Landmark, Pencil, Plus, Scale } from 'lucide-react'
import { Badge, Button, ConfirmAction, EmptyState, Field, Menu, Modal, MoneyInput, QueryError, Section, Select, SkeletonRows, inputCls } from './ui'

const KIND_LABEL: Record<string, string> = {
  corriente: 'Cuenta corriente',
  vista: 'Cuenta vista / RUT',
  digital: 'Cuenta digital / prepago',
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
  const period = currentPeriod()
  return (
    <div className="space-y-5">
      <AccountsSection period={period} />
      <TransfersSection period={period} />
    </div>
  )
}

// CardsOwedList shows what each card had billed and not yet paid at a month's
// close: its purchases leave the account that pays it the month its statement
// is paid. Nothing when no card owes anything.
function CardsOwedList({ cards }: { cards: readonly CardOwed[] }) {
  if (cards.length === 0) return null
  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="mb-1.5 text-xs font-medium text-fg-muted">Tarjetas por pagar</p>
      <ul className="space-y-1.5 text-sm">
        {cards.map((c) => (
          <li key={c.cardId} className="flex items-center justify-between gap-2">
            <span className="truncate text-fg-muted">{c.name}</span>
            <span className="shrink-0 text-right">
              <strong className="tabular-nums text-fg">{formatCLP(c.owed)}</strong>
              <span className="ml-1.5 text-xs text-fg-subtle">se paga en {periodLabel(c.paymentPeriod).toLowerCase()}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// AccountBalancesPanel shows, in the Resumen, each account at the close of the
// month on screen, and lets the user reconcile it with the bank's balance.
// Nothing while the profile has no accounts.
export function AccountBalancesPanel({ period }: { period: string }) {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const [reconciling, setReconciling] = useState<AccountView | null>(null)
  const query = useQuery(`account-balances:${period}:${version}`, async () => {
    const res = await FinanceService.ListAccounts(period)
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'cuentas no disponibles')
    return res.data
  })
  if (query.status !== 'error' && (query.data?.accounts.length ?? 0) === 0) return null
  // A month that has not started, or before the account's opening, cannot be closed.
  const canReconcile = (a: AccountView) => period <= currentPeriod() && a.openingPeriod <= period
  return (
    <Section title="Cuentas" action={<Link to={{ page: 'config', section: 'cuentas' }}>Administrar</Link>}>
      {query.status === 'error' ? (
        <QueryError message={query.error} onRetry={() => invalidate('ledger')} />
      ) : (
        <>
          <ul className="space-y-2.5 text-sm">
            {(query.data?.accounts ?? []).map((a) => (
              <li key={a.id} className="space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-fg-muted">{a.name}</span>
                    {a.conciliacion && (
                      <Badge tone="positive" icon={CircleCheck}>
                        Conciliada
                      </Badge>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <strong className={`tabular-nums ${isNegative(a.balance) ? 'text-negative-fg' : 'text-fg'}`}>{formatCLP(a.balance)}</strong>
                    {canReconcile(a) && (
                      <Menu
                        label={`Acciones de la cuenta ${a.name}`}
                        items={[
                          {
                            label: a.conciliacion ? `Editar conciliación de ${periodLabel(period)}…` : `Conciliar ${periodLabel(period)}…`,
                            icon: Scale,
                            onSelect: () => setReconciling(a),
                          },
                        ]}
                      />
                    )}
                  </span>
                </div>
                {a.conciliacion && !isZero(a.conciliacion.diferencia) && (
                  <p className="text-xs text-fg-subtle">
                    El banco dice {formatCLP(a.conciliacion.saldoReal)}; la app calculaba {formatCLP(a.conciliacion.calculado)}.
                  </p>
                )}
              </li>
            ))}
          </ul>
          <CardsOwedList cards={query.data?.cards ?? []} />
        </>
      )}
      {reconciling && (
        <AccountReconcileDialog
          account={reconciling}
          period={period}
          onClose={() => setReconciling(null)}
          onSaved={() => invalidate('ledger')}
        />
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
  const query = useQuery(`accounts-view:${period}:${version}`, async () => {
    const res = await FinanceService.ListAccounts(period)
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'cuentas no disponibles')
    return res.data
  })

  async function remove(id: number) {
    if (!failed(await FinanceService.DeleteAccount(id))) invalidate('ledger')
  }

  return (
    <Section
      title={`Cuentas · saldo a ${periodLabel(period)}`}
      action={
        <Button icon={Plus} onClick={() => setEditing(null)}>
          Nueva cuenta
        </Button>
      }
    >
      {query.status === 'error' ? (
        <QueryError message={query.error} onRetry={() => invalidate('ledger')} />
      ) : !query.data ? (
        <SkeletonRows rows={3} />
      ) : query.data.accounts.length === 0 ? (
        <EmptyState icon={Landmark} title="Aún no tienes cuentas" action={<Button icon={Plus} onClick={() => setEditing(null)}>Agregar una cuenta</Button>}>
          Agrega tus cuentas (corriente, vista, efectivo) para ver cuánto hay en cada una. Luego indica en tus gastos, ingresos y
          tarjetas de qué cuenta salen.
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {query.data.accounts.map((a: AccountView) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-center gap-3">
                  <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sunken text-fg-muted ring-1 ring-inset ring-line">
                    <Landmark className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 font-medium text-fg">
                      {a.name}
                      {a.receivesSalary && <Badge tone="positive">Recibe el sueldo</Badge>}
                    </div>
                    <div className="text-xs text-fg-muted">
                      {KIND_LABEL[a.kind] ?? a.kind} · este mes +{formatCLP(a.ingresos)} / −{formatCLP(a.gastos)}
                      {(!isZero(a.transferIn) || !isZero(a.transferOut)) && (
                        <>
                          {' '}
                          · transferencias +{formatCLP(a.transferIn)} / −{formatCLP(a.transferOut)}
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <strong className={`mr-1 tabular-nums ${isNegative(a.balance) ? 'text-negative-fg' : 'text-fg'}`}>{formatCLP(a.balance)}</strong>
                  <Button variant="secondary" size="sm" icon={Pencil} onClick={() => setEditing(a)}>
                    Editar
                  </Button>
                  <ConfirmAction label={`Eliminar la cuenta ${a.name}`} iconOnly onConfirm={() => remove(a.id)} />
                </div>
              </li>
            ))}
          </ul>
          <CardsOwedList cards={query.data.cards} />
          <p className="mt-3 text-xs text-fg-subtle">
            Sin cuenta este mes: +{formatCLP(query.data.unassignedIngresos)} / −{formatCLP(query.data.unassignedGastos)}. Lo que
            compras con tarjeta sale de su cuenta el mes en que pagas el estado de cuenta. Eliminar una cuenta deja sus
            movimientos sin cuenta y borra sus conciliaciones; si una transferencia la usa, termínala o elimínala antes.
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
  // MoneyInput holds a magnitude; an overdrawn start is an explicit choice (as in the reconcile dialogs).
  const [opening, setOpening] = useState(account?.openingBalance.replace(/^-/, '') ?? '0')
  const [overdrawn, setOverdrawn] = useState(account ? isNegative(account.openingBalance) : false)
  const [openingPeriod, setOpeningPeriod] = useState(account?.openingPeriod ?? defaultPeriod)
  const [salary, setSalary] = useState(account?.receivesSalary ?? false)
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    const balance = withSign(opening || '0', overdrawn)
    try {
      const res = account
        ? await FinanceService.UpdateAccount(account.id, name, kind, balance, openingPeriod, salary)
        : await FinanceService.CreateAccount(name, kind, balance, openingPeriod, salary)
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
          <Field
            label="Tipo"
            hint={kind === 'digital' ? 'Mercado Pago, Tenpo, MACH: se carga con plata antes de usarla.' : undefined}
          >
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 items-start gap-3">
          <Field label="Saldo al inicio del mes" hint="Lo que tenía antes de los movimientos de ese mes (por ejemplo, antes del sueldo).">
            <MoneyInput value={opening} onChange={setOpening} placeholder="0" />
          </Field>
          <Field label="Mes">
            <input type="month" className={inputCls} value={openingPeriod} onChange={(e) => setOpeningPeriod(e.target.value)} required />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input type="checkbox" className="size-4 accent-accent" checked={overdrawn} onChange={(e) => setOverdrawn(e.target.checked)} />
          Saldo negativo (cuenta sobregirada)
        </label>
        <p className="text-xs text-fg-subtle">
          Se pone una sola vez: desde ahí la app sigue sola mes a mes. Si después no calza con el banco, usa «Conciliar» en el panel
          Cuentas del Resumen.
        </p>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" className="size-4 accent-accent" checked={salary} onChange={(e) => setSalary(e.target.checked)} />
          Aquí cae mi sueldo
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy}>
            Guardar
          </Button>
        </div>
      </form>
    </Modal>
  )
}
