import { generateMessageIDV2 } from "@whiskeysockets/baileys";
import { pool } from "../../db/pool";
import { leerConfig } from "./config";
import { actualizarEstadoMensaje, guardarMensaje, marcarErrorMensaje, type Autor, type FilaMensaje, type TipoMensaje } from "./mensajes";
import { transporte, type ContenidoSalida } from "./transporte";

// UNA sola cola de envío para todo lo que sale por WhatsApp (anti-bloqueo):
// - tope por minuto: si se llena, ESPERA
// - tope por día: falla con un mensaje claro
// - pausas aleatorias entre mensajes
// - lo que escribe una persona pasa delante del bot

export class ErrorEnvio extends Error {
  status = 409;
}

interface Trabajo {
  jid: string;
  contenido: ContenidoSalida;
  waId: string;
  prioridad: number; // 0 = persona, 1 = bot/sistema
  orden: number;
  resolve: () => void;
  reject: (e: Error) => void;
}

const cola: Trabajo[] = [];
let procesando = false;
let contadorOrden = 0;
const enviosUltimoMinuto: number[] = [];
let ultimoEnvio = 0;
const conteoDia = { fecha: "", n: 0 };

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const azar = (min: number, max: number) => min + Math.random() * Math.max(0, max - min);

async function enviadosHoy(zona: string) {
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: zona }).format(new Date());
  if (conteoDia.fecha !== hoy) {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM wa_mensajes
       WHERE de_mi AND NOT interno AND autor <> 'telefono' AND estado <> 'error'
         AND (created_at AT TIME ZONE $1)::date = $2::date`,
      [zona, hoy]
    );
    conteoDia.fecha = hoy;
    conteoDia.n = r.rows[0].n;
  }
  return conteoDia;
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

  const dia = await enviadosHoy(config.negocio.zonaHoraria);
  if (dia.n >= ab.porDia) {
    throw new ErrorEnvio(`Se alcanzó el tope diario de ${ab.porDia} mensajes. Se puede subir en Configuración > Anti-bloqueo.`);
  }

  // Tope por minuto: esperar a que se libere un lugar
  for (;;) {
    const ahora = Date.now();
    while (enviosUltimoMinuto.length && ahora - enviosUltimoMinuto[0]! > 60_000) enviosUltimoMinuto.shift();
    if (enviosUltimoMinuto.length < ab.porMinuto) break;
    await esperar(60_000 - (ahora - enviosUltimoMinuto[0]!) + 50);
  }

  // Pausa aleatoria desde el envío anterior (las personas esperan menos)
  const pausa = t.prioridad === 0 ? azar(300, 900) : azar(ab.pausaMinMs, ab.pausaMaxMs);
  const falta = ultimoEnvio + pausa - Date.now();
  if (falta > 0) await esperar(falta);

  const tr = transporte();
  if (!tr.conectado()) throw new ErrorEnvio("WhatsApp no está conectado");
  const key = await tr.enviar(t.jid, t.contenido, t.waId);
  ultimoEnvio = Date.now();
  enviosUltimoMinuto.push(ultimoEnvio);
  dia.n++;
  await actualizarEstadoMensaje(key?.id ?? t.waId, "enviado");
}

export interface OpcionesEnvio {
  jid: string;
  autor: Exclude<Autor, "cliente" | "telefono">;
  texto?: string;
  imagen?: { buffer: Buffer; mime: string; mediaKey?: string | null };
  usuarioId?: number | null;
  /** false = devuelve apenas queda en cola (el panel ve el ✓ por SSE) */
  esperarEnvio?: boolean;
}

/**
 * Guarda el mensaje como "pendiente" ANTES de enviarlo, con el ID que después se le pasa
 * a Baileys: así el eco que llega por messages.upsert no se duplica.
 * Resuelve cuando salió (o rechaza con el motivo).
 */
export async function enviarMensaje(op: OpcionesEnvio): Promise<FilaMensaje> {
  const tr = transporte();
  if (!tr.conectado()) throw Object.assign(new Error("WhatsApp no está conectado"), { status: 503 });
  const waId = generateMessageIDV2(tr.miJid() ?? undefined);
  const tipo: TipoMensaje = op.imagen ? "imagen" : "texto";

  const fila = await guardarMensaje({
    jid: op.jid,
    waId,
    waKey: { remoteJid: op.jid, fromMe: true, id: waId },
    deMi: true,
    autor: op.autor,
    tipo,
    texto: op.texto ?? null,
    mediaKey: op.imagen?.mediaKey ?? null,
    mediaMime: op.imagen?.mime ?? null,
    mediaBytes: op.imagen?.buffer.length ?? null,
    estado: "pendiente",
    usuarioId: op.usuarioId ?? null,
  });
  if (!fila) throw new Error("No se pudo registrar el mensaje");

  const contenido: ContenidoSalida = op.imagen
    ? { imagen: op.imagen.buffer, mime: op.imagen.mime, texto: op.texto }
    : { texto: op.texto ?? "" };

  const enviado = new Promise<void>((resolve, reject) => {
    cola.push({ jid: op.jid, contenido, waId, prioridad: op.autor === "humano" ? 0 : 1, orden: contadorOrden++, resolve, reject });
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
export function estadoCola() {
  return { enCola: cola.length, enviadosUltimoMinuto: enviosUltimoMinuto.length, enviadosHoy: conteoDia.n };
}
