-- WhatsApp: respuestas rápidas con título, cargadas desde su propia pestaña y a mano en cualquier chat.
-- Antes eran una lista de renglones dentro de la configuración del bot (solo el admin las podía tocar).
CREATE TABLE IF NOT EXISTS wa_respuestas_rapidas (
  id serial PRIMARY KEY,
  titulo text NOT NULL,
  texto text NOT NULL,
  orden integer NOT NULL DEFAULT 0,
  creado_por integer REFERENCES usuarios(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

-- Las que ya estaban cargadas en la configuración pasan a la tabla (solo la primera vez)
INSERT INTO wa_respuestas_rapidas (titulo, texto, orden)
SELECT CASE WHEN char_length(r.texto) > 40 THEN left(r.texto, 39) || '…' ELSE r.texto END, r.texto, r.n
FROM wa_config c,
     jsonb_array_elements_text(
       COALESCE(
         c.datos -> 'config' -> 'panel' -> 'respuestasRapidas',
         '["Hola, ¿en qué te puedo ayudar?", "Dame un momento y ya te confirmo.", "Ya recibimos tu comprobante, lo estamos verificando.", "¡Listo! Tu operación quedó confirmada."]'::jsonb
       )
     ) WITH ORDINALITY AS r(texto, n)
WHERE c.id = 1 AND btrim(r.texto) <> '' AND NOT EXISTS (SELECT 1 FROM wa_respuestas_rapidas);
