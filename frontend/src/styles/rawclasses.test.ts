import { describe, expect, it } from 'vitest'
import { rawColorClasses } from './rawclasses'

// Every .tsx under src, as text (tests excluded: they may name any class).
const sources = import.meta.glob<string>(['../**/*.tsx', '!../**/*.test.tsx'], { query: '?raw', import: 'default', eager: true })

describe('rawColorClasses', () => {
  it('flags raw palette colors, black/white and legacy token names', () => {
    const src = `className="bg-slate-800 hover:text-amber-200 ring-black/40 text-white bg-surface-alt text-danger/80 bg-primary-dark"`
    expect(rawColorClasses(src)).toEqual([
      'bg-slate-800',
      'text-amber-200',
      'ring-black',
      'text-white',
      'bg-surface-alt',
      'text-danger',
      'bg-primary-dark',
    ])
  })

  it('accepts the semantic tokens', () => {
    const src = `className="bg-panel text-fg-muted ring-line hover:bg-accent-hover text-negative-fg bg-caution-soft backdrop:bg-scrim"`
    expect(rawColorClasses(src)).toEqual([])
  })
})

describe('semantic tokens only', () => {
  it('no component uses a raw color class', () => {
    const offenders = Object.entries(sources)
      .map(([path, src]) => [path, rawColorClasses(src)] as const)
      .filter(([, found]) => found.length > 0)
      .map(([path, found]) => `${path}: ${found.join(', ')}`)
    // Both themes read the tokens; a raw color looks right in one theme only.
    expect(offenders, 'use the semantic tokens of index.css instead').toEqual([])
  })
})
