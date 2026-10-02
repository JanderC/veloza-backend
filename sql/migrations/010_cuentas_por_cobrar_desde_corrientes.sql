-- Cuentas por Cobrar se alimenta de las cuentas corrientes. Una cuenta de poco movimiento
-- (debe y abona a los días) se pasa a POR_COBRAR: sale de la lista de Cuentas Corrientes
-- y se sigue llevando igual (misma hoja, mismos movimientos) desde Cuentas por Cobrar.
ALTER TABLE cuentas_corrientes ADD COLUMN IF NOT EXISTS modulo text NOT NULL DEFAULT 'CORRIENTE';
ALTER TABLE cuentas_corrientes DROP CONSTRAINT IF EXISTS cuentas_corrientes_modulo_check;
ALTER TABLE cuentas_corrientes ADD CONSTRAINT cuentas_corrientes_modulo_check CHECK (modulo IN ('CORRIENTE', 'POR_COBRAR'));
