import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { abrirTurnoSiFalta } from "./cierreCaja.service";
import { registrarMovimientoCuentaCorriente } from "./cuentaCorriente.service";

const ZONA = "America/Bogota";
// Lo que se ve de la caja de taquilla: efectivo en pesos, dólares y euros
const MONEDAS_TAQUILLA = ["COP", "USD", "EUR"];

function errorHttp(mensaje: string, status: number) {
  return Object.assign(new Error(mensaje), { status });
}

async function cajaDeTaquilla() {
  const r = await pool.query(`SELECT id, nombre FROM cajas WHERE es_taquilla AND activo ORDER BY id LIMIT 1`);
  if (!r.rows[0]) throw errorHttp("No hay una caja de taquilla configurada", 409);
  return r.rows[0] as { id: number; nombre: string };
}

// Solicitudes de Confirmaciones: lo que se le compró al cliente y ya está confirmado
const SELECT_SOLICITUD = `
  SELECT mc.id, mc.fecha, mc.descripcion, mc.monto, mc.cantidad_base, mc.tasa, mc.comision_descontada,
         mc.pagado_en, up.nombre AS pagado_por_nombre,
         cc.id AS cuenta_id, m.codigo AS moneda_codigo, m.decimales AS moneda_decimales,
         t.nombre AS cliente_nombre, t.telefono AS cliente_telefono, t.identificacion AS cliente_cedula
  FROM movimientos_cuenta_corriente mc
  JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id
  JOIN monedas m ON m.id = cc.moneda_id
  JOIN terceros t ON t.id = cc.tercero_id
  LEFT JOIN usuarios up ON up.id = mc.pagado_por
  WHERE cc.modulo = 'CAJA' AND mc.estado_confirmacion = 'CONFIRMADA' AND NOT mc.anulado AND mc.monto > 0`;

/** La caja de taquilla con su efectivo, las solicitudes confirmadas por pagar y las pagadas hoy. */
export async function obtenerTaquilla() {
  const caja = await cajaDeTaquilla();
  const saldos = await pool.query(
    `SELECT m.id AS moneda_id, m.codigo, m.decimales, COALESCE(s.monto, 0) AS monto
     FROM monedas m LEFT JOIN saldos_caja s ON s.moneda_id = m.id AND s.caja_id = $1
     WHERE m.codigo = ANY($2::text[])
     ORDER BY array_position($2::text[], m.codigo::text)`,
    [caja.id, MONEDAS_TAQUILLA]
  );
  const pendientes = await pool.query(`${SELECT_SOLICITUD} AND mc.pagado_en IS NULL ORDER BY mc.fecha, mc.id`);
  const pagadasHoy = await pool.query(
    `${SELECT_SOLICITUD} AND (mc.pagado_en AT TIME ZONE '${ZONA}')::date = (now() AT TIME ZONE '${ZONA}')::date ORDER BY mc.pagado_en DESC`
  );
  return { caja: { ...caja, saldos: saldos.rows }, pendientes: pendientes.rows, pagadasHoy: pagadasHoy.rows };
}

/**
 * Sumar o descontar efectivo de la caja de taquilla (iniciar el día, reponer, retirar).
 * monto con signo: + entra, - sale. No deja la caja en negativo.
 */
export async function moverCajaTaquilla(input: { monedaCodigo: string; monto: string; usuarioId: number }) {
  if (!MONEDAS_TAQUILLA.includes(input.monedaCodigo)) throw errorHttp("La caja de taquilla solo maneja pesos, dólares y euros", 400);
  let monto: Decimal;
  try {
    monto = new Decimal(input.monto);
  } catch {
    throw errorHttp("El monto no es un número válido", 400);
  }
  if (!monto.isFinite() || monto.isZero()) throw errorHttp("El monto no puede ser cero", 400);

  const caja = await cajaDeTaquilla();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const moneda = await client.query(`SELECT id FROM monedas WHERE codigo = $1`, [input.monedaCodigo]);
    if (!moneda.rows[0]) throw errorHttp("Moneda no encontrada", 404);
    const monedaId = moneda.rows[0].id as number;
    await abrirTurnoSiFalta(client, caja.id, monedaId, input.usuarioId);

    const saldo = await client.query(`SELECT id, monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`, [caja.id, monedaId]);
    const anterior = new Decimal(saldo.rows[0]?.monto ?? 0);
    const nuevo = anterior.plus(monto);
    if (nuevo.isNegative()) throw errorHttp("La caja no tiene tanto para descontar", 409);
    if (saldo.rows[0]) await client.query(`UPDATE saldos_caja SET monto = $1 WHERE id = $2`, [nuevo.toFixed(4), saldo.rows[0].id]);
    else await client.query(`INSERT INTO saldos_caja (caja_id, moneda_id, monto) VALUES ($1, $2, $3)`, [caja.id, monedaId, nuevo.toFixed(4)]);

    await client.query(
      `INSERT INTO movimientos_caja (caja_id, moneda_id, tipo, monto, saldo_anterior, saldo_nuevo, usuario_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [caja.id, monedaId, monto.isPositive() ? "INGRESO" : "EGRESO", monto.abs().toFixed(4), anterior.toFixed(4), nuevo.toFixed(4), input.usuarioId]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return obtenerTaquilla();
}

/**
 * "Se pagó": al cliente se le entrega su efectivo. Descuenta de la caja de taquilla y deja saldada su cuenta
 * (registra el pago en su hoja). Una solicitud no se paga dos veces.
 */
export async function pagarSolicitud(movimientoId: number, usuarioId: number) {
  const caja = await cajaDeTaquilla();
  // Se aparta primero: si dos personas tocan "Se pagó" a la vez, solo una sigue
  const apartada = await pool.query(
    `UPDATE movimientos_cuenta_corriente mc SET pagado_en = now(), pagado_por = $2
     FROM cuentas_corrientes cc
     WHERE mc.id = $1 AND cc.id = mc.cuenta_corriente_id AND cc.modulo = 'CAJA'
       AND mc.estado_confirmacion = 'CONFIRMADA' AND NOT mc.anulado AND mc.monto > 0 AND mc.pagado_en IS NULL
     RETURNING mc.id, mc.monto, mc.descripcion, cc.tercero_id, cc.canal_id, cc.moneda_id`,
    [movimientoId, usuarioId]
  );
  const s = apartada.rows[0];
  if (!s) throw errorHttp("Esa solicitud no está por pagar: ya se pagó, se anuló o todavía no está confirmada", 409);

  try {
    const referencia = String(s.descripcion ?? "").split(" · ")[1];
    const pago = await registrarMovimientoCuentaCorriente({
      terceroId: s.tercero_id,
      canalId: s.canal_id,
      monedaId: s.moneda_id,
      tipo: "ABONO",
      monto: new Decimal(s.monto).negated().toFixed(4),
      descripcion: `Pago en taquilla${referencia ? ` · ${referencia}` : ""}`,
      usuarioId,
      // el efectivo sale de la caja de taquilla, en la moneda de la cuenta del cliente
      cajaId: caja.id,
      montoCaja: new Decimal(s.monto).negated().toFixed(4),
      monedaCajaId: s.moneda_id,
    });
    await pool.query(`UPDATE movimientos_cuenta_corriente SET pagado_movimiento_id = $1 WHERE id = $2`, [pago.movimiento.id, movimientoId]);
  } catch (err) {
    // no se pudo pagar (p. ej. la caja no tiene tanto): la solicitud vuelve a quedar por pagar
    await pool.query(`UPDATE movimientos_cuenta_corriente SET pagado_en = NULL, pagado_por = NULL WHERE id = $1`, [movimientoId]);
    throw err;
  }
  return obtenerTaquilla();
}
