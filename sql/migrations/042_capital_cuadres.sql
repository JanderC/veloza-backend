-- Capital de giros: el cuadre de todo el negocio (lo que nos deben, lo que debemos, bolívares, pesos y dólares), como la
-- hoja de Excel. Lo hace el administrador cuando quiera; cada cuadre queda guardado con su fecha y quién lo hizo.
CREATE TABLE IF NOT EXISTS capital_cuadres (
  id serial PRIMARY KEY,
  usuario_id integer NOT NULL REFERENCES usuarios(id),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  -- todo lo de ese cuadre: lo que se llenó a mano y lo que el sistema traía en ese momento
  datos jsonb NOT NULL,
  -- los totales, para la lista de cuadres anteriores
  capital_cop numeric(20,2) NOT NULL,
  capital_divisa numeric(20,2) NOT NULL,
  capital_divisa_cop numeric(20,2) NOT NULL,
  nota text
);
CREATE INDEX IF NOT EXISTS capital_cuadres_fecha ON capital_cuadres (created_at DESC);
