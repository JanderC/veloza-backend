-- Cuentas corrientes: en un mismo día se pueden hacer varios cierres con el cliente (uno al mediodía, otro a la tarde).
-- cierres_cuenta_corriente sigue guardando el último de cada día; acá queda cada cierre que se hizo, con su hora y su
-- saldo, para poder compartir el reporte de solo lo que entró desde el cierre anterior.
CREATE TABLE IF NOT EXISTS cierres_cuenta_corriente_tramos (
  id serial PRIMARY KEY,
  cuenta_corriente_id integer NOT NULL REFERENCES cuentas_corrientes(id),
  dia date NOT NULL,
  saldo_final numeric(20,4) NOT NULL,
  usuario_id integer NOT NULL REFERENCES usuarios(id),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cierres_cc_tramos_cuenta_dia ON cierres_cuenta_corriente_tramos (cuenta_corriente_id, dia, created_at);

-- Los cierres que ya había pasan como el único cierre de su día (solo la primera vez)
INSERT INTO cierres_cuenta_corriente_tramos (cuenta_corriente_id, dia, saldo_final, usuario_id, created_at)
SELECT c.cuenta_corriente_id, c.dia, c.saldo_final, c.usuario_id, c.created_at
FROM cierres_cuenta_corriente c
WHERE NOT EXISTS (SELECT 1 FROM cierres_cuenta_corriente_tramos);
