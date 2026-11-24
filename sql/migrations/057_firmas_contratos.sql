-- Contratos de comisión y sus firmas.
--   firmas: la firma de un cliente, de un titular de cuenta (quien recibe el dinero) o de la empresa. Se guarda la
--     imagen (PNG). La última vigente de cada uno es la que va en los contratos nuevos.
--   firma_links: el link que se le manda a un cliente o a un titular para que firme desde su teléfono. Sirve una sola
--     vez y vence.
--   contratos: cada contrato generado, con sus datos (partes y finiquito) y las firmas que llevó, para verlo y
--     volver a descargarlo.
CREATE TABLE IF NOT EXISTS firmas (
  id serial PRIMARY KEY,
  tipo text NOT NULL CHECK (tipo IN ('CLIENTE', 'TITULAR', 'EMPRESA')),
  tercero_id integer REFERENCES terceros(id) ON DELETE SET NULL, -- el cliente (en un titular: el cliente que lo trajo)
  nombre text NOT NULL,
  cedula text,
  numero_cuenta text, -- titular: la cuenta donde recibe
  banco text,
  imagen text NOT NULL, -- data:image/png;base64,...
  origen text NOT NULL DEFAULT 'PANEL' CHECK (origen IN ('LINK', 'PANEL')),
  activa boolean NOT NULL DEFAULT true,
  usuario_id integer REFERENCES usuarios(id),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS firmas_tercero ON firmas (tercero_id, tipo, created_at DESC);
CREATE INDEX IF NOT EXISTS firmas_cedula ON firmas (tipo, cedula);

CREATE TABLE IF NOT EXISTS firma_links (
  id serial PRIMARY KEY,
  token text NOT NULL UNIQUE,
  tipo text NOT NULL CHECK (tipo IN ('CLIENTE', 'TITULAR')),
  tercero_id integer REFERENCES terceros(id) ON DELETE CASCADE,
  nombre text,
  cedula text,
  numero_cuenta text,
  banco text,
  firma_id integer REFERENCES firmas(id) ON DELETE SET NULL,
  expira_en timestamp with time zone NOT NULL,
  firmado_en timestamp with time zone,
  usuario_id integer REFERENCES usuarios(id),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS firma_links_tercero ON firma_links (tercero_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contratos (
  id serial PRIMARY KEY,
  numero text,
  tercero_id integer REFERENCES terceros(id) ON DELETE SET NULL,
  cliente_nombre text NOT NULL,
  titular_nombre text,
  datos jsonb NOT NULL,
  firma_cliente_id integer REFERENCES firmas(id) ON DELETE SET NULL,
  firma_titular_id integer REFERENCES firmas(id) ON DELETE SET NULL,
  firma_empresa_id integer REFERENCES firmas(id) ON DELETE SET NULL,
  usuario_id integer REFERENCES usuarios(id),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contratos_tercero ON contratos (tercero_id, created_at DESC);
