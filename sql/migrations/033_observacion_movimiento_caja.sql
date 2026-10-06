-- Módulo Caja Fuerte: los ingresos y egresos que se cargan a mano llevan un concepto (de dónde viene o a dónde va la plata).
ALTER TABLE movimientos_caja ADD COLUMN IF NOT EXISTS observacion text;
