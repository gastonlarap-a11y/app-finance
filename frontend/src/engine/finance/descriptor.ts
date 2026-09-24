// Mirror of backend/finance/descriptor.go: how bank descriptors are normalized,
// which rule pattern a descriptor suggests, and which learned rule applies.
import type { MerchantRule } from '@/services/contract'

// suggestedPatternWords is how many leading significant words of a descriptor a
// learned rule keys on by default ("cruz verde", "entel pcs").
const suggestedPatternWords = 2

// normalizeDescriptor reduces a bank descriptor to its stable words: lowercase,
// without tokens carrying digits (store or terminal ids such as "L9093") or
// single letters (the trailing channel code), whitespace collapsed.
// "CRUZ VERDE L9093 CHILLAN  C" → "cruz verde chillan".
export function normalizeDescriptor(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => [...w].length >= 2 && !/[0-9]/.test(w))
    .join(' ')
}

// suggestPattern proposes the rule pattern for a descriptor: its first
// significant words, so the rule also covers other branches of the merchant.
export function suggestPattern(description: string): string {
  const norm = normalizeDescriptor(description)
  return norm === '' ? '' : norm.split(' ').slice(0, suggestedPatternWords).join(' ')
}

// ruleFor returns the rule whose pattern prefixes the descriptor at a word
// boundary; the longest (most specific) pattern wins, ties keep the first.
export function ruleFor(rules: MerchantRule[], description: string): MerchantRule | null {
  const norm = normalizeDescriptor(description)
  let best: MerchantRule | null = null
  for (const r of rules) {
    if (norm !== r.pattern && !norm.startsWith(r.pattern + ' ')) continue
    // Counted in code points, like the Go side's utf8.RuneCountInString.
    if (!best || [...r.pattern].length > [...best.pattern].length) best = r
  }
  return best
}
