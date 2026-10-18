-- Capital de giros: lo que se va escribiendo (tasas, filas a mano) queda guardado al instante, aunque no se guarde
-- el cuadre. Es uno solo para todo el negocio: se ve igual desde cualquier computador.
CREATE TABLE IF NOT EXISTS capital_borrador (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  datos jsonb NOT NULL,
  usuario_id integer REFERENCES usuarios(id),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
