-- La sincronización de correo (alertas del banco por IMAP) se eliminó: los
-- movimientos entran solo con los estados de cuenta que sube el usuario. Sólo
-- escritorio, como la migración que creó la tabla. Debe ordenar antes que
-- cualquier migración de finanzas del mismo release: el motor web ignora una
-- migración de escritorio más antigua que su última, pero rechaza una más nueva.
DROP TABLE IF EXISTS mail_accounts;
