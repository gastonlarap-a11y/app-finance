import { useState, type SubmitEvent } from 'react'
import { useAtomValue } from 'jotai'
import { Plus, X } from 'lucide-react'
import { FinanceService } from '@/services/finance'
import { periodAtom } from '@/atoms/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { formatCLP } from '@/lib/format'
import { Button, Callout, Field, IconButton, MoneyInput, Section, inputCls } from './ui'
import { useAccounts } from './Accounts'

export function IncomePanel() {
  const period = useAtomValue(periodAtom)
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const reload = () => invalidate('ledger')

  const key = `${period}:${version}`
  const query = useQuery(key, async () => {
    const [sal, extras] = await Promise.all([FinanceService.GetSalary(period), FinanceService.ListIncomes(period)])
    // A failed salary read must surface as an error, never as "0": saving that
    // zero would overwrite the real salary.
    if (sal.error || !sal.data) throw new Error(sal.error?.message ?? 'sueldo no disponible')
    return { salary: sal.data.amount, extras }
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

  async function addExtra(e: SubmitEvent) {
    e.preventDefault()
    if (!desc.trim() || !amount) {
      setFormError('Completa la descripción y el monto.')
      return
    }
    setFormError('')
    if (!failed(await FinanceService.CreateIncome(period, desc, amount))) {
      setDesc('')
      setAmount('')
      reload()
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
        <div>
          <Field label="Sueldo de este mes">
            <div className="flex gap-2">
              <MoneyInput value={salary} onChange={(v) => setDraft({ key, value: v })} placeholder="0" />
              <Button variant="secondary" onClick={saveSalary} loading={busy} disabled={!loaded || salary === savedSalary}>
                Guardar
              </Button>
            </div>
          </Field>
          <p className="mt-1 text-xs text-fg-subtle">Solo para este mes.</p>
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
              <Button type="submit" icon={Plus} className="shrink-0 px-3">
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
    </Section>
  )
}
