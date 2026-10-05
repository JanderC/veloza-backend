-- Módulo Taquilla: las solicitudes confirmadas en Confirmaciones llegan acá para pagarse en efectivo.
-- Tiene su propia caja (pesos, dólares y euros) y cada solicitud se marca "se pagó", que descuenta de esa caja.
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS es_taquilla boolean NOT NULL DEFAULT false;
INSERT INTO cajas (nombre, tipo, descripcion, es_taquilla)
SELECT 'Taquilla', 'FISICA', 'Caja del módulo Taquilla: efectivo en pesos, dólares y euros', true
WHERE NOT EXISTS (SELECT 1 FROM cajas WHERE es_taquilla) AND NOT EXISTS (SELECT 1 FROM cajas WHERE nombre = 'Taquilla');
UPDATE cajas SET es_taquilla = true WHERE nombre = 'Taquilla' AND NOT EXISTS (SELECT 1 FROM cajas WHERE es_taquilla);

-- Cuándo y quién pagó la solicitud, y con qué movimiento quedó saldada la cuenta del cliente
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS pagado_en timestamp with time zone;
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS pagado_por integer REFERENCES usuarios(id);
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS pagado_movimiento_id integer REFERENCES movimientos_cuenta_corriente(id);
