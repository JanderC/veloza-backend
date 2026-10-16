-- El cliente es uno solo para todos los módulos: el mismo tercero puede tener su cuenta en Cuentas Corrientes, en
-- Cuentas por Cobrar y en Confirmaciones, aunque sea con el mismo medio y la misma moneda. Antes la cuenta era única
-- por (tercero, medio, moneda), y por eso se creaba otro cliente igual para llevarlo en otro módulo.
ALTER TABLE cuentas_corrientes DROP CONSTRAINT IF EXISTS cuentas_corrientes_tercero_id_canal_id_moneda_id_key;
ALTER TABLE cuentas_corrientes ADD CONSTRAINT cuentas_corrientes_tercero_canal_moneda_modulo_key UNIQUE (tercero_id, canal_id, moneda_id, modulo);
