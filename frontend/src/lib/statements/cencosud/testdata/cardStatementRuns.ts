// Synthetic Tarjeta Cencosud Scotiabank statement: the geometry of the real
// format (header runs "TARJETA ****…", bare amounts, one sub-header per card,
// notes the user wrote over the PDF inside the description column) with an
// invented holder, cards, merchants and amounts. Its totals add up like a real one:
//   500.000 previous + (−500.000 + 100.000 + 50.000 + 30.000 − 10.000 + 20.000) operations
//   + 1.000 voluntary + 2.000 charges = 193.000 billed;
//   193.000 + 960.000 not billed yet (9 × 100.000 + 2 × 30.000) = 1.153.000 credit used
import type { TextRun } from '@/lib/statements/layout'

type Cell = readonly [x: number, str: string, width?: number]
type Spec = readonly [y: number, ...cells: Cell[]]

const CHAR = 3.62

function right(edge: number, str: string): Cell {
  return [edge - str.length * CHAR, str, str.length * CHAR]
}

function rows(page: number, spec: readonly Spec[]): TextRun[] {
  return spec.flatMap(([y, ...cells]) => cells.map(([x, str, width]) => ({ page, str, x, y, width: width ?? str.length * 3.6 })))
}

// A movement: place, date, descriptor, operation, total, cuota, cuota amount;
// `note` is text the user wrote over the PDF, in the description column.
function movement(
  y: number, place: string, date: string, description: string,
  operation: string, total: string, cuota: string, installment: string, note?: string,
): Spec {
  const cells: Cell[] = [[99.56, date, 37.56], [143.55, description], right(449.07, operation), right(494.78, total),
    [cuota.length > 3 ? 507.58 : 511.78, cuota, cuota.length * 3.6], right(568.16, installment)]
  if (place !== '') cells.unshift([43.84, place])
  if (note) cells.push([266.36, note])
  return [y, ...cells]
}

const HEADER = (page: number): Spec[] => [
  [748, [104.88, 'ESTADO DE CUENTA', 128.55]],
  [731, [104.88, 'TARJETA CENCOSUD SCOTIABANK BLACK', 263.18]],
  [696, [530.97, `Pag ${page} de 3`, 38.51]],
  [672, [57.3, 'NOMBRE ANA PRUEBA SOTO', 130], [364.86, 'ANA PRUEBA SOTO', 90]],
  [658, [57.3, 'TARJETA ************4321', 117.02], [364.86, 'CALLE FICTICIA 123', 90]],
  [643, [57.3, 'FECHA 21/03/2026', 85.99], [364.86, 'SANTIAGO', 36.81]],
]

const TABLE_HEADER: Spec[] = [
  [616, [46.1, '2. PERIODO ACTUAL', 75.01], [501.82, 'CARGO DEL MES', 61.22]],
  [604, [534.23, 'VALOR', 23.74]],
  [599, [408.81, 'MONTO', 26.35], [459.7, 'MONTO', 26.35]],
  [594, [50.75, 'LUGAR DE', 35.47], [100.9, 'FECHA DE', 34.89], [505.47, 'N°', 7.89], [534.04, 'CUOTA', 24.13]],
  [590, [205.65, 'DESCRIPCIÓN OPERACIÓN O COBRO', 125.26], [397.53, 'OPERACIÓN O', 48.91], [458.23, 'TOTAL A', 29.29]],
  [585, [47.73, 'OPERACIÓN', 41.52], [97.59, 'OPERACIÓN', 41.52], [497.35, 'CUOTA', 24.13], [529.01, 'MENSUAL', 34.18]],
  [580, [395.31, 'COBRO ($/USD)', 53.33], [455.16, 'PAGAR ($)', 35.43]],
  [575, [541.5, '($)', 9.21]],
]

export const syntheticCencosudRuns: readonly TextRun[] = [
  ...rows(1, [
    ...HEADER(1),
    [607, [57.44, 'I. INFORMACIÓN GENERAL', 115.86]],
    [582, [228.28, 'Cupo Total', 37.93], [273.93, 'Cupo Utilizado', 51.37], [332.37, 'Cupo Disponible', 57.53],
      [477.21, 'CAE PREPAGO', 52.81]],
    [568, [46.1, 'CUPO TOTAL', 47.18], [227.78, '3.000.000', 34.92], [290.68, '1.153.000', 34.92], [350.82, '1.847.000', 34.92],
      [492.52, '3.39%', 22.19]],
    [555, [46.1, 'CUPO TOTAL AVANCE EN EFECTIVO', 130.24], [245.65, '-', 3.18], [321.1, '0', 4.5], [350.82, '1.500.000', 34.92]],
    [554, [469.34, 'SIN SELLO SERNAC', 68.55]],
    [520, [214.77, 'TASA DE INTERÉS Y CAE', 89.03], [458.02, 'PERIODO DE FACTURACIÓN', 102.13]],
    [506, [185.39, 'ROTATIVO', 37.63], [245.36, 'CUOTAS', 30.53], [297.98, 'AVANCES', 35.48], [466.47, 'DESDE', 25.05],
      [526.24, 'HASTA', 25.6]],
    [493, [46.1, 'TASA INTERÉS VIGENTE', 87.29], [193.1, '2.46%', 22.19], [249.53, '3.40%', 22.19], [304.61, '3.40%', 22.19],
      [353.5, 'PERIODO FACTURADO', 82.9], [458.87, '22/02/2026', 40.24], [518.91, '21/03/2026', 40.24]],
    [480, [46.1, 'CAE', 15.05], [190.85, '50.85%', 26.69], [247.28, '64.18%', 26.69], [302.36, '64.18%', 26.69]],
    [479, [353.5, 'PAGAR HASTA', 53.69], [518.91, '06/04/2026', 40.24]],
    [423, [57.44, 'II. DETALLE', 49.01]],
    [398, [106.96, '1. PERIODO ANTERIOR', 83.16], [279.61, 'DESDE', 25.05], [348.97, 'HASTA', 25.6]],
    [384, [46.1, 'PERIODO FACTURADO ANTERIOR', 123.55], [272.01, '22/01/2026', 40.24], [341.64, '21/02/2026', 40.24]],
    [370, [46.1, 'SALDO ADEUDADO INICIO PERIODO ANTERIOR', 174], [385.74, '0', 4.5]],
    [357, [46.1, 'MONTO FACTURADO A PAGAR DEL PERIODO ANTERIOR', 205.96], [360.68, '500.000', 26.8]],
    [344, [46.1, 'MONTO PAGADO PERIODO ANTERIOR', 139.58], [358.3, '-500.000', 29.76]],
    [331, [46.1, 'SALDO ADEUDADO FINAL PERIODO ANTERIOR', 172.79], [385.74, '0', 4.5]],
    // The payment slip: its date is never a movement.
    [97, [62.98, 'CUENTA', 30.37], [126.19, 'HASTA', 25.6]],
    [79, [48.92, '************4321', 58.5], [118.86, '06/04/2026', 40.24], [214.13, '193.000', 26.8], [273.4, '50.000', 22.6]],
  ]),

  ...rows(2, [
    ...HEADER(2),
    ...TABLE_HEADER,
    [563, [143.55, '1.TOTAL OPERACIONES NACIONALES', 136.09]],
    [550, [143.55, '************4321 - ANA PRUEBA SOTO', 150]],
    movement(537, '', '27/02/2026', 'MONTO CANCELADO SERVIPAG APP', '500.000', '-500.000', '1/1', '-500.000', 'pago de febrero'),
    movement(523, 'LAS CONDES', '22/12/2025', 'TIENDA UNO CL', '1.200.000', '1.200.000', '3/12', '100.000'),
    // A note a little above its row, as the real PDF places some.
    [521.2, [267.06, 'celular cuota 3 de 12 G', 80]],
    movement(510, 'SANTIAGO', '21/02/2026', 'MERCADOPAGO TIENDA DOS', '50.000', '50.000', '1/1', '50.000', 'FC'),
    movement(497, 'SANTIAGO', '24/02/2026', 'TIENDA TRES', '90.000', '90.000', '1/3', '30.000'),
    movement(484, 'SANTIAGO', '11/03/2026', 'TIENDA TRES', '10.000', '-10.000', '1/1', '-10.000', 'devolución'),
    // A note alone on its line: no date, never a movement.
    [476, [301.62, 'FC', 8]],
    [470, [143.55, '************9876 - ANA PRUEBA SOTO', 150]],
    [457, [143.55, '2.TOTAL OPERACIONES INTERNACIONALES', 158.09]],
    [444, [143.55, '************4321 - ANA PRUEBA SOTO', 150]],
    movement(431, '', '04/03/2026', 'SERVICIO DIGITAL 22 USD', '20.000', '20.000', '1/1', '20.000'),
    [418, [143.55, '3.PRODUCTOS O SERVICIOS VOLUNTARIAMENTE CONTRATADOS', 238.67]],
    [405, [143.55, '************4321 - ANA PRUEBA SOTO', 150]],
    movement(392, '', '21/03/2026', 'SEGURO DESGRAVAMEN', '1.000', '1.000', '1/1', '1.000'),
    [379, [143.55, '4.CARGOS, COMISIONES, IMPUESTOS Y ABONOS', 177.06]],
    movement(366, '', '21/03/2026', 'SERVICIO ADMINISTRACION MENSUAL', '2.000', '2.000', '1/1', '2.000'),
    [353, [143.55, '5.INFORMACIÓN COMPRAS EN CUOTAS EN PERIODO (NAC-INTER)', 241.06]],
  ]),

  ...rows(3, [
    ...HEADER(3),
    [607, [57.44, 'III. INFORMACIÓN DE PAGO', 119.16]],
    [582, [46.1, 'MONTO TOTAL FACTURADO A PAGAR', 138.52], [275.18, '193.000', 26.8]],
    [568, [46.1, 'MONTO MÍNIMO A PAGAR', 94.72], [279.32, '50.000', 22.6]],
    [554, [46.1, 'COSTO MONETARIO PREPAGO', 110.71], [267.49, '1.153.000', 34.92]],
    [534, [130.39, 'VENCIMIENTOS PRÓXIMOS 4 MESES', 131.68]],
    [520, [62.47, 'ACTUAL', 30.46], [133.93, 'MAY', 16.25], [194.29, 'JUN', 13.8], [254.12, 'JUL', 12.41], [311.28, 'AGO', 16.88]],
    [506, [78.94, '960.000', 26.8], [139.7, '130.000', 26.8], [198.84, '130.000', 26.8], [257.97, '100.000', 26.8],
      [317.62, '100.000', 26.8]],
    [486, [239.71, 'DESDE', 25.05], [304.26, 'HASTA', 25.6]],
    [472, [46.1, 'PRÓXIMO PERIODO A FACTURAR', 121.32], [232.11, '22/03/2026', 40.24], [296.93, '21/04/2026', 40.24]],
    [405, [57.44, 'IV. COSTOS POR ATRASO', 110.59]],
    [380, [46.1, 'INTERÉS MORATORIO', 79], [291.73, '29.52% ANUAL', 54.61]],
  ]),
]
