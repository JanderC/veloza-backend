import { AsyncLocalStorage } from "async_hooks";
import { PoolClient } from "pg";
import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { registrarMovimientoCuentaCorriente } from "./cuentaCorriente.service";
import { abrirTurnoSiFalta } from "./cierreCaja.service";
import { aplicarMovimientoLeg } from "./transaccionService";
import { generarUrlTemporal, subirArchivo } from "./almacenamiento.service";

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

// Hay varias taquillas (1, 2 y 3) que trabajan igual, cada una con su caja. Todo lo de este archivo corre
// para la taquilla que eligió la ruta (/taquilla, /taquilla-2, /taquilla-3); sin contexto es la 1.
const taquillaActual = new AsyncLocalStorage<number>();
export function enTaquilla<T>(numero: number, fn: () => Promise<T>) {
  return taquillaActual.run(numero, fn);
}

async function cajaDeTaquilla() {
  const numero = taquillaActual.getStore() ?? 1;
  const r = await pool.query(`SELECT id, nombre FROM cajas WHERE taquilla_numero = $1 AND activo`, [numero]);
  if (!r.rows[0]) throw errorHttp(`No hay una caja configurada para la taquilla ${numero}`, 409);
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
  SELECT mc.id, mc.fecha, mc.descripcion, mc.monto, mc.cantidad_base, mc.tasa, mc.comision_descontada, mc.comision_incluida, mc.cuenta_destino,
         mc.estado_confirmacion, (mc.comprobante_key IS NOT NULL) AS tiene_comprobante,
         mc.pagado_en, mc.pagado_medio, mc.pagado_caja_id, cp.nombre AS pagado_caja_nombre, up.nombre AS pagado_por_nombre, ur.nombre AS registrado_por_nombre,
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
  LEFT JOIN cajas cp ON cp.id = mc.pagado_caja_id
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
  // Pagadas por esta taquilla: las de esta sesión de caja; con la caja cerrada, las de hoy.
  // (Las por pagar se ven en las dos taquillas: la que la paga se la queda.)
  const pagadas = abierta
    ? await pool.query(`${SELECT_SOLICITUD} AND mc.pagado_caja_id = $1 AND mc.pagado_en >= $2 ORDER BY mc.pagado_en DESC`, [caja.id, abiertaEn])
    : await pool.query(
        `${SELECT_SOLICITUD} AND mc.pagado_caja_id = $1 AND (mc.pagado_en AT TIME ZONE '${ZONA}')::date = (now() AT TIME ZONE '${ZONA}')::date ORDER BY mc.pagado_en DESC`,
        [caja.id]
      );

  // Ingresos y egresos de ventanilla: los de esta sesión (o de hoy) y todo lo que siga pendiente de confirmar
  const operaciones = await pool.query(
    `${SELECT_OPERACION}
     WHERE o.caja_id = $1 AND (o.estado = 'PENDIENTE' OR ${abierta ? "o.created_at >= $2" : `(o.created_at AT TIME ZONE '${ZONA}')::date = (now() AT TIME ZONE '${ZONA}')::date`})
     ORDER BY o.id DESC`,
    abierta ? [caja.id, abiertaEn] : [caja.id]
  );

  // Pagos hechos por Bancolombia en el mismo período: cuántos y cuánto. No tocan la caja.
  // Lo mismo los pagados por otros métodos.
  const resumenDe = (medio: string) => {
    const filas = pagadas.rows.filter((s) => s.pagado_medio === medio);
    const totales = new Map<string, Decimal>();
    for (const s of filas) totales.set(s.moneda_codigo, (totales.get(s.moneda_codigo) ?? new Decimal(0)).plus(s.monto));
    return { cantidad: filas.length, totales: [...totales.entries()].map(([codigo, total]) => ({ codigo, total: total.toFixed(4) })) };
  };

  // La Caja Fuerte alimenta a la taquilla y recibe lo que queda al cerrar: se muestra cuánto tiene
  const fuerte = await cajaFuerte();
  const saldosFuerte = await pool.query(`SELECT moneda_id, monto FROM saldos_caja WHERE caja_id = $1`, [fuerte.id]);

  return {
    cajaFuerte: {
      ...fuerte,
      saldos: monedas.map((m) => ({ codigo: m.codigo, monto: new Decimal(saldosFuerte.rows.find((s) => s.moneda_id === m.id)?.monto ?? 0).toFixed(4) })),
    },
    operaciones: operaciones.rows,
    pagosBancolombia: resumenDe("BANCOLOMBIA"),
    pagosOtros: resumenDe("OTROS"),
    caja: { ...caja, saldos: porMoneda },
    sesion: { abierta, abierta_en: abiertaEn, abierta_por: abierta ? (turnos.rows[0].usuario_nombre as string) : null },
    ultimoCierre: ultimo.rows.length
      ? { cerrada_en: ultimo.rows[0].fecha_cierre, abierta_en: ultimo.rows[0].fecha_apertura, por: ultimo.rows[0].usuario_nombre, monedas: ultimo.rows }
      : null,
    pendientes: pendientes.rows,
    pagadasHoy: pagadas.rows,
  };
}

/**
 * Solicitudes ya pagadas que coinciden con lo buscado (referencia, nombre, cédula o teléfono), en cualquiera de las
 * dos taquillas y de cualquier día. Es la protección entre taquillas: si alguien viene a retirar una referencia
 * que ya se pagó en la otra, acá sale dónde, cuándo y quién la pagó.
 */
export async function buscarSolicitudesPagadas(texto: string) {
  const q = texto.trim();
  if (q.length < 3) return [];
  const r = await pool.query(
    `${SELECT_SOLICITUD} AND mc.pagado_en IS NOT NULL
       AND position(lower($1) in lower(concat_ws(' ', t.nombre, t.telefono, t.identificacion, mc.descripcion, cc.referencia))) > 0
     ORDER BY mc.pagado_en DESC LIMIT 15`,
    [q]
  );
  return r.rows;
}

/** "Esa solicitud ya se pagó en Taquilla 1 el 06/10 3:15 p. m.": dónde y cuándo se pagó, para el que intenta pagarla otra vez. */
async function mensajeYaPagada(movimientoId: number) {
  const r = await pool.query(
    `SELECT mc.pagado_en, mc.pagado_medio, c.nombre AS caja, u.nombre AS usuario
     FROM movimientos_cuenta_corriente mc LEFT JOIN cajas c ON c.id = mc.pagado_caja_id LEFT JOIN usuarios u ON u.id = mc.pagado_por WHERE mc.id = $1`,
    [movimientoId]
  );
  const p = r.rows[0];
  if (!p?.pagado_en) return "Esa solicitud ya se pagó";
  const cuando = new Date(p.pagado_en).toLocaleString("es-CO", { timeZone: ZONA, day: "2-digit", month: "2-digit", hour: "numeric", minute: "2-digit" });
  return `Esa solicitud ya se pagó${p.caja ? ` en ${p.caja}` : ""}${p.pagado_medio === "BANCOLOMBIA" ? " por Bancolombia" : p.pagado_medio === "OTROS" ? " por otros métodos" : ""} el ${cuando}${p.usuario ? ` (${p.usuario})` : ""}: no se puede retirar otra vez`;
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

/** La Caja Fuerte: de ahí sale el efectivo con que arranca la taquilla y ahí vuelve al cerrar. */
async function cajaFuerte() {
  const r = await pool.query(`SELECT id, nombre FROM cajas WHERE tipo = 'FUERTE' AND activo ORDER BY es_principal DESC, id LIMIT 1`);
  if (!r.rows[0]) throw errorHttp("No hay una Caja Fuerte configurada", 409);
  return r.rows[0] as { id: number; nombre: string };
}

/**
 * Pasa efectivo de una caja a otra dentro de una transacción ya abierta. Queda registrado como transferencia interna,
 * igual que las que se hacen desde el módulo Cajas. Abre el turno de cada caja en esa moneda si hacía falta.
 */
async function pasarEntreCajas(
  client: PoolClient,
  p: { origen: { id: number; nombre: string }; destino: { id: number; nombre: string }; monedaId: number; codigo: string; monto: Decimal; usuarioId: number; observacion: string }
) {
  if (!p.monto.isPositive()) return;
  await abrirTurnoSiFalta(client, p.origen.id, p.monedaId, p.usuarioId);
  await abrirTurnoSiFalta(client, p.destino.id, p.monedaId, p.usuarioId);
  // Bloqueo en orden fijo, como en las transferencias del módulo Cajas
  await client.query(`SELECT id FROM saldos_caja WHERE moneda_id = $1 AND caja_id = ANY($2::int[]) ORDER BY caja_id FOR UPDATE`, [p.monedaId, [p.origen.id, p.destino.id]]);
  const tx = await client.query(
    `INSERT INTO transacciones
      (tipo, estado, caja_id, caja_destino_id, moneda_origen_id, monto_origen, moneda_destino_id, monto_destino, usuario_id, confirmada_en, confirmado_por_id, observacion)
     VALUES ('TRANSFERENCIA_INTERNA', 'CONFIRMADA', $1, $2, $3, $4, $3, $4, $5, now(), $5, $6) RETURNING id`,
    [p.origen.id, p.destino.id, p.monedaId, p.monto.toFixed(4), p.usuarioId, p.observacion]
  );
  try {
    await aplicarMovimientoLeg(client, { cajaId: p.origen.id, monedaId: p.monedaId, tipo: "EGRESO", monto: p.monto, transaccionId: tx.rows[0].id, usuarioId: p.usuarioId });
  } catch (err) {
    if (/saldo insuficiente/i.test((err as Error).message)) throw errorHttp(`${p.origen.nombre} no tiene tanto en ${p.codigo}`, 409);
    throw err;
  }
  await aplicarMovimientoLeg(client, { cajaId: p.destino.id, monedaId: p.monedaId, tipo: "INGRESO", monto: p.monto, transaccionId: tx.rows[0].id, usuarioId: p.usuarioId });
}

/**
 * Abrir la caja de taquilla: se declara con cuánto efectivo arranca en pesos, dólares y euros.
 * desdeCajaFuerte: ese efectivo sale de la Caja Fuerte (se transfiere lo que falte, o se devuelve lo que sobre).
 * Si no, la caja queda directamente en lo declarado. Desde ahí se va sumando y descontando todo hasta el cuadre.
 */
export async function abrirSesionTaquilla(input: { montos: Partial<Record<CodigoMoneda, string>>; desdeCajaFuerte?: boolean; usuarioId: number }) {
  const caja = await cajaDeTaquilla();
  const fuerte = await cajaFuerte();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const abierta = await client.query(`SELECT 1 FROM cierres_caja WHERE caja_id = $1 AND estado = 'ABIERTA' LIMIT 1`, [caja.id]);
    if (abierta.rows.length) throw errorHttp("La caja de taquilla ya está abierta", 409);
    for (const m of await monedasDeTaquilla(client)) {
      const inicial = aDecimal(input.montos[m.codigo], `El monto inicial en ${m.codigo}`);
      if (input.desdeCajaFuerte) {
        const saldo = await client.query(`SELECT monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2`, [caja.id, m.id]);
        const falta = inicial.minus(saldo.rows[0]?.monto ?? 0);
        const base = { monedaId: m.id, codigo: m.codigo, usuarioId: input.usuarioId };
        if (falta.isPositive()) await pasarEntreCajas(client, { ...base, origen: fuerte, destino: caja, monto: falta, observacion: `Apertura de ${caja.nombre}` });
        else if (falta.isNegative()) await pasarEntreCajas(client, { ...base, origen: caja, destino: fuerte, monto: falta.abs(), observacion: `Apertura de ${caja.nombre}: sobrante` });
      } else {
        await fijarSaldo(client, caja.id, m.id, inicial, input.usuarioId);
      }
      // el turno de esa moneda arranca con lo declarado (si la transferencia ya lo había abierto, se actualiza)
      await client.query(
        `INSERT INTO cierres_caja (caja_id, moneda_id, usuario_id, fecha_apertura, saldo_inicial, estado) VALUES ($1, $2, $3, now(), $4, 'ABIERTA')
         ON CONFLICT (caja_id, moneda_id) WHERE estado = 'ABIERTA'
         DO UPDATE SET saldo_inicial = EXCLUDED.saldo_inicial, fecha_apertura = EXCLUDED.fecha_apertura, usuario_id = EXCLUDED.usuario_id`,
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
 * Queda guardado lo esperado, lo contado y la diferencia (contado - esperado), y lo contado pasa a la Caja Fuerte:
 * la taquilla termina el día en cero.
 */
export async function cerrarSesionTaquilla(input: { contado: Partial<Record<CodigoMoneda, string>>; usuarioId: number }) {
  const caja = await cajaDeTaquilla();
  const fuerte = await cajaFuerte();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const abierta = await client.query(`SELECT 1 FROM cierres_caja WHERE caja_id = $1 AND estado = 'ABIERTA' LIMIT 1`, [caja.id]);
    if (!abierta.rows.length) throw errorHttp("La caja de taquilla no está abierta", 409);
    const monedas = await monedasDeTaquilla(client);
    // todas las monedas se cierran, aunque alguna no se haya movido en el día
    for (const m of monedas) await abrirTurnoSiFalta(client, caja.id, m.id, input.usuarioId);
    // FOR UPDATE espera a que terminen los pagos en curso
    const turnos = await client.query(`SELECT id, moneda_id FROM cierres_caja WHERE caja_id = $1 AND estado = 'ABIERTA' FOR UPDATE`, [caja.id]);
    for (const m of monedas) {
      const turno = turnos.rows.find((t) => t.moneda_id === m.id);
      if (!turno) continue;
      const real = aDecimal(input.contado[m.codigo], `Lo contado en ${m.codigo}`);
      const saldo = await client.query(`SELECT monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2`, [caja.id, m.id]);
      const esperado = new Decimal(saldo.rows[0]?.monto ?? 0);
      // la caja queda en lo que de verdad se contó (la diferencia queda anotada) y eso pasa a la Caja Fuerte
      await fijarSaldo(client, caja.id, m.id, real, input.usuarioId);
      await pasarEntreCajas(client, { origen: caja, destino: fuerte, monedaId: m.id, codigo: m.codigo, monto: real, usuarioId: input.usuarioId, observacion: `Cierre de ${caja.nombre}` });
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

/**
 * Traer efectivo de la Caja Fuerte a la taquilla, o enviárselo. Con la taquilla cerrada también se puede traer:
 * alimentarla la deja abierta en esa moneda.
 */
export async function moverConCajaFuerte(input: { monedaCodigo: string; monto: string; sentido: "TRAER" | "ENVIAR"; usuarioId: number }) {
  const monto = aDecimal(input.monto, "El monto");
  if (monto.isZero()) throw errorHttp("El monto no puede ser cero", 400);
  const caja = await cajaDeTaquilla();
  const fuerte = await cajaFuerte();
  const moneda = (await monedasDeTaquilla()).find((m) => m.codigo === input.monedaCodigo);
  if (!moneda) throw errorHttp("La caja de taquilla solo maneja pesos, dólares y euros", 400);
  const traer = input.sentido === "TRAER";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await pasarEntreCajas(client, {
      origen: traer ? fuerte : caja,
      destino: traer ? caja : fuerte,
      monedaId: moneda.id,
      codigo: moneda.codigo,
      monto,
      usuarioId: input.usuarioId,
      observacion: traer ? `Caja Fuerte alimenta a ${caja.nombre}` : `${caja.nombre} envía a Caja Fuerte`,
    });
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
 * ¿Está abierta la caja de taquilla? Si está abierta pero esa moneda todavía no tenía turno
 * (p. ej. se abrió alimentándola solo en pesos), se abre el de esa moneda.
 */
async function exigirSesion(cajaId: number, monedaId: number, usuarioId: number, db: PoolClient | typeof pool = pool) {
  const r = await db.query(`SELECT moneda_id FROM cierres_caja WHERE caja_id = $1 AND estado = 'ABIERTA'`, [cajaId]);
  if (!r.rows.length) throw errorHttp("Primero hay que abrir la caja de taquilla", 409);
  if (!r.rows.some((t) => t.moneda_id === monedaId)) await abrirTurnoSiFalta(db as PoolClient, cajaId, monedaId, usuarioId);
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
  await exigirSesion(caja.id, moneda.id, input.usuarioId);

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
 *   OTROS:       se le pagó por otro método; tampoco toca la caja, queda contado como pago por otros métodos.
 * Una solicitud no se paga dos veces, ni antes de que esté confirmada.
 */
export async function pagarSolicitud(movimientoId: number, usuarioId: number, medio: "EFECTIVO" | "BANCOLOMBIA" | "OTROS" = "EFECTIVO") {
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
  if (p.pagado_en) throw errorHttp(await mensajeYaPagada(movimientoId), 409);
  if (p.estado_confirmacion === "EN_PROCESO") throw errorHttp("Esa transferencia todavía no está confirmada: se confirma en Confirmaciones y después se paga", 409);
  if (enEfectivo) {
    if (!(MONEDAS_TAQUILLA as readonly string[]).includes(p.moneda_codigo)) {
      throw errorHttp(`Esa solicitud se paga en ${p.moneda_codigo} y la caja de taquilla solo maneja pesos, dólares y euros`, 409);
    }
    await exigirSesion(caja.id, p.moneda_id, usuarioId);
  }

  // Se aparta primero: si dos personas tocan "Se pagó" a la vez, solo una sigue
  const apartada = await pool.query(
    `UPDATE movimientos_cuenta_corriente mc SET pagado_en = now(), pagado_por = $2, pagado_medio = $3, pagado_caja_id = $4
     FROM cuentas_corrientes cc
     WHERE mc.id = $1 AND cc.id = mc.cuenta_corriente_id AND mc.pagado_en IS NULL AND NOT mc.anulado
     RETURNING mc.id, mc.monto, mc.descripcion, cc.tercero_id, cc.canal_id, cc.moneda_id`,
    [movimientoId, usuarioId, medio, caja.id]
  );
  const s = apartada.rows[0];
  if (!s) throw errorHttp(await mensajeYaPagada(movimientoId), 409);

  try {
    const referencia = String(s.descripcion ?? "").split(" · ")[1];
    const pago = await registrarMovimientoCuentaCorriente({
      terceroId: s.tercero_id,
      canalId: s.canal_id,
      monedaId: s.moneda_id,
      tipo: "ABONO",
      monto: new Decimal(s.monto).negated().toFixed(4),
      descripcion: `${enEfectivo ? `Pago en ${caja.nombre.toLowerCase()}` : medio === "OTROS" ? "Pago por otros métodos" : "Pago por Bancolombia"}${referencia ? ` · ${referencia}` : ""}`,
      usuarioId,
      // en efectivo sale de la caja de taquilla, en la moneda de la cuenta del cliente; por Bancolombia la caja no se toca
      ...(enEfectivo ? { cajaId: caja.id, montoCaja: new Decimal(s.monto).negated().toFixed(4), monedaCajaId: s.moneda_id } : {}),
    });
    await pool.query(`UPDATE movimientos_cuenta_corriente SET pagado_movimiento_id = $1 WHERE id = $2`, [pago.movimiento.id, movimientoId]);
  } catch (err) {
    // no se pudo pagar (p. ej. la caja no tiene tanto): la solicitud vuelve a quedar por pagar
    await pool.query(`UPDATE movimientos_cuenta_corriente SET pagado_en = NULL, pagado_por = NULL, pagado_medio = NULL, pagado_caja_id = NULL WHERE id = $1`, [movimientoId]);
    throw err;
  }
  return obtenerTaquilla();
}

// ---------- Ingresos y egresos de ventanilla ----------
const SELECT_OPERACION = `
  SELECT o.id, o.tipo, o.cantidad, o.tasa, o.comision_pct, o.divide, o.moneda_operacion, o.medio, o.resultado, o.moneda_resultado, o.caja_lado, o.total, o.descripcion, o.cliente_nombre, o.cliente_telefono, o.cliente_cedula,
         o.estado, o.created_at, o.confirmado_en, (o.comprobante_key IS NOT NULL) AS tiene_comprobante, m.codigo AS moneda_codigo, u.nombre AS usuario_nombre, uc.nombre AS confirmado_por_nombre
  FROM operaciones_taquilla o
  JOIN monedas m ON m.id = o.moneda_id
  JOIN usuarios u ON u.id = o.usuario_id
  LEFT JOIN usuarios uc ON uc.id = o.confirmado_por`;

/** Suma (delta > 0) o descuenta (delta < 0) de la caja, sin dejarla en negativo. Dentro de una transacción. */
async function aplicarACaja(client: PoolClient, cajaId: number, monedaId: number, delta: Decimal, usuarioId: number) {
  await exigirSesion(cajaId, monedaId, usuarioId, client);
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
  // qué lado mueve la caja: lo que trae el cliente (MONTO), lo que sale de la cuenta (RESULTADO),
  // o los dos (AMBOS: efectivo por efectivo; en un ingreso entra el monto y sale el resultado)
  cajaLado: "MONTO" | "RESULTADO" | "AMBOS";
  // el resultado ya calculado, cuando la cuenta no es una sola tasa (ej. dólares por denominación de billete)
  resultado?: string;
  medio?: "EFECTIVO" | "BANCOLOMBIA" | "OTROS"; // por Bancolombia o por otros métodos no mueve la caja
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

  const resultado = (
    input.resultado?.trim()
      ? aDecimal(input.resultado, "El resultado")
      : (input.dividir && tasa ? cantidad.div(tasa) : cantidad.times(tasa ?? 1)).times(new Decimal(1).minus((comision ?? new Decimal(0)).div(100)))
  ).toDecimalPlaces(Number(monedaResultado.decimales), Decimal.ROUND_HALF_UP);
  if (!resultado.isPositive()) throw errorHttp("El resultado da cero: revisá el monto y la tasa o la comisión", 400);

  // Lo que mueve la caja. El total guardado es el lado del monto (o del resultado si solo ese la mueve)
  const montoRedondeado = cantidad.toDecimalPlaces(Number(monedaOperacion.decimales), Decimal.ROUND_HALF_UP);
  const monedaCaja = input.cajaLado === "RESULTADO" ? monedaResultado : monedaOperacion;
  const total = input.cajaLado === "RESULTADO" ? resultado : montoRedondeado;
  // con signo, por moneda: en un ingreso entra el monto y (si son los dos lados) sale el resultado; en un egreso, al revés
  const signo = input.tipo === "INGRESO" ? 1 : -1;
  const efectos: { moneda: typeof monedaCaja; delta: Decimal }[] =
    input.cajaLado === "AMBOS"
      ? [
          { moneda: monedaOperacion, delta: montoRedondeado.times(signo) },
          { moneda: monedaResultado, delta: resultado.times(-signo) },
        ]
      : [{ moneda: monedaCaja, delta: total.times(signo) }];

  // El egreso queda hecho ya; el ingreso, solo si viene confirmado. Por Bancolombia es transferencia: nunca mueve la caja
  const aplica = input.tipo === "EGRESO" || !!input.confirmada;
  const medio = input.medio ?? "EFECTIVO";
  const tocaCaja = medio === "EFECTIVO";
  const fuera = tocaCaja ? efectos.find((e) => !(MONEDAS_TAQUILLA as readonly string[]).includes(e.moneda.codigo)) : undefined;
  if (fuera) throw errorHttp(`La caja de taquilla solo maneja pesos, dólares y euros: no puede moverse en ${fuera.moneda.codigo}`, 400);

  let operacionId = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (aplica && tocaCaja) {
      // primero lo que entra, después lo que sale
      for (const e of [...efectos].sort((a, b) => b.delta.cmp(a.delta))) await aplicarACaja(client, caja.id, e.moneda.id, e.delta, input.usuarioId);
    }
    const creada = await client.query(
      `INSERT INTO operaciones_taquilla
        (tipo, moneda_id, cantidad, tasa, comision_pct, total, descripcion, cliente_nombre, cliente_telefono, cliente_cedula, estado, usuario_id,
         confirmado_en, confirmado_por, moneda_operacion, divide, medio, resultado, moneda_resultado, caja_lado, caja_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $13 THEN now() END, CASE WHEN $13 THEN $12::int END, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
      [
        input.tipo, monedaCaja.id, cantidad.toFixed(4), tasa?.toFixed(8) ?? null, comision?.toFixed(4) ?? null, total.toFixed(4),
        input.descripcion?.trim() || null, input.clienteNombre?.trim() || null, input.clienteTelefono?.trim() || null, input.clienteCedula?.trim() || null,
        aplica ? "CONFIRMADA" : "PENDIENTE", input.usuarioId, aplica,
        codigoOperacion, !!(input.dividir && tasa), medio, resultado.toFixed(4), codigoResultado, input.cajaLado, caja.id,
      ]
    );
    operacionId = creada.rows[0].id as number;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  // el id de la operación nueva, para poder guardarle la imagen del comprobante
  return { ...(await obtenerTaquilla()), operacionId };
}

/** Confirmar un ingreso pendiente: recién ahí suma a la caja. */
export async function confirmarOperacionTaquilla(id: number, usuarioId: number) {
  const caja = await cajaDeTaquilla();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(`SELECT * FROM operaciones_taquilla WHERE id = $1 AND caja_id = $2 FOR UPDATE`, [id, caja.id]);
    const o = r.rows[0];
    if (!o) throw errorHttp("Operación no encontrada", 404);
    if (o.estado !== "PENDIENTE") throw errorHttp("Esa operación ya no está pendiente", 409);
    // por Bancolombia se confirma sin tocar la caja
    if (o.medio === "EFECTIVO") {
      const signo = o.tipo === "INGRESO" ? 1 : -1;
      if (o.caja_lado === "AMBOS") {
        // efectivo por efectivo: entra un lado y sale el otro
        const m = await client.query(`SELECT id, codigo FROM monedas WHERE codigo = ANY($1::text[])`, [[o.moneda_operacion, o.moneda_resultado]]);
        const idDe = (codigo: string) => m.rows.find((x) => x.codigo === codigo)?.id as number;
        const efectos = [
          { monedaId: idDe(o.moneda_operacion), delta: new Decimal(o.cantidad).times(signo) },
          { monedaId: idDe(o.moneda_resultado), delta: new Decimal(o.resultado).times(-signo) },
        ].sort((a, b) => b.delta.cmp(a.delta));
        for (const e of efectos) await aplicarACaja(client, caja.id, e.monedaId, e.delta, usuarioId);
      } else {
        await aplicarACaja(client, caja.id, o.moneda_id, new Decimal(o.total).times(signo), usuarioId);
      }
    }
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
  const caja = await cajaDeTaquilla();
  const r = await pool.query(`UPDATE operaciones_taquilla SET estado = 'ANULADA' WHERE id = $1 AND caja_id = $2 AND estado = 'PENDIENTE' RETURNING id`, [id, caja.id]);
  if (!r.rows[0]) throw errorHttp("Solo se puede anular una operación que siga pendiente", 409);
  return obtenerTaquilla();
}

/** Guarda la imagen del comprobante con el ingreso o egreso de taquilla. */
export async function guardarComprobanteOperacion(id: number, imagen: Buffer, mime: string) {
  const existe = await pool.query(`SELECT id FROM operaciones_taquilla WHERE id = $1`, [id]);
  if (!existe.rows[0]) throw errorHttp("Operación no encontrada", 404);
  const key = await subirArchivo("comprobantes-taquilla", `op-${id}-${Date.now()}`, imagen, mime);
  await pool.query(`UPDATE operaciones_taquilla SET comprobante_key = $1, comprobante_mime = $2 WHERE id = $3`, [key, mime, id]);
  return obtenerTaquilla();
}

/** Enlace temporal (unos minutos) para ver la imagen del comprobante de una operación. */
export async function urlComprobanteOperacion(id: number) {
  const r = await pool.query(`SELECT comprobante_key, comprobante_mime FROM operaciones_taquilla WHERE id = $1`, [id]);
  if (!r.rows[0]?.comprobante_key) throw errorHttp("Esa operación no tiene imagen de comprobante", 404);
  return { url: generarUrlTemporal(r.rows[0].comprobante_key, r.rows[0].comprobante_mime, 600) };
}
