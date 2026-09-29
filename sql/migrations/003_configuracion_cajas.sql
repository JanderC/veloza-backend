-- Configuración de cajas: caja principal, descripción, fondeo y transferencias entre cajas.
-- Ejecutar fuera de una transacción explícita: ALTER TYPE ... ADD VALUE no puede usarse
-- en la misma transacción en la que se agrega.

ALTER TYPE tipo_transaccion ADD VALUE IF NOT EXISTS 'FONDEO';

ALTER TABLE cajas ADD COLUMN IF NOT EXISTS es_principal boolean NOT NULL DEFAULT false;
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS descripcion text;
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Solo puede haber UNA caja principal (la que se alimenta y reparte a las demás)
CREATE UNIQUE INDEX IF NOT EXISTS idx_una_caja_principal ON cajas (es_principal) WHERE es_principal;

-- Nota libre en fondeos y transferencias ("Base del día", "Reposición de efectivo"...)
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS observacion text;

-- Si todavía no hay principal, la Caja Fuerte pasa a serlo (el admin la puede cambiar luego)
UPDATE cajas SET es_principal = true
WHERE id = (SELECT id FROM cajas WHERE tipo = 'FUERTE' AND activo ORDER BY id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM cajas WHERE es_principal);
