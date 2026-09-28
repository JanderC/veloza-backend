INSERT INTO cajas (nombre, tipo) VALUES
  ('Caja 1', 'FISICA'),
  ('Caja Fuerte', 'FUERTE'),
  ('Bancolombia', 'BANCO')
ON CONFLICT (nombre) DO NOTHING;