-- Cuentas por Pagar: lo que se le debe a cada cliente, llevado igual que una cuenta corriente, y que cuando se quiera
-- se envía a las taquillas para pagárselo. Es un módulo más de las cuentas (el cliente es el mismo en todos).
ALTER TABLE cuentas_corrientes DROP CONSTRAINT IF EXISTS cuentas_corrientes_modulo_check;
ALTER TABLE cuentas_corrientes ADD CONSTRAINT cuentas_corrientes_modulo_check CHECK (modulo IN ('CORRIENTE', 'POR_COBRAR', 'POR_PAGAR', 'CAJA'));
