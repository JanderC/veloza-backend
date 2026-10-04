-- Cierre diario de una cuenta corriente: cada día se cuadra con la persona y se le manda el reporte.
-- Se guarda con qué saldo se cerró el día; si después entra otro movimiento de ese día, se puede volver a cerrar.
CREATE TABLE IF NOT EXISTS cierres_cuenta_corriente (
  id serial PRIMARY KEY,
  cuenta_corriente_id integer NOT NULL REFERENCES cuentas_corrientes(id),
  dia date NOT NULL,
  saldo_final numeric(20,4) NOT NULL,
  usuario_id integer NOT NULL REFERENCES usuarios(id),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (cuenta_corriente_id, dia)
);
