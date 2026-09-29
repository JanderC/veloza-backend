import { PoolClient } from "pg";
import { pool } from "../db/pool";

function errorHttp(mensaje: string, status: number) {
  return Object.assign(new Error(mensaje), { status });
}

export async function listarMetodosPago(opciones: { incluirInactivos: boolean }) {
  const result = await pool.query(
    `SELECT mp.*, c.nombre AS cuenta_nombre, c.banco AS cuenta_banco
     FROM metodos_pago mp
     LEFT JOIN cajas c ON c.id = mp.cuenta_id
     ${opciones.incluirInactivos ? "" : "WHERE mp.activo = true"}
     ORDER BY mp.activo DESC, mp.nombre`
  );
  return result.rows;
}

// La cuenta es opcional; si viene, tiene que ser una cuenta (caja tipo BANCO) activa
async function validarCuenta(client: PoolClient, cuentaId: number | null | undefined) {
  if (cuentaId == null) return;
  const result = await client.query(`SELECT nombre, tipo, activo FROM cajas WHERE id = $1`, [cuentaId]);
  const cuenta = result.rows[0];
  if (!cuenta) throw errorHttp("Cuenta no encontrada", 404);
  if (cuenta.tipo !== "BANCO") throw errorHttp(`"${cuenta.nombre}" no es una cuenta bancaria: solo se pueden vincular cuentas`, 400);
  if (!cuenta.activo) throw errorHttp(`La cuenta "${cuenta.nombre}" está inactiva`, 409);
}

function traducirNombreDuplicado(err: unknown) {
  if (typeof err === "object" && err !== null && "code" in err && err.code === "23505") {
    return errorHttp("Ya existe un método de pago con ese nombre", 409);
  }
  return err;
}

async function obtenerConCuenta(client: PoolClient, id: number) {
  const result = await client.query(
    `SELECT mp.*, c.nombre AS cuenta_nombre, c.banco AS cuenta_banco
     FROM metodos_pago mp LEFT JOIN cajas c ON c.id = mp.cuenta_id
     WHERE mp.id = $1`,
    [id]
  );
  return result.rows[0];
}

export async function crearMetodoPago(input: { nombre: string; cuentaId?: number | null }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await validarCuenta(client, input.cuentaId);
    const result = await client.query(`INSERT INTO metodos_pago (nombre, cuenta_id) VALUES ($1, $2) RETURNING id`, [
      input.nombre.trim(),
      input.cuentaId ?? null,
    ]);
    const metodo = await obtenerConCuenta(client, result.rows[0].id);
    await client.query("COMMIT");
    return metodo;
  } catch (err) {
    await client.query("ROLLBACK");
    throw traducirNombreDuplicado(err);
  } finally {
    client.release();
  }
}

// undefined = no tocar; cuentaId null = desvincular
export async function actualizarMetodoPago(id: number, input: { nombre?: string; cuentaId?: number | null; activo?: boolean }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existe = await client.query(`SELECT id FROM metodos_pago WHERE id = $1 FOR UPDATE`, [id]);
    if (existe.rows.length === 0) throw errorHttp("Método de pago no encontrado", 404);
    if (input.cuentaId !== undefined) await validarCuenta(client, input.cuentaId);

    await client.query(
      `UPDATE metodos_pago SET
         nombre = COALESCE($2, nombre),
         cuenta_id = CASE WHEN $3::boolean THEN $4::int ELSE cuenta_id END,
         activo = COALESCE($5, activo)
       WHERE id = $1`,
      [id, input.nombre?.trim() ?? null, input.cuentaId !== undefined, input.cuentaId ?? null, input.activo ?? null]
    );
    const metodo = await obtenerConCuenta(client, id);
    await client.query("COMMIT");
    return metodo;
  } catch (err) {
    await client.query("ROLLBACK");
    throw traducirNombreDuplicado(err);
  } finally {
    client.release();
  }
}
