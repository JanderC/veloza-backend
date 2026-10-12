-- Cuentas corrientes: un administrador puede corregir un movimiento mal cargado. Queda anotado quién y cuándo lo editó.
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS editado_en timestamp with time zone;
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS editado_por integer REFERENCES usuarios(id);
