import {
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  normalizeMessageContent,
  type WAMessage,
  type WAMessageUpdate,
} from "@whiskeysockets/baileys";
import { randomUUID } from "crypto";
import { pool } from "../../db/pool";
import { subirArchivo } from "../almacenamiento.service";
import { leerConfig } from "./config";
import { jidCanonico } from "./conexion";
import { actualizarChat, actualizarEstadoMensaje, asegurarChat, guardarMensaje, notaInterna, obtenerChat, type EstadoMensaje, type TipoMensaje } from "./mensajes";
import { guardarMediaEnMemoria } from "./mediaMemoria";
import { claveDeChat, transporte, telefonoDeJid, type Linea } from "./transporte";
import { esJidDelDueno, procesarMensajeDueno } from "./dueno";
import { marcarNecesitaHumano } from "./atencion";
import { encolarTurno } from "./bot";
import { liberarEsperasDeChat, vincularCodigoTransaccion } from "./outbox";

// Todo lo que entra por messages.upsert: lo del cliente ("notify"), el historial que
// sincroniza WhatsApp al vincular ("append"), lo que se escribe desde el teléfono y el
// eco de lo que enviamos nosotros (que ya está guardado: no se duplica).

const IGNORAR = new Set([
  "protocolMessage",
  "reactionMessage",
  "senderKeyDistributionMessage",
  "pollUpdateMessage",
  "keepInChatMessage",
  "messageContextInfo",
]);

interface Parseado {
  tipo: TipoMensaje;
  texto: string | null;
  mime: string | null;
  conMedia: boolean;
}

function parsear(contenido: NonNullable<WAMessage["message"]>): Parseado | null {
  const tipoWa = getContentType(contenido);
  if (!tipoWa || IGNORAR.has(tipoWa)) return null;
  const c = contenido;
  switch (tipoWa) {
    case "conversation":
      return { tipo: "texto", texto: c.conversation ?? "", mime: null, conMedia: false };
    case "extendedTextMessage":
      return { tipo: "texto", texto: c.extendedTextMessage?.text ?? "", mime: null, conMedia: false };
    case "imageMessage":
      return { tipo: "imagen", texto: c.imageMessage?.caption || null, mime: c.imageMessage?.mimetype ?? "image/jpeg", conMedia: true };
    case "audioMessage":
      return { tipo: "audio", texto: null, mime: (c.audioMessage?.mimetype ?? "audio/ogg").split(";")[0]!, conMedia: true };
    case "videoMessage":
      return { tipo: "video", texto: c.videoMessage?.caption || null, mime: c.videoMessage?.mimetype ?? "video/mp4", conMedia: true };
    case "documentMessage":
      return {
        tipo: "documento",
        texto: c.documentMessage?.caption || c.documentMessage?.fileName || "Documento",
        mime: c.documentMessage?.mimetype ?? "application/octet-stream",
        conMedia: true,
      };
    case "stickerMessage":
      return { tipo: "sticker", texto: null, mime: c.stickerMessage?.mimetype ?? "image/webp", conMedia: true };
    case "locationMessage":
      return {
        tipo: "texto",
        texto: `📍 Ubicación: ${c.locationMessage?.degreesLatitude}, ${c.locationMessage?.degreesLongitude}`,
        mime: null,
        conMedia: false,
      };
    case "contactMessage":
      return { tipo: "texto", texto: `👤 Contacto: ${c.contactMessage?.displayName ?? ""}`, mime: null, conMedia: false };
    default:
      return { tipo: "texto", texto: `[${tipoWa}]`, mime: null, conMedia: false };
  }
}

/** Descarga el adjunto y lo sube a Cloudinary. Nunca se guarda base64 en la base. */
async function subirMedia(msg: WAMessage, jid: string, mime: string, linea: Linea) {
  try {
    const buffer = await transporte(linea).descargar(msg);
    const key = await subirArchivo(`whatsapp/${telefonoDeJid(jid)}`, randomUUID(), buffer, mime);
    return { buffer, key };
  } catch (err) {
    console.error("[wa] no se pudo guardar el adjunto", (err as Error).message);
    return null;
  }
}

function fechaDe(msg: WAMessage) {
  const ts = Number(msg.messageTimestamp ?? 0);
  return ts > 0 ? new Date(ts * 1000) : new Date();
}

/** linea: por cuál de los teléfonos vinculados llegó. Cada línea tiene su propia bandeja de chats. */
export async function procesarEntrantes(mensajes: WAMessage[], tipo: "notify" | "append", linea: Linea = 1) {
  for (const msg of mensajes) {
    try {
      await procesarUno(msg, tipo, linea);
    } catch (err) {
      console.error("[wa] error con un mensaje entrante", err);
    }
  }
}

async function procesarUno(msg: WAMessage, tipoUpsert: "notify" | "append", linea: Linea) {
  const key = msg.key;
  const remoto = key.remoteJid;
  if (!remoto || isJidGroup(remoto) || isJidBroadcast(remoto) || isJidStatusBroadcast(remoto) || isJidNewsletter(remoto)) return;
  const contenido = normalizeMessageContent(msg.message);
  if (!contenido) return;
  const p = parsear(contenido);
  if (!p) return;

  const real = await jidCanonico(remoto, key.remoteJidAlt, linea);
  // la clave del chat lleva la línea: el mismo cliente escribiéndole a dos teléfonos son dos conversaciones
  const jid = claveDeChat(linea, real);
  const deMi = !!key.fromMe;
  const esChatPropio = real === transporte(linea).miJid();

  // Eco de un mensaje nuestro: ya se guardó como "pendiente" con este mismo ID
  if (deMi && key.id) {
    const existe = await pool.query(`SELECT 1 FROM wa_mensajes WHERE wa_id = $1`, [key.id]);
    if (existe.rows.length) return;
  }

  await asegurarChat(jid, deMi ? null : msg.pushName ?? null);

  // ¿Es una respuesta a otro mensaje? WhatsApp manda el id del citado: se busca el nuestro para mostrar la cita
  let respondeA: string | null = null;
  const tipoWa = getContentType(contenido);
  const citadoId = tipoWa ? (contenido[tipoWa] as { contextInfo?: { stanzaId?: string | null } } | null | undefined)?.contextInfo?.stanzaId : null;
  if (citadoId) {
    const q = await pool.query(`SELECT id FROM wa_mensajes WHERE wa_id = $1 AND jid = $2`, [citadoId, jid]);
    respondeA = q.rows[0] ? String(q.rows[0].id) : null;
  }

  let media: { buffer: Buffer; key: string } | null = null;
  if (p.conMedia && p.mime) media = await subirMedia(msg, jid, p.mime, linea);

  const fila = await guardarMensaje({
    jid,
    waId: key.id ?? null,
    waKey: { remoteJid: real, fromMe: deMi, id: key.id, participant: key.participant ?? undefined, lid: remoto !== real ? remoto : undefined },
    deMi,
    autor: deMi ? "telefono" : "cliente",
    tipo: p.tipo,
    texto: p.texto,
    mediaKey: media?.key ?? null,
    mediaMime: media ? p.mime : null,
    mediaBytes: media?.buffer.length ?? null,
    estado: deMi ? "enviado" : "leido",
    fecha: fechaDe(msg),
    cuentaNoLeido: tipoUpsert === "notify" && !deMi,
    respondeA,
  });
  if (!fila) return; // ya estaba guardado
  if (media) guardarMediaEnMemoria(fila.id, media.buffer, p.mime!);

  // El historial sincronizado al vincular solo se guarda
  if (tipoUpsert !== "notify") return;

  // El bot y el asistente del dueño solo existen en la línea 1. Las otras líneas son para leer y responder
  // a mano: lo que entra queda en la bandeja y nada contesta solo.
  const conBot = linea === 1;

  if (deMi) {
    // "Tú": el dueño usa el mismo número del bot y se escribe a sí mismo
    if (esChatPropio) return conBot ? procesarMensajeDueno(jid, p.texto ?? "", fila) : undefined;
    // Alguien respondió desde el teléfono del negocio: toma el control del chat
    const chat = await obtenerChat(jid);
    if (chat?.bot_activo) {
      await actualizarChat(jid, { bot_activo: false, necesita_humano: false, motivo: null });
      await notaInterna(jid, "Respondieron desde el teléfono: el bot quedó en pausa en este chat.");
    }
    return;
  }

  // ---- Mensaje del cliente ----
  await liberarEsperasDeChat(jid);
  if (!conBot) return;
  if (await esJidDelDueno(jid)) return procesarMensajeDueno(jid, p.texto ?? "", fila);
  if (p.texto) await vincularCodigoTransaccion(jid, p.texto);

  // Mensajes viejos que llegan de golpe al reconectar: los atiende una persona
  const config = await leerConfig();
  if (Date.now() - fechaDe(msg).getTime() > config.antibloqueo.viejosMinutos * 60_000) {
    const chat = await obtenerChat(jid);
    if (chat && !chat.necesita_humano) {
      await marcarNecesitaHumano(jid, "escribió mientras el WhatsApp estaba desconectado", { texto: p.texto });
    }
    return;
  }

  encolarTurno(jid);
}

const ESTADOS_WA: Record<number, EstadoMensaje> = { 2: "enviado", 3: "entregado", 4: "leido", 5: "leido" };

/** ✓ / ✓✓ / azul desde messages.update (2 = enviado, 3 = entregado, 4 = leído). Nunca retrocede. */
export async function procesarActualizaciones(updates: WAMessageUpdate[]) {
  for (const { key, update } of updates) {
    if (!key.fromMe || !key.id || update.status == null) continue;
    const estado = ESTADOS_WA[update.status];
    if (estado) await actualizarEstadoMensaje(key.id, estado);
  }
}
