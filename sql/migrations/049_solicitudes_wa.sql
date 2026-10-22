-- Atención de Solicitudes: lo que piden los clientes por WhatsApp (chats individuales), clasificado solo
-- (tasa, cuenta, comprobante, datos para pagar, confirmar, retiro, compra), para atenderlo y no dejar a nadie esperando.
CREATE TABLE IF NOT EXISTS solicitudes_wa (
  id serial PRIMARY KEY,
  jid text NOT NULL,
  linea integer NOT NULL DEFAULT 1,
  tipo text NOT NULL CHECK (tipo IN ('TASA', 'CUENTA', 'COMPROBANTE', 'PAGO', 'CONFIRMAR', 'RETIRO', 'COMPRA')),
  texto text,
  datos jsonb NOT NULL DEFAULT '{}'::jsonb,
  mensaje_id bigint,
  mensajes integer NOT NULL DEFAULT 1,
  estado text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'ATENDIDA', 'DESCARTADA')),
  atendida_por integer REFERENCES usuarios(id),
  atendida_en timestamp with time zone,
  nota text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS solicitudes_wa_pendientes ON solicitudes_wa (estado, created_at);
CREATE INDEX IF NOT EXISTS solicitudes_wa_jid ON solicitudes_wa (jid, estado);
