-- Captura / comprobante del pago de una operación (se revisa en la Bandeja de Solicitudes).
-- No cuenta para la verificación de identidad del cliente.
ALTER TABLE documentos_tercero DROP CONSTRAINT IF EXISTS documentos_tercero_tipo_check;
ALTER TABLE documentos_tercero ADD CONSTRAINT documentos_tercero_tipo_check
  CHECK (tipo IN ('CEDULA', 'RIF', 'PASAPORTE', 'COMPROBANTE_DOMICILIO', 'ORIGEN_FONDOS', 'COMPROBANTE_PAGO', 'OTRO'));

CREATE INDEX IF NOT EXISTS idx_documentos_tercero_transaccion ON documentos_tercero (transaccion_id);

-- Auditoría de la confirmación: qué verificó quien aprobó (monto en banco, checklist, nota)
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS verificacion jsonb;
