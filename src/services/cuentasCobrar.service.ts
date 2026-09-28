import { PoolClient } from "pg";
import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { exigirTurnoAbierto } from "./cierreCaja.service";

interface CrearCuentaPorCobrarInput {
  terceroId: number;
  monedaId: number;
  montoOriginal: string;
}

export async function crearCuentaPorCobrar(input: CrearCuentaPorCobrarInput) {
  const monto = new Decimal(input.montoOriginal);
  if (!monto.isPositive()) {
    throw Object.assign(new Error("El monto original debe ser mayor a cero"), { status: 400 });
  }

  const result = await pool.query(
    `INSERT INTO cuentas_por_cobrar (tercero_id, moneda_id, monto_original, saldo_pendiente, estado)
     VALUES ($1, $2, $3, $3, 'PENDIENTE')
     RETURNING *`,
    [input.terceroId, input.monedaId, monto.toFixed(4)]
  );
  return result.rows[0];
}

interface RegistrarAbonoCobrarInput {
  cuentaPorCobrarId: number;
  monto: string;
  cajaId: number;
  metodoPagoId?: number;
  usuarioId: number;
}

/**
 * Registra un abono a una cuenta por cobrar de forma ATÓMICA:
 * 1) bloquea la cuenta (FOR UPDATE) y valida que el abono no exceda el saldo pendiente
 * 2) actualiza saldo_pendiente y estado de la cuenta
 * 3) inserta el abono
 * 4) bloquea el saldo de caja correspondiente y registra el INGRESO
 * Un cliente que paga lo que debe es dinero que ENTRA a caja.
 */
export async function registrarAbonoCobrar(input: RegistrarAbonoCobrarInput) {
  const client: PoolClient = await pool.connect();
  const monto = new Decimal(input.monto);

  try {
    if (!monto.isPositive()) {
      throw Object.assign(new Error("El monto del abono debe ser mayor a cero"), { status: 400 });
    }

    await client.query("BEGIN");

    const cuentaResult = await client.query(
      `SELECT * FROM cuentas_por_cobrar WHERE id = $1 FOR UPDATE`,
      [input.cuentaPorCobrarId]
    );
    const cuenta = cuentaResult.rows[0];
    if (!cuenta) {
      throw Object.assign(new Error("Cuenta por cobrar no encontrada"), { status: 404 });
    }

    const saldoPendiente = new Decimal(cuenta.saldo_pendiente);
    if (monto.greaterThan(saldoPendiente)) {
      throw Object.assign(
        new Error(`El abono (${monto.toFixed(4)}) no puede superar el saldo pendiente (${saldoPendiente.toFixed(4)})`),
        { status: 409 }
      );
    }

    const nuevoSaldo = saldoPendiente.minus(monto);
    const nuevoEstado = nuevoSaldo.isZero() ? "PAGADA" : "ABONADA";

    await client.query(
      `UPDATE cuentas_por_cobrar SET saldo_pendiente = $1, estado = $2 WHERE id = $3`,
      [nuevoSaldo.toFixed(4), nuevoEstado, cuenta.id]
    );

    const abonoResult = await client.query(
      `INSERT INTO abonos_cuenta (cuenta_por_cobrar_id, monto) VALUES ($1, $2) RETURNING *`,
      [cuenta.id, monto.toFixed(4)]
    );

    // El pago del cliente entra a la caja como INGRESO
    await exigirTurnoAbierto(client, input.cajaId, cuenta.moneda_id);

    const saldoCajaResult = await client.query(
      `SELECT id, monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`,
      [input.cajaId, cuenta.moneda_id]
    );

    let saldoCajaAnterior: Decimal;
    let saldoCajaId: number;

    if (saldoCajaResult.rows.length === 0) {
      saldoCajaAnterior = new Decimal(0);
      const insertSaldo = await client.query(
        `INSERT INTO saldos_caja (caja_id, moneda_id, monto) VALUES ($1, $2, 0) RETURNING id`,
        [input.cajaId, cuenta.moneda_id]
      );
      saldoCajaId = insertSaldo.rows[0].id;
    } else {
      saldoCajaAnterior = new Decimal(saldoCajaResult.rows[0].monto);
      saldoCajaId = saldoCajaResult.rows[0].id;
    }

    const saldoCajaNuevo = saldoCajaAnterior.plus(monto);

    await client.query(`UPDATE saldos_caja SET monto = $1 WHERE id = $2`, [saldoCajaNuevo.toFixed(4), saldoCajaId]);

    await client.query(
      `INSERT INTO movimientos_caja
        (caja_id, moneda_id, metodo_pago_id, tipo, monto, saldo_anterior, saldo_nuevo, usuario_id)
       VALUES ($1,$2,$3,'INGRESO',$4,$5,$6,$7)`,
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