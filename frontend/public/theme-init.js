// Applies the saved theme before the first paint, so the app never flashes the
// wrong one. A classic blocking script and a same-origin file because the web
// build's CSP forbids inline scripts. Mirrors src/lib/theme.ts
// (THEME_STORAGE_KEY, resolveTheme); src/lib/theme.test.ts keeps them in sync.
;(function () {
  var root = document.documentElement
  var mode = 'system'
  try {
    var saved = localStorage.getItem('app-finance:theme')
    if (saved === 'light' || saved === 'dark') mode = saved
  } catch (e) {
    // Storage blocked: follow the system.
  }
  var systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  var dark = mode === 'dark' || (mode === 'system' && systemDark)
  root.dataset.theme = dark ? 'dark' : 'light'
  // Desktop window chrome (see main.go): which OS draws the window.
  if (root.dataset.target === 'desktop') {
    var ua = navigator.userAgent
    root.dataset.os = /Macintosh/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : 'other'
  }
})()
