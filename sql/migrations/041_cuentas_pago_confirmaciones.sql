-- Confirmaciones: una confirmación se puede pagar "por otro método" (sin pasar por taquilla), descontando de una cuenta
-- de la empresa. Ya estaban Bancolombia y Nequi; se agregan las de bolívares y USDT (solo si no existen).
INSERT INTO cajas (nombre, tipo, descripcion, moneda_id)
SELECT v.nombre, 'BANCO', v.descripcion, m.id
FROM (VALUES ('Bolívares', 'VES', 'Pagos de confirmaciones en bolívares'), ('USDT', 'USDT', 'Pagos de confirmaciones en USDT')) AS v(nombre, codigo, descripcion)
JOIN monedas m ON m.codigo = v.codigo
WHERE NOT EXISTS (SELECT 1 FROM cajas c WHERE lower(c.nombre) = lower(v.nombre));
