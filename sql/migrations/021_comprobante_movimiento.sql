-- La imagen del comprobante queda guardada con el movimiento (se ve en la hoja del cliente y en Taquilla).
-- comprobante_key es el identificador del archivo en el almacenamiento privado.
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS comprobante_key text;
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS comprobante_mime text;
