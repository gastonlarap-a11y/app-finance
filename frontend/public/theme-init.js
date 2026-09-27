// Applies the saved theme before the first paint, so the app never flashes the
// wrong one. A classic blocking script and a same-origin file because the web
// build's CSP forbids inline scripts. Mirrors src/lib/theme.ts
// (THEME_STORAGE_KEY, THEME_LIGHT_ENABLED); src/lib/theme.test.ts keeps them in sync.
;(function () {
  var LIGHT_ENABLED = false
  var mode = 'system'
  try {
    var saved = localStorage.getItem('app-finance:theme')
    if (saved === 'light' || saved === 'dark') mode = saved
  } catch (e) {
    // Storage blocked: follow the system.
  }
  var systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  var dark = mode === 'dark' || (mode === 'system' && (systemDark || !LIGHT_ENABLED))
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
})()
