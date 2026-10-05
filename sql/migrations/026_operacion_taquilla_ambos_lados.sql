-- Cambio de efectivo por efectivo en taquilla (ej. compramos dólares y entregamos pesos): se mueven los dos lados de la caja.
-- caja_lado = 'AMBOS': en un ingreso entra el monto y sale el resultado; en un egreso, al revés.
ALTER TABLE operaciones_taquilla DROP CONSTRAINT IF EXISTS operaciones_taquilla_caja_lado_check;
ALTER TABLE operaciones_taquilla ADD CONSTRAINT operaciones_taquilla_caja_lado_check CHECK (caja_lado IN ('MONTO', 'RESULTADO', 'AMBOS'));
