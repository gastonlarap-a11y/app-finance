import { useSyncExternalStore } from 'react'
import { IS_WEB } from '@/lib/platform'
import { HOME, formatHash, parseHash, type Route } from '@/lib/route'

// The current route lives in location.hash (see lib/route.ts). Components read
// it with useRoute() and change it with navigate() or <Link>; nothing copies it
// into an atom, so there is no second source of truth to keep in sync.

const LAST_ROUTE_KEY = 'app-finance:last-route'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

const currentHash = () => window.location.hash

export function useRoute(): Route {
  // The snapshot is the raw hash (a string, stable between renders); parsing
  // happens in render so equal hashes never produce a new object identity.
  return parseHash(useSyncExternalStore(subscribe, currentHash), IS_WEB)
}

export function navigate(route: Route, { replace = false }: { replace?: boolean } = {}): void {
  const hash = formatHash(route)
  if (hash === window.location.hash) return
  if (!replace) {
    window.location.hash = hash // fires hashchange
    return
  }
  history.replaceState(null, '', hash)
  window.dispatchEvent(new HashChangeEvent('hashchange')) // replaceState fires none
}

// startRouteMemory reopens the last screen when the app starts without a hash
// (the PWA's start_url, the desktop window) and remembers each one visited.
// Call once at startup, before the first render.
export function startRouteMemory(): void {
  if (window.location.hash === '' || window.location.hash === '#') {
    let saved: string | null = null
    try {
      saved = localStorage.getItem(LAST_ROUTE_KEY)
    } catch {
      // Storage blocked: start on the home screen.
    }
    history.replaceState(null, '', formatHash(saved ? parseHash(saved, IS_WEB) : HOME))
  }
  window.addEventListener('hashchange', () => {
    try {
      localStorage.setItem(LAST_ROUTE_KEY, window.location.hash)
    } catch {
      // Not remembered: the next start opens the home screen.
    }
  })
}
