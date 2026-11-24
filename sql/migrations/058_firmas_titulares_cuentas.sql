-- Firmas de los titulares de las cuentas de banco de la empresa: la persona dueña de cada cuenta (BDV 8515, Provincial
-- 1788…) firma una vez, y en el contrato con el cliente va como EL COMISIONISTA cuando el cliente depositó en esa
-- cuenta. Se guardan también sus datos para el contrato (RIF, ciudad, municipio, estado).
ALTER TABLE firmas ADD COLUMN IF NOT EXISTS caja_id integer REFERENCES cajas(id) ON DELETE SET NULL;
ALTER TABLE firmas ADD COLUMN IF NOT EXISTS datos jsonb;
ALTER TABLE firmas DROP CONSTRAINT IF EXISTS firmas_tipo_check;
ALTER TABLE firmas ADD CONSTRAINT firmas_tipo_check CHECK (tipo IN ('CLIENTE', 'TITULAR', 'EMPRESA', 'COMISIONISTA'));
CREATE INDEX IF NOT EXISTS firmas_caja ON firmas (caja_id, created_at DESC) WHERE caja_id IS NOT NULL;

ALTER TABLE firma_links ADD COLUMN IF NOT EXISTS caja_id integer REFERENCES cajas(id) ON DELETE CASCADE;
ALTER TABLE firma_links DROP CONSTRAINT IF EXISTS firma_links_tipo_check;
ALTER TABLE firma_links ADD CONSTRAINT firma_links_tipo_check CHECK (tipo IN ('CLIENTE', 'TITULAR', 'COMISIONISTA'));
