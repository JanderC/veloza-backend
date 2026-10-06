-- Taquilla 3: otra taquilla más, igual que la 1 y la 2, con su propia caja (pesos, dólares y euros, en cero).
INSERT INTO cajas (nombre, tipo, descripcion, es_taquilla, taquilla_numero)
SELECT 'Taquilla 3', 'FISICA', 'Caja del módulo Taquilla 3: efectivo en pesos, dólares y euros', true, 3
WHERE NOT EXISTS (SELECT 1 FROM cajas WHERE taquilla_numero = 3);

INSERT INTO saldos_caja (caja_id, moneda_id, monto)
SELECT c.id, m.id, 0
FROM cajas c CROSS JOIN monedas m
WHERE c.taquilla_numero = 3 AND m.codigo IN ('COP', 'USD', 'EUR')
  AND NOT EXISTS (SELECT 1 FROM saldos_caja x WHERE x.caja_id = c.id AND x.moneda_id = m.id);
