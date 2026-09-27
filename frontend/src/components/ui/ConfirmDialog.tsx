import { useState, type ReactNode } from 'react'
import { Button } from './Button'
import { Modal } from './Modal'

// ConfirmDialog asks before a destructive action chosen from a menu (where an
// inline ConfirmAction has no room). Focus starts on «Cancelar», the safe
// choice; Escape cancels. Mount it only while it should be open.
export function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Eliminar',
  onConfirm,
  onClose,
}: {
  title: string
  children: ReactNode
  confirmLabel?: string
  onConfirm: () => void | Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)

  async function confirm() {
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
    onClose()
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-5">
        <div className="text-sm text-fg-muted">{children}</div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" autoFocus disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
