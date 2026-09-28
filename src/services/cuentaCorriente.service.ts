import { PoolClient } from "pg";
import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { exigirTurnoAbierto } from "./cierreCaja.service";

interface RegistrarMovimientoCCInput {
  terceroId: number;
  canalId: number;
  monedaId: number; // moneda del saldo de la cuenta corriente (COP o USD, según la fase del Excel)
  tipo: "COMPRA" | "VENTA" | "ABONO" | "CARGO" | "AJUSTE";
  monto: string; // CON SIGNO: + aumenta el saldo, - lo reduce (igual que el Excel)
  descripcion?: string;
  cantidadBase?: string;
  monedaBaseId?: number;
  tasa?: string;
  transaccionId?: number;
  usuarioId: number;
  fecha?: string;
  categoriaId?: number;
  // --- Opcional: si este movimiento TAMBIÉN es un ingreso/egreso real de
  // efectivo (la columna "TOTAL DE PESOS" del Excel), se registra en la
  // misma transacción SQL, todo o nada.
  cajaId?: number;
  montoCaja?: string; // con signo, en la moneda de la caja (normalmente COP)
  monedaCajaId?: number; // moneda de la caja; si no se manda, se usa monedaId
  metodoPagoId?: number;
}

/**
 * Registra un movimiento de cuenta corriente y, si corresponde, el
 * movimiento de caja asociado -- de forma ATÓMICA. Si algo falla en
 * cualquiera de los dos, no queda ninguno aplicado.
 */
export async function registrarMovimientoCuentaCorriente(input: RegistrarMovimientoCCInput) {
  const client: PoolClient = await pool.connect();
  const monto = new Decimal(input.monto);

  try {
    await client.query("BEGIN");

    // ---------- 1) Cuenta corriente (get-or-create + lock) ----------
    let cuentaResult = await client.query(
      `SELECT * FROM cuentas_corrientes
       WHERE tercero_id = $1 AND canal_id = $2 AND moneda_id = $3
       FOR UPDATE`,
      [input.terceroId, input.canalId, input.monedaId]
    );

    let cuenta;
    if (cuentaResult.rows.length === 0) {
      const insert = await client.query(
        `INSERT INTO cuentas_corrientes (tercero_id, canal_id, moneda_id, saldo_actual)
         VALUES ($1, $2, $3, 0) RETURNING *`,
        [input.terceroId, input.canalId, input.monedaId]
      );
      cuenta = insert.rows[0];
    } else {
      cuenta = cuentaResult.rows[0];
    }

    const saldoAnterior = new Decimal(cuenta.saldo_actual);
    const saldoNuevo = saldoAnterior.plus(monto);

    await client.query(`UPDATE cuentas_corrientes SET saldo_actual = $1 WHERE id = $2`, [
      saldoNuevo.toFixed(4),
      cuenta.id,
    ]);

        const movResult = await client.query(
      `INSERT INTO movimientos_cuenta_corriente
        (cuenta_corriente_id, fecha, descripcion, tipo, cantidad_base, moneda_base_id, tasa, monto, saldo_anterior, saldo_nuevo, transaccion_id, usuario_id, categoria_id)
       VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        cuenta.id, input.fecha ?? null, input.descripcion ?? null, input.tipo,
        input.cantidadBase ?? null, input.monedaBaseId ?? null, input.tasa ?? null,
        monto.toFixed(4), saldoAnterior.toFixed(4), saldoNuevo.toFixed(4),
        input.transaccionId ?? null, input.usuarioId, input.categoriaId ?? null,
      ]
    );

    // ---------- 2) Caja física, SOLO si este movimiento también mueve efectivo ----------
    let movimientoCaja = null;
    if (input.cajaId) {
      const montoCaja = new Decimal(input.montoCaja ?? input.monto);
      const monedaCajaId = input.monedaCajaId ?? input.monedaId;
      const tipoMovimiento = montoCaja.isPositive() ? "INGRESO" : "EGRESO";
      const montoAbsoluto = montoCaja.abs();

      await exigirTurnoAbierto(client, input.cajaId, monedaCajaId);

      const saldoCajaResult = await client.query(
        `SELECT id, monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`,
        [input.cajaId, monedaCajaId]
      );

      let saldoCajaAnterior: Decimal;
      let saldoCajaId: number;

      if (saldoCajaResult.rows.length === 0) {
        saldoCajaAnterior = new Decimal(0);
        const insertSaldo = await client.query(
          `INSERT INTO saldos_caja (caja_id, moneda_id, monto) VALUES ($1, $2, 0) RETURNING id`,
          [input.cajaId, monedaCajaId]
        );
        saldoCajaId = insertSaldo.rows[0].id;
      } else {
        saldoCajaAnterior = new Decimal(saldoCajaResult.rows[0].monto);
        saldoCajaId = saldoCajaResult.rows[0].id;
      }

      const saldoCajaNuevo =
        tipoMovimiento === "INGRESO" ? saldoCajaAnterior.plus(montoAbsoluto) : saldoCajaAnterior.minus(montoAbsoluto);

      if (saldoCajaNuevo.isNegative()) {
        throw Object.assign(new Error("Saldo insuficiente en caja para este movimiento"), { status: 409 });
      }

      await client.query(`UPDATE saldos_caja SET monto = $1 WHERE id = $2`, [saldoCajaNuevo.toFixed(4), saldoCajaId]);

      const movCajaResult = await client.query(
        `INSERT INTO movimientos_caja
          (caja_id, moneda_id, metodo_pago_id, tipo, monto, saldo_anterior, saldo_nuevo, usuario_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          input.cajaId,
          monedaCajaId,
          input.metodoPagoId ?? null,
          tipoMovimiento,
          montoAbsoluto.toFixed(4),
          saldoCajaAnterior.toFixed(4),
          saldoCajaNuevo.toFixed(4),
          input.usuarioId,
        ]
      );
      movimientoCaja = movCajaResult.rows[0];
    }

    await client.query("COMMIT");
    return { movimiento: movResult.rows[0], saldoNuevo: saldoNuevo.toFixed(4), movimientoCaja };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function cambiarEstadoCuentaCorriente(id: number, estado: "DISPONIBLE" | "BLOQUEADA" | "CERRADA") {
  const result = await pool.query(`UPDATE cuentas_corrientes SET estado = $1 WHERE id = $2 RETURNING *`, [
    estado,
    id,
  ]);
  if (result.rows.length === 0) {
    throw Object.assign(new Error("Cuenta corriente no encontrada"), { status: 404 });
  }
  return result.rows[0];
} 