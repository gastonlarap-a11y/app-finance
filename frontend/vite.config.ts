import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import wails from '@wailsio/runtime/plugins/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

// Two build targets share this config:
// - default (wails3 dev/build → npm run dev|build, no --mode flag): the desktop
//   webview build, byte-identical behavior to the original flat config.
// - `--mode web` (npm run dev:web|build:web): the installable PWA build — the
//   Wails bindings wrappers are aliased to the local-SQLite web adapters and
//   the app is served under the GitHub Pages base path.
export default defineConfig(({ mode }) => {
  const isWeb = mode === 'web'
  return {
    base: isWeb ? '/app-finance/' : '/',
    server: {
      host: '127.0.0.1',
      port: Number(process.env.WAILS_VITE_PORT) || 9245,
      strictPort: true,
      // The web engine raw-imports the backend's .sql migrations, which live
      // outside the Vite root.
      ...(isWeb ? { fs: { allow: [path.resolve(__dirname, '..')] } } : {}),
    },
    plugins: [
      react(),
      tailwindcss(),
      ...(isWeb
        ? [
            // iOS reads its own tags (not the manifest) for Add to Home Screen.
            {
              name: 'ios-pwa-meta',
              transformIndexHtml() {
                return [
                  { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/app-finance/apple-touch-icon.png' }, injectTo: 'head' as const },
                  { tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' }, injectTo: 'head' as const },
                  { tag: 'meta', attrs: { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' }, injectTo: 'head' as const },
                  { tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: 'App Finance' }, injectTo: 'head' as const },
                  { tag: 'meta', attrs: { name: 'theme-color', content: '#0f172a' }, injectTo: 'head' as const },
                ]
              },
            } satisfies PluginOption,
            VitePWA({
              registerType: 'autoUpdate',
              manifest: {
                name: 'App Finance',
                short_name: 'App Finance',
                description: 'Tus cuentas mes a mes',
                lang: 'es',
                start_url: '/app-finance/',
                scope: '/app-finance/',
                display: 'standalone',
                background_color: '#0f172a',
                theme_color: '#0f172a',
                icons: [
                  { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                  { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
                  { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                ],
              },
              workbox: {
                globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,woff2}'],
                // sqlite3.wasm outgrows workbox's default 2 MB precache limit.
                maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
              },
            }) as PluginOption,
          ]
        : [wails('./bindings')]),
    ],
    resolve: {
      alias: [
        ...(isWeb
          ? [
              { find: '@/services/finance', replacement: path.resolve(__dirname, './src/services/web/finance.ts') },
              { find: '@/services/users', replacement: path.resolve(__dirname, './src/services/web/users.ts') },
              { find: '@/services/settings', replacement: path.resolve(__dirname, './src/services/web/settings.ts') },
            ]
          : []),
        { find: '@', replacement: path.resolve(__dirname, './src') },
      ],
    },
    define: {
      'import.meta.env.VITE_TARGET': JSON.stringify(isWeb ? 'web' : 'desktop'),
    },
    ...(isWeb
      ? {
          worker: { format: 'es' as const },
          optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
        }
      : {}),
  }
})
