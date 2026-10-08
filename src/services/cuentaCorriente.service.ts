import { PoolClient } from "pg";
import Decimal from "decimal.js";
import * as XLSX from "xlsx";
import { pool } from "../db/pool";
import { abrirTurnoSiFalta } from "./cierreCaja.service";
import { enviarMensaje } from "./whatsapp/envio";
import { asegurarChat } from "./whatsapp/mensajes";
import { claveDeChat, jidDeTelefono, type Linea } from "./whatsapp/transporte";
import { generarUrlTemporal, subirArchivo } from "./almacenamiento.service";

interface RegistrarMovimientoCCInput {
  terceroId: number;
  canalId: number;
  monedaId: number; // moneda del saldo de la cuenta corriente (COP o USD, según la fase del Excel)
  tipo: "COMPRA" | "VENTA" | "ABONO" | "CARGO" | "AJUSTE";
  // CON SIGNO: + aumenta el saldo, - lo reduce (igual que el Excel).
  // Si no se manda, se calcula como cantidadBase x tasa (la columna MONTO del Excel).
  monto?: string;
  descripcion?: string;
  cantidadBase?: string;
  monedaBaseId?: number;
  tasa?: string;
  // true si la tasa es una comisión en % (viaja como fracción: 3% = "0.03")
  tasaEsPorcentaje?: boolean;
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
  reversoDeId?: number;
  cuentaDestino?: string; // a qué cuenta del cliente se le pagó (opcional)
  // Comisión descontada del monto: la tasa viaja como factor (4% -> "0.96") y cantidad × factor = lo que queda
  comisionDescontada?: boolean;
  comisionIncluida?: boolean; // el % ya venía sumado en lo enviado: la tasa es 1 / (1 + %)
  // Confirmaciones: el medio de ESTE movimiento. El cliente se registra una sola vez y cada movimiento lleva su medio
  // (hoy Nequi, mañana Bancolombia). Sin él, vale el medio de la cuenta.
  canalMovimientoId?: number;
  // Confirmación de la transferencia: entra ya confirmada, o pendiente hasta que se verifique (ej. Western Union)
  estadoConfirmacion?: "EN_PROCESO" | "CONFIRMADA";
}

function errorHttp(mensaje: string, status: number) {
  return Object.assign(new Error(mensaje), { status });
}

function aDecimal(valor: string, campo: string) {
  try {
    const d = new Decimal(valor);
    if (!d.isFinite()) throw new Error();
    return d;
  } catch {
    throw errorHttp(`${campo} no es un número válido`, 400);
  }
}

/**
 * Registra un movimiento de cuenta corriente y, si corresponde, el
 * movimiento de caja asociado -- de forma ATÓMICA. Si algo falla en
 * cualquiera de los dos, no queda ninguno aplicado.
 */
export async function registrarMovimientoCuentaCorriente(input: RegistrarMovimientoCCInput) {
  const cantidad = input.cantidadBase !== undefined ? aDecimal(input.cantidadBase, "La cantidad") : null;
  const tasa = input.tasa !== undefined ? aDecimal(input.tasa, "La tasa") : null;
  if (tasa && tasa.lte(0)) throw errorHttp("La tasa debe ser mayor a cero", 400);
  if (input.monto === undefined && !(cantidad && tasa)) {
    throw errorHttp("Indicá el monto, o la cantidad y la tasa para calcularlo", 400);
  }

  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    // MONTO = CANTIDAD x TASA, redondeado a los decimales de la moneda de la cuenta
    const monedaResult = await client.query(`SELECT decimales FROM monedas WHERE id = $1`, [input.monedaId]);
    if (!monedaResult.rows[0]) throw errorHttp("Moneda no encontrada", 404);
    const decimales = Number(monedaResult.rows[0].decimales);
    const calculado = cantidad && tasa ? cantidad.times(tasa).toDecimalPlaces(decimales, Decimal.ROUND_HALF_UP) : null;
    const monto = input.monto !== undefined ? aDecimal(input.monto, "El monto") : calculado!;
    if (input.monto !== undefined && calculado && !monto.eq(calculado)) {
      throw errorHttp(`El monto (${monto.toString()}) no coincide con cantidad x tasa (${calculado.toString()})`, 400);
    }
    if (monto.isZero()) throw errorHttp("El monto no puede ser cero", 400);

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
    if (cuenta.estado !== "DISPONIBLE") {
      throw errorHttp(`La cuenta está ${String(cuenta.estado).toLowerCase()}: no admite movimientos`, 409);
    }

    const saldoAnterior = new Decimal(cuenta.saldo_actual);
    const saldoNuevo = saldoAnterior.plus(monto);

    await client.query(`UPDATE cuentas_corrientes SET saldo_actual = $1 WHERE id = $2`, [
      saldoNuevo.toFixed(4),
      cuenta.id,
    ]);

        const movResult = await client.query(
      `INSERT INTO movimientos_cuenta_corriente
        (cuenta_corriente_id, fecha, descripcion, tipo, cantidad_base, moneda_base_id, tasa, monto, saldo_anterior, saldo_nuevo, transaccion_id, usuario_id, categoria_id, reverso_de_id, anulado, tasa_es_porcentaje, cuenta_destino, comision_descontada, estado_confirmacion, comision_incluida, canal_id)
       VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::int, $14::int IS NOT NULL, $15, $16, $17, $18, $19, $20)
       RETURNING *`,
      [
        cuenta.id, input.fecha ?? null, input.descripcion ?? null, input.tipo,
        input.cantidadBase ?? null, input.monedaBaseId ?? null, input.tasa ?? null,
        monto.toFixed(4), saldoAnterior.toFixed(4), saldoNuevo.toFixed(4),
        input.transaccionId ?? null, input.usuarioId, input.categoriaId ?? null, input.reversoDeId ?? null,
        !!((input.tasaEsPorcentaje || input.comisionDescontada) && tasa),
        input.cuentaDestino?.trim() || null,
        !!(input.comisionDescontada && tasa),
        input.reversoDeId ? null : (input.estadoConfirmacion ?? null),
        !!(input.comisionDescontada && input.comisionIncluida && tasa),
        input.canalMovimientoId ?? null,
      ]
    );

    // La fórmula del cliente se guarda con su primer movimiento: por tasa o con comisión descontada
    if (cuenta.formula == null && tasa && !input.reversoDeId) {
      if (input.comisionDescontada) {
        await client.query(`UPDATE cuentas_corrientes SET formula = 'COMISION', comision_pct = $1 WHERE id = $2`, [
          // el % del cliente: descontado es 1 - factor; ya sumado en lo enviado es 1/factor - 1
          (input.comisionIncluida ? new Decimal(1).div(tasa).minus(1) : new Decimal(1).minus(tasa)).times(100).toFixed(4),
          cuenta.id,
        ]);
      } else if (!input.tasaEsPorcentaje) {
        await client.query(`UPDATE cuentas_corrientes SET formula = 'TASA', tasa_habitual = COALESCE(tasa_habitual, $1) WHERE id = $2`, [tasa.toFixed(8), cuenta.id]);
      }
    }

    // ---------- 2) Caja física, SOLO si este movimiento también mueve efectivo ----------
    let movimientoCaja = null;
    if (input.cajaId) {
      const montoCaja = input.montoCaja !== undefined ? aDecimal(input.montoCaja, "El monto de caja") : monto;
      const monedaCajaId = input.monedaCajaId ?? input.monedaId;
      const tipoMovimiento = montoCaja.isPositive() ? "INGRESO" : "EGRESO";
      const montoAbsoluto = montoCaja.abs();

      // Como en los fondeos: si la caja no tiene turno abierto en esa moneda, se abre con este movimiento
      await abrirTurnoSiFalta(client, input.cajaId, monedaCajaId, input.usuarioId);

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
      await client.query(`UPDATE movimientos_cuenta_corriente SET movimiento_caja_id = $1 WHERE id = $2`, [
        movimientoCaja.id,
        movResult.rows[0].id,
      ]);
    }
    if (input.reversoDeId) {
      await client.query(`UPDATE movimientos_cuenta_corriente SET anulado = true WHERE id = $1`, [input.reversoDeId]);
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

// ---------- Abrir una cuenta (proveedor o cliente + canal de pago + moneda) ----------
const ZONA = "America/Bogota";

interface CrearCuentaInput {
  terceroId?: number;
  nuevoTercero?: { nombre: string; tipo: "CLIENTE" | "PROVEEDOR" | "MIXTO" | "AMIGO"; identificacion?: string; telefono?: string };
  canalId?: number; // opcional: sin banco, la cuenta queda en el canal SIN_BANCO
  // Si se le cobra en otra moneda que la de la contabilidad (ej. cuenta en USD, se cobra en COP): cuál y a qué tasa manual
  monedaCobroId?: number;
  tasaCobro?: string;
  modulo?: ModuloCuenta; // dónde se lleva: Cuentas Corrientes (por defecto), Cuentas por Cobrar o Cajas y Confirmaciones
  referencia?: string; // dato libre del cliente (Cajas y Confirmaciones)
  grupoCobro?: string; // Cuentas por Cobrar: en qué grupo va ("Cerveloza", "Zelle", "Préstamos"...)
  // Confirmaciones: si ya hay un cliente con ese nombre, se usa ese (y su cuenta con ese medio y moneda, o se le abre una)
  // en vez de rechazarlo. La pantalla lo manda después de preguntar "ya existe, ¿es el mismo?".
  usarExistente?: boolean;
  monedaId: number;
  // con signo, como el "Saldo pendiente" con el que arranca la hoja del Excel: + me debe, - yo le debo
  saldoInicial?: string;
  usuarioId: number;
}

export const CANAL_SIN_BANCO = "SIN_BANCO";
export type ModuloCuenta = "CORRIENTE" | "POR_COBRAR" | "CAJA";

/** Cobrar en la misma moneda de la contabilidad no necesita tasa; en otra, la tasa manual es obligatoria. */
function validarCobro(monedaId: number, monedaCobroId: number | null, tasaCobro?: string) {
  if (!monedaCobroId || monedaCobroId === monedaId) return { monedaCobroId: null, tasaCobro: null };
  const tasa = tasaCobro !== undefined ? aDecimal(tasaCobro, "La tasa de cobro") : null;
  if (!tasa || tasa.lte(0)) throw errorHttp("Para cobrar en otra moneda hace falta la tasa", 400);
  return { monedaCobroId, tasaCobro: tasa.toFixed(8) };
}

/** Cambiar en qué moneda se le cobra a la cuenta y a qué tasa. No toca el saldo: la contabilidad sigue en su moneda. */
export async function configurarCobroCuenta(id: number, datos: { monedaCobroId: number | null; tasaCobro?: string }) {
  const cuenta = await obtenerCuentaCorriente(id);
  const cobro = validarCobro(cuenta.moneda_id, datos.monedaCobroId, datos.tasaCobro);
  await pool.query(`UPDATE cuentas_corrientes SET moneda_cobro_id = $1, tasa_cobro = $2 WHERE id = $3`, [cobro.monedaCobroId, cobro.tasaCobro, id]);
  return obtenerCuentaCorriente(id);
}

export async function crearCuentaCorriente(input: CrearCuentaInput) {
  const saldoInicial = input.saldoInicial !== undefined ? aDecimal(input.saldoInicial, "El saldo inicial") : null;
  const canalId = input.canalId ?? ((await crearCanal(CANAL_SIN_BANCO)).id as number);
  const cobro = validarCobro(input.monedaId, input.monedaCobroId ?? null, input.tasaCobro);
  let terceroId = input.terceroId;
  if (!terceroId) {
    const n = input.nuevoTercero;
    if (!n?.nombre.trim()) throw errorHttp("Elegí un tercero o escribí el nombre del nuevo", 400);
    // Cuentas por Cobrar lleva sus propios clientes, separados de los demás módulos: el nombre solo no se puede
    // repetir dentro de Cuentas por Cobrar (puede haber un "Manuel" allá y otro en Cuentas Corrientes).
    const repetido =
      input.modulo === "POR_COBRAR"
        ? await pool.query(
            `SELECT t.id FROM terceros t JOIN cuentas_corrientes cc ON cc.tercero_id = t.id AND cc.modulo = 'POR_COBRAR' AND cc.activo
             WHERE lower(t.nombre) = lower($1) AND t.activo LIMIT 1`,
            [n.nombre.trim()]
          )
        : await pool.query(`SELECT id FROM terceros WHERE lower(nombre) = lower($1) AND activo`, [n.nombre.trim()]);
    if (repetido.rows[0] && input.modulo === "CAJA" && input.usarExistente) {
      // Confirmaciones: es el mismo cliente (ya se preguntó en la pantalla). Se le completan el teléfono y la cédula si faltaban.
      terceroId = repetido.rows[0].id as number;
      await pool.query(`UPDATE terceros SET telefono = COALESCE(NULLIF(telefono, ''), $1), identificacion = COALESCE(NULLIF(identificacion, ''), $2) WHERE id = $3`, [
        n.telefono?.trim() || null,
        n.identificacion?.trim() || null,
        terceroId,
      ]);
    } else if (repetido.rows[0]) {
      throw errorHttp(`Ya existe "${n.nombre.trim()}": buscalo en la lista en vez de crearlo de nuevo`, 409);
    } else {
      const r = await pool.query(`INSERT INTO terceros (nombre, identificacion, telefono, tipo) VALUES ($1, $2, $3, $4) RETURNING id`, [
        n.nombre.trim(),
        n.identificacion?.trim() || null,
        n.telefono?.trim() || null,
        n.tipo,
      ]);
      terceroId = r.rows[0].id as number;
    }
  }

  const existe = await pool.query(`SELECT id, activo, modulo FROM cuentas_corrientes WHERE tercero_id = $1 AND canal_id = $2 AND moneda_id = $3`, [
    terceroId,
    canalId,
    input.monedaId,
  ]);
  // Confirmaciones, cliente que ya existía: el cliente es uno solo aunque cambie de medio. Si ya tiene una cuenta de
  // Confirmaciones en esa moneda (con el medio que sea), el movimiento va a esa: el medio lo lleva cada movimiento.
  if (input.modulo === "CAJA" && input.usarExistente) {
    const suya = await pool.query(
      `SELECT id, activo FROM cuentas_corrientes WHERE tercero_id = $1 AND modulo = 'CAJA' AND moneda_id = $2 ORDER BY activo DESC, (canal_id = $3) DESC, id LIMIT 1`,
      [terceroId, input.monedaId, canalId]
    );
    if (suya.rows[0]) {
      if (!suya.rows[0].activo) await pool.query(`UPDATE cuentas_corrientes SET activo = true WHERE id = $1`, [suya.rows[0].id]);
      return obtenerCuentaCorriente(suya.rows[0].id);
    }
  }
  if (existe.rows[0] && input.modulo === "CAJA" && input.usarExistente) {
    if (existe.rows[0].modulo !== "CAJA") {
      throw errorHttp("Ese nombre ya tiene una cuenta con ese medio y esa moneda en otro módulo (Cuentas Corrientes): registralo con otro nombre o desde allá", 409);
    }
    if (!existe.rows[0].activo) await pool.query(`UPDATE cuentas_corrientes SET activo = true WHERE id = $1`, [existe.rows[0].id]);
    return obtenerCuentaCorriente(existe.rows[0].id);
  }
  // Una cuenta eliminada vuelve a aparecer tal como estaba (sus movimientos nunca se borran)
  if (existe.rows[0] && !existe.rows[0].activo) {
    await pool.query(`UPDATE cuentas_corrientes SET activo = true WHERE id = $1`, [existe.rows[0].id]);
    return obtenerCuentaCorriente(existe.rows[0].id);
  }
  if (existe.rows[0]) {
    throw errorHttp(input.canalId ? "Ese tercero ya tiene una cuenta con ese canal y esa moneda" : "Ese tercero ya tiene una cuenta sin banco en esa moneda", 409);
  }

  const cuenta = await pool.query(
    `INSERT INTO cuentas_corrientes (tercero_id, canal_id, moneda_id, saldo_actual, modulo, moneda_cobro_id, tasa_cobro, referencia, grupo_cobro) VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8) RETURNING id`,
    [terceroId, canalId, input.monedaId, input.modulo ?? "CORRIENTE", cobro.monedaCobroId, cobro.tasaCobro, input.referencia?.trim() || null, input.grupoCobro?.trim() || null]
  );
  if (saldoInicial && !saldoInicial.isZero()) {
    await registrarMovimientoCuentaCorriente({
      terceroId,
      canalId,
      monedaId: input.monedaId,
      tipo: "AJUSTE",
      monto: saldoInicial.toFixed(4),
      descripcion: "Saldo pendiente inicial",
      usuarioId: input.usuarioId,
    });
  }
  return obtenerCuentaCorriente(cuenta.rows[0].id);
}

const SELECT_CUENTA = `
  SELECT cc.*, t.nombre AS tercero_nombre, t.tipo AS tercero_tipo, t.telefono AS tercero_telefono, t.identificacion AS tercero_identificacion, ch.nombre AS canal_nombre,
         m.codigo AS moneda_codigo, m.decimales AS moneda_decimales,
         mcob.codigo AS moneda_cobro_codigo, mcob.decimales AS moneda_cobro_decimales,
         -- lo de hoy: lo que le vendí (suma) y lo que me vendió o abonó (resta)
         (SELECT COALESCE(sum(mh.monto), 0) FROM movimientos_cuenta_corriente mh
           WHERE mh.cuenta_corriente_id = cc.id AND NOT mh.anulado AND mh.monto > 0
             AND (mh.fecha AT TIME ZONE 'America/Bogota')::date = (now() AT TIME ZONE 'America/Bogota')::date) AS vendido_hoy,
         (SELECT COALESCE(sum(mh.monto), 0) FROM movimientos_cuenta_corriente mh
           WHERE mh.cuenta_corriente_id = cc.id AND NOT mh.anulado AND mh.monto < 0
             AND (mh.fecha AT TIME ZONE 'America/Bogota')::date = (now() AT TIME ZONE 'America/Bogota')::date) AS abonado_hoy,
         (SELECT max(fecha) FROM movimientos_cuenta_corriente WHERE cuenta_corriente_id = cc.id) AS ultimo_movimiento
  FROM cuentas_corrientes cc
  JOIN terceros t ON t.id = cc.tercero_id
  JOIN canales_cuenta_corriente ch ON ch.id = cc.canal_id
  JOIN monedas m ON m.id = cc.moneda_id
  LEFT JOIN monedas mcob ON mcob.id = cc.moneda_cobro_id`;

/**
 * Cuánto vale en pesos cada moneda, según la última tasa usada en los movimientos de las cuentas en pesos.
 * La moneda de la tasa se saca de la referencia (Zelle, USDT, bss...) y, si no lo dice, de su tamaño.
 */
async function valoresDeMonedas(): Promise<Record<string, string>> {
  const r = await pool.query(
    `SELECT DISTINCT ON (clase) clase, tasa FROM (
       SELECT mc.id, mc.tasa,
         CASE WHEN mc.descripcion ~* 'euro' THEN 'EUR'
              WHEN mc.descripcion ~* 'usdt' THEN 'USDT'
              WHEN mc.descripcion ~* 'zelle|d[oó]lar' THEN 'USD'
              WHEN mc.descripcion ~* 'bss|bol[ií]var|pago m[oó]vil' THEN 'VES'
              WHEN mc.tasa >= 1000 THEN 'USD'
              WHEN mc.tasa >= 2 AND mc.tasa < 100 THEN 'VES' END AS clase
       FROM movimientos_cuenta_corriente mc
       JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id
       JOIN monedas m ON m.id = cc.moneda_id
       WHERE m.codigo = 'COP' AND mc.tasa IS NOT NULL AND NOT mc.tasa_es_porcentaje AND NOT mc.anulado
     ) x WHERE clase IS NOT NULL ORDER BY clase, id DESC`
  );
  const valores: Record<string, string> = {};
  for (const f of r.rows) valores[f.clase] = new Decimal(f.tasa).toFixed();
  if (!valores.USDT && valores.USD) valores.USDT = valores.USD;
  return valores;
}

/** A cada cuenta que no es en pesos le agrega valor_moneda: cuántos pesos vale 1 de su moneda (la tasa de cobro si la tiene). */
async function conValorMoneda<T extends Record<string, any>>(cuentas: T[]): Promise<T[]> {
  if (!cuentas.some((c) => c.moneda_codigo !== "COP")) return cuentas.map((c) => ({ ...c, valor_moneda: null }));
  const valores = await valoresDeMonedas();
  return cuentas.map((c) => ({
    ...c,
    valor_moneda:
      c.moneda_codigo === "COP"
        ? null
        : c.moneda_cobro_codigo === "COP" && c.tasa_cobro
          ? new Decimal(c.tasa_cobro).toFixed()
          : (valores[c.moneda_codigo] ?? null),
  }));
}

export async function obtenerCuentaCorriente(id: number) {
  const r = await pool.query(`${SELECT_CUENTA} WHERE cc.id = $1`, [id]);
  if (!r.rows[0]) throw errorHttp("Cuenta corriente no encontrada", 404);
  return (await conValorMoneda([r.rows[0]]))[0];
}

/** Teléfono con código de país para WhatsApp: celular colombiano o venezolano sin él -> se le agrega. */
function telefonoConPais(telefono: string | null) {
  const d = (telefono ?? "").replace(/\D/g, "").replace(/^00/, "");
  if (d.length < 8) return null;
  if (d.length === 10 && d.startsWith("3")) return `57${d}`;
  if (d.length === 11 && d.startsWith("04")) return `58${d.slice(1)}`;
  return d;
}

/** Manda un mensaje al cliente de la cuenta por el WhatsApp conectado al sistema (ej. la confirmación de un abono). */
export async function avisarClientePorWhatsApp(id: number, texto: string, usuarioId: number, linea: Linea = 1) {
  const cuenta = await obtenerCuentaCorriente(id);
  const telefono = telefonoConPais(cuenta.tercero_telefono);
  if (!telefono) throw errorHttp("Este cliente no tiene un teléfono válido registrado", 400);
  // sale por la línea elegida (Bolívares, Pesos o Dólares): cada una tiene su propio chat con el cliente
  const jid = claveDeChat(linea, jidDeTelefono(telefono));
  await asegurarChat(jid, cuenta.tercero_nombre);
  await enviarMensaje({ jid, autor: "sistema", texto, usuarioId });
}

/** Eliminar una cuenta: deja de listarse. Los movimientos no se borran; si se vuelve a crear, reaparece como estaba. */
export async function eliminarCuentaCorriente(id: number) {
  const r = await pool.query(`UPDATE cuentas_corrientes SET activo = false WHERE id = $1 RETURNING id`, [id]);
  if (!r.rows[0]) throw errorHttp("Cuenta corriente no encontrada", 404);
}

/**
 * ¿Ya hay un movimiento con ese número de transferencia? Se busca en lo anotado después de la referencia
 * ("Abono Zelle · Juan 123456" o "Recibe Zelle · d1a1kat6i"), en todas las cuentas, sin contar los anulados.
 * La referencia puede tener letras: se compara completa, sin distinguir mayúsculas.
 */
export async function buscarMovimientoPorNumero(numero: string, canalId?: number) {
  // El bloqueo es por medio de pago: la misma referencia puede existir en Bancolombia y en Nequi (cada banco numera
  // por su cuenta), pero no dos veces en el mismo medio. Sin canal se busca en todos.
  const r = await pool.query(
    `SELECT mc.id, mc.fecha, mc.descripcion, mc.monto, t.nombre AS tercero_nombre, ch.nombre AS canal_nombre
     FROM movimientos_cuenta_corriente mc
     JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id
     -- el medio es el del movimiento; los anteriores a ese dato usan el de la cuenta
     JOIN canales_cuenta_corriente ch ON ch.id = COALESCE(mc.canal_id, cc.canal_id)
     JOIN terceros t ON t.id = cc.tercero_id
     WHERE NOT mc.anulado AND position(' · ' in mc.descripcion) > 0
       AND ($2::int IS NULL OR COALESCE(mc.canal_id, cc.canal_id) = $2)
       AND regexp_replace(split_part(mc.descripcion, ' · ', 2), ' \([0-9.,]+ [A-Z]{3,5} a [0-9.,]+\)$', '') ~* ('(^|[^a-z0-9])' || $1 || '([^a-z0-9]|$)')
     ORDER BY mc.id DESC LIMIT 1`,
    [numero, canalId ?? null]
  );
  return r.rows[0] ?? null;
}

/** Pasar una cuenta a Cuentas por Cobrar (sale de la lista de Cuentas Corrientes) o devolverla. No toca saldo ni movimientos. */
export async function cambiarModuloCuentaCorriente(id: number, modulo: ModuloCuenta) {
  const r = await pool.query(`UPDATE cuentas_corrientes SET modulo = $1 WHERE id = $2 RETURNING id`, [modulo, id]);
  if (!r.rows[0]) throw errorHttp("Cuenta corriente no encontrada", 404);
  return obtenerCuentaCorriente(id);
}

/** Cuentas por Cobrar: cambiar de grupo a un cliente ("Cerveloza", "Zelle", "Préstamos"...). */
export async function cambiarGrupoCobro(id: number, grupo: string | null) {
  const r = await pool.query(`UPDATE cuentas_corrientes SET grupo_cobro = $1 WHERE id = $2 AND modulo = 'POR_COBRAR' RETURNING id`, [grupo?.trim() || null, id]);
  if (!r.rows[0]) throw errorHttp("Cuenta por cobrar no encontrada", 404);
  return obtenerCuentaCorriente(id);
}

export async function listarCuentasCorrientes(filtros: {
  terceroId?: number;
  canalId?: number;
  buscar?: string;
  tipoTercero?: string;
  // corrientes: las que se llevan en Cuentas Corrientes. cobrar: las pasadas a Cuentas por Cobrar + toda cuenta con saldo (me deben o yo debo)
  vista?: "corrientes" | "cobrar" | "cajas";
}) {
  const cond: string[] = ["cc.activo"]; // las eliminadas no se listan
  if (filtros.vista === "corrientes") cond.push(`cc.modulo = 'CORRIENTE'`);
  if (filtros.vista === "cajas") cond.push(`cc.modulo = 'CAJA'`);
  // Cuentas por Cobrar lleva solo sus propios clientes (ya no se alimenta de las cuentas corrientes con saldo)
  if (filtros.vista === "cobrar") cond.push(`cc.modulo = 'POR_COBRAR'`);
  const valores: unknown[] = [];
  if (filtros.terceroId) {
    valores.push(filtros.terceroId);
    cond.push(`cc.tercero_id = $${valores.length}`);
  }
  if (filtros.canalId) {
    valores.push(filtros.canalId);
    cond.push(`cc.canal_id = $${valores.length}`);
  }
  if (filtros.tipoTercero) {
    valores.push(filtros.tipoTercero);
    cond.push(`t.tipo::text = $${valores.length}`);
  }
  if (filtros.buscar?.trim()) {
    // Por nombre, por cédula o por teléfono (comparando solo los dígitos, sin espacios ni +)
    const texto = filtros.buscar.trim();
    valores.push(`%${texto}%`);
    // ...o por referencia: la del cliente, o la anotada en alguno de sus movimientos (número de transferencia, MTCN, quién envió)
    const porReferencia =
      texto.length >= 3
        ? ` OR cc.referencia ILIKE $${valores.length} OR EXISTS (SELECT 1 FROM movimientos_cuenta_corriente mr WHERE mr.cuenta_corriente_id = cc.id AND NOT mr.anulado AND position(' · ' in mr.descripcion) > 0 AND split_part(mr.descripcion, ' · ', 2) ILIKE $${valores.length})`
        : "";
    const porTexto = `(t.nombre ILIKE $${valores.length} OR t.identificacion ILIKE $${valores.length}${porReferencia})`;
    const digitos = texto.replace(/\D/g, "");
    if (digitos.length >= 3) {
      valores.push(`%${digitos}%`);
      cond.push(`(${porTexto} OR regexp_replace(COALESCE(t.telefono, ''), '\\D', '', 'g') LIKE $${valores.length} OR regexp_replace(COALESCE(t.identificacion, ''), '\\D', '', 'g') LIKE $${valores.length})`);
    } else {
      cond.push(porTexto);
    }
  }
  const r = await pool.query(`${SELECT_CUENTA} ${cond.length ? `WHERE ${cond.join(" AND ")}` : ""} ORDER BY t.nombre, ch.nombre`, valores);
  // Si se buscó algo, a cada cuenta se le dice en qué movimiento apareció (para no confundir dos clientes con la misma referencia)
  const buscado = filtros.buscar?.trim() ?? "";
  let filas = r.rows;
  if (buscado.length >= 3 && filas.length) {
    const m = await pool.query(
      `SELECT DISTINCT ON (cuenta_corriente_id) cuenta_corriente_id, descripcion, fecha, monto
       FROM movimientos_cuenta_corriente
       WHERE NOT anulado AND position(' · ' in descripcion) > 0 AND split_part(descripcion, ' · ', 2) ILIKE $1 AND cuenta_corriente_id = ANY($2::int[])
       ORDER BY cuenta_corriente_id, id DESC`,
      [`%${buscado}%`, filas.map((f) => f.id)]
    );
    const porCuenta = new Map(m.rows.map((x) => [x.cuenta_corriente_id, { descripcion: x.descripcion, fecha: x.fecha, monto: x.monto }]));
    filas = filas.map((f) => ({ ...f, movimiento_coincide: porCuenta.get(f.id) ?? null }));
  }
  return conValorMoneda(filas);
}

export async function crearCanal(nombre: string) {
  // Mismo formato que los canales existentes (ZELLE, WESTERN_UNION...)
  const limpio = nombre.trim().toUpperCase().replace(/\s+/g, "_");
  if (!limpio) throw errorHttp("Escribí el nombre del canal", 400);
  const r = await pool.query(
    `INSERT INTO canales_cuenta_corriente (nombre) VALUES ($1)
     ON CONFLICT (nombre) DO UPDATE SET activo = true RETURNING *`,
    [limpio]
  );
  return r.rows[0];
}

/** Cambiar el nombre de un canal o quitarlo de la lista (se desactiva: las cuentas que lo usan lo conservan). */
export async function actualizarCanal(id: number, cambios: { nombre?: string; activo?: boolean }) {
  const actual = await pool.query(`SELECT nombre FROM canales_cuenta_corriente WHERE id = $1`, [id]);
  if (!actual.rows[0]) throw errorHttp("Canal no encontrado", 404);
  if (actual.rows[0].nombre === CANAL_SIN_BANCO) throw errorHttp("Esa opción es del sistema: no se puede cambiar", 409);
  const limpio = cambios.nombre?.trim().toUpperCase().replace(/\s+/g, "_");
  if (cambios.nombre !== undefined && !limpio) throw errorHttp("Escribí el nombre del canal", 400);
  if (limpio) {
    const repetido = await pool.query(`SELECT id FROM canales_cuenta_corriente WHERE nombre = $1 AND id <> $2`, [limpio, id]);
    if (repetido.rows[0]) throw errorHttp("Ya hay otra opción con ese nombre", 409);
  }
  const r = await pool.query(
    `UPDATE canales_cuenta_corriente SET nombre = COALESCE($2, nombre), activo = COALESCE($3, activo) WHERE id = $1 RETURNING *`,
    [id, limpio ?? null, cambios.activo ?? null]
  );
  return r.rows[0];
}

/**
 * La hoja del Excel: saldo pendiente con el que arranca el período, cada movimiento con
 * su TOTAL corrido, y las sumas. El total se calcula en orden de fecha (no de carga), así
 * un movimiento cargado con fecha de ayer queda donde corresponde.
 */
export async function obtenerEstadoCuenta(id: number, filtros: { desde?: string; hasta?: string }) {
  const cuenta = await obtenerCuentaCorriente(id);
  const dia = `(fecha AT TIME ZONE '${ZONA}')::date`;
  const r = await pool.query(
    `WITH corridos AS (
       SELECT mc.*, sum(mc.monto) OVER (ORDER BY mc.fecha, mc.id) AS total
       FROM movimientos_cuenta_corriente mc WHERE mc.cuenta_corriente_id = $1
     )
     SELECT c.id, c.fecha, c.descripcion, c.tipo, c.cantidad_base, c.tasa, c.tasa_es_porcentaje, c.comision_descontada, c.comision_incluida, c.estado_confirmacion, (c.comprobante_key IS NOT NULL) AS tiene_comprobante, c.pagado_en, c.cuenta_destino, c.monto, c.total, c.anulado, c.reverso_de_id,
            c.movimiento_caja_id, c.created_at, u.nombre AS usuario_nombre, mb.codigo AS moneda_base_codigo, cat.nombre AS categoria_nombre
     FROM corridos c
     JOIN usuarios u ON u.id = c.usuario_id
     LEFT JOIN monedas mb ON mb.id = c.moneda_base_id
     LEFT JOIN categorias_movimiento cat ON cat.id = c.categoria_id
     WHERE ($2::date IS NULL OR ${dia.replace("fecha", "c.fecha")} >= $2::date)
       AND ($3::date IS NULL OR ${dia.replace("fecha", "c.fecha")} <= $3::date)
     ORDER BY c.fecha, c.id`,
    [id, filtros.desde ?? null, filtros.hasta ?? null]
  );
  const anterior = await pool.query(
    `SELECT COALESCE(sum(monto), 0) AS saldo FROM movimientos_cuenta_corriente
     WHERE cuenta_corriente_id = $1 AND $2::date IS NOT NULL AND ${dia} < $2::date`,
    [id, filtros.desde ?? null]
  );
  const saldoAnterior = new Decimal(anterior.rows[0].saldo);
  let sumas = new Decimal(0);
  let abonos = new Decimal(0);
  // lo que el cliente envió en el período: la cantidad de cada compra, antes de tasa o comisión
  let enviado = new Decimal(0);
  for (const m of r.rows) {
    if (m.anulado) continue; // un movimiento y su reverso se cancelan: no ensucian las sumas
    const monto = new Decimal(m.monto);
    if (monto.isPositive() && m.cantidad_base != null) enviado = enviado.plus(new Decimal(m.cantidad_base).abs());
    if (monto.isPositive()) sumas = sumas.plus(monto);
    else abonos = abonos.plus(monto);
  }
  const saldoFinal = r.rows.length ? new Decimal(r.rows[r.rows.length - 1].total) : saldoAnterior;
  // Si se está viendo un solo día: con qué saldo se cerró (si ya se cerró)
  const cierre =
    filtros.desde && filtros.desde === filtros.hasta
      ? (
          await pool.query(
            `SELECT c.saldo_final, c.created_at, u.nombre AS usuario_nombre
             FROM cierres_cuenta_corriente c JOIN usuarios u ON u.id = c.usuario_id
             WHERE c.cuenta_corriente_id = $1 AND c.dia = $2::date`,
            [id, filtros.desde]
          )
        ).rows[0] ?? null
      : null;
  // Lo enviado por el cliente en toda la historia de la cuenta, y cuánto de eso todavía no se le pagó
  const envios = await pool.query(
    `SELECT COALESCE(sum(abs(cantidad_base)), 0) AS total,
            COALESCE(sum(abs(cantidad_base)) FILTER (WHERE pagado_en IS NULL), 0) AS por_pagar
     FROM movimientos_cuenta_corriente
     WHERE cuenta_corriente_id = $1 AND NOT anulado AND reverso_de_id IS NULL AND monto > 0 AND cantidad_base IS NOT NULL`,
    [id]
  );
  return {
    cuenta,
    cierre,
    enviado: enviado.toFixed(4),
    enviadoTotal: new Decimal(envios.rows[0].total).toFixed(4),
    enviadoPorPagar: new Decimal(envios.rows[0].por_pagar).toFixed(4),
    saldoAnterior: saldoAnterior.toFixed(4),
    movimientos: r.rows,
    sumas: sumas.toFixed(4),
    abonos: abonos.toFixed(4),
    saldoFinal: saldoFinal.toFixed(4),
  };
}

/** Cierre diario: deja anotado con qué saldo se cerró el día. Volver a cerrar el mismo día lo actualiza. */
export async function cerrarDiaCuentaCorriente(id: number, dia: string, usuarioId: number) {
  const { saldoFinal } = await obtenerEstadoCuenta(id, { desde: dia, hasta: dia });
  await pool.query(
    `INSERT INTO cierres_cuenta_corriente (cuenta_corriente_id, dia, saldo_final, usuario_id) VALUES ($1, $2::date, $3, $4)
     ON CONFLICT (cuenta_corriente_id, dia) DO UPDATE SET saldo_final = EXCLUDED.saldo_final, usuario_id = EXCLUDED.usuario_id, created_at = now()`,
    [id, dia, saldoFinal, usuarioId]
  );
  return obtenerEstadoCuenta(id, { desde: dia, hasta: dia });
}

/**
 * La misma hoja, en un .xlsx para mandarle al cliente: FECHA · REFERENCIA · CANTIDAD · TASA · MONTO · TOTAL.
 * Los negativos (lo que yo le debo) salen en rojo y con signo, como en el Excel de siempre.
 */
export async function generarExcelEstadoCuenta(id: number, filtros: { desde?: string; hasta?: string }) {
  const { cuenta, saldoAnterior, movimientos, sumas, abonos, saldoFinal } = await obtenerEstadoCuenta(id, filtros);
  const fechaCorta = (f: string | Date) => new Date(f).toLocaleDateString("es-CO", { timeZone: ZONA, day: "2-digit", month: "2-digit", year: "numeric" });
  const periodo = filtros.desde || filtros.hasta ? `Del ${filtros.desde ?? "inicio"} al ${filtros.hasta ?? "hoy"}` : "Todos los movimientos";
  const final = new Decimal(saldoFinal);
  const lectura = final.isZero() ? "Cuenta al día" : final.isNegative() ? "Saldo a favor del cliente (se le debe)" : "Saldo pendiente por pagar";

  const filas: (string | number | null)[][] = [
    [`Estado de cuenta — ${cuenta.tercero_nombre}`],
    [`Moneda: ${cuenta.moneda_codigo}`, null, periodo],
    [],
    ["FECHA", "REFERENCIA", "CANTIDAD", "TASA", "MONTO", "TOTAL"],
  ];
  const encabezado = filas.length - 1;
  if (filtros.desde) filas.push([null, "Saldo pendiente anterior", null, null, null, Number(saldoAnterior)]);
  const porcentajes: number[] = []; // filas cuya tasa es una comisión en %
  for (const m of movimientos) {
    if (m.tasa_es_porcentaje && !m.comision_descontada) porcentajes.push(filas.length);
    filas.push([
      fechaCorta(m.fecha),
      `${m.descripcion ?? m.tipo}${m.cuenta_destino ? ` → ${m.cuenta_destino}` : ""}${m.anulado && !m.reverso_de_id ? " (anulado)" : ""}`,
      m.cantidad_base != null ? Number(m.cantidad_base) : null,
      // comisión descontada: se guarda el factor (0.96) y se muestra como -4%
      // (si el % ya venía sumado en lo enviado, el factor es 1/1,06 y se muestra como +6%)
      m.comision_descontada && m.tasa != null
        ? m.comision_incluida
          ? `+${new Decimal(1).div(m.tasa).minus(1).times(100).toDecimalPlaces(3).toFixed()}%`
          : new Decimal(m.tasa).eq(1)
            ? "sin comisión" // familiar o amigo
            : `-${new Decimal(1).minus(m.tasa).times(100).toFixed()}%`
        : m.tasa != null
          ? Number(m.tasa)
          : null,
      Number(m.monto),
      Number(m.total),
    ]);
  }
  filas.push([]);
  filas.push([null, "Sumas del período", null, null, Number(sumas)]);
  filas.push([null, "Abonos del período", null, null, Number(abonos)]);
  filas.push([null, "SALDO PENDIENTE", null, null, null, Number(saldoFinal)]);
  filas.push([null, lectura]);
  if (cuenta.moneda_cobro_codigo && cuenta.tasa_cobro && !final.isZero()) {
    const equivalente = final.abs().times(cuenta.tasa_cobro).toDecimalPlaces(Number(cuenta.moneda_cobro_decimales), Decimal.ROUND_HALF_UP);
    filas.push([null, `Equivale a ${equivalente.toNumber().toLocaleString("es-CO")} ${cuenta.moneda_cobro_codigo} (tasa ${new Decimal(cuenta.tasa_cobro).toNumber().toLocaleString("es-CO")})`]);
  }

  const hoja = XLSX.utils.aoa_to_sheet(filas);
  const dinero = "#,##0.##;[Red]-#,##0.##";
  for (let f = encabezado + 1; f < filas.length; f++) {
    for (const c of [2, 4, 5]) {
      const celda = hoja[XLSX.utils.encode_cell({ r: f, c })];
      if (celda?.t === "n") celda.z = dinero;
    }
    const tasa = hoja[XLSX.utils.encode_cell({ r: f, c: 3 })];
    if (tasa?.t === "n") tasa.z = porcentajes.includes(f) ? "0.##%" : "#,##0.########";
  }
  hoja["!cols"] = [{ wch: 12 }, { wch: 38 }, { wch: 16 }, { wch: 10 }, { wch: 18 }, { wch: 18 }];
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, "Estado de cuenta");
  return XLSX.write(libro, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/**
 * Las últimas tasas y porcentajes de comisión usados, para volver a aplicarlos sin escribirlos.
 * Primero las de esta cuenta, después las del resto; la más reciente adelante.
 */
export async function obtenerTasasRecientes(cuentaId: number) {
  const r = await pool.query(
    `SELECT mc.tasa, mc.tasa_es_porcentaje, max(mc.id) AS ultimo, bool_or(mc.cuenta_corriente_id = $1) AS de_esta
     FROM movimientos_cuenta_corriente mc
     WHERE mc.tasa IS NOT NULL AND NOT mc.anulado AND NOT mc.comision_descontada
       AND mc.id > (SELECT COALESCE(max(id), 0) - 3000 FROM movimientos_cuenta_corriente)
     GROUP BY mc.tasa, mc.tasa_es_porcentaje
     ORDER BY de_esta DESC, ultimo DESC`,
    [cuentaId]
  );
  const tasas = r.rows.filter((f) => !f.tasa_es_porcentaje).slice(0, 5).map((f) => new Decimal(f.tasa).toFixed());
  // La comisión se guarda como fracción (0.03): se devuelve como se escribe (3)
  const porcentajes = r.rows.filter((f) => f.tasa_es_porcentaje).slice(0, 5).map((f) => new Decimal(f.tasa).times(100).toFixed());
  // La tasa que queda puesta en el formulario: la fijada en la cuenta o, si no hay, la última usada en ella
  const cuenta = await pool.query(`SELECT tasa_habitual FROM cuentas_corrientes WHERE id = $1`, [cuentaId]);
  const ultimaDeEsta = r.rows.find((f) => f.de_esta && !f.tasa_es_porcentaje);
  const fijada = cuenta.rows[0]?.tasa_habitual ?? ultimaDeEsta?.tasa ?? null;
  // La referencia que más se usa con esta persona (sin el nombre de quien envió ni el detalle del cobro)
  const ref = await pool.query(
    `SELECT regexp_replace(split_part(descripcion, ' · ', 1), ' \([0-9.,]+ [A-Z]{3,5} a [0-9.,]+\)$', '') AS referencia, count(*) AS veces, max(id) AS ultimo
     FROM (SELECT id, descripcion FROM movimientos_cuenta_corriente
           WHERE cuenta_corriente_id = $1 AND NOT anulado AND descripcion IS NOT NULL
             AND descripcion NOT LIKE 'Reverso de%' AND descripcion <> 'Saldo pendiente inicial'
           ORDER BY id DESC LIMIT 300) recientes
     GROUP BY 1 ORDER BY veces DESC, ultimo DESC LIMIT 1`,
    [cuentaId]
  );
  return {
    tasas,
    porcentajes,
    tasaHabitual: fijada != null ? new Decimal(fijada).toFixed() : null,
    referenciaFrecuente: (ref.rows[0]?.referencia as string | undefined) ?? null,
  };
}

/** Fijar la tasa que queda puesta en el formulario de esta cuenta. */
export async function guardarTasaHabitual(id: number, tasa: string) {
  const valor = aDecimal(tasa, "La tasa");
  if (valor.lte(0)) throw errorHttp("La tasa debe ser mayor a cero", 400);
  const r = await pool.query(`UPDATE cuentas_corrientes SET tasa_habitual = $1 WHERE id = $2 RETURNING id`, [valor.toFixed(8), id]);
  if (!r.rows[0]) throw errorHttp("Cuenta corriente no encontrada", 404);
  return { tasaHabitual: valor.toFixed() };
}

/** Guarda la imagen del comprobante con el movimiento (se ve después en la hoja del cliente y en Taquilla). */
export async function guardarComprobanteMovimiento(movimientoId: number, imagen: Buffer, mime: string) {
  const existe = await pool.query(`SELECT id FROM movimientos_cuenta_corriente WHERE id = $1`, [movimientoId]);
  if (!existe.rows[0]) throw errorHttp("Movimiento no encontrado", 404);
  const key = await subirArchivo("comprobantes-movimientos", `mov-${movimientoId}-${Date.now()}`, imagen, mime);
  await pool.query(`UPDATE movimientos_cuenta_corriente SET comprobante_key = $1, comprobante_mime = $2 WHERE id = $3`, [key, mime, movimientoId]);
  return { ok: true };
}

/** Enlace temporal (unos minutos) para ver la imagen del comprobante de un movimiento. */
export async function urlComprobanteMovimiento(movimientoId: number) {
  const r = await pool.query(`SELECT comprobante_key, comprobante_mime FROM movimientos_cuenta_corriente WHERE id = $1`, [movimientoId]);
  if (!r.rows[0]?.comprobante_key) throw errorHttp("Ese movimiento no tiene imagen de comprobante", 404);
  return { url: generarUrlTemporal(r.rows[0].comprobante_key, r.rows[0].comprobante_mime, 600) };
}

/** Western (u otro medio que tarda) ya verificó: el movimiento en proceso pasa a confirmado. */
export async function confirmarMovimiento(movimientoId: number) {
  const r = await pool.query(
    `UPDATE movimientos_cuenta_corriente SET estado_confirmacion = 'CONFIRMADA' WHERE id = $1 AND estado_confirmacion = 'EN_PROCESO' AND NOT anulado RETURNING id`,
    [movimientoId]
  );
  if (!r.rows[0]) throw errorHttp("Ese movimiento no está en proceso de confirmación", 409);
  return { id: movimientoId, estado_confirmacion: "CONFIRMADA" as const };
}

/** Un error no se borra: se registra el movimiento contrario (y el de caja, si lo hubo). */
export async function anularMovimiento(movimientoId: number, usuarioId: number) {
  const r = await pool.query(
    `SELECT mc.*, cc.tercero_id, cc.canal_id, cc.moneda_id, mcaja.caja_id, mcaja.moneda_id AS caja_moneda_id, mcaja.tipo AS caja_tipo,
            mcaja.monto AS caja_monto, mcaja.metodo_pago_id
     FROM movimientos_cuenta_corriente mc
     JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id
     LEFT JOIN movimientos_caja mcaja ON mcaja.id = mc.movimiento_caja_id
     WHERE mc.id = $1`,
    [movimientoId]
  );
  const m = r.rows[0];
  if (!m) throw errorHttp("Movimiento no encontrado", 404);
  if (m.anulado) throw errorHttp("Ese movimiento ya está anulado", 409);

  return registrarMovimientoCuentaCorriente({
    terceroId: m.tercero_id,
    canalId: m.canal_id,
    monedaId: m.moneda_id,
    tipo: "AJUSTE",
    monto: new Decimal(m.monto).negated().toFixed(4),
    cantidadBase: m.cantidad_base != null && m.tasa != null ? new Decimal(m.cantidad_base).negated().toString() : undefined,
    monedaBaseId: m.moneda_base_id ?? undefined,
    tasa: m.cantidad_base != null && m.tasa != null ? new Decimal(m.tasa).toString() : undefined,
    tasaEsPorcentaje: m.tasa_es_porcentaje,
    comisionDescontada: m.comision_descontada,
    comisionIncluida: m.comision_incluida,
    canalMovimientoId: m.canal_id ?? undefined,
    descripcion: `Reverso de: ${m.descripcion ?? m.tipo}`,
    fecha: new Date(m.fecha).toISOString(),
    usuarioId,
    reversoDeId: m.id,
    ...(m.caja_id
      ? {
          cajaId: m.caja_id,
          monedaCajaId: m.caja_moneda_id,
          // lo contrario de lo que se hizo en la caja
          montoCaja: (m.caja_tipo === "INGRESO" ? new Decimal(m.caja_monto).negated() : new Decimal(m.caja_monto)).toFixed(4),
          metodoPagoId: m.metodo_pago_id ?? undefined,
        }
      : {}),
  });
}

