import {
  createContext,
  use,
  useId,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import { ChevronDown } from 'lucide-react'
import { formatThousands, parseThousands } from '@/lib/format'

export const inputCls =
  'h-10 w-full rounded-lg bg-panel px-3 text-fg outline-none ring-1 ring-inset ring-line-input placeholder:text-fg-subtle focus:ring-2 focus:ring-focus disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:ring-negative-fg'

// FieldContext hands the hint/error ids of a <Field> to the control inside it,
// so Input/Select/MoneyInput wire aria-describedby and aria-invalid by themselves.
type FieldA11y = { describedBy?: string; invalid: boolean }
const FieldContext = createContext<FieldA11y>({ invalid: false })

function useFieldA11y() {
  const { describedBy, invalid } = use(FieldContext)
  return { 'aria-describedby': describedBy, 'aria-invalid': invalid || undefined }
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined
  return (
    <FieldContext value={{ describedBy, invalid: !!error }}>
      <div>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-fg-muted">{label}</span>
          {children}
        </label>
        {error && (
          <p id={errorId} role="alert" className="mt-1 text-sm text-negative-fg">
            {error}
          </p>
        )}
        {hint && (
          <p id={hintId} className="mt-1 text-xs text-fg-subtle">
            {hint}
          </p>
        )}
      </div>
    </FieldContext>
  )
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const a11y = useFieldA11y()
  return <input className={className ?? inputCls} {...a11y} {...rest} />
}

// Select with the native dropdown chrome stripped (appearance-none) and a custom
// arrow, so it shares the exact same box height as text inputs — the native
// select/date chrome otherwise renders at a different intrinsic height per
// engine (WKWebView vs. WebView2), making fields in the same form look uneven.
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  const a11y = useFieldA11y()
  return (
    <div className="relative">
      <select className={`${className ?? inputCls} appearance-none pr-9`} {...a11y} {...rest}>
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
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
  const a11y = useFieldA11y()
  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    onChange(parseThousands(e.target.value))
  }
  return (
    <input
      className={`${className ?? inputCls} tabular-nums`}
      type="text"
      inputMode="numeric"
      value={formatThousands(value)}
      onChange={handleChange}
      placeholder={placeholder}
      required={required}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      {...a11y}
    />
  )
}

// Switch is an on/off setting that applies immediately (role="switch"). The
// whole row is the label; the button keeps a 44px touch target around the track.
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <span id={`${id}-label`} className="block text-sm font-medium text-fg">
          {label}
        </span>
        {description && (
          <span id={`${id}-desc`} className="block text-xs text-fg-muted">
            {description}
          </span>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="group inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className={`inline-flex h-6 w-10 items-center rounded-full p-0.5 transition-colors ${checked ? 'bg-accent' : 'bg-line-input'}`}
        >
          <span className={`size-5 rounded-full bg-on-accent shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
        </span>
      </button>
    </div>
  )
}
