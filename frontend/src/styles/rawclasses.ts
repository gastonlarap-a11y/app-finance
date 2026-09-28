// Detects color classes that bypass the semantic tokens of index.css: raw
// Tailwind palette colors (slate-400, amber-200…), black/white, and the
// pre-redesign token names (surface, primary, danger…), which no longer exist.
// Used by rawclasses.test.ts.

const COLOR_UTILITY = '(?:bg|text|ring|border|outline|fill|stroke|divide|from|via|to|decoration|placeholder|caret|shadow)'
const PALETTE = '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)'

const PATTERNS = [
  new RegExp(`\\b${COLOR_UTILITY}-${PALETTE}-\\d{2,3}\\b`, 'g'),
  new RegExp(`\\b${COLOR_UTILITY}-(?:white|black)\\b`, 'g'),
  new RegExp(`\\b${COLOR_UTILITY}-(?:surface-alt|surface|primary-dark|primary|success|danger|warning)\\b`, 'g'),
]

export function rawColorClasses(source: string): string[] {
  return PATTERNS.flatMap((p) => source.match(p) ?? [])
}
