-- Confirmaciones: una parte se le paga al cliente por banco y el resto en efectivo en taquilla.
-- pagado_parcial: lo que ya se le pagó por banco de esta confirmación (la taquilla entrega solo lo que falta).
-- pago_parcial_de_id: en el movimiento de ese pago, la confirmación a la que corresponde (para devolverlo si se anula).
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS pagado_parcial numeric(20, 4) NOT NULL DEFAULT 0;
ALTER TABLE movimientos_cuenta_corriente ADD COLUMN IF NOT EXISTS pago_parcial_de_id integer REFERENCES movimientos_cuenta_corriente(id);
