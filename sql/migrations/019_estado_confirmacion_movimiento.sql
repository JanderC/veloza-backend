-- Western Union tarda en verificar: el movimiento se registra "en proceso de confirmación"
-- y se marca como confirmado cuando Western lo libera. NULL = el movimiento no lleva confirmación.
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS estado_confirmacion text;
ALTER TABLE movimientos_cuenta_corriente DROP CONSTRAINT IF EXISTS movimientos_cc_estado_confirmacion_check;
ALTER TABLE movimientos_cuenta_corriente ADD CONSTRAINT movimientos_cc_estado_confirmacion_check CHECK (estado_confirmacion IN ('EN_PROCESO', 'CONFIRMADA'));
