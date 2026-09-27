import { useState, type FocusEvent, type KeyboardEvent } from 'react'
import { Trash2, type LucideIcon } from 'lucide-react'
import { Button, IconButton } from './Button'

type Phase = 'idle' | 'asking' | 'returning'

// ConfirmAction is a destructive action that asks inline before running
// (no native confirm(): it blocks the webview and Safari suppresses it in
// installed PWAs). The question takes focus on «Cancelar» — the safe default —
// and closes on Escape or when focus leaves it, handing focus back to the trigger.
export function ConfirmAction({
  label,
  onConfirm,
  icon = Trash2,
  iconOnly = false,
  question = '¿Eliminar?',
  confirmLabel = 'Eliminar',
  size = 'sm',
}: {
  // Trigger text; the accessible name of an icon-only trigger.
  label: string
  onConfirm: () => void | Promise<void>
  icon?: LucideIcon
  iconOnly?: boolean
  question?: string
  confirmLabel?: string
  size?: 'sm' | 'md'
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [busy, setBusy] = useState(false)

  async function confirm() {
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
      setPhase('idle') // no-op when the confirmed row unmounted this component
    }
  }

  if (phase !== 'asking') {
    // After a cancel, the re-mounted trigger takes focus back.
    const autoFocus = phase === 'returning'
    return iconOnly ? (
      <IconButton label={label} icon={icon} tone="danger" size={size} onClick={() => setPhase('asking')} autoFocus={autoFocus} />
    ) : (
      <Button variant="quiet" size={size} icon={icon} onClick={() => setPhase('asking')} autoFocus={autoFocus}>
        {label}
      </Button>
    )
  }

  function onBlur(e: FocusEvent<HTMLDivElement>) {
    if (!busy && !e.currentTarget.contains(e.relatedTarget)) setPhase('idle')
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Escape' || busy) return
    // Inside a Modal, Escape cancels the question, not the dialog: a canceled
    // keydown is not a close request for the <dialog>.
    e.preventDefault()
    e.stopPropagation()
    setPhase('returning')
  }

  return (
    // Delegated from the two buttons inside: Escape and focus leaving the group close the question.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div role="group" aria-label={`${label}: ${question}`} onBlur={onBlur} onKeyDown={onKeyDown} className="inline-flex items-center gap-2">
      <span className="text-sm text-fg-muted">{question}</span>
      <Button variant="danger" size={size} loading={busy} onClick={() => void confirm()}>
        {confirmLabel}
      </Button>
      <Button variant="secondary" size={size} disabled={busy} autoFocus onClick={() => setPhase('returning')}>
        Cancelar
      </Button>
    </div>
  )
}
