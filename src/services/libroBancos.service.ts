import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { coincideDato } from "./capital.service";

/**
 * Libro contable de las cuentas de banco de la empresa (las de bolívares, Bancolombia…) y estados de cuenta.
 *
 * - El libro es lo que entró y salió de cada cuenta: confirmaciones (lo que mandó un cliente, reconocido por los
 *   últimos 4 dígitos o el teléfono del capture), pagos, fondeos, traslados y lo cargado de un estado de cuenta.
 *   Cada renglón dice quién lo hizo, de qué cliente es y con qué referencia.
 * - Un estado de cuenta (el PDF del banco, o el mismo texto en MD) se lee renglón por renglón y se cruza con el
 *   libro: por referencia, o por día, monto y sentido. Lo que ya está queda conciliado; lo que falta se anota.
 * - Las referencias se protegen: la misma referencia no entra dos veces en la misma cuenta para dos clientes.
 */

// La migración 056: mientras no esté, todo sigue como antes
let listo: boolean | null = null;
export async function libroListo() {
  if (listo) return true;
  listo = (await pool.query(`SELECT to_regclass('public.banco_extracto_lineas') IS NOT NULL AS hay`)).rows[0].hay as boolean;
  return listo;
}
const sinLibro = () => Object.assign(new Error("Falta preparar la base para el libro de bancos (migración 056)"), { status: 503 });

const err = (mensaje: string, status: number) => Object.assign(new Error(mensaje), { status });
const soloDigitos = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

// ---------------------------------------------------------------- lectura del estado de cuenta

export interface RenglonExtracto {
  referencia: string;
  fecha: string; // AAAA-MM-DD
  descripcion: string;
  tipo: "NC" | "ND"; // nota de crédito (entra) o de débito (sale)
  monto: string; // positivo, con punto decimal: "1300.00"
  saldo: string | null;
}
export interface Extracto {
  cuenta: string | null; // 0102****8515
  desde: string | null;
  hasta: string | null;
  saldoInicial: string | null;
  saldoFinal: string | null;
  renglones: RenglonExtracto[];
  // revisión: cada renglón tiene que cuadrar con el saldo del anterior (si no, algo se leyó mal)
  descuadres: { referencia: string; fecha: string; esperado: string; dice: string }[];
  totalCreditos: string;
  totalDebitos: string;
}

const MONTO = String.raw`-?\d{1,3}(?:\.\d{3})*,\d{2}`;
const aNumero = (m: string) => Number(m.replace(/\./g, "").replace(",", "."));
const aIso = (f: string) => {
  const [d, m, a] = f.split("/");
  return `${a}-${m}-${d}`;
};
const dos = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/**
 * Lee el texto de un estado de cuenta del Banco de Venezuela: el que sale del PDF (donde cada celda puede venir
 * partida en varios renglones) o el MD con las tablas. Cada movimiento termina con un bloque que siempre viene
 * entero: fecha, SI/NC/ND, débito, crédito y saldo. Lo que hay entre un bloque y el siguiente es la referencia y la
 * descripción del movimiento; lo que queda antes de la referencia (el teléfono del pago móvil, "CANAL 54…") completa
 * la descripción del anterior. Los encabezados y pies de página se saltan.
 */
export function leerExtracto(texto: string): Extracto {
  const plano = texto.replace(/\|/g, " ");
  const ancla = new RegExp(String.raw`(\d{2}/\d{2}/\d{4})\s*(SI|NC|ND)\s*(${MONTO})\s*(${MONTO})\s*(${MONTO})`, "g");
  const cuenta = /(\d{4}\s*[*xX•]{2,}\s*\d{4})/.exec(texto)?.[1]?.replace(/\s/g, "") ?? null;
  const periodo = /(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/.exec(texto);
  // lo que no es de ningún movimiento: encabezados, pie de página, la tabla del resumen
  const ruido = (l: string) =>
    /^[-\s]+$/.test(l) ||
    /^#/.test(l) ||
    /estado de cuenta|banco de venezuela|banco universal|certifica|^cliente$|^direcci[oó]n$|cuenta\s*per[ií]odo|^cuenta$|^per[ií]odo$|saldo\s*inicial|saldo\s*promedio|saldo\s*final|total\s*d[eé]bitos|intereses\s*pagados|intereses\s*cobrados|impuestos\s*retenidos|islr\s*cobrados|referencia\s*descripci/i.test(l) ||
    // solo números con puntos o comas (la fila del resumen); un número largo solo es una referencia
    (/^\d[\d.,\s-]*$/.test(l) && !/^\d{6,20}$/.test(l));
  // entre el pie de una página y el encabezado de la siguiente no hay nada de los movimientos
  const limpiar = (trozo: string) => {
    let lineas = trozo.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const pie = lineas.findIndex((l) => /certifica|estado de cuenta/i.test(l));
    if (pie >= 0) {
      const encabezado = lineas.map((l) => /referencia\s*descripci/i.test(l)).lastIndexOf(true);
      lineas = [...lineas.slice(0, pie), ...(encabezado > pie ? lineas.slice(encabezado + 1) : [])];
    }
    return lineas.filter((l) => !ruido(l));
  };
  const renglones: RenglonExtracto[] = [];
  let saldoInicial: string | null = null;
  let desde = 0;
  const completarAnterior = (lineas: string[]) => {
    if (lineas.length && renglones.length) renglones[renglones.length - 1]!.descripcion += ` ${lineas.join(" ")}`;
  };
  for (const m of plano.matchAll(ancla)) {
    const lineas = limpiar(plano.slice(desde, m.index));
    desde = m.index! + m[0].length;
    const [, fecha, mov, debito, credito, saldo] = m;
    // la referencia: el renglón que empieza con el número largo del banco ("0677221491391 OPERACION…", 12 o más
    // dígitos); si no hay, el primero con un número ("00011401"). Así una cédula partida del renglón anterior no se toma.
    const larga = lineas.findIndex((l) => /^\d{12,20}(?:\s|$)/.test(l));
    const i = larga >= 0 ? larga : lineas.findIndex((l) => /^\d{6,20}(?:\s|$)/.test(l));
    completarAnterior(i >= 0 ? lineas.slice(0, i) : mov === "SI" ? [] : lineas);
    if (mov === "SI") {
      saldoInicial ??= dos(aNumero(saldo!));
      continue;
    }
    if (i < 0) continue;
    const referencia = /^(\d{6,20})/.exec(lineas[i]!)![1]!;
    const descripcion = [lineas[i]!.slice(referencia.length), ...lineas.slice(i + 1)].join(" ").replace(/\s+/g, " ").trim();
    const monto = mov === "ND" ? Math.abs(aNumero(debito!)) : Math.abs(aNumero(credito!));
    if (!(monto > 0)) continue;
    renglones.push({ referencia, fecha: aIso(fecha!), descripcion, tipo: mov as "NC" | "ND", monto: dos(monto), saldo: dos(aNumero(saldo!)) });
  }
  completarAnterior(limpiar(plano.slice(desde)));
  // revisión de saldos: el saldo de cada renglón = el anterior ± el monto
  const descuadres: Extracto["descuadres"] = [];
  let corriendo = saldoInicial !== null ? Number(saldoInicial) : null;
  let creditos = 0;
  let debitos = 0;
  for (const r of renglones) {
    const delta = r.tipo === "NC" ? Number(r.monto) : -Number(r.monto);
    if (r.tipo === "NC") creditos += Number(r.monto);
    else debitos += Number(r.monto);
    if (corriendo !== null && r.saldo !== null) {
      const esperado = corriendo + delta;
      if (Math.abs(esperado - Number(r.saldo)) > 0.005) descuadres.push({ referencia: r.referencia, fecha: r.fecha, esperado: dos(esperado), dice: r.saldo });
    }
    corriendo = r.saldo !== null ? Number(r.saldo) : corriendo !== null ? corriendo + delta : null;
  }
  return {
    cuenta,
    desde: periodo ? aIso(periodo[1]!) : (renglones[0]?.fecha ?? null),
    hasta: periodo ? aIso(periodo[2]!) : (renglones[renglones.length - 1]?.fecha ?? null),
    saldoInicial,
    saldoFinal: renglones.length ? renglones[renglones.length - 1]!.saldo : saldoInicial,
    renglones,
    descuadres,
    totalCreditos: dos(creditos),
    totalDebitos: dos(debitos),
  };
}

/** El texto de un archivo: un PDF se lee con el lector de PDF; un MD o un TXT, tal cual. */
export async function textoDeArchivo(buffer: Buffer, nombre: string, tipo: string) {
  const esPdf = /pdf/i.test(tipo) || /\.pdf$/i.test(nombre) || buffer.subarray(0, 5).toString() === "%PDF-";
  if (!esPdf) return buffer.toString("utf8");
  // (se importa el archivo de adentro: el principal de pdf-parse corre una prueba al cargarse)
  const pdf = (await import("pdf-parse/lib/pdf-parse.js")).default as (b: Buffer) => Promise<{ text: string }>;
  try {
    return (await pdf(buffer)).text;
  } catch {
    throw err("No se pudo leer el PDF. Si está protegido con clave, descargalo de nuevo sin clave.", 400);
  }
}

// ---------------------------------------------------------------- cruce con el libro

/** Dos referencias son la misma si coinciden en sus últimos 8 dígitos (o completas si son más cortas). */
export function mismaReferencia(a: string | null | undefined, b: string | null | undefined) {
  const x = soloDigitos(a);
  const y = soloDigitos(b);
  if (x.length < 6 || y.length < 6) return false;
  const n = Math.min(8, x.length, y.length);
  return x.slice(-n) === y.slice(-n);
}

type Db = Pick<PoolClient, "query">;

/**
 * El movimiento del libro que corresponde a un renglón del estado de cuenta: mismo sentido y mismo monto, todavía
 * sin conciliar; primero el de la misma referencia y si no, el único de ese día (o del día anterior o siguiente).
 */
async function buscarEnLibro(db: Db, cajaId: number, r: Pick<RenglonExtracto, "referencia" | "fecha" | "tipo" | "monto">) {
  const candidatos = (
    await db.query(
      `SELECT k.id, k.referencia, to_char(COALESCE(k.fecha_banco, (k.created_at AT TIME ZONE 'America/Bogota')::date), 'YYYY-MM-DD') AS dia
       FROM movimientos_caja k
       WHERE k.caja_id = $1 AND k.tipo = $2 AND k.monto = $3::numeric
         AND NOT EXISTS (SELECT 1 FROM banco_extracto_lineas x WHERE x.movimiento_caja_id = k.id)
         AND COALESCE(k.fecha_banco, (k.created_at AT TIME ZONE 'America/Bogota')::date) BETWEEN $4::date - 3 AND $4::date + 3`,
      [cajaId, r.tipo === "NC" ? "INGRESO" : "EGRESO", r.monto, r.fecha]
    )
  ).rows as { id: number; referencia: string | null; dia: string }[];
  const porRef = candidatos.find((c) => mismaReferencia(c.referencia, r.referencia));
  if (porRef) return porRef.id;
  // (en pago móvil el número de operación del capture no es el mismo del estado de cuenta: por eso no se descarta por referencia)
  const delDia = candidatos.filter((c) => Math.abs(Date.parse(c.dia) - Date.parse(r.fecha)) <= 86_400_000);
  return delDia.length === 1 ? delDia[0]!.id : null;
}

/** La cuenta de la empresa a la que es el estado de cuenta (por los últimos 4 dígitos que dice). */
async function cuentaDelExtracto(cuenta: string | null) {
  if (!cuenta) return null;
  const datos = (await pool.query(`SELECT x.caja_id, x.tipo, x.banco, x.numero, x.telefono, c.nombre FROM cajas_datos_banco x JOIN cajas c ON c.id = x.caja_id WHERE c.activo AND c.tipo = 'BANCO'`)).rows;
  const cajas = [...new Map(datos.filter((d) => coincideDato(cuenta, d)).map((d) => [d.caja_id as number, d])).values()];
  return cajas.length === 1 ? { id: cajas[0]!.caja_id as number, nombre: cajas[0]!.nombre as string } : null;
}

/**
 * Lo que va a pasar al cargar el estado de cuenta, sin tocar nada: de qué cuenta es, cuántos renglones son nuevos,
 * cuáles ya están en el libro (y con qué) y si los saldos cuadran.
 */
export async function revisarExtracto(texto: string, cajaIdElegida?: number) {
  if (!(await libroListo())) throw sinLibro();
  const e = leerExtracto(texto);
  if (!e.renglones.length) throw err("No encontré movimientos en el archivo. ¿Es el estado de cuenta del banco (con referencia, fecha, débito, crédito y saldo)?", 400);
  const deLaCuenta = await cuentaDelExtracto(e.cuenta);
  if (cajaIdElegida && deLaCuenta && deLaCuenta.id !== cajaIdElegida)
    throw err(`Este estado de cuenta es de la cuenta ${e.cuenta} ("${deLaCuenta.nombre}"), no de la que elegiste`, 409);
  const cajaId = cajaIdElegida ?? deLaCuenta?.id;
  if (!cajaId) throw err(`No sé a qué cuenta es: la cuenta ${e.cuenta ?? "del archivo"} no está registrada. Cargala en "Cuenta y pago móvil" o abrí el estado de cuenta desde esa cuenta.`, 409);
  const caja = (await pool.query(`SELECT c.id, c.nombre, COALESCE(m.codigo, 'COP') AS moneda FROM cajas c LEFT JOIN monedas m ON m.id = c.moneda_id WHERE c.id = $1 AND c.tipo = 'BANCO'`, [cajaId])).rows[0];
  if (!caja) throw err("Esa cuenta de banco no existe", 404);
  // los últimos 4 dígitos de la cuenta registrada, para avisar si el archivo dice otra
  const registrada = (await pool.query(`SELECT numero FROM cajas_datos_banco WHERE caja_id = $1 AND tipo = 'CUENTA'`, [cajaId])).rows.map((x) => String(x.numero));
  const otraCuenta = !!e.cuenta && registrada.length > 0 && !registrada.some((n) => n.slice(-4) === soloDigitos(e.cuenta).slice(-4));
  if (otraCuenta) throw err(`Este estado de cuenta es de la cuenta terminada en ${soloDigitos(e.cuenta).slice(-4)}, y "${caja.nombre}" está registrada con ${registrada.map((n) => `…${n.slice(-4)}`).join(", ")}`, 409);

  const renglones = [];
  for (const r of e.renglones) {
    const ya = (
      await pool.query(`SELECT id, movimiento_caja_id FROM banco_extracto_lineas WHERE caja_id = $1 AND referencia = $2 AND fecha = $3 AND tipo = $4 AND monto = $5::numeric`, [cajaId, r.referencia, r.fecha, r.tipo, r.monto])
    ).rows[0];
    const enLibro = ya ? null : await buscarEnLibro(pool, cajaId, r);
    renglones.push({ ...r, estado: ya ? ("cargado" as const) : enLibro ? ("en_libro" as const) : ("nuevo" as const) });
  }
  const saldo = (await pool.query(`SELECT s.monto FROM saldos_caja s JOIN monedas m ON m.id = s.moneda_id WHERE s.caja_id = $1 AND m.codigo = $2`, [cajaId, caja.moneda])).rows[0]?.monto ?? "0";
  return {
    caja: { id: caja.id as number, nombre: caja.nombre as string, moneda: caja.moneda as string, saldo: String(saldo) },
    cuenta: e.cuenta,
    desde: e.desde,
    hasta: e.hasta,
    saldoInicial: e.saldoInicial,
    saldoFinal: e.saldoFinal,
    totalCreditos: e.totalCreditos,
    totalDebitos: e.totalDebitos,
    descuadres: e.descuadres,
    renglones,
    nuevos: renglones.filter((r) => r.estado === "nuevo").length,
    enLibro: renglones.filter((r) => r.estado === "en_libro").length,
    cargados: renglones.filter((r) => r.estado === "cargado").length,
  };
}

/**
 * Carga el estado de cuenta: guarda sus renglones (los repetidos no entran dos veces), concilia con el libro lo que ya
 * estaba (una confirmación con su referencia, un pago) y anota en la cuenta lo que faltaba, con su referencia y su
 * fecha. Todo junto o nada.
 */
export async function cargarExtracto(texto: string, archivo: string, cajaIdElegida: number | undefined, usuarioId: number) {
  const revision = await revisarExtracto(texto, cajaIdElegida);
  if (revision.descuadres.length) throw err(`El archivo no cuadra en ${revision.descuadres.length} renglón(es) (el saldo no coincide con el anterior): no se cargó nada para no meter montos mal leídos.`, 409);
  const cajaId = revision.caja.id;
  const client = await pool.connect();
  let nuevos = 0;
  let conciliados = 0;
  try {
    await client.query("BEGIN");
    const moneda = (await client.query(`SELECT id FROM monedas WHERE codigo = $1`, [revision.caja.moneda])).rows[0].id as number;
    const ext = await client.query(
      `INSERT INTO banco_extractos (caja_id, cuenta, desde, hasta, saldo_inicial, saldo_final, archivo, usuario_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [cajaId, revision.cuenta, revision.desde, revision.hasta, revision.saldoInicial, revision.saldoFinal, archivo.slice(0, 200), usuarioId]
    );
    for (const r of revision.renglones) {
      if (r.estado === "cargado") continue;
      const linea = await client.query(
        `INSERT INTO banco_extracto_lineas (extracto_id, caja_id, referencia, fecha, descripcion, tipo, monto, saldo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (caja_id, referencia, fecha, tipo, monto) DO NOTHING RETURNING id`,
        [ext.rows[0].id, cajaId, r.referencia, r.fecha, r.descripcion.slice(0, 300), r.tipo, r.monto, r.saldo]
      );
      if (!linea.rows[0]) continue;
      // ya estaba en el libro (una confirmación, un pago): se concilia sin mover el saldo
      const enLibro = await buscarEnLibro(client, cajaId, r);
      if (enLibro) {
        await client.query(`UPDATE banco_extracto_lineas SET movimiento_caja_id = $1 WHERE id = $2`, [enLibro, linea.rows[0].id]);
        await client.query(`UPDATE movimientos_caja SET referencia = COALESCE(referencia, $1), fecha_banco = COALESCE(fecha_banco, $2) WHERE id = $3`, [r.referencia, r.fecha, enLibro]);
        conciliados++;
        continue;
      }
      // no estaba: se anota en la cuenta con la referencia y la fecha del banco
      const fila =
        (await client.query(`SELECT id, monto FROM saldos_caja WHERE caja_id = $1 AND moneda_id = $2 FOR UPDATE`, [cajaId, moneda])).rows[0] ??
        (await client.query(`INSERT INTO saldos_caja (caja_id, moneda_id, monto) VALUES ($1, $2, 0) RETURNING id, monto`, [cajaId, moneda])).rows[0];
      const antes = Number(fila.monto);
      const delta = r.tipo === "NC" ? Number(r.monto) : -Number(r.monto);
      const despues = Math.round((antes + delta) * 10000) / 10000;
      const mov = await client.query(
        `INSERT INTO movimientos_caja (caja_id, moneda_id, tipo, monto, saldo_anterior, saldo_nuevo, usuario_id, observacion, referencia, fecha_banco, de_extracto)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) RETURNING id`,
        [cajaId, moneda, r.tipo === "NC" ? "INGRESO" : "EGRESO", r.monto, antes.toFixed(4), despues.toFixed(4), usuarioId, `Estado de cuenta: ${r.descripcion}`.slice(0, 200), r.referencia, r.fecha]
      );
      await client.query(`UPDATE saldos_caja SET monto = $1 WHERE id = $2`, [despues.toFixed(4), fila.id]);
      await client.query(`UPDATE banco_extracto_lineas SET movimiento_caja_id = $1 WHERE id = $2`, [mov.rows[0].id, linea.rows[0].id]);
      nuevos++;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  const saldo = (await pool.query(`SELECT s.monto FROM saldos_caja s JOIN monedas m ON m.id = s.moneda_id WHERE s.caja_id = $1 AND m.codigo = $2`, [cajaId, revision.caja.moneda])).rows[0]?.monto ?? "0";
  return { cuenta: revision.caja.nombre, nuevos, conciliados, yaCargados: revision.cargados, saldoSistema: String(saldo), saldoFinalExtracto: revision.saldoFinal, hasta: revision.hasta };
}

// ---------------------------------------------------------------- confirmaciones

/**
 * Antes de anotar en una cuenta de banco lo que dice un capture de Confirmaciones:
 *  - si la referencia ya entró en esa cuenta para otra confirmación que sigue vigente, no se deja (referencia protegida);
 *  - si esa plata ya está en el libro porque vino en un estado de cuenta (mismo sentido y monto, misma referencia o el
 *    único de esos días, todavía sin cliente), se devuelve ese movimiento para enlazarlo sin sumar dos veces.
 */
export async function revisarReferenciaEnBanco(db: Db, d: { cajaId: number; referencia: string | null; tipo: "INGRESO" | "EGRESO"; monto: string }) {
  if (!(await libroListo())) return { enlazarCon: null as number | null };
  const ref = soloDigitos(d.referencia);
  if (ref.length >= 6) {
    const usada = (
      await db.query(
        `SELECT k.id, k.referencia, k.created_at, t.nombre AS cliente
         FROM movimientos_caja k
         JOIN movimientos_cuenta_corriente mc ON mc.movimiento_caja_id = k.id AND NOT mc.anulado AND mc.reverso_de_id IS NULL
         JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id JOIN terceros t ON t.id = cc.tercero_id
         WHERE k.caja_id = $1 AND k.referencia IS NOT NULL AND right(regexp_replace(k.referencia, '\\D', '', 'g'), 8) = right($2, 8)`,
        [d.cajaId, ref]
      )
    ).rows[0];
    if (usada) {
      const dia = new Date(usada.created_at).toLocaleDateString("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "2-digit" });
      throw err(`La referencia ${d.referencia} ya entró en esta cuenta para ${usada.cliente} (${dia}). Una referencia no se registra dos veces.`, 409);
    }
  }
  // lo que vino en un estado de cuenta y todavía no tiene cliente
  const candidatos = (
    await db.query(
      `SELECT k.id, k.referencia FROM movimientos_caja k
       WHERE k.caja_id = $1 AND k.de_extracto AND k.tipo = $2 AND k.monto = $3::numeric
         AND k.fecha_banco BETWEEN (now() AT TIME ZONE 'America/Bogota')::date - 3 AND (now() AT TIME ZONE 'America/Bogota')::date
         AND NOT EXISTS (SELECT 1 FROM movimientos_cuenta_corriente mc WHERE mc.movimiento_caja_id = k.id AND NOT mc.anulado)`,
      [d.cajaId, d.tipo, d.monto]
    )
  ).rows as { id: number; referencia: string | null }[];
  const porRef = candidatos.find((c) => mismaReferencia(c.referencia, d.referencia));
  return { enlazarCon: porRef?.id ?? (candidatos.length === 1 ? candidatos[0]!.id : null) };
}

// ---------------------------------------------------------------- el libro

export async function libroBanco(cajaId: number, f: { desde?: string; hasta?: string; buscar?: string }) {
  if (!(await libroListo())) throw sinLibro();
  const caja = (await pool.query(`SELECT c.id, c.nombre, COALESCE(m.codigo, 'COP') AS moneda FROM cajas c LEFT JOIN monedas m ON m.id = c.moneda_id WHERE c.id = $1 AND c.tipo = 'BANCO'`, [cajaId])).rows[0];
  if (!caja) throw err("Esa cuenta de banco no existe", 404);
  const valores: unknown[] = [cajaId];
  const cond = [`k.caja_id = $1`];
  const dia = `COALESCE(k.fecha_banco, (k.created_at AT TIME ZONE 'America/Bogota')::date)`;
  if (f.desde) {
    valores.push(f.desde);
    cond.push(`${dia} >= $${valores.length}::date`);
  }
  if (f.hasta) {
    valores.push(f.hasta);
    cond.push(`${dia} <= $${valores.length}::date`);
  }
  if (f.buscar?.trim()) {
    valores.push(`%${f.buscar.trim()}%`);
    const p = `$${valores.length}`;
    cond.push(`(k.referencia ILIKE ${p} OR k.observacion ILIKE ${p} OR u.nombre ILIKE ${p} OR t.nombre ILIKE ${p} OR mc.descripcion ILIKE ${p} OR x.descripcion ILIKE ${p})`);
  }
  const r = await pool.query(
    `SELECT k.id, k.tipo, k.monto, k.saldo_nuevo, k.observacion, k.referencia, k.de_extracto, to_char(${dia}, 'YYYY-MM-DD') AS dia, k.created_at,
            u.nombre AS usuario, t.nombre AS cliente, mc.id AS movimiento_id, mc.descripcion AS detalle_cliente, mc.anulado,
            x.id IS NOT NULL AS en_extracto, x.descripcion AS detalle_banco
     FROM movimientos_caja k
     LEFT JOIN usuarios u ON u.id = k.usuario_id
     LEFT JOIN LATERAL (SELECT * FROM movimientos_cuenta_corriente m2 WHERE m2.movimiento_caja_id = k.id ORDER BY m2.id LIMIT 1) mc ON true
     LEFT JOIN cuentas_corrientes cc ON cc.id = mc.cuenta_corriente_id
     LEFT JOIN terceros t ON t.id = cc.tercero_id
     LEFT JOIN banco_extracto_lineas x ON x.movimiento_caja_id = k.id
     WHERE ${cond.join(" AND ")}
     ORDER BY ${dia} DESC, k.id DESC LIMIT 1000`,
    valores
  );
  const filas = r.rows;
  const entra = filas.filter((x) => x.tipo === "INGRESO").reduce((s, x) => s + Number(x.monto), 0);
  const sale = filas.filter((x) => x.tipo === "EGRESO").reduce((s, x) => s + Number(x.monto), 0);
  // el último estado de cuenta cargado: lo del libro en esas fechas que no aparece en el banco se marca
  const ultimo = (await pool.query(`SELECT to_char(desde, 'YYYY-MM-DD') AS desde, to_char(hasta, 'YYYY-MM-DD') AS hasta, saldo_final, created_at FROM banco_extractos WHERE caja_id = $1 ORDER BY hasta DESC NULLS LAST, id DESC LIMIT 1`, [cajaId])).rows[0] ?? null;
  const saldo = (await pool.query(`SELECT s.monto FROM saldos_caja s JOIN monedas m ON m.id = s.moneda_id WHERE s.caja_id = $1 AND m.codigo = $2`, [cajaId, caja.moneda])).rows[0]?.monto ?? "0";
  return {
    caja: { id: caja.id as number, nombre: caja.nombre as string, moneda: caja.moneda as string, saldo: String(saldo) },
    filas,
    totales: { entra: dos(entra), sale: dos(sale), cantidad: filas.length },
    ultimoExtracto: ultimo,
  };
}
