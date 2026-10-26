-- Gastos administrativos: todo egreso del negocio que no es una operación con clientes (gastos de oficina, nómina,
-- bonos, pagos a entes, pagos por Bancolombia o en bolívares, el sueldo del dueño...). Igual que la hoja de Excel:
-- cada gasto con su monto en pesos y/o en dólares; lo que no tiene fecha de pago está pendiente.
CREATE TABLE IF NOT EXISTS gastos (
  id serial PRIMARY KEY,
  periodo text NOT NULL CHECK (periodo ~ '^\d{4}-\d{2}$'), -- el mes al que pertenece (2026-09)
  categoria text NOT NULL,
  descripcion text NOT NULL,
  monto_cop numeric(20, 4) NOT NULL DEFAULT 0 CHECK (monto_cop >= 0),
  monto_usd numeric(20, 4) NOT NULL DEFAULT 0 CHECK (monto_usd >= 0),
  estado text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'PAGADO')),
  fecha date, -- cuándo se pagó
  fecha_programada date, -- cuándo toca (los pagos semanales)
  caja_id integer REFERENCES cajas(id), -- de dónde salió la plata (null: no movió ninguna caja del sistema)
  movimientos_caja integer[] NOT NULL DEFAULT '{}',
  plantilla_id integer,
  nota text,
  usuario_id integer REFERENCES usuarios(id),
  pagado_por integer REFERENCES usuarios(id),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CHECK (monto_cop > 0 OR monto_usd > 0)
);
CREATE INDEX IF NOT EXISTS gastos_periodo ON gastos (periodo, categoria);

-- Lo que se repite: la nómina de cada mes y los pagos de cada semana (a qué día)
CREATE TABLE IF NOT EXISTS gastos_plantillas (
  id serial PRIMARY KEY,
  categoria text NOT NULL,
  descripcion text NOT NULL,
  monto_cop numeric(20, 4) NOT NULL DEFAULT 0,
  monto_usd numeric(20, 4) NOT NULL DEFAULT 0,
  frecuencia text NOT NULL CHECK (frecuencia IN ('MENSUAL', 'SEMANAL')),
  dia_semana integer CHECK (dia_semana BETWEEN 0 AND 6), -- SEMANAL: 0 domingo ... 6 sábado
  orden integer NOT NULL DEFAULT 0,
  activo boolean NOT NULL DEFAULT true
);
