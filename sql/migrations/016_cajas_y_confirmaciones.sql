-- Módulo Cajas y Confirmaciones: cuentas que se llevan igual que las corrientes pero en su propia lista
-- (modulo = 'CAJA'), creadas con el cliente que llega: nombre, teléfono y una referencia.
ALTER TABLE cuentas_corrientes DROP CONSTRAINT IF EXISTS cuentas_corrientes_modulo_check;
ALTER TABLE cuentas_corrientes ADD CONSTRAINT cuentas_corrientes_modulo_check CHECK (modulo IN ('CORRIENTE', 'POR_COBRAR', 'CAJA'));
ALTER TABLE cuentas_corrientes ADD COLUMN IF NOT EXISTS referencia text;
