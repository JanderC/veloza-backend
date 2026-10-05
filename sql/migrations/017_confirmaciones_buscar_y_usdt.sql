-- Confirmaciones filtra por banco o medio: falta USDT entre las opciones.
INSERT INTO canales_cuenta_corriente (nombre) VALUES ('USDT')
ON CONFLICT (nombre) DO UPDATE SET activo = true;
