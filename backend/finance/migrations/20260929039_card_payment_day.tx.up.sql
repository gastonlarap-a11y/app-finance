-- Día del mes en que se paga el estado de cuenta de una tarjeta («pagar hasta»).
-- La vista de cuentas descuenta las compras de la tarjeta de la cuenta que la
-- paga en el mes en que se paga su estado, no en el que cierra. NULL = el mes
-- siguiente al cierre (lo habitual); la fecha de pago de un estado importado
-- siempre manda.
ALTER TABLE cards ADD COLUMN payment_day INTEGER CHECK (payment_day BETWEEN 1 AND 31);
