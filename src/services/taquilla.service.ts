import { PoolClient } from "pg";
import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { registrarMovimientoCuentaCorriente } from "./cuentaCorriente.service";

const ZONA = "America/Bogota";
// Lo que maneja la caja de taquilla: efectivo en pesos, dólares y euros
const MONEDAS_TAQUILLA = ["COP", "USD", "EUR"] as const;
type CodigoMoneda = (typeof MONEDAS_TAQUILLA)[number];

function errorHttp(mensaje: string, status: number) {
  return Object.assign(new Error(mensaje), { status });
}

function aDecimal(valor: string | undefined, campo: string) {
  try {
    const d = new Decimal(valor ?? "0");
    if (!d.isFinite() || d.isNegative()) throw new Error();
    return d;
  } catch {
    throw errorHttp(`${campo} no es un monto válido`, 400);
  }
}

async function cajaDeTaquilla() {
  const r = await pool.query(`SELECT id, nombre FROM cajas WHERE es_taquilla AND activo ORDER BY id LIMIT 1`);
  if (!r.rows[0]) throw errorHttp("No hay una caja de taquilla configurada", 409);
  return r.rows[0] as { id: number; nombre: string };
}

/** Las monedas de taquilla con su id, en el orden en que se muestran. */
async function monedasDeTaquilla(db: { query: PoolClient["query"] } = pool) {
  const r = await db.query(
    `SELECT id, codigo, decimales FROM monedas WHERE codigo = ANY($1::text[]) ORDER BY array_position($1::text[], codigo::text)`,
    [MONEDAS_TAQUILLA as unknown as string[]]
  );
  return r.rows as { id: number; codigo: CodigoMoneda; decimales: number }[];
}

// Todas las compras de Confirmaciones: lo que hay que entregarle al cliente en efectivo.
// Las que Western todavía no confirmó también llegan, marcadas, y no se pueden pagar hasta que se confirmen.
const SELECT_SOLICITUD = `
  SELECT mc.id, mc.fecha, mc.descripcion, mc.monto, mc.cantidad_base, mc.tasa, mc.comision_descontada, mc.cuenta_destino,
         mc.estado_confirmacion, (mc.comprobante_key IS NOT NULL) AS tiene_comprobante,
         mc.pagado_en, mc.pagado_medio, up.nombre AS pagado_por_nombre, ur.nombre AS registrado_por_nombre,
         cc.id AS cuenta_id, cc.referencia AS cliente_referencia, m.codigo AS moneda_codigo, m.decimales AS moneda_decimales,
         ch.nombre AS canal_nombre,
         t.nombre AS cliente_nombre, t.telefono AS cliente_telefono, t.identificacion AS cliente_cedula
  FROM movimientos_cuenta_corriente mc
  JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id
  JOIN monedas m ON m.id = cc.moneda_id
  JOIN canales_cuenta_corriente ch ON ch.id = cc.canal_id
  JOIN terceros t ON t.id = cc.tercero_id
  JOIN usuarios ur ON ur.id = mc.usuario_id
  LEFT JOIN usuarios up ON up.id = mc.pagado_por
  WHERE cc.modulo = 'CAJA' AND NOT mc.anulado AND mc.monto > 0 AND mc.reverso_de_id IS NULL`;

/**
 * La taquilla: su caja con la sesión del día (con cuánto abrió, cuánto entró y salió, cuánto debe haber),
 * las solicitudes por pagar, las pagadas y el último cuadre.
 */
export async function obtenerTaquilla() {
  const caja = await cajaDeTaquilla();
  const monedas = await monedasDeTaquilla();
  const turnos = await pool.query(
    `SELECT cz.id, cz.moneda_id, cz.fecha_apertura, cz.saldo_inicial, u.nombre AS usuario_nombre
     FROM cierres_caja cz JOIN usuarios u ON u.id = cz.usuario_id
     WHERE cz.caja_id = $1 AND cz.estado = 'ABIERTA'`,
    [caja.id]
  );
  const saldos = await pool.query(`SELECT moneda_id, monto FROM saldos_caja WHERE caja_id = $1`, [caja.id]);
  const abierta = turnos.rows.length > 0;
  const abiertaEn: Date | null = abierta ? turnos.rows.reduce((min: Date, t) => (t.fecha_apertura < min ? t.fecha_apertura : min), turnos.rows[0].fecha_apertura) : null;

  // Lo que entró y salió de la caja desde que abrió (el ajuste de apertura no cuenta: es el saldo inicial)
  const movidos = abierta
    ? await pool.query(
        `SELECT moneda_id, tipo, COALESCE(sum(monto), 0) AS total FROM movimientos_caja
         WHERE caja_id = $1 AND created_at > $2 GROUP BY moneda_id, tipo`,
        [caja.id, abiertaEn]
      )
    : { rows: [] as { moneda_id: number; tipo: string; total: string }[] };

  const porMoneda = monedas.map((m) => {
    const turno = turnos.rows.find((t) => t.moneda_id === m.id);
    const total = (tipo: string) => new Decimal(movidos.rows.find((x) => x.moneda_id === m.id && x.tipo === tipo)?.total ?? 0).toFixed(4);
    return {
      moneda_id: m.id,
      codigo: m.codigo,
      decimales: m.decimales,
      monto: new Decimal(saldos.rows.find((s) => s.moneda_id === m.id)?.monto ?? 0).toFixed(4), // lo que debe haber en caja
      inicial: turno ? new Decimal(turno.saldo_inicial).toFixed(4) : null,
      entradas: total("INGRESO"),
      salidas: total("EGRESO"),
    };
  });

  // El último cuadre: lo que debía haber, lo que se contó y la diferencia, por moneda
  const ultimo = await pool.query(
    `SELECT cz.fecha_apertura, cz.fecha_cierre, cz.saldo_inicial, cz.saldo_esperado, cz.saldo_real, cz.diferencia, m.codigo, u.nombre AS usuario_nombre
     FROM cierres_caja cz JOIN monedas m ON m.id = cz.moneda_id JOIN usuarios u ON u.id = cz.usuario_id
     WHERE cz.caja_id = $1 AND cz.estado = 'CERRADA'
       AND cz.fecha_cierre = (SELECT max(fecha_cierre) FROM cierres_caja WHERE caja_id = $1 AND estado = 'CERRADA')
     ORDER BY array_position($2::text[], m.codigo::text)`,
    [caja.id, MONEDAS_TAQUILLA as unknown as string[]]
  );

  const pendientes = await pool.query(`${SELECT_SOLICITUD} AND mc.pagado_en IS NULL ORDER BY mc.fecha, mc.id`);
  // Pagadas: las de esta sesión de caja; con la caja cerrada, las de hoy
  const pagadas = abierta
    ? await pool.query(`${SELECT_SOLICITUD} AND mc.pagado_en >= $1 ORDER BY mc.pagado_en DESC`, [abiertaEn])
    : await pool.query(`${SELECT_SOLICITUD} AND (mc.pagado_en AT TIME ZONE '${ZONA}')::date = (now() AT TIME ZONE '${ZONA}')::date ORDER BY mc.pagado_en DESC`);

  // Ingresos y egresos de ventanilla: los de esta sesión (o de hoy) y todo lo que siga pendiente de confirmar
  const operaciones = await pool.query(
    `${SELECT_OPERACION}
     WHERE o.estado = 'PENDIENTE' OR ${abierta ? "o.created_at >= $1" : `(o.created_at AT TIME ZONE '${ZONA}')::date = (now() AT TIME ZONE '${ZONA}')::date`}
     ORDER BY o.id DESC`,
    abierta ? [abiertaEn] : []
  );

  // Pagos hechos por Bancolombia en el mismo período: cuántos y cuánto. No tocan la caja.
  const porBanco = pagadas.rows.filter((s) => s.pagado_medio === "BANCOLOMBIA");
  const totalesBanco = new Map<string, Decimal>();
  for (const s of porBanco) totalesBanco.set(s.moneda_codigo, (totalesBanco.get(s.moneda_codigo) ?? new Decimal(0)).plus(s.monto));

  return {
    operaciones: operaciones.rows,
    pagosBancolombia: { cantidad: porBanco.length, totales: [...totalesBanco.entries()].map(([codigo, total]) => ({ codigo, total: total.toFixed(4) })) },
    caja: { ...caja, saldos: porMoneda },
    sesion: { abierta, abierta_en: abiertaEn, abierta_por: abierta ? (turnos.rows[0].usuario_nombre as string) : null },
    ultimoCierre: ultimo.rows.length
      ? { cerrada_en: ultimo.rows[0].fecha_cierre, abierta_en: ultimo.rows[0].fecha_apertura, por: ultimo.rows[0].usuario_nombre, monedas: ultimo.rows }
      : null,
    pendientes: pendientes.rows,
    pagadasHoy: pagadas.rows,
  };
}

/** Deja el saldo de la caja en `nuevo` y anota el movimiento por la diferencia. */
async function fijarSaldo(client: PoolClient, cajaId: number, monedaId: number, nuevo: Decimal, usuarioId: number) {
  const saldo = await client.query(`SELECT id, monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`, [cajaId, monedaId]);
  const anterior = new Decimal(saldo.rows[0]?.monto ?? 0);
  if (saldo.rows[0]) await client.query(`UPDATE saldos_caja SET monto = $1 WHERE id = $2`, [nuevo.toFixed(4), saldo.rows[0].id]);
  else await client.query(`INSERT INTO saldos_caja (caja_id, moneda_id, monto) VALUES ($1, $2, $3)`, [cajaId, monedaId, nuevo.toFixed(4)]);
  const diferencia = nuevo.minus(anterior);
  if (!diferencia.isZero()) {
    await client.query(
      `INSERT INTO movimientos_caja (caja_id, moneda_id, tipo, monto, saldo_anterior, saldo_nuevo, usuario_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [cajaId, monedaId, diferencia.isPositive() ? "INGRESO" : "EGRESO", diferencia.abs().toFixed(4), anterior.toFixed(4), nuevo.toFixed(4), usuarioId]
    );
  }
}

/**
 * Abrir la caja de taquilla: se declara con cuánto efectivo arranca en pesos, dólares y euros.
 * La caja queda en esos montos y desde ahí se va sumando y descontando todo hasta el cuadre.
 */
export async function abrirSesionTaquilla(input: { montos: Partial<Record<CodigoMoneda, string>>; usuarioId: number }) {
  const caja = await cajaDeTaquilla();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const abierta = await client.query(`SELECT 1 FROM cierres_caja WHERE caja_id = $1 AND estado = 'ABIERTA' LIMIT 1`, [caja.id]);
    if (abierta.rows.length) throw errorHttp("La caja de taquilla ya está abierta", 409);
    for (const m of await monedasDeTaquilla(client)) {
      const inicial = aDecimal(input.montos[m.codigo], `El monto inicial en ${m.codigo}`);
      await fijarSaldo(client, caja.id, m.id, inicial, input.usuarioId);
      await client.query(
        `INSERT INTO cierres_caja (caja_id, moneda_id, usuario_id, fecha_apertura, saldo_inicial, estado) VALUES ($1, $2, $3, now(), $4, 'ABIERTA')`,
        [caja.id, m.id, input.usuarioId, inicial.toFixed(4)]
      );
    }
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
 * Cerrar y cuadrar: se cuenta el efectivo de cada moneda y se compara con lo que debía haber.
 * Queda guardado lo esperado, lo contado y la diferencia (contado - esperado).
 */
export async function cerrarSesionTaquilla(input: { contado: Partial<Record<CodigoMoneda, string>>; usuarioId: number }) {
  const caja = await cajaDeTaquilla();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // FOR UPDATE espera a que terminen los pagos en curso
    const turnos = await client.query(`SELECT id, moneda_id FROM cierres_caja WHERE caja_id = $1 AND estado = 'ABIERTA' FOR UPDATE`, [caja.id]);
    if (!turnos.rows.length) throw errorHttp("La caja de taquilla no está abierta", 409);
    for (const m of await monedasDeTaquilla(client)) {
      const turno = turnos.rows.find((t) => t.moneda_id === m.id);
      if (!turno) continue;
      const real = aDecimal(input.contado[m.codigo], `Lo contado en ${m.codigo}`);
      const saldo = await client.query(`SELECT monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2`, [caja.id, m.id]);
      const esperado = new Decimal(saldo.rows[0]?.monto ?? 0);
      await client.query(
        `UPDATE cierres_caja SET fecha_cierre = now(), saldo_esperado = $1, saldo_real = $2, diferencia = $3, estado = 'CERRADA' WHERE id = $4`,
        [esperado.toFixed(4), real.toFixed(4), real.minus(esperado).toFixed(4), turno.id]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return obtenerTaquilla();
}

/** ¿Está abierta la caja de taquilla en esa moneda? */
async function exigirSesion(cajaId: number, monedaId: number) {
  const r = await pool.query(`SELECT 1 FROM cierres_caja WHERE caja_id = $1 AND moneda_id = $2 AND estado = 'ABIERTA'`, [cajaId, monedaId]);
  if (!r.rows.length) throw errorHttp("Primero hay que abrir la caja de taquilla", 409);
}

/**
 * Sumar o descontar efectivo de la caja con la sesión abierta (reponer, retirar).
 * monto con signo: + entra, - sale. No deja la caja en negativo.
 */
export async function moverCajaTaquilla(input: { monedaCodigo: string; monto: string; usuarioId: number }) {
  let monto: Decimal;
  try {
    monto = new Decimal(input.monto);
  } catch {
    throw errorHttp("El monto no es un número válido", 400);
  }
  if (!monto.isFinite() || monto.isZero()) throw errorHttp("El monto no puede ser cero", 400);

  const caja = await cajaDeTaquilla();
  const moneda = (await monedasDeTaquilla()).find((m) => m.codigo === input.monedaCodigo);
  if (!moneda) throw errorHttp("La caja de taquilla solo maneja pesos, dólares y euros", 400);
  await exigirSesion(caja.id, moneda.id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const saldo = await client.query(`SELECT monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`, [caja.id, moneda.id]);
    const nuevo = new Decimal(saldo.rows[0]?.monto ?? 0).plus(monto);
    if (nuevo.isNegative()) throw errorHttp("La caja no tiene tanto para descontar", 409);
    await fijarSaldo(client, caja.id, moneda.id, nuevo, input.usuarioId);
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
 * "Se pagó": al cliente se le entrega lo suyo y su cuenta queda saldada (se registra el pago en su hoja).
 *   EFECTIVO:    sale de la caja de taquilla (tiene que estar abierta y tener con qué).
 *   BANCOLOMBIA: se le transfirió; no toca la caja, solo queda contado como pago por Bancolombia.
 * Una solicitud no se paga dos veces, ni antes de que esté confirmada.
 */
export async function pagarSolicitud(movimientoId: number, usuarioId: number, medio: "EFECTIVO" | "BANCOLOMBIA" = "EFECTIVO") {
  const enEfectivo = medio === "EFECTIVO";
  const caja = await cajaDeTaquilla();
  const previa = await pool.query(
    `SELECT mc.estado_confirmacion, mc.pagado_en, cc.moneda_id, m.codigo AS moneda_codigo
     FROM movimientos_cuenta_corriente mc JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id JOIN monedas m ON m.id = cc.moneda_id
     WHERE mc.id = $1 AND cc.modulo = 'CAJA' AND NOT mc.anulado AND mc.monto > 0`,
    [movimientoId]
  );
  const p = previa.rows[0];
  if (!p) throw errorHttp("Solicitud no encontrada", 404);
  if (p.pagado_en) throw errorHttp("Esa solicitud ya se pagó", 409);
  if (p.estado_confirmacion === "EN_PROCESO") throw errorHttp("Esa transferencia todavía no está confirmada: se confirma en Confirmaciones y después se paga", 409);
  if (enEfectivo) {
    if (!(MONEDAS_TAQUILLA as readonly string[]).includes(p.moneda_codigo)) {
      throw errorHttp(`Esa solicitud se paga en ${p.moneda_codigo} y la caja de taquilla solo maneja pesos, dólares y euros`, 409);
    }
    await exigirSesion(caja.id, p.moneda_id);
  }

  // Se aparta primero: si dos personas tocan "Se pagó" a la vez, solo una sigue
  const apartada = await pool.query(
    `UPDATE movimientos_cuenta_corriente mc SET pagado_en = now(), pagado_por = $2, pagado_medio = $3
     FROM cuentas_corrientes cc
     WHERE mc.id = $1 AND cc.id = mc.cuenta_corriente_id AND mc.pagado_en IS NULL AND NOT mc.anulado
     RETURNING mc.id, mc.monto, mc.descripcion, cc.tercero_id, cc.canal_id, cc.moneda_id`,
    [movimientoId, usuarioId, medio]
  );
  const s = apartada.rows[0];
  if (!s) throw errorHttp("Esa solicitud ya se pagó", 409);

  try {
    const referencia = String(s.descripcion ?? "").split(" · ")[1];
    const pago = await registrarMovimientoCuentaCorriente({
      terceroId: s.tercero_id,
      canalId: s.canal_id,
      monedaId: s.moneda_id,
      tipo: "ABONO",
      monto: new Decimal(s.monto).negated().toFixed(4),
      descripcion: `${enEfectivo ? "Pago en taquilla" : "Pago por Bancolombia"}${referencia ? ` · ${referencia}` : ""}`,
      usuarioId,
      // en efectivo sale de la caja de taquilla, en la moneda de la cuenta del cliente; por Bancolombia la caja no se toca
      ...(enEfectivo ? { cajaId: caja.id, montoCaja: new Decimal(s.monto).negated().toFixed(4), monedaCajaId: s.moneda_id } : {}),
    });
    await pool.query(`UPDATE movimientos_cuenta_corriente SET pagado_movimiento_id = $1 WHERE id = $2`, [pago.movimiento.id, movimientoId]);
  } catch (err) {
    // no se pudo pagar (p. ej. la caja no tiene tanto): la solicitud vuelve a quedar por pagar
    await pool.query(`UPDATE movimientos_cuenta_corriente SET pagado_en = NULL, pagado_por = NULL, pagado_medio = NULL WHERE id = $1`, [movimientoId]);
    throw err;
  }
  return obtenerTaquilla();
}

// ---------- Ingresos y egresos de ventanilla ----------
const SELECT_OPERACION = `
  SELECT o.id, o.tipo, o.cantidad, o.tasa, o.comision_pct, o.divide, o.moneda_operacion, o.medio, o.resultado, o.moneda_resultado, o.caja_lado, o.total, o.descripcion, o.cliente_nombre, o.cliente_telefono, o.cliente_cedula,
         o.estado, o.created_at, o.confirmado_en, m.codigo AS moneda_codigo, u.nombre AS usuario_nombre, uc.nombre AS confirmado_por_nombre
  FROM operaciones_taquilla o
  JOIN monedas m ON m.id = o.moneda_id
  JOIN usuarios u ON u.id = o.usuario_id
  LEFT JOIN usuarios uc ON uc.id = o.confirmado_por`;

/** Suma (delta > 0) o descuenta (delta < 0) de la caja, sin dejarla en negativo. Dentro de una transacción. */
async function aplicarACaja(client: PoolClient, cajaId: number, monedaId: number, delta: Decimal, usuarioId: number) {
  const abierta = await client.query(`SELECT 1 FROM cierres_caja WHERE caja_id = $1 AND moneda_id = $2 AND estado = 'ABIERTA' FOR SHARE`, [cajaId, monedaId]);
  if (!abierta.rows.length) throw errorHttp("Primero hay que abrir la caja de taquilla", 409);
  const saldo = await client.query(`SELECT monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`, [cajaId, monedaId]);
  const nuevo = new Decimal(saldo.rows[0]?.monto ?? 0).plus(delta);
  if (nuevo.isNegative()) throw errorHttp("La caja no tiene tanto para ese egreso", 409);
  await fijarSaldo(client, cajaId, monedaId, nuevo, usuarioId);
}

interface OperacionInput {
  tipo: "INGRESO" | "EGRESO";
  cantidad: string; // lo que trae el cliente o se negocia (ej. 100.000 pesos, o 100.000 bolívares)
  monedaOperacion: string; // en qué está esa cantidad: VES, USD, USDT, EUR, COP
  tasa?: string; // cantidad x tasa = resultado (o cantidad ÷ tasa si dividir)
  dividir?: boolean;
  comisionPct?: string; // % que se descuenta
  monedaResultado: string; // en qué queda el resultado
  // qué lado mueve la caja: lo que trae el cliente (MONTO) o lo que sale de la cuenta (RESULTADO)
  cajaLado: "MONTO" | "RESULTADO";
  medio?: "EFECTIVO" | "BANCOLOMBIA"; // por Bancolombia es transferencia: no mueve la caja
  descripcion?: string;
  clienteNombre?: string;
  clienteTelefono?: string;
  clienteCedula?: string;
  confirmada?: boolean; // un ingreso ya confirmado suma a la caja de una vez
  usuarioId: number;
}

/**
 * Registra un ingreso o egreso de ventanilla, que puede ser una conversión:
 *   me venden 100.000 Bs a 3,3  -> 100.000 Bs × 3,3 = $330.000   (la caja se mueve por el resultado, en pesos)
 *   trae $100.000 y quiere Bs   -> $100.000 ÷ 3,3 = Bs 30.303    (la caja se mueve por lo que trae, en pesos)
 * El egreso descuenta de la caja al registrarlo. El ingreso queda pendiente y suma cuando se confirma
 * (o de una vez si llega ya confirmado). Por Bancolombia nunca toca la caja.
 */
export async function crearOperacionTaquilla(input: OperacionInput) {
  const caja = await cajaDeTaquilla();
  const cantidad = aDecimal(input.cantidad, "El monto");
  if (cantidad.isZero()) throw errorHttp("El monto no puede ser cero", 400);
  const tasa = input.tasa?.trim() ? aDecimal(input.tasa, "La tasa") : null;
  if (tasa && tasa.isZero()) throw errorHttp("La tasa no puede ser cero", 400);
  if (input.dividir && !tasa) throw errorHttp("Para dividir hace falta la tasa", 400);
  const comision = input.comisionPct?.trim() ? aDecimal(input.comisionPct, "La comisión") : null;
  if (comision && comision.gte(100)) throw errorHttp("La comisión tiene que ser menor al 100%", 400);

  const codigoOperacion = input.monedaOperacion.trim().toUpperCase();
  const codigoResultado = input.monedaResultado.trim().toUpperCase();
  const monedas = await pool.query(`SELECT id, codigo, decimales FROM monedas WHERE codigo = ANY($1::text[])`, [[codigoOperacion, codigoResultado]]);
  const monedaDe = (codigo: string) => monedas.rows.find((m) => m.codigo === codigo) as { id: number; codigo: string; decimales: number } | undefined;
  const monedaResultado = monedaDe(codigoResultado);
  const monedaOperacion = monedaDe(codigoOperacion);
  if (!monedaResultado || !monedaOperacion) throw errorHttp("Moneda no encontrada", 400);

  const resultado = (input.dividir && tasa ? cantidad.div(tasa) : cantidad.times(tasa ?? 1))
    .times(new Decimal(1).minus((comision ?? new Decimal(0)).div(100)))
    .toDecimalPlaces(Number(monedaResultado.decimales), Decimal.ROUND_HALF_UP);
  if (!resultado.isPositive()) throw errorHttp("El resultado da cero: revisá el monto y la tasa o la comisión", 400);

  // Lo que mueve la caja: lo que trae el cliente o lo que resulta
  const monedaCaja = input.cajaLado === "MONTO" ? monedaOperacion : monedaResultado;
  const total = input.cajaLado === "MONTO" ? cantidad.toDecimalPlaces(Number(monedaOperacion.decimales), Decimal.ROUND_HALF_UP) : resultado;

  // El egreso queda hecho ya; el ingreso, solo si viene confirmado. Por Bancolombia es transferencia: nunca mueve la caja
  const aplica = input.tipo === "EGRESO" || !!input.confirmada;
  const medio = input.medio ?? "EFECTIVO";
  const tocaCaja = medio === "EFECTIVO";
  if (tocaCaja && !(MONEDAS_TAQUILLA as readonly string[]).includes(monedaCaja.codigo)) {
    throw errorHttp(`La caja de taquilla solo maneja pesos, dólares y euros: no puede moverse en ${monedaCaja.codigo}`, 400);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (aplica && tocaCaja) await aplicarACaja(client, caja.id, monedaCaja.id, input.tipo === "INGRESO" ? total : total.negated(), input.usuarioId);
    await client.query(
      `INSERT INTO operaciones_taquilla
        (tipo, moneda_id, cantidad, tasa, comision_pct, total, descripcion, cliente_nombre, cliente_telefono, cliente_cedula, estado, usuario_id,
         confirmado_en, confirmado_por, moneda_operacion, divide, medio, resultado, moneda_resultado, caja_lado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $13 THEN now() END, CASE WHEN $13 THEN $12::int END, $14, $15, $16, $17, $18, $19)`,
      [
        input.tipo, monedaCaja.id, cantidad.toFixed(4), tasa?.toFixed(8) ?? null, comision?.toFixed(4) ?? null, total.toFixed(4),
        input.descripcion?.trim() || null, input.clienteNombre?.trim() || null, input.clienteTelefono?.trim() || null, input.clienteCedula?.trim() || null,
        aplica ? "CONFIRMADA" : "PENDIENTE", input.usuarioId, aplica,
        codigoOperacion, !!(input.dividir && tasa), medio, resultado.toFixed(4), codigoResultado, input.cajaLado,
      ]
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

/** Confirmar un ingreso pendiente: recién ahí suma a la caja. */
export async function confirmarOperacionTaquilla(id: number, usuarioId: number) {
  const caja = await cajaDeTaquilla();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(`SELECT * FROM operaciones_taquilla WHERE id = $1 FOR UPDATE`, [id]);
    const o = r.rows[0];
    if (!o) throw errorHttp("Operación no encontrada", 404);
    if (o.estado !== "PENDIENTE") throw errorHttp("Esa operación ya no está pendiente", 409);
    // por Bancolombia se confirma sin tocar la caja
    if (o.medio === "EFECTIVO") await aplicarACaja(client, caja.id, o.moneda_id, o.tipo === "INGRESO" ? new Decimal(o.total) : new Decimal(o.total).negated(), usuarioId);
    await client.query(`UPDATE operaciones_taquilla SET estado = 'CONFIRMADA', confirmado_en = now(), confirmado_por = $2 WHERE id = $1`, [id, usuarioId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return obtenerTaquilla();
}

/** Descartar un ingreso pendiente (todavía no había tocado la caja). */
export async function anularOperacionTaquilla(id: number) {
  const r = await pool.query(`UPDATE operaciones_taquilla SET estado = 'ANULADA' WHERE id = $1 AND estado = 'PENDIENTE' RETURNING id`, [id]);
  if (!r.rows[0]) throw errorHttp("Solo se puede anular una operación que siga pendiente", 409);
  return obtenerTaquilla();
}
