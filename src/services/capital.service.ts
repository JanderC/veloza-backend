import { pool } from "../db/pool";

// Capital de giros: lo que el sistema ya sabe para el cuadre (los saldos de las cajas y las confirmaciones sin pagar)
// y los cuadres guardados. Lo que está fuera del sistema lo llena el administrador en la pantalla.

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
    `SELECT m.codigo, sum(mc.monto) AS total, count(*)::int AS cantidad
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
  const bancos = await pool.query(
    `SELECT c.id, c.nombre, mc.codigo AS moneda,
            COALESCE((SELECT json_agg(json_build_object('codigo', m.codigo, 'monto', s.monto) ORDER BY m.codigo) FROM saldos_caja s JOIN monedas m ON m.id = s.moneda_id WHERE s.caja_id = c.id AND s.monto <> 0), '[]') AS saldos
     FROM cajas c LEFT JOIN monedas mc ON mc.id = c.moneda_id
     WHERE c.activo AND c.tipo = 'BANCO' ORDER BY c.id`
  );
  return {
    cajas: [...porCaja.values()],
    bancos: bancos.rows as { id: number; nombre: string; moneda: string | null; saldos: { codigo: string; monto: string }[] }[],
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
