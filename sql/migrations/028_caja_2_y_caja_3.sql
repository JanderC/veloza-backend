-- Cajas y fondeo queda con Taquilla, Caja Fuerte, Caja 1, Caja 2 y Caja 3.
-- Se crean las dos que faltaban, con las mismas monedas que ya maneja Caja 1 (en cero).
INSERT INTO cajas (nombre, tipo, descripcion)
SELECT n, 'FISICA', 'Caja de efectivo'
FROM (VALUES ('Caja 2'), ('Caja 3')) AS nuevas(n)
WHERE NOT EXISTS (SELECT 1 FROM cajas c WHERE c.nombre = nuevas.n);

INSERT INTO saldos_caja (caja_id, moneda_id, monto)
SELECT c.id, s.moneda_id, 0
FROM cajas c
JOIN saldos_caja s ON s.caja_id = (SELECT id FROM cajas WHERE nombre = 'Caja 1' ORDER BY id LIMIT 1)
WHERE c.nombre IN ('Caja 2', 'Caja 3')
  AND NOT EXISTS (SELECT 1 FROM saldos_caja x WHERE x.caja_id = c.id AND x.moneda_id = s.moneda_id);
