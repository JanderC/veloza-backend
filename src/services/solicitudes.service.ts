import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { obtenerVerificacionTercero } from "./documentosTercero.service";

export interface Pata {
  cajaId: number;
  monedaId: number;
  tipo: "INGRESO" | "EGRESO";
  monto: string;
}

/**
 * Qué movimientos de caja aplicaría confirmar esta transacción. Es la MISMA regla
 * que usa confirmarTransaccion: si cambia allá, tiene que cambiar acá.
 */
export function patasDeTransaccion(t: {
  tipo: string;
  caja_id: number;
  caja_destino_id: number | null;
  moneda_origen_id: number;
  moneda_destino_id: number | null;
  monto_origen: string;
  monto_destino: string | null;
}): Pata[] {
  if (t.caja_destino_id != null && t.moneda_destino_id != null && t.monto_destino != null) {
    const esCompra = t.tipo === "COMPRA_DIVISA";
    return [
      { cajaId: t.caja_id, monedaId: t.moneda_origen_id, tipo: esCompra ? "INGRESO" : "EGRESO", monto: t.monto_origen },
      { cajaId: t.caja_destino_id, monedaId: t.moneda_destino_id, tipo: esCompra ? "EGRESO" : "INGRESO", monto: t.monto_destino },
    ];
  }
  return [{ cajaId: t.caja_id, monedaId: t.moneda_origen_id, tipo: t.tipo === "DEPOSITO" ? "INGRESO" : "EGRESO", monto: t.monto_origen }];
}

function errorHttp(mensaje: string, status: number) {
  return Object.assign(new Error(mensaje), { status });
}

/**
 * Todo lo que quien confirma necesita para verificar la plata ANTES de aprobar:
 * qué entra y qué sale (con saldo y turno de cada caja), a dónde se le paga al
 * cliente, la referencia, las capturas y alertas.
 */
export async function obtenerDetalleSolicitud(id: number) {
  const txResult = await pool.query(
    `SELECT t.*, u.nombre AS creado_por_nombre, uc.nombre AS confirmado_por_nombre,
            r.codigo AS referencia_codigo, r.banco_origen AS referencia_banco_origen, r.estado AS referencia_estado,
            mp.nombre AS metodo_pago_nombre, mpc.nombre AS metodo_pago_cuenta_nombre,
            m.codigo AS moneda_codigo, md.codigo AS moneda_destino_codigo
     FROM transacciones t
     JOIN monedas m ON m.id = t.moneda_origen_id
     LEFT JOIN monedas md ON md.id = t.moneda_destino_id
     JOIN usuarios u ON u.id = t.usuario_id
     LEFT JOIN usuarios uc ON uc.id = t.confirmado_por_id
     LEFT JOIN referencias r ON r.id = t.referencia_id
     LEFT JOIN metodos_pago mp ON mp.id = t.metodo_pago_id
     LEFT JOIN cajas mpc ON mpc.id = mp.cuenta_id
     WHERE t.id = $1`,
    [id]
  );
  const t = txResult.rows[0];
  if (!t) throw errorHttp("Solicitud no encontrada", 404);

  // ---- Patas con el estado real de cada caja ----
  const patas = [];
  for (const pata of patasDeTransaccion(t)) {
    const r = await pool.query(
      `SELECT c.id, c.nombre, c.tipo, c.banco, c.numero_cuenta, c.tipo_cuenta, c.titular, c.identificacion_titular, c.telefono, c.email,
              m.codigo AS moneda_codigo, m.decimales,
              COALESCE((SELECT monto FROM saldos_caja WHERE caja_id = c.id AND moneda_id = m.id), 0) AS saldo_actual,
              EXISTS (SELECT 1 FROM cierres_caja WHERE caja_id = c.id AND moneda_id = m.id AND estado = 'ABIERTA') AS turno_abierto
       FROM cajas c, monedas m WHERE c.id = $1 AND m.id = $2`,
      [pata.cajaId, pata.monedaId]
    );
    const caja = r.rows[0];
    const saldoActual = new Decimal(caja.saldo_actual);
    const monto = new Decimal(pata.monto);
    const saldoDespues = pata.tipo === "INGRESO" ? saldoActual.plus(monto) : saldoActual.minus(monto);
    patas.push({
      tipo: pata.tipo,
      monto: pata.monto,
      monedaId: pata.monedaId,
      monedaCodigo: caja.moneda_codigo,
      decimales: Number(caja.decimales),
      caja: {
        id: caja.id,
        nombre: caja.nombre,
        tipo: caja.tipo,
        banco: caja.banco,
        numeroCuenta: caja.numero_cuenta,
        tipoCuenta: caja.tipo_cuenta,
        titular: caja.titular,
        identificacionTitular: caja.identificacion_titular,
        telefono: caja.telefono,
        email: caja.email,
      },
      saldoActual: saldoActual.toFixed(4),
      saldoDespues: saldoDespues.toFixed(4),
      turnoAbierto: caja.turno_abierto as boolean,
      saldoSuficiente: !saldoDespues.isNegative(),
    });
  }

  // ---- Cliente, su historial y la cuenta a donde se le paga ----
  let cliente = null;
  if (t.tercero_id) {
    const c = await pool.query(
      `SELECT ter.id, ter.nombre, ter.identificacion, ter.telefono, ter.tipo, ter.created_at,
              count(tx.id) FILTER (WHERE tx.estado = 'CONFIRMADA') AS confirmadas,
              count(tx.id) FILTER (WHERE tx.estado = 'RECHAZADA') AS rechazadas,
              count(tx.id) FILTER (WHERE tx.estado = 'PENDIENTE' AND tx.id <> $2) AS otras_pendientes
       FROM terceros ter LEFT JOIN transacciones tx ON tx.tercero_id = ter.id
       WHERE ter.id = $1 GROUP BY ter.id`,
      [t.tercero_id, id]
    );
    const fila = c.rows[0];
    cliente = {
      id: fila.id,
      nombre: fila.nombre,
      identificacion: fila.identificacion,
      telefono: fila.telefono,
      clienteDesde: fila.created_at,
      operacionesConfirmadas: Number(fila.confirmadas),
      operacionesRechazadas: Number(fila.rechazadas),
      otrasPendientes: Number(fila.otras_pendientes),
      verificacion: await obtenerVerificacionTercero(fila.id),
    };
  }

  let cuentaCliente = null;
  if (t.cuenta_tercero_id) {
    const r = await pool.query(`SELECT ct.*, m.codigo AS moneda_codigo FROM cuentas_tercero ct LEFT JOIN monedas m ON m.id = ct.moneda_id WHERE ct.id = $1`, [
      t.cuenta_tercero_id,
    ]);
    cuentaCliente = r.rows[0] ?? null;
  }

  // ---- Capturas y soportes vinculados a esta operación ----
  const docs = await pool.query(
    `SELECT d.id, d.tipo, d.descripcion, d.nombre_original, d.mime_type, d.tamano_bytes, d.estado, d.created_at, u.nombre AS subido_por_nombre
     FROM documentos_tercero d JOIN usuarios u ON u.id = d.subido_por_id
     WHERE d.transaccion_id = $1 ORDER BY d.created_at`,
    [id]
  );

  // ---- Posibles duplicados: mismo cliente, mismo monto y moneda, últimas 48 h ----
  const duplicados = t.tercero_id
    ? await pool.query(
        `SELECT id, estado, created_at FROM transacciones
         WHERE tercero_id = $1 AND id <> $2 AND moneda_origen_id = $3 AND monto_origen = $4 AND tipo = $5
           AND created_at > $6::timestamptz - interval '48 hours' AND estado IN ('PENDIENTE', 'CONFIRMADA')
         ORDER BY created_at DESC LIMIT 5`,
        [t.tercero_id, id, t.moneda_origen_id, t.monto_origen, t.tipo, t.created_at]
      )
    : { rows: [] };

  // ---- Alertas: lo que haría fallar la confirmación va como "bloqueante" ----
  const alertas: { nivel: "bloqueante" | "advertencia" | "info"; mensaje: string }[] = [];
  for (const p of patas) {
    if (!p.turnoAbierto) alertas.push({ nivel: "bloqueante", mensaje: `${p.caja.nombre} no tiene turno abierto en ${p.monedaCodigo}.` });
    if (!p.saldoSuficiente) alertas.push({ nivel: "bloqueante", mensaje: `Saldo insuficiente en ${p.caja.nombre}: hay ${p.saldoActual} ${p.monedaCodigo} y salen ${p.monto}.` });
  }
  if (duplicados.rows.length > 0) {
    alertas.push({
      nivel: "advertencia",
      mensaje: `Posible duplicado: este cliente tiene ${duplicados.rows.length} operación(es) igual(es) en las últimas 48 h (#${duplicados.rows.map((d) => d.id).join(", #")}).`,
    });
  }
  if (docs.rows.length === 0) alertas.push({ nivel: "advertencia", mensaje: "No hay captura ni comprobante adjunto a esta operación." });
  if (cliente && cliente.verificacion.estado !== "VERIFICADO") {
    alertas.push({ nivel: "advertencia", mensaje: "El cliente no tiene la identidad verificada." });
  }
  if (cliente && cliente.operacionesConfirmadas === 0) alertas.push({ nivel: "info", mensaje: "Primera operación de este cliente." });

  return {
    transaccion: t,
    patas,
    cliente,
    cuentaCliente,
    documentos: docs.rows,
    alertas,
  };
}

// ---------- Verificación que acompaña a la confirmación ----------
export interface VerificacionConfirmacion {
  montoVerificado?: string; // lo que quien confirma vio en el banco
  checklist?: string[];
  nota?: string;
}

/**
 * Si quien confirma escribió el monto que vio en el banco, tiene que coincidir con
 * la pata que pasa por un banco (lo que llega o lo que sale por transferencia).
 */
export function validarMontoVerificado(
  patas: Pata[],
  tiposCaja: Map<number, string>,
  montoVerificado: string | undefined
) {
  if (montoVerificado === undefined) return;
  const pataBanco = patas.find((p) => tiposCaja.get(p.cajaId) === "BANCO") ?? patas[0];
  if (!pataBanco) return;
  let verificado: Decimal;
  try {
    verificado = new Decimal(montoVerificado.replace(",", "."));
  } catch {
    throw errorHttp("El monto verificado no es un número válido", 400);
  }
  if (!verificado.eq(pataBanco.monto)) {
    throw errorHttp(
      `El monto verificado (${verificado.toString()}) no coincide con el de la operación (${new Decimal(pataBanco.monto).toString()}). Revisá antes de confirmar.`,
      409
    );
  }
}
