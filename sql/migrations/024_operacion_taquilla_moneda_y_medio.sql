-- Ingresos y egresos de taquilla: qué moneda se compró o vendió (bolívares, dólares...), si la cuenta es dividiendo,
-- y por dónde se movió: en efectivo (mueve la caja) o por transferencia de Bancolombia (no la toca).
ALTER TABLE operaciones_taquilla ADD COLUMN IF NOT EXISTS moneda_operacion text;
ALTER TABLE operaciones_taquilla ADD COLUMN IF NOT EXISTS divide boolean NOT NULL DEFAULT false;
ALTER TABLE operaciones_taquilla ADD COLUMN IF NOT EXISTS medio text NOT NULL DEFAULT 'EFECTIVO';
ALTER TABLE operaciones_taquilla DROP CONSTRAINT IF EXISTS operaciones_taquilla_medio_check;
ALTER TABLE operaciones_taquilla ADD CONSTRAINT operaciones_taquilla_medio_check CHECK (medio IN ('EFECTIVO', 'BANCOLOMBIA'));
