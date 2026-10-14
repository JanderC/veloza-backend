import { pool } from "../db/pool";

// Capital de giros: lo que el sistema ya sabe para el cuadre (los saldos de las cajas y las confirmaciones sin pagar)
// y los cuadres guardados. Lo que está fuera del sistema lo llena el administrador en la pantalla.

/** Saldos de cada caja (taquillas, cajas y Caja Fuerte) por moneda, y lo que falta pagar de confirmaciones. */
export async function obtenerDatosDelSistema() {
  const cajas = await pool.query(
    `SELECT c.id, c.nombre, c.tipo, m.codigo, s.monto
     FROM cajas c JOIN saldos_caja s ON s.caja_id = c.id JOIN monedas m ON m.id = s.moneda_id
     WHERE c.activo AND c.tipo IN ('FISICA', 'FUERTE') AND s.monto <> 0
     ORDER BY CASE c.tipo WHEN 'FUERTE' THEN 1 ELSE 0 END, c.id, m.codigo`
  );
  // confirmaciones que le debemos a clientes y todavía no se pagaron (ni en taquilla ni por otro método)
  const porPagar = await pool.query(
    `SELECT m.codigo, sum(mc.monto) AS total, count(*)::int AS cantidad
     FROM movimientos_cuenta_corriente mc JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id JOIN monedas m ON m.id = cc.moneda_id
     WHERE cc.modulo = 'CAJA' AND mc.monto > 0 AND NOT mc.anulado AND mc.reverso_de_id IS NULL AND mc.pagado_en IS NULL
     GROUP BY m.codigo ORDER BY m.codigo`
  );
  const porCaja = new Map<number, { id: number; nombre: string; tipo: string; saldos: { codigo: string; monto: string }[] }>();
  for (const r of cajas.rows) {
    const c = porCaja.get(r.id) ?? { id: r.id, nombre: r.nombre, tipo: r.tipo, saldos: [] as { codigo: string; monto: string }[] };
    c.saldos.push({ codigo: r.codigo, monto: r.monto });
    porCaja.set(r.id, c);
  }
  return { cajas: [...porCaja.values()], confirmacionesPorPagar: porPagar.rows as { codigo: string; total: string; cantidad: number }[] };
}

export async function guardarCuadre(input: { datos: unknown; capitalCop: number; capitalDivisa: number; capitalDivisaCop: number; nota?: string }, usuarioId: number) {
  const r = await pool.query(
    `INSERT INTO capital_cuadres (usuario_id, datos, capital_cop, capital_divisa, capital_divisa_cop, nota) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [usuarioId, JSON.stringify(input.datos), input.capitalCop, input.capitalDivisa, input.capitalDivisaCop, input.nota?.trim() || null]
  );
  return r.rows[0];
}

/** Los cuadres guardados, del más nuevo al más viejo (sin el detalle). */
export async function listarCuadres(limite = 60) {
  const r = await pool.query(
    `SELECT c.id, c.created_at, c.capital_cop, c.capital_divisa, c.capital_divisa_cop, c.nota, u.nombre AS usuario_nombre
     FROM capital_cuadres c JOIN usuarios u ON u.id = c.usuario_id ORDER BY c.created_at DESC LIMIT $1`,
    [limite]
  );
  return r.rows;
}

export async function obtenerCuadre(id: number) {
  const r = await pool.query(
    `SELECT c.*, u.nombre AS usuario_nombre FROM capital_cuadres c JOIN usuarios u ON u.id = c.usuario_id WHERE c.id = $1`,
    [id]
  );
  if (!r.rows[0]) throw Object.assign(new Error("Ese cuadre no existe"), { status: 404 });
  return r.rows[0];
}
