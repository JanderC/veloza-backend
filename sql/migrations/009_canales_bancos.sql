-- Opciones del select de banco o canal: sale FAMILIA (se desactiva, no se borra) y entran las de uso diario.
-- El resto se carga desde la pantalla, en "Personalizar".
UPDATE canales_cuenta_corriente SET activo = false WHERE nombre = 'FAMILIA';
INSERT INTO canales_cuenta_corriente (nombre)
VALUES ('NEQUI'), ('BANCOLOMBIA'), ('PAGO_MOVIL'), ('BOLIVARES'), ('DOLARES')
ON CONFLICT (nombre) DO UPDATE SET activo = true;
