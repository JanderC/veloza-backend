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
/**
 * Rendimiento de cada empleado en un día (hora de Colombia): confirmaciones que registró, clientes que atendió en
 * taquilla (operaciones de ventanilla y confirmaciones que pagó) y cuánto movió, por moneda. El dueño ve a todos;
 * cada empleado, solo lo suyo.
 */
export async function obtenerRendimiento(dia: string, soloUsuarioId: number | null) {
  const Z = "America/Bogota";
  const delDia = (col: string) => `(${col} AT TIME ZONE '${Z}')::date = $1::date`;
  const p = [dia, soloUsuarioId];
  const filtroU = (col: string) => `($2::int IS NULL OR ${col} = $2)`;
  const [usuarios, confirmaciones, pagos, operaciones, otros] = await Promise.all([
    pool.query(`SELECT id, nombre, rol FROM usuarios WHERE activo AND ($1::int IS NULL OR id = $1) ORDER BY nombre`, [soloUsuarioId]),
    // confirmaciones registradas (lo que se le debe al cliente), por moneda
    pool.query(
      `SELECT mc.usuario_id, m.codigo, count(*)::int AS cantidad, sum(mc.monto) AS total, count(DISTINCT cc.tercero_id)::int AS clientes
       FROM movimientos_cuenta_corriente mc JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id AND cc.modulo = 'CAJA' JOIN monedas m ON m.id = cc.moneda_id
       WHERE mc.monto > 0 AND NOT mc.anulado AND mc.reverso_de_id IS NULL AND ${delDia("mc.created_at")} AND ${filtroU("mc.usuario_id")}
       GROUP BY 1, 2`,
      p
    ),
    // confirmaciones que pagó (en taquilla o por otro método)
    pool.query(
      `SELECT mc.pagado_por AS usuario_id, m.codigo, count(*)::int AS cantidad, sum(mc.monto) AS total
       FROM movimientos_cuenta_corriente mc JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id JOIN monedas m ON m.id = cc.moneda_id
       WHERE mc.pagado_en IS NOT NULL AND ${delDia("mc.pagado_en")} AND ${filtroU("mc.pagado_por")}
       GROUP BY 1, 2`,
      p
    ),
    // operaciones de ventanilla en taquilla (cada una es un cliente atendido)
    pool.query(
      `SELECT o.usuario_id, o.tipo, m.codigo, count(*)::int AS cantidad, sum(o.cantidad) AS total
       FROM operaciones_taquilla o JOIN monedas m ON m.id = o.moneda_id
       WHERE o.estado <> 'ANULADA' AND ${delDia("o.created_at")} AND ${filtroU("o.usuario_id")}
       GROUP BY 1, 2, 3`,
      p
    ),
    // movimientos que cargó en Cuentas Corrientes y Cuentas por Cobrar
    pool.query(
      `SELECT mc.usuario_id, cc.modulo, count(*)::int AS cantidad
       FROM movimientos_cuenta_corriente mc JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id AND cc.modulo IN ('CORRIENTE', 'POR_COBRAR')
       WHERE NOT mc.anulado AND mc.reverso_de_id IS NULL AND ${delDia("mc.created_at")} AND ${filtroU("mc.usuario_id")}
       GROUP BY 1, 2`,
      p
    ),
  ]);
  type Total = { codigo: string; cantidad: number; total: string };
  const de = <T extends { usuario_id: number }>(filas: T[], id: number) => filas.filter((f) => f.usuario_id === id);
  const filas = usuarios.rows.map((u) => {
    const conf = de(confirmaciones.rows, u.id);
    const pag = de(pagos.rows, u.id);
    const ops = de(operaciones.rows, u.id);
    const otr = de(otros.rows, u.id);
    const suma = (l: { cantidad: number }[]) => l.reduce((s, x) => s + x.cantidad, 0);
    const porMoneda = (l: { codigo: string; cantidad: number; total: string }[]): Total[] => l.map((x) => ({ codigo: x.codigo, cantidad: x.cantidad, total: String(x.total) }));
    return {
      usuarioId: u.id as number,
      nombre: u.nombre as string,
      rol: u.rol as string,
      confirmaciones: { cantidad: suma(conf), clientes: conf.reduce((s, x) => s + x.clientes, 0), porMoneda: porMoneda(conf) },
      pagadas: { cantidad: suma(pag), porMoneda: porMoneda(pag) },
      ventanilla: {
        cantidad: suma(ops),
        ingresos: porMoneda(ops.filter((o) => o.tipo === "INGRESO")),
        egresos: porMoneda(ops.filter((o) => o.tipo === "EGRESO")),
      },
      // clientes atendidos en taquilla: cada operación de ventanilla y cada confirmación que pagó
      clientesTaquilla: suma(ops) + suma(pag),
      cuentasCorrientes: otr.find((x) => x.modulo === "CORRIENTE")?.cantidad ?? 0,
      cuentasPorCobrar: otr.find((x) => x.modulo === "POR_COBRAR")?.cantidad ?? 0,
    };
  });
  // el dueño ve también a los que no hicieron nada; ordenados por lo que hicieron
  const total = (f: (typeof filas)[number]) => f.confirmaciones.cantidad + f.clientesTaquilla + f.cuentasCorrientes + f.cuentasPorCobrar;
  return { dia, empleados: filas.sort((a, b) => total(b) - total(a)) };
}

/**
 * Clientes que más vienen (Confirmaciones): cuántas confirmaciones les hicimos en el período, en cuántos días distintos
 * vinieron, cuánto fue por moneda, cuántas ya retiraron y la última vez. Del que más viene al que menos.
 */
export async function obtenerClientesFrecuentes(desde: string, hasta: string, limite = 50) {
  const r = await pool.query(
    `WITH conf AS (
       SELECT cc.tercero_id, m.codigo, mc.monto, mc.fecha, mc.pagado_en
       FROM movimientos_cuenta_corriente mc
       JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id AND cc.modulo = $$CAJA$$
       JOIN monedas m ON m.id = cc.moneda_id
       WHERE mc.monto > 0 AND NOT mc.anulado AND mc.reverso_de_id IS NULL
         AND (mc.fecha AT TIME ZONE $$America/Bogota$$)::date BETWEEN $1::date AND $2::date
     ), por_moneda AS (
       SELECT tercero_id, codigo, sum(monto) AS total FROM conf GROUP BY 1, 2
     )
     SELECT t.id AS tercero_id, t.nombre, t.telefono, count(*)::int AS confirmaciones,
            count(DISTINCT (c.fecha AT TIME ZONE $$America/Bogota$$)::date)::int AS dias,
            count(c.pagado_en)::int AS retiradas, min(c.fecha) AS primera, max(c.fecha) AS ultima,
            (SELECT json_agg(json_build_object($$codigo$$, pm.codigo, $$total$$, pm.total) ORDER BY pm.total DESC) FROM por_moneda pm WHERE pm.tercero_id = t.id) AS totales,
            (SELECT cc2.id FROM cuentas_corrientes cc2 WHERE cc2.tercero_id = t.id AND cc2.modulo = $$CAJA$$ AND cc2.activo ORDER BY cc2.id LIMIT 1) AS cuenta_id
     FROM conf c JOIN terceros t ON t.id = c.tercero_id
     GROUP BY t.id, t.nombre, t.telefono
     ORDER BY confirmaciones DESC, dias DESC, ultima DESC
     LIMIT $3`,
    [desde, hasta, limite]
  );
  return r.rows as {
    tercero_id: number;
    nombre: string;
    telefono: string | null;
    confirmaciones: number;
    dias: number;
    retiradas: number;
    primera: string;
    ultima: string;
    totales: { codigo: string; total: string }[];
    cuenta_id: number | null;
  }[];
}
