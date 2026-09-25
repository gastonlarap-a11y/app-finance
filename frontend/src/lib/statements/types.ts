import type { CardStatementInput, ImportBatch } from '@/services/contract'
import type { TextRun } from '@/lib/statements/layout'

// ParsedStatement is what a statement parser hands to the import screen plus
// human-readable notes (what was read or skipped on purpose) and warnings
// (checks that failed and deserve a manual look). A cartola is a batch of
// movements for the inbox (StageImport); a credit-card PDF carries whole
// statements, stored in full (ImportCardStatement) — one per currency.
export type ParsedStatement = { notes: string[]; warnings: string[] } & (
  | { kind: 'batch'; batch: ImportBatch }
  | { kind: 'cardStatements'; statements: CardStatementInput[] }
)

// StatementParser is one issuer's format (Strategy): `matches` recognizes the
// document from its plain text, `parse` reads the positioned runs. Supporting a
// new bank or statement type means adding one implementation to the registry
// in detect.ts.
export interface StatementParser {
  label: string
  matches(text: string): boolean
  parse(runs: readonly TextRun[]): ParsedStatement
}

// StatementFormatError means the document is not one we can read (unknown
// format, or a known one whose layout changed); its message is for the user.
export class StatementFormatError extends Error {
  override name = 'StatementFormatError'
}
