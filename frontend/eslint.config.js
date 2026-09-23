// ESLint flat config: type-aware typescript-eslint, React hooks (including the
// React Compiler rules shipped in eslint-plugin-react-hooks v6+) and jsx-a11y.
import { defineConfig } from 'eslint/config'
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import jsxA11y from 'eslint-plugin-jsx-a11y'

export default defineConfig(
  { ignores: ['dist', 'bindings', 'dev-dist', 'node_modules', '*.config.ts', '*.config.js'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      reactHooks.configs.flat['recommended-latest'],
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-deprecated': 'error',
      // Dialog forms focus their first field on open — the documented <dialog>
      // behaviour (autofocus inside showModal()), not a page-load focus steal.
      'jsx-a11y/no-autofocus': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Event handlers returning promises are the idiomatic React pattern.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
  {
    // The engine and web adapters implement async RPC contracts synchronously
    // (sqlite-wasm is sync): `async` is the contract's shape, not a missing await.
    files: ['src/engine/**/*.ts', 'src/services/web/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    // Tests assert on shapes built from fixtures; non-null assertions keep them readable.
    files: ['src/**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
)
