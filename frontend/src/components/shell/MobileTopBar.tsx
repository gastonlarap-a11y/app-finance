import { useEffect, useRef } from 'react'
import { Menu as MenuIcon, Wallet } from 'lucide-react'
import { IconButton } from '../ui'
import { Sidebar } from './Sidebar'

// MobileTopBar replaces the sidebar on narrow screens (phone, iPad split view):
// the menu button opens the same navigation as a drawer.
export function MobileTopBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-panel px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
      <IconButton label="Abrir el menú" icon={MenuIcon} onClick={onOpenMenu} />
      <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-lg bg-accent text-on-accent">
        <Wallet className="size-4" />
      </span>
      <span className="font-semibold tracking-tight text-fg">App Finance</span>
    </header>
  )
}

// NavDrawer is the sidebar as a modal side sheet: a native <dialog> (focus
// trap, Escape) that closes when a destination is chosen or the page behind is tapped.
export function NavDrawer({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    return () => dialog.close()
  }, [])

  return (
    // Tapping the backdrop (the dialog box itself, outside the sidebar) closes it;
    // keyboard users have Escape (the cancel event) and every link inside.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={ref}
      aria-label="Menú"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className="m-0 h-dvh max-h-none w-auto max-w-none bg-transparent p-0 backdrop:bg-scrim"
    >
      <Sidebar variant="expanded" onNavigate={onClose} />
    </dialog>
  )
}
