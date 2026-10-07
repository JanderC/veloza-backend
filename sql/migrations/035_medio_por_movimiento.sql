-- Confirmaciones: el cliente se registra una sola vez y cada movimiento lleva su medio de pago
-- (hoy envía por Nequi, mañana por Bancolombia). Antes el medio era de la cuenta, y había que registrar al cliente
-- de nuevo por cada medio. Los movimientos anteriores quedan sin este dato y usan el medio de su cuenta.
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS canal_id integer REFERENCES canales_cuenta_corriente(id);
