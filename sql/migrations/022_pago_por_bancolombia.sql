-- Cómo se le pagó la solicitud al cliente: en efectivo (descuenta de la caja de taquilla)
-- o por transferencia de Bancolombia (no toca la caja).
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS pagado_medio text;
ALTER TABLE movimientos_cuenta_corriente DROP CONSTRAINT IF EXISTS movimientos_cc_pagado_medio_check;
ALTER TABLE movimientos_cuenta_corriente ADD CONSTRAINT movimientos_cc_pagado_medio_check CHECK (pagado_medio IN ('EFECTIVO', 'BANCOLOMBIA'));
UPDATE movimientos_cuenta_corriente SET pagado_medio = 'EFECTIVO' WHERE pagado_en IS NOT NULL AND pagado_medio IS NULL;
