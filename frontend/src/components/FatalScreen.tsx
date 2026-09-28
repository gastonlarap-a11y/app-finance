import type { ReactNode } from 'react'
import { CircleAlert, RotateCw } from 'lucide-react'
import { Button } from './ui'

// FatalScreen replaces the whole app with a message and one way out. The way
// out is mandatory: an installed PWA has no browser chrome, so without the
// button a stuck screen could only be left by killing the app.
export function FatalScreen({
  title,
  children,
  actionLabel,
  onAction,
}: {
  title: string
  children: ReactNode
  actionLabel: string
  onAction: () => void
}) {
  return (
    <div role="alert" className="flex min-h-dvh items-center justify-center bg-canvas p-6 text-fg">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-negative-soft">
          <CircleAlert aria-hidden="true" className="size-6 text-negative-fg" />
        </span>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm text-fg-muted">{children}</p>
        <Button icon={RotateCw} onClick={onAction} className="mt-2">
          {actionLabel}
        </Button>
      </div>
    </div>
  )
}
