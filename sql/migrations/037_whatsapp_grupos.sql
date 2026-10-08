-- WhatsApp: los grupos en los que están los teléfonos vinculados también se ven y se les puede escribir.
-- En un grupo hablan varias personas: cada mensaje guarda quién lo escribió.
ALTER TABLE wa_mensajes ADD COLUMN IF NOT EXISTS remitente text;
