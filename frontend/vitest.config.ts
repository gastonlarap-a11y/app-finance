import { defineConfig } from 'vitest/config'
import path from 'path'

// Engine tests run in Node against the same sqlite-wasm build used in
// production (in-memory DBs — Node has no OPFS). Kept separate from
// vite.config.ts so the mode-conditional app config stays untangled.
export default defineConfig({
  resolve: {
    alias: [{ find: '@', replacement: path.resolve(__dirname, './src') }],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
