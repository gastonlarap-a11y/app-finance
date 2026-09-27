import { registerSW } from 'virtual:pwa-register'
import { announceUpdate } from '@/lib/pwaUpdate'

// startWebPlatform wires what only the PWA needs. main.tsx imports this module
// dynamically inside its web branch: `virtual:pwa-register` exists only in the
// web build, and the desktop dev server resolves every import of a module it
// serves — dead branches included — so it must not appear in main.tsx itself.
export function startWebPlatform(): void {
  const updateSW = registerSW({ onNeedRefresh: () => announceUpdate(() => updateSW(true)) })

  // Ask the browser to keep OPFS through storage pressure. WebKit decides on
  // its own heuristics (installing to the home screen is the documented
  // signal), so the answer is only shown in Ajustes, never required.
  if (typeof navigator.storage?.persist === 'function') {
    void navigator.storage.persist().catch(() => false) // best effort
  }

  // A lazy chunk that failed to load (e.g. after a deploy) cannot recover in
  // place: reload once, and not in a loop if the chunk is truly gone.
  window.addEventListener('vite:preloadError', (e) => {
    const key = 'app-finance:preload-reload'
    try {
      if (sessionStorage.getItem(key)) return
      sessionStorage.setItem(key, '1')
    } catch {
      return // no storage: rather show the error than risk a reload loop
    }
    e.preventDefault()
    window.location.reload()
  })
}
