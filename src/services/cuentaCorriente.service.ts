import { PoolClient } from "pg";
import Decimal from "decimal.js";
import * as XLSX from "xlsx";
import { pool } from "../db/pool";
import { exigirTurnoAbierto } from "./cierreCaja.service";

interface RegistrarMovimientoCCInput {
  terceroId: number;
  canalId: number;
  monedaId: number; // moneda del saldo de la cuenta corriente (COP o USD, según la fase del Excel)
  tipo: "COMPRA" | "VENTA" | "ABONO" | "CARGO" | "AJUSTE";
  // CON SIGNO: + aumenta el saldo, - lo reduce (igual que el Excel).
  // Si no se manda, se calcula como cantidadBase x tasa (la columna MONTO del Excel).
  monto?: string;
  descripcion?: string;
  cantidadBase?: string;
  monedaBaseId?: number;
  tasa?: string;
  // true si la tasa es una comisión en % (viaja como fracción: 3% = "0.03")
  tasaEsPorcentaje?: boolean;
  transaccionId?: number;
  usuarioId: number;
  fecha?: string;
  categoriaId?: number;
  // --- Opcional: si este movimiento TAMBIÉN es un ingreso/egreso real de
  // efectivo (la columna "TOTAL DE PESOS" del Excel), se registra en la
  // misma transacción SQL, todo o nada.
  cajaId?: number;
  montoCaja?: string; // con signo, en la moneda de la caja (normalmente COP)
  monedaCajaId?: number; // moneda de la caja; si no se manda, se usa monedaId
  metodoPagoId?: number;
  reversoDeId?: number;
}

function errorHttp(mensaje: string, status: number) {
  return Object.assign(new Error(mensaje), { status });
}

function aDecimal(valor: string, campo: string) {
  try {
    const d = new Decimal(valor);
    if (!d.isFinite()) throw new Error();
    return d;
  } catch {
    throw errorHttp(`${campo} no es un número válido`, 400);
  }
}

/**
 * Registra un movimiento de cuenta corriente y, si corresponde, el
 * movimiento de caja asociado -- de forma ATÓMICA. Si algo falla en
 * cualquiera de los dos, no queda ninguno aplicado.
 */
export async function registrarMovimientoCuentaCorriente(input: RegistrarMovimientoCCInput) {
  const cantidad = input.cantidadBase !== undefined ? aDecimal(input.cantidadBase, "La cantidad") : null;
  const tasa = input.tasa !== undefined ? aDecimal(input.tasa, "La tasa") : null;
  if (tasa && tasa.lte(0)) throw errorHttp("La tasa debe ser mayor a cero", 400);
  if (input.monto === undefined && !(cantidad && tasa)) {
    throw errorHttp("Indicá el monto, o la cantidad y la tasa para calcularlo", 400);
  }

  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    // MONTO = CANTIDAD x TASA, redondeado a los decimales de la moneda de la cuenta
    const monedaResult = await client.query(`SELECT decimales FROM monedas WHERE id = $1`, [input.monedaId]);
    if (!monedaResult.rows[0]) throw errorHttp("Moneda no encontrada", 404);
    const decimales = Number(monedaResult.rows[0].decimales);
    const calculado = cantidad && tasa ? cantidad.times(tasa).toDecimalPlaces(decimales, Decimal.ROUND_HALF_UP) : null;
    const monto = input.monto !== undefined ? aDecimal(input.monto, "El monto") : calculado!;
    if (input.monto !== undefined && calculado && !monto.eq(calculado)) {
      throw errorHttp(`El monto (${monto.toString()}) no coincide con cantidad x tasa (${calculado.toString()})`, 400);
    }
    if (monto.isZero()) throw errorHttp("El monto no puede ser cero", 400);

    // ---------- 1) Cuenta corriente (get-or-create + lock) ----------
    let cuentaResult = await client.query(
      `SELECT * FROM cuentas_corrientes
       WHERE tercero_id = $1 AND canal_id = $2 AND moneda_id = $3
       FOR UPDATE`,
      [input.terceroId, input.canalId, input.monedaId]
    );

    let cuenta;
    if (cuentaResult.rows.length === 0) {
      const insert = await client.query(
        `INSERT INTO cuentas_corrientes (tercero_id, canal_id, moneda_id, saldo_actual)
         VALUES ($1, $2, $3, 0) RETURNING *`,
        [input.terceroId, input.canalId, input.monedaId]
      );
      cuenta = insert.rows[0];
    } else {
      cuenta = cuentaResult.rows[0];
    }
    if (cuenta.estado !== "DISPONIBLE") {
      throw errorHttp(`La cuenta está ${String(cuenta.estado).toLowerCase()}: no admite movimientos`, 409);
    }

    const saldoAnterior = new Decimal(cuenta.saldo_actual);
    const saldoNuevo = saldoAnterior.plus(monto);

    await client.query(`UPDATE cuentas_corrientes SET saldo_actual = $1 WHERE id = $2`, [
      saldoNuevo.toFixed(4),
      cuenta.id,
    ]);

        const movResult = await client.query(
      `INSERT INTO movimientos_cuenta_corriente
        (cuenta_corriente_id, fecha, descripcion, tipo, cantidad_base, moneda_base_id, tasa, monto, saldo_anterior, saldo_nuevo, transaccion_id, usuario_id, categoria_id, reverso_de_id, anulado, tasa_es_porcentaje)
       VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::int, $14::int IS NOT NULL, $15)
       RETURNING *`,
      [
        cuenta.id, input.fecha ?? null, input.descripcion ?? null, input.tipo,
        input.cantidadBase ?? null, input.monedaBaseId ?? null, input.tasa ?? null,
        monto.toFixed(4), saldoAnterior.toFixed(4), saldoNuevo.toFixed(4),
        input.transaccionId ?? null, input.usuarioId, input.categoriaId ?? null, input.reversoDeId ?? null,
        !!(input.tasaEsPorcentaje && tasa),
      ]
    );

    // ---------- 2) Caja física, SOLO si este movimiento también mueve efectivo ----------
    let movimientoCaja = null;
    if (input.cajaId) {
      const montoCaja = input.montoCaja !== undefined ? aDecimal(input.montoCaja, "El monto de caja") : monto;
      const monedaCajaId = input.monedaCajaId ?? input.monedaId;
      const tipoMovimiento = montoCaja.isPositive() ? "INGRESO" : "EGRESO";
      const montoAbsoluto = montoCaja.abs();

      await exigirTurnoAbierto(client, input.cajaId, monedaCajaId);

      const saldoCajaResult = await client.query(
        `SELECT id, monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`,
        [input.cajaId, monedaCajaId]
      );

      let saldoCajaAnterior: Decimal;
      let saldoCajaId: number;

      if (saldoCajaResult.rows.length === 0) {
        saldoCajaAnterior = new Decimal(0);
        const insertSaldo = await client.query(
          `INSERT INTO saldos_caja (caja_id, moneda_id, monto) VALUES ($1, $2, 0) RETURNING id`,
          [input.cajaId, monedaCajaId]
        );
        saldoCajaId = insertSaldo.rows[0].id;
      } else {
        saldoCajaAnterior = new Decimal(saldoCajaResult.rows[0].monto);
        saldoCajaId = saldoCajaResult.rows[0].id;
      }

      const saldoCajaNuevo =
        tipoMovimiento === "INGRESO" ? saldoCajaAnterior.plus(montoAbsoluto) : saldoCajaAnterior.minus(montoAbsoluto);

      if (saldoCajaNuevo.isNegative()) {
        throw Object.assign(new Error("Saldo insuficiente en caja para este movimiento"), { status: 409 });
      }

      await client.query(`UPDATE saldos_caja SET monto = $1 WHERE id = $2`, [saldoCajaNuevo.toFixed(4), saldoCajaId]);

      const movCajaResult = await client.query(
        `INSERT INTO movimientos_caja
          (caja_id, moneda_id, metodo_pago_id, tipo, monto, saldo_anterior, saldo_nuevo, usuario_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          input.cajaId,
          monedaCajaId,
          input.metodoPagoId ?? null,
          tipoMovimiento,
          montoAbsoluto.toFixed(4),
          saldoCajaAnterior.toFixed(4),
          saldoCajaNuevo.toFixed(4),
          input.usuarioId,
        ]
      );
      movimientoCaja = movCajaResult.rows[0];
      await client.query(`UPDATE movimientos_cuenta_corriente SET movimiento_caja_id = $1 WHERE id = $2`, [
        movimientoCaja.id,
        movResult.rows[0].id,
      ]);
    }
    if (input.reversoDeId) {
      await client.query(`UPDATE movimientos_cuenta_corriente SET anulado = true WHERE id = $1`, [input.reversoDeId]);
    }

    await client.query("COMMIT");
    return { movimiento: movResult.rows[0], saldoNuevo: saldoNuevo.toFixed(4), movimientoCaja };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function cambiarEstadoCuentaCorriente(id: number, estado: "DISPONIBLE" | "BLOQUEADA" | "CERRADA") {
  const result = await pool.query(`UPDATE cuentas_corrientes SET estado = $1 WHERE id = $2 RETURNING *`, [
    estado,
    id,
  ]);
  if (result.rows.length === 0) {
    throw Object.assign(new Error("Cuenta corriente no encontrada"), { status: 404 });
  }
  return result.rows[0];
}

// ---------- Abrir una cuenta (proveedor o cliente + canal de pago + moneda) ----------
const ZONA = "America/Bogota";

interface CrearCuentaInput {
  terceroId?: number;
  nuevoTercero?: { nombre: string; tipo: "CLIENTE" | "PROVEEDOR" | "MIXTO"; identificacion?: string; telefono?: string };
  canalId?: number; // opcional: sin banco, la cuenta queda en el canal SIN_BANCO
  monedaId: number;
  // con signo, como el "Saldo pendiente" con el que arranca la hoja del Excel: + me debe, - yo le debo
  saldoInicial?: string;
  usuarioId: number;
}

export const CANAL_SIN_BANCO = "SIN_BANCO";

export async function crearCuentaCorriente(input: CrearCuentaInput) {
  const saldoInicial = input.saldoInicial !== undefined ? aDecimal(input.saldoInicial, "El saldo inicial") : null;
  const canalId = input.canalId ?? ((await crearCanal(CANAL_SIN_BANCO)).id as number);
  let terceroId = input.terceroId;
  if (!terceroId) {
    const n = input.nuevoTercero;
    if (!n?.nombre.trim()) throw errorHttp("Elegí un tercero o escribí el nombre del nuevo", 400);
    const repetido = await pool.query(`SELECT id FROM terceros WHERE lower(nombre) = lower($1) AND activo`, [n.nombre.trim()]);
    if (repetido.rows[0]) throw errorHttp(`Ya existe "${n.nombre.trim()}": buscalo en la lista en vez de crearlo de nuevo`, 409);
    const r = await pool.query(`INSERT INTO terceros (nombre, identificacion, telefono, tipo) VALUES ($1, $2, $3, $4) RETURNING id`, [
      n.nombre.trim(),
      n.identificacion?.trim() || null,
      n.telefono?.trim() || null,
      n.tipo,
    ]);
    terceroId = r.rows[0].id as number;
  }

  const existe = await pool.query(`SELECT id FROM cuentas_corrientes WHERE tercero_id = $1 AND canal_id = $2 AND moneda_id = $3`, [
    terceroId,
    canalId,
    input.monedaId,
  ]);
  if (existe.rows[0]) {
    throw errorHttp(input.canalId ? "Ese tercero ya tiene una cuenta con ese canal y esa moneda" : "Ese tercero ya tiene una cuenta sin banco en esa moneda", 409);
  }

  const cuenta = await pool.query(
    `INSERT INTO cuentas_corrientes (tercero_id, canal_id, moneda_id, saldo_actual) VALUES ($1, $2, $3, 0) RETURNING id`,
    [terceroId, canalId, input.monedaId]
  );
  if (saldoInicial && !saldoInicial.isZero()) {
    await registrarMovimientoCuentaCorriente({
      terceroId,
      canalId,
      monedaId: input.monedaId,
      tipo: "AJUSTE",
      monto: saldoInicial.toFixed(4),
      descripcion: "Saldo pendiente inicial",
      usuarioId: input.usuarioId,
    });
  }
  return obtenerCuentaCorriente(cuenta.rows[0].id);
}

const SELECT_CUENTA = `
  SELECT cc.*, t.nombre AS tercero_nombre, t.tipo AS tercero_tipo, t.telefono AS tercero_telefono, ch.nombre AS canal_nombre,
         m.codigo AS moneda_codigo, m.decimales AS moneda_decimales,
         (SELECT max(fecha) FROM movimientos_cuenta_corriente WHERE cuenta_corriente_id = cc.id) AS ultimo_movimiento
  FROM cuentas_corrientes cc
  JOIN terceros t ON t.id = cc.tercero_id
  JOIN canales_cuenta_corriente ch ON ch.id = cc.canal_id
  JOIN monedas m ON m.id = cc.moneda_id`;

export async function obtenerCuentaCorriente(id: number) {
  const r = await pool.query(`${SELECT_CUENTA} WHERE cc.id = $1`, [id]);
  if (!r.rows[0]) throw errorHttp("Cuenta corriente no encontrada", 404);
  return r.rows[0];
}

export async function listarCuentasCorrientes(filtros: { terceroId?: number; canalId?: number; buscar?: string; tipoTercero?: string }) {
  const cond: string[] = [];
  const valores: unknown[] = [];
  if (filtros.terceroId) {
    valores.push(filtros.terceroId);
    cond.push(`cc.tercero_id = $${valores.length}`);
  }
  if (filtros.canalId) {
    valores.push(filtros.canalId);
    cond.push(`cc.canal_id = $${valores.length}`);
  }
  if (filtros.tipoTercero) {
    valores.push(filtros.tipoTercero);
    cond.push(`t.tipo::text = $${valores.length}`);
  }
  if (filtros.buscar?.trim()) {
    valores.push(`%${filtros.buscar.trim()}%`);
    cond.push(`t.nombre ILIKE $${valores.length}`);
  }
  const r = await pool.query(`${SELECT_CUENTA} ${cond.length ? `WHERE ${cond.join(" AND ")}` : ""} ORDER BY t.nombre, ch.nombre`, valores);
  return r.rows;
}

export async function crearCanal(nombre: string) {
  // Mismo formato que los canales existentes (ZELLE, WESTERN_UNION...)
  const limpio = nombre.trim().toUpperCase().replace(/\s+/g, "_");
  if (!limpio) throw errorHttp("Escribí el nombre del canal", 400);
  const r = await pool.query(
    `INSERT INTO canales_cuenta_corriente (nombre) VALUES ($1)
     ON CONFLICT (nombre) DO UPDATE SET activo = true RETURNING *`,
    [limpio]
  );
  return r.rows[0];
}

/**
 * La hoja del Excel: saldo pendiente con el que arranca el período, cada movimiento con
 * su TOTAL corrido, y las sumas. El total se calcula en orden de fecha (no de carga), así
 * un movimiento cargado con fecha de ayer queda donde corresponde.
 */
export async function obtenerEstadoCuenta(id: number, filtros: { desde?: string; hasta?: string }) {
  const cuenta = await obtenerCuentaCorriente(id);
  const dia = `(fecha AT TIME ZONE '${ZONA}')::date`;
  const r = await pool.query(
    `WITH corridos AS (
       SELECT mc.*, sum(mc.monto) OVER (ORDER BY mc.fecha, mc.id) AS total
       FROM movimientos_cuenta_corriente mc WHERE mc.cuenta_corriente_id = $1
     )
     SELECT c.id, c.fecha, c.descripcion, c.tipo, c.cantidad_base, c.tasa, c.tasa_es_porcentaje, c.monto, c.total, c.anulado, c.reverso_de_id,
            c.movimiento_caja_id, c.created_at, u.nombre AS usuario_nombre, mb.codigo AS moneda_base_codigo, cat.nombre AS categoria_nombre
     FROM corridos c
     JOIN usuarios u ON u.id = c.usuario_id
     LEFT JOIN monedas mb ON mb.id = c.moneda_base_id
     LEFT JOIN categorias_movimiento cat ON cat.id = c.categoria_id
     WHERE ($2::date IS NULL OR ${dia.replace("fecha", "c.fecha")} >= $2::date)
       AND ($3::date IS NULL OR ${dia.replace("fecha", "c.fecha")} <= $3::date)
     ORDER BY c.fecha, c.id`,
    [id, filtros.desde ?? null, filtros.hasta ?? null]
  );
  const anterior = await pool.query(
    `SELECT COALESCE(sum(monto), 0) AS saldo FROM movimientos_cuenta_corriente
     WHERE cuenta_corriente_id = $1 AND $2::date IS NOT NULL AND ${dia} < $2::date`,
    [id, filtros.desde ?? null]
  );
  const saldoAnterior = new Decimal(anterior.rows[0].saldo);
  let sumas = new Decimal(0);
  let abonos = new Decimal(0);
  for (const m of r.rows) {
    if (m.anulado) continue; // un movimiento y su reverso se cancelan: no ensucian las sumas
    const monto = new Decimal(m.monto);
    if (monto.isPositive()) sumas = sumas.plus(monto);
    else abonos = abonos.plus(monto);
  }
  const saldoFinal = r.rows.length ? new Decimal(r.rows[r.rows.length - 1].total) : saldoAnterior;
  return {
    cuenta,
    saldoAnterior: saldoAnterior.toFixed(4),
    movimientos: r.rows,
    sumas: sumas.toFixed(4),
    abonos: abonos.toFixed(4),
    saldoFinal: saldoFinal.toFixed(4),
  };
}

/**
 * La misma hoja, en un .xlsx para mandarle al cliente: FECHA · REFERENCIA · CANTIDAD · TASA · MONTO · TOTAL.
 * Los negativos (lo que yo le debo) salen en rojo y con signo, como en el Excel de siempre.
 */
export async function generarExcelEstadoCuenta(id: number, filtros: { desde?: string; hasta?: string }) {
  const { cuenta, saldoAnterior, movimientos, sumas, abonos, saldoFinal } = await obtenerEstadoCuenta(id, filtros);
  const fechaCorta = (f: string | Date) => new Date(f).toLocaleDateString("es-CO", { timeZone: ZONA, day: "2-digit", month: "2-digit", year: "numeric" });
  const periodo = filtros.desde || filtros.hasta ? `Del ${filtros.desde ?? "inicio"} al ${filtros.hasta ?? "hoy"}` : "Todos los movimientos";
  const final = new Decimal(saldoFinal);
  const lectura = final.isZero() ? "Cuenta al día" : final.isNegative() ? "Saldo a favor del cliente (se le debe)" : "Saldo pendiente por pagar";

  const filas: (string | number | null)[][] = [
    [`Estado de cuenta — ${cuenta.tercero_nombre}`],
    [`Moneda: ${cuenta.moneda_codigo}`, null, periodo],
    [],
    ["FECHA", "REFERENCIA", "CANTIDAD", "TASA", "MONTO", "TOTAL"],
  ];
  const encabezado = filas.length - 1;
  if (filtros.desde) filas.push([null, "Saldo pendiente anterior", null, null, null, Number(saldoAnterior)]);
  const porcentajes: number[] = []; // filas cuya tasa es una comisión en %
  for (const m of movimientos) {
    if (m.tasa_es_porcentaje) porcentajes.push(filas.length);
    filas.push([
      fechaCorta(m.fecha),
      `${m.descripcion ?? m.tipo}${m.anulado && !m.reverso_de_id ? " (anulado)" : ""}`,
      m.cantidad_base != null ? Number(m.cantidad_base) : null,
      m.tasa != null ? Number(m.tasa) : null,
      Number(m.monto),
      Number(m.total),
    ]);
  }
  filas.push([]);
  filas.push([null, "Sumas del período", null, null, Number(sumas)]);
  filas.push([null, "Abonos del período", null, null, Number(abonos)]);
  filas.push([null, "SALDO PENDIENTE", null, null, null, Number(saldoFinal)]);
  filas.push([null, lectura]);

  const hoja = XLSX.utils.aoa_to_sheet(filas);
  const dinero = "#,##0.##;[Red]-#,##0.##";
  for (let f = encabezado + 1; f < filas.length; f++) {
    for (const c of [2, 4, 5]) {
      const celda = hoja[XLSX.utils.encode_cell({ r: f, c })];
      if (celda?.t === "n") celda.z = dinero;
    }
    const tasa = hoja[XLSX.utils.encode_cell({ r: f, c: 3 })];
    if (tasa?.t === "n") tasa.z = porcentajes.includes(f) ? "0.##%" : "#,##0.########";
  }
  hoja["!cols"] = [{ wch: 12 }, { wch: 38 }, { wch: 16 }, { wch: 10 }, { wch: 18 }, { wch: 18 }];
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, "Estado de cuenta");
  return XLSX.write(libro, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Un error no se borra: se registra el movimiento contrario (y el de caja, si lo hubo). */
export async function anularMovimiento(movimientoId: number, usuarioId: number) {
  const r = await pool.query(
    `SELECT mc.*, cc.tercero_id, cc.canal_id, cc.moneda_id, mcaja.caja_id, mcaja.moneda_id AS caja_moneda_id, mcaja.tipo AS caja_tipo,
            mcaja.monto AS caja_monto, mcaja.metodo_pago_id
     FROM movimientos_cuenta_corriente mc
     JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id
     LEFT JOIN movimientos_caja mcaja ON mcaja.id = mc.movimiento_caja_id
     WHERE mc.id = $1`,
    [movimientoId]
  );
  const m = r.rows[0];
  if (!m) throw errorHttp("Movimiento no encontrado", 404);
  if (m.anulado) throw errorHttp("Ese movimiento ya está anulado", 409);

  return registrarMovimientoCuentaCorriente({
    terceroId: m.tercero_id,
    canalId: m.canal_id,
    monedaId: m.moneda_id,
    tipo: "AJUSTE",
    monto: new Decimal(m.monto).negated().toFixed(4),
    cantidadBase: m.cantidad_base != null && m.tasa != null ? new Decimal(m.cantidad_base).negated().toString() : undefined,
    monedaBaseId: m.moneda_base_id ?? undefined,
    tasa: m.cantidad_base != null && m.tasa != null ? new Decimal(m.tasa).toString() : undefined,
    tasaEsPorcentaje: m.tasa_es_porcentaje,
    descripcion: `Reverso de: ${m.descripcion ?? m.tipo}`,
    fecha: new Date(m.fecha).toISOString(),
    usuarioId,
    reversoDeId: m.id,
    ...(m.caja_id
      ? {
          cajaId: m.caja_id,
          monedaCajaId: m.caja_moneda_id,
          // lo contrario de lo que se hizo en la caja
          montoCaja: (m.caja_tipo === "INGRESO" ? new Decimal(m.caja_monto).negated() : new Decimal(m.caja_monto)).toFixed(4),
          metodoPagoId: m.metodo_pago_id ?? undefined,
        }
      : {}),
  });
}

