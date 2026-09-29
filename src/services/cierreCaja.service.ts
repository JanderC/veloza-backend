import { PoolClient } from "pg";
import Decimal from "decimal.js";
import { pool } from "../db/pool";

/**
 * Bloquea cualquier movimiento de caja si esa caja+moneda no tiene turno
 * ABIERTO. Se llama DENTRO de la transacción del movimiento: el FOR SHARE
 * mantiene el turno bloqueado hasta el COMMIT, así cerrarCaja (FOR UPDATE)
 * espera a que termine y su saldo_esperado ya incluye este movimiento.
 */
export async function exigirTurnoAbierto(client: PoolClient, cajaId: number, monedaId: number) {
  const result = await client.query(
    `SELECT id FROM cierres_caja WHERE caja_id = $1 AND moneda_id = $2 AND estado = 'ABIERTA' FOR SHARE`,
    [cajaId, monedaId]
  );
  if (result.rows.length === 0) {
    throw Object.assign(new Error("La caja no tiene un turno abierto en esta moneda"), { status: 409 });
  }
}

/**
 * Igual que abrirCaja pero dentro de una transacción ya abierta, y sin error
 * si el turno ya existe. Lo usan fondeo y transferencias para abrir el turno
 * del destino en el mismo paso. saldo_inicial = saldo ANTES del movimiento.
 */
export async function abrirTurnoSiFalta(client: PoolClient, cajaId: number, monedaId: number, usuarioId: number) {
  await client.query(
    `INSERT INTO cierres_caja (caja_id, moneda_id, usuario_id, fecha_apertura, saldo_inicial, estado)
     VALUES ($1, $2, $3, now(), COALESCE((SELECT monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2), 0), 'ABIERTA')
     ON CONFLICT (caja_id, moneda_id) WHERE estado = 'ABIERTA' DO NOTHING`,
    [cajaId, monedaId, usuarioId]
  );
}

interface AbrirCajaInput {
  cajaId: number;
  monedaId: number;
  usuarioId: number;
}

/**
 * Abre un turno de caja. El saldo_inicial NO se pide manualmente -- se toma
 * directo de saldos_caja, que ya es la fuente de verdad actualizada por
 * cada transacción atómica. Así se evita que alguien "declare" un saldo
 * inicial que no coincide con lo que el sistema ya sabe.
 */
export async function abrirCaja(input: AbrirCajaInput) {
  const abiertoExistente = await pool.query(
    `SELECT id FROM cierres_caja WHERE caja_id = $1 AND moneda_id = $2 AND estado = 'ABIERTA'`,
    [input.cajaId, input.monedaId]
  );
  if (abiertoExistente.rows.length > 0) {
    throw Object.assign(new Error("Ya hay un turno abierto para esta caja y moneda"), { status: 409 });
  }

  const saldoResult = await pool.query(`SELECT monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2`, [
    input.cajaId,
    input.monedaId,
  ]);
  const saldoInicial = saldoResult.rows.length > 0 ? new Decimal(saldoResult.rows[0].monto) : new Decimal(0);

  const result = await pool.query(
    `INSERT INTO cierres_caja (caja_id, moneda_id, usuario_id, fecha_apertura, saldo_inicial, estado)
     VALUES ($1, $2, $3, now(), $4, 'ABIERTA')
     RETURNING *`,
    [input.cajaId, input.monedaId, input.usuarioId, saldoInicial.toFixed(4)]
  );
  return result.rows[0];
}

interface CerrarCajaInput {
  cierreId: number;
  saldoReal: string; // lo que el cajero contó físicamente
  usuarioId: number;
}

/**
 * Cierra un turno. saldo_esperado se toma de saldos_caja en el momento del
 * cierre (no se recalcula sumando movimientos: saldos_caja ya está siempre
 * sincronizado por cada operación atómica). diferencia = real - esperado.
 */
export async function cerrarCaja(input: CerrarCajaInput) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // FOR UPDATE espera a que terminen los movimientos en curso (FOR SHARE en exigirTurnoAbierto)
    const cierreResult = await client.query(`SELECT * FROM cierres_caja WHERE id = $1 FOR UPDATE`, [input.cierreId]);
    const cierre = cierreResult.rows[0];
    if (!cierre) {
      throw Object.assign(new Error("Cierre no encontrado"), { status: 404 });
    }
    if (cierre.estado === "CERRADA") {
      throw Object.assign(new Error("Este turno ya está cerrado"), { status: 409 });
    }

    const saldoActualResult = await client.query(
      `SELECT monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2`,
      [cierre.caja_id, cierre.moneda_id]
    );
    const saldoEsperado =
      saldoActualResult.rows.length > 0 ? new Decimal(saldoActualResult.rows[0].monto) : new Decimal(0);
    const saldoReal = new Decimal(input.saldoReal);
    const diferencia = saldoReal.minus(saldoEsperado);

    const result = await client.query(
      `UPDATE cierres_caja
       SET fecha_cierre = now(), saldo_esperado = $1, saldo_real = $2, diferencia = $3, estado = 'CERRADA'
       WHERE id = $4
       RETURNING *`,
      [saldoEsperado.toFixed(4), saldoReal.toFixed(4), diferencia.toFixed(4), input.cierreId]
    );

    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function obtenerCierreAbierto(cajaId: number, monedaId: number) {
  const result = await pool.query(
    `SELECT cc.*, c.nombre AS caja_nombre, m.codigo AS moneda_codigo
     FROM cierres_caja cc
     JOIN cajas c ON c.id = cc.caja_id
     JOIN monedas m ON m.id = cc.moneda_id
     WHERE cc.caja_id = $1 AND cc.moneda_id = $2 AND cc.estado = 'ABIERTA'`,
    [cajaId, monedaId]
  );
  return result.rows[0] ?? null;
}