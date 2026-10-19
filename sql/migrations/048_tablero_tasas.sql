-- La "Tasa del día" como la publica el negocio: dólar (compra por billete y venta), euro, bolívares, Zelle, Western y
-- USDT. Cada vez que se actualiza queda una versión nueva (con su hora y quién): la última es la vigente, y contra la
-- anterior se ve si cada tasa subió o bajó. Estas tasas son las que se proponen en taquilla, Confirmaciones y cuentas.
CREATE TABLE IF NOT EXISTS tablero_tasas (
  id serial PRIMARY KEY,
  valores jsonb NOT NULL,
  usuario_id integer REFERENCES usuarios(id),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tablero_tasas_reciente ON tablero_tasas (created_at DESC);
