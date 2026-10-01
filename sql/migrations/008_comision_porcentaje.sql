-- Comisiones en porcentaje: la tasa se guarda como fracción (3% = 0.03) y esta marca
-- hace que la hoja y el Excel la muestren como "3%" en vez de "0,03".
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS tasa_es_porcentaje boolean NOT NULL DEFAULT false;
