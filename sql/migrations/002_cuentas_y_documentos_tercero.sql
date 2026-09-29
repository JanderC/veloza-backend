-- Cuentas a donde se le paga al cliente (banco, pago móvil, Zelle, Nequi...)
CREATE TABLE IF NOT EXISTS cuentas_tercero (
  id SERIAL PRIMARY KEY,
  tercero_id integer NOT NULL REFERENCES terceros(id),
  moneda_id integer REFERENCES monedas(id),
  tipo text NOT NULL CHECK (tipo IN ('CUENTA_BANCARIA', 'PAGO_MOVIL', 'ZELLE', 'NEQUI', 'DAVIPLATA', 'OTRO')),
  banco text,
  numero_cuenta text,
  tipo_cuenta text CHECK (tipo_cuenta IN ('AHORRO', 'CORRIENTE')),
  titular text NOT NULL,
  identificacion_titular text,
  telefono text,
  email text,
  alias text,
  activo boolean NOT NULL DEFAULT true,
  creado_por_id integer NOT NULL REFERENCES usuarios(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cuentas_tercero_tercero ON cuentas_tercero (tercero_id);

-- Documentos del cliente (cédula, RIF, soportes). El archivo vive en R2;
-- aquí solo la ruta (archivo_key). Nunca se borran: se aprueban o rechazan.
CREATE TABLE IF NOT EXISTS documentos_tercero (
  id SERIAL PRIMARY KEY,
  tercero_id integer NOT NULL REFERENCES terceros(id),
  transaccion_id integer REFERENCES transacciones(id),
  tipo text NOT NULL CHECK (tipo IN ('CEDULA', 'RIF', 'PASAPORTE', 'COMPROBANTE_DOMICILIO', 'ORIGEN_FONDOS', 'OTRO')),
  descripcion text,
  archivo_key text NOT NULL UNIQUE,
  nombre_original text NOT NULL,
  mime_type text NOT NULL,
  tamano_bytes integer NOT NULL,
  fecha_vencimiento date,
  estado text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'APROBADO', 'RECHAZADO')),
  motivo_rechazo text,
  revisado_por_id integer REFERENCES usuarios(id),
  revisado_en timestamptz,
  subido_por_id integer NOT NULL REFERENCES usuarios(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documentos_tercero_tercero ON documentos_tercero (tercero_id);

-- A qué cuenta del cliente se le pagó en un cambio
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS cuenta_tercero_id integer REFERENCES cuentas_tercero(id);
