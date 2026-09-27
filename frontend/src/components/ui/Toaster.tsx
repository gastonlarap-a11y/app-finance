import { useAtomValue } from 'jotai'
import { CircleAlert, CircleCheck, Info, X, type LucideIcon } from 'lucide-react'
import { dismiss, noticesAtom, type NoticeTone } from '@/lib/notify'
import { IconButton } from './Button'

const TONE: Record<NoticeTone, { icon: LucideIcon; color: string; ring: string }> = {
  error: { icon: CircleAlert, color: 'text-negative-fg', ring: 'ring-negative-fg/40' },
  success: { icon: CircleCheck, color: 'text-positive-fg', ring: 'ring-positive-fg/40' },
  info: { icon: Info, color: 'text-accent-fg', ring: 'ring-line' },
}

// Toaster renders the in-app notices raised by notify() (errors, confirmations).
// The icon states the tone, so messages need no ✓/⚠ glyphs of their own.
export function Toaster() {
  const notices = useAtomValue(noticesAtom)
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4"
    >
      {notices.map((n) => {
        const tone = TONE[n.tone]
        const Icon = tone.icon
        return (
          <div
            key={n.id}
            role={n.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex max-w-lg items-start gap-3 rounded-xl bg-raised py-3 pl-4 pr-2 text-sm text-fg shadow-lg ring-1 ${tone.ring}`}
          >
            <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${tone.color}`} />
            <span className="flex-1 py-0.5">{n.message}</span>
            <IconButton label="Descartar aviso" icon={X} size="sm" onClick={() => dismiss(n.id)} />
          </div>
        )
      })}
    </div>
  )
}
