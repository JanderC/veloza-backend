import { PoolClient } from "pg";
import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { exigirTurnoAbierto } from "./cierreCaja.service";

interface CrearCuentaPorPagarInput {
  terceroId: number;
  monedaId: number;
  montoOriginal: string;
}

export async function crearCuentaPorPagar(input: CrearCuentaPorPagarInput) {
  const monto = new Decimal(input.montoOriginal);
  if (!monto.isPositive()) {
    throw Object.assign(new Error("El monto original debe ser mayor a cero"), { status: 400 });
  }

  const result = await pool.query(
    `INSERT INTO cuentas_por_pagar (tercero_id, moneda_id, monto_original, saldo_pendiente, estado)
     VALUES ($1, $2, $3, $3, 'PENDIENTE')
     RETURNING *`,
    [input.terceroId, input.monedaId, monto.toFixed(4)]
  );
  return result.rows[0];
}

interface RegistrarAbonoPagarInput {
  cuentaPorPagarId: number;
  monto: string;
  cajaId: number;
  metodoPagoId?: number;
  usuarioId: number;
}

/**
 * Registra un pago a una cuenta por pagar de forma ATÓMICA. Simétrico
 * a registrarAbonoCobrar, pero el dinero SALE de caja (EGRESO), así que
 * además hay que validar que la caja tenga saldo suficiente.
 */
export async function registrarAbonoPagar(input: RegistrarAbonoPagarInput) {
  const client: PoolClient = await pool.connect();
  const monto = new Decimal(input.monto);

  try {
    if (!monto.isPositive()) {
      throw Object.assign(new Error("El monto del abono debe ser mayor a cero"), { status: 400 });
    }

    await client.query("BEGIN");

    const cuentaResult = await client.query(
      `SELECT * FROM cuentas_por_pagar WHERE id = $1 FOR UPDATE`,
      [input.cuentaPorPagarId]
    );
    const cuenta = cuentaResult.rows[0];
    if (!cuenta) {
      throw Object.assign(new Error("Cuenta por pagar no encontrada"), { status: 404 });
    }

    const saldoPendiente = new Decimal(cuenta.saldo_pendiente);
    if (monto.greaterThan(saldoPendiente)) {
      throw Object.assign(
        new Error(`El pago (${monto.toFixed(4)}) no puede superar el saldo pendiente (${saldoPendiente.toFixed(4)})`),
        { status: 409 }
      );
    }

    const nuevoSaldo = saldoPendiente.minus(monto);
    const nuevoEstado = nuevoSaldo.isZero() ? "PAGADA" : "ABONADA";

    await client.query(
      `UPDATE cuentas_por_pagar SET saldo_pendiente = $1, estado = $2 WHERE id = $3`,
      [nuevoSaldo.toFixed(4), nuevoEstado, cuenta.id]
    );

    const abonoResult = await client.query(
      `INSERT INTO abonos_cuenta (cuenta_por_pagar_id, monto) VALUES ($1, $2) RETURNING *`,
      [cuenta.id, monto.toFixed(4)]
    );

    await exigirTurnoAbierto(client, input.cajaId, cuenta.moneda_id);

    const saldoCajaResult = await client.query(
      `SELECT id, monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`,
      [input.cajaId, cuenta.moneda_id]
    );

    const cajaExiste = saldoCajaResult.rows.length > 0;
    if (!cajaExiste) {
      throw Object.assign(new Error("La caja no tiene saldo registrado en esa moneda"), { status: 409 });
    }

    const saldoCajaAnterior = new Decimal(saldoCajaResult.rows[0].monto);
    const saldoCajaId = saldoCajaResult.rows[0].id;
    const saldoCajaNuevo = saldoCajaAnterior.minus(monto);

    if (saldoCajaNuevo.isNegative()) {
      throw Object.assign(new Error("Saldo insuficiente en caja para realizar este pago"), { status: 409 });
    }

    await client.query(`UPDATE saldos_caja SET monto = $1 WHERE id = $2`, [saldoCajaNuevo.toFixed(4), saldoCajaId]);

    await client.query(
      `INSERT INTO movimientos_caja
        (caja_id, moneda_id, metodo_pago_id, tipo, monto, saldo_anterior, saldo_nuevo, usuario_id)
       VALUES ($1,$2,$3,'EGRESO',$4,$5,$6,$7)`,
      [
        input.cajaId,
        cuenta.moneda_id,
        input.metodoPagoId ?? null,
        monto.toFixed(4),
        saldoCajaAnterior.toFixed(4),
        saldoCajaNuevo.toFixed(4),
        input.usuarioId,
      ]
    );

    await client.query("COMMIT");
    return {
      abono: abonoResult.rows[0],
      cuenta: { ...cuenta, saldo_pendiente: nuevoSaldo.toFixed(4), estado: nuevoEstado },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}