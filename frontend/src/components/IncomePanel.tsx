import { useState, type SubmitEvent } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FinanceService } from '@/services/finance'
import { periodAtom, refreshAtom } from '@/atoms/finance'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { formatCLP } from '@/lib/format'
import { Button, Field, IconButton, MoneyInput, Section, inputCls } from './ui'

export function IncomePanel() {
  const period = useAtomValue(periodAtom)
  const refresh = useAtomValue(refreshAtom)
  const bump = useSetAtom(refreshAtom)
  const reload = () => bump((n) => n + 1)

  const key = `${period}:${refresh}`
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

  return (
    <Section title="Ingresos">
      {query.status === 'error' && (
        <p role="alert" className="mb-3 rounded bg-danger/10 px-3 py-2 text-sm text-red-200">
          No se pudo cargar el sueldo: {query.error}.{' '}
          <button type="button" className="underline" onClick={reload}>
            Reintentar
          </button>
        </p>
      )}
      <div className="space-y-4">
        <div>
          <Field label="Sueldo de este mes">
            <div className="flex gap-2">
              <MoneyInput value={salary} onChange={(v) => setDraft({ key, value: v })} placeholder="0" />
              <Button variant="ghost" onClick={saveSalary} disabled={!loaded || busy || salary === savedSalary}>
                {busy ? 'Guardando…' : 'Guardar'}
              </Button>
            </div>
          </Field>
          <p className="mt-1 text-xs text-slate-500">Solo para este mes.</p>
        </div>

        <div>
          <div className="mb-2 text-sm text-slate-300">Extras / bonos de este mes</div>
          {loaded && loaded.extras.length > 0 && (
            <ul className="mb-3 space-y-1">
              {loaded.extras.map((x) => (
                <li key={x.id} className="flex items-center justify-between text-sm">
                  <span className="truncate text-slate-300">{x.description}</span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums text-success">{formatCLP(x.amount)}</span>
                    <IconButton label={`Eliminar ${x.description}`} onClick={() => removeExtra(x.id)} className="text-slate-500 hover:text-danger">
                      ✕
                    </IconButton>
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
              <Button type="submit">
                <span aria-hidden="true">+</span>
                <span className="sr-only">Agregar ingreso extra</span>
              </Button>
            </div>
            {formError && (
              <p role="alert" className="text-xs text-danger">
                {formError}
              </p>
            )}
          </form>
        </div>
      </div>
    </Section>
  )
}
