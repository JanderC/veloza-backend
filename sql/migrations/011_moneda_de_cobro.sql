-- La contabilidad de la cuenta se lleva en una moneda (moneda_id, ej. USD) pero se le puede cobrar
-- en otra (ej. COP) con una tasa manual: tasa_cobro = cuánto de la moneda de cobro vale 1 de la contabilidad.
-- Si moneda_cobro_id es NULL se cobra en la misma moneda, como siempre.
ALTER TABLE cuentas_corrientes ADD COLUMN IF NOT EXISTS moneda_cobro_id integer REFERENCES monedas(id);
ALTER TABLE cuentas_corrientes ADD COLUMN IF NOT EXISTS tasa_cobro numeric(20,8);
