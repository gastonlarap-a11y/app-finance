// Synthetic CMR Falabella statement: the geometry of a real one (mixed-case
// "Label:" / value header, operations grouped by store, the card in the
// footer, the payment among the charges) with an invented holder, card and
// amounts. The real statement it copies had no purchases: the two purchase
// rows below are invented on the table header's columns, not copied from a
// real row. Its totals add up like a real one:
//   44.530 previous + (30.000 + 30.000) purchases − 44.530 payment = 60.000 billed;
//   60.000 + 60.000 not billed yet (2 × 30.000) = 120.000 of «Cupo Compras» used
import type { TextRun } from '@/lib/statements/layout'

type Cell = readonly [x: number, str: string, width?: number]
type Spec = readonly [y: number, ...cells: Cell[]]

const CHAR = 4.07

function right(edge: number, str: string): Cell {
  return [edge - str.length * CHAR, str, str.length * CHAR]
}

function rows(page: number, spec: readonly Spec[]): TextRun[] {
  return spec.flatMap(([y, ...cells]) => cells.map(([x, str, width]) => ({ page, str, x, y, width: width ?? str.length * 3.4 })))
}

// A movement row: place, date, descriptor, T/A, amounts and cuotas where the
// table header puts them; «Primer Cargo» holds text that is never read.
function movement(
  y: number, place: string, date: string, description: string,
  operation: string, total: string, cuotas: string, first: string, installment: string,
): Spec {
  const cells: Cell[] = [[35.97, place], [105.54, date, 38.53], [154.56, description], [314.89, 'T', 3.77],
    right(386.24, operation)]
  if (total !== '') cells.push(right(430, total))
  cells.push([447.65, cuotas, 19.26])
  if (first !== '') cells.push([487.8, first, 30])
  if (installment !== '') cells.push(right(550, installment))
  return [y, ...cells]
}

const HOLDER = 'ANA PRUEBA SOTO'

const TABLE_HEADER = (dy: number): Spec[] => [
  [260 + dy, [482.08, 'Cargo del Mes', 31.93]],
  [257 + dy, [33.01, 'Lugar', 15.71], [102.01, 'Fecha', 16.1], [305.04, 'Titular o', 22.69], [355.7, 'Monto', 17.11],
    [403.86, 'Monto', 17.11]],
  [254 + dy, [155.23, 'Descripción Operación', 60.75], [447.64, 'Número', 18.23], [487.8, 'Primer', 15.61],
    [523.65, 'Valor Cuota', 26.49]],
  [251 + dy, [33.01, 'Operación', 27.67], [102.01, 'Operación', 27.67], [299.75, 'Adicional (1)', 33.27],
    [350.42, 'Operación', 27.67], [394.37, 'Total a Pagar', 36.09]],
  [249 + dy, [449.06, 'Cuotas', 15.4], [488.94, 'Cargo', 13.33], [527.55, 'Mensual', 18.69]],
]

export const syntheticCmrRuns: readonly TextRun[] = [
  ...rows(1, [
    [753, [86.54, 'ESTADO DE CUENTA', 151.54]],
    [739, [86.54, 'CLIENTE CMR', 96.21]],
    [700, [32.59, 'Nombre del Titular:', 54.3], [141.17, HOLDER, 80]],
    [689, [32.59, 'Cupón de pago N°:', 51.38], [141.5, '11.111.111.01', 44.49]],
    [677, [32.59, 'N° de Contrato:', 42.97], [141.83, '000000******0000', 58.72]],
    [666, [32.59, 'Fecha Facturación Estado de Cuenta:', 103.3], [141.17, '19/06/2026', 37.43]],
    [632, [89.95, '· Pagar hasta', 40.79], [240.16, '05/07/2026', 38.52]],
    [622, [89.95, '· Monto total facturado a pagar', 96.8], [258.33, '60.000', 20.35]],
    [612, [89.95, '· Monto mínimo a pagar', 74.18], [258.33, '60.000', 20.35]],
    [516, [33, 'I. INFORMACIÓN GENERAL', 92.76]],
    [496, [144.52, 'Cupo Total', 33.14], [184.81, 'Cupo Utilizado', 44.56], [233.88, 'Cupo Disponible', 49.76]],
    [484, [32.42, 'Cupo Total*', 36.41], [143.15, '39.040.000', 35.95], [210.3, '120.000', 24.42], [246.48, '38.920.000', 35.95]],
    [477, [453.94, 'CAE PREPAGO:', 60.49]],
    [473, [32.42, 'Cupo Compras', 45.23], [147.23, '2.000.000', 31.86], [210.3, '120.000', 24.42], [250.57, '1.880.000', 31.86]],
    [462, [32.42, 'Cupo Avance en Efectivo**', 82.33], [176.61, '-', 2.49], [223.68, '0', 4.07], [250.57, '1.880.000', 31.86],
      [466.52, '0,00%', 35.32]],
    [450, [32.42, 'Cupo Súper Avance***', 69.59], [143.15, '37.040.000', 35.95], [223.68, '0', 4.07], [246.48, '37.040.000', 35.95]],
    [433, [145.75, 'Refundido', 31.35], [196.65, 'Cuotas', 21.21], [246.07, 'Avances', 25.38], [439.92, 'Desde', 19.16],
      [513.22, 'Hasta', 17.89]],
    [422, [32.42, 'Tasa Interés Vigente', 63.53], [159.46, '3,44%', 19.96], [208.13, '4,37%', 19.96], [262.46, '4,37%', 19.96],
      [304.16, 'Período Facturado', 57.47], [429.32, '20/05/2026', 38.52], [502.9, '19/06/2026', 38.53]],
    [410, [32.42, 'CAE', 12.32], [155.39, '50,06%', 24.03], [204.05, '42,85%', 24.05], [258.38, '45,67%', 24.05],
      [304.16, 'Pagar Hasta', 38.02], [464.65, '05/07/2026', 38.52]],
    [375, [31.83, 'II. DETALLE', 40.3]],
    [353, [32.09, '1. PERÍODO ANTERIOR', 74.05], [164.09, 'Desde', 19.16], [239.45, 'Hasta', 17.89]],
    [341, [32.09, 'Período de Facturación anterior', 98.93], [154.41, '20/04/2026', 38.52], [229.13, '19/05/2026', 38.53]],
    [324, [32.09, 'Saldo adeudado inicio período anterior', 120.01], [278.35, '0', 4.08]],
    [313, [32.09, 'Monto facturado o a pagar período anterior', 135.2], [260.36, '44.530', 22.06]],
    [302, [32.09, 'Monto pagado período anterior', 96.97], [257.88, '-44.530', 24.55]],
    [290, [32.09, 'Saldo adeudado final período anterior', 117.24], [278.35, '0', 4.08]],
    [271, [32.54, '2. PERÍODO ACTUAL', 66.33]],
    ...TABLE_HEADER(0),
    [232, [32.12, '2.1 Total Operaciones', 69.12]],
    [218, [33.45, 'FALABELLA', 38.23]],
    movement(205, 'FALABELLA ONLINE', '28/05/2026', 'Tienda Uno', '30.000', '30.000', '01/01', '', '30.000'),
    [193, [33.45, 'SODIMAC HOMECENTER', 78.88]],
    [178, [33.45, 'Sin Movimientos', 50.95]],
    [166, [33.67, 'COMPRAS NACIONALES', 77.36]],
    movement(151, 'SANTIAGO', '10/06/2026', 'Tienda Dos', '90.000', '90.000', '01/03', 'Jun-2026', '30.000'),
    [139, [33.9, 'COMPRAS INTERNACIONALES', 97.1]],
    [124, [33.45, 'Sin Movimientos', 50.95]],
    [19, [296.73, '1 de 2', 19.29]],
  ]),

  ...rows(2, [
    [767, [305.43, 'Nombre del Titular:', 54.3], [414, HOLDER, 80]],
    [753, [86.54, 'ESTADO DE CUENTA', 151.54]],
    [744, [305.43, 'N° de Contrato:', 42.97], [414.67, '000000******0000', 58.72]],
    [739, [86.54, 'CLIENTE CMR', 96.21]],
    // Every page repeats the statement's date in its header: never a movement.
    [733, [305.43, 'Fecha Facturación Estado de Cuenta:', 103.3], [414, '19/06/2026', 37.43]],
    ...TABLE_HEADER(446),
    [678, [32.64, '2.1 Total Operaciones', 69.12]],
    [664, [34.86, 'OTROS', 22.63]],
    [649, [33.97, 'Sin Movimientos', 50.95]],
    [635, [32.36, '2.2 Productos o servicios voluntariamente contratados', 172.78]],
    [616, [32.36, '2.3 Cargos, Comisiones, Impuestos y Abonos', 140.06]],
    movement(600, 'S/I', '25/05/2026', 'Pago Tarjeta Cmr', '-44.530', '', '01/01', '', ''),
    [570, [34.53, 'III. INFORMACIÓN DE PAGO', 95.58]],
    [548, [33.45, 'Monto Total Facturado a Pagar', 96.26], [260.45, '60.000', 20.35]],
    [537, [33.78, 'Monto Mínimo a Pagar', 70.27], [260.45, '60.000', 20.35]],
    [525, [33.45, 'Costo Monetario Prepago al 19/06/2026 ****', 141.61], [256.37, '120.000', 24.42]],
    [508, [110.23, 'Vencimiento próximos 4 meses', 97.1]],
    [497, [46.12, 'Actual', 19.41]],
    [485, [45.64, '60.000', 20.35]],
    [456, [33.78, 'Próximo Período a Facturar', 85.82], [161.85, '20/06/2026', 38.52], [233.02, '19/07/2026', 38.53]],
    [423, [34.03, 'IV. COSTO POR ATRASO', 82.93]],
    [350, [32.83, 'Tasa máxima interés vigente mora', 109.29], [199.18, '3,44%', 20.27]],
    [267, [29.78, `(1) T : Titular : 000000******4321|${HOLDER}`, 214.47]],
    [19, [297.68, '2 de 2', 18.88]],
  ]),
]
