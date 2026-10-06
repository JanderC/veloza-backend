-- Taquilla: pago por "otros métodos". Igual que por Bancolombia: queda registrado y contado, pero no descuenta de la caja.
ALTER TABLE movimientos_cuenta_corriente DROP CONSTRAINT IF EXISTS movimientos_cc_pagado_medio_check;
ALTER TABLE movimientos_cuenta_corriente ADD CONSTRAINT movimientos_cc_pagado_medio_check CHECK (pagado_medio IN ('EFECTIVO', 'BANCOLOMBIA', 'OTROS'));
ALTER TABLE operaciones_taquilla DROP CONSTRAINT IF EXISTS operaciones_taquilla_medio_check;
ALTER TABLE operaciones_taquilla ADD CONSTRAINT operaciones_taquilla_medio_check CHECK (medio IN ('EFECTIVO', 'BANCOLOMBIA', 'OTROS'));
