import { describe, expect, it } from 'vitest'
import css from '../index.css?raw'
import { LOOK_COLORS } from '@/engine/finance/looks'

// Guards the semantic color tokens of index.css: every text/background pair the
// primitives use must meet WCAG 2.2 AA (4.5:1 text, 3:1 UI graphics) in both
// themes. Colors are read from the CSS itself, so a token edit that breaks
// contrast fails here instead of on screen.

type Oklch = readonly [l: number, c: number, h: number]

function parseTokens(block: string): Map<string, Oklch> {
  const tokens = new Map<string, Oklch>()
  for (const m of block.matchAll(/--color-([a-z-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)) {
    const [, name, l, c, h] = m
    if (name && l && c && h) tokens.set(name, [Number(l), Number(c), Number(h)])
  }
  return tokens
}

function block(selector: RegExp): string {
  const m = css.match(selector)
  if (!m?.[1]) throw new Error(`index.css: block ${selector} not found`)
  return m[1]
}

const light = parseTokens(block(/@theme\s*\{([^}]*)\}/))
const dark = new Map([...light, ...parseTokens(block(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/))])

// OKLCH → linear sRGB (Björn Ottosson's matrices), clamped to the gamut.
function relativeLuminance([L, C, h]: Oklch): number {
  const a = C * Math.cos((h * Math.PI) / 180)
  const b = C * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v)))
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!
}

function contrast(x: Oklch, y: Oklch): number {
  const [hi, lo] = [relativeLuminance(x), relativeLuminance(y)].sort((p, q) => q - p)
  return (hi! + 0.05) / (lo! + 0.05)
}

const SURFACES = ['canvas', 'panel', 'raised', 'sunken']
const TEXT = ['fg', 'fg-muted', 'fg-subtle', 'accent-fg', 'positive-fg', 'negative-fg', 'caution-fg', 'info-fg']
const STATES = ['positive', 'negative', 'caution', 'info']
const LOOKS = LOOK_COLORS

const pairs: [fg: string, bg: string, min: number][] = [
  ...SURFACES.flatMap((bg) => TEXT.map((fg): [string, string, number] => [fg, bg, 4.5])),
  // Form-control outlines and the focus ring are UI graphics (SC 1.4.11).
  ...SURFACES.flatMap((bg): [string, string, number][] => [
    ['line-input', bg, 3],
    ['focus', bg, 3],
  ]),
  ['on-accent', 'accent', 4.5],
  ['on-accent', 'accent-hover', 4.5],
  ['on-accent', 'negative', 4.5],
  ['accent-fg', 'accent-soft', 4.5],
  ['fg', 'accent-soft', 4.5],
  // Callouts and badges: tinted backgrounds with neutral or tone-colored text.
  ...STATES.flatMap((s): [string, string, number][] => [
    [`${s}-fg`, `${s}-soft`, 4.5],
    ['fg', `${s}-soft`, 4.5],
    ['fg-muted', `${s}-soft`, 4.5],
  ]),
  // Personalization: an icon on its chip (held to the text ratio, so a label
  // may sit there too), and a bare dot or icon on the surfaces.
  ...LOOKS.flatMap((k): [string, string, number][] => [
    [`look-${k}`, `look-${k}-soft`, 4.5],
    ['fg', `look-${k}-soft`, 4.5],
    ...SURFACES.map((bg): [string, string, number] => [`look-${k}`, bg, 3]),
  ]),
]

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme', (_, tokens) => {
  it.each(pairs)('%s on %s ≥ %s:1', (fg, bg, min) => {
    const f = tokens.get(fg)
    const b = tokens.get(bg)
    if (!f || !b) throw new Error(`missing token: ${f ? bg : fg}`)
    expect(contrast(f, b)).toBeGreaterThanOrEqual(min)
  })
})
