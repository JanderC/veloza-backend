-- Ingresos y egresos de la caja de taquilla que no vienen de una solicitud: una compra o venta hecha en la ventanilla.
-- total = cantidad x tasa, menos la comisión; es lo que entra o sale de la caja, en pesos, dólares o euros.
-- Un ingreso puede quedar PENDIENTE: suma a la caja recién cuando se confirma.
CREATE TABLE IF NOT EXISTS operaciones_taquilla (
  id serial PRIMARY KEY,
  tipo text NOT NULL CHECK (tipo IN ('INGRESO', 'EGRESO')),
  moneda_id integer NOT NULL REFERENCES monedas(id),
  cantidad numeric(20,4) NOT NULL CHECK (cantidad > 0),
  tasa numeric(20,8),
  comision_pct numeric(9,4),
  total numeric(20,4) NOT NULL CHECK (total > 0),
  descripcion text,
  cliente_nombre text,
  cliente_telefono text,
  cliente_cedula text,
  estado text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'CONFIRMADA', 'ANULADA')),
  usuario_id integer NOT NULL REFERENCES usuarios(id),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  confirmado_en timestamp with time zone,
  confirmado_por integer REFERENCES usuarios(id)
);
