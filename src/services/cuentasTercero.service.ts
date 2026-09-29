import { pool } from "../db/pool";

export type TipoCuentaTercero = "CUENTA_BANCARIA" | "PAGO_MOVIL" | "ZELLE" | "NEQUI" | "DAVIPLATA" | "OTRO";

export interface DatosCuentaTercero {
  tipo: TipoCuentaTercero;
  monedaId?: number | null;
  banco?: string | null;
  numeroCuenta?: string | null;
  tipoCuenta?: "AHORRO" | "CORRIENTE" | null;
  titular: string;
  identificacionTitular?: string | null;
  telefono?: string | null;
  email?: string | null;
  alias?: string | null;
}

/** Campos obligatorios según el tipo de cuenta. Se usa al crear y al editar. */
function validarCamposPorTipo(c: DatosCuentaTercero) {
  const faltan: string[] = [];
  switch (c.tipo) {
    case "CUENTA_BANCARIA":
      if (!c.banco) faltan.push("banco");
      if (!c.numeroCuenta) faltan.push("numeroCuenta");
      break;
    case "PAGO_MOVIL":
      if (!c.banco) faltan.push("banco");
      if (!c.telefono) faltan.push("telefono");
      if (!c.identificacionTitular) faltan.push("identificacionTitular");
      break;
    case "ZELLE":
      if (!c.email && !c.telefono) faltan.push("email o telefono");
      break;
    case "NEQUI":
    case "DAVIPLATA":
      if (!c.telefono) faltan.push("telefono");
      break;
    case "OTRO":
      break;
  }
  if (faltan.length > 0) {
    throw Object.assign(new Error(`Para una cuenta ${c.tipo} falta: ${faltan.join(", ")}`), { status: 400 });
  }
}

async function exigirTercero(terceroId: number) {
  const result = await pool.query(`SELECT id FROM terceros WHERE id = $1`, [terceroId]);
  if (result.rows.length === 0) throw Object.assign(new Error("Tercero no encontrado"), { status: 404 });
}

export async function listarCuentasTercero(terceroId: number, incluirInactivas: boolean) {
  const result = await pool.query(
    `SELECT ct.*, m.codigo AS moneda_codigo
     FROM cuentas_tercero ct
     LEFT JOIN monedas m ON m.id = ct.moneda_id
     WHERE ct.tercero_id = $1 ${incluirInactivas ? "" : "AND ct.activo = true"}
     ORDER BY ct.activo DESC, ct.tipo, ct.created_at DESC`,
    [terceroId]
  );
  return result.rows;
}

export async function crearCuentaTercero(terceroId: number, datos: DatosCuentaTercero, usuarioId: number) {
  await exigirTercero(terceroId);
  validarCamposPorTipo(datos);

  const result = await pool.query(
    `INSERT INTO cuentas_tercero
      (tercero_id, moneda_id, tipo, banco, numero_cuenta, tipo_cuenta, titular, identificacion_titular,
       telefono, email, alias, creado_por_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      terceroId,
      datos.monedaId ?? null,
      datos.tipo,
      datos.banco ?? null,
      datos.numeroCuenta ?? null,
      datos.tipoCuenta ?? null,
      datos.titular,
      datos.identificacionTitular ?? null,
      datos.telefono ?? null,
      datos.email ?? null,
      datos.alias ?? null,
      usuarioId,
    ]
  );
  return result.rows[0];
}

export async function actualizarCuentaTercero(
  cuentaId: number,
  cambios: Partial<DatosCuentaTercero> & { activo?: boolean }
) {
  const actualResult = await pool.query(`SELECT * FROM cuentas_tercero WHERE id = $1`, [cuentaId]);
  const actual = actualResult.rows[0];
  if (!actual) throw Object.assign(new Error("Cuenta no encontrada"), { status: 404 });

  // undefined = no se envió (se conserva); null = se borra el valor
  const elegir = <T>(nuevo: T | undefined, anterior: T): T => (nuevo === undefined ? anterior : nuevo);
  const fusionada: DatosCuentaTercero = {
    tipo: elegir(cambios.tipo, actual.tipo),
    monedaId: elegir(cambios.monedaId, actual.moneda_id),
    banco: elegir(cambios.banco, actual.banco),
    numeroCuenta: elegir(cambios.numeroCuenta, actual.numero_cuenta),
    tipoCuenta: elegir(cambios.tipoCuenta, actual.tipo_cuenta),
    titular: elegir(cambios.titular, actual.titular),
    identificacionTitular: elegir(cambios.identificacionTitular, actual.identificacion_titular),
    telefono: elegir(cambios.telefono, actual.telefono),
    email: elegir(cambios.email, actual.email),
    alias: elegir(cambios.alias, actual.alias),
  };
  validarCamposPorTipo(fusionada);

  const result = await pool.query(
    `UPDATE cuentas_tercero
     SET tipo = $1, moneda_id = $2, banco = $3, numero_cuenta = $4, tipo_cuenta = $5, titular = $6,
         identificacion_titular = $7, telefono = $8, email = $9, alias = $10, activo = $11
     WHERE id = $12
     RETURNING *`,
    [
      fusionada.tipo,
      fusionada.monedaId ?? null,
      fusionada.banco ?? null,
      fusionada.numeroCuenta ?? null,
      fusionada.tipoCuenta ?? null,
      fusionada.titular,
      fusionada.identificacionTitular ?? null,
      fusionada.telefono ?? null,
      fusionada.email ?? null,
      fusionada.alias ?? null,
      elegir(cambios.activo, actual.activo),
      cuentaId,
    ]
  );
  return result.rows[0];
}

/** No se borra: puede estar referenciada por transacciones. Solo se desactiva. */
export async function desactivarCuentaTercero(cuentaId: number) {
  const result = await pool.query(`UPDATE cuentas_tercero SET activo = false WHERE id = $1 RETURNING *`, [cuentaId]);
  const cuenta = result.rows[0];
  if (!cuenta) throw Object.assign(new Error("Cuenta no encontrada"), { status: 404 });
  return cuenta;
}
