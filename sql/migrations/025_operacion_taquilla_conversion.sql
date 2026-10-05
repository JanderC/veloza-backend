-- Conversiones en taquilla: el cliente trae una moneda y se lleva otra (ej. trae 100.000 pesos y quiere bolívares).
-- cantidad + moneda_operacion = lo que trae o se negocia; resultado + moneda_resultado = lo que sale de la cuenta.
-- total + moneda_id sigue siendo lo que mueve la caja: el monto o el resultado, según cuál sea efectivo de la caja.
ALTER TABLE operaciones_taquilla ADD COLUMN IF NOT EXISTS resultado numeric(20,4);
ALTER TABLE operaciones_taquilla ADD COLUMN IF NOT EXISTS moneda_resultado text;
ALTER TABLE operaciones_taquilla ADD COLUMN IF NOT EXISTS caja_lado text NOT NULL DEFAULT 'RESULTADO';
ALTER TABLE operaciones_taquilla DROP CONSTRAINT IF EXISTS operaciones_taquilla_caja_lado_check;
ALTER TABLE operaciones_taquilla ADD CONSTRAINT operaciones_taquilla_caja_lado_check CHECK (caja_lado IN ('MONTO', 'RESULTADO'));
