import { PoolClient } from "pg";
import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { aplicarMovimientoLeg } from "./transaccionService";
import { abrirTurnoSiFalta } from "./cierreCaja.service";

type TipoCaja = "FISICA" | "FUERTE" | "BANCO";

function errorHttp(mensaje: string, status: number) {
  return Object.assign(new Error(mensaje), { status });
}

// ---------- Configuración ----------

/**
 * Cajas con sus saldos por moneda y las monedas con turno abierto, para el
 * tablero de configuración. La principal va primero.
 */
export async function listarCajas(opciones: { incluirInactivas: boolean }) {
  const result = await pool.query(
    `SELECT c.*,
       COALESCE((
         SELECT json_agg(json_build_object('moneda_id', s.moneda_id, 'moneda_codigo', m.codigo, 'monto', s.monto::text) ORDER BY m.codigo)
         FROM saldos_caja s JOIN monedas m ON m.id = s.moneda_id
         WHERE s.caja_id = c.id
       ), '[]') AS saldos,
       COALESCE((
         SELECT json_agg(json_build_object('cierre_id', cc.id, 'moneda_id', cc.moneda_id, 'moneda_codigo', m.codigo) ORDER BY m.codigo)
         FROM cierres_caja cc JOIN monedas m ON m.id = cc.moneda_id
         WHERE cc.caja_id = c.id AND cc.estado = 'ABIERTA'
       ), '[]') AS turnos_abiertos,
       (SELECT codigo FROM monedas WHERE id = c.moneda_id) AS moneda_codigo,
       COALESCE((
         SELECT json_agg(json_build_object('id', mp.id, 'nombre', mp.nombre) ORDER BY mp.nombre)
         FROM metodos_pago mp WHERE mp.cuenta_id = c.id AND mp.activo
       ), '[]') AS metodos_pago
     FROM cajas c
     ${opciones.incluirInactivas ? "" : "WHERE c.activo = true"}
     ORDER BY c.es_principal DESC, c.activo DESC, c.nombre`
  );
  return result.rows;
}

// Datos bancarios de una cuenta de la empresa (caja tipo BANCO). Todos opcionales:
// undefined = no tocar, null = borrar.
export interface DatosCuenta {
  banco?: string | null;
  numeroCuenta?: string | null;
  tipoCuenta?: "AHORRO" | "CORRIENTE" | "BILLETERA" | null;
  titular?: string | null;
  identificacionTitular?: string | null;
  telefono?: string | null;
  email?: string | null;
  pais?: string | null;
  monedaId?: number | null;
}

const COLUMNA_CUENTA: Record<keyof DatosCuenta, string> = {
  banco: "banco",
  numeroCuenta: "numero_cuenta",
  tipoCuenta: "tipo_cuenta",
  titular: "titular",
  identificacionTitular: "identificacion_titular",
  telefono: "telefono",
  email: "email",
  pais: "pais",
  monedaId: "moneda_id",
};

function limpiarValor(valor: string | number | null | undefined) {
  if (typeof valor === "string") return valor.trim() || null;
  return valor ?? null;
}

interface CrearCajaInput extends DatosCuenta {
  nombre: string;
  tipo: TipoCaja;
  descripcion?: string;
  esPrincipal?: boolean;
}

export async function crearCaja(input: CrearCajaInput) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.esPrincipal) await client.query(`UPDATE cajas SET es_principal = false WHERE es_principal`);
    const columnasCuenta = Object.keys(COLUMNA_CUENTA) as (keyof DatosCuenta)[];
    const result = await client.query(
      `INSERT INTO cajas (nombre, tipo, descripcion, es_principal, ${columnasCuenta.map((c) => COLUMNA_CUENTA[c]).join(", ")})
       VALUES ($1, $2, $3, $4, ${columnasCuenta.map((_, i) => `$${i + 5}`).join(", ")})
       RETURNING *`,
      [
        input.nombre.trim(),
        input.tipo,
        input.descripcion?.trim() || null,
        input.esPrincipal ?? false,
        ...columnasCuenta.map((c) => limpiarValor(input[c])),
      ]
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw traducirNombreDuplicado(err);
  } finally {
    client.release();
  }
}

interface ActualizarCajaInput extends DatosCuenta {
  nombre?: string;
  tipo?: TipoCaja;
  descripcion?: string | null;
  activo?: boolean;
}

/**
 * Edita una caja. Desactivar solo se permite si la caja quedó vacía (saldo 0
 * en todas las monedas), sin turnos abiertos y si no es la principal: así
 * nunca queda plata "escondida" en una caja que ya no aparece en pantalla.
 */
export async function actualizarCaja(id: number, input: ActualizarCajaInput) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cajaResult = await client.query(`SELECT * FROM cajas WHERE id = $1 FOR UPDATE`, [id]);
    const caja = cajaResult.rows[0];
    if (!caja) throw errorHttp("Caja no encontrada", 404);

    if (input.activo === false && caja.activo) {
      if (caja.es_principal) throw errorHttp("No se puede desactivar la caja principal. Marcá otra como principal primero.", 409);

      // Se juntan TODOS los motivos para que el admin los resuelva de una vez
      const turnos = await client.query(
        `SELECT m.codigo FROM cierres_caja cc JOIN monedas m ON m.id = cc.moneda_id
         WHERE cc.caja_id = $1 AND cc.estado = 'ABIERTA' ORDER BY m.codigo`,
        [id]
      );
      const saldos = await client.query(
        `SELECT m.codigo, s.monto FROM saldos_caja s JOIN monedas m ON m.id = s.moneda_id
         WHERE s.caja_id = $1 AND s.monto <> 0 ORDER BY m.codigo`,
        [id]
      );
      const motivos: string[] = [];
      if (turnos.rows.length > 0) {
        motivos.push(`tiene turnos abiertos en ${turnos.rows.map((r) => r.codigo).join(", ")} (cerralos en Cierre de Caja)`);
      }
      if (saldos.rows.length > 0) {
        const detalle = saldos.rows.map((r) => `${r.codigo} ${new Decimal(r.monto).toString()}`).join(", ");
        motivos.push(`todavía tiene saldo: ${detalle} (transferilo a otra caja)`);
      }
      const metodos = await metodosVinculados(client, id);
      if (metodos.length > 0) {
        motivos.push(`tiene métodos de pago vinculados: ${metodos.join(", ")} (desvinculalos en Cuentas y Métodos de Pago)`);
      }
      if (motivos.length > 0) throw errorHttp(`No se puede desactivar "${caja.nombre}": ${motivos.join("; y ")}.`, 409);
    }

    // Los métodos de pago solo se vinculan a cuentas (tipo BANCO)
    if (input.tipo !== undefined && input.tipo !== "BANCO" && caja.tipo === "BANCO") {
      const metodos = await metodosVinculados(client, id);
      if (metodos.length > 0) {
        throw errorHttp(`"${caja.nombre}" tiene métodos de pago vinculados (${metodos.join(", ")}): desvinculalos antes de cambiarle el tipo.`, 409);
      }
    }

    // Solo se actualizan los campos que vinieron; null borra el valor
    const cambios: Record<string, unknown> = {};
    if (input.nombre !== undefined) cambios.nombre = input.nombre.trim();
    if (input.tipo !== undefined) cambios.tipo = input.tipo;
    if (input.descripcion !== undefined) cambios.descripcion = limpiarValor(input.descripcion);
    if (input.activo !== undefined) cambios.activo = input.activo;
    for (const campo of Object.keys(COLUMNA_CUENTA) as (keyof DatosCuenta)[]) {
      if (input[campo] !== undefined) cambios[COLUMNA_CUENTA[campo]] = limpiarValor(input[campo]);
    }

    const columnas = Object.keys(cambios);
    const result =
      columnas.length === 0
        ? cajaResult
        : await client.query(
            `UPDATE cajas SET ${columnas.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING *`,
            [id, ...columnas.map((c) => cambios[c])]
          );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw traducirNombreDuplicado(err);
  } finally {
    client.release();
  }
}

export async function marcarPrincipal(id: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cajaResult = await client.query(`SELECT * FROM cajas WHERE id = $1 FOR UPDATE`, [id]);
    const caja = cajaResult.rows[0];
    if (!caja) throw errorHttp("Caja no encontrada", 404);
    if (!caja.activo) throw errorHttp("Una caja inactiva no puede ser la principal", 409);

    await client.query(`UPDATE cajas SET es_principal = false WHERE es_principal AND id <> $1`, [id]);
    const result = await client.query(`UPDATE cajas SET es_principal = true WHERE id = $1 RETURNING *`, [id]);
    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function metodosVinculados(client: PoolClient, cajaId: number): Promise<string[]> {
  const result = await client.query(`SELECT nombre FROM metodos_pago WHERE cuenta_id = $1 AND activo ORDER BY nombre`, [cajaId]);
  return result.rows.map((r) => r.nombre);
}

function traducirNombreDuplicado(err: unknown) {
  if (typeof err === "object" && err !== null && "code" in err && err.code === "23505") {
    return errorHttp("Ya existe una caja con ese nombre", 409);
  }
  return err;
}

async function obtenerCajaActiva(client: PoolClient, id: number) {
  const result = await client.query(`SELECT * FROM cajas WHERE id = $1`, [id]);
  const caja = result.rows[0];
  if (!caja) throw errorHttp("Caja no encontrada", 404);
  if (!caja.activo) throw errorHttp(`La caja "${caja.nombre}" está inactiva`, 409);
  return caja;
}

/**
 * Chequeo previo con mensaje claro ("Caja 1 no tiene turno abierto en USD").
 * El bloqueo real lo sigue haciendo exigirTurnoAbierto dentro de cada pata.
 */
async function exigirTurnoConNombre(client: PoolClient, caja: { id: number; nombre: string }, monedaId: number, sugerencia: string) {
  const result = await client.query(
    `SELECT m.codigo, cc.id AS cierre_id
     FROM monedas m LEFT JOIN cierres_caja cc ON cc.moneda_id = m.id AND cc.caja_id = $1 AND cc.estado = 'ABIERTA'
     WHERE m.id = $2`,
    [caja.id, monedaId]
  );
  const fila = result.rows[0];
  if (!fila) throw errorHttp("Moneda no encontrada", 404);
  if (fila.cierre_id === null) {
    throw errorHttp(`"${caja.nombre}" no tiene turno abierto en ${fila.codigo}. ${sugerencia}`, 409);
  }
}

// ---------- Fondeo: plata que entra al negocio (normalmente a la caja principal) ----------

interface FondearCajaInput {
  cajaId?: number; // si no viene, se usa la principal
  monedaId: number;
  monto: string;
  observacion?: string;
  abrirTurno: boolean;
  usuarioId: number;
}

export async function fondearCaja(input: FondearCajaInput) {
  const monto = new Decimal(input.monto);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let cajaId = input.cajaId;
    if (cajaId === undefined) {
      const principal = await client.query(`SELECT id FROM cajas WHERE es_principal AND activo`);
      if (principal.rows.length === 0) throw errorHttp("No hay una caja principal configurada", 409);
      cajaId = principal.rows[0].id as number;
    }
    const caja = await obtenerCajaActiva(client, cajaId);

    if (input.abrirTurno) {
      await abrirTurnoSiFalta(client, cajaId, input.monedaId, input.usuarioId);
    } else {
      await exigirTurnoConNombre(client, caja, input.monedaId, "Abrilo en Cierre de Caja o marcá la opción de abrirlo al alimentar.");
    }

    const txResult = await client.query(
      `INSERT INTO transacciones
        (tipo, estado, caja_id, moneda_origen_id, monto_origen, usuario_id, confirmada_en, confirmado_por_id, observacion)
       VALUES ('FONDEO', 'CONFIRMADA', $1, $2, $3, $4, now(), $4, $5)
       RETURNING *`,
      [cajaId, input.monedaId, monto.toFixed(4), input.usuarioId, input.observacion?.trim() || null]
    );
    const transaccion = txResult.rows[0];

    const saldoNuevo = await aplicarMovimientoLeg(client, {
      cajaId,
      monedaId: input.monedaId,
      tipo: "INGRESO",
      monto,
      transaccionId: transaccion.id,
      usuarioId: input.usuarioId,
    });

    await client.query("COMMIT");
    return { transaccion, saldoNuevo: saldoNuevo.toFixed(4) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------- Transferencia entre cajas (misma moneda, dos patas) ----------

interface TransferirInput {
  cajaOrigenId: number;
  cajaDestinoId: number;
  monedaId: number;
  monto: string;
  observacion?: string;
  abrirTurnoDestino: boolean;
  usuarioId: number;
}

/**
 * Mueve plata de una caja a otra en UNA transacción de BD: EGRESO en el
 * origen + INGRESO en el destino. El origen necesita turno abierto (es quien
 * entrega la plata); el destino se puede abrir en el mismo paso, que es el
 * caso típico de repartir la base del día desde la caja principal.
 */
export async function transferirEntreCajas(input: TransferirInput) {
  if (input.cajaOrigenId === input.cajaDestinoId) throw errorHttp("La caja de origen y destino deben ser distintas", 400);

  const monto = new Decimal(input.monto);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const origen = await obtenerCajaActiva(client, input.cajaOrigenId);
    const destino = await obtenerCajaActiva(client, input.cajaDestinoId);

    await exigirTurnoConNombre(client, origen, input.monedaId, "Abrilo en Cierre de Caja o alimentala primero.");
    if (input.abrirTurnoDestino) {
      await abrirTurnoSiFalta(client, input.cajaDestinoId, input.monedaId, input.usuarioId);
    } else {
      await exigirTurnoConNombre(client, destino, input.monedaId, "Abrilo en Cierre de Caja o marcá la opción de abrirlo al transferir.");
    }

    // Bloqueo en orden fijo: dos transferencias cruzadas (A→B y B→A) no se traban entre sí
    await client.query(
      `SELECT id FROM saldos_caja WHERE moneda_id = $1 AND caja_id = ANY($2::int[]) ORDER BY caja_id FOR UPDATE`,
      [input.monedaId, [input.cajaOrigenId, input.cajaDestinoId]]
    );

    const txResult = await client.query(
      `INSERT INTO transacciones
        (tipo, estado, caja_id, caja_destino_id, moneda_origen_id, monto_origen, moneda_destino_id, monto_destino,
         usuario_id, confirmada_en, confirmado_por_id, observacion)
       VALUES ('TRANSFERENCIA_INTERNA', 'CONFIRMADA', $1, $2, $3, $4, $3, $4, $5, now(), $5, $6)
       RETURNING *`,
      [
        input.cajaOrigenId,
        input.cajaDestinoId,
        input.monedaId,
        monto.toFixed(4),
        input.usuarioId,
        input.observacion?.trim() || null,
      ]
    );
    const transaccion = txResult.rows[0];

    const saldoOrigen = await aplicarMovimientoLeg(client, {
      cajaId: input.cajaOrigenId,
      monedaId: input.monedaId,
      tipo: "EGRESO",
      monto,
      transaccionId: transaccion.id,
      usuarioId: input.usuarioId,
    });
    const saldoDestino = await aplicarMovimientoLeg(client, {
      cajaId: input.cajaDestinoId,
      monedaId: input.monedaId,
      tipo: "INGRESO",
      monto,
      transaccionId: transaccion.id,
      usuarioId: input.usuarioId,
    });

    await client.query("COMMIT");
    return { transaccion, saldoOrigen: saldoOrigen.toFixed(4), saldoDestino: saldoDestino.toFixed(4) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------- Historial de fondeos y transferencias ----------

export async function listarMovimientosInternos(filtros: { cajaId?: number; limite: number }) {
  const valores: unknown[] = [];
  let filtroCaja = "";
  if (filtros.cajaId !== undefined) {
    valores.push(filtros.cajaId);
    filtroCaja = `AND (t.caja_id = $1 OR t.caja_destino_id = $1)`;
  }
  valores.push(filtros.limite);

  const result = await pool.query(
    `SELECT t.id, t.tipo, t.caja_id, c.nombre AS caja_nombre, t.caja_destino_id, cd.nombre AS caja_destino_nombre,
            t.moneda_origen_id AS moneda_id, m.codigo AS moneda_codigo, t.monto_origen AS monto,
            t.observacion, t.created_at, u.nombre AS usuario_nombre
     FROM transacciones t
     JOIN cajas c ON c.id = t.caja_id
     LEFT JOIN cajas cd ON cd.id = t.caja_destino_id
     JOIN monedas m ON m.id = t.moneda_origen_id
     JOIN usuarios u ON u.id = t.usuario_id
     WHERE t.tipo IN ('FONDEO', 'TRANSFERENCIA_INTERNA') ${filtroCaja}
     ORDER BY t.created_at DESC
     LIMIT $${valores.length}`,
    valores
  );
  return result.rows;
}

// ---------- Estado de cuenta de UNA caja: saldos, movimientos y cuadre por moneda ----------

interface FiltrosEstadoCaja {
  monedaId?: number;
  desde?: string; // "AAAA-MM-DD", día de Colombia
  hasta?: string; // "AAAA-MM-DD", inclusive
  tipo?: "INGRESO" | "EGRESO";
  limite: number;
}

// Las fechas del filtro son días calendario de Colombia, no UTC
const DIA_BOGOTA = `(mc.created_at AT TIME ZONE 'America/Bogota')::date`;

export async function obtenerEstadoCaja(cajaId: number, filtros: FiltrosEstadoCaja) {
  const cajaResult = await pool.query(
    `SELECT c.*, (SELECT codigo FROM monedas WHERE id = c.moneda_id) AS moneda_codigo FROM cajas c WHERE c.id = $1`,
    [cajaId]
  );
  const caja = cajaResult.rows[0];
  if (!caja) throw errorHttp("Caja no encontrada", 404);

  // Monedas que la caja tiene o tuvo (saldo o algún movimiento), con saldo actual y turno
  const monedasResult = await pool.query(
    `SELECT m.id AS moneda_id, m.codigo AS moneda_codigo, m.decimales,
            COALESCE(s.monto, 0) AS saldo_actual,
            cc.id AS cierre_abierto_id, cc.fecha_apertura AS turno_abierto_desde
     FROM monedas m
     LEFT JOIN saldos_caja s ON s.caja_id = $1 AND s.moneda_id = m.id
     LEFT JOIN cierres_caja cc ON cc.caja_id = $1 AND cc.moneda_id = m.id AND cc.estado = 'ABIERTA'
     WHERE s.id IS NOT NULL OR EXISTS (SELECT 1 FROM movimientos_caja mc WHERE mc.caja_id = $1 AND mc.moneda_id = m.id)
     ORDER BY m.codigo`,
    [cajaId]
  );

  // Condiciones del período (sirven para el resumen y para la lista)
  const condPeriodo: string[] = [];
  const valoresPeriodo: unknown[] = [cajaId];
  if (filtros.desde) {
    valoresPeriodo.push(filtros.desde);
    condPeriodo.push(`${DIA_BOGOTA} >= $${valoresPeriodo.length}::date`);
  }
  if (filtros.hasta) {
    valoresPeriodo.push(filtros.hasta);
    condPeriodo.push(`${DIA_BOGOTA} <= $${valoresPeriodo.length}::date`);
  }
  const wherePeriodo = condPeriodo.length > 0 ? `AND ${condPeriodo.join(" AND ")}` : "";

  // ---- Resumen por moneda: saldo al inicio del período, ingresos, egresos y saldo final ----
  const resumenResult = await pool.query(
    `SELECT mc.moneda_id,
            count(*)::int AS movimientos,
            COALESCE(SUM(mc.monto) FILTER (WHERE mc.tipo = 'INGRESO'), 0) AS ingresos,
            COALESCE(SUM(mc.monto) FILTER (WHERE mc.tipo = 'EGRESO'), 0) AS egresos,
            (array_agg(mc.saldo_anterior ORDER BY mc.id ASC))[1] AS saldo_inicial,
            (array_agg(mc.saldo_nuevo ORDER BY mc.id DESC))[1] AS saldo_final
     FROM movimientos_caja mc
     WHERE mc.caja_id = $1 ${wherePeriodo}
     GROUP BY mc.moneda_id`,
    valoresPeriodo
  );
  const resumenPorMoneda = new Map(resumenResult.rows.map((r) => [r.moneda_id as number, r]));

  // Sin movimientos en el período: el saldo es el último conocido hasta que termina
  const saldoHastaFinDelPeriodo = async (monedaId: number) => {
    const vals: unknown[] = [cajaId, monedaId];
    let cond = "";
    if (filtros.hasta) {
      vals.push(filtros.hasta);
      cond = `AND ${DIA_BOGOTA} <= $${vals.length}::date`;
    }
    const r = await pool.query(
      `SELECT saldo_nuevo FROM movimientos_caja mc WHERE mc.caja_id = $1 AND mc.moneda_id = $2 ${cond} ORDER BY mc.id DESC LIMIT 1`,
      vals
    );
    return (r.rows[0]?.saldo_nuevo as string | undefined) ?? "0";
  };

  const monedas = [];
  for (const m of monedasResult.rows) {
    const r = resumenPorMoneda.get(m.moneda_id);
    const saldoInicial: string = r ? r.saldo_inicial : await saldoHastaFinDelPeriodo(m.moneda_id);
    const saldoFinal: string = r ? r.saldo_final : saldoInicial;
    const ingresos: string = r?.ingresos ?? "0";
    const egresos: string = r?.egresos ?? "0";
    monedas.push({
      monedaId: m.moneda_id,
      monedaCodigo: m.moneda_codigo,
      decimales: Number(m.decimales),
      saldoActual: new Decimal(m.saldo_actual).toFixed(4),
      turnoAbierto: m.cierre_abierto_id != null,
      turnoAbiertoDesde: m.turno_abierto_desde,
      periodo: {
        movimientos: r?.movimientos ?? 0,
        saldoInicial: new Decimal(saldoInicial).toFixed(4),
        ingresos: new Decimal(ingresos).toFixed(4),
        egresos: new Decimal(egresos).toFixed(4),
        saldoFinal: new Decimal(saldoFinal).toFixed(4),
        // inicial + ingresos - egresos tiene que dar el final: si no, hay un descuadre
        cuadra: new Decimal(saldoInicial).plus(ingresos).minus(egresos).eq(saldoFinal),
      },
    });
  }

  // ---- Movimientos con su concepto ----
  const valoresLista = [...valoresPeriodo];
  let filtrosLista = wherePeriodo;
  if (filtros.monedaId) {
    valoresLista.push(filtros.monedaId);
    filtrosLista += ` AND mc.moneda_id = $${valoresLista.length}`;
  }
  if (filtros.tipo) {
    valoresLista.push(filtros.tipo);
    filtrosLista += ` AND mc.tipo = $${valoresLista.length}`;
  }
  valoresLista.push(filtros.limite + 1);

  const movsResult = await pool.query(
    `SELECT mc.id, mc.tipo, mc.monto, mc.saldo_anterior, mc.saldo_nuevo, mc.created_at, mc.moneda_id,
            m.codigo AS moneda_codigo, u.nombre AS usuario_nombre, mp.nombre AS metodo_pago_nombre,
            t.id AS transaccion_id, t.tipo AS transaccion_tipo, t.observacion,
            ter.nombre AS tercero_nombre, r.codigo AS referencia_codigo,
            -- la otra caja de la operación (transferencia o cambio)
            CASE WHEN t.caja_id = mc.caja_id THEN cd.nombre ELSE co.nombre END AS contraparte_nombre
     FROM movimientos_caja mc
     JOIN monedas m ON m.id = mc.moneda_id
     JOIN usuarios u ON u.id = mc.usuario_id
     LEFT JOIN metodos_pago mp ON mp.id = mc.metodo_pago_id
     LEFT JOIN transacciones t ON t.id = mc.transaccion_id
     LEFT JOIN terceros ter ON ter.id = t.tercero_id
     LEFT JOIN referencias r ON r.id = t.referencia_id
     LEFT JOIN cajas co ON co.id = t.caja_id
     LEFT JOIN cajas cd ON cd.id = t.caja_destino_id
     WHERE mc.caja_id = $1 ${filtrosLista}
     ORDER BY mc.id DESC
     LIMIT $${valoresLista.length}`,
    valoresLista
  );

  return {
    caja,
    monedas,
    movimientos: movsResult.rows.slice(0, filtros.limite),
    hayMas: movsResult.rows.length > filtros.limite,
  };
}
