-- Guarda la tasa realmente usada en un cambio y si se multiplicó o dividió.
-- Nullable: las transacciones anteriores quedan con NULL.
ALTER TABLE transacciones
  ADD COLUMN IF NOT EXISTS tasa_aplicada numeric(20,8),
  ADD COLUMN IF NOT EXISTS operacion_calculo text;

ALTER TABLE transacciones
  ADD CONSTRAINT transacciones_operacion_calculo_check
  CHECK (operacion_calculo IN ('MULTIPLICACION', 'DIVISION'));
