// Small display pieces for finance data shared by several views.

// Bar is a display-only progress bar; `fill` is a 0..1 proportion (see
// lib/money ratio, which computes it from decimal strings).
export function Bar({ fill, tone = 'primary' }: { fill: number; tone?: 'primary' | 'danger' | 'success' | 'warning' }) {
  const pct = Math.min(100, Math.max(0, fill * 100))
  const bg = { danger: 'bg-negative-fg', success: 'bg-positive-fg', warning: 'bg-caution-fg', primary: 'bg-accent' }[tone]
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-sunken" aria-hidden="true">
      <div className={`h-full rounded-full ${bg}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

// TagChips shows an expense's tags (renders nothing without tags).
export function TagChips({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null
  return (
    <span className="mt-0.5 flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t} className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-fg">
          #{t}
        </span>
      ))}
    </span>
  )
}

// BankDescription shows the bank's descriptor of an expense entered by hand
// and then merged with its bank movement, under the user's own description.
export function BankDescription({ text }: { text: string }) {
  if (text === '') return null
  return (
    <span className="block max-w-[260px] truncate font-mono text-[11px] text-fg-subtle" title={`En el banco: ${text}`}>
      Banco: {text}
    </span>
  )
}

// BankCodes shows the bank's reference codes of an expense (one per statement
// that reported it), each selectable whole to quote it in a dispute.
export function BankCodes({ codes }: { codes: readonly string[] }) {
  if (codes.length === 0) return null
  return (
    <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-fg-subtle">
      Cód. banco
      {codes.map((c) => (
        <span key={c} className="select-all font-mono">
          {c}
        </span>
      ))}
    </span>
  )
}
