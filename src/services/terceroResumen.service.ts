import { pool } from "../db/pool";

export async function obtenerResumenTercero(terceroId: number) {
  const terceroResult = await pool.query(`SELECT * FROM terceros WHERE id = $1`, [terceroId]);
  const tercero = terceroResult.rows[0];
  if (!tercero) return null;

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

  const cxcResult = await pool.query(
    `SELECT cxc.*, m.codigo AS moneda_codigo
     FROM cuentas_por_cobrar cxc JOIN monedas m ON m.id = cxc.moneda_id
     WHERE cxc.tercero_id = $1 AND cxc.estado <> 'PAGADA'`,
    [terceroId]
  );
  const cxpResult = await pool.query(
    `SELECT cxp.*, m.codigo AS moneda_codigo
     FROM cuentas_por_pagar cxp JOIN monedas m ON m.id = cxp.moneda_id
     WHERE cxp.tercero_id = $1 AND cxp.estado <> 'PAGADA'`,
    [terceroId]
  );

  return {
    tercero,
    cuentas: {
      disponibles: cuentas.filter((c) => c.estado === "DISPONIBLE"),
      bloqueadas: cuentas.filter((c) => c.estado === "BLOQUEADA"),
      cerradas: cuentas.filter((c) => c.estado === "CERRADA"),
    },
    cuentasPorCobrar: cxcResult.rows,
    cuentasPorPagar: cxpResult.rows,
  };
}