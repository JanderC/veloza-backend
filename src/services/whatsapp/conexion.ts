import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  isLidUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { pool } from "../../db/pool";
import { emitirPanel } from "./eventos";
import { borrarSesion, haySesionGuardada, usarSesionBd } from "./sesionBd";
import { usarTransporte, type Transporte } from "./transporte";
import { procesarActualizaciones, procesarEntrantes } from "./entrantes";

// Ciclo de vida del socket de Baileys:
// - fallas de red: reintento sin límite con espera creciente (máx. 60 s), NUNCA se borra la sesión
// - 515 restartRequired (normal tras vincular): reinicio inmediato
// - 401 loggedOut: se borra la sesión y se genera un QR nuevo
// - 440 connectionReplaced: otra instancia abrió la sesión; no se reconecta solo

export type EstadoConexion = "DESCONECTADO" | "CONECTANDO" | "ESPERANDO_QR" | "CONECTADO" | "REEMPLAZADA";

const logger = pino({ level: process.env.WA_LOG_LEVEL ?? "warn" });

let sock: WASocket | null = null;
let generacion = 0; // cada socket nuevo sube el número; los eventos de sockets viejos se ignoran
let estado: EstadoConexion = "DESCONECTADO";
let qrDataUrl: string | null = null;
let huboQr = false;
let intentos = 0;
let timerReintento: NodeJS.Timeout | null = null;
let ultimoError: string | null = null;
let conectadoDesde: Date | null = null;
let esperandoQr: (() => void)[] = [];

export function estadoConexion() {
  return {
    estado,
    qr: estado === "ESPERANDO_QR" ? qrDataUrl : null,
    numero: sock?.user?.id ? jidNormalizedUser(sock.user.id).split("@")[0] : null,
    nombre: sock?.user?.name ?? null,
    ultimoError,
    conectadoDesde,
  };
}

/** Momento en que abrió la conexión actual: lo anterior que llegue ahora es "viejo". */
export function conectadoDesdeFecha() {
  return conectadoDesde;
}

function cambiarEstado(nuevo: EstadoConexion) {
  estado = nuevo;
  emitirPanel("conexion", estadoConexion());
}

function soltarSocket() {
  if (!sock) return;
  const viejo = sock;
  sock = null;
  usarTransporte(null);
  try {
    viejo.ev.removeAllListeners(undefined as never);
    viejo.end(undefined);
  } catch {
    // ya estaba cerrado
  }
}

/** jid real del chat: en v7 puede llegar como @lid; se guarda siempre como <numero>@s.whatsapp.net. */
export async function jidCanonico(jid: string, alternativo?: string | null): Promise<string> {
  if (!isLidUser(jid)) return jidNormalizedUser(jid);
  if (alternativo && !isLidUser(alternativo)) return jidNormalizedUser(alternativo);
  const pn = await sock?.signalRepository.lidMapping.getPNForLID(jid).catch(() => null);
  return pn ? jidNormalizedUser(pn) : jidNormalizedUser(jid);
}

/** Descarga el adjunto de un mensaje (pide que lo vuelvan a subir si el enlace venció). */
export async function descargarMedia(msg: WAMessage): Promise<Buffer> {
  const s = sock;
  if (!s) throw new Error("WhatsApp no está conectado");
  return downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: s.updateMediaMessage });
}

function crearTransporte(s: WASocket): Transporte {
  return {
    conectado: () => estado === "CONECTADO" && sock === s,
    miJid: () => (s.user?.id ? jidNormalizedUser(s.user.id) : null),
    enviar: async (jid, contenido, messageId) => {
      const mensaje =
        "imagen" in contenido
          ? { image: contenido.imagen, mimetype: contenido.mime, caption: contenido.texto }
          : { text: contenido.texto };
      const r = await s.sendMessage(jid, mensaje, { messageId });
      return r?.key;
    },
    presencia: (jid, tipo) => s.sendPresenceUpdate(tipo, jid),
    leer: (claves: WAMessageKey[]) => s.readMessages(claves),
    existe: async (telefono) => {
      const r = await s.onWhatsApp(telefono.replace(/\D/g, ""));
      const encontrado = r?.find((x) => x.exists);
      return encontrado ? jidNormalizedUser(encontrado.jid) : null;
    },
    descargar: (msg) => descargarMedia(msg),
  };
}

export async function iniciarConexion(): Promise<void> {
  if (timerReintento) {
    clearTimeout(timerReintento);
    timerReintento = null;
  }
  soltarSocket();
  const miGeneracion = ++generacion;
  huboQr = false;
  qrDataUrl = null;
  cambiarEstado("CONECTANDO");

  const { state, saveCreds } = await usarSesionBd();
  if (miGeneracion !== generacion) return; // otro iniciarConexion() ganó mientras leíamos la sesión

  const s = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    browser: Browsers.macOS("Chrome"),
    markOnlineOnConnect: false, // así el teléfono del negocio sigue recibiendo notificaciones
    syncFullHistory: false,
    getMessage: async (key) => {
      // Para reenvíos que pide WhatsApp: el texto que guardamos
      const r = await pool.query(`SELECT texto FROM wa_mensajes WHERE wa_id = $1`, [key.id]);
      const texto = r.rows[0]?.texto;
      return texto ? { conversation: texto } : undefined;
    },
  });
  sock = s;
  const vigente = () => miGeneracion === generacion;

  s.ev.on("creds.update", () => {
    if (vigente()) saveCreds().catch((e) => console.error("[wa] no se pudo guardar la sesión", e));
  });

  s.ev.on("connection.update", async (u) => {
    if (!vigente()) return;
    if (u.qr) {
      huboQr = true;
      qrDataUrl = await QRCode.toDataURL(u.qr);
      if (!vigente()) return;
      cambiarEstado("ESPERANDO_QR");
      const pendientes = esperandoQr;
      esperandoQr = [];
      pendientes.forEach((fn) => fn());
    }
    if (u.connection === "open") {
      intentos = 0;
      ultimoError = null;
      conectadoDesde = new Date();
      usarTransporte(crearTransporte(s));
      cambiarEstado("CONECTADO");
    }
    if (u.connection === "close") {
      const codigo = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      ultimoError = u.lastDisconnect?.error?.message ?? null;
      conectadoDesde = null;
      usarTransporte(null);
      await manejarCierre(codigo);
    }
  });

  s.ev.on("messages.upsert", ({ messages, type }) => {
    if (!vigente()) return;
    procesarEntrantes(messages, type).catch((e) => console.error("[wa] error procesando mensajes", e));
  });

  s.ev.on("messages.update", (updates) => {
    if (!vigente()) return;
    procesarActualizaciones(updates).catch((e) => console.error("[wa] error actualizando estados", e));
  });
}

async function manejarCierre(codigo: number | undefined) {
  if (codigo === DisconnectReason.restartRequired) {
    console.log("[wa] 515 restartRequired: reiniciando");
    return iniciarConexion();
  }
  if (codigo === DisconnectReason.loggedOut) {
    console.warn("[wa] 401 loggedOut: se borra la sesión y se pide un QR nuevo");
    soltarSocket();
    await borrarSesion();
    return iniciarConexion();
  }
  if (codigo === DisconnectReason.connectionReplaced) {
    console.warn("[wa] 440 connectionReplaced: otra instancia abrió la sesión; no se reconecta solo");
    soltarSocket();
    return cambiarEstado("REEMPLAZADA");
  }
  // Red, timeouts, 5xx...: reintento sin límite con espera creciente
  soltarSocket();
  intentos++;
  const espera = Math.min(60_000, 1_000 * 2 ** Math.min(intentos, 6));
  console.warn(`[wa] conexión cerrada (${codigo ?? "sin código"}); reintento ${intentos} en ${espera / 1000} s`);
  cambiarEstado("DESCONECTADO");
  timerReintento = setTimeout(() => {
    timerReintento = null;
    iniciarConexion().catch((e) => console.error("[wa] error al reconectar", e));
  }, espera);
}

/** Código de 8 dígitos para vincular sin QR. Solo se pide después del primer QR del socket. */
export async function pedirCodigoVinculacion(numero: string) {
  const limpio = numero.replace(/\D/g, "");
  if (limpio.length < 10) throw Object.assign(new Error("Número inválido: incluí el código de país"), { status: 400 });
  if (estado === "CONECTADO") throw Object.assign(new Error("WhatsApp ya está conectado"), { status: 409 });
  if (!sock || estado === "REEMPLAZADA" || estado === "DESCONECTADO") await iniciarConexion();
  if (!huboQr) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error("WhatsApp tardó demasiado en responder"), { status: 504 })), 30_000);
      esperandoQr.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  if (!sock) throw Object.assign(new Error("No hay conexión con WhatsApp"), { status: 503 });
  return sock.requestPairingCode(limpio);
}

export async function cerrarSesion() {
  const s = sock;
  if (s) await s.logout().catch(() => {});
  soltarSocket();
  generacion++;
  await borrarSesion();
  cambiarEstado("DESCONECTADO");
}

/** Borra la sesión y arranca de cero (nuevo QR), sin avisar a WhatsApp. Para sesiones corruptas. */
export async function resetearSesion() {
  soltarSocket();
  generacion++;
  await borrarSesion();
  await iniciarConexion();
}

export async function autoIniciar() {
  if (process.env.WA_AUTOSTART === "false") {
    console.log("[wa] WA_AUTOSTART=false: WhatsApp no arranca solo");
    return;
  }
  // Sin sesión guardada no se abre socket: esperaría un QR que nadie mira
  if (!(await haySesionGuardada())) {
    console.log("[wa] sin sesión guardada: vincular desde el panel");
    return;
  }
  await iniciarConexion();
}
