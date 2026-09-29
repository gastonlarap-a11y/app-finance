import { useState, type SubmitEvent } from 'react'
import { useAtomValue } from 'jotai'
import { Plus, X } from 'lucide-react'
import { FinanceService, type BaseSalary, type OpResult } from '@/services/finance'
import { periodAtom } from '@/atoms/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { isZero } from '@/lib/money'
import { formatCLP, periodLabel } from '@/lib/format'
import { Badge, Button, Callout, Field, IconButton, Modal, MoneyInput, Section, inputCls } from './ui'
import { useAccounts } from './Accounts'

export function IncomePanel() {
  const period = useAtomValue(periodAtom)
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const reload = () => invalidate('ledger')

  const key = `${period}:${version}`
  const query = useQuery(key, async () => {
    const [sal, extras, base] = await Promise.all([
      FinanceService.GetSalary(period),
      FinanceService.ListIncomes(period),
      FinanceService.GetBaseSalary(period),
    ])
    // A failed salary read must surface as an error, never as "0": saving that
    // zero would overwrite the real salary.
    if (sal.error || !sal.data) throw new Error(sal.error?.message ?? 'sueldo no disponible')
    if (base.error) throw new Error(base.error.message)
    return { salary: sal.data.amount, expected: sal.data.expected, extras, base: base.data ?? null }
  })

  // The salary input's unsaved edit, tied to the load it was typed over so a
  // month change or refetch discards it instead of leaking into another month.
  const [draft, setDraft] = useState<{ key: string; value: string } | null>(null)
  const [desc, setDesc] = useState('')
  const [amount, setAmount] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)

  const loaded = query.status === 'success' ? query.data : undefined
  const savedSalary = loaded?.salary ?? ''
  const salary = draft?.key === key ? draft.value : savedSalary

  async function saveSalary() {
    if (!loaded) return
    setBusy(true)
    try {
      if (!failed(await FinanceService.SetSalary(period, salary || '0'))) {
        setDraft(null)
        reload()
      }
    } finally {
      setBusy(false)
    }
  }

  // run performs one salary action and refetches on success.
  async function run(action: () => Promise<OpResult>) {
    setBusy(true)
    try {
      if (!failed(await action())) reload()
    } finally {
      setBusy(false)
    }
  }

  const [editingBase, setEditingBase] = useState(false)

  const [adding, setAdding] = useState(false)
  async function addExtra(e: SubmitEvent) {
    e.preventDefault()
    if (adding) return
    if (!desc.trim() || !amount) {
      setFormError('Completa la descripción y el monto.')
      return
    }
    setFormError('')
    setAdding(true)
    try {
      if (!failed(await FinanceService.CreateIncome(period, desc, amount))) {
        setDesc('')
        setAmount('')
        reload()
      }
    } finally {
      setAdding(false)
    }
  }

  async function removeExtra(id: number) {
    if (!failed(await FinanceService.DeleteIncome(id))) reload()
  }

  const accounts = useAccounts()
  async function setIncomeAccount(id: number, accountId: number | null) {
    if (!failed(await FinanceService.SetIncomeAccount(id, accountId))) reload()
  }

  return (
    <Section title="Ingresos">
      {query.status === 'error' && (
        <Callout
          tone="negative"
          role="alert"
          className="mb-4"
          action={
            <Button variant="secondary" size="sm" onClick={reload}>
              Reintentar
            </Button>
          }
        >
          No se pudo cargar el sueldo: {query.error}.
        </Callout>
      )}
      <div className="space-y-5">
        <div className="space-y-2">
          <Field label="Sueldo de este mes">
            <div className="flex gap-2">
              <MoneyInput value={salary} onChange={(v) => setDraft({ key, value: v })} placeholder="0" />
              <Button variant="secondary" onClick={saveSalary} loading={busy} disabled={!loaded || salary === savedSalary}>
                Guardar
              </Button>
            </div>
          </Field>
          {loaded?.expected ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              <Badge tone="info">Esperado</Badge>
              <span>Es tu sueldo base: confírmalo cuando llegue, o cambia el monto de este mes.</span>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => FinanceService.SetSalary(period, savedSalary))}>
                Confirmar
              </Button>
            </div>
          ) : (
            loaded?.base &&
            !isZero(savedSalary) && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
                <span>Confirmado para este mes.</span>
                <Button size="sm" variant="quiet" disabled={busy} onClick={() => void run(() => FinanceService.DeleteSalary(period))}>
                  Volver al sueldo base
                </Button>
              </div>
            )
          )}
          {loaded && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-sunken px-3 py-2 text-xs text-fg-muted ring-1 ring-inset ring-line">
              {loaded.base ? (
                <span>
                  Sueldo base <strong className="tabular-nums text-fg">{formatCLP(loaded.base.amount)}</strong> desde{' '}
                  {periodLabel(loaded.base.effectiveFrom).toLowerCase()}: se repite cada mes.
                </span>
              ) : (
                <span>Sin sueldo base: cada mes empieza en $0 hasta que anotes el sueldo.</span>
              )}
              <span className="flex gap-1.5">
                {loaded.base ? (
                  <>
                    <Button size="sm" variant="quiet" onClick={() => setEditingBase(true)}>
                      Cambiar
                    </Button>
                    <Button size="sm" variant="quiet" disabled={busy} onClick={() => void run(() => FinanceService.EndBaseSalary(period))}>
                      Terminar desde este mes
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={busy || isZero(savedSalary || '0')}
                    onClick={() => void run(() => FinanceService.SetBaseSalary(period, savedSalary))}
                  >
                    Repetir este sueldo cada mes
                  </Button>
                )}
              </span>
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-fg-muted">Extras / bonos de este mes</p>
          {loaded && loaded.extras.length > 0 && (
            <ul className="mb-3 divide-y divide-line">
              {loaded.extras.map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                  <span className="min-w-0 truncate text-fg">{x.description}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {accounts.length > 0 && (
                      <select
                        aria-label={`Cuenta de ${x.description}`}
                        className="h-7 rounded-md bg-sunken px-1 text-xs text-fg-muted outline-none ring-1 ring-inset ring-line focus:ring-2 focus:ring-focus"
                        value={x.accountId === null ? '' : String(x.accountId)}
                        onChange={(e) => void setIncomeAccount(x.id, e.target.value === '' ? null : Number(e.target.value))}
                      >
                        <option value="">Sin cuenta</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={String(a.id)}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    )}
                    <span className="tabular-nums text-positive-fg">{formatCLP(x.amount)}</span>
                    <IconButton label={`Eliminar ${x.description}`} icon={X} tone="danger" size="sm" onClick={() => void removeExtra(x.id)} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={addExtra} className="space-y-1">
            <div className="flex gap-2">
              <input
                className={inputCls}
                aria-label="Descripción del ingreso extra"
                value={desc}
                onChange={(e) => {
                  setDesc(e.target.value)
                  setFormError('')
                }}
                placeholder="Bono, aguinaldo…"
                required
              />
              <MoneyInput
                className={`${inputCls} w-28`}
                aria-label="Monto del ingreso extra"
                value={amount}
                onChange={(v) => {
                  setAmount(v)
                  setFormError('')
                }}
                placeholder="0"
                required
              />
              <Button type="submit" icon={Plus} className="shrink-0 px-3" loading={adding}>
                <span className="sr-only">Agregar ingreso extra</span>
              </Button>
            </div>
            {formError && (
              <p role="alert" className="text-xs text-negative-fg">
                {formError}
              </p>
            )}
          </form>
        </div>
      </div>
      {editingBase && loaded?.base && (
        <BaseSalaryForm base={loaded.base} defaultPeriod={period} onClose={() => setEditingBase(false)} onSaved={reload} />
      )}
    </Section>
  )
}

// BaseSalaryForm changes the base salary from a month on; earlier months keep
// theirs and a month's confirmed salary always wins.
function BaseSalaryForm({
  base,
  defaultPeriod,
  onClose,
  onSaved,
}: {
  base: BaseSalary
  defaultPeriod: string
  onClose: () => void
  onSaved: () => void
}) {
  const [amount, setAmount] = useState(base.amount)
  const [from, setFrom] = useState(defaultPeriod)
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      if (failed(await FinanceService.SetBaseSalary(from, amount))) return
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Cambiar sueldo base" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 items-start gap-3">
          <Field label="Sueldo base">
            <MoneyInput value={amount} onChange={setAmount} required autoFocus />
          </Field>
          <Field label="Desde">
            <input type="month" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} required />
          </Field>
        </div>
        <p className="text-xs text-fg-subtle">
          Se espera cada mes desde ahí. Los meses anteriores y los sueldos que ya confirmaste no cambian.
        </p>
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
