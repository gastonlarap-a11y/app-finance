import { useEffect, useState } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { FinanceService, type Income } from '@/services/finance'
import { periodAtom, refreshAtom } from '@/atoms/finance'
import { failed } from '@/lib/result'
import { formatCLP } from '@/lib/format'
import { Button, Field, MoneyInput, Section, inputCls } from './ui'

export function IncomePanel() {
  const [period] = useAtom(periodAtom)
  const [refresh] = useAtom(refreshAtom)
  const bump = useSetAtom(refreshAtom)

  const [salary, setSalary] = useState('')
  const [savedSalary, setSavedSalary] = useState('')
  const [extras, setExtras] = useState<Income[]>([])
  const [desc, setDesc] = useState('')
  const [amount, setAmount] = useState('')
  const [formError, setFormError] = useState('')

  useEffect(() => {
    let active = true
    Promise.all([FinanceService.GetSalary(period), FinanceService.ListIncomes(period)]).then(([sal, inc]) => {
      if (!active) return
      const value = sal.data ? String(sal.data.amount ?? '0') : '0'
      setSalary(value)
      setSavedSalary(value)
      setExtras(inc ?? [])
    })
    return () => {
      active = false
    }
  }, [period, refresh])

  async function saveSalary() {
    const res = await FinanceService.SetSalary(period, salary || '0')
    if (!failed(res)) bump((n) => n + 1)
  }

  async function addExtra(e: React.FormEvent) {
    e.preventDefault()
    if (!desc.trim() || !amount) {
      setFormError('Completa la descripción y el monto.')
      return
    }
    setFormError('')
    const res = await FinanceService.CreateIncome(period, desc, amount)
    if (!failed(res)) {
      setDesc('')
      setAmount('')
      bump((n) => n + 1)
    }
  }

  async function removeExtra(id: number) {
    const res = await FinanceService.DeleteIncome(id)
    if (!failed(res)) bump((n) => n + 1)
  }

  return (
    <Section title="Ingresos">
      <div className="space-y-4">
        <div>
          <Field label="Sueldo de este mes">
            <div className="flex gap-2">
              <MoneyInput value={salary} onChange={setSalary} placeholder="0" />
              <Button variant="ghost" onClick={saveSalary} disabled={salary === savedSalary}>
                Guardar
              </Button>
            </div>
          </Field>
          <p className="mt-1 text-xs text-slate-500">Solo para este mes.</p>
        </div>

        <div>
          <div className="mb-2 text-sm text-slate-300">Extras / bonos de este mes</div>
          {extras.length > 0 && (
            <ul className="mb-3 space-y-1">
              {extras.map((x) => (
                <li key={x.id} className="flex items-center justify-between text-sm">
                  <span className="truncate text-slate-300">{x.description}</span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums text-success">{formatCLP(x.amount)}</span>
                    <button onClick={() => removeExtra(x.id)} className="text-slate-500 hover:text-danger" title="Eliminar">
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={addExtra} className="space-y-1">
            <div className="flex gap-2">
              <input className={inputCls} value={desc} onChange={(e) => { setDesc(e.target.value); setFormError('') }} placeholder="Bono, aguinaldo…" required />
              <MoneyInput
                className={`${inputCls} w-28`}
                value={amount}
                onChange={(v) => { setAmount(v); setFormError('') }}
                placeholder="0"
                required
              />
              <Button type="submit">+</Button>
            </div>
            {formError && <p className="text-xs text-danger">{formError}</p>}
          </form>
        </div>
      </div>
    </Section>
  )
}
