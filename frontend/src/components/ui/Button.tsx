import type { ReactNode } from 'react'
import { LoaderCircle, type LucideIcon } from 'lucide-react'

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent shadow-xs hover:bg-accent-hover',
  secondary: 'bg-panel text-fg ring-1 ring-inset ring-line-strong hover:bg-sunken',
  quiet: 'text-fg-muted hover:bg-sunken hover:text-fg',
  danger: 'bg-negative text-on-accent shadow-xs hover:brightness-95',
}

const SIZE: Record<Size, string> = {
  sm: 'h-8 gap-1.5 px-3 text-sm',
  md: 'h-9 gap-2 px-4 text-sm',
  lg: 'h-11 gap-2 px-5 text-base',
}

const ICON_SIZE: Record<Size, string> = { sm: 'size-3.5', md: 'size-4', lg: 'size-5' }

type ButtonProps = {
  children: ReactNode
  onClick?: () => void
  // 'ghost' is the pre-redesign name of 'secondary', kept while views migrate.
  variant?: Variant | 'ghost'
  size?: Size
  icon?: LucideIcon
  iconEnd?: LucideIcon
  // In flight: shows a spinner and blocks a second submit.
  loading?: boolean
  type?: 'button' | 'submit'
  disabled?: boolean
  autoFocus?: boolean
  title?: string
  className?: string
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconEnd: IconEnd,
  loading = false,
  type = 'button',
  disabled,
  autoFocus,
  title,
  className = '',
}: ButtonProps) {
  const look = VARIANT[variant === 'ghost' ? 'secondary' : variant]
  const iconCls = `${ICON_SIZE[size]} shrink-0`
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      autoFocus={autoFocus}
      // Modal focuses this on open: React's autoFocus runs while a <dialog> is still closed.
      data-autofocus={autoFocus || undefined}
      title={title}
      className={`inline-flex items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors select-none disabled:cursor-not-allowed disabled:opacity-50 ${SIZE[size]} ${look} ${className}`}
    >
      {loading ? (
        <LoaderCircle aria-hidden="true" className={`${iconCls} motion-safe:animate-spin`} />
      ) : (
        Icon && <Icon aria-hidden="true" className={iconCls} />
      )}
      {children}
      {IconEnd && <IconEnd aria-hidden="true" className={iconCls} />}
    </button>
  )
}

type IconTone = 'default' | 'accent' | 'positive' | 'danger'

const ICON_TONE: Record<IconTone, string> = {
  default: 'text-fg-muted hover:bg-sunken hover:text-fg',
  accent: 'text-fg-muted hover:bg-accent-soft hover:text-accent-fg',
  positive: 'text-fg-muted hover:bg-positive-soft hover:text-positive-fg',
  danger: 'text-fg-muted hover:bg-negative-soft hover:text-negative-fg',
}

type IconButtonProps = {
  // Mandatory accessible name: the glyph is decorative, so screen readers would
  // otherwise read nothing (or "wastebasket").
  label: string
  onClick: () => void
  icon?: LucideIcon
  // Pre-redesign text glyph, kept while views migrate to `icon`.
  children?: ReactNode
  tone?: IconTone
  size?: 'sm' | 'md'
  disabled?: boolean
  autoFocus?: boolean
  // Pre-redesign color override (replaces `tone`), kept while views migrate.
  className?: string
}

// Icon-only button. 32px (28px small) with a mouse, 44×44 on touch screens.
export function IconButton({ label, onClick, icon: Icon, children, tone = 'default', size = 'md', disabled, autoFocus, className }: IconButtonProps) {
  const box = size === 'sm' ? 'size-7' : 'size-8'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-w-11 ${box} ${className ?? ICON_TONE[tone]}`}
    >
      {Icon ? <Icon aria-hidden="true" className="size-4" /> : <span aria-hidden="true">{children}</span>}
    </button>
  )
}
