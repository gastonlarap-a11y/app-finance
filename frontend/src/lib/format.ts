// Currency + period helpers. Amounts arrive from Go as decimal strings (CLP, no
// decimals); format with es-CL so thousands use a dot: 150000 -> "$150.000".

const clp = new Intl.NumberFormat('es-CL', {
  style: 'currency',
  currency: 'CLP',
  maximumFractionDigits: 0,
})

export function formatCLP(v: string | number | null | undefined): string {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return clp.format(Number.isFinite(n) ? n : 0)
}

export function currentPeriod(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function shiftPeriod(period: string, delta: number): string {
  const parts = period.split('-')
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function yearOf(period: string): number {
  return Number(period.split('-')[0])
}

export function periodLabel(period: string): string {
  const parts = period.split('-')
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1)
  const label = d.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' })
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function monthLabel(period: string): string {
  const parts = period.split('-')
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1)
  const label = d.toLocaleDateString('es-CL', { month: 'short' })
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function formatDate(d: unknown): string {
  if (!d) return '—'
  const iso = String(d).slice(0, 10)
  const [y, mo, day] = iso.split('-')
  const dt = new Date(Number(y), Number(mo) - 1, Number(day))
  return dt.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })
}
