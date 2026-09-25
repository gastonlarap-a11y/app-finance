// Currency + period helpers. Amounts arrive from Go as decimal strings (CLP, no
// decimals); format with es-CL so thousands use a dot: 150000 -> "$150.000".

const clp = new Intl.NumberFormat('es-CL', {
  style: 'currency',
  currency: 'CLP',
  maximumFractionDigits: 0,
})

const DECIMAL_RE = /^-?\d+(\.\d+)?$/

// formatCLP formats the backend's decimal string directly (Intl.NumberFormat
// accepts numeric strings exactly, with no float round-trip); anything that is
// not a plain decimal renders as $0.
export function formatCLP(v: string | number | null | undefined): string {
  if (typeof v === 'number') return clp.format(Number.isFinite(v) ? v : 0)
  const s = (v ?? '').trim()
  return clp.format(DECIMAL_RE.test(s) ? (s as Intl.StringNumericLiteral) : 0)
}

const usd = new Intl.NumberFormat('es-CL', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

// formatAmount formats a decimal string in its currency: CLP as formatCLP,
// USD with cents ("US$20,00"), anything else as the bare number and its code.
export function formatAmount(v: string, currency: string): string {
  if (currency === 'CLP' || currency === '') return formatCLP(v)
  const s = v.trim()
  if (currency === 'USD') return usd.format(DECIMAL_RE.test(s) ? (s as Intl.StringNumericLiteral) : 0)
  return `${s} ${currency}`
}

// Live thousands-separator masking for money <input>s (es-CL: '.' groups
// thousands, ',' marks decimals). The "real" value is a whole-peso digit
// string (what's sent to the backend: CLP has no minor unit); the input shows
// the same digits grouped. All string math: Number() loses digits past 2^53.

// roundDigits rounds "<int>" + fraction digits half-up to whole pesos.
function roundDigits(int: string, fraction: string): string {
  const whole = int.replace(/^0+(?=\d)/, '') || '0'
  if (!/^[5-9]/.test(fraction)) return whole
  // Add one to the digit string, carrying.
  const out = whole.split('')
  let i = out.length - 1
  while (i >= 0 && out[i] === '9') out[i--] = '0'
  if (i < 0) out.unshift('1')
  else out[i] = String(Number(out[i]) + 1)
  return out.join('')
}

// formatThousands groups a value's whole pesos: '1234567' → '1.234.567'. A
// stored decimal ('15000.5', dot as decimal point) is shown rounded, never as
// if its decimals were more thousands.
export function formatThousands(value: string): string {
  const decimal = /^(\d+)\.(\d+)$/.exec(value)
  const digits = decimal ? roundDigits(decimal[1] ?? '', decimal[2] ?? '') : value.replace(/\D/g, '')
  if (digits === '') return ''
  return (digits.replace(/^0+(?=\d)/, '') || '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

// parseThousands reads what the user typed or pasted, in es-CL format:
// '1.234.567' → '1234567', and '1.234,50' → '1235' (rounded to whole pesos,
// where stripping every non-digit used to give 123450).
export function parseThousands(typed: string): string {
  const comma = typed.indexOf(',')
  const int = (comma < 0 ? typed : typed.slice(0, comma)).replace(/\D/g, '')
  const fraction = comma < 0 ? '' : typed.slice(comma + 1).replace(/\D/g, '')
  if (int === '' && fraction === '') return ''
  return roundDigits(int, fraction)
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

export function formatDate(d: string | null | undefined): string {
  if (!d) return '—'
  const iso = d.slice(0, 10)
  const [y, mo, day] = iso.split('-')
  const dt = new Date(Number(y), Number(mo) - 1, Number(day))
  return dt.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })
}
