// Build-target flag: 'web' for the PWA build (vite --mode web), 'desktop' for
// the Wails app. Inlined at build time (see define in vite.config.ts), so
// branches on IS_WEB are dead-code-eliminated from the other target.
export const IS_WEB = import.meta.env.VITE_TARGET === 'web'

// Apple keyboard (macOS, iPadOS — which reports a Mac user agent): shortcuts
// use ⌘ instead of Ctrl. Read once; it does not change while the app runs.
export const IS_APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
