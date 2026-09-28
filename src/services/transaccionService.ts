import { Pool, PoolClient } from "pg";
import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { exigirTurnoAbierto } from "./cierreCaja.service";

// ---------- Helper compartido: UN movimiento de caja ----------
async function aplicarMovimientoLeg(
  client: PoolClient,
  params: {
    cajaId: number;
    monedaId: number;
    tipo: "INGRESO" | "EGRESO";
    monto: Decimal;
    transaccionId: number;
    usuarioId: number;
    metodoPagoId?: number;
  }
) {
  await exigirTurnoAbierto(client, params.cajaId, params.monedaId);

  const saldoResult = await client.query(
    `SELECT id, monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`,
    [params.cajaId, params.monedaId]
  );

  let saldoAnterior: Decimal;
  let saldoId: number;

  if (saldoResult.rows.length === 0) {
    saldoAnterior = new Decimal(0);
    const insert = await client.query(
      `INSERT INTO saldos_caja (caja_id, moneda_id, monto) VALUES ($1, $2, 0) RETURNING id`,
      [params.cajaId, params.monedaId]
    );
    saldoId = insert.rows[0].id;
  } else {
    saldoAnterior = new Decimal(saldoResult.rows[0].monto);
    saldoId = saldoResult.rows[0].id;
  }

  const saldoNuevo = params.tipo === "INGRESO" ? saldoAnterior.plus(params.monto) : saldoAnterior.minus(params.monto);

  if (saldoNuevo.isNegative()) {
    throw Object.assign(new Error("Saldo insuficiente en caja para esta operación"), { status: 409 });
  }

  await client.query(`UPDATE saldos_caja SET monto = $1 WHERE id = $2`, [saldoNuevo.toFixed(4), saldoId]);

  await client.query(
    `INSERT INTO movimientos_caja
      (caja_id, transaccion_id, moneda_id, metodo_pago_id, tipo, monto, saldo_anterior, saldo_nuevo, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      params.cajaId,
      params.transaccionId,
      params.monedaId,
      params.metodoPagoId ?? null,
      params.tipo,
      params.monto.toFixed(4),
      saldoAnterior.toFixed(4),
      saldoNuevo.toFixed(4),
      params.usuarioId,
    ]
  );

  return saldoNuevo;
}

// ---------- Operación simple: un solo movimiento (depósito/retiro manual) ----------
interface RegistrarTransaccionInput {
  tipo: "DEPOSITO" | "RETIRO";
  cajaId: number;
  terceroId?: number;
  monedaOrigenId: number;
  montoOrigen: string;
  metodoPagoId?: number;
  referenciaCodigo?: string;
  bancoOrigen?: string;
  usuarioId: number;
}

export async function registrarTransaccion(input: RegistrarTransaccionInput) {
  const client: PoolClient = await pool.connect();
  const montoOrigen = new Decimal(input.montoOrigen);

  try {
    await client.query("BEGIN");

    const cajaResult = await client.query(`SELECT * FROM cajas WHERE id = $1`, [input.cajaId]);
    const caja = cajaResult.rows[0];
    if (!caja) throw Object.assign(new Error("Caja no encontrada"), { status: 404 });
    const requiereConfirmacion = caja.tipo === "BANCO";

    let referenciaId: number | null = null;
    if (input.referenciaCodigo) {
      const refResult = await client.query(
        `INSERT INTO referencias (codigo, banco_origen, estado) VALUES ($1, $2, 'BLOQUEADA') RETURNING id`,
        [input.referenciaCodigo, input.bancoOrigen ?? null]
      );
      referenciaId = refResult.rows[0].id;
    }

    const estadoInicial = requiereConfirmacion ? "PENDIENTE" : "CONFIRMADA";

    const txResult = await client.query(
      `INSERT INTO transacciones
        (tipo, estado, tercero_id, caja_id, moneda_origen_id, monto_origen, metodo_pago_id, referencia_id, usuario_id, confirmada_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $2 = 'CONFIRMADA' THEN now() ELSE NULL END)
       RETURNING *`,
      [
        input.tipo,
        estadoInicial,
        input.terceroId ?? null,
        input.cajaId,
        input.monedaOrigenId,
        montoOrigen.toFixed(4),
        input.metodoPagoId ?? null,
        referenciaId,
        input.usuarioId,
      ]
    );
    const transaccion = txResult.rows[0];

    if (requiereConfirmacion) {
      await client.query("COMMIT");
      return { transaccion, requiereConfirmacion: true };
    }

    const tipoMovimiento = input.tipo === "DEPOSITO" ? "INGRESO" : "EGRESO";
    const saldoNuevo = await aplicarMovimientoLeg(client, {
      cajaId: input.cajaId,
      monedaId: input.monedaOrigenId,
      tipo: tipoMovimiento,
      monto: montoOrigen,
      transaccionId: transaccion.id,
      usuarioId: input.usuarioId,
      metodoPagoId: input.metodoPagoId,
    });

    await client.query("COMMIT");
    return { transaccion, saldoNuevo: saldoNuevo.toFixed(4), requiereConfirmacion: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------- Cálculo del cambio (multiplicar o dividir por la tasa) ----------
// La tasa SIEMPRE es "pesos por 1 unidad de divisa" (ej. 3 COP por 1 Bs).
// Lo que cambia es qué monto trae el cliente:
//   - trae divisa  (cantidadExtranjera) -> montoLocal = cantidadExtranjera × tasa   (MULTIPLICACION)
//   - trae pesos   (montoLocal)         -> cantidadExtranjera = montoLocal ÷ tasa   (DIVISION)
// Ej. compra: 1000 Bs × 3 = 3000 COP. Ej. venta: 3000 COP ÷ 3.2 = 937.5 Bs.
export interface CalcularCambioInput {
  tipo: "COMPRA_DIVISA" | "VENTA_DIVISA";
  monedaExtranjeraId: number;
  monedaLocalId: number;
  cantidadExtranjera?: string;
  montoLocal?: string;
  cotizacionDetalleId?: number;
  tasaManual?: string;
}

export interface ResultadoCalculoCambio {
  operacion: "MULTIPLICACION" | "DIVISION";
  tasa: Decimal;
  cotizacionDetalleId: number | null;
  cantidadExtranjera: Decimal;
  montoLocal: Decimal;
}

async function obtenerDecimalesMoneda(db: Pool | PoolClient, monedaId: number, rol: string) {
  const result = await db.query(`SELECT decimales FROM monedas WHERE id = $1`, [monedaId]);
  const moneda = result.rows[0];
  if (!moneda) throw Object.assign(new Error(`Moneda ${rol} no encontrada`), { status: 404 });
  return Number(moneda.decimales);
}

export async function calcularCambio(db: Pool | PoolClient, input: CalcularCambioInput): Promise<ResultadoCalculoCambio> {
  if (input.monedaExtranjeraId === input.monedaLocalId) {
    throw Object.assign(new Error("La moneda extranjera y la local deben ser distintas"), { status: 400 });
  }

  // ---- Resolver la tasa: de la cotización del día, o manual ----
  let tasa: Decimal;
  let cotizacionDetalleId: number | null = null;

  if (input.cotizacionDetalleId) {
    const cotResult = await db.query(`SELECT * FROM cotizaciones_detalle WHERE id = $1`, [input.cotizacionDetalleId]);
    const cot = cotResult.rows[0];
    if (!cot) throw Object.assign(new Error("Cotización no encontrada"), { status: 404 });
    if (cot.valor == null) {
      throw Object.assign(
        new Error("Esa cotización es un porcentaje de comisión, no un precio fijo -- usá una de tipo Efectivo o ingresá la tasa manual"),
        { status: 400 }
      );
    }
    if (cot.moneda_id !== input.monedaExtranjeraId) {
      throw Object.assign(new Error("La cotización elegida no corresponde a la moneda de la operación"), { status: 400 });
    }
    const tipoCotizacionEsperado = input.tipo === "COMPRA_DIVISA" ? "COMPRA" : "VENTA";
    if (cot.tipo !== tipoCotizacionEsperado) {
      throw Object.assign(
        new Error(`Para esta operación se debe usar una tasa de ${tipoCotizacionEsperado}, no de ${cot.tipo}`),
        { status: 400 }
      );
    }
    tasa = new Decimal(cot.valor);
    cotizacionDetalleId = cot.id;
  } else if (input.tasaManual) {
    tasa = new Decimal(input.tasaManual);
  } else {
    throw Object.assign(new Error("Debés indicar una cotización del día o una tasa manual"), { status: 400 });
  }

  if (!tasa.isPositive() || tasa.isZero()) {
    throw Object.assign(new Error("La tasa debe ser mayor a cero"), { status: 400 });
  }

  const decimalesExtranjera = await obtenerDecimalesMoneda(db, input.monedaExtranjeraId, "extranjera");
  const decimalesLocal = await obtenerDecimalesMoneda(db, input.monedaLocalId, "local");

  let operacion: ResultadoCalculoCambio["operacion"];
  let cantidadExtranjera: Decimal;
  let montoLocal: Decimal;

  if (input.cantidadExtranjera !== undefined && input.montoLocal === undefined) {
    operacion = "MULTIPLICACION";
    cantidadExtranjera = new Decimal(input.cantidadExtranjera).toDecimalPlaces(decimalesExtranjera, Decimal.ROUND_HALF_UP);
    montoLocal = cantidadExtranjera.times(tasa).toDecimalPlaces(decimalesLocal, Decimal.ROUND_HALF_UP);
  } else if (input.montoLocal !== undefined && input.cantidadExtranjera === undefined) {
    operacion = "DIVISION";
    montoLocal = new Decimal(input.montoLocal).toDecimalPlaces(decimalesLocal, Decimal.ROUND_HALF_UP);
    cantidadExtranjera = montoLocal.dividedBy(tasa).toDecimalPlaces(decimalesExtranjera, Decimal.ROUND_HALF_UP);
  } else {
    throw Object.assign(new Error("Indicá exactamente uno: cantidadExtranjera (multiplica) o montoLocal (divide)"), {
      status: 400,
    });
  }

  if (!cantidadExtranjera.isPositive() || cantidadExtranjera.isZero() || !montoLocal.isPositive() || montoLocal.isZero()) {
    throw Object.assign(new Error("El monto es demasiado pequeño para esta tasa"), { status: 400 });
  }

  return { operacion, tasa, cotizacionDetalleId, cantidadExtranjera, montoLocal };
}

/** Decimal -> string para la respuesta JSON (nunca number, para no perder precisión). */
export function calculoAJson(calculo: ResultadoCalculoCambio) {
  return {
    operacion: calculo.operacion,
    tasa: calculo.tasa.toString(),
    cotizacionDetalleId: calculo.cotizacionDetalleId,
    cantidadExtranjera: calculo.cantidadExtranjera.toString(),
    montoLocal: calculo.montoLocal.toString(),
  };
}

// ---------- Cambio de divisa: DOS movimientos atómicos (la divisa + el pago en pesos) ----------
interface RegistrarCambioInput extends CalcularCambioInput {
  // COMPRA = el cliente nos vende divisa; VENTA = el cliente nos compra divisa
  terceroId?: number;
  cajaExtranjeraId: number; // dónde entra/sale la divisa física
  cajaLocalId: number; // caja física, o un banco (Nequi/Bancolombia) si se paga por transferencia
  metodoPagoId?: number;
  referenciaCodigo?: string;
  bancoOrigen?: string;
  usuarioId: number;
}

export async function registrarCambioDivisa(input: RegistrarCambioInput) {
  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    const calculo = await calcularCambio(client, input);
    const { cantidadExtranjera, montoLocal, tasa, cotizacionDetalleId } = calculo;

    // ---- Cajas involucradas ----
    const cajaExtResult = await client.query(`SELECT * FROM cajas WHERE id = $1`, [input.cajaExtranjeraId]);
    const cajaExtranjera = cajaExtResult.rows[0];
    if (!cajaExtranjera) throw Object.assign(new Error("Caja de la divisa extranjera no encontrada"), { status: 404 });

    const cajaLocalResult = await client.query(`SELECT * FROM cajas WHERE id = $1`, [input.cajaLocalId]);
    const cajaLocal = cajaLocalResult.rows[0];
    if (!cajaLocal) throw Object.assign(new Error("Caja de pesos no encontrada"), { status: 404 });

    // Si cualquiera de las dos patas pasa por un banco, la operación
    // completa queda pendiente hasta que otra persona confirme el pago.
    const requiereConfirmacion = cajaExtranjera.tipo === "BANCO" || cajaLocal.tipo === "BANCO";

    let referenciaId: number | null = null;
    if (input.referenciaCodigo) {
      const refResult = await client.query(
        `INSERT INTO referencias (codigo, banco_origen, estado) VALUES ($1, $2, 'BLOQUEADA') RETURNING id`,
        [input.referenciaCodigo, input.bancoOrigen ?? null]
      );
      referenciaId = refResult.rows[0].id;
    }

    const estadoInicial = requiereConfirmacion ? "PENDIENTE" : "CONFIRMADA";

    const txResult = await client.query(
      `INSERT INTO transacciones
        (tipo, estado, tercero_id, caja_id, caja_destino_id, moneda_origen_id, monto_origen,
         moneda_destino_id, monto_destino, cotizacion_detalle_id, metodo_pago_id, referencia_id, usuario_id,
         tasa_aplicada, operacion_calculo, confirmada_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, CASE WHEN $2 = 'CONFIRMADA' THEN now() ELSE NULL END)
       RETURNING *`,
      [
        input.tipo,
        estadoInicial,
        input.terceroId ?? null,
        input.cajaExtranjeraId,
        input.cajaLocalId,
        input.monedaExtranjeraId,
        cantidadExtranjera.toFixed(4),
        input.monedaLocalId,
        montoLocal.toFixed(4),
        cotizacionDetalleId,
        input.metodoPagoId ?? null,
        referenciaId,
        input.usuarioId,
        tasa.toFixed(8),
        calculo.operacion,
      ]
    );
    const transaccion = txResult.rows[0];

    if (requiereConfirmacion) {
      await client.query("COMMIT");
      return { transaccion, calculo: calculoAJson(calculo), montoLocal: montoLocal.toFixed(4), requiereConfirmacion: true };
    }

    // COMPRA_DIVISA: el cliente nos entrega divisa (INGRESO) y le pagamos pesos (EGRESO).
    // VENTA_DIVISA: es al revés.
    const tipoLegExtranjera = input.tipo === "COMPRA_DIVISA" ? "INGRESO" : "EGRESO";
    const tipoLegLocal = input.tipo === "COMPRA_DIVISA" ? "EGRESO" : "INGRESO";

    await aplicarMovimientoLeg(client, {
      cajaId: input.cajaExtranjeraId,
      monedaId: input.monedaExtranjeraId,
      tipo: tipoLegExtranjera,
      monto: cantidadExtranjera,
      transaccionId: transaccion.id,
      usuarioId: input.usuarioId,
    });

    await aplicarMovimientoLeg(client, {
      cajaId: input.cajaLocalId,
      monedaId: input.monedaLocalId,
      tipo: tipoLegLocal,
      monto: montoLocal,
      transaccionId: transaccion.id,
      usuarioId: input.usuarioId,
      metodoPagoId: input.metodoPagoId,
    });

    await client.query("COMMIT");
    return { transaccion, calculo: calculoAJson(calculo), montoLocal: montoLocal.toFixed(4), requiereConfirmacion: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------- Bandeja de solicitudes pendientes ----------
interface FiltrosSolicitudes {
  cajaId?: number;
  terceroId?: number;
}

export async function obtenerSolicitudesPendientes(filtros: FiltrosSolicitudes) {
  const condiciones = ["t.estado = 'PENDIENTE'"];
  const valores: unknown[] = [];

  if (filtros.cajaId) {
    valores.push(filtros.cajaId);
    condiciones.push(`(t.caja_id = $${valores.length} OR t.caja_destino_id = $${valores.length})`);
  }
  if (filtros.terceroId) {
    valores.push(filtros.terceroId);
    condiciones.push(`t.tercero_id = $${valores.length}`);
  }

  const result = await pool.query(
    `SELECT t.*, c.nombre AS caja_nombre, cd.nombre AS caja_destino_nombre,
            m.codigo AS moneda_codigo, md.codigo AS moneda_destino_codigo,
            ter.nombre AS tercero_nombre, u.nombre AS creado_por_nombre, r.codigo AS referencia_codigo
     FROM transacciones t
     JOIN cajas c ON c.id = t.caja_id
     LEFT JOIN cajas cd ON cd.id = t.caja_destino_id
     JOIN monedas m ON m.id = t.moneda_origen_id
     LEFT JOIN monedas md ON md.id = t.moneda_destino_id
     LEFT JOIN terceros ter ON ter.id = t.tercero_id
     JOIN usuarios u ON u.id = t.usuario_id
     LEFT JOIN referencias r ON r.id = t.referencia_id
     WHERE ${condiciones.join(" AND ")}
     ORDER BY t.created_at ASC`,
    valores
  );
  return result.rows;
}

/** Confirma una solicitud pendiente -- aplica UNA o DOS patas según corresponda. Quien la creó no puede confirmarla. */
export async function confirmarTransaccion(transaccionId: number, usuarioConfirmaId: number) {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    const txResult = await client.query(`SELECT * FROM transacciones WHERE id = $1 FOR UPDATE`, [transaccionId]);
    const transaccion = txResult.rows[0];
    if (!transaccion) throw Object.assign(new Error("Solicitud no encontrada"), { status: 404 });
    if (transaccion.estado !== "PENDIENTE") throw Object.assign(new Error("Esta solicitud ya fue resuelta"), { status: 409 });
    if (transaccion.usuario_id === usuarioConfirmaId) {
      throw Object.assign(new Error("Quien registró la solicitud no puede confirmarla"), { status: 403 });
    }

    const esCambio = transaccion.caja_destino_id != null;

    if (esCambio) {
      const tipoLegExtranjera = transaccion.tipo === "COMPRA_DIVISA" ? "INGRESO" : "EGRESO";
      const tipoLegLocal = transaccion.tipo === "COMPRA_DIVISA" ? "EGRESO" : "INGRESO";

      await aplicarMovimientoLeg(client, {
        cajaId: transaccion.caja_id,
        monedaId: transaccion.moneda_origen_id,
        tipo: tipoLegExtranjera,
        monto: new Decimal(transaccion.monto_origen),
        transaccionId: transaccion.id,
        usuarioId: usuarioConfirmaId,
      });
      await aplicarMovimientoLeg(client, {
        cajaId: transaccion.caja_destino_id,
        monedaId: transaccion.moneda_destino_id,
        tipo: tipoLegLocal,
        monto: new Decimal(transaccion.monto_destino),
        transaccionId: transaccion.id,
        usuarioId: usuarioConfirmaId,
        metodoPagoId: transaccion.metodo_pago_id,
      });
    } else {
      const tipoMovimiento = transaccion.tipo === "DEPOSITO" ? "INGRESO" : "EGRESO";
      await aplicarMovimientoLeg(client, {
        cajaId: transaccion.caja_id,
        monedaId: transaccion.moneda_origen_id,
        tipo: tipoMovimiento,
        monto: new Decimal(transaccion.monto_origen),
        transaccionId: transaccion.id,
        usuarioId: usuarioConfirmaId,
        metodoPagoId: transaccion.metodo_pago_id,
      });
    }

    const updateResult = await client.query(
      `UPDATE transacciones SET estado = 'CONFIRMADA', confirmada_en = now(), confirmado_por_id = $1 WHERE id = $2 RETURNING *`,
      [usuarioConfirmaId, transaccionId]
    );

    if (transaccion.referencia_id) {
      await client.query(`UPDATE referencias SET estado = 'CONFIRMADA' WHERE id = $1`, [transaccion.referencia_id]);
    }

    await client.query("COMMIT");
    return updateResult.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function rechazarTransaccion(transaccionId: number, usuarioId: number, motivo?: string) {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const txResult = await client.query(`SELECT * FROM transacciones WHERE id = $1 FOR UPDATE`, [transaccionId]);
    const transaccion = txResult.rows[0];
    if (!transaccion) throw Object.assign(new Error("Solicitud no encontrada"), { status: 404 });
    if (transaccion.estado !== "PENDIENTE") throw Object.assign(new Error("Esta solicitud ya fue resuelta"), { status: 409 });

    const updateResult = await client.query(
      `UPDATE transacciones SET estado = 'RECHAZADA', confirmado_por_id = $1, motivo_rechazo = $2 WHERE id = $3 RETURNING *`,
      [usuarioId, motivo ?? null, transaccionId]
    );
    if (transaccion.referencia_id) {
      await client.query(`UPDATE referencias SET estado = 'RECHAZADA' WHERE id = $1`, [transaccion.referencia_id]);
    }
    await client.query("COMMIT");
    return updateResult.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------- Historial (reportes/pantalla de Transacciones) ----------
interface FiltrosTransacciones {
  desde?: string;
  hasta?: string;
  monedaId?: number;
  cajaId?: number;
  estado?: string;
  tipo?: string;
}

export async function obtenerTransacciones(filtros: FiltrosTransacciones) {
  const condiciones: string[] = [];
  const valores: unknown[] = [];

  if (filtros.desde) { valores.push(filtros.desde); condiciones.push(`t.created_at >= $${valores.length}`); }
  if (filtros.hasta) { valores.push(filtros.hasta); condiciones.push(`t.created_at <= $${valores.length}`); }
  if (filtros.monedaId) { valores.push(filtros.monedaId); condiciones.push(`(t.moneda_origen_id = $${valores.length} OR t.moneda_destino_id = $${valores.length})`); }
  if (filtros.cajaId) { valores.push(filtros.cajaId); condiciones.push(`(t.caja_id = $${valores.length} OR t.caja_destino_id = $${valores.length})`); }
  if (filtros.estado) { valores.push(filtros.estado); condiciones.push(`t.estado = $${valores.length}`); }
  if (filtros.tipo) { valores.push(filtros.tipo); condiciones.push(`t.tipo = $${valores.length}`); }

  const where = condiciones.length > 0 ? `WHERE ${condiciones.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT t.*, c.nombre AS caja_nombre, cd.nombre AS caja_destino_nombre,
            m.codigo AS moneda_codigo, md.codigo AS moneda_destino_codigo,
            ter.nombre AS tercero_nombre, u.nombre AS creado_por_nombre, r.codigo AS referencia_codigo
     FROM transacciones t
     JOIN cajas c ON c.id = t.caja_id
     LEFT JOIN cajas cd ON cd.id = t.caja_destino_id
     JOIN monedas m ON m.id = t.moneda_origen_id
     LEFT JOIN monedas md ON md.id = t.moneda_destino_id
     LEFT JOIN terceros ter ON ter.id = t.tercero_id
     JOIN usuarios u ON u.id = t.usuario_id
     LEFT JOIN referencias r ON r.id = t.referencia_id
     ${where}
     ORDER BY t.created_at DESC
     LIMIT 200`,
    valores
  );
  return result.rows;
}