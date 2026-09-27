import { describe, expect, it } from 'vitest'
import { RAW_CLASS_BASELINE } from './rawclasses.baseline'
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

describe('raw color class ratchet', () => {
  const counts = Object.fromEntries(Object.entries(sources).map(([path, src]) => [path, rawColorClasses(src).length]))

  it('adds no raw color class to any file', () => {
    const over = Object.entries(counts)
      .filter(([path, n]) => n > (RAW_CLASS_BASELINE[path] ?? 0))
      .map(([path, n]) => `${path}: ${n} (allowed ${RAW_CLASS_BASELINE[path] ?? 0}) → ${rawColorClasses(sources[path] ?? '').join(', ')}`)
    expect(over, 'use the semantic tokens of index.css instead').toEqual([])
  })

  it('keeps the baseline tight (lower it as files migrate)', () => {
    const loose = Object.entries(RAW_CLASS_BASELINE)
      .filter(([path, allowed]) => (counts[path] ?? 0) < allowed)
      .map(([path, allowed]) => `${path}: ${counts[path] ?? 0} (baseline ${allowed})`)
    expect(loose, 'update src/styles/rawclasses.baseline.ts').toEqual([])
  })
})
