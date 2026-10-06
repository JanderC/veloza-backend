-- La imagen del comprobante también se guarda con los ingresos y egresos de taquilla.
ALTER TABLE operaciones_taquilla ADD COLUMN IF NOT EXISTS comprobante_key text;
ALTER TABLE operaciones_taquilla ADD COLUMN IF NOT EXISTS comprobante_mime text;
