import { generateMessageIDV2 } from "@whiskeysockets/baileys";
import { pool } from "../../db/pool";
import { leerConfig } from "./config";
import { actualizarEstadoMensaje, guardarMensaje, marcarErrorMensaje, obtenerChat, vistaPrevia, type Autor, type FilaMensaje, type TipoMensaje } from "./mensajes";
import { LINEAS, jidReal, lineaDeClave, nombreDeLinea, sqlDeLinea, telefonoDeJid, transporte, type CitaSalida, type ContenidoSalida, type Linea } from "./transporte";

// UNA sola puerta de salida para todo lo que se envía por WhatsApp. Todo pasa por acá: lo que escribe una persona
// en el panel o en la burbuja, los avisos de las confirmaciones y el bot. Acá viven las protecciones para que Meta
// no bloquee los teléfonos vinculados. Los topes se llevan por línea: a Meta le importa cada número por separado.
//
// Antes de aceptar un mensaje:
//  - Cliente que YA escribió (conversación abierta por él): se le responde con normalidad.
//  - Cliente que NUNCA escribió a esa línea: se le manda UN solo mensaje. Hasta que conteste no sale otro.
//    Antes de ese primer mensaje se verifica que el número tenga WhatsApp.
//  - El mismo texto a varios clientes que nunca escribieron, seguidos: se corta (es lo que parece difusión).
//  - Una ráfaga exagerada al mismo chat: se corta.
// Al enviar:
//  - tope por minuto (si se llena, ESPERA) y tope por día (falla con un mensaje claro)
//  - pausas aleatorias entre mensajes y "escribiendo…" antes de los que no escribe una persona
//  - lo que escribe una persona pasa delante de los avisos automáticos

export class ErrorEnvio extends Error {
  status = 409;
  /** El cliente todavía no respondió: no es un error para reintentar, hay que esperar a que escriba. */
  esperaCliente = false;
}

function rechazo(mensaje: string, esperaCliente = false) {
  const e = new ErrorEnvio(mensaje);
  e.esperaCliente = esperaCliente;
  return e;
}

interface Trabajo {
  jid: string;
  linea: Linea;
  contenido: ContenidoSalida;
  cita?: CitaSalida;
  waId: string;
  prioridad: number; // 0 = persona, 1 = bot/sistema
  orden: number;
  resolve: () => void;
  reject: (e: Error) => void;
}

const cola: Trabajo[] = [];
let procesando = false;
let contadorOrden = 0;

// Ritmo de cada línea
interface Ritmo {
  ultimoMinuto: number[];
  ultimoEnvio: number;
  dia: { fecha: string; n: number };
}
const ritmos = new Map<Linea, Ritmo>(LINEAS.map((l) => [l.id, { ultimoMinuto: [], ultimoEnvio: 0, dia: { fecha: "", n: 0 } }]));
const ritmo = (linea: Linea) => ritmos.get(linea)!;

// Para detectar difusión y ráfagas (en memoria: alcanza con lo de los últimos minutos)
const RAFAGA_POR_CHAT = 15; // mensajes al mismo chat en un minuto
const IGUALES_A_FRIOS = 3; // mismo texto a clientes que nunca escribieron...
const VENTANA_IGUALES_MS = 30 * 60_000; // ...en media hora
const enviosPorChat = new Map<string, number[]>();
const textosAFrios = new Map<string, { jid: string; en: number }[]>();

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const azar = (min: number, max: number) => min + Math.random() * Math.max(0, max - min);
const normalizar = (texto: string) => texto.toLowerCase().replace(/\s+/g, " ").trim();

async function enviadosHoy(linea: Linea, zona: string) {
  const r = ritmo(linea);
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: zona }).format(new Date());
  if (r.dia.fecha !== hoy) {
    const q = await pool.query(
      `SELECT count(*)::int AS n FROM wa_mensajes
       WHERE de_mi AND NOT interno AND autor <> 'telefono' AND estado <> 'error'
         AND ${sqlDeLinea("jid", linea)}
         AND (created_at AT TIME ZONE $1)::date = $2::date`,
      [zona, hoy]
    );
    r.dia = { fecha: hoy, n: q.rows[0].n };
  }
  return r.dia;
}

async function procesarCola() {
  if (procesando) return;
  procesando = true;
  try {
    while (cola.length > 0) {
      cola.sort((a, b) => a.prioridad - b.prioridad || a.orden - b.orden);
      const t = cola.shift()!;
      try {
        await enviarAhora(t);
        t.resolve();
      } catch (err) {
        await marcarErrorMensaje(t.waId, (err as Error).message);
        t.reject(err as Error);
      }
    }
  } finally {
    procesando = false;
  }
}

async function enviarAhora(t: Trabajo) {
  const config = await leerConfig();
  const ab = config.antibloqueo;
  const r = ritmo(t.linea);

  const dia = await enviadosHoy(t.linea, config.negocio.zonaHoraria);
  if (dia.n >= ab.porDia) {
    throw rechazo(`La línea ${nombreDeLinea(t.linea)} alcanzó el tope diario de ${ab.porDia} mensajes. Se puede subir en Bot e IA > Anti-bloqueo.`);
  }

  // Tope por minuto: esperar a que se libere un lugar
  for (;;) {
    const ahora = Date.now();
    while (r.ultimoMinuto.length && ahora - r.ultimoMinuto[0]! > 60_000) r.ultimoMinuto.shift();
    if (r.ultimoMinuto.length < ab.porMinuto) break;
    await esperar(60_000 - (ahora - r.ultimoMinuto[0]!) + 50);
  }

  // Pausa aleatoria desde el envío anterior de esa línea (las personas esperan menos)
  const pausa = t.prioridad === 0 ? azar(300, 900) : azar(ab.pausaMinMs, ab.pausaMaxMs);
  const falta = r.ultimoEnvio + pausa - Date.now();
  if (falta > 0) await esperar(falta);

  const tr = transporte(t.linea);
  if (!tr.conectado()) throw rechazo(`La línea ${nombreDeLinea(t.linea)} no está conectada`);

  // Lo automático "escribe" un momento antes de enviar, como una persona (lo de una persona ya tardó en teclearse)
  if (t.prioridad !== 0) {
    const largo = "texto" in t.contenido && !("sticker" in t.contenido) ? (t.contenido.texto?.length ?? 0) : 40;
    await tr.presencia(t.jid, "composing").catch(() => {});
    await esperar(Math.min(4_000, 700 + largo * 18 + azar(0, 600)));
    await tr.presencia(t.jid, "paused").catch(() => {});
  }

  const key = await tr.enviar(t.jid, t.contenido, t.waId, t.cita);
  r.ultimoEnvio = Date.now();
  r.ultimoMinuto.push(r.ultimoEnvio);
  dia.n++;
  await actualizarEstadoMensaje(key?.id ?? t.waId, "enviado");
}

/**
 * Las reglas que se revisan ANTES de aceptar el mensaje. Si no pasa, no se guarda ni se intenta enviar.
 * Devuelve si el contacto es "frío" (nunca le escribió a esa línea).
 */
async function revisarProteccion(op: OpcionesEnvio, linea: Linea): Promise<{ frio: boolean }> {
  const ahora = Date.now();

  // Ráfaga al mismo chat
  const delChat = (enviosPorChat.get(op.jid) ?? []).filter((t) => ahora - t < 60_000);
  if (delChat.length >= RAFAGA_POR_CHAT) throw rechazo("Demasiados mensajes seguidos a este chat: esperá un momento antes de mandar otro.");

  const chat = await obtenerChat(op.jid);
  const frio = !chat?.ultimo_entrante_en;
  if (!frio) return { frio: false };

  // Nunca nos escribió: un solo mensaje hasta que responda
  const previos = await pool.query(`SELECT count(*)::int AS n FROM wa_mensajes WHERE jid = $1 AND de_mi AND NOT interno AND estado <> 'error'`, [op.jid]);
  if (previos.rows[0].n > 0) {
    throw rechazo(
      "A este cliente ya se le envió un mensaje y todavía no respondió. Para cuidar el número no se le escribe otra vez hasta que conteste: cuando escriba, se le responde sin límite.",
      true
    );
  }

  // El mismo texto a varios que nunca escribieron: eso es lo que WhatsApp toma por difusión
  const texto = normalizar(op.texto ?? "");
  if (texto.length >= 12) {
    const iguales = (textosAFrios.get(texto) ?? []).filter((x) => ahora - x.en < VENTANA_IGUALES_MS);
    const otros = new Set(iguales.map((x) => x.jid).filter((j) => j !== op.jid));
    if (otros.size >= IGUALES_A_FRIOS) {
      throw rechazo("Ese mismo mensaje ya se le mandó a varios clientes que nunca escribieron. Para que WhatsApp no lo tome como difusión, cambiá el texto o esperá un rato.");
    }
  }

  // Que el número exista antes de escribirle (escribirle a números sin WhatsApp también cuenta en contra)
  let existe: string | null;
  try {
    existe = await transporte(linea).existe(telefonoDeJid(op.jid));
  } catch {
    throw rechazo("No se pudo comprobar si ese número tiene WhatsApp. Probá de nuevo en un momento.");
  }
  if (!existe) throw Object.assign(rechazo("Ese número no tiene WhatsApp."), { status: 400 });
  return { frio: true };
}

function anotarEnvio(op: OpcionesEnvio, frio: boolean) {
  const ahora = Date.now();
  enviosPorChat.set(op.jid, [...(enviosPorChat.get(op.jid) ?? []).filter((t) => ahora - t < 60_000), ahora]);
  if (frio) {
    const texto = normalizar(op.texto ?? "");
    if (texto.length >= 12) textosAFrios.set(texto, [...(textosAFrios.get(texto) ?? []).filter((x) => ahora - x.en < VENTANA_IGUALES_MS), { jid: op.jid, en: ahora }]);
  }
  // limpieza ocasional para que los mapas no crezcan sin fin
  if (enviosPorChat.size > 2_000) for (const [k, v] of enviosPorChat) if (!v.some((t) => ahora - t < 60_000)) enviosPorChat.delete(k);
  if (textosAFrios.size > 500) for (const [k, v] of textosAFrios) if (!v.some((x) => ahora - x.en < VENTANA_IGUALES_MS)) textosAFrios.delete(k);
}

export interface OpcionesEnvio {
  /** La clave del chat: dice a quién y por cuál línea sale */
  jid: string;
  autor: Exclude<Autor, "cliente" | "telefono">;
  texto?: string;
  imagen?: { buffer: Buffer; mime: string; mediaKey?: string | null };
  /** Un sticker (WebP de 512x512). Va solo, sin texto. */
  sticker?: { buffer: Buffer; mediaKey?: string | null };
  /** id (de wa_mensajes) del mensaje de este chat al que se responde: sale citado */
  respondeA?: string | null;
  usuarioId?: number | null;
  turnoHasta?: string | null;
  /** false = devuelve apenas queda en cola (el panel ve el ✓ por SSE) */
  esperarEnvio?: boolean;
}

/**
 * Guarda el mensaje como "pendiente" ANTES de enviarlo, con el ID que después se le pasa
 * a Baileys: así el eco que llega por messages.upsert no se duplica.
 * Resuelve cuando salió (o rechaza con el motivo).
 */
export async function enviarMensaje(op: OpcionesEnvio): Promise<FilaMensaje> {
  const linea = lineaDeClave(op.jid);
  const tr = transporte(linea);
  if (!tr.conectado()) throw Object.assign(new Error(`La línea ${nombreDeLinea(linea)} de WhatsApp no está conectada`), { status: 503 });

  const { frio } = await revisarProteccion(op, linea);

  // El mensaje al que se responde tiene que ser de esta misma conversación y haber pasado por WhatsApp
  let cita: CitaSalida | undefined;
  let respondeA: string | null = null;
  if (op.respondeA) {
    const q = await pool.query(`SELECT id, wa_id, wa_key, de_mi, tipo, texto FROM wa_mensajes WHERE id = $1 AND jid = $2 AND NOT interno`, [op.respondeA, op.jid]);
    const original = q.rows[0];
    if (original?.wa_id) {
      respondeA = String(original.id);
      const guardada = (original.wa_key ?? {}) as { participant?: string };
      cita = {
        key: { remoteJid: jidReal(op.jid), fromMe: original.de_mi, id: original.wa_id, participant: guardada.participant },
        texto: vistaPrevia(original.tipo, original.texto) || "Mensaje",
      };
    }
  }

  const waId = generateMessageIDV2(tr.miJid() ?? undefined);
  const tipo: TipoMensaje = op.sticker ? "sticker" : op.imagen ? "imagen" : "texto";

  const fila = await guardarMensaje({
    jid: op.jid,
    waId,
    waKey: { remoteJid: op.jid.split("#")[0], fromMe: true, id: waId },
    deMi: true,
    autor: op.autor,
    tipo,
    texto: op.sticker ? null : (op.texto ?? null),
    mediaKey: op.sticker?.mediaKey ?? op.imagen?.mediaKey ?? null,
    mediaMime: op.sticker ? "image/webp" : (op.imagen?.mime ?? null),
    mediaBytes: op.sticker?.buffer.length ?? op.imagen?.buffer.length ?? null,
    estado: "pendiente",
    usuarioId: op.usuarioId ?? null,
    turnoHasta: op.turnoHasta ?? null,
    respondeA,
  });
  if (!fila) throw new Error("No se pudo registrar el mensaje");
  anotarEnvio(op, frio);

  const contenido: ContenidoSalida = op.sticker
    ? { sticker: op.sticker.buffer }
    : op.imagen
      ? { imagen: op.imagen.buffer, mime: op.imagen.mime, texto: op.texto }
      : { texto: op.texto ?? "" };

  const enviado = new Promise<void>((resolve, reject) => {
    cola.push({ jid: op.jid, linea, contenido, cita, waId, prioridad: op.autor === "humano" ? 0 : 1, orden: contadorOrden++, resolve, reject });
    void procesarCola();
  });
  if (op.esperarEnvio === false) {
    enviado.catch((e) => console.warn(`[wa] no salió un mensaje a ${op.jid}: ${(e as Error).message}`));
    return fila;
  }
  await enviado;
  return { ...fila, estado: "enviado" };
}

/** Para pruebas y para el estado del panel. */
export function estadoCola(linea: Linea = 1) {
  const r = ritmo(linea);
  return { enCola: cola.filter((t) => t.linea === linea).length, enviadosUltimoMinuto: r.ultimoMinuto.length, enviadosHoy: r.dia.n };
}
