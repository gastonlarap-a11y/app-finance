import { useSyncExternalStore } from 'react'

// useMediaQuery reports whether a CSS media query matches, updating live (for
// layout decisions CSS alone cannot make, like which navigation to render).
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
  )
}
