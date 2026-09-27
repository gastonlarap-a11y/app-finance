import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { IconButton } from './Button'

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
    // button. Move focus to the control marked autoFocus (data-autofocus), or
    // else to the first form field.
    const target =
      dialog.querySelector<HTMLElement>('[data-autofocus]') ??
      dialog.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
    target?.focus()
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
      className={`m-auto max-h-[90vh] w-[calc(100%-2rem)] ${wide ? 'max-w-4xl' : 'max-w-md'} overflow-y-auto rounded-xl bg-raised p-6 text-fg shadow-2xl ring-1 ring-line backdrop:bg-scrim`}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 id={titleId} className="text-lg font-semibold">
          {title}
        </h3>
        <IconButton label="Cerrar" icon={X} onClick={onClose} />
      </div>
      {children}
    </dialog>
  )
}
