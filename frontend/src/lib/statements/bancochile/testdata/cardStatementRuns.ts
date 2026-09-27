// Synthetic Banco de Chile credit-card statement: the geometry of the real
// format (label and column positions; several cells packed in one text run,
// as the bank prints them: "12.345 $", "060787654321 ZAPATERIA") with invented
// holder, card, merchants, codes and amounts. Its totals add up like a real one:
//   A 0 + B 0 + C 0 + D 60.000 + E 10.000 + F 0 + G 5.960 = 75.960 billed;
//   75.960 + 350.000 not billed yet = 425.960 credit used
import type { TextRun } from '@/lib/statements/layout'

type Cell = readonly [x: number, str: string, width?: number]

// Average character width of the statement's font.
const CHAR = 3.9

// Cells right-aligned at `right`.
function right(right: number, str: string): Cell {
  return [right - str.length * CHAR, str, str.length * CHAR]
}

function rows(page: number, spec: ReadonlyArray<readonly [y: number, ...cells: Cell[]]>): TextRun[] {
  return spec.flatMap(([y, ...cells]) =>
    cells.map(([x, str, width]) => ({ page, str, x, y, width: width ?? str.length * 4.2 })),
  )
}

// A movement's amounts: the operation amount shares its run with the next
// column's "$" ("50.000 $"), the total and the cuota stand alone.
function amounts(operation: string, total: string, installment: string): Cell[] {
  return [[379, '$', 4], right(445.4, `${operation} $`), right(498.7, total), [535, '$', 4], right(592.3, installment)]
}

// A movement: place, date, code and descriptor in one run, extra runs, amounts, cuota.
function movement(
  y: number, place: string, date: string, codeAndDescription: string, extra: Cell[],
  operation: string, total: string, cuota: string, installment: string,
): readonly [number, ...Cell[]] {
  const cells: Cell[] = [[105, date, 28], [143, codeAndDescription], ...extra, ...amounts(operation, total, installment), [508, cuota, 18]]
  return place === '' ? [y, ...cells] : [y, [45, place], ...cells]
}

function tableHeader(page: number, y: number): TextRun[] {
  return rows(page, [
    [y, [45, 'LUGAR DE', 40], [97, 'FECHA', 25], [144, 'CÓDIGO', 30], [195, 'DESCRIPCIÓN OPERACIÓN O COBRO', 135],
      [379, 'MONTO', 27], [441, 'MONTO', 27], [517, 'CARGOS DEL MES', 60]],
    [y - 11, [45, 'OPERACIÓN', 44], [97, 'OPERACIÓN REFERENCIA', 95], [379, 'OPERACIÓN', 44], [441, 'TOTAL A', 31],
      [504, 'N°', 8], [535, 'VALOR CUOTA', 50]],
    [y - 20, [504, 'CUOTA', 25]],
    [y - 23, [379, 'O COBRO', 35], [441, 'PAGAR', 26], [535, 'MENSUAL', 36]],
  ])
}

const HOLDER = 'ANA PRUEBA SOTO'

export const syntheticBancoChileRuns: readonly TextRun[] = [
  ...rows(1, [
    [764, [305, '1 de 3', 20]],
    [727, [232, 'ESTADO DE CUENTA NACIONAL DE TARJETA DE CRÉDITO', 230]],
    [715, [48, 'NOMBRE DEL TITULAR', 80], [176, HOLDER]],
    [706, [48, 'N° DE TARJETA DE CRÉDITO', 100], [176, 'XXXX XXX1 0000 4321', 80]],
    [698, [48, 'FECHA ESTADO DE CUENTA', 95], [176, '22/07/2026', 40]],
    [632, [383, HOLDER]],
    [586, [53, 'I.', 5], [67, 'INFORMACIÓN GENERAL', 90]],
    [561, [228, 'CUPO TOTAL', 45], [309, 'CUPO UTILIZADO', 65], [394, 'CUPO DISPONIBLE', 70], [515, 'CAE PREPAGO', 50]],
    [550, [50, 'CUPO TOTAL', 46], [209, '$', 4], right(300.8, '1.000.000 $'), right(388.7, '425.960 $'), right(467.5, '574.040')],
    [542, [537, '10,67 %', 30]],
    [539, [50, 'CUPO TOTAL AVANCE EN EFECTIVO', 130], [209, '$', 4], right(300.8, '900.000 $'), right(388.7, '0 $'),
      right(467.5, '574.040')],
    [525, [537, 'SIN SELLO', 40]],
    [519, [232, 'ROTATIVO', 40], [301, 'COMPRA EN CUOTAS', 75], [390, 'AVANCE EN CUOTAS', 75]],
    [508, [50, 'TASA INTERÉS VIGENTE', 90], [268, '2,55', 15], [283, '%', 6], [356, '2,87', 15], [371, '%', 6],
      [444, '2,87', 15], [459, '%', 6]],
    [496, [50, 'CAE', 15], [264, '50,23', 20], [283, '%', 6], [352, '42,18', 20], [371, '%', 6], [439, '49,36', 20], [459, '%', 6]],
    [488, [522, 'DESDE', 25], [565, 'HASTA', 25]],
    [481, [51, 'CAE se calcula sobre un supuesto de gasto mensual de UF 20 y pagadero en 12 cuotas.', 300]],
    [476, [418, 'PERÍODO FACTURADO', 80], [515, '19/06/2026', 40], [557, '22/07/2026', 40]],
    [465, [418, 'PAGAR HASTA', 50], [536, '04/08/2026', 40]],
    [447, [53, 'II.', 8], [67, 'DETALLE', 35]],
    [430, [47, '1. PERÍODO ANTERIOR', 85], [297, 'DESDE', 25], [365, 'HASTA', 25]],
    [418, [50, 'PERÍODO DE FACTURACIÓN ANTERIOR', 140], [292, '20/05/2026', 40], [360, '18/06/2026', 40]],
    [407, [50, 'SALDO ADEUDADO INICIO PERÍODO ANTERIOR', 170], [277, '$', 4], [336, '0', 4]],
    [396, [50, 'MONTO FACTURADO A PAGAR (PERÍODO ANTERIOR)', 190], [257, 'A', 5], [277, '$', 4], [336, '0', 4]],
    [384, [50, 'MONTO PAGADO PERÍODO ANTERIOR', 135], [277, '$', 4], [336, '0', 4]],
    [373, [50, 'SALDO ADEUDADO FINAL PERÍODO ANTERIOR', 165], [277, '$', 4], [336, '0', 4]],
    [353, [47, '2. PERÍODO ACTUAL', 75]],
  ]),
  ...tableHeader(1, 342),
  ...rows(1, [
    [308, [277, '1.TOTAL OPERACIONES', 85]],
    [296, [195, 'Sin Movimientos', 60]],
    [285, [279, 'TOTAL PAGOS A LA CUENTA', 105], [523, 'B', 5], [535, '$', 4], [588, '0', 4]],
    [273, [195, 'Sin Movimientos', 60]],
    [262, [285, 'TOTAL PAT A LA CUENTA', 95], [523, 'C', 5], [535, '$', 4], [588, '0', 4]],
    // The place of the operation ends the descriptor in a run of its own.
    movement(251, 'SANTIAGO', '04/07/26', '060711111111 ZAPATERIA UNO', [[270, 'SANTIAGO', 37]],
      '50.000', '50.000', '01/01', '50.000'),
    // The payment slip.
    [132, [43, 'EMISOR', 30], [317, 'CLIENTE', 32]],
    [116, [133, 'COMPROBANTE DE PAGO', 95], [408, 'COMPROBANTE DE PAGO', 95]],
    [103, [48, 'NOMBRE', 33], [175, 'NÚMERO DE TARJETA', 80], [322, 'NOMBRE', 33], [450, 'NÚMERO DE TARJETA', 80]],
    [92, [45, HOLDER], [320, HOLDER]],
    [81, [48, 'PAGAR HASTA', 50], [175, 'MONTO TOTAL FACTURADO A PAGAR', 135], [322, 'PAGAR HASTA', 50],
      [450, 'MONTO TOTAL FACTURADO A PAGAR', 135]],
    [70, [45, '04/08/2026', 40], [222, '$ 75.960', 30], [320, '04/08/2026', 40], [414, 'Banco', 20], [497, '$ 75.960', 30]],
    [58, [48, 'MONTO MÍNIMO A PAGAR', 93], [175, 'MONTO CANCELADO', 77], [322, 'MONTO MÍNIMO A PAGAR', 93],
      [450, 'MONTO CANCELADO', 77]],
    [47, [45, '$', 4], [54, '20.000', 22], [320, '$', 4], [329, '20.000', 22]],
  ]),

  ...rows(2, [
    [764, [305, '2 de 3', 20]],
    [727, [47, '2. PERÍODO ACTUAL', 75]],
  ]),
  ...tableHeader(2, 716),
  ...rows(2, [
    // The place glued to a truncated descriptor.
    movement(682, 'LAS CONDES', '10/07/26', '130722222222 MERCADOPAGO*TIENDA DOSLAS CONDES', [],
      '10.000', '10.000', '01/01', '10.000'),
    [557, [259, 'TOTAL TARJETA XXXX XXXX XXXX 4321', 139], [535, '$', 4], [566, '60.000', 26]],
    [546, [257, 'TOTAL TRANSACCIONES EN UNA CUOTA', 130], [523, 'D', 5], [535, '$', 4], [566, '60.000', 26]],
    movement(534, 'LAS CONDES', '03/07/26', '220733333333 TIENDA TRES', [[285, 'TASA INT. 0,00%', 60]],
      '120.000', '120.000', '01/12', '10.000'),
    [523, [263, 'TOTAL TRANSACCIONES EN CUOTAS', 120], [523, 'E', 5], [535, '$', 4], [570, '10.000', 22]],
    [512, [203, '2.PRODUCTOS O SERVICIOS VOLUNTARIAMENTE CONTRATADOS', 210]],
    [500, [195, 'Sin Movimientos', 60]],
    [489, [204, 'TOTAL PRODUCTOS O SERVICIOS VOLUNTARIAMENTE CONTRATADOS', 230], [524, 'F', 5], [535, '$', 4], [588, '0', 4]],
    [478, [232, '3.CARGOS, COMISIONES, IMPUESTOS Y ABONOS', 160]],
    movement(466, '', '22/07/26', '220700000000 COMISION ADMINISTRACION MENSUAL', [], '5.000', '5.000', '01/01', '5.000'),
    movement(455, '', '06/07/26', '060744444444 IMPUESTO DECRETO LEY 3475 TASA 0,800 %', [], '960', '960', '01/01', '960'),
    [410, [233, 'TOTAL CARGOS, COMISIONES, IMPUESTOS Y ABONOS', 180], [523, 'G', 5], [535, '$', 4], [570, '5.960', 22]],
    // Bought this period, first cuota next period (00/24): not billed yet.
    [331, [225, '4.INFORMACIÓN COMPRAS EN CUOTAS EN PERÍODO', 160], [535, '$', 4], [588, '0', 4]],
    movement(319, 'LAS CONDES', '06/07/26', '070744444444 TIENDA CUATRO TASA INT', [[332, '0,00%', 20]],
      '240.000', '240.000', '00/24', '10.000'),
  ]),

  ...rows(3, [
    [764, [305, '3 de 3', 20]],
    [726, [49, 'III. INFORMACIÓN DE PAGO', 100]],
    [705, [48, 'MONTO TOTAL FACTURADO A PAGAR (', 135], [188, 'A + B + C + D + E + F +G )', 70], [271, '$', 4],
      [325, '75.960', 26], [396, 'EVOLUCIÓN MONTOS FACTURADOS Y PAGADOS', 170]],
    [695, [48, 'MONTO MÍNIMO A PAGAR', 95], [271, '$', 4], [329, '20.000', 22]],
    [684, [48, 'COSTO MONETARIO PREPAGO', 110], [271, '$', 4], [319, '425.960', 30]],
    [681, [387, '80.000', 22]],
    [672, [48, 'CARGO AUTOMÁTICO', 80], [271, '$', 4], [347, '0', 4]],
    [634, [136, 'VENCIMIENTO PRÓXIMOS 4 MESES', 130], [536, 'Monto Facturado', 60]],
    [622, [59, 'ACTUAL', 30], [121, 'AGOSTO', 32], [175, 'SEPTIEMBRE', 50], [243, 'OCTUBRE', 38], [302, 'NOVIEMBRE', 45],
      [536, 'Monto Pagado', 44]],
    // The chart's axis labels (no "$") share the schedule's row.
    [611, [51, '$', 4], [67, '350.000', 30], [114, '$', 4], [134, '20.000', 22], [176, '$', 4], [196, '20.000', 22],
      [239, '$', 4], [259, '20.000', 22], [301, '$', 4], [321, '20.000', 22], [387, '40.000', 22]],
    [592, [248, 'DESDE', 25], [311, 'HASTA', 25]],
    [579, [45, 'PRÓXIMO PERÍODO DE FACTURACIÓN', 130], [243, '23/07/2026', 40], [305, '19/08/2026', 40]],
    [556, [49, 'IV. COSTOS POR ATRASO', 90]],
    [533, [48, 'INTERÉS MORATORIO', 80], [161, '30,60%', 25]],
    [406, [48, 'DÓLARES-PREMIO AL 20-JUL-2026', 120]],
  ]),
]
