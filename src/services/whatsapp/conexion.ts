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
import { LINEAS, jidReal, nombreDeLinea, usarTransporte, type Linea, type Transporte } from "./transporte";
import { procesarActualizaciones, procesarEntrantes } from "./entrantes";

// Ciclo de vida del socket de Baileys, uno por línea (teléfono vinculado):
// - fallas de red: reintento sin límite con espera creciente (máx. 60 s), NUNCA se borra la sesión
// - 515 restartRequired (normal tras vincular): reinicio inmediato
// - 401 loggedOut: se borra la sesión de ESA línea y se genera un QR nuevo
// - 440 connectionReplaced: otra instancia abrió la sesión; no se reconecta solo
// Cada línea es independiente: que una se caiga o se desvincule no toca a las otras.

export type EstadoConexion = "DESCONECTADO" | "CONECTANDO" | "ESPERANDO_QR" | "CONECTADO" | "REEMPLAZADA";

const logger = pino({ level: process.env.WA_LOG_LEVEL ?? "warn" });

interface EstadoLinea {
  linea: Linea;
  sock: WASocket | null;
  generacion: number; // cada socket nuevo sube el número; los eventos de sockets viejos se ignoran
  estado: EstadoConexion;
  qrDataUrl: string | null;
  huboQr: boolean;
  intentos: number;
  timerReintento: NodeJS.Timeout | null;
  ultimoError: string | null;
  conectadoDesde: Date | null;
  esperandoQr: (() => void)[];
}

const lineas = new Map<Linea, EstadoLinea>(
  LINEAS.map((l) => [
    l.id,
    { linea: l.id, sock: null, generacion: 0, estado: "DESCONECTADO", qrDataUrl: null, huboQr: false, intentos: 0, timerReintento: null, ultimoError: null, conectadoDesde: null, esperandoQr: [] },
  ])
);
const de = (linea: Linea) => lineas.get(linea)!;
const etiqueta = (linea: Linea) => `[wa ${nombreDeLinea(linea)}]`;

export function estadoConexion(linea: Linea = 1) {
  const L = de(linea);
  return {
    linea,
    nombreLinea: nombreDeLinea(linea),
    estado: L.estado,
    qr: L.estado === "ESPERANDO_QR" ? L.qrDataUrl : null,
    numero: L.sock?.user?.id ? jidNormalizedUser(L.sock.user.id).split("@")[0] : null,
    nombre: L.sock?.user?.name ?? null,
    ultimoError: L.ultimoError,
    conectadoDesde: L.conectadoDesde,
  };
}

/** El estado de las tres líneas, en orden. */
export function estadoLineas() {
  return LINEAS.map((l) => estadoConexion(l.id));
}

/** Momento en que abrió la conexión actual: lo anterior que llegue ahora es "viejo". */
export function conectadoDesdeFecha(linea: Linea = 1) {
  return de(linea).conectadoDesde;
}

function cambiarEstado(linea: Linea, nuevo: EstadoConexion) {
  de(linea).estado = nuevo;
  emitirPanel("conexion", estadoConexion(linea));
}

function soltarSocket(linea: Linea) {
  const L = de(linea);
  if (!L.sock) return;
  const viejo = L.sock;
  L.sock = null;
  usarTransporte(linea, null);
  try {
    viejo.ev.removeAllListeners(undefined as never);
    viejo.end(undefined);
  } catch {
    // ya estaba cerrado
  }
}

/** jid real del chat: en v7 puede llegar como @lid; se guarda siempre como <numero>@s.whatsapp.net. */
export async function jidCanonico(jid: string, alternativo?: string | null, linea: Linea = 1): Promise<string> {
  if (!isLidUser(jid)) return jidNormalizedUser(jid);
  if (alternativo && !isLidUser(alternativo)) return jidNormalizedUser(alternativo);
  const pn = await de(linea).sock?.signalRepository.lidMapping.getPNForLID(jid).catch(() => null);
  return pn ? jidNormalizedUser(pn) : jidNormalizedUser(jid);
}

/** Descarga el adjunto de un mensaje (pide que lo vuelvan a subir si el enlace venció). */
export async function descargarMedia(msg: WAMessage, linea: Linea = 1): Promise<Buffer> {
  const s = de(linea).sock;
  if (!s) throw new Error("WhatsApp no está conectado");
  return downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: s.updateMediaMessage });
}

// El resto del módulo trabaja con la clave del chat (el jid, con "#2"/"#3" en las otras líneas):
// acá, al hablar con WhatsApp, siempre se usa el jid real.
function crearTransporte(linea: Linea, s: WASocket): Transporte {
  return {
    conectado: () => de(linea).estado === "CONECTADO" && de(linea).sock === s,
    miJid: () => (s.user?.id ? jidNormalizedUser(s.user.id) : null),
    enviar: async (jid, contenido, messageId, cita) => {
      const mensaje =
        "sticker" in contenido
          ? { sticker: contenido.sticker }
          : "imagen" in contenido
            ? { image: contenido.imagen, mimetype: contenido.mime, caption: contenido.texto }
            : { text: contenido.texto };
      // al responder a un mensaje, WhatsApp necesita la clave del original y algo de su contenido para armar la cita
      const quoted = cita ? { key: { ...cita.key, remoteJid: jidReal(cita.key.remoteJid ?? jid) }, message: { conversation: cita.texto } } : undefined;
      const r = await s.sendMessage(jidReal(jid), mensaje, { messageId, quoted });
      return r?.key;
    },
    presencia: (jid, tipo) => s.sendPresenceUpdate(tipo, jidReal(jid)),
    leer: (claves: WAMessageKey[]) => s.readMessages(claves.map((c) => (c.remoteJid ? { ...c, remoteJid: jidReal(c.remoteJid) } : c))),
    existe: async (telefono) => {
      const r = await s.onWhatsApp(telefono.replace(/\D/g, ""));
      const encontrado = r?.find((x) => x.exists);
      return encontrado ? jidNormalizedUser(encontrado.jid) : null;
    },
    descargar: (msg) => descargarMedia(msg, linea),
  };
}

export async function iniciarConexion(linea: Linea = 1): Promise<void> {
  const L = de(linea);
  if (L.timerReintento) {
    clearTimeout(L.timerReintento);
    L.timerReintento = null;
  }
  soltarSocket(linea);
  const miGeneracion = ++L.generacion;
  L.huboQr = false;
  L.qrDataUrl = null;
  cambiarEstado(linea, "CONECTANDO");

  const { state, saveCreds } = await usarSesionBd(linea);
  if (miGeneracion !== L.generacion) return; // otro iniciarConexion() ganó mientras leíamos la sesión

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
  L.sock = s;
  const vigente = () => miGeneracion === L.generacion;

  s.ev.on("creds.update", () => {
    if (vigente()) saveCreds().catch((e) => console.error(`${etiqueta(linea)} no se pudo guardar la sesión`, e));
  });

  s.ev.on("connection.update", async (u) => {
    if (!vigente()) return;
    if (u.qr) {
      L.huboQr = true;
      L.qrDataUrl = await QRCode.toDataURL(u.qr);
      if (!vigente()) return;
      cambiarEstado(linea, "ESPERANDO_QR");
      const pendientes = L.esperandoQr;
      L.esperandoQr = [];
      pendientes.forEach((fn) => fn());
    }
    if (u.connection === "open") {
      L.intentos = 0;
      L.ultimoError = null;
      L.conectadoDesde = new Date();
      usarTransporte(linea, crearTransporte(linea, s));
      cambiarEstado(linea, "CONECTADO");
    }
    if (u.connection === "close") {
      const codigo = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      L.ultimoError = u.lastDisconnect?.error?.message ?? null;
      L.conectadoDesde = null;
      usarTransporte(linea, null);
      await manejarCierre(linea, codigo);
    }
  });

  s.ev.on("messages.upsert", ({ messages, type }) => {
    if (!vigente()) return;
    procesarEntrantes(messages, type, linea).catch((e) => console.error(`${etiqueta(linea)} error procesando mensajes`, e));
  });

  s.ev.on("messages.update", (updates) => {
    if (!vigente()) return;
    procesarActualizaciones(updates).catch((e) => console.error(`${etiqueta(linea)} error actualizando estados`, e));
  });
}

async function manejarCierre(linea: Linea, codigo: number | undefined) {
  const L = de(linea);
  if (codigo === DisconnectReason.restartRequired) {
    console.log(`${etiqueta(linea)} 515 restartRequired: reiniciando`);
    return iniciarConexion(linea);
  }
  if (codigo === DisconnectReason.loggedOut) {
    console.warn(`${etiqueta(linea)} 401 loggedOut: se borra la sesión y se pide un QR nuevo`);
    soltarSocket(linea);
    await borrarSesion(linea);
    return iniciarConexion(linea);
  }
  if (codigo === DisconnectReason.connectionReplaced) {
    console.warn(`${etiqueta(linea)} 440 connectionReplaced: otra instancia abrió la sesión; no se reconecta solo`);
    soltarSocket(linea);
    return cambiarEstado(linea, "REEMPLAZADA");
  }
  // Red, timeouts, 5xx...: reintento sin límite con espera creciente
  soltarSocket(linea);
  L.intentos++;
  const espera = Math.min(60_000, 1_000 * 2 ** Math.min(L.intentos, 6));
  console.warn(`${etiqueta(linea)} conexión cerrada (${codigo ?? "sin código"}); reintento ${L.intentos} en ${espera / 1000} s`);
  cambiarEstado(linea, "DESCONECTADO");
  L.timerReintento = setTimeout(() => {
    L.timerReintento = null;
    iniciarConexion(linea).catch((e) => console.error(`${etiqueta(linea)} error al reconectar`, e));
  }, espera);
}

/** Código de 8 dígitos para vincular sin QR. Solo se pide después del primer QR del socket. */
export async function pedirCodigoVinculacion(numero: string, linea: Linea = 1) {
  const L = de(linea);
  const limpio = numero.replace(/\D/g, "");
  if (limpio.length < 10) throw Object.assign(new Error("Número inválido: incluí el código de país"), { status: 400 });
  if (L.estado === "CONECTADO") throw Object.assign(new Error("Esa línea ya está conectada"), { status: 409 });
  if (!L.sock || L.estado === "REEMPLAZADA" || L.estado === "DESCONECTADO") await iniciarConexion(linea);
  if (!L.huboQr) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error("WhatsApp tardó demasiado en responder"), { status: 504 })), 30_000);
      L.esperandoQr.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  if (!L.sock) throw Object.assign(new Error("No hay conexión con WhatsApp"), { status: 503 });
  return L.sock.requestPairingCode(limpio);
}

export async function cerrarSesion(linea: Linea = 1) {
  const L = de(linea);
  const s = L.sock;
  if (s) await s.logout().catch(() => {});
  soltarSocket(linea);
  L.generacion++;
  if (L.timerReintento) {
    clearTimeout(L.timerReintento);
    L.timerReintento = null;
  }
  await borrarSesion(linea);
  cambiarEstado(linea, "DESCONECTADO");
}

/** Borra la sesión de la línea y arranca de cero (nuevo QR), sin avisar a WhatsApp. Para sesiones corruptas. */
export async function resetearSesion(linea: Linea = 1) {
  soltarSocket(linea);
  de(linea).generacion++;
  await borrarSesion(linea);
  await iniciarConexion(linea);
}

export async function autoIniciar() {
  if (process.env.WA_AUTOSTART === "false") {
    console.log("[wa] WA_AUTOSTART=false: WhatsApp no arranca solo");
    return;
  }
  for (const l of LINEAS) {
    // Sin sesión guardada no se abre socket: esperaría un QR que nadie mira
    if (!(await haySesionGuardada(l.id))) {
      console.log(`${etiqueta(l.id)} sin sesión guardada: vincular desde el panel`);
      continue;
    }
    // una línea que falle al arrancar no frena a las otras
    await iniciarConexion(l.id).catch((e) => console.error(`${etiqueta(l.id)} no se pudo iniciar`, e));
  }
}
