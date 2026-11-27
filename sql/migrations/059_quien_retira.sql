-- Quién retiró el efectivo en taquilla cuando no fue el mismo cliente (vacío = lo retiró el cliente)
ALTER TABLE movimientos_cuenta_corriente
  ADD COLUMN IF NOT EXISTS retira_nombre   text,
  ADD COLUMN IF NOT EXISTS retira_cedula   text,
  ADD COLUMN IF NOT EXISTS retira_telefono text;
