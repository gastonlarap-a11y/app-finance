// UF values for fixed expenses priced in UF. Source: mindicador.cl, a free
// public API (no key) that republishes the Banco Central series and allows
// CORS from any origin, so the desktop webview and the iPad PWA share this one
// implementation — like the statement parsers, the backend never goes online
// for it. The app stores the value of day 1 of each month (SetUFValues); a
// month not downloaded yet is estimated with the closest known one.
import { useEffect } from 'react'
import { FinanceService } from '@/services/finance'
import type { UFValueInput } from '@/services/contract'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { failed } from '@/lib/result'

const API = 'https://mindicador.cl/api/uf/'
const TIMEOUT_MS = 15_000

// parseSeries keeps each month's day-1 value from a /api/uf/{year} response.
// `fecha` is Chile's midnight written in UTC ("2026-09-01T04:00:00.000Z"), so
// its UTC date is the local one.
export function parseSeries(body: unknown): UFValueInput[] {
  if (typeof body !== 'object' || body === null || !('serie' in body) || !Array.isArray(body.serie)) return []
  const out: UFValueInput[] = []
  for (const entry of body.serie as unknown[]) {
    if (typeof entry !== 'object' || entry === null || !('fecha' in entry) || !('valor' in entry)) continue
    const { fecha, valor } = entry
    if (typeof fecha !== 'string' || typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) continue
    const day1 = /^(\d{4})-(\d{2})-01T/.exec(fecha)
    if (!day1) continue
    // The UF is published with two decimals: toFixed(2) returns them exactly.
    out.push({ period: `${day1[1]}-${day1[2]}`, value: valor.toFixed(2) })
  }
  return out
}

// fetchUFValues downloads the years `periods` fall in and returns the values
// found for them (months not yet published are simply missing).
export async function fetchUFValues(periods: readonly string[], fetchFn: typeof fetch = fetch): Promise<UFValueInput[]> {
  const wanted = new Set(periods)
  const out: UFValueInput[] = []
  for (const year of new Set(periods.map((p) => p.slice(0, 4)))) {
    const res = await fetchFn(API + year, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`mindicador.cl respondió ${res.status}`)
    for (const v of parseSeries(await res.json())) if (wanted.has(v.period)) out.push(v)
  }
  return out
}

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
