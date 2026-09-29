-- Cuentas de la empresa (Nequi, Bancolombia, Mercantil...) = cajas tipo BANCO con sus
-- datos bancarios. El saldo sigue viviendo en saldos_caja: una sola fuente de verdad.
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS banco text;
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS numero_cuenta text;
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS tipo_cuenta text;
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS titular text;
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS identificacion_titular text;
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS telefono text;
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS pais text;
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS moneda_id integer REFERENCES monedas(id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cajas_tipo_cuenta_check') THEN
    ALTER TABLE cajas ADD CONSTRAINT cajas_tipo_cuenta_check
      CHECK (tipo_cuenta IS NULL OR tipo_cuenta IN ('AHORRO', 'CORRIENTE', 'BILLETERA'));
  END IF;
END $$;

-- Método de pago: solo el nombre, con vínculo OPCIONAL a una cuenta de la empresa
ALTER TABLE metodos_pago ADD COLUMN IF NOT EXISTS cuenta_id integer REFERENCES cajas(id);
ALTER TABLE metodos_pago ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_metodos_pago_cuenta ON metodos_pago (cuenta_id);
