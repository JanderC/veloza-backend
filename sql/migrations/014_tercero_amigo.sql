-- Un tipo más de tercero para las cuentas corrientes: amigos (ni cliente ni proveedor).
ALTER TYPE tipo_tercero ADD VALUE IF NOT EXISTS 'AMIGO';
