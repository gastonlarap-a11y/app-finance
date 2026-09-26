import { describe, expect, it } from 'vitest'
import { ALL_TOPICS, bumped, versionKey, type Versions } from './refresh'

const zero: Versions = { ledger: 0, imports: 0, profiles: 0, settings: 0, mail: 0 }

describe('selective refetch', () => {
  it('changes the key only of queries reading an invalidated topic', () => {
    const next = bumped(zero, ['ledger'])
    expect(versionKey(next, ['ledger'])).not.toBe(versionKey(zero, ['ledger']))
    expect(versionKey(next, ['imports', 'ledger'])).not.toBe(versionKey(zero, ['imports', 'ledger']))
    expect(versionKey(next, ['settings'])).toBe(versionKey(zero, ['settings']))
    expect(versionKey(next, ['profiles'])).toBe(versionKey(zero, ['profiles']))
  })

  it('invalidates every topic when none is named (profile switch)', () => {
    const next = bumped(zero, [])
    for (const t of ALL_TOPICS) expect(next[t]).toBe(1)
  })

  it('keys stay distinct across topics with equal counters', () => {
    expect(versionKey(zero, ['ledger'])).not.toBe(versionKey(zero, ['imports']))
  })

  it('does not mutate the previous versions', () => {
    bumped(zero, ['mail'])
    expect(zero.mail).toBe(0)
  })
})
