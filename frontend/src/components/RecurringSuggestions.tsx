import { useState } from 'react'
import { FinanceService, type RecurringSuggestion } from '@/services/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { notify } from '@/lib/notify'
import { useQuery } from '@/lib/useQuery'
import { formatCLP, monthLabel, periodLabel } from '@/lib/format'
import { Repeat } from 'lucide-react'
import { Button, Section } from './ui'

function keyOf(s: RecurringSuggestion): string {
  return `${s.merchant}|${s.description}`
}

// RecurringSuggestions lists one-off charges that keep repeating every month and
// converts one into a fixed expense starting the month after its last charge
// (so nothing is counted twice).
export function RecurringSuggestions({ period }: { period: string }) {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  // Dismissed only for this session: the detector is cheap and the user may
  // change their mind next time.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)

  const query = useQuery(`${period}:${version}`, async () => {
    const res = await FinanceService.DetectRecurring(period)
    if (res.error) throw new Error(res.error.message)
    return res.data ?? []
  })

  const visible = (query.data ?? []).filter((s) => !dismissed.has(keyOf(s)))
  if (visible.length === 0) return null

  async function convert(s: RecurringSuggestion) {
    setBusy(keyOf(s))
    try {
      const res = await FinanceService.CreateFixedExpense(s.description, s.category, s.cardId, s.nextPeriod, s.amount, 1, 'CLP')
      if (failed(res)) return
      notify(`«${s.description}» ahora es un gasto fijo desde ${periodLabel(s.nextPeriod)}.`, 'success')
      invalidate('ledger')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title="¿Gastos que se repiten?">
      <p className="mb-3 text-sm text-fg-muted">
        Estos gastos únicos aparecen casi todos los meses con un monto parecido. Conviértelos en gasto fijo y se
        cargarán solos desde el mes siguiente a su último cobro.
      </p>
      <ul className="space-y-2">
        {visible.map((s) => (
          <li key={keyOf(s)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-sunken p-3 ring-1 ring-inset ring-line">
            <div className="flex min-w-0 items-start gap-3">
              <Repeat aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
              <div className="min-w-0">
                <div className="font-medium text-fg">
                  {s.description}
                  {s.merchant && s.merchant !== s.description && <span className="text-fg-muted"> · {s.merchant}</span>}
                </div>
                <div className="text-xs text-fg-subtle">
                  {formatCLP(s.amount)} · visto en {s.periods.map((p) => monthLabel(p)).join(', ')}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void convert(s)} loading={busy === keyOf(s)} disabled={busy !== null}>
                Hacer fijo
              </Button>
              <Button variant="quiet" size="sm" onClick={() => setDismissed((d) => new Set(d).add(keyOf(s)))}>
                Ignorar
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  )
}
