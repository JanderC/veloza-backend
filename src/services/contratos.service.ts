import { randomBytes } from "crypto";
import { pool } from "../db/pool";

/**
 * Contratos de comisión y firmas. Se guardan las firmas de:
 *   CLIENTE       el cliente (EL COMITENTE)
 *   TITULAR       el titular de la cuenta que recibe el dinero del cliente
 *   COMISIONISTA  el titular de una cuenta de banco de la empresa (BDV 8515 a nombre de…): firma como EL COMISIONISTA
 *                 en los contratos de los clientes que depositaron en su cuenta
 *   EMPRESA       la firma general de la empresa (cuando no se sabe de qué cuenta es)
 * La última vigente de cada uno es la que va en los contratos nuevos. Se puede firmar desde el teléfono con un link
 * (sirve una vez y vence). Cada contrato generado queda guardado con sus datos y sus firmas.
 */

const err = (mensaje: string, status: number) => Object.assign(new Error(mensaje), { status });

// La migración 057: mientras no esté, el módulo avisa en vez de romperse
let listo: boolean | null = null;
export async function contratosListos() {
  if (listo) return true;
  listo = (await pool.query(`SELECT to_regclass('public.firma_links') IS NOT NULL AS hay`)).rows[0].hay as boolean;
  if (!listo) throw err("Falta preparar la base para los contratos (migración 057)", 503);
  return true;
}
// La migración 058 (titulares de las cuentas de la empresa)
let conCuentas: boolean | null = null;
async function titularesDeCuentasListos() {
  if (conCuentas) return true;
  conCuentas = (await pool.query(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'firmas' AND column_name = 'caja_id') AS hay`)).rows[0].hay as boolean;
  return conCuentas;
}
async function exigirTitularesDeCuentas() {
  if (!(await titularesDeCuentasListos())) throw err("Falta preparar la base para los titulares de las cuentas (migración 058)", 503);
}

const soloDigitos = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");
const DIAS_LINK = 7;
const MAX_IMAGEN = 600_000; // ~450 KB de PNG

function validarImagen(imagen: string) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(imagen)) throw err("La firma no es una imagen válida", 400);
  if (imagen.length > MAX_IMAGEN) throw err("La imagen de la firma es muy grande", 413);
}

export type TipoFirma = "CLIENTE" | "TITULAR" | "EMPRESA" | "COMISIONISTA";
/** Los datos de quien firma como EL COMISIONISTA (van en el contrato). */
export interface DatosParte {
  rif?: string | null;
  ciudad?: string | null;
  municipio?: string | null;
  estado?: string | null;
}

async function camposFirma() {
  const base = `f.id, f.tipo, f.tercero_id, f.nombre, f.cedula, f.numero_cuenta, f.banco, f.imagen, f.origen, f.activa, f.created_at`;
  return (await titularesDeCuentasListos()) ? `${base}, f.caja_id, f.datos, (SELECT nombre FROM cajas WHERE id = f.caja_id) AS caja_nombre` : `${base}, NULL::int AS caja_id, NULL::jsonb AS datos, NULL::text AS caja_nombre`;
}

// ---------------------------------------------------------------- firmas

export async function guardarFirma(
  d: { tipo: TipoFirma; terceroId?: number | null; cajaId?: number | null; nombre: string; cedula?: string | null; numeroCuenta?: string | null; banco?: string | null; datos?: DatosParte | null; imagen: string; origen: "LINK" | "PANEL" },
  usuarioId: number | null
) {
  await contratosListos();
  validarImagen(d.imagen);
  if (d.nombre.trim().length < 3) throw err("Falta el nombre de quien firma", 400);
  if (d.tipo === "COMISIONISTA") {
    await exigirTitularesDeCuentas();
    const caja = d.cajaId ? (await pool.query(`SELECT id FROM cajas WHERE id = $1 AND tipo = 'BANCO'`, [d.cajaId])).rows[0] : null;
    if (!caja) throw err("Esa cuenta de banco de la empresa no existe", 404);
  }
  const conCaja = await titularesDeCuentasListos();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // la nueva reemplaza a la anterior de la misma persona (la vieja queda en el historial, sin usarse)
    if (d.tipo === "EMPRESA") await client.query(`UPDATE firmas SET activa = false WHERE tipo = 'EMPRESA' AND activa`);
    else if (d.tipo === "COMISIONISTA") await client.query(`UPDATE firmas SET activa = false WHERE tipo = 'COMISIONISTA' AND caja_id = $1 AND activa`, [d.cajaId]);
    else if (d.tipo === "CLIENTE" && d.terceroId) await client.query(`UPDATE firmas SET activa = false WHERE tipo = 'CLIENTE' AND tercero_id = $1 AND activa`, [d.terceroId]);
    else if (d.tipo === "TITULAR" && soloDigitos(d.cedula)) await client.query(`UPDATE firmas SET activa = false WHERE tipo = 'TITULAR' AND regexp_replace(COALESCE(cedula, ''), '\\D', '', 'g') = $1 AND activa`, [soloDigitos(d.cedula)]);
    const columnas = ["tipo", "tercero_id", "nombre", "cedula", "numero_cuenta", "banco", "imagen", "origen", "usuario_id", ...(conCaja ? ["caja_id", "datos"] : [])];
    const valores = [d.tipo, d.terceroId ?? null, d.nombre.trim(), d.cedula?.trim() || null, d.numeroCuenta?.trim() || null, d.banco?.trim() || null, d.imagen, d.origen, usuarioId, ...(conCaja ? [d.cajaId ?? null, d.datos ? JSON.stringify(d.datos) : null] : [])];
    const r = await client.query(
      `INSERT INTO firmas (${columnas.join(", ")}) VALUES (${columnas.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id, tipo, tercero_id, nombre, cedula, numero_cuenta, banco, origen, created_at`,
      valores
    );
    await client.query("COMMIT");
    return r.rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Las firmas vigentes: de un tipo, las de un cliente (su firma y la de sus titulares) o la de una cuenta de la empresa. */
export async function listarFirmas(f: { tipo?: TipoFirma; terceroId?: number; cajaId?: number; buscar?: string }) {
  await contratosListos();
  const conCaja = await titularesDeCuentasListos();
  const cond = ["f.activa"];
  const valores: unknown[] = [];
  if (f.tipo) {
    valores.push(f.tipo);
    cond.push(`f.tipo = $${valores.length}`);
  }
  if (f.terceroId) {
    valores.push(f.terceroId);
    cond.push(`f.tercero_id = $${valores.length}`);
  }
  if (f.cajaId) {
    if (!conCaja) return [];
    valores.push(f.cajaId);
    cond.push(`f.caja_id = $${valores.length}`);
  }
  if (f.buscar?.trim()) {
    valores.push(`%${f.buscar.trim()}%`);
    cond.push(`(f.nombre ILIKE $${valores.length} OR f.cedula ILIKE $${valores.length} OR f.numero_cuenta ILIKE $${valores.length} OR t.nombre ILIKE $${valores.length})`);
  }
  const r = await pool.query(
    `SELECT ${await camposFirma()}, t.nombre AS cliente_nombre FROM firmas f LEFT JOIN terceros t ON t.id = f.tercero_id
     WHERE ${cond.join(" AND ")} ORDER BY f.created_at DESC LIMIT 300`,
    valores
  );
  return r.rows;
}

export async function quitarFirma(id: number) {
  await contratosListos();
  const r = await pool.query(`UPDATE firmas SET activa = false WHERE id = $1 RETURNING id`, [id]);
  if (!r.rows[0]) throw err("Esa firma no existe", 404);
  return { quitada: true };
}

export async function firmasPorId(ids: number[]) {
  if (!ids.length) return [];
  return (await pool.query(`SELECT ${await camposFirma()} FROM firmas f WHERE f.id = ANY($1::int[])`, [ids])).rows;
}

/** La cuenta de banco de la empresa donde entró la plata de una operación del cliente (la que alimentó el capture). */
export async function cuentaDeMovimiento(movimientoId: number) {
  const r = await pool.query(
    `SELECT k.caja_id FROM movimientos_cuenta_corriente mc JOIN movimientos_caja k ON k.id = mc.movimiento_caja_id JOIN cajas c ON c.id = k.caja_id
     WHERE mc.id = $1 AND c.tipo = 'BANCO'`,
    [movimientoId]
  );
  return { cajaId: (r.rows[0]?.caja_id as number | undefined) ?? null };
}

// ---------------------------------------------------------------- links para firmar

export async function crearLink(
  d: { tipo: "CLIENTE" | "TITULAR" | "COMISIONISTA"; terceroId?: number | null; cajaId?: number | null; nombre?: string | null; cedula?: string | null; numeroCuenta?: string | null; banco?: string | null },
  usuarioId: number
) {
  await contratosListos();
  const token = randomBytes(24).toString("hex");
  if (d.tipo === "COMISIONISTA") {
    await exigirTitularesDeCuentas();
    const caja = d.cajaId ? (await pool.query(`SELECT id, nombre FROM cajas WHERE id = $1 AND tipo = 'BANCO'`, [d.cajaId])).rows[0] : null;
    if (!caja) throw err("Esa cuenta de banco de la empresa no existe", 404);
    const r = await pool.query(
      `INSERT INTO firma_links (token, tipo, caja_id, nombre, cedula, expira_en, usuario_id)
       VALUES ($1, 'COMISIONISTA', $2, $3, $4, now() + make_interval(days => $5), $6) RETURNING id, token, tipo, nombre, cedula, expira_en`,
      [token, caja.id, d.nombre?.trim() || null, d.cedula?.trim() || null, DIAS_LINK, usuarioId]
    );
    return { ...r.rows[0], estado: "PENDIENTE", caja_id: caja.id, caja_nombre: caja.nombre };
  }
  if (!d.terceroId) throw err("Falta el cliente", 400);
  const cliente = (await pool.query(`SELECT id, nombre, identificacion FROM terceros WHERE id = $1`, [d.terceroId])).rows[0];
  if (!cliente) throw err("Cliente no encontrado", 404);
  const nombre = d.tipo === "CLIENTE" ? cliente.nombre : d.nombre?.trim() || null;
  const cedula = d.tipo === "CLIENTE" ? cliente.identificacion : d.cedula?.trim() || null;
  const r = await pool.query(
    `INSERT INTO firma_links (token, tipo, tercero_id, nombre, cedula, numero_cuenta, banco, expira_en, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(days => $8), $9) RETURNING id, token, tipo, nombre, cedula, expira_en`,
    [token, d.tipo, d.terceroId, nombre, cedula, d.numeroCuenta?.trim() || null, d.banco?.trim() || null, DIAS_LINK, usuarioId]
  );
  return { ...r.rows[0], estado: "PENDIENTE" };
}

export async function listarLinks(f: { terceroId?: number; cajaId?: number }) {
  await contratosListos();
  const conCaja = await titularesDeCuentasListos();
  if (f.cajaId && !conCaja) return [];
  const r = await pool.query(
    `SELECT l.id, l.token, l.tipo, l.tercero_id, t.nombre AS cliente_nombre, l.nombre, l.cedula, l.numero_cuenta, l.banco, l.firma_id,
            l.expira_en, l.firmado_en, l.created_at, u.nombre AS creado_por,
            ${conCaja ? "l.caja_id, (SELECT nombre FROM cajas WHERE id = l.caja_id) AS caja_nombre" : "NULL::int AS caja_id, NULL::text AS caja_nombre"},
            CASE WHEN l.firmado_en IS NOT NULL THEN 'FIRMADO' WHEN l.expira_en < now() THEN 'VENCIDO' ELSE 'PENDIENTE' END AS estado
     FROM firma_links l LEFT JOIN terceros t ON t.id = l.tercero_id LEFT JOIN usuarios u ON u.id = l.usuario_id
     WHERE ($1::int IS NULL OR l.tercero_id = $1) ${f.cajaId ? "AND l.caja_id = $2" : ""} ORDER BY l.created_at DESC LIMIT 200`,
    f.cajaId ? [f.terceroId ?? null, f.cajaId] : [f.terceroId ?? null]
  );
  return r.rows;
}

/** Lo que ve quien abre el link (sin iniciar sesión): quién tiene que firmar y para qué. */
export async function linkPublico(token: string) {
  await contratosListos();
  if (!/^[a-f0-9]{48}$/.test(token)) throw err("Este link no es válido", 404);
  const conCaja = await titularesDeCuentasListos();
  const l = (
    await pool.query(
      `SELECT l.*, t.nombre AS cliente_nombre, ${conCaja ? "(SELECT nombre FROM cajas WHERE id = l.caja_id)" : "NULL::text"} AS caja_nombre
       FROM firma_links l LEFT JOIN terceros t ON t.id = l.tercero_id WHERE l.token = $1`,
      [token]
    )
  ).rows[0];
  if (!l) throw err("Este link no es válido", 404);
  if (l.firmado_en) throw err("Este link ya se usó: la firma quedó registrada. Gracias.", 410);
  if (new Date(l.expira_en) < new Date()) throw err("Este link venció. Pedile uno nuevo a Pago Veloz al Cambio.", 410);
  return {
    tipo: l.tipo as "CLIENTE" | "TITULAR" | "COMISIONISTA",
    nombre: l.nombre as string | null,
    cedula: l.cedula as string | null,
    numeroCuenta: l.numero_cuenta as string | null,
    banco: l.banco as string | null,
    cliente: l.cliente_nombre as string | null,
    cuenta: l.caja_nombre as string | null,
    expira: l.expira_en as string,
  };
}

/** Firma desde el link: queda guardada a nombre del cliente, del titular o de la cuenta de la empresa, y el link ya no sirve. */
export async function firmarConLink(token: string, d: { imagen: string; nombre?: string; cedula?: string; numeroCuenta?: string; datos?: DatosParte }) {
  const info = await linkPublico(token);
  const l = (await pool.query(`SELECT * FROM firma_links WHERE token = $1`, [token])).rows[0];
  const nombre = (info.tipo === "CLIENTE" ? info.nombre : d.nombre?.trim() || info.nombre) ?? "";
  const cedula = (info.tipo === "CLIENTE" ? info.cedula : d.cedula?.trim() || info.cedula) ?? null;
  if (nombre.trim().length < 3) throw err("Escribí tu nombre completo", 400);
  if (!soloDigitos(cedula)) throw err("Escribí tu número de cédula", 400);
  if (info.tipo === "COMISIONISTA" && !d.datos?.ciudad?.trim()) throw err("Escribí la ciudad donde vivís (va en el contrato)", 400);
  const firma = await guardarFirma(
    {
      tipo: info.tipo,
      terceroId: l.tercero_id,
      cajaId: l.caja_id ?? null,
      nombre,
      cedula,
      numeroCuenta: d.numeroCuenta?.trim() || info.numeroCuenta,
      banco: info.banco,
      datos: info.tipo === "COMISIONISTA" ? d.datos ?? null : null,
      imagen: d.imagen,
      origen: "LINK",
    },
    null
  );
  // un solo uso: si dos lo firman a la vez, solo uno queda
  const r = await pool.query(`UPDATE firma_links SET firmado_en = now(), firma_id = $1 WHERE id = $2 AND firmado_en IS NULL RETURNING id`, [firma.id, l.id]);
  if (!r.rows[0]) {
    await pool.query(`UPDATE firmas SET activa = false WHERE id = $1`, [firma.id]);
    throw err("Este link ya se usó", 410);
  }
  // el cliente que firma sin cédula cargada: se le pone la que escribió
  if (info.tipo === "CLIENTE" && l.tercero_id && soloDigitos(cedula)) {
    await pool.query(`UPDATE terceros SET identificacion = $1 WHERE id = $2 AND (identificacion IS NULL OR identificacion = '')`, [cedula, l.tercero_id]).catch(() => {});
  }
  return { firmado: true, nombre };
}

// ---------------------------------------------------------------- contratos

export async function guardarContrato(
  d: { terceroId: number; numero?: string | null; clienteNombre: string; titularNombre?: string | null; datos: unknown; firmaClienteId?: number | null; firmaTitularId?: number | null; firmaEmpresaId?: number | null },
  usuarioId: number
) {
  await contratosListos();
  const r = await pool.query(
    `INSERT INTO contratos (numero, tercero_id, cliente_nombre, titular_nombre, datos, firma_cliente_id, firma_titular_id, firma_empresa_id, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
    [d.numero ?? null, d.terceroId, d.clienteNombre, d.titularNombre ?? null, JSON.stringify(d.datos), d.firmaClienteId ?? null, d.firmaTitularId ?? null, d.firmaEmpresaId ?? null, usuarioId]
  );
  return r.rows[0];
}

export async function listarContratos(f: { terceroId?: number; buscar?: string }) {
  await contratosListos();
  const valores: unknown[] = [];
  const cond: string[] = [];
  if (f.terceroId) {
    valores.push(f.terceroId);
    cond.push(`c.tercero_id = $${valores.length}`);
  }
  if (f.buscar?.trim()) {
    valores.push(`%${f.buscar.trim()}%`);
    cond.push(`(c.cliente_nombre ILIKE $${valores.length} OR c.titular_nombre ILIKE $${valores.length} OR c.numero ILIKE $${valores.length})`);
  }
  const r = await pool.query(
    `SELECT c.id, c.numero, c.tercero_id, c.cliente_nombre, c.titular_nombre, c.created_at, u.nombre AS hecho_por,
            c.datos -> 'comisionista' ->> 'nombre' AS comisionista_nombre,
            c.firma_cliente_id IS NOT NULL AS firmo_cliente, c.firma_titular_id IS NOT NULL AS firmo_titular, c.firma_empresa_id IS NOT NULL AS firmo_empresa,
            (c.datos -> 'finiquito') IS NOT NULL AND (c.datos -> 'finiquito') <> 'null'::jsonb AS con_finiquito
     FROM contratos c LEFT JOIN usuarios u ON u.id = c.usuario_id
     ${cond.length ? `WHERE ${cond.join(" AND ")}` : ""} ORDER BY c.created_at DESC LIMIT 300`,
    valores
  );
  return r.rows;
}

/** Un contrato con sus datos y sus firmas, para volver a armar el Word igual. */
export async function obtenerContrato(id: number) {
  await contratosListos();
  const c = (await pool.query(`SELECT * FROM contratos WHERE id = $1`, [id])).rows[0];
  if (!c) throw err("Contrato no encontrado", 404);
  const firmas = await firmasPorId([c.firma_cliente_id, c.firma_titular_id, c.firma_empresa_id].filter(Boolean));
  const de = (fid: number | null) => firmas.find((x) => x.id === fid) ?? null;
  return { ...c, firmaCliente: de(c.firma_cliente_id), firmaTitular: de(c.firma_titular_id), firmaEmpresa: de(c.firma_empresa_id) };
}
