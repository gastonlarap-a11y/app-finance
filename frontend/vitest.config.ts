import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import path from 'path'

// Two projects, kept separate from vite.config.ts so the mode-conditional app
// config stays untangled:
// - unit: engine + lib tests in Node against the same sqlite-wasm build used in
//   production (in-memory DBs — Node has no OPFS).
// - browser: UI primitives in a real headless Chromium (*.dom.test.tsx). jsdom
//   has no <dialog>.showModal and happy-dom no Escape/Popover, which the UI relies on.
export default defineConfig({
  resolve: {
    alias: [{ find: '@', replacement: path.resolve(import.meta.dirname, './src') }],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          // Vitest blanks CSS modules by default, even ?raw: the token contrast
          // test (src/styles/tokens.test.ts) reads index.css as text.
          css: { include: [/src\/index\.css/] },
        },
      },
      {
        extends: true,
        plugins: [react()],
        // Pre-bundled together up front: a dependency discovered mid-run is
        // re-optimized with its own React copy, and hooks then crash.
        optimizeDeps: {
          include: ['react', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'lucide-react', 'jotai', 'vitest-browser-react'],
        },
        test: {
          name: 'browser',
          include: ['src/**/*.dom.test.tsx'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
