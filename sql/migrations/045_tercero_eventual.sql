-- Un tipo más de tercero: clientes eventuales (los que vienen de vez en cuando, sin relación fija).
ALTER TYPE tipo_tercero ADD VALUE IF NOT EXISTS 'EVENTUAL';
