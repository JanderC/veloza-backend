-- Cuentas por Cobrar desde cero: clientes propios del módulo, agrupados como en el Excel
-- ("Cuentas por Cobrar Cerveloza", "Cuentas por Cobrar Zelle", "Cuentas por Cobrar Préstamos").
-- El grupo es texto libre: se pueden crear más desde la pantalla.
ALTER TABLE cuentas_corrientes ADD COLUMN IF NOT EXISTS grupo_cobro text;
