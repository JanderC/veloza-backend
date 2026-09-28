import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { pool } from "../db/pool";

type EstadoConexion = "DESCONECTADO" | "ESPERANDO_QR" | "CONECTADO";

let socket: ReturnType<typeof makeWASocket> | null = null;
let estado: EstadoConexion = "DESCONECTADO";
let qrActual: string | null = null; // data URL, listo para <img src="">

export function obtenerEstadoWhatsapp() {
  return { estado, qr: estado === "ESPERANDO_QR" ? qrActual : null };
}

/**
 * Extrae monto + moneda de un texto libre, con patrones simples.
 * NUNCA se usa para registrar nada solo -- siempre es una sugerencia
 * que el asesor confirma manualmente al convertir el mensaje.
 */
function detectarMontoYMoneda(texto: string): { monto: number | null; codigoMoneda: string | null } {
  const patron = /(\d+(?:[.,]\d+)?)\s*(usd|dolares|dólares|eur|euros|usdt|bs|bolivares|bolívares)/i;
  const match = texto.match(patron);
  if (!match) return { monto: null, codigoMoneda: null };

  const grupoMonto = match[1];
  const grupoPalabra = match[2];
  if (!grupoMonto || !grupoPalabra) return { monto: null, codigoMoneda: null };

  const monto = Number(grupoMonto.replace(",", "."));
  const palabra = grupoPalabra.toLowerCase();
  const mapa: Record<string, string> = {
    usd: "USD", dolares: "USD", dólares: "USD",
    eur: "EUR", euros: "EUR",
    usdt: "USDT",
    bs: "VES", bolivares: "VES", bolívares: "VES",
  };
  return { monto: Number.isFinite(monto) ? monto : null, codigoMoneda: mapa[palabra] ?? null };
}

async function guardarMensajeEntrante(telefono: string, nombreContacto: string | null, texto: string) {
  const { monto, codigoMoneda } = detectarMontoYMoneda(texto);

  let monedaId: number | null = null;
  if (codigoMoneda) {
    const monedaResult = await pool.query(`SELECT id FROM monedas WHERE codigo = $1`, [codigoMoneda]);
    monedaId = monedaResult.rows[0]?.id ?? null;
  }

  // Si el teléfono ya es de un cliente conocido, lo vinculamos de una vez.
  const terceroResult = await pool.query(`SELECT id FROM terceros WHERE telefono = $1`, [telefono]);
  const terceroId = terceroResult.rows[0]?.id ?? null;

  await pool.query(
    `INSERT INTO whatsapp_mensajes (telefono, nombre_contacto, mensaje, monto_detectado, moneda_detectada_id, tercero_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [telefono, nombreContacto, texto, monto, monedaId, terceroId]
  );
}

export async function iniciarSesionWhatsapp() {
  if (socket) return obtenerEstadoWhatsapp();

  const { state, saveCreds } = await useMultiFileAuthState("./whatsapp-auth");

  socket = makeWASocket({ auth: state, printQRInTerminal: false });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      estado = "ESPERANDO_QR";
      qrActual = await QRCode.toDataURL(qr);
    }

    if (connection === "open") {
      estado = "CONECTADO";
      qrActual = null;
    }

    if (connection === "close") {
      const debeReconectar =
        (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
      estado = "DESCONECTADO";
      socket = null;
      if (debeReconectar) iniciarSesionWhatsapp();
    }
  });

  socket.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      const telefono = msg.key.remoteJid?.replace("@s.whatsapp.net", "") ?? "desconocido";
      const nombreContacto = msg.pushName ?? null;
      const texto = msg.message.conversation ?? msg.message.extendedTextMessage?.text ?? "";
      if (!texto) continue;

      await guardarMensajeEntrante(telefono, nombreContacto, texto);

      const configResult = await pool.query(`SELECT * FROM whatsapp_configuracion WHERE id = 1`);
      const config = configResult.rows[0];
      if (config?.respuesta_automatica_activa && socket) {
        await socket.sendMessage(msg.key.remoteJid!, { text: config.mensaje_automatico });
      }
    }
  });

  estado = "ESPERANDO_QR";
  return obtenerEstadoWhatsapp();
}

export async function obtenerMensajesWhatsapp(estadoFiltro?: string) {
  const where = estadoFiltro ? `WHERE wm.estado = $1` : "";
  const valores = estadoFiltro ? [estadoFiltro] : [];
  const result = await pool.query(
    `SELECT wm.*, m.codigo AS moneda_codigo, t.nombre AS tercero_nombre
     FROM whatsapp_mensajes wm
     LEFT JOIN monedas m ON m.id = wm.moneda_detectada_id
     LEFT JOIN terceros t ON t.id = wm.tercero_id
     ${where}
     ORDER BY wm.created_at DESC LIMIT 100`,
    valores
  );
  return result.rows;
}

export async function marcarMensajeWhatsapp(id: number, estadoNuevo: "CONVERTIDO" | "DESCARTADO", terceroId?: number) {
  const result = await pool.query(
    `UPDATE whatsapp_mensajes SET estado = $1, tercero_id = COALESCE($2, tercero_id) WHERE id = $3 RETURNING *`,
    [estadoNuevo, terceroId ?? null, id]
  );
  return result.rows[0];
}

export async function obtenerConfiguracionWhatsapp() {
  const result = await pool.query(`SELECT * FROM whatsapp_configuracion WHERE id = 1`);
  return result.rows[0];
}

export async function actualizarConfiguracionWhatsapp(activa: boolean, mensaje: string) {
  const result = await pool.query(
    `UPDATE whatsapp_configuracion SET respuesta_automatica_activa = $1, mensaje_automatico = $2, actualizado_en = now() WHERE id = 1 RETURNING *`,
    [activa, mensaje]
  );
  return result.rows[0];
}