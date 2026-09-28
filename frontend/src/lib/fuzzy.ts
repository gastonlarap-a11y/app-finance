// Fuzzy matching for the command palette: accent- and case-insensitive, ranked
// so a prefix beats a word start, which beats letters scattered in order.
// Returns the matched character positions so the palette can highlight them.

export type FuzzyMatch = { score: number; indices: number[] }

// fold lowercases and strips diacritics one character at a time, so positions
// in the folded string map 1:1 to the original ("Año" → "ano").
function fold(s: string): string {
  return Array.from(s, (ch) => ch.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().charAt(0) || ch).join('')
}

const range = (from: number, length: number) => Array.from({ length }, (_, i) => from + i)

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = fold(query.trim())
  if (q === '') return { score: 0, indices: [] }
  const t = fold(text)

  if (t.startsWith(q)) return { score: 300 - t.length, indices: range(0, q.length) }

  // A word start: after a space or punctuation ("gastos fijos" ← "fij").
  for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + 1)) {
    if (i > 0 && /[^a-z0-9]/.test(t.charAt(i - 1))) return { score: 200 - t.length, indices: range(i, q.length) }
  }
  const at = t.indexOf(q)
  if (at !== -1) return { score: 150 - t.length, indices: range(at, q.length) }

  // Subsequence: every query letter in order; tighter matches rank higher.
  const indices: number[] = []
  let from = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const i = t.indexOf(ch, from)
    if (i === -1) return null
    indices.push(i)
    from = i + 1
  }
  const spread = (indices.at(-1) ?? 0) - (indices[0] ?? 0)
  return { score: 100 - spread - t.length / 10, indices }
}
