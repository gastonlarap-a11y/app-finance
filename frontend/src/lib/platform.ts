// Build-target flag: 'web' for the PWA build (vite --mode web), 'desktop' for
// the Wails app. Inlined at build time (see define in vite.config.ts), so
// branches on IS_WEB are dead-code-eliminated from the other target.
export const IS_WEB = import.meta.env.VITE_TARGET === 'web'
