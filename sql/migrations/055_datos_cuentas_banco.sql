-- Capital de giros: con qué se reconoce cada cuenta de banco de la empresa en un capture. Al registrar una
-- confirmación, si el origen o el destino del capture es una de estas, esa cuenta se alimenta sola.
--   CUENTA: el número de la cuenta (completo o los últimos dígitos) y el banco (0102 = Banco de Venezuela).
--   PAGO_MOVIL: cédula, banco y teléfono.
CREATE TABLE IF NOT EXISTS cajas_datos_banco (
  id serial PRIMARY KEY,
  caja_id integer NOT NULL REFERENCES cajas(id) ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('CUENTA', 'PAGO_MOVIL')),
  banco text,
  numero text,
  cedula text,
  telefono text,
  usuario_id integer REFERENCES usuarios(id),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CHECK ((tipo = 'CUENTA' AND numero IS NOT NULL) OR (tipo = 'PAGO_MOVIL' AND telefono IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS cajas_datos_banco_caja ON cajas_datos_banco (caja_id);
-- un mismo número o teléfono no puede ser de dos cuentas
CREATE UNIQUE INDEX IF NOT EXISTS cajas_datos_banco_unico ON cajas_datos_banco (tipo, COALESCE(banco, ''), COALESCE(numero, ''), COALESCE(telefono, ''));
