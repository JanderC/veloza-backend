-- Auditoría de las ediciones de un movimiento: cada vez que un administrador lo corrige queda quién, cuándo,
-- cómo estaba antes y cómo quedó (fecha, referencia, cantidad, tasa o %, monto).
CREATE TABLE IF NOT EXISTS movimientos_cc_ediciones (
  id serial PRIMARY KEY,
  movimiento_id integer NOT NULL REFERENCES movimientos_cuenta_corriente(id),
  usuario_id integer NOT NULL REFERENCES usuarios(id),
  editado_en timestamptz NOT NULL DEFAULT now(),
  antes jsonb NOT NULL,
  despues jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mov_cc_ediciones_mov ON movimientos_cc_ediciones (movimiento_id, id);
