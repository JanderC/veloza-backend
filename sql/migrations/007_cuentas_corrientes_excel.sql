-- Cuentas corrientes como el Excel (fecha, referencia, cantidad x tasa = monto, total corrido).
-- Los movimientos nunca se borran ni se editan: un error se corrige con un reverso.

-- El reverso apunta al movimiento que anula; los dos quedan marcados como anulados
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS reverso_de_id integer REFERENCES movimientos_cuenta_corriente(id);
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS anulado boolean NOT NULL DEFAULT false;

-- Si el movimiento también movió una caja o banco, cuál fue (para poder revertirlo junto)
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS movimiento_caja_id integer REFERENCES movimientos_caja(id);
