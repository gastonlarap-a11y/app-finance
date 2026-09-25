import { useEffect, useId, useRef, type ChangeEvent, type ReactNode, type SelectHTMLAttributes } from 'react'
import { useAtomValue } from 'jotai'
import { formatThousands, parseThousands } from '@/lib/format'
import { dismiss, noticesAtom } from '@/lib/notify'

export const inputCls =
  'h-10 w-full rounded bg-surface px-3 py-2 text-slate-100 outline-none ring-1 ring-slate-700 focus:ring-2 focus:ring-primary'

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

// Icon-only button: the visible glyph is decorative, so an accessible name is
// mandatory (screen readers would otherwise read "wastebasket" or nothing).
export function IconButton({
  label,
  onClick,
  children,
  className = 'text-slate-400 hover:text-slate-200',
}: {
  label: string
  onClick: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={`rounded px-1 ${className}`}>
      <span aria-hidden="true">{children}</span>
    </button>
  )
}

// Modal is a native <dialog> opened with showModal(): the browser provides the
// focus trap, Escape to close (→ onClose via the cancel event), inert
// background and ::backdrop. Mount it only while it should be open.
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean // for tables (a statement's detail); forms keep the narrow default
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    // React's autoFocus runs while the dialog is still closed (display: none),
    // so it is a no-op and showModal() lands on the first focusable — the close
    // button. Move focus to the first form field instead.
    dialog.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')?.focus()
    return () => dialog.close()
  }, [])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault() // let React unmount it, keeping state in charge
        onClose()
      }}
      className={`m-auto max-h-[90vh] w-[calc(100%-2rem)] ${wide ? 'max-w-4xl' : 'max-w-md'} overflow-y-auto rounded-base bg-surface-alt p-6 text-slate-100 shadow-2xl ring-1 ring-slate-700 backdrop:bg-black/60`}
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 id={titleId} className="text-lg font-semibold">
          {title}
        </h3>
        <IconButton label="Cerrar" onClick={onClose} className="text-xl leading-none text-slate-400 hover:text-slate-200">
          ✕
        </IconButton>
      </div>
      {children}
    </dialog>
  )
}

// Toaster renders the in-app notices raised by notify() (errors, confirmations).
export function Toaster() {
  const notices = useAtomValue(noticesAtom)
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
      {notices.map((n) => (
        <div
          key={n.id}
          role={n.tone === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto flex max-w-lg items-start gap-3 rounded-base px-4 py-3 text-sm shadow-xl ring-1 ${
            n.tone === 'error'
              ? 'bg-danger/15 text-red-200 ring-danger/40'
              : n.tone === 'success'
                ? 'bg-success/15 text-emerald-200 ring-success/40'
                : 'bg-surface-alt text-slate-200 ring-slate-700'
          }`}
        >
          <span className="flex-1">{n.message}</span>
          <IconButton label="Descartar aviso" onClick={() => dismiss(n.id)} className="text-current opacity-70 hover:opacity-100">
            ✕
          </IconButton>
        </div>
      ))}
    </div>
  )
}

// QueryError is the inline failure state for a view whose data could not load.
export function QueryError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="space-y-3 rounded-base bg-danger/10 p-6 text-center ring-1 ring-danger/30">
      <p className="text-red-200">No se pudieron cargar los datos: {message}</p>
      <Button variant="ghost" onClick={onRetry}>
        Reintentar
      </Button>
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

// Select with the native dropdown chrome stripped (appearance-none) and a custom
// arrow, so it shares the exact same box height as text inputs — the native
// select/date chrome otherwise renders at a different intrinsic height per
// engine (WKWebView vs. WebView2), making fields in the same form look uneven.
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={`${className ?? inputCls} appearance-none pr-8`} {...rest}>
        {children}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">▾</span>
    </div>
  )
}

type MoneyInputProps = {
  value: string
  onChange: (digits: string) => void
  placeholder?: string
  required?: boolean
  autoFocus?: boolean
  className?: string
  // Only needed when the input is not wrapped in a <Field> label.
  'aria-label'?: string
}

// Text input that displays its numeric value with es-CL thousands separators
// (e.g. "1.500.000") while keeping a clean digit-only string as the real value,
// so users can spot an extra zero before saving.
export function MoneyInput({ value, onChange, placeholder, required, autoFocus, className, 'aria-label': ariaLabel }: MoneyInputProps) {
  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    onChange(parseThousands(e.target.value))
  }
  return (
    <input
      className={className ?? inputCls}
      type="text"
      inputMode="numeric"
      value={formatThousands(value)}
      onChange={handleChange}
      placeholder={placeholder}
      required={required}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
    />
  )
}

// Bar is a display-only progress bar; `fill` is a 0..1 proportion (see
// lib/money ratio, which computes it from decimal strings).
export function Bar({ fill, tone = 'primary' }: { fill: number; tone?: 'primary' | 'danger' | 'success' | 'warning' }) {
  const pct = Math.min(100, Math.max(0, fill * 100))
  const bg = { danger: 'bg-danger', success: 'bg-success', warning: 'bg-warning', primary: 'bg-primary' }[tone]
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface" aria-hidden="true">
      <div className={`h-full ${bg}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-base bg-surface p-6 text-center text-slate-500">{children}</div>
}

export function Spinner() {
  return (
    <div role="status" className="p-6 text-center text-slate-500">
      Cargando…
    </div>
  )
}
