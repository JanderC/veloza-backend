-- La tasa que queda puesta en el formulario de la cuenta al cargar un movimiento.
-- Si es NULL se usa la última tasa con la que se registró un movimiento en esa cuenta.
ALTER TABLE cuentas_corrientes ADD COLUMN IF NOT EXISTS tasa_habitual numeric(20,8);
