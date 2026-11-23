-- Libro contable de las cuentas de banco de la empresa y estados de cuenta cargados (PDF del banco o MD).
--   movimientos_caja.referencia: la referencia del banco o del capture de lo que entró o salió (no se repite en la
--     misma cuenta para dos clientes).
--   movimientos_caja.fecha_banco: el día que dice el estado de cuenta (lo cargado desde un estado de cuenta).
--   movimientos_caja.de_extracto: lo anotó un estado de cuenta (al anular una confirmación enlazada no se devuelve:
--     esa plata se movió de verdad en el banco).
ALTER TABLE movimientos_caja ADD COLUMN IF NOT EXISTS referencia text;
ALTER TABLE movimientos_caja ADD COLUMN IF NOT EXISTS fecha_banco date;
ALTER TABLE movimientos_caja ADD COLUMN IF NOT EXISTS de_extracto boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS movimientos_caja_caja_referencia ON movimientos_caja (caja_id, referencia) WHERE referencia IS NOT NULL;

-- Cada estado de cuenta cargado
CREATE TABLE IF NOT EXISTS banco_extractos (
  id serial PRIMARY KEY,
  caja_id integer NOT NULL REFERENCES cajas(id) ON DELETE CASCADE,
  cuenta text,              -- como lo dice el estado de cuenta: 0102****8515
  desde date,
  hasta date,
  saldo_inicial numeric(20,4),
  saldo_final numeric(20,4),
  archivo text,
  usuario_id integer REFERENCES usuarios(id),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Cada renglón del estado de cuenta. movimiento_caja_id: con qué movimiento del libro se concilió.
CREATE TABLE IF NOT EXISTS banco_extracto_lineas (
  id serial PRIMARY KEY,
  extracto_id integer NOT NULL REFERENCES banco_extractos(id) ON DELETE CASCADE,
  caja_id integer NOT NULL REFERENCES cajas(id) ON DELETE CASCADE,
  referencia text NOT NULL,
  fecha date NOT NULL,
  descripcion text,
  tipo text NOT NULL CHECK (tipo IN ('NC', 'ND')),
  monto numeric(20,4) NOT NULL CHECK (monto > 0),
  saldo numeric(20,4),
  movimiento_caja_id integer REFERENCES movimientos_caja(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- el mismo renglón no entra dos veces aunque se cargue dos veces el mismo estado de cuenta
CREATE UNIQUE INDEX IF NOT EXISTS banco_extracto_lineas_unica ON banco_extracto_lineas (caja_id, referencia, fecha, tipo, monto);
CREATE INDEX IF NOT EXISTS banco_extracto_lineas_caja_fecha ON banco_extracto_lineas (caja_id, fecha);
CREATE UNIQUE INDEX IF NOT EXISTS banco_extracto_lineas_mov ON banco_extracto_lineas (movimiento_caja_id) WHERE movimiento_caja_id IS NOT NULL;
