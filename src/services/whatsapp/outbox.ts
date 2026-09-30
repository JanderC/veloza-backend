import { pool } from "../../db/pool";
import { generarUrlTemporal } from "../almacenamiento.service";
import { ahoraLocal, enRango, leerConfig } from "./config";
import { emitirPanel } from "./eventos";
import { enviarMensaje } from "./envio";
import { asegurarChat, guardarEstadoConversacion, notaInterna, obtenerChat } from "./mensajes";
import { formatearMonto } from "./herramientas";
import { jidDeTelefono, telefonoDeJid, transporte } from "./transporte";

// Envíos salientes (recibos, confirmaciones, avisos). Nunca se mandan en la misma petición
// HTTP: se guardan acá y un trabajador los envía con reintentos y espera creciente.
// Un solo mensaje por envío, texto corto y variado, sin enlaces ni plantilla fija.
// Contactos "fríos" (nunca nos escribieron): tope diario, pausas largas, solo de día,
// y se verifica con onWhatsApp que el número exista.

export type EstadoOutbox = "EN_COLA" | "ESPERA_CLIENTE" | "ENVIANDO" | "ENVIADO" | "ERROR";
const MAX_INTENTOS = 5;

const azar = <T,>(lista: T[]) => lista[Math.floor(Math.random() * lista.length)]!;
const azarEntre = (min: number, max: number) => min + Math.random() * Math.max(0, max - min);

interface FilaOutbox {
  id: string;
  jid: string;
  texto: string;
  media_key: string | null;
  media_mime: string | null;
  origen: string | null;
  estado: EstadoOutbox;
  intentos: number;
  proximo_intento: string;
  error: string | null;
  frio: boolean;
  created_at: string;
  enviado_en: string | null;
}

async function emitir(id: string) {
  const r = await pool.query(`SELECT * FROM wa_outbox WHERE id = $1`, [id]);
  if (r.rows[0]) emitirPanel("outbox", r.rows[0]);
}

export async function encolarOutbox(input: {
  jid?: string;
  telefono?: string;
  texto: string;
  mediaKey?: string | null;
  mediaMime?: string | null;
  origen?: string | null;
  usuarioId?: number | null;
}) {
  const jid = input.jid ?? (input.telefono ? jidDeTelefono(input.telefono) : null);
  if (!jid) throw Object.assign(new Error("Falta el número de destino"), { status: 400 });
  const r = await pool.query(
    `INSERT INTO wa_outbox (jid, texto, media_key, media_mime, origen, creado_por_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (origen) WHERE origen IS NOT NULL DO NOTHING
     RETURNING id`,
    [jid, input.texto, input.mediaKey ?? null, input.mediaMime ?? null, input.origen ?? null, input.usuarioId ?? null]
  );
  const id = r.rows[0]?.id;
  if (id) {
    await emitir(id);
    void trabajarOutbox();
  }
  return id ?? null;
}

async function reprogramar(id: string, estado: EstadoOutbox, cuando: Date | null, error: string | null, sumarIntento = false) {
  await pool.query(
    `UPDATE wa_outbox SET estado = $2, proximo_intento = COALESCE($3, proximo_intento), error = $4,
       intentos = intentos + CASE WHEN $5 THEN 1 ELSE 0 END WHERE id = $1`,
    [id, estado, cuando, error, sumarIntento]
  );
  await emitir(id);
}

let trabajando = false;

export async function trabajarOutbox() {
  if (trabajando || !transporte().conectado()) return;
  trabajando = true;
  try {
    for (;;) {
      const r = await pool.query(
        `UPDATE wa_outbox SET estado = 'ENVIANDO' WHERE id = (
           SELECT id FROM wa_outbox WHERE estado = 'EN_COLA' AND proximo_intento <= now()
           ORDER BY proximo_intento, id LIMIT 1 FOR UPDATE SKIP LOCKED
         ) RETURNING *`
      );
      const item: FilaOutbox | undefined = r.rows[0];
      if (!item) break;
      await emitir(item.id);
      await procesarItem(item);
      if (!transporte().conectado()) break;
    }
  } catch (err) {
    console.error("[outbox] error del trabajador", err);
  } finally {
    trabajando = false;
  }
}

async function procesarItem(item: FilaOutbox) {
  const config = await leerConfig();
  const ab = config.antibloqueo;
  const chat = await obtenerChat(item.jid);
  const frio = !chat?.ultimo_entrante_en;

  if (frio) {
    // Solo de día
    const { hora } = ahoraLocal(config.negocio.zonaHoraria);
    if (!enRango(hora, ab.friosDesde, ab.friosHasta)) {
      return reprogramar(item.id, "EN_COLA", new Date(Date.now() + 15 * 60_000), `Contacto nuevo: se envía entre ${ab.friosDesde} y ${ab.friosHasta}`);
    }
    // Tope diario de contactos fríos: esperan a que el cliente escriba
    const hoy = await pool.query(
      `SELECT count(*)::int AS n, max(enviado_en) AS ultimo FROM wa_outbox
       WHERE frio AND estado = 'ENVIADO' AND enviado_en > now() - interval '24 hours'`
    );
    if (hoy.rows[0].n >= ab.friosPorDia) {
      return reprogramar(item.id, "ESPERA_CLIENTE", null, "Tope diario de contactos nuevos: sale en cuanto el cliente escriba");
    }
    // Pausa larga y aleatoria entre contactos fríos
    const ultimo = hoy.rows[0].ultimo ? new Date(hoy.rows[0].ultimo).getTime() : 0;
    const pausa = azarEntre(ab.friosPausaMinS, ab.friosPausaMaxS) * 1000;
    if (Date.now() - ultimo < pausa) {
      return reprogramar(item.id, "EN_COLA", new Date(ultimo + pausa), null);
    }
    // Que el número exista antes de escribirle
    let existe: string | null;
    try {
      existe = await transporte().existe(telefonoDeJid(item.jid));
    } catch (err) {
      return reprogramar(item.id, "EN_COLA", new Date(Date.now() + 60_000), (err as Error).message);
    }
    if (!existe) return reprogramar(item.id, "ERROR", null, "Ese número no tiene WhatsApp");
    await asegurarChat(item.jid);
  }

  try {
    let imagen: { buffer: Buffer; mime: string; mediaKey: string } | undefined;
    if (item.media_key && item.media_mime) {
      const res = await fetch(generarUrlTemporal(item.media_key, item.media_mime, 120));
      if (!res.ok) throw new Error(`No se pudo leer la imagen (${res.status})`);
      imagen = { buffer: Buffer.from(await res.arrayBuffer()), mime: item.media_mime, mediaKey: item.media_key };
    }
    await enviarMensaje({ jid: item.jid, autor: "sistema", texto: item.texto, imagen });
    await pool.query(`UPDATE wa_outbox SET estado = 'ENVIADO', enviado_en = now(), error = NULL, frio = $2 WHERE id = $1`, [item.id, frio]);
    await emitir(item.id);
  } catch (err) {
    const intentos = item.intentos + 1;
    const mensaje = (err as Error).message;
    if (!transporte().conectado()) return reprogramar(item.id, "EN_COLA", new Date(Date.now() + 30_000), mensaje);
    if (intentos >= MAX_INTENTOS) return reprogramar(item.id, "ERROR", null, mensaje, true);
    const espera = Math.min(60, 2 ** intentos) * 60_000;
    return reprogramar(item.id, "EN_COLA", new Date(Date.now() + espera), mensaje, true);
  }
}

/** El cliente escribió: lo que esperaba por él sale ya (ahora es un contacto "caliente"). */
export async function liberarEsperasDeChat(jid: string) {
  const r = await pool.query(
    `UPDATE wa_outbox SET estado = 'EN_COLA', proximo_intento = now(), error = NULL
     WHERE jid = $1 AND estado IN ('ESPERA_CLIENTE', 'EN_COLA') RETURNING id`,
    [jid]
  );
  for (const f of r.rows) await emitir(f.id);
  if (r.rows.length) setTimeout(() => void trabajarOutbox(), 8_000); // después de la respuesta del bot
}

export async function reintentarOutbox(id: string) {
  const r = await pool.query(
    `UPDATE wa_outbox SET estado = 'EN_COLA', intentos = 0, proximo_intento = now(), error = NULL
     WHERE id = $1 AND estado IN ('ERROR', 'ESPERA_CLIENTE') RETURNING id`,
    [id]
  );
  if (!r.rows[0]) throw Object.assign(new Error("Ese envío no se puede reintentar"), { status: 409 });
  await emitir(id);
  void trabajarOutbox();
}

export async function listarOutbox(limite = 100) {
  const r = await pool.query(
    `SELECT o.*, c.nombre, c.nombre_guardado, c.telefono FROM wa_outbox o LEFT JOIN wa_chats c ON c.jid = o.jid
     ORDER BY CASE o.estado WHEN 'ERROR' THEN 0 WHEN 'ENVIANDO' THEN 1 WHEN 'EN_COLA' THEN 2 WHEN 'ESPERA_CLIENTE' THEN 3 ELSE 4 END, o.id DESC
     LIMIT $1`,
    [limite]
  );
  return r.rows;
}

// ---------- Avisos de transacciones ----------
async function datosTransaccion(txId: number) {
  const r = await pool.query(
    `SELECT t.*, ter.nombre AS cliente, mo.codigo AS mo, mo.decimales AS mo_dec, md.codigo AS md, md.decimales AS md_dec
     FROM transacciones t
     LEFT JOIN terceros ter ON ter.id = t.tercero_id
     JOIN monedas mo ON mo.id = t.moneda_origen_id
     LEFT JOIN monedas md ON md.id = t.moneda_destino_id
     WHERE t.id = $1`,
    [txId]
  );
  return r.rows[0] ?? null;
}

type Tx = NonNullable<Awaited<ReturnType<typeof datosTransaccion>>>;

function primerNombre(tx: Tx) {
  return tx.cliente ? String(tx.cliente).split(" ")[0] : "";
}

function resumenMontos(tx: Tx) {
  const divisa = `${formatearMonto(tx.monto_origen, Number(tx.mo_dec))} ${tx.mo}`;
  const pesos = tx.monto_destino ? `$${formatearMonto(tx.monto_destino, Number(tx.md_dec))} ${tx.md}` : null;
  if (!pesos) return divisa;
  return tx.tipo === "COMPRA_DIVISA" ? `${divisa} → ${pesos}` : `${pesos} → ${divisa}`;
}

function textoResultado(tx: Tx) {
  const n = primerNombre(tx);
  const hola = n ? `${azar(["Hola", "¡Hola"])} ${n}` : azar(["Hola", "¡Hola"]);
  if (tx.estado === "CONFIRMADA") {
    return azar([
      `${hola}! Tu operación #${tx.id} quedó confirmada ✅ (${resumenMontos(tx)}). Gracias por confiar en nosotros.`,
      `${hola}, ya confirmamos tu operación #${tx.id} (${resumenMontos(tx)}). ¡Gracias!`,
      `${hola}! Listo: la operación #${tx.id} está confirmada. ${resumenMontos(tx)}.`,
    ]);
  }
  if (tx.estado === "RECHAZADA") {
    const motivo = tx.motivo_rechazo ? `: ${tx.motivo_rechazo}` : ".";
    return azar([
      `${hola}, tu solicitud #${tx.id} no se pudo completar${motivo} Si tienes dudas, escríbenos por aquí.`,
      `${hola}. Lamentablemente la solicitud #${tx.id} no se completó${motivo} Cualquier cosa nos escribes.`,
    ]);
  }
  return `${hola}, tu operación #${tx.id} (${resumenMontos(tx)}) está ${String(tx.estado).toLowerCase()}.`;
}

/** Chat al que se le avisa: el de la solicitud o, si el cliente ya nos escribió, el suyo. */
async function jidDeTransaccion(tx: Tx): Promise<string | null> {
  if (tx.wa_jid) return tx.wa_jid;
  if (!tx.tercero_id) return null;
  const r = await pool.query(`SELECT jid FROM wa_chats WHERE tercero_id = $1 AND ultimo_entrante_en IS NOT NULL ORDER BY ultimo_entrante_en DESC LIMIT 1`, [
    tx.tercero_id,
  ]);
  return r.rows[0]?.jid ?? null;
}

/** Después de confirmar o rechazar en la Bandeja: aviso al cliente por la outbox. */
export async function notificarResultadoTransaccion(txId: number, usuarioId?: number) {
  const tx = await datosTransaccion(txId);
  if (!tx || !["CONFIRMADA", "RECHAZADA"].includes(tx.estado)) return;
  const jid = await jidDeTransaccion(tx);
  if (!jid) return;
  await encolarOutbox({ jid, texto: textoResultado(tx), origen: `transaccion:${tx.id}:${String(tx.estado).toLowerCase()}`, usuarioId });
  const chat = await obtenerChat(jid);
  if (chat?.estado?.solicitudId === tx.id) await guardarEstadoConversacion(jid, { solicitudId: null, comprobanteRecibido: null });
  if (chat) await notaInterna(jid, `Solicitud #${tx.id} ${String(tx.estado).toLowerCase()}: aviso al cliente en la cola de envíos.`);
}

/**
 * "Recibir por WhatsApp": el cliente escribe primero con su código (VC-123).
 * Al llegar, se une la transacción a su chat y se le manda el recibo.
 */
export async function vincularCodigoTransaccion(jid: string, texto: string) {
  const m = texto.match(/\bVC-?(\d{1,9})\b/i);
  if (!m) return;
  const tx = await datosTransaccion(Number(m[1]));
  if (!tx) return;
  const chat = await obtenerChat(jid);
  if (tx.tercero_id && chat && !chat.tercero_id) {
    await pool.query(`UPDATE wa_chats SET tercero_id = $1 WHERE jid = $2`, [tx.tercero_id, jid]);
  }
  if (!tx.wa_jid) await pool.query(`UPDATE transacciones SET wa_jid = $1 WHERE id = $2`, [jid, tx.id]);
  await notaInterna(jid, `El cliente escribió con el código VC-${tx.id}: se unió la operación #${tx.id} a este chat.`);
  await encolarOutbox({ jid, texto: textoResultado(tx), origen: `transaccion:${tx.id}:recibo` });
}

/** Link wa.me con el mensaje prellenado que incluye el código de la operación. */
export async function enlaceRecibirPorWhatsapp(txId: number) {
  const config = await leerConfig();
  const numero = config.negocio.numeroWhatsapp.replace(/\D/g, "") || transporte().miJid()?.split("@")[0] || "";
  if (!numero) throw Object.assign(new Error("Falta configurar el número de WhatsApp del negocio"), { status: 409 });
  const texto = `Hola, quiero recibir el comprobante de mi operación VC-${txId}`;
  return { url: `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`, codigo: `VC-${txId}` };
}
