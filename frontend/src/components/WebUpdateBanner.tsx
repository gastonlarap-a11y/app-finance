import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { applyUpdate, onUpdateReady, updateReady } from '@/lib/pwaUpdate'
import { Banner, Button } from './ui'

// WebUpdateBanner offers a new deploy of the PWA; the page switches versions
// only when the user taps "Actualizar" (see lib/pwaUpdate).
export function WebUpdateBanner() {
  const [ready, setReady] = useState(updateReady)
  const [busy, setBusy] = useState(false)
  useEffect(() => onUpdateReady(() => setReady(true)), [])
  if (!ready) return null
  return (
    <Banner icon={Sparkles}>
      <span>Hay una versión nueva de la app.</span>
      <Button
        size="sm"
        loading={busy}
        onClick={() => {
          setBusy(true)
          void applyUpdate() // reloads the page on success
        }}
      >
        {busy ? 'Actualizando…' : 'Actualizar'}
      </Button>
    </Banner>
  )
}
