import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { pool } from "../db/pool";

/**
 * Gastos administrativos: los egresos del negocio que no son operaciones con clientes, con la misma forma de la hoja
 * de Excel (gasto de oficina, sueldo del dueño, pagos a entes, pagos por Bancolombia y en bolívares, nómina, bonos).
 * Cada gasto tiene monto en pesos y/o en dólares, está PENDIENTE o PAGADO, y al pagarlo se elige de dónde sale la
 * plata (Caja Fuerte, una cuenta de la empresa, o ninguna caja del sistema): esa caja baja por lo pagado.
 */
export const CATEGORIAS = ["OFICINA", "DUENO", "ENTES", "PAGO_BANCOLOMBIA", "PAGO_BOLIVARES", "NOMINA", "BONO", "OTRO"] as const;
export type Categoria = (typeof CATEGORIAS)[number];

function errorHttp(mensaje: string, status: number) {
  return Object.assign(new Error(mensaje), { status });
}
const monto = (v: string | undefined, campo: string) => {
  if (v === undefined || v === "") return new Decimal(0);
  const d = new Decimal(v);
  if (!d.isFinite() || d.isNegative()) throw errorHttp(`${campo} no es válido`, 400);
  return d;
};

const SELECT = `SELECT g.*, c.nombre AS caja_nombre, u.nombre AS usuario_nombre, p.nombre AS pagado_por_nombre
  FROM gastos g LEFT JOIN cajas c ON c.id = g.caja_id LEFT JOIN usuarios u ON u.id = g.usuario_id LEFT JOIN usuarios p ON p.id = g.pagado_por`;

export async function listarGastos(periodo: string) {
  const r = await pool.query(`${SELECT} WHERE g.periodo = $1 ORDER BY g.categoria, COALESCE(g.fecha, g.fecha_programada) NULLS LAST, g.id`, [periodo]);
  return r.rows;
}

/** Saca la plata de una caja (Caja Fuerte o cuenta de la empresa) dentro de la transacción; devuelve los movimientos. */
async function sacarDeCaja(c: PoolClient, cajaId: number, montos: { codigo: string; monto: Decimal }[], usuarioId: number, observacion: string) {
  const caja = (await c.query(`SELECT id, nombre, tipo FROM cajas WHERE id = $1 AND activo`, [cajaId])).rows[0];
  if (!caja) throw errorHttp("Esa caja no existe", 404);
  // las taquillas tienen su sesión y su cuadre: los gastos salen de la Caja Fuerte o de una cuenta de la empresa
  if (caja.tipo === "FISICA") throw errorHttp("Los gastos se pagan desde la Caja Fuerte o una cuenta de la empresa, no desde una taquilla", 400);
  const ids: number[] = [];
  for (const m of montos) {
    if (m.monto.isZero()) continue;
    const moneda = (await c.query(`SELECT id FROM monedas WHERE codigo = $1`, [m.codigo])).rows[0];
    let fila = (await c.query(`SELECT id, monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`, [cajaId, moneda.id])).rows[0];
    if (!fila) fila = (await c.query(`INSERT INTO saldos_caja (caja_id, moneda_id, monto) VALUES ($1, $2, 0) RETURNING id, monto`, [cajaId, moneda.id])).rows[0];
    const antes = new Decimal(fila.monto);
    const despues = antes.minus(m.monto);
    // las cuentas de banco pueden quedar en negativo; la Caja Fuerte no
    if (despues.isNegative() && caja.tipo !== "BANCO") throw errorHttp(`${caja.nombre} no tiene ${m.monto.toFixed(0)} ${m.codigo} para este gasto`, 409);
    const mov = await c.query(
      `INSERT INTO movimientos_caja (caja_id, moneda_id, tipo, monto, saldo_anterior, saldo_nuevo, usuario_id, observacion) VALUES ($1, $2, 'EGRESO', $3, $4, $5, $6, $7) RETURNING id`,
      [cajaId, moneda.id, m.monto.toFixed(4), antes.toFixed(4), despues.toFixed(4), usuarioId, observacion]
    );
    await c.query(`UPDATE saldos_caja SET monto = $1 WHERE id = $2`, [despues.toFixed(4), fila.id]);
    ids.push(mov.rows[0].id);
  }
  return ids;
}

/** Devuelve a la caja lo que salió por un gasto (al borrarlo). */
async function devolverACaja(c: PoolClient, movimientos: number[], usuarioId: number, observacion: string) {
  for (const id of movimientos) {
    const m = (await c.query(`SELECT caja_id, moneda_id, monto FROM movimientos_caja WHERE id = $1`, [id])).rows[0];
    if (!m) continue;
    const fila = (await c.query(`SELECT id, monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`, [m.caja_id, m.moneda_id])).rows[0];
    const antes = new Decimal(fila?.monto ?? 0);
    const despues = antes.plus(m.monto);
    await c.query(
      `INSERT INTO movimientos_caja (caja_id, moneda_id, tipo, monto, saldo_anterior, saldo_nuevo, usuario_id, observacion) VALUES ($1, $2, 'INGRESO', $3, $4, $5, $6, $7)`,
      [m.caja_id, m.moneda_id, m.monto, antes.toFixed(4), despues.toFixed(4), usuarioId, observacion]
    );
    if (fila) await c.query(`UPDATE saldos_caja SET monto = $1 WHERE id = $2`, [despues.toFixed(4), fila.id]);
  }
}

async function enTransaccion<T>(fn: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

export interface NuevoGasto {
  periodo: string;
  categoria: Categoria;
  descripcion: string;
  montoCop?: string;
  montoUsd?: string;
  pagado: boolean;
  fecha?: string; // si ya se pagó (hoy si no se dice)
  cajaId?: number | null; // de dónde salió (null: ninguna caja del sistema)
  nota?: string;
}

const hoy = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());

export async function crearGasto(g: NuevoGasto, usuarioId: number) {
  const cop = monto(g.montoCop, "El monto en pesos");
  const usd = monto(g.montoUsd, "El monto en dólares");
  if (cop.isZero() && usd.isZero()) throw errorHttp("Escribe el monto en pesos o en dólares", 400);
  return enTransaccion(async (c) => {
    const movs = g.pagado && g.cajaId ? await sacarDeCaja(c, g.cajaId, [{ codigo: "COP", monto: cop }, { codigo: "USD", monto: usd }], usuarioId, `Gasto: ${g.descripcion.trim()}`) : [];
    const r = await c.query(
      `INSERT INTO gastos (periodo, categoria, descripcion, monto_cop, monto_usd, estado, fecha, caja_id, movimientos_caja, nota, usuario_id, pagado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        g.periodo,
        g.categoria,
        g.descripcion.trim(),
        cop.toFixed(4),
        usd.toFixed(4),
        g.pagado ? "PAGADO" : "PENDIENTE",
        g.pagado ? (g.fecha ?? hoy()) : null,
        g.pagado ? (g.cajaId ?? null) : null,
        movs,
        g.nota?.trim() || null,
        usuarioId,
        g.pagado ? usuarioId : null,
      ]
    );
    return r.rows[0];
  });
}

/** Pagar uno pendiente: queda con la fecha y, si se elige, sale de una caja. */
export async function pagarGasto(id: number, d: { fecha?: string; cajaId?: number | null }, usuarioId: number) {
  return enTransaccion(async (c) => {
    const g = (await c.query(`SELECT * FROM gastos WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!g) throw errorHttp("Gasto no encontrado", 404);
    if (g.estado === "PAGADO") throw errorHttp("Ese gasto ya está pagado", 409);
    const movs = d.cajaId
      ? await sacarDeCaja(c, d.cajaId, [{ codigo: "COP", monto: new Decimal(g.monto_cop) }, { codigo: "USD", monto: new Decimal(g.monto_usd) }], usuarioId, `Gasto: ${g.descripcion}`)
      : [];
    await c.query(`UPDATE gastos SET estado = 'PAGADO', fecha = $2, caja_id = $3, movimientos_caja = $4, pagado_por = $5 WHERE id = $1`, [id, d.fecha ?? hoy(), d.cajaId ?? null, movs, usuarioId]);
    return { id };
  });
}

/** Corregir un gasto. Si ya movió una caja, el monto no se cambia (se borra y se carga de nuevo). */
export async function editarGasto(id: number, d: { descripcion?: string; categoria?: Categoria; montoCop?: string; montoUsd?: string; fecha?: string | null; nota?: string }) {
  const g = (await pool.query(`SELECT * FROM gastos WHERE id = $1`, [id])).rows[0];
  if (!g) throw errorHttp("Gasto no encontrado", 404);
  const cop = d.montoCop !== undefined ? monto(d.montoCop, "El monto en pesos") : new Decimal(g.monto_cop);
  const usd = d.montoUsd !== undefined ? monto(d.montoUsd, "El monto en dólares") : new Decimal(g.monto_usd);
  const cambiaMonto = !cop.eq(g.monto_cop) || !usd.eq(g.monto_usd);
  if (cambiaMonto && g.movimientos_caja.length) throw errorHttp("Este gasto ya salió de una caja: para cambiar el monto, bórralo y cárgalo de nuevo", 409);
  if (cop.isZero() && usd.isZero()) throw errorHttp("Escribe el monto en pesos o en dólares", 400);
  await pool.query(`UPDATE gastos SET descripcion = $2, categoria = $3, monto_cop = $4, monto_usd = $5, fecha = $6, nota = $7 WHERE id = $1`, [
    id,
    d.descripcion?.trim() || g.descripcion,
    d.categoria ?? g.categoria,
    cop.toFixed(4),
    usd.toFixed(4),
    d.fecha !== undefined ? d.fecha : g.fecha,
    d.nota !== undefined ? d.nota.trim() || null : g.nota,
  ]);
  return { id };
}

/** Borrar un gasto: si había salido de una caja, la plata vuelve a esa caja. */
export async function borrarGasto(id: number, usuarioId: number) {
  return enTransaccion(async (c) => {
    const g = (await c.query(`SELECT * FROM gastos WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!g) throw errorHttp("Gasto no encontrado", 404);
    await devolverACaja(c, g.movimientos_caja, usuarioId, `Se borró el gasto: ${g.descripcion}`);
    await c.query(`DELETE FROM gastos WHERE id = $1`, [id]);
    return { id };
  });
}

// ---------- Lo que se repite: nómina del mes y pagos de cada semana ----------
export async function listarPlantillas() {
  return (await pool.query(`SELECT * FROM gastos_plantillas WHERE activo ORDER BY categoria, orden, id`)).rows;
}

export async function guardarPlantillas(
  filas: { id?: number; categoria: Categoria; descripcion: string; montoCop?: string; montoUsd?: string; frecuencia: "MENSUAL" | "SEMANAL"; diaSemana?: number | null }[]
) {
  return enTransaccion(async (c) => {
    const ids = filas.map((f) => f.id).filter((x): x is number => !!x);
    await c.query(`UPDATE gastos_plantillas SET activo = false WHERE NOT (id = ANY($1::int[]))`, [ids]);
    for (const [i, f] of filas.entries()) {
      const vals = [f.categoria, f.descripcion.trim(), monto(f.montoCop, "El monto").toFixed(4), monto(f.montoUsd, "El monto").toFixed(4), f.frecuencia, f.frecuencia === "SEMANAL" ? (f.diaSemana ?? 1) : null, i];
      if (f.id) await c.query(`UPDATE gastos_plantillas SET categoria = $2, descripcion = $3, monto_cop = $4, monto_usd = $5, frecuencia = $6, dia_semana = $7, orden = $8, activo = true WHERE id = $1`, [f.id, ...vals]);
      else await c.query(`INSERT INTO gastos_plantillas (categoria, descripcion, monto_cop, monto_usd, frecuencia, dia_semana, orden) VALUES ($1, $2, $3, $4, $5, $6, $7)`, vals);
    }
    return listarPlantillas();
  });
}

/**
 * Deja pendientes los gastos que se repiten en el mes: la nómina (uno por persona) o los pagos semanales (uno por cada
 * día que toca). Lo que ya estaba generado para ese mes no se repite.
 */
export async function generarDelMes(periodo: string, frecuencia: "MENSUAL" | "SEMANAL", usuarioId: number) {
  const plantillas = (await pool.query(`SELECT * FROM gastos_plantillas WHERE activo AND frecuencia = $1 ORDER BY orden, id`, [frecuencia])).rows;
  const [anio, mes] = periodo.split("-").map(Number) as [number, number];
  let creados = 0;
  for (const p of plantillas) {
    const fechas: (string | null)[] = [];
    if (frecuencia === "MENSUAL") fechas.push(null);
    else {
      const dias = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
      for (let d = 1; d <= dias; d++) {
        const f = new Date(Date.UTC(anio, mes - 1, d));
        if (f.getUTCDay() === p.dia_semana) fechas.push(f.toISOString().slice(0, 10));
      }
    }
    for (const fp of fechas) {
      const ya = await pool.query(`SELECT 1 FROM gastos WHERE plantilla_id = $1 AND periodo = $2 AND fecha_programada IS NOT DISTINCT FROM $3::date`, [p.id, periodo, fp]);
      if (ya.rows[0]) continue;
      await pool.query(
        `INSERT INTO gastos (periodo, categoria, descripcion, monto_cop, monto_usd, estado, fecha_programada, plantilla_id, usuario_id) VALUES ($1, $2, $3, $4, $5, 'PENDIENTE', $6, $7, $8)`,
        [periodo, p.categoria, p.descripcion, p.monto_cop, p.monto_usd, fp, p.id, usuarioId]
      );
      creados++;
    }
  }
  return { creados };
}
