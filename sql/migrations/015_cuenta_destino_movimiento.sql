-- A qué cuenta del cliente se le pagó en este movimiento (opcional): hay clientes con varias cuentas
-- y en el reporte tiene que verse a cuál fue.
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS cuenta_destino text;
