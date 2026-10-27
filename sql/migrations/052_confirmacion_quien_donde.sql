-- Quién confirmó una transferencia que estaba en proceso (Western, Zelle…), cuándo y en qué caja (la taquilla donde se
-- confirmó). Así cada taquilla ve en su historial las transferencias que confirmó.
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS confirmado_en timestamptz;
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS confirmado_por integer REFERENCES usuarios(id);
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS confirmado_caja_id integer REFERENCES cajas(id);
CREATE INDEX IF NOT EXISTS idx_mov_cc_confirmado_caja ON movimientos_cuenta_corriente (confirmado_caja_id, confirmado_en) WHERE confirmado_caja_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mov_cc_pagado_caja ON movimientos_cuenta_corriente (pagado_caja_id, pagado_en) WHERE pagado_caja_id IS NOT NULL;
