-- Taquilla 2: otra taquilla que trabaja igual que la primera pero con su propia caja, su sesión y sus movimientos.
-- Cada caja de taquilla lleva su número; la que ya existía pasa a ser la 1.
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS taquilla_numero smallint;
UPDATE cajas SET taquilla_numero = 1 WHERE es_taquilla AND taquilla_numero IS NULL AND NOT EXISTS (SELECT 1 FROM cajas WHERE taquilla_numero = 1);
UPDATE cajas SET nombre = 'Taquilla 1' WHERE taquilla_numero = 1 AND nombre = 'Taquilla';
CREATE UNIQUE INDEX IF NOT EXISTS cajas_taquilla_numero_uq ON cajas (taquilla_numero) WHERE taquilla_numero IS NOT NULL;

INSERT INTO cajas (nombre, tipo, descripcion, es_taquilla, taquilla_numero)
SELECT 'Taquilla 2', 'FISICA', 'Caja del módulo Taquilla 2: efectivo en pesos, dólares y euros', true, 2
WHERE NOT EXISTS (SELECT 1 FROM cajas WHERE taquilla_numero = 2);

INSERT INTO saldos_caja (caja_id, moneda_id, monto)
SELECT c.id, m.id, 0
FROM cajas c CROSS JOIN monedas m
WHERE c.taquilla_numero = 2 AND m.codigo IN ('COP', 'USD', 'EUR')
  AND NOT EXISTS (SELECT 1 FROM saldos_caja x WHERE x.caja_id = c.id AND x.moneda_id = m.id);

-- Los ingresos/egresos de ventanilla y los pagos de solicitudes quedan con la taquilla que los hizo
ALTER TABLE operaciones_taquilla ADD COLUMN IF NOT EXISTS caja_id integer REFERENCES cajas(id);
UPDATE operaciones_taquilla SET caja_id = (SELECT id FROM cajas WHERE taquilla_numero = 1) WHERE caja_id IS NULL;
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS pagado_caja_id integer REFERENCES cajas(id);
UPDATE movimientos_cuenta_corriente SET pagado_caja_id = (SELECT id FROM cajas WHERE taquilla_numero = 1) WHERE pagado_en IS NOT NULL AND pagado_caja_id IS NULL;
