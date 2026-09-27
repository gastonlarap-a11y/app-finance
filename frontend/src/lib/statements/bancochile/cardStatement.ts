// Banco de Chile credit-card statement, in the CMF's standard format (see
// cmfCardStatement.ts). Its text never names the bank (the logo is an image):
// it is recognized by its rewards program ("DÓLARES-PREMIO") or by the way it
// totals purchases (one-cuota and cuotas apart). Its PDF packs several cells
// in one text run ("12.345 $", "060787654321 ZAPATERIA").
import { cmfCardStatementParser } from '@/lib/statements/cmfCardStatement'
import { norm } from '@/lib/statements/cardFields'

export const bancoChileCardStatement = cmfCardStatementParser({
  issuer: 'bancochile',
  label: 'Estado de cuenta tarjeta de crédito Banco de Chile',
  matches(text) {
    const t = norm(text)
    return t.includes('DOLARES-PREMIO') || t.includes('TOTAL TRANSACCIONES EN UNA CUOTA')
  },
  packedCells: true,
})
