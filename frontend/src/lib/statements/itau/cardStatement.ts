// Itaú Chile credit-card statement as the bank emails it: one PDF with the
// national statement (CLP) and, after it, the international one (USD), in the
// CMF's standard format (see cmfCardStatement.ts). Any standard statement
// without another issuer's marks is read as Itaú's, the first one supported.
import { cmfCardStatementParser } from '@/lib/statements/cmfCardStatement'

export const itauCardStatement = cmfCardStatementParser({
  issuer: 'itau',
  label: 'Estado de cuenta tarjeta de crédito Itaú',
  matches: () => true,
  packedCells: false,
})
