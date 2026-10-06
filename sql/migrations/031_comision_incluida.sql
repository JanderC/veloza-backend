-- Comisión que ya viene sumada en lo que envió el cliente: mandó 10.600 = 10.000 + 6%.
-- La tasa guardada sigue siendo el factor por el que se multiplica lo enviado (1 / 1,06), y esta marca
-- dice cómo leerlo: recibe = enviado ÷ (1 + %) en vez de enviado − %.
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS comision_incluida boolean NOT NULL DEFAULT false;
