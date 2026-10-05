-- La fórmula con la que se le trabaja a cada cliente, guardada con su primer movimiento:
--   TASA:     cantidad × tasa = total (la tasa queda en tasa_habitual)
--   COMISION: al monto se le descuenta la comisión, ej. 1.000 - 4% = 960 (el % queda en comision_pct)
ALTER TABLE cuentas_corrientes ADD COLUMN IF NOT EXISTS formula text;
ALTER TABLE cuentas_corrientes DROP CONSTRAINT IF EXISTS cuentas_corrientes_formula_check;
ALTER TABLE cuentas_corrientes ADD CONSTRAINT cuentas_corrientes_formula_check CHECK (formula IN ('TASA', 'COMISION'));
ALTER TABLE cuentas_corrientes ADD COLUMN IF NOT EXISTS comision_pct numeric(9,4);

-- Movimiento con comisión descontada: la "tasa" guardada es el factor (4% -> 0.96) y se muestra como -4%.
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS comision_descontada boolean NOT NULL DEFAULT false;
