import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { abrirTurnoSiFalta } from "./cierreCaja.service";

const ZONA = "America/Bogota";
// Lo que se lleva en la Caja Fuerte: dólares, pesos colombianos y euros
const MONEDAS_CAJA_FUERTE = ["USD", "COP", "EUR"] as const;
type CodigoMoneda = (typeof MONEDAS_CAJA_FUERTE)[number];

function errorHttp(mensaje: string, status: number) {
  return Object.assign(new Error(mensaje), { status });
}

async function cajaFuerte() {
  const r = await pool.query(`SELECT id, nombre FROM cajas WHERE tipo = 'FUERTE' AND activo ORDER BY es_principal DESC, id LIMIT 1`);
  if (!r.rows[0]) throw errorHttp("No hay una Caja Fuerte configurada", 409);
  return r.rows[0] as { id: number; nombre: string };
}

export interface FiltrosCajaFuerte {
  pagina?: number;
  porPagina?: number;
  moneda?: CodigoMoneda;
  tipo?: "INGRESO" | "EGRESO";
}

/**
 * La Caja Fuerte: cuánto hay en dólares, pesos y euros, lo que entró y salió hoy, y sus movimientos paginados
 * (los más nuevos primero). Cada movimiento trae cómo quedaron los tres saldos después de él.
 */
export async function obtenerCajaFuerte(filtros: FiltrosCajaFuerte = {}) {
  const caja = await cajaFuerte();
  const porPagina = Math.min(100, Math.max(5, Math.trunc(filtros.porPagina ?? 10)));
  const pagina = Math.max(1, Math.trunc(filtros.pagina ?? 1));
  const codigos = MONEDAS_CAJA_FUERTE as unknown as string[];

  const saldos = await pool.query(
    `SELECT m.codigo, m.decimales, COALESCE(s.monto, 0) AS monto
     FROM monedas m LEFT JOIN saldos_caja s ON s.moneda_id = m.id AND s.caja_id = $1
     WHERE m.codigo = ANY($2::text[]) ORDER BY array_position($2::text[], m.codigo::text)`,
    [caja.id, codigos]
  );
  // Lo que entró y salió hoy, por moneda
  const hoy = await pool.query(
    `SELECT m.codigo, k.tipo::text AS tipo, COALESCE(sum(k.monto), 0) AS total
     FROM movimientos_caja k JOIN monedas m ON m.id = k.moneda_id
     WHERE k.caja_id = $1 AND m.codigo = ANY($2::text[]) AND (k.created_at AT TIME ZONE '${ZONA}')::date = (now() AT TIME ZONE '${ZONA}')::date
     GROUP BY 1, 2`,
    [caja.id, codigos]
  );

  // Los movimientos de la caja en esas tres monedas; los filtros solo eligen cuáles se listan
  const BASE = `
    WITH m AS (
      SELECT k.id, k.tipo::text AS tipo, k.monto, k.saldo_anterior, k.saldo_nuevo, k.created_at, k.observacion, mo.codigo,
             u.nombre AS usuario_nombre, t.tipo::text AS transaccion_tipo, t.observacion AS transaccion_observacion,
             co.nombre AS caja_origen, cd.nombre AS caja_destino
      FROM movimientos_caja k
      JOIN monedas mo ON mo.id = k.moneda_id
      LEFT JOIN usuarios u ON u.id = k.usuario_id
      LEFT JOIN transacciones t ON t.id = k.transaccion_id
      LEFT JOIN cajas co ON co.id = t.caja_id
      LEFT JOIN cajas cd ON cd.id = t.caja_destino_id
      WHERE k.caja_id = $1 AND mo.codigo = ANY($2::text[])
    )`;
  const FILTRO = `($3::text IS NULL OR codigo = $3) AND ($4::text IS NULL OR tipo = $4)`;
  const parametros = [caja.id, codigos, filtros.moneda ?? null, filtros.tipo ?? null];
  const total = Number((await pool.query(`${BASE} SELECT count(*) AS n FROM m WHERE ${FILTRO}`, parametros)).rows[0].n);
  const paginas = Math.max(1, Math.ceil(total / porPagina));
  const actual = Math.min(pagina, paginas);
  // cómo quedó cada saldo después del movimiento: el último saldo_nuevo de esa moneda hasta ahí
  const saldoTras = (codigo: string) => `(SELECT x.saldo_nuevo FROM m x WHERE x.codigo = '${codigo}' AND x.id <= p.id ORDER BY x.id DESC LIMIT 1)`;
  const filas = await pool.query(
    `${BASE}
     SELECT p.*, ${saldoTras("USD")} AS saldo_usd, ${saldoTras("COP")} AS saldo_cop, ${saldoTras("EUR")} AS saldo_eur
     FROM (SELECT * FROM m WHERE ${FILTRO} ORDER BY id DESC LIMIT $5 OFFSET $6) p
     ORDER BY p.id DESC`,
    [...parametros, porPagina, (actual - 1) * porPagina]
  );

  const fijo = (v: unknown) => new Decimal((v as string | null) ?? 0).toFixed(4);
  return {
    caja,
    saldos: saldos.rows.map((s) => {
      const de = (tipo: string) => fijo(hoy.rows.find((h) => h.codigo === s.codigo && h.tipo === tipo)?.total);
      return { codigo: s.codigo as CodigoMoneda, decimales: Number(s.decimales), monto: fijo(s.monto), entroHoy: de("INGRESO"), salioHoy: de("EGRESO") };
    }),
    movimientos: filas.rows.map((f) => ({
      id: f.id as number,
      fecha: f.created_at as Date,
      tipo: f.tipo as "INGRESO" | "EGRESO",
      codigo: f.codigo as CodigoMoneda,
      monto: fijo(f.monto),
      // de dónde vino o a dónde fue: lo escrito al cargarlo, o la transferencia que lo generó
      concepto:
        (f.observacion as string | null) ??
        (f.transaccion_tipo === "TRANSFERENCIA_INTERNA"
          ? `${f.transaccion_observacion ?? "Transferencia"} · ${f.tipo === "INGRESO" ? `desde ${f.caja_origen ?? "otra caja"}` : `hacia ${f.caja_destino ?? "otra caja"}`}`
          : f.transaccion_tipo === "FONDEO"
            ? (f.transaccion_observacion ?? "Fondeo")
            : (f.transaccion_observacion ?? "Ajuste de saldo")),
      manual: f.transaccion_tipo == null,
      usuario: (f.usuario_nombre as string | null) ?? "—",
      saldoUsd: f.saldo_usd != null ? fijo(f.saldo_usd) : null,
      saldoCop: f.saldo_cop != null ? fijo(f.saldo_cop) : null,
      saldoEur: f.saldo_eur != null ? fijo(f.saldo_eur) : null,
    })),
    paginacion: { pagina: actual, porPagina, total, paginas },
  };
}

/** Ingresar o egresar dinero de la Caja Fuerte, con su concepto. El egreso no puede dejarla en negativo. */
export async function registrarMovimientoCajaFuerte(input: { tipo: "INGRESO" | "EGRESO"; monedaCodigo: string; monto: string; concepto: string; usuarioId: number }) {
  let monto: Decimal;
  try {
    monto = new Decimal(input.monto);
  } catch {
    throw errorHttp("El monto no es un número válido", 400);
  }
  if (!monto.isFinite() || !monto.isPositive()) throw errorHttp("El monto tiene que ser mayor a cero", 400);
  const concepto = input.concepto.trim();
  if (concepto.length < 3) throw errorHttp("Escribí la referencia: de dónde viene o a dónde va el dinero", 400);

  const caja = await cajaFuerte();
  const moneda = (await pool.query(`SELECT id, codigo, decimales FROM monedas WHERE codigo = $1`, [input.monedaCodigo])).rows[0];
  if (!moneda || !(MONEDAS_CAJA_FUERTE as readonly string[]).includes(moneda.codigo)) throw errorHttp("La Caja Fuerte se lleva en dólares, pesos y euros", 400);
  monto = monto.toDecimalPlaces(Number(moneda.decimales), Decimal.ROUND_HALF_UP);
  if (!monto.isPositive()) throw errorHttp("El monto tiene que ser mayor a cero", 400);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await abrirTurnoSiFalta(client, caja.id, moneda.id, input.usuarioId);
    await client.query(`INSERT INTO saldos_caja (caja_id, moneda_id, monto) SELECT $1, $2, 0 WHERE NOT EXISTS (SELECT 1 FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2)`, [caja.id, moneda.id]);
    const saldo = (await client.query(`SELECT id, monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`, [caja.id, moneda.id])).rows[0];
    const anterior = new Decimal(saldo.monto);
    const nuevo = input.tipo === "INGRESO" ? anterior.plus(monto) : anterior.minus(monto);
    if (nuevo.isNegative()) throw errorHttp(`La Caja Fuerte no tiene tanto en ${moneda.codigo}: hay ${anterior.toFixed(Number(moneda.decimales))}`, 409);
    await client.query(`UPDATE saldos_caja SET monto = $1 WHERE id = $2`, [nuevo.toFixed(4), saldo.id]);
    await client.query(
      `INSERT INTO movimientos_caja (caja_id, moneda_id, tipo, monto, saldo_anterior, saldo_nuevo, usuario_id, observacion) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [caja.id, moneda.id, input.tipo, monto.toFixed(4), anterior.toFixed(4), nuevo.toFixed(4), input.usuarioId, concepto]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
