// Port of the pure parts of backend/finance/fixedmatch.go: when a bank charge
// may be a fixed expense's monthly bill. Both the name and the amount must
// agree, the amount only approximately (Actual Budget's ±7.5 % "approximately"
// schedules), because a fixed expense's amount is an estimate.
import { Money } from '@/engine/decimal'

const FIXED_MATCH_TOLERANCE = Money.fromString('0.075')

// MIN_MATCH_TOKEN_LEN keeps short words ('sub', 'com', 'pcs') from matching.
const MIN_MATCH_TOKEN_LEN = 4

// matchTokens splits text into its lowercase letter runs of at least
// MIN_MATCH_TOKEN_LEN letters ('APPLE.COM/BILL' → apple, bill).
function matchTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => [...w].length >= MIN_MATCH_TOKEN_LEN)
}

// namesMatch reports whether a fixed expense's name and a bank descriptor share
// a significant word, allowing one to prefix the other ('Proseguro' and
// 'PROSEGUR ACTIVA', 'Claude' and 'ANTHROPIC* CLAUDE SUB').
export function namesMatch(fixedName: string, descriptor: string): boolean {
  const theirs = matchTokens(descriptor)
  return matchTokens(fixedName).some((a) => theirs.some((b) => a.startsWith(b) || b.startsWith(a)))
}

// amountGap is |clp − planned| / planned, or null when it exceeds the
// tolerance (or planned is zero).
export function amountGap(clp: Money, planned: Money): Money | null {
  if (planned.isZero()) return null
  const gap = clp.sub(planned).abs().div(planned)
  return gap.gt(FIXED_MATCH_TOLERANCE) ? null : gap
}
