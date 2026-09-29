INSERT INTO cajas (nombre, tipo) VALUES
  ('Caja 1', 'FISICA'),
  ('Caja Fuerte', 'FUERTE'),
  ('Bancolombia', 'BANCO')
ON CONFLICT (nombre) DO NOTHING;

UPDATE cajas SET es_principal = true
WHERE nombre = 'Caja Fuerte' AND NOT EXISTS (SELECT 1 FROM cajas WHERE es_principal);
