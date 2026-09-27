// Synthetic Itaú credit-card statement downloaded from the bank's website: the
// geometry of the real format (mixed-case labels, "Label: value" header runs,
// dates a little left of their header, the place column out of step with its
// rows) with invented holder, card, merchants, codes and amounts. Its totals
// add up like a real one:
//   50.000 previous + (10.000 + 20.000 − 50.000) operations + (300 − 1.000 + 5.000) charges = 34.300 billed;
//   34.300 + 190.000 not billed yet = 224.300 credit used
import type { TextRun } from '@/lib/statements/layout'

type Cell = readonly [x: number, str: string, width?: number]

const CHAR = 2.9

function right(right: number, str: string): Cell {
  return [right - str.length * CHAR, str, str.length * CHAR]
}

function rows(page: number, spec: ReadonlyArray<readonly [y: number, ...cells: Cell[]]>): TextRun[] {
  return spec.flatMap(([y, ...cells]) =>
    cells.map(([x, str, width]) => ({ page, str, x, y, width: width ?? str.length * 3.2 })),
  )
}

// A movement: date, 16-digit code, descriptor, amounts, cuota.
function movement(
  y: number, date: string, code: string, description: string,
  operation: string, total: string, cuota: string, installment: string,
): readonly [number, ...Cell[]] {
  return [y, [78.5, date, 30], [135.4, code, 53], [249.1, description], right(419.8, operation), right(476.6, total),
    [497.6, cuota, 15], right(590.4, installment)]
}

const HOLDER = 'ANA PRUEBA SOTO'
const FOOTER: readonly [number, ...Cell[]] = [22, [114, 'Infórmese sobre la garantía estatal de los depósitos en su banco', 240],
  [361, '© 2014 Banco Itaú. Todos los derechos reservados', 140]]

export const syntheticItauWebRuns: readonly TextRun[] = [
  ...rows(1, [
    [711, [22, 'Estado de cuenta nacional', 70], [356, '26/09/2026 18:22:27', 55]],
    [700, [519, 'Datos del cliente', 45]],
    [687, [22, 'Nombre del titular: Ana Prueba Soto', 100], [307, 'Dirección de envío: Calle Ficticia 123', 110]],
    [675, [22, 'Nº de tarjeta de crédito: xxxx-xxxx-xxxx-4321', 120], [307, 'Comuna de envío: Santiago', 80]],
    [663, [22, 'Fecha de estado de cuenta: 23/09/2026', 110]],
    [626, [22, 'I. Información general', 60]],
    [613, [213, 'Cupo total', 30], [346, 'Cupo utilizado', 40], [484, 'Cupo disponible', 45]],
    [600, [22, 'Cupo total', 30], [253, '$ 1.000.000', 32], [400, '$ 224.300', 28], [542, '$ 775.700', 28]],
    [587, [22, 'Cupo avance en efectivo', 65], [253, '$ 1.000.000', 32], [435, '$ 0', 8], [542, '$ 775.700', 28]],
    [565, [152, 'Desde', 17], [248, 'Hasta', 17], [494, 'CAE prepago', 35]],
    [549, [22, 'Período facturado', 50], [117, '26/08/2026', 30], [212, '23/09/2026', 30], [505, '14,05 %', 22]],
    [533, [22, 'Pagar hasta', 32], [117, '06/10/2026', 30]],
    [502, [219, 'Rotativo', 25], [342, 'Compra en cuotas', 48], [505, 'Avance', 20]],
    [486, [22, 'Tasa de interés vigente', 65], [285, '2,5 %', 15], [423, '4,16 %', 18], [565, '4,16 %', 18]],
    [470, [22, 'CAE', 12], [276, '64,13 %', 22], [418, '61,94 %', 22], [565, '71,5 %', 18]],
    [454, [22, 'CAE se calcula sobre un supuesto de gasto mensual de 20UF y pagadero en 12 cuotas', 230]],
    [413, [22, 'II Detalle', 28]],
    [393, [22, '1. Período anterior', 55]],
    [374, [166, 'Desde', 17], [271, 'Hasta', 17]],
    [358, [22, 'Período facturación anterior', 80], [126, '28/07/2026', 30], [231, '25/08/2026', 30]],
    [327, [22, 'Saldo adeudado inicio período anterior', 105], [300, '$ 0', 8]],
    [311, [22, 'Monto facturado a pagar (período anterior)', 120], [298, '$ 50.000', 25]],
    [295, [22, 'Monto pagado período anterior', 85], [296, '$ -50.000', 27]],
    [279, [22, 'Saldo adeudado final período anterior', 105], [323, '$ 0', 8]],
    // The payment slip.
    [236, [22, 'Emisor', 20], [306, 'Cliente', 20]],
    [202, [22, 'Nombre', 20], [164, 'Número de cuenta', 48], [307, 'Nombre', 20], [449, 'Número de cuenta', 48]],
    [187, [22, HOLDER, 60], [164, 'xxxx-xxxx-xxxx-4321', 55], [307, HOLDER, 60], [449, 'xxxx-xxxx-xxxx-4321', 55]],
    [171, [22, 'Pagar hasta', 32], [164, 'Monto total facturado a pagar', 80], [307, 'Pagar hasta', 32],
      [449, 'Monto total facturado a pagar', 80]],
    [156, [22, '06/10/2026', 30], [164, '$ 34.300', 25], [307, '06/10/2026', 30], [449, '$ 34.300', 25]],
    [140, [22, 'Monto mínimo a pagar', 60], [164, 'Monto cancelado', 45], [307, 'Monto mínimo a pagar', 60],
      [449, 'Monto cancelado', 45]],
    [125, [22, '$ 34.300', 25], [307, '$ 34.300', 25]],
    FOOTER,
  ]),

  ...rows(2, [
    [709, [22, '2. Período actual', 50]],
    [698, [21.6, 'Lugar de operación', 55.7], [83.1, 'Fecha operación', 47.7], [166.7, 'Código referencia', 51],
      [249.1, 'Descripción operación o cobro', 88.4], [367.2, 'Monto operación', 48.3], [420.5, 'Monto total a pagar', 55.3],
      [512.9, 'Cargo del mes', 41.4]],
    [691, [502.5, 'N° cuota | Valor cuota', 62.1]],
    [666, [22, '1.Total operaciones', 55]],
    movement(659, '14/08/2026', '2026081411111111', 'Tienda Uno Tasa Int. 0,00%', '$ 120.000', '$ 120.000', '02/12', '$ 10.000'),
    // The place column runs out of step with the rows: never read.
    [652, [21.6, 'Santiago', 25]],
    movement(652, '28/08/2026', '2026082822222222', 'Seguro Hogar Santiago', '$ 20.000', '$ 20.000', '01/1', '$ 20.000'),
    movement(644, '28/08/2026', '2026082800000000', 'Monto Cancelado', '$ -50.000', '$ -50.000', '01/1', '$ -50.000'),
    [536, [22, '2.Productos o servicios voluntariamente', 100]],
    [521, [22, '3.Cargos, comisiones, impuestos y abonos', 110]],
    movement(514, '14/09/2026', '2026091433333333', 'Impuesto Decreto Ley 3475 Tasa 0,264 %', '$ 300', '$ 300', '01/1', '$ 300'),
    movement(506, '21/09/2026', '2026092100000000', 'Cashback Com Sep26', '$ -1.000', '$ -1.000', '01/1', '$ -1.000'),
    movement(499, '23/09/2026', '2026092300000000', 'Comision Administracion Mensual', '$ 5.000', '$ 5.000', '01/1', '$ 5.000'),
    [477, [22, '4.Informacion compras en cuotas en perio', 100]],
    [470, [21.6, 'Las Condes', 30]],
    movement(470, '12/09/2026', '2026091244444444', 'Tienda Cinco Tasa Int 0,00%', '$ 90.000', '$ 90.000', '00/3', '$ 30.000'),
    [413, [22, 'III Información de pago', 60]],
    [395, [22, 'Monto total facturado a pagar', 80], [270, '$ 34.300', 25]],
    [379, [22, 'Monto mínimo a pagar', 60], [270, '$ 34.300', 25]],
    [358, [22, 'Costo monetario prepago', 65], [263, '$ 224.300', 28]],
    [337, [22, 'Cargo automático', 45], [294, '$ 0', 8]],
    [295, [22, 'Vencimiento próximos 4 meses', 80]],
    [279, [22, 'Saldo capital cuotas Actual', 75], [136, 'Octubre', 22], [250, 'Noviembre', 30], [363, 'Diciembre', 28],
      [477, 'Enero', 16]],
    [263, [93, '$ 190.000', 28], [213, '$ 40.000', 25], [327, '$ 40.000', 25], [441, '$ 40.000', 25], [554, '$ 10.000', 25]],
    [232, [294, 'Desde', 17], [485, 'Hasta', 17]],
    [216, [22, 'Próximo período facturación', 80], [212, '24/09/2026', 30], [401, '26/10/2026', 30]],
    [162, [22, 'IV Costos por atraso', 55]],
    [144, [34, 'Interés Moratorio', 50], [113, '30 %', 12]],
    FOOTER,
  ]),
]
