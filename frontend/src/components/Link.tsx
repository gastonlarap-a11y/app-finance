import type { ReactNode } from 'react'
import { formatHash, type Route } from '@/lib/route'

// Link goes to another screen of the app. A real <a href="#/…">: it can be
// opened with the keyboard, read as a link by screen readers, and the hash
// change is what moves the app (lib/useRoute.ts).
export function Link({ to, children, className = 'font-medium text-accent-fg underline-offset-2 hover:underline' }: { to: Route; children: ReactNode; className?: string }) {
  return (
    <a href={formatHash(to)} className={className}>
      {children}
    </a>
  )
}
