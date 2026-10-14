-- Confirmaciones: una confirmación puede armarse con varias transferencias del cliente. Cada una queda guardada con su
-- referencia, quién la envió, su monto, su fórmula (tasa, dividir o comisión) y su captura. El movimiento sigue siendo
-- uno solo (el total): saldos, taquilla y cierres no cambian.
CREATE TABLE IF NOT EXISTS movimiento_transferencias (
  id serial PRIMARY KEY,
  movimiento_id integer NOT NULL REFERENCES movimientos_cuenta_corriente(id) ON DELETE CASCADE,
  orden integer NOT NULL,
  referencia text,
  remitente text,
  cantidad numeric(20,8) NOT NULL,
  formula text NOT NULL CHECK (formula IN ('TASA', 'DIVIDIR', 'COMISION', 'DIRECTO')),
  valor numeric(20,8), -- la tasa, o el % de comisión
  resultado numeric(20,4) NOT NULL, -- lo que esa transferencia suma al movimiento, en la moneda de la cuenta
  comprobante_key text,
  comprobante_mime text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS movimiento_transferencias_mov ON movimiento_transferencias (movimiento_id, orden);
