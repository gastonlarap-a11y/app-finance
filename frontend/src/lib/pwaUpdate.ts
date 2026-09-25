// A new PWA version waiting to take over. The service worker is registered in
// 'prompt' mode (vite-plugin-pwa): a new deploy never swaps the app's files
// under an open page, it waits until the user accepts. Silent auto-updates
// could reload mid-edit and leave a long-lived tab asking for chunks the new
// deploy no longer has. main.tsx registers the worker (web only, so the desktop
// bundle never imports the virtual module) and announces updates here; the
// banner only depends on this module.

type Apply = () => Promise<void>

let pending: Apply | null = null
const listeners = new Set<() => void>()

// announceUpdate is called by the registration once a new version is ready.
export function announceUpdate(apply: Apply): void {
  pending = apply
  for (const l of listeners) l()
}

export function updateReady(): boolean {
  return pending !== null
}

export function onUpdateReady(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// applyUpdate activates the waiting version and reloads the page.
export async function applyUpdate(): Promise<void> {
  if (pending) await pending()
}
