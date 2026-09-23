import { useState } from 'react'
import { useSetAtom } from 'jotai'
import { FinanceService, type RecurringSuggestion } from '@/services/finance'
import { refreshAtom } from '@/atoms/finance'
import { failed } from '@/lib/result'
import { notify } from '@/lib/notify'
import { useQuery } from '@/lib/useQuery'
import { formatCLP, monthLabel, periodLabel } from '@/lib/format'
import { Button, Section } from './ui'

function keyOf(s: RecurringSuggestion): string {
  return `${s.merchant}|${s.description}`
}

// RecurringSuggestions lists one-off charges that keep repeating every month and
// converts one into a fixed expense starting the month after its last charge
// (so nothing is counted twice).
export function RecurringSuggestions({ period, refresh }: { period: string; refresh: number }) {
  const bump = useSetAtom(refreshAtom)
  // Dismissed only for this session: the detector is cheap and the user may
  // change their mind next time.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)

  const query = useQuery(`${period}:${refresh}`, async () => {
    const res = await FinanceService.DetectRecurring(period)
    if (res.error) throw new Error(res.error.message)
    return res.data ?? []
  })

  const visible = (query.data ?? []).filter((s) => !dismissed.has(keyOf(s)))
  if (visible.length === 0) return null

  async function convert(s: RecurringSuggestion) {
    setBusy(keyOf(s))
    try {
      const res = await FinanceService.CreateFixedExpense(s.description, s.category, s.cardId, s.nextPeriod, s.amount)
      if (failed(res)) return
      notify(`«${s.description}» ahora es un gasto fijo desde ${periodLabel(s.nextPeriod)}.`, 'success')
      bump((n) => n + 1)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title="¿Gastos que se repiten?">
      <p className="mb-3 text-xs text-slate-500">
        Estos gastos únicos aparecen casi todos los meses con un monto parecido. Conviértelos en gasto fijo y se
        cargarán solos desde el mes siguiente a su último cobro.
      </p>
      <ul className="space-y-2">
        {visible.map((s) => (
          <li key={keyOf(s)} className="flex flex-wrap items-center justify-between gap-2 rounded-base bg-surface p-3 ring-1 ring-slate-800">
            <div>
              <div className="font-medium">
                {s.description}
                {s.merchant && s.merchant !== s.description && <span className="text-slate-400"> · {s.merchant}</span>}
              </div>
              <div className="text-xs text-slate-500">
                {formatCLP(s.amount)} · visto en {s.periods.map((p) => monthLabel(p)).join(', ')}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={() => convert(s)} disabled={busy !== null}>
                {busy === keyOf(s) ? 'Creando…' : 'Hacer fijo'}
              </Button>
              <Button variant="ghost" onClick={() => setDismissed((d) => new Set(d).add(keyOf(s)))}>
                Ignorar
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  )
}
