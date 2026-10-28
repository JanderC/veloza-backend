import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { actualizarCaja } from "./cajas.service";

function errorHttp(mensaje: string, status: number) {
  return Object.assign(new Error(mensaje), { status });
}

/**
 * Las taquillas que hay (cada una es una caja con su número): habilitadas y deshabilitadas, si están abiertas
 * y lo que tienen. El panel de módulos muestra las habilitadas; Configuración las crea y las habilita.
 */
export async function listarTaquillas() {
  const r = await pool.query(
    `SELECT c.taquilla_numero AS numero, c.nombre, c.activo, c.id AS caja_id,
            EXISTS (SELECT 1 FROM cierres_caja z WHERE z.caja_id = c.id AND z.estado = 'ABIERTA') AS abierta,
            COALESCE((SELECT json_agg(json_build_object('codigo', m.codigo, 'monto', s.monto) ORDER BY m.id)
                      FROM saldos_caja s JOIN monedas m ON m.id = s.moneda_id WHERE s.caja_id = c.id AND s.monto <> 0), '[]') AS saldos
     FROM cajas c WHERE c.taquilla_numero IS NOT NULL ORDER BY c.taquilla_numero`
  );
  return r.rows as { numero: number; nombre: string; activo: boolean; caja_id: number; abierta: boolean; saldos: { codigo: string; monto: string }[] }[];
}

/** Una taquilla nueva: el número que sigue, su caja en cero en pesos, dólares y euros, y habilitada. */
export async function crearTaquilla(nombre?: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // de a una: dos creaciones a la vez no sacan el mismo número
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('crear-taquilla'))`);
    const numero = Number((await client.query(`SELECT COALESCE(MAX(taquilla_numero), 0) + 1 AS n FROM cajas`)).rows[0].n);
    const titulo = nombre?.trim() || `Taquilla ${numero}`;
    const existe = await client.query(`SELECT 1 FROM cajas WHERE lower(nombre) = lower($1)`, [titulo]);
    if (existe.rows[0]) throw errorHttp(`Ya hay una caja que se llama "${titulo}": ponle otro nombre`, 409);
    const caja = await client.query(
      `INSERT INTO cajas (nombre, tipo, descripcion, es_taquilla, taquilla_numero)
       VALUES ($1, 'FISICA', $2, true, $3) RETURNING id`,
      [titulo, `Caja del módulo ${titulo}: efectivo en pesos, dólares y euros`, numero]
    );
    await client.query(
      `INSERT INTO saldos_caja (caja_id, moneda_id, monto)
       SELECT $1, m.id, 0 FROM monedas m WHERE m.codigo IN ('COP', 'USD', 'EUR') ON CONFLICT DO NOTHING`,
      [caja.rows[0].id]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return listarTaquillas();
}

/**
 * Cambiarle el nombre, o habilitarla y deshabilitarla. Para deshabilitarla tiene que estar cerrada y sin efectivo
 * (lo valida la caja), así no queda plata en una taquilla que ya no aparece.
 */
export async function editarTaquilla(numero: number, input: { nombre?: string; activo?: boolean }) {
  const r = await pool.query(`SELECT id FROM cajas WHERE taquilla_numero = $1`, [numero]);
  if (!r.rows[0]) throw errorHttp(`No existe la taquilla ${numero}`, 404);
  if (input.nombre !== undefined && !input.nombre.trim()) throw errorHttp("El nombre no puede quedar vacío", 400);
  if (input.activo === false) {
    // dicho como en la taquilla; la caja igual lo vuelve a validar
    const t = (await listarTaquillas()).find((x) => x.numero === numero);
    const motivos: string[] = [];
    if (t?.abierta) motivos.push("está abierta (ciérrala y cuádrala primero)");
    if (t?.saldos.length) motivos.push(`tiene efectivo: ${t.saldos.map((s) => `${new Decimal(s.monto).toString()} ${s.codigo}`).join(", ")} (pásalo a la Caja Fuerte)`);
    if (motivos.length) throw errorHttp(`No se puede deshabilitar ${t?.nombre}: ${motivos.join(" y ")}.`, 409);
  }
  await actualizarCaja(r.rows[0].id, input);
  return listarTaquillas();
}
