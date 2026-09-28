import { pool } from "../db/pool";

/**
 * Capital consolidado por moneda: lo que hay en cajas/bancos, más lo que
 * nos deben, menos lo que debemos. NO incluye todavía cuentas_corrientes
 * porque el signo (si un saldo que sube significa "les debemos" o "nos
 * deben") sigue pendiente de que confirme el cliente -- sumarlo mal acá
 * sería peor que no mostrarlo. Cuando lo confirme, es un JOIN más.
 */
export async function obtenerCapitalConsolidado() {
  const result = await pool.query(`
    SELECT
      m.id AS moneda_id,
      m.codigo,
      m.nombre,
      COALESCE(caja.total, 0) AS total_cajas,
      COALESCE(cxc.total, 0) AS total_por_cobrar,
      COALESCE(cxp.total, 0) AS total_por_pagar,
      (COALESCE(caja.total, 0) + COALESCE(cxc.total, 0) - COALESCE(cxp.total, 0)) AS capital_neto
    FROM monedas m
    LEFT JOIN (
      SELECT moneda_id, SUM(monto) AS total FROM saldos_caja GROUP BY moneda_id
    ) caja ON caja.moneda_id = m.id
    LEFT JOIN (
      SELECT moneda_id, SUM(saldo_pendiente) AS total FROM cuentas_por_cobrar WHERE estado <> 'PAGADA' GROUP BY moneda_id
    ) cxc ON cxc.moneda_id = m.id
    LEFT JOIN (
      SELECT moneda_id, SUM(saldo_pendiente) AS total FROM cuentas_por_pagar WHERE estado <> 'PAGADA' GROUP BY moneda_id
    ) cxp ON cxp.moneda_id = m.id
    WHERE m.activo = true
    ORDER BY m.codigo
  `);
  return result.rows;
}

interface FiltrosMovimientosCaja {
  desde?: string;
  hasta?: string;
  cajaId?: number;
  monedaId?: number;
}

export async function obtenerMovimientosCaja(filtros: FiltrosMovimientosCaja) {
  const condiciones: string[] = [];
  const valores: unknown[] = [];

  if (filtros.cajaId) {
    valores.push(filtros.cajaId);
    condiciones.push(`mc.caja_id = $${valores.length}`);
  }
  if (filtros.monedaId) {
    valores.push(filtros.monedaId);
    condiciones.push(`mc.moneda_id = $${valores.length}`);
  }
  if (filtros.desde) {
    valores.push(filtros.desde);
    condiciones.push(`mc.created_at >= $${valores.length}`);
  }
  if (filtros.hasta) {
    valores.push(filtros.hasta);
    condiciones.push(`mc.created_at <= $${valores.length}`);
  }

  const where = condiciones.length > 0 ? `WHERE ${condiciones.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT mc.*, c.nombre AS caja_nombre, m.codigo AS moneda_codigo
     FROM movimientos_caja mc
     JOIN cajas c ON c.id = mc.caja_id
     JOIN monedas m ON m.id = mc.moneda_id
     ${where}
     ORDER BY mc.created_at DESC`,
    valores
  );
  return result.rows;
}

interface FiltrosMovimientosCC {
  desde?: string;
  hasta?: string;
  terceroId?: number;
  canalId?: number;
}

export async function obtenerMovimientosCuentaCorriente(filtros: FiltrosMovimientosCC) {
  const condiciones: string[] = [];
  const valores: unknown[] = [];

  if (filtros.terceroId) {
    valores.push(filtros.terceroId);
    condiciones.push(`cc.tercero_id = $${valores.length}`);
  }
  if (filtros.canalId) {
    valores.push(filtros.canalId);
    condiciones.push(`cc.canal_id = $${valores.length}`);
  }
  if (filtros.desde) {
    valores.push(filtros.desde);
    condiciones.push(`mcc.fecha >= $${valores.length}`);
  }
  if (filtros.hasta) {
    valores.push(filtros.hasta);
    condiciones.push(`mcc.fecha <= $${valores.length}`);
  }

  const where = condiciones.length > 0 ? `WHERE ${condiciones.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT mcc.*, t.nombre AS tercero_nombre, ch.nombre AS canal_nombre, m.codigo AS moneda_codigo
     FROM movimientos_cuenta_corriente mcc
     JOIN cuentas_corrientes cc ON cc.id = mcc.cuenta_corriente_id
     JOIN terceros t ON t.id = cc.tercero_id
     JOIN canales_cuenta_corriente ch ON ch.id = cc.canal_id
     JOIN monedas m ON m.id = cc.moneda_id
     ${where}
     ORDER BY mcc.fecha DESC, mcc.id DESC`,
    valores
  );
  return result.rows;
}

/** Mismo formato que las hojas del Excel: fecha, descripción, cantidad, tasa, monto, saldo corrido. */
export async function obtenerEstadoCuentaTercero(terceroId: number) {
  const cuentasResult = await pool.query(
    `SELECT cc.*, ch.nombre AS canal_nombre, m.codigo AS moneda_codigo
     FROM cuentas_corrientes cc
     JOIN canales_cuenta_corriente ch ON ch.id = cc.canal_id
     JOIN monedas m ON m.id = cc.moneda_id
     WHERE cc.tercero_id = $1
     ORDER BY ch.nombre, m.codigo`,
    [terceroId]
  );

  const cuentas = cuentasResult.rows;
  const cuentasConMovimientos = [];

  for (const cuenta of cuentas) {
    const movResult = await pool.query(
      `SELECT * FROM movimientos_cuenta_corriente WHERE cuenta_corriente_id = $1 ORDER BY fecha, id`,
      [cuenta.id]
    );
    cuentasConMovimientos.push({ ...cuenta, movimientos: movResult.rows });
  }

  return cuentasConMovimientos;
}

interface FiltrosCuadres {
  cajaId?: number;
  estado?: string;
}

export async function obtenerCuadresCaja(filtros: FiltrosCuadres) {
  const condiciones: string[] = [];
  const valores: unknown[] = [];

  if (filtros.cajaId) {
    valores.push(filtros.cajaId);
    condiciones.push(`cc.caja_id = $${valores.length}`);
  }
  if (filtros.estado) {
    valores.push(filtros.estado);
    condiciones.push(`cc.estado = $${valores.length}`);
  }

  const where = condiciones.length > 0 ? `WHERE ${condiciones.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT cc.*, c.nombre AS caja_nombre, m.codigo AS moneda_codigo
     FROM cierres_caja cc
     JOIN cajas c ON c.id = cc.caja_id
     JOIN monedas m ON m.id = cc.moneda_id
     ${where}
     ORDER BY cc.fecha_apertura DESC`,
    valores
  );
  return result.rows;
}