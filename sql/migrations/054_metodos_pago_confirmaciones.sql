-- Confirmaciones: "Otro método de pago" se simplifica a Zelle, Western Union, USDT, Bancolombia, Bancolombia Internacional,
-- Bs y Efectivo. Ya estaban Bancolombia, Bolívares y USDT; se agregan las que faltan (solo si no existen).
-- Efectivo es una cuenta aparte: lo pagado así no pasa por taquilla y no toca el efectivo de las cajas físicas.
INSERT INTO cajas (nombre, tipo, descripcion, moneda_id)
SELECT v.nombre, 'BANCO', v.descripcion, m.id
FROM (VALUES
  ('Zelle', 'USD', 'Pagos de confirmaciones por Zelle'),
  ('Western Union', 'USD', 'Pagos de confirmaciones por Western Union'),
  ('Bancolombia Internacional', 'USD', 'Pagos de confirmaciones por Bancolombia Internacional'),
  ('Efectivo', 'COP', 'Pagos de confirmaciones en efectivo, fuera de taquilla')
) AS v(nombre, codigo, descripcion)
JOIN monedas m ON m.codigo = v.codigo
WHERE NOT EXISTS (SELECT 1 FROM cajas c WHERE lower(c.nombre) = lower(v.nombre));
