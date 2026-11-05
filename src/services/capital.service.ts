import { pool } from "../db/pool";

// Capital de giros: lo que el sistema ya sabe para el cuadre (los saldos de las cajas y las confirmaciones sin pagar)
// y los cuadres guardados. Lo que está fuera del sistema lo llena el administrador en la pantalla.

// La tabla de los datos de las cuentas (migración 055): mientras no esté, todo sigue como antes
let hayDatosBanco: boolean | null = null;
async function tablaDatosBanco() {
  if (hayDatosBanco) return true;
  hayDatosBanco = (await pool.query(`SELECT to_regclass('public.cajas_datos_banco') IS NOT NULL AS hay`)).rows[0].hay as boolean;
  return hayDatosBanco;
}

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
    `SELECT m.codigo, sum(mc.monto - mc.pagado_parcial) AS total, count(*)::int AS cantidad
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
  // las cuentas de banco de la empresa (Bancolombia, Nequi, Bolívares, USDT…), con su moneda y lo que tienen
  const columnaDatos = (await tablaDatosBanco())
    ? `COALESCE((SELECT json_agg(json_build_object('id', x.id, 'tipo', x.tipo, 'banco', x.banco, 'numero', x.numero, 'cedula', x.cedula, 'telefono', x.telefono) ORDER BY x.id) FROM cajas_datos_banco x WHERE x.caja_id = c.id), '[]') AS datos`
    : `'[]'::json AS datos`;
  const bancos = await pool.query(
    `SELECT c.id, c.nombre, mc.codigo AS moneda,
            COALESCE((SELECT json_agg(json_build_object('codigo', m.codigo, 'monto', s.monto) ORDER BY m.codigo) FROM saldos_caja s JOIN monedas m ON m.id = s.moneda_id WHERE s.caja_id = c.id AND s.monto <> 0), '[]') AS saldos,
            ${columnaDatos}
     FROM cajas c LEFT JOIN monedas mc ON mc.id = c.moneda_id
     WHERE c.activo AND c.tipo = 'BANCO' ORDER BY c.id`
  );
  // de cada cliente de Confirmaciones: desde cuándo tiene confirmaciones sin pagar (no ha venido a retirar)
  const sinRetirar = await pool.query(
    `SELECT mc.cuenta_corriente_id AS cuenta_id, min(mc.fecha) AS desde, max(mc.fecha) AS hasta, count(*)::int AS cantidad
     FROM movimientos_cuenta_corriente mc JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id
     WHERE cc.modulo = 'CAJA' AND mc.monto > 0 AND NOT mc.anulado AND mc.reverso_de_id IS NULL AND mc.pagado_en IS NULL
     GROUP BY 1`
  );
  return {
    cajas: [...porCaja.values()],
    sinRetirar: sinRetirar.rows as { cuenta_id: number; desde: string; hasta: string; cantidad: number }[],
    bancos: bancos.rows as { id: number; nombre: string; moneda: string | null; saldos: { codigo: string; monto: string }[]; datos: Omit<DatoBanco, "caja_id">[] }[],
    confirmacionesPorPagar: porPagar.rows as { codigo: string; total: string; cantidad: number }[],
  };
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

/** Nueva cuenta de banco de la empresa, desde el capital (con su moneda). */
export async function crearCuentaBanco(nombre: string, monedaCodigo: string) {
  const moneda = (await pool.query(`SELECT id FROM monedas WHERE codigo = $1`, [monedaCodigo])).rows[0];
  if (!moneda) throw Object.assign(new Error("Esa moneda no existe"), { status: 400 });
  const ya = await pool.query(`SELECT id FROM cajas WHERE lower(nombre) = lower($1)`, [nombre.trim()]);
  if (ya.rows[0]) throw Object.assign(new Error(`Ya hay una caja o cuenta llamada "${nombre.trim()}"`), { status: 409 });
  const r = await pool.query(`INSERT INTO cajas (nombre, tipo, descripcion, moneda_id) VALUES ($1, 'BANCO', 'Cuenta de banco cargada desde Capital de giros', $2) RETURNING id, nombre`, [
    nombre.trim(),
    moneda.id,
  ]);
  return r.rows[0];
}

/**
 * El saldo real de una cuenta de banco: se anota la diferencia con lo que tenía el sistema como un movimiento de
 * esa cuenta (ingreso o egreso), y desde ahí el sistema la sigue llevando (los pagos por otro método salen de ahí).
 */
export async function cargarSaldoBanco(cajaId: number, monedaCodigo: string, saldoReal: string, usuarioId: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const caja = (await client.query(`SELECT id, nombre FROM cajas WHERE id = $1 AND tipo = 'BANCO' AND activo`, [cajaId])).rows[0];
    if (!caja) throw Object.assign(new Error("Esa cuenta de banco no existe"), { status: 404 });
    const moneda = (await client.query(`SELECT id FROM monedas WHERE codigo = $1`, [monedaCodigo])).rows[0];
    if (!moneda) throw Object.assign(new Error("Esa moneda no existe"), { status: 400 });
    const real = Number(saldoReal);
    if (!Number.isFinite(real)) throw Object.assign(new Error("El saldo no es un número válido"), { status: 400 });
    let fila = (await client.query(`SELECT id, monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`, [cajaId, moneda.id])).rows[0];
    if (!fila) fila = (await client.query(`INSERT INTO saldos_caja (caja_id, moneda_id, monto) VALUES ($1, $2, 0) RETURNING id, monto`, [cajaId, moneda.id])).rows[0];
    const antes = Number(fila.monto);
    const diferencia = Math.round((real - antes) * 10000) / 10000;
    if (diferencia !== 0) {
      await client.query(
        `INSERT INTO movimientos_caja (caja_id, moneda_id, tipo, monto, saldo_anterior, saldo_nuevo, usuario_id, observacion) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [cajaId, moneda.id, diferencia > 0 ? "INGRESO" : "EGRESO", Math.abs(diferencia).toFixed(4), antes.toFixed(4), real.toFixed(4), usuarioId, "Saldo real cargado desde Capital de giros"]
      );
      await client.query(`UPDATE saldos_caja SET monto = $1 WHERE id = $2`, [real.toFixed(4), fila.id]);
    }
    await client.query("COMMIT");
    return { cuenta: caja.nombre, antes: antes.toFixed(4), ahora: real.toFixed(4), diferencia: diferencia.toFixed(4) };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Cambiarle el nombre a una cuenta de banco de la empresa. */
export async function renombrarCuentaBanco(cajaId: number, nombre: string) {
  const ya = await pool.query(`SELECT id FROM cajas WHERE lower(nombre) = lower($1) AND id <> $2`, [nombre.trim(), cajaId]);
  if (ya.rows[0]) throw Object.assign(new Error(`Ya hay una caja o cuenta llamada "${nombre.trim()}"`), { status: 409 });
  const r = await pool.query(`UPDATE cajas SET nombre = $1 WHERE id = $2 AND tipo = 'BANCO' RETURNING id, nombre`, [nombre.trim(), cajaId]);
  if (!r.rows[0]) throw Object.assign(new Error("Esa cuenta de banco no existe"), { status: 404 });
  return r.rows[0];
}

/** Suma o resta en una cuenta de banco dentro de una transacción, dejando el movimiento anotado. (Las de banco pueden quedar en negativo.) */
async function moverBanco(client: import("pg").PoolClient, cajaId: number, monedaId: number, delta: number, usuarioId: number, observacion: string) {
  let fila = (await client.query(`SELECT id, monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`, [cajaId, monedaId])).rows[0];
  if (!fila) fila = (await client.query(`INSERT INTO saldos_caja (caja_id, moneda_id, monto) VALUES ($1, $2, 0) RETURNING id, monto`, [cajaId, monedaId])).rows[0];
  const antes = Number(fila.monto);
  const despues = Math.round((antes + delta) * 10000) / 10000;
  await client.query(
    `INSERT INTO movimientos_caja (caja_id, moneda_id, tipo, monto, saldo_anterior, saldo_nuevo, usuario_id, observacion) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [cajaId, monedaId, delta > 0 ? "INGRESO" : "EGRESO", Math.abs(delta).toFixed(4), antes.toFixed(4), despues.toFixed(4), usuarioId, observacion]
  );
  await client.query(`UPDATE saldos_caja SET monto = $1 WHERE id = $2`, [despues.toFixed(4), fila.id]);
  return { antes, despues };
}

async function enTransaccion<T>(fn: (client: import("pg").PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function bancoYMoneda(cajaId: number, monedaCodigo: string) {
  const caja = (await pool.query(`SELECT id, nombre FROM cajas WHERE id = $1 AND tipo = 'BANCO' AND activo`, [cajaId])).rows[0];
  if (!caja) throw Object.assign(new Error("Esa cuenta de banco no existe"), { status: 404 });
  const moneda = (await pool.query(`SELECT id FROM monedas WHERE codigo = $1`, [monedaCodigo])).rows[0];
  if (!moneda) throw Object.assign(new Error("Esa moneda no existe"), { status: 400 });
  return { caja: caja as { id: number; nombre: string }, monedaId: moneda.id as number };
}

/** Un ingreso o un egreso en una cuenta de banco (con su nota: qué fue). */
export async function movimientoBanco(cajaId: number, d: { tipo: "INGRESO" | "EGRESO"; moneda: string; monto: string; nota: string }, usuarioId: number) {
  const { caja, monedaId } = await bancoYMoneda(cajaId, d.moneda);
  const monto = Number(d.monto);
  if (!(monto > 0)) throw Object.assign(new Error("El monto tiene que ser mayor a cero"), { status: 400 });
  const r = await enTransaccion((c) => moverBanco(c, caja.id, monedaId, d.tipo === "INGRESO" ? monto : -monto, usuarioId, `${d.tipo === "INGRESO" ? "Ingreso" : "Egreso"}: ${d.nota.trim()}`));
  return { cuenta: caja.nombre, antes: r.antes.toFixed(4), ahora: r.despues.toFixed(4) };
}

/** Pasar plata de una cuenta de banco a otra (en la misma moneda). */
export async function transferirEntreBancos(d: { origenId: number; destinoId: number; moneda: string; monto: string; nota?: string }, usuarioId: number) {
  if (d.origenId === d.destinoId) throw Object.assign(new Error("Elegí dos cuentas distintas"), { status: 400 });
  const o = await bancoYMoneda(d.origenId, d.moneda);
  const dst = await bancoYMoneda(d.destinoId, d.moneda);
  const monto = Number(d.monto);
  if (!(monto > 0)) throw Object.assign(new Error("El monto tiene que ser mayor a cero"), { status: 400 });
  const nota = d.nota?.trim() ? ` · ${d.nota.trim()}` : "";
  await enTransaccion(async (c) => {
    // siempre en el mismo orden, para que dos traslados a la vez no se traben
    const pasos = [
      { id: o.caja.id, delta: -monto, obs: `Traslado a ${dst.caja.nombre}${nota}` },
      { id: dst.caja.id, delta: monto, obs: `Traslado desde ${o.caja.nombre}${nota}` },
    ].sort((a, b) => a.id - b.id);
    for (const p of pasos) await moverBanco(c, p.id, o.monedaId, p.delta, usuarioId, p.obs);
  });
  return { de: o.caja.nombre, a: dst.caja.nombre, monto: monto.toFixed(4), moneda: d.moneda };
}

/** Los últimos movimientos de una cuenta de banco. */
export async function movimientosBanco(cajaId: number) {
  const r = await pool.query(
    `SELECT k.id, k.tipo, k.monto, k.saldo_nuevo, k.observacion, k.created_at, m.codigo, u.nombre AS usuario
     FROM movimientos_caja k JOIN monedas m ON m.id = k.moneda_id LEFT JOIN usuarios u ON u.id = k.usuario_id
     WHERE k.caja_id = $1 ORDER BY k.id DESC LIMIT 30`,
    [cajaId]
  );
  return r.rows;
}

/** Lo que se va escribiendo en el capital (tasas, filas a mano): queda guardado al instante, para todos los computadores. */
export async function obtenerBorrador() {
  const r = await pool.query(`SELECT datos, updated_at FROM capital_borrador WHERE id = 1`);
  return r.rows[0] ?? null;
}

export async function guardarBorrador(datos: unknown, usuarioId: number) {
  await pool.query(
    `INSERT INTO capital_borrador (id, datos, usuario_id, updated_at) VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET datos = EXCLUDED.datos, usuario_id = EXCLUDED.usuario_id, updated_at = now()`,
    [JSON.stringify(datos), usuarioId]
  );
  return { guardado: true };
}

// ---------- Con qué se reconoce cada cuenta de banco en un capture ----------

export interface DatoBanco {
  id: number;
  caja_id: number;
  tipo: "CUENTA" | "PAGO_MOVIL";
  banco: string | null;
  numero: string | null;
  cedula: string | null;
  telefono: string | null;
}

const soloDigitos = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");
/** El teléfono venezolano sin el 0 ni el 58: 04147320762 y +58 414-7320762 quedan 4147320762. */
export function telefonoNormal(v: string | null | undefined) {
  const d = soloDigitos(v);
  return d.length >= 10 ? d.slice(-10) : d;
}

export async function listarDatosBanco(cajaId: number) {
  return (await pool.query(`SELECT id, caja_id, tipo, banco, numero, cedula, telefono FROM cajas_datos_banco WHERE caja_id = $1 ORDER BY id`, [cajaId])).rows as DatoBanco[];
}

export async function agregarDatoBanco(cajaId: number, d: { tipo: "CUENTA" | "PAGO_MOVIL"; banco?: string; numero?: string; cedula?: string; telefono?: string }, usuarioId: number) {
  const caja = (await pool.query(`SELECT id FROM cajas WHERE id = $1 AND tipo = 'BANCO'`, [cajaId])).rows[0];
  if (!caja) throw Object.assign(new Error("Esa cuenta de banco no existe"), { status: 404 });
  const banco = soloDigitos(d.banco) || null;
  if (banco && banco.length !== 4) throw Object.assign(new Error("El código del banco tiene 4 dígitos (ej. 0102 Banco de Venezuela)"), { status: 400 });
  const numero = d.tipo === "CUENTA" ? soloDigitos(d.numero) : null;
  const telefono = d.tipo === "PAGO_MOVIL" ? telefonoNormal(d.telefono) : null;
  const cedula = soloDigitos(d.cedula) || null;
  if (d.tipo === "CUENTA" && (!numero || numero.length < 4)) throw Object.assign(new Error("Escribí el número de la cuenta (por lo menos los últimos 4 dígitos)"), { status: 400 });
  if (d.tipo === "PAGO_MOVIL" && (!telefono || telefono.length !== 10)) throw Object.assign(new Error("El teléfono del pago móvil no es válido (ej. 0414-7320762)"), { status: 400 });
  // la misma cuenta o el mismo teléfono en otra cuenta de la empresa: el capture no sabría a cuál ir
  const otra = (
    await pool.query(
      `SELECT c.nombre FROM cajas_datos_banco x JOIN cajas c ON c.id = x.caja_id
       WHERE x.tipo = $1 AND (($1 = 'CUENTA' AND right(x.numero, 4) = right($2, 4) AND (x.banco IS NULL OR $3::text IS NULL OR x.banco = $3) AND (length(x.numero) < 10 OR length($2) < 10 OR x.numero = $2))
                         OR ($1 = 'PAGO_MOVIL' AND x.telefono = $4))
       LIMIT 1`,
      [d.tipo, numero ?? "", banco, telefono]
    )
  ).rows[0];
  if (otra) throw Object.assign(new Error(`Ese ${d.tipo === "CUENTA" ? "número de cuenta" : "teléfono"} ya está en la cuenta "${otra.nombre}"`), { status: 409 });
  const r = await pool.query(
    `INSERT INTO cajas_datos_banco (caja_id, tipo, banco, numero, cedula, telefono, usuario_id) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, caja_id, tipo, banco, numero, cedula, telefono`,
    [cajaId, d.tipo, banco, numero, cedula, telefono, usuarioId]
  );
  return r.rows[0] as DatoBanco;
}

export async function quitarDatoBanco(id: number) {
  const r = await pool.query(`DELETE FROM cajas_datos_banco WHERE id = $1 RETURNING id`, [id]);
  if (!r.rows[0]) throw Object.assign(new Error("Ese dato ya no está"), { status: 404 });
  return { quitado: true };
}

/**
 * Lo que dice el capture como origen o destino ("0102****8515", "04147320762", "0102-0123-45-0001234567"), comparado
 * con las cuentas de la empresa. Una cuenta se reconoce por sus últimos 4 dígitos (y el banco, si los dos lo dicen);
 * un pago móvil, por el teléfono. Si coincide con más de una cuenta no se adivina.
 */
export function coincideDato(escrito: string, d: Pick<DatoBanco, "tipo" | "banco" | "numero" | "telefono">) {
  const digitos = soloDigitos(escrito);
  if (digitos.length < 4) return false;
  if (d.tipo === "PAGO_MOVIL") {
    // un teléfono: 10 dígitos que empiezan con 4 (sin el 0 ni el 58)
    const tel = /^(?:58)?0?(4\d{9})$/.exec(digitos)?.[1];
    return !!tel && tel === d.telefono;
  }
  const numero = d.numero ?? "";
  if (numero.length < 4) return false;
  // un teléfono (pago móvil) no es una cuenta, aunque termine igual
  if (/^(?:58)?0?4\d{9}$/.test(digitos)) return digitos === numero;
  // enmascarada: "0102****8515" -> banco 0102, termina en 8515
  const mascara = /(\d{4})[^\d]*[*xX•·.]{2,}[^\d]*(\d{3,})\s*$/.exec(escrito.trim());
  const final = mascara ? mascara[2]! : digitos;
  const bancoCapture = mascara ? mascara[1]! : digitos.length >= 20 ? digitos.slice(0, 4) : null;
  const bancoDato = d.banco ?? (numero.length >= 20 ? numero.slice(0, 4) : null);
  if (bancoCapture && bancoDato && bancoCapture !== bancoDato) return false;
  // completas las dos: tienen que ser iguales
  if (!mascara && digitos.length >= 10 && numero.length >= 10) return digitos === numero;
  const cuantos = Math.min(4, final.length);
  return final.slice(-cuantos) === numero.slice(-cuantos) && cuantos >= 4;
}

export async function reconocerCuentaBanco(origen: string | null, destino: string | null) {
  if (!(await tablaDatosBanco())) return null;
  const datos = (
    await pool.query(
      `SELECT x.id, x.caja_id, x.tipo, x.banco, x.numero, x.telefono, c.nombre, m.id AS moneda_id, m.codigo AS moneda
       FROM cajas_datos_banco x JOIN cajas c ON c.id = x.caja_id
       LEFT JOIN monedas m ON m.id = COALESCE(c.moneda_id, (SELECT id FROM monedas WHERE codigo = 'COP'))
       WHERE c.activo AND c.tipo = 'BANCO'`
    )
  ).rows;
  const buscar = (escrito: string | null) => {
    if (!escrito) return null;
    const cajas = [...new Map(datos.filter((d) => coincideDato(escrito, d)).map((d) => [d.caja_id, d])).values()];
    return cajas.length === 1 ? cajas[0] : null;
  };
  // lo que llega a una cuenta nuestra entra; lo que sale de una cuenta nuestra, sale
  const aDestino = buscar(destino);
  const deOrigen = aDestino ? null : buscar(origen);
  const d = aDestino ?? deOrigen;
  if (!d) return null;
  return {
    cajaId: d.caja_id as number,
    nombre: d.nombre as string,
    monedaId: (d.moneda_id as number | null) ?? null,
    moneda: (d.moneda as string | null) ?? null,
    rol: aDestino ? ("destino" as const) : ("origen" as const),
    dato: d.tipo === "PAGO_MOVIL" ? `pago móvil ${d.telefono}` : `cuenta terminada en ${String(d.numero).slice(-4)}`,
  };
}
