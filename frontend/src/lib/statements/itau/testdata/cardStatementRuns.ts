// Synthetic Itaú credit-card statement: the geometry of the real format
// (label and column positions, right-aligned amounts printed a point above
// their row, the payment slip at the foot of pages) with invented holder,
// card, merchants and amounts. Its totals add up like a real statement:
//   national  A 50.000 + B 4.685 + C 0 + D 7.810 = 62.495 billed;
//             62.495 + 387.505 not billed yet = 450.000 credit used
//   international  100,00 − 100,00 + 0 + 20,00 − 2,25 = 17,75 USD debt
import type { TextRun } from '@/lib/statements/layout'

type Cell = readonly [x: number, str: string, width?: number]

// Amount columns share a right edge; widths approximate the font's.
const RIGHT = { operation: 443, total: 485, installment: 593, origin: 537, usd: 592 } as const

function amount(column: keyof typeof RIGHT, str: string): Cell {
  const width = str.length * 3.3
  return [RIGHT[column] - width, str, width]
}

function rows(page: number, spec: ReadonlyArray<readonly [y: number, ...cells: Cell[]]>): TextRun[] {
  return spec.flatMap(([y, ...cells]) =>
    cells.map(([x, str, width]) => ({
      page,
      str,
      x,
      // Amounts sit a point above the row's text, as in the real PDF.
      y: /^(US)?\$|^-?[\d.]+,\d\d$/.test(str) ? y + 1 : y,
      width: width ?? str.length * 4.4,
    })),
  )
}

const HOLDER = 'ANA PRUEBA SOTO'

function header(page: number, title: string, titleX: number): TextRun[] {
  return rows(page, [
    [721.9, [titleX, title, 213]],
    [710.9, [43, 'NOMBRE DEL TITULAR', 82], [170, HOLDER]],
    [700.6, [43, 'Nº DE TARJETA DE CRÉDITO', 103], [170, 'XXXX XXXX XXXX 4321', 82]],
    [690.2, [43, 'FECHA ESTADO DE CUENTA', 102], [170, '25/08/2026', 37]],
    [631.3, [370, HOLDER]],
    [621.0, [370, 'CALLE FICTICIA 123']],
  ])
}

// The national movements table header, as printed at the top of each page.
function nationalTableHeader(page: number, y: number): TextRun[] {
  return rows(page, [
    [y, [40, 'LUGAR DE', 38], [102, 'FECHA', 25], [150, 'CÓDIGO', 30], [207, 'DESCRIPCIÓN OPERACIÓN O COBRO', 134],
      [400, 'MONTO', 27], [448, 'MONTO', 27], [504, 'CARGO DEL MES', 61]],
    [y - 11, [40, 'OPERACIÓN', 44], [102, 'OPERACIÓN REFERENCIA', 96], [400, 'OPERACIÓN', 44], [448, 'TOTAL A', 31],
      [490, 'Nº CUOTA', 36], [536, 'VALOR CUOTA', 53]],
    [y - 21.3, [400, 'O COBRO', 35], [448, 'PAGAR', 26], [536, 'MENSUAL', 36]],
  ])
}

// A national movement: place, date, code, description runs, amounts, cuota.
function movement(
  y: number, place: string, date: string, code: string, description: Cell[],
  operation: string, total: string, cuota: string, installment: string,
): readonly [number, ...Cell[]] {
  const cells: Cell[] = [[113, date, 29], [149, code, 51], ...description,
    amount('operation', operation), amount('total', total), [509, cuota, 18], amount('installment', installment)]
  return place === '' ? [y, ...cells] : [y, [40, place], ...cells]
}

function paymentSlip(page: number, total: string): TextRun[] {
  return rows(page, [
    [130.1, [366, 'Estimado cliente, para pagar este estado de cuenta por caja, debe completar', 227]],
    [121.3, [37, 'EMISOR', 29], [327, 'CLIENTE', 32], [366, 'los números de su tarjeta de crédito en los casilleros correspondientes.', 207]],
    [110.0, [126, 'COMPROBANTE DE PAGO', 95], [410, 'COMPROBANTE DE PAGO', 95]],
    [98.3, [40, 'NOMBRE', 33], [167, 'NÚMERO DE CUENTA', 78], [325, 'NOMBRE', 33], [452, 'NÚMERO DE CUENTA', 78]],
    [88.1, [40, HOLDER], [287, '4321', 16], [325, HOLDER], [572, '4321', 16]],
    [76.9, [40, 'PAGAR HASTA', 54], [167, 'MONTO TOTAL FACTURADO A PAGAR', 139], [325, 'PAGAR HASTA', 54], [452, 'MONTO TOTAL FACTURADO A PAGAR', 139]],
    [66.7, [40, '08/09/2026', 37], [325, '08/09/2026', 37]],
    [62.2, [167, total, 31], [452, total, 31]],
    [52.1, [40, 'MONTO MÍNIMO A PAGAR', 93], [167, 'MONTO CANCELADO', 77], [325, 'MONTO MÍNIMO A PAGAR', 93], [452, 'MONTO CANCELADO', 77]],
    [38.5, [40, total, 31], [325, total, 31]],
  ])
}

const national: TextRun[] = [
  ...rows(1, [[765.4, [277, '1 de 3', 27]]]),
  ...header(1, 'ESTADO DE CUENTA NACIONAL DE TARJETA DE CRÉDITO', 210),
  ...rows(1, [
    [583.8, [55, 'I.', 4], [71, 'INFORMACIÓN GENERAL', 91]],
    [559.8, [200, 'CUPO TOTAL', 48], [283, 'CUPO UTILIZADO', 63], [371, 'CUPO DISPONIBLE', 68], [512, 'CAE PREPAGO', 80]],
    [547.1, [43, 'CUPO TOTAL', 47], [218, '$ 2.000.000', 43], [313, '$ 450.000', 39], [404, '$ 1.550.000', 39]],
    [538.0, [43, 'CUPO TOTAL AVANCE EN EFECTIVO', 131], [218, '$ 2.000.000', 43], [342, '$ 0', 10], [404, '$ 1.550.000', 39],
      [533, '12,50%', 38]],
    [515.5, [205, 'ROTATIVO', 38], [276, 'COMPRA EN CUOTAS', 78], [367, 'AVANCE EN CUOTAS', 77]],
    [503.9, [43, 'TASA INTERÉS VIGENTE', 88], [240, '2,10%', 21], [331, '3,90%', 21], [422, '3,95%', 21]],
    [492.3, [43, 'CAE', 15], [236, '60,10%', 25], [327, '58,20%', 25], [418, '66,40%', 25]],
    [485.2, [518, 'DESDE', 25], [561, 'HASTA', 25]],
    [473.5, [416, 'PERÍODO FACTURADO', 82], [512, '28/07/2026', 37], [555, '25/08/2026', 37]],
    [461.9, [416, 'PAGAR HASTA', 52], [534, '08/09/2026', 37]],
    [442.1, [53, 'II.', 6], [71, 'DETALLE', 34]],
    [420.7, [43, '1. PERÍODO ANTERIOR', 83], [272, 'DESDE', 25], [343, 'HASTA', 25]],
    [409.1, [43, 'PERÍODO DE FACTURACIÓN ANTERIOR', 142], [272, '24/06/2026', 37], [346, '27/07/2026', 37]],
    [397.0, [43, 'SALDO ADEUDADO INICIO PERÍODO ANTERIOR', 170], [301, '$0', 8]],
    [386.7, [43, 'MONTO FACTURADO A PAGAR (PERÍODO ANTERIOR)', 191], [236, '(A)', 10], [279, '$50.000', 31]],
    [376.3, [43, 'MONTO PAGADO PERÍODO ANTERIOR', 137], [276, '$-50.000', 33]],
    [365.9, [43, 'SALDO ADEUDADO FINAL PERÍODO ANTERIOR', 168], [280, '$0', 8]],
    [345.9, [43, '2. PERÍODO ACTUAL', 75]],
  ]),
  ...nationalTableHeader(1, 334.4),
  ...rows(1, [
    [300.9, [207, '1.TOTAL OPERACIONES', 87], [521, '(B)', 10], [568, '$4.685', 27]],
    movement(292.8, '', '10/08/26', '1008 00000000', [[207, 'MONTO CANCELADO', 75]], '$-50.000', '$-50.000', '01/01', '$-50.000'),
    [268.5, [207, 'TOTAL PAGOS A LA CUENTA', 105], [558, '$-50.000', 33]],
    // Cuota 2/3 of an earlier purchase; its interest note shares the run.
    movement(260.4, 'SANTIAGO', '16/06/26', '2508 11111111', [[207, 'TIENDA UNO TASA INT. 0,00%', 120]],
      '$30.000', '$30.000', '02/03', '$10.000'),
    // Cuota 3/6 with the descriptor split in runs and the interest note apart.
    movement(250.1, 'SANTIAGO', '20/06/26', '2508 22222222', [[207, 'MP', 11], [228, '*TIENDA DOS', 55], [298, 'TASA INT. 0,00%', 60]],
      '$60.001', '$60.001', '03/06', '$10.000'),
  ]),
  ...paymentSlip(1, '$62.495'),

  ...rows(2, [[765.4, [277, '2 de 3', 27]], [718.5, [43, '2. PERÍODO ACTUAL', 75]]]),
  ...nationalTableHeader(2, 707.0),
  ...rows(2, [
    // Descriptors ending with the place of the operation, in a run of their own or not.
    movement(676.4, 'SANTIAGO', '12/08/26', '1308 33333333', [[207, 'TAXI', 20], [233, '*VIAJE', 30], [288, 'SANTIAGO', 38]],
      '$2.340', '$2.340', '01/01', '$2.340'),
    movement(666.0, 'CHILLAN', '14/08/26', '1408 44444444', [[207, 'FARMACIA CENTRO CHILLAN CHILLAN', 129]],
      '$12.345', '$12.345', '01/01', '$12.345'),
    movement(655.7, 'Las Condes', '20/08/26', '2508 55555555', [[207, 'ELECTRO HOGAR', 60], [308, 'TASA INT. 0,00%', 60]],
      '$240.000', '$240.000', '01/12', '$20.000'),
    [644.4, [207, 'TOTAL TARJETA XXXX XXX4 1', 111], [560, '$54.685', 31]],
    [633.7, [207, '2.PRODUCTOS O SERVICIOS VOLUNTARIAMENTE CONTRATADOS SIN MOVIMIENTOS', 308], [521, '(C)', 10], [586, '$0', 8]],
    [622.7, [207, '3.CARGOS, COMISIONES, IMPUESTOS Y ABONOS', 179], [521, '(D)', 10], [572, '$7.810', 23]],
    movement(613.6, '', '10/08/26', '1008 00000000', [[207, 'IMPUESTO DECRETO LEY 3475 TASA 0,066 %', 161]], '$150', '$150', '01/01', '$150'),
    movement(603.3, '', '17/08/26', '1708 00000000', [[207, 'ABONO CANJE COMPRA TC', 99]], '$-2.340', '$-2.340', '01/01', '$-2.340'),
    movement(592.9, '', '21/08/26', '2108 00000000', [[207, 'CASHBACK COM AGO26', 86]], '$-10.000', '$-10.000', '01/01', '$-10.000'),
    movement(582.6, '', '25/08/26', '2508 00000000', [[207, 'COMISION ADMINISTRACION MENSUAL', 141]], '$20.000', '$20.000', '01/01', '$20.000'),
  ]),

  ...rows(3, [
    [765.4, [277, '3 de 3', 27]],
    [716.1, [51, 'III.', 8], [71, 'INFORMACIÓN DE PAGO', 89]],
    [696.1, [40, 'MONTO TOTAL FACTURADO A PAGAR', 136], [180, '(A + B + C +D)', 49], [284, '$62.495', 31],
      [401, 'EVOLUCIÓN MONTOS FACTURADOS Y PAGADOS', 178]],
    [685.7, [40, 'MONTO MÍNIMO A PAGAR', 92], [284, '$62.495', 31]],
    // The chart's axis labels (no "$") share rows with the payment fields.
    [677.1, [40, 'COSTO MONETARIO PREPAGO', 111], [278, '$450.000', 37], [393, '120.000', 21]],
    [665.0, [40, 'CARGO AUTOMÁTICO', 78], [307, '$0', 8]],
    [628.3, [129, 'VENCIMIENTO PRÓXIMOS 4 MESES', 127]],
    [616.8, [53, 'ACTUAL', 29], [107, 'SEPTIEMBRE', 48], [175, 'OCTUBRE', 36], [233, 'NOVIEMBRE', 44], [297, 'DICIEMBRE', 41],
      [393, '95.000', 21]],
    [604.7, [54, '$387.505', 37], [123, '$40.000', 31], [185, '$40.000', 31], [247, '$30.000', 31], [310, '$30.000', 31]],
    [585.8, [223, 'DESDE', 25], [279, 'HASTA', 25]],
    [574.3, [43, 'PRÓXIMO PERÍODO DE FACTURACIÓN', 138], [217, '26/08/2026', 37], [274, '23/09/2026', 37]],
    [551.4, [51, 'IV.', 9], [71, 'COSTOS POR ATRASO', 82]],
    [538.9, [43, 'INTERÉS MORATORIO', 79], [156, '28,50%', 25]],
  ]),
]

const international: TextRun[] = [
  ...rows(4, [[766.3, [278, '1 de 1', 25]]]),
  ...header(4, 'ESTADO DE CUENTA INTERNACIONAL DE TARJETA DE CRÉDITO', 199),
  ...rows(4, [
    [556.8, [55, 'I.', 4], [71, 'INFORMACIÓN GENERAL', 91]],
    [534.8, [190, 'CUPO TOTAL', 48], [254, 'CUPO UTILIZADO CUPO DISPONIBLE', 136]],
    [522.2, [43, 'CUPO TOTAL', 47], [181, 'US$ 2.500,00', 49], [252, 'US$ 17,75', 39], [323, 'US$ 2.482,25', 49]],
    [500.3, [43, 'CUPO TOTAL AVANCE EN EFECTIVO', 131], [181, 'US$ 2.500,00', 49], [252, 'US$ 0,00', 31], [323, 'US$ 2.482,25', 49]],
    [468.4, [53, 'II.', 6], [71, 'DETALLE', 34]],
    [446.4, [53, '1.', 6], [71, 'INFORMACIÓN DE PAGO', 89]],
    [425.8, [40, 'SALDO ANTERIOR FACTURADO', 113], [214, 'US$ 100,00', 39], [374, 'PERÍODO FACTURADO DESDE', 109], [550, '28/07/2026', 37]],
    [414.2, [40, 'ABONO REALIZADO', 70], [213, 'US$-100,00', 39], [374, 'PERÍODO FACTURADO HASTA', 109], [550, '25/08/2026', 37]],
    [402.6, [40, 'TRASPASO DEUDA NACIONAL', 108], [222, 'US$ 0,00', 31], [374, 'PAGAR HASTA', 52], [550, '08/09/2026', 37]],
    [391.0, [40, 'DEUDA TOTAL', 52], [214, 'US$ 17,75', 39]],
    [351.4, [53, '2.', 6], [71, 'INFORMACIÓN DE TRANSACCIONES', 131]],
    [338.8, [40, 'NÚMERO REFERENCIA', 82], [156, 'FECHA', 25], [207, 'DESCRIPCIÓN OPERACIÓN O COBRO', 134], [391, 'CIUDAD', 28],
      [475, 'PAÍS MONTO', 48], [547, 'MONTO US$', 44]],
    [328.5, [40, 'INTERNACIONAL', 60], [156, 'OPERACIÓN', 44], [496, 'MONEDA', 32]],
    [318.2, [496, 'ORIGEN', 29]],
    [306.0, [207, 'TOTAL DE PAGOS', 66], amount('usd', '-100,00')],
    [296.1, [40, '3007', 16], [159, '30/07/26', 29], [207, 'MONTO CANCELADO', 75], [476, 'CL', 9],
      amount('origin', '-100,00'), amount('usd', '-100,00')],
    [283.9, [207, 'TOTAL DE COMPRAS', 77], amount('usd', '20,00')],
    [274.0, [40, '0308 11112222333344445555666', 113], [159, '02/08/26', 29], [207, 'SERVICIO WEB SUB', 80],
      [391, 'SAN FRANCISCO', 61], [476, 'US', 10], amount('origin', '20,00'), amount('usd', '20,00')],
    [251.5, [40, 'TOTAL TARJETA XXXXXXXXXXXX4321', 138], amount('usd', '20,00')],
    [240.5, [207, 'COMISIONES, OTROS CARGOS Y ABONOS A LA C UENTA', 207], amount('usd', '-2,25')],
    [230.5, [40, '1008 99998888777766665555444', 113], [159, '07/08/26', 29], [207, 'TIENDA APPS', 50], [391, 'CUPERTINO', 43],
      [476, 'US', 10], amount('origin', '-2.027,00'), amount('usd', '-2,25')],
    [117.8, [117, 'COMPROBANTE DE PAGO', 95], [419, 'COMPROBANTE DE PAGO', 95]],
    [83.4, [40, 'Pagar Hasta', 43], [176, 'Monto Facturado', 60]],
    [71.8, [40, '08/09/2026', 37], [176, 'US$17,75', 37]],
  ]),
]

export const syntheticCardStatementRuns: readonly TextRun[] = [...national, ...international]
