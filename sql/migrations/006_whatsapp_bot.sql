-- WhatsApp: sesión de Baileys en la base (Railway borra el disco en cada deploy),
-- chats y mensajes para el panel, configuración de la IA, outbox de envíos salientes
-- y lo que el bot necesita en transacciones (origen, chat y vencimiento de la tasa).

-- Sesión de Baileys: una fila por archivo que useMultiFileAuthState escribiría en disco
CREATE TABLE IF NOT EXISTS wa_sesion (
  clave text PRIMARY KEY,
  datos text NOT NULL,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

-- Un chat por número. jid canónico: <numero>@s.whatsapp.net (nunca @lid)
CREATE TABLE IF NOT EXISTS wa_chats (
  jid text PRIMARY KEY,
  telefono text NOT NULL,
  nombre text,                 -- el pushName que manda WhatsApp
  nombre_guardado text,        -- el que le pone una persona en el panel
  tercero_id integer REFERENCES terceros(id),
  ultimo_mensaje text,
  ultimo_mensaje_en timestamptz,
  ultimo_entrante_en timestamptz, -- NULL = contacto "frío": nunca le escribió al negocio
  no_leidos integer NOT NULL DEFAULT 0,
  bot_activo boolean NOT NULL DEFAULT true,
  necesita_humano boolean NOT NULL DEFAULT false,
  motivo text,
  necesita_humano_desde timestamptz,
  estado jsonb NOT NULL DEFAULT '{}'::jsonb, -- estado de la conversación (cotización vigente, solicitud...)
  archivado boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_chats_ultimo ON wa_chats (ultimo_mensaje_en DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_wa_chats_tercero ON wa_chats (tercero_id);

CREATE TABLE IF NOT EXISTS wa_mensajes (
  id bigserial PRIMARY KEY,
  jid text NOT NULL REFERENCES wa_chats(jid),
  wa_id text UNIQUE,
  wa_key jsonb,
  de_mi boolean NOT NULL,
  autor text NOT NULL CHECK (autor IN ('cliente', 'bot', 'humano', 'telefono', 'sistema')),
  tipo text NOT NULL CHECK (tipo IN ('texto', 'imagen', 'audio', 'documento', 'sticker', 'video')),
  texto text,
  media_key text,  -- ruta en Cloudinary (privado); la URL se firma al leer. Nunca base64 acá.
  media_mime text,
  media_bytes integer,
  estado text NOT NULL DEFAULT 'enviado' CHECK (estado IN ('pendiente', 'enviado', 'entregado', 'leido', 'error')),
  error text,
  interno boolean NOT NULL DEFAULT false, -- nota del sistema que solo ve el panel (no sale por WhatsApp)
  usuario_id integer REFERENCES usuarios(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE wa_mensajes ADD COLUMN IF NOT EXISTS media_bytes integer;
CREATE INDEX IF NOT EXISTS idx_wa_mensajes_jid ON wa_mensajes (jid, id DESC);
CREATE INDEX IF NOT EXISTS idx_wa_mensajes_texto ON wa_mensajes USING gin (to_tsvector('simple', coalesce(texto, '')));

-- Toda la configuración del bot en una fila (IA, personalidad, negocio, horario, anti-bloqueo, dueño).
-- Las API keys viven acá y no en .env ni en git.
CREATE TABLE IF NOT EXISTS wa_config (
  id integer PRIMARY KEY CHECK (id = 1),
  datos jsonb NOT NULL DEFAULT '{}'::jsonb,
  estado_dueno jsonb NOT NULL DEFAULT '{}'::jsonb, -- cliente en foco, último resumen...
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
INSERT INTO wa_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Envíos salientes (recibos, avisos): nunca en la misma petición HTTP, los manda un trabajador
CREATE TABLE IF NOT EXISTS wa_outbox (
  id bigserial PRIMARY KEY,
  jid text NOT NULL,
  texto text NOT NULL,
  media_key text,
  media_mime text,
  origen text,  -- ej. 'transaccion:123:confirmada' (evita duplicar el mismo aviso)
  estado text NOT NULL DEFAULT 'EN_COLA' CHECK (estado IN ('EN_COLA', 'ESPERA_CLIENTE', 'ENVIANDO', 'ENVIADO', 'ERROR')),
  intentos integer NOT NULL DEFAULT 0,
  frio boolean NOT NULL DEFAULT false, -- salió a un contacto que nunca nos escribió
  proximo_intento timestamptz NOT NULL DEFAULT now(),
  error text,
  creado_por_id integer REFERENCES usuarios(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  enviado_en timestamptz
);
ALTER TABLE wa_outbox ADD COLUMN IF NOT EXISTS frio boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_outbox_origen ON wa_outbox (origen) WHERE origen IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_outbox_pendientes ON wa_outbox (estado, proximo_intento);

-- Solicitudes creadas por el bot: de qué chat vienen y hasta cuándo vale la tasa congelada
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'SISTEMA';
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS wa_jid text;
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS tasa_vence_en timestamptz;
CREATE INDEX IF NOT EXISTS idx_transacciones_wa_vence ON transacciones (tasa_vence_en) WHERE origen = 'WHATSAPP' AND estado = 'PENDIENTE';

-- Usuario de sistema que firma lo que hace el bot. Inactivo: no puede iniciar sesión.
INSERT INTO usuarios (nombre, email, password_hash, rol, activo)
SELECT 'Bot WhatsApp', 'bot-whatsapp@sistema.local', '!sin-acceso', 'OPERADOR', false
WHERE NOT EXISTS (SELECT 1 FROM usuarios WHERE email = 'bot-whatsapp@sistema.local');
