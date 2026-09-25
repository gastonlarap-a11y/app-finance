import { useEffect, useState } from 'react'
import { applyUpdate, onUpdateReady, updateReady } from '@/lib/pwaUpdate'
import { Button } from './ui'

// WebUpdateBanner offers a new deploy of the PWA; the page switches versions
// only when the user taps "Actualizar" (see lib/pwaUpdate).
export function WebUpdateBanner() {
  const [ready, setReady] = useState(updateReady)
  const [busy, setBusy] = useState(false)
  useEffect(() => onUpdateReady(() => setReady(true)), [])
  if (!ready) return null
  return (
    <div role="status" className="border-b border-primary/40 bg-primary/10">
      <div className="mx-auto flex max-w-[1536px] flex-wrap items-center gap-3 px-6 py-2 text-sm">
        <span>Hay una versión nueva de la app.</span>
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void applyUpdate() // reloads the page on success
          }}
        >
          {busy ? 'Actualizando…' : 'Actualizar'}
        </Button>
      </div>
    </div>
  )
}
