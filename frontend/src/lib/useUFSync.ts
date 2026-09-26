// Background sync of the UF values fixed expenses priced in UF need. Kept apart
// from the pure fetch/parse helpers (lib/uf.ts) because it reaches the bound
// FinanceService: the web CI job tests lib/uf.ts without generated bindings.
import { useEffect } from 'react'
import { FinanceService } from '@/services/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { fetchUFValues } from '@/lib/uf'

// Months already requested this session: next month's value is published
// around the 9th, so asking again on every refetch would only repeat a miss.
const attempted = new Set<string>()

// useUFSync fills in missing UF values in the background whenever the ledger
// changes (e.g. a new UF fixed expense), then refetches the finance views.
// Offline or with the API down, the app keeps working on estimated values
// (flagged in the month view), so the failure is only logged.
export function useUFSync(): void {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  useEffect(() => {
    let active = true
    async function sync() {
      const need = (await FinanceService.UFMonthsNeeded()).filter((p) => !attempted.has(p))
      if (need.length === 0) return
      for (const p of need) attempted.add(p)
      const values = await fetchUFValues(need)
      if (!active || values.length === 0) return
      if (!failed(await FinanceService.SetUFValues(values))) invalidate('ledger')
    }
    sync().catch((err: unknown) => console.warn('No se pudo actualizar la UF; se usan valores estimados.', err))
    return () => {
      active = false
    }
  }, [version, invalidate])
}
