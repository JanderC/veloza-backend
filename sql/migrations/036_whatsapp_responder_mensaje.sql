-- WhatsApp: responder a un mensaje en particular (citarlo), como en la aplicación.
-- responde_a: el mensaje de esta misma conversación que se está contestando.
ALTER TABLE wa_mensajes ADD COLUMN IF NOT EXISTS responde_a bigint REFERENCES wa_mensajes(id) ON DELETE SET NULL;
