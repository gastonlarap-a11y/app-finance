import type { ReactNode } from 'react'

export const inputCls =
  'w-full rounded bg-surface px-3 py-2 text-slate-100 outline-none ring-1 ring-slate-700 focus:ring-2 focus:ring-primary'

export function Section({
  title,
  action,
  children,
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-base bg-surface-alt p-5">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title ? <h2 className="text-lg font-semibold">{title}</h2> : <span />}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function StatCard({
  label,
  value,
  tone = 'default',
  hint,
}: {
  label: string
  value: string
  tone?: 'default' | 'success' | 'danger' | 'primary'
  hint?: string
}) {
  const toneCls =
    tone === 'success'
      ? 'text-success'
      : tone === 'danger'
        ? 'text-danger'
        : tone === 'primary'
          ? 'text-primary'
          : 'text-slate-100'
  return (
    <div className="rounded-base bg-surface p-4 ring-1 ring-slate-800">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${toneCls}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  )
}

type ButtonProps = {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'danger'
  type?: 'button' | 'submit'
  disabled?: boolean
  className?: string
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  type = 'button',
  disabled,
  className = '',
}: ButtonProps) {
  const base = 'rounded px-4 py-2 text-sm font-medium transition disabled:opacity-50'
  const variants = {
    primary: 'bg-primary hover:bg-primary-dark text-white',
    ghost: 'bg-surface ring-1 ring-slate-700 hover:ring-slate-500 text-slate-200',
    danger: 'bg-danger/90 hover:bg-danger text-white',
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </button>
  )
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-base bg-surface-alt p-6 shadow-2xl ring-1 ring-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="text-xl leading-none text-slate-400 hover:text-slate-200">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-slate-300">{label}</span>
      {children}
    </label>
  )
}

export function Bar({ value, max, tone = 'primary' }: { value: number; max: number; tone?: 'primary' | 'danger' | 'success' }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  const bg = tone === 'danger' ? 'bg-danger' : tone === 'success' ? 'bg-success' : 'bg-primary'
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
      <div className={`h-full ${bg}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-base bg-surface p-6 text-center text-slate-500">{children}</div>
}

export function Spinner() {
  return <div className="p-6 text-center text-slate-500">Cargando…</div>
}
