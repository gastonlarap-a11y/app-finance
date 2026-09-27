// Registry of supported statement formats. Add a parser here to support a new
// bank or document type; the first one whose `matches` accepts the text wins,
// so an issuer recognized by its own marks goes before the fallback it shares
// a format with (Banco de Chile before Itaú: both print the CMF's standard).
import { groupRows, rowText, type TextRun } from '@/lib/statements/layout'
import { itauAccountStatement } from '@/lib/statements/itau/accountStatement'
import { itauCardStatement } from '@/lib/statements/itau/cardStatement'
import { itauWebCardStatement } from '@/lib/statements/itau/webCardStatement'
import { bancoChileCardStatement } from '@/lib/statements/bancochile/cardStatement'
import { StatementFormatError, type ParsedStatement, type StatementParser } from '@/lib/statements/types'

const PARSERS: readonly StatementParser[] = [
  itauAccountStatement,
  bancoChileCardStatement,
  itauCardStatement,
  itauWebCardStatement,
]

// format is the parser's label, shown to the user.
export type DetectedStatement = ParsedStatement & { format: string }

// parseStatement recognizes the document and parses it; an unknown format is
// a StatementFormatError listing what is supported.
export function parseStatement(runs: readonly TextRun[]): DetectedStatement {
  const text = groupRows(runs).map(rowText).join('\n')
  const parser = PARSERS.find((p) => p.matches(text))
  if (!parser) {
    throw new StatementFormatError(
      `No se reconoce el formato del PDF. Por ahora se admiten: ${PARSERS.map((p) => p.label).join(', ')}.`,
    )
  }
  return { ...parser.parse(runs), format: parser.label }
}
