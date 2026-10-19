import { pool } from "../db/pool";

/**
 * La "Tasa del día": un juego de valores (clave -> número escrito, ej. "dolar.compra.100-50" -> "3200"). Cada
 * actualización es una versión nueva; la vigente es la última y se compara con la anterior para saber si subió o bajó.
 */
export type ValoresTablero = Record<string, string>;

const SELECT = `SELECT tt.id, tt.valores, tt.created_at, u.nombre AS usuario FROM tablero_tasas tt LEFT JOIN usuarios u ON u.id = tt.usuario_id`;

export async function obtenerTablero() {
  const r = await pool.query(`${SELECT} ORDER BY tt.id DESC LIMIT 2`);
  const [actual, anterior] = r.rows;
  return {
    actual: actual ? { valores: actual.valores as ValoresTablero, actualizado: actual.created_at as string, por: actual.usuario as string | null } : null,
    anterior: anterior ? { valores: anterior.valores as ValoresTablero, actualizado: anterior.created_at as string } : null,
  };
}

/** Guarda el tablero completo como versión nueva (la hora de actualización es la de ahora). */
export async function guardarTablero(valores: ValoresTablero, usuarioId: number) {
  await pool.query(`INSERT INTO tablero_tasas (valores, usuario_id) VALUES ($1, $2)`, [JSON.stringify(valores), usuarioId]);
  return obtenerTablero();
}

/** Cambia una sola tasa (ej. desde Cuentas Corrientes: "guardar esta tasa como la del día"). */
export async function actualizarTasaTablero(clave: string, valor: string, usuarioId: number) {
  const r = await pool.query(`SELECT valores FROM tablero_tasas ORDER BY id DESC LIMIT 1`);
  const valores: ValoresTablero = { ...((r.rows[0]?.valores as ValoresTablero | undefined) ?? {}), [clave]: valor };
  return guardarTablero(valores, usuarioId);
}

/** Las versiones de un día (para ver cómo cambió la tasa durante el día). */
export async function historialTablero(limite = 30) {
  const r = await pool.query(`${SELECT} ORDER BY tt.id DESC LIMIT $1`, [limite]);
  return r.rows.map((x) => ({ id: x.id as number, valores: x.valores as ValoresTablero, actualizado: x.created_at as string, por: x.usuario as string | null }));
}
