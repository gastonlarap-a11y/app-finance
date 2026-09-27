// Port of backend/finance/cutoff.go: where a card purchase is billed. Banks
// move the cutoff with weekends and holidays, so the windows the card's own
// statements printed decide first (each statement's billed period, then the
// next period it announces) and the card's billing day only covers dates no
// statement reached yet.
import { addMonths, periodOf, type DateParts } from '@/engine/finance/period'

export interface BillingWindow {
  from: string // YYYY-MM-DD, inclusive
  to: string // YYYY-MM-DD, inclusive
  period: string // YYYY-MM billed
}

export interface CardCutoff {
  billingDay: number // 0 = no card: billed in its own month
  windows: BillingWindow[] // billed periods before announced ones: a real close beats a forecast
}

export const NO_CUTOFF: CardCutoff = { billingDay: 0, windows: [] }

function isoDay(d: DateParts): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
}

// cutoffPeriodOf is the billing month of a purchase made on date.
export function cutoffPeriodOf(c: CardCutoff, date: DateParts): string {
  const day = isoDay(date)
  for (const w of c.windows) if (w.from <= day && day <= w.to) return w.period
  return periodOf(date, c.billingDay)
}

// The statement fields a cutoff reads.
export interface StatementWindowRow {
  cardId: number
  period: string
  periodFrom: string
  periodTo: string
  nextPeriodFrom: string
  nextPeriodTo: string
}

function validWindow(from: string, to: string): boolean {
  return from !== '' && to !== '' && from <= to
}

// buildCutoffs mirrors cutoffsFor's assembly: one cutoff per card, from its
// billing day and its statements (given newest first).
export function buildCutoffs(
  cards: readonly { id: number; billingDay: number }[],
  statements: readonly StatementWindowRow[],
): Map<number, CardCutoff> {
  const billed = new Map<number, BillingWindow[]>()
  const announced = new Map<number, BillingWindow[]>()
  const push = (m: Map<number, BillingWindow[]>, id: number, w: BillingWindow) => m.set(id, [...(m.get(id) ?? []), w])
  for (const st of statements) {
    if (validWindow(st.periodFrom, st.periodTo)) {
      push(billed, st.cardId, { from: st.periodFrom, to: st.periodTo, period: st.period })
    }
    if (validWindow(st.nextPeriodFrom, st.nextPeriodTo)) {
      push(announced, st.cardId, { from: st.nextPeriodFrom, to: st.nextPeriodTo, period: addMonths(st.period, 1) })
    }
  }
  const out = new Map<number, CardCutoff>()
  for (const c of cards) {
    out.set(c.id, { billingDay: c.billingDay, windows: [...(billed.get(c.id) ?? []), ...(announced.get(c.id) ?? [])] })
  }
  return out
}

// operationNumber mirrors the Go helper: the stable part of a statement
// reference (its last eight digits), '' when it carries none (all zeros).
export function operationNumber(ref: string): string {
  const digits = ref.replace(/\D/g, '')
  if (digits.length < 8) return ''
  const n = digits.slice(-8)
  return /^0+$/.test(n) ? '' : n
}
