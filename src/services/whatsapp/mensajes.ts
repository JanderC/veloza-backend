import { pool } from "../../db/pool";
import { generarUrlTemporal } from "../almacenamiento.service";
import { emitirPanel } from "./eventos";
import { telefonoDeJid } from "./transporte";

export type Autor = "cliente" | "bot" | "humano" | "telefono" | "sistema";
export type TipoMensaje = "texto" | "imagen" | "audio" | "documento" | "sticker" | "video";
export type EstadoMensaje = "pendiente" | "enviado" | "entregado" | "leido" | "error";

export interface FilaChat {
  jid: string;
  telefono: string;
  nombre: string | null;
  nombre_guardado: string | null;
  tercero_id: number | null;
  ultimo_mensaje: string | null;
  ultimo_mensaje_en: string | null;
  ultimo_entrante_en: string | null;
  no_leidos: number;
  bot_activo: boolean;
  necesita_humano: boolean;
  motivo: string | null;
  necesita_humano_desde: string | null;
  estado: EstadoConversacion;
  archivado: boolean;
}

/** Estado de la conversación que el bot va guardando (JSONB). */
export interface EstadoConversacion {
  cotizacion?: {
    tipo: "COMPRA_DIVISA" | "VENTA_DIVISA";
    monedaId: number;
    monedaCodigo: string;
    cotizacionId: number;
    etiqueta: string;
    cantidadExtranjera: string;
    montoLocal: string;
    tasa: string;
    montoEn: "divisa" | "pesos";
    en: string;
  };
  solicitudId?: number;
  comprobanteRecibido?: boolean;
}

export interface FilaMensaje {
  id: string;
  jid: string;
  wa_id: string | null;
  wa_key: unknown;
  de_mi: boolean;
  autor: Autor;
  tipo: TipoMensaje;
  texto: string | null;
  media_key: string | null;
  media_mime: string | null;
  media_bytes: number | null;
  estado: EstadoMensaje;
  error: string | null;
  interno: boolean;
  usuario_id: number | null;
  created_at: string;
}

const RANGO_ESTADO: Record<EstadoMensaje, number> = { error: -1, pendiente: 0, enviado: 1, entregado: 2, leido: 3 };

export function vistaPrevia(tipo: TipoMensaje, texto: string | null) {
  const etiquetas: Record<TipoMensaje, string> = {
    texto: "",
    imagen: "📷 Foto",
    audio: "🎤 Nota de voz",
    documento: "📄 Documento",
    sticker: "Sticker",
    video: "🎥 Video",
  };
  if (tipo === "texto") return (texto ?? "").slice(0, 200);
  return texto ? `${etiquetas[tipo]}: ${texto.slice(0, 180)}` : etiquetas[tipo];
}

/** Crea el chat si no existe y lo vincula con el cliente (tercero) cuyo teléfono coincida. */
export async function asegurarChat(jid: string, nombre?: string | null) {
  const telefono = telefonoDeJid(jid);
  await pool.query(
    `INSERT INTO wa_chats (jid, telefono, nombre, tercero_id)
     VALUES ($1, $2, $3, (SELECT id FROM terceros WHERE activo AND telefono IS NOT NULL
                          AND right(regexp_replace(telefono, '\\D', '', 'g'), 10) = right($2, 10) ORDER BY id LIMIT 1))
     ON CONFLICT (jid) DO UPDATE SET nombre = COALESCE(EXCLUDED.nombre, wa_chats.nombre)`,
    [jid, telefono, nombre ?? null]
  );
}

export async function obtenerChat(jid: string): Promise<FilaChat | null> {
  const r = await pool.query(`SELECT * FROM wa_chats WHERE jid = $1`, [jid]);
  return r.rows[0] ?? null;
}

export async function actualizarChat(jid: string, cambios: Partial<Omit<FilaChat, "jid" | "estado">>) {
  const campos = Object.keys(cambios);
  if (campos.length === 0) return obtenerChat(jid);
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(", ");
  const r = await pool.query(`UPDATE wa_chats SET ${sets} WHERE jid = $1 RETURNING *`, [
    jid,
    ...campos.map((c) => (cambios as Record<string, unknown>)[c]),
  ]);
  const chat = r.rows[0] ?? null;
  if (chat) emitirPanel("chat", await chatParaPanel(chat));
  return chat as FilaChat | null;
}

/** Mezcla cambios en el estado de la conversación (null borra la clave). */
export async function guardarEstadoConversacion(jid: string, cambios: Partial<Record<keyof EstadoConversacion, unknown>>) {
  const quitar = Object.entries(cambios).filter(([, v]) => v === null).map(([k]) => k);
  const poner = Object.fromEntries(Object.entries(cambios).filter(([, v]) => v !== null && v !== undefined));
  await pool.query(`UPDATE wa_chats SET estado = (estado - $2::text[]) || $3::jsonb WHERE jid = $1`, [
    jid,
    quitar,
    JSON.stringify(poner),
  ]);
}

interface NuevoMensaje {
  jid: string;
  waId?: string | null;
  waKey?: unknown;
  deMi: boolean;
  autor: Autor;
  tipo?: TipoMensaje;
  texto?: string | null;
  mediaKey?: string | null;
  mediaMime?: string | null;
  mediaBytes?: number | null;
  estado?: EstadoMensaje;
  interno?: boolean;
  usuarioId?: number | null;
  fecha?: Date;
  /** false = historial sincronizado ("append"): no suma no leídos */
  cuentaNoLeido?: boolean;
}

/** Guarda el mensaje (idempotente por wa_id) y actualiza el resumen del chat. null si ya existía. */
export async function guardarMensaje(m: NuevoMensaje): Promise<FilaMensaje | null> {
  const tipo = m.tipo ?? "texto";
  const r = await pool.query(
    `INSERT INTO wa_mensajes (jid, wa_id, wa_key, de_mi, autor, tipo, texto, media_key, media_mime, media_bytes, estado, interno, usuario_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, COALESCE($14, now()))
     ON CONFLICT (wa_id) DO NOTHING
     RETURNING *`,
    [
      m.jid,
      m.waId ?? null,
      m.waKey ? JSON.stringify(m.waKey) : null,
      m.deMi,
      m.autor,
      tipo,
      m.texto ?? null,
      m.mediaKey ?? null,
      m.mediaMime ?? null,
      m.mediaBytes ?? null,
      m.estado ?? (m.deMi ? "enviado" : "leido"),
      m.interno ?? false,
      m.usuarioId ?? null,
      m.fecha ?? null,
    ]
  );
  const fila: FilaMensaje | undefined = r.rows[0];
  if (!fila) return null;

  if (!fila.interno) {
    const esEntrante = !m.deMi;
    const chat = await pool.query(
      `UPDATE wa_chats SET
         ultimo_mensaje = CASE WHEN ultimo_mensaje_en IS NULL OR $2 >= ultimo_mensaje_en THEN $3 ELSE ultimo_mensaje END,
         ultimo_mensaje_en = GREATEST(ultimo_mensaje_en, $2),
         ultimo_entrante_en = CASE WHEN $4 THEN GREATEST(ultimo_entrante_en, $2) ELSE ultimo_entrante_en END,
         no_leidos = no_leidos + CASE WHEN $4 AND $5 THEN 1 ELSE 0 END,
         archivado = CASE WHEN $4 AND $5 THEN false ELSE archivado END
       WHERE jid = $1 RETURNING *`,
      [m.jid, fila.created_at, vistaPrevia(tipo, m.texto ?? null), esEntrante, m.cuentaNoLeido ?? true]
    );
    if (chat.rows[0]) emitirPanel("chat", await chatParaPanel(chat.rows[0]));
  }
  emitirPanel("mensaje", mensajeParaPanel(fila));
  return fila;
}

/** Nota interna del sistema (solo la ve el panel, centrada). */
export function notaInterna(jid: string, texto: string) {
  return guardarMensaje({ jid, deMi: true, autor: "sistema", texto, interno: true, estado: "leido" });
}

/** Sube el estado (✓ → ✓✓ → azul) sin retroceder nunca. */
export async function actualizarEstadoMensaje(waId: string, estado: EstadoMensaje, error?: string) {
  const rangos = Object.entries(RANGO_ESTADO)
    .map(([e, n]) => `WHEN '${e}' THEN ${n}`)
    .join(" ");
  const r = await pool.query(
    `UPDATE wa_mensajes SET estado = $2, error = COALESCE($3, error)
     WHERE wa_id = $1 AND (CASE estado ${rangos} END) < (CASE $2::text ${rangos} END)
       AND NOT (estado = 'error' AND $2 <> 'error')
     RETURNING id, jid, wa_id, estado, error`,
    [waId, estado, error ?? null]
  );
  const fila = r.rows[0];
  if (fila) emitirPanel("estado", fila);
  return fila;
}

/** Marca error aunque esté "pendiente" (el ranking de arriba solo sube). */
export async function marcarErrorMensaje(waId: string, error: string) {
  const r = await pool.query(
    `UPDATE wa_mensajes SET estado = 'error', error = $2 WHERE wa_id = $1 AND estado = 'pendiente' RETURNING id, jid, wa_id, estado, error`,
    [waId, error]
  );
  if (r.rows[0]) emitirPanel("estado", r.rows[0]);
}

// ---------- Lo que ve el panel ----------
const SEGUNDOS_URL_MEDIA = 3600;

export function mensajeParaPanel(m: FilaMensaje) {
  let mediaUrl: string | null = null;
  if (m.media_key && m.media_mime) {
    try {
      mediaUrl = generarUrlTemporal(m.media_key, m.media_mime, SEGUNDOS_URL_MEDIA);
    } catch {
      mediaUrl = null; // Cloudinary sin configurar
    }
  }
  return {
    id: String(m.id),
    jid: m.jid,
    deMi: m.de_mi,
    autor: m.autor,
    tipo: m.tipo,
    texto: m.texto,
    mediaUrl,
    mediaMime: m.media_mime,
    estado: m.estado,
    error: m.error,
    interno: m.interno,
    fecha: m.created_at,
  };
}

export async function chatParaPanel(c: FilaChat) {
  let terceroNombre: string | null = null;
  if (c.tercero_id) {
    const r = await pool.query(`SELECT nombre FROM terceros WHERE id = $1`, [c.tercero_id]);
    terceroNombre = r.rows[0]?.nombre ?? null;
  }
  return {
    jid: c.jid,
    telefono: c.telefono,
    nombre: c.nombre_guardado ?? terceroNombre ?? c.nombre ?? `+${c.telefono}`,
    nombreWhatsapp: c.nombre,
    nombreGuardado: c.nombre_guardado,
    terceroId: c.tercero_id,
    terceroNombre,
    ultimoMensaje: c.ultimo_mensaje,
    ultimoMensajeEn: c.ultimo_mensaje_en,
    noLeidos: c.no_leidos,
    botActivo: c.bot_activo,
    necesitaHumano: c.necesita_humano,
    motivo: c.motivo,
    necesitaHumanoDesde: c.necesita_humano_desde,
    archivado: c.archivado,
    frio: c.ultimo_entrante_en === null,
  };
}

export type FiltroChats = "todos" | "no_leidos" | "atencion" | "bot" | "humano" | "archivados";

export async function listarChats(filtro: FiltroChats, busqueda: string | undefined, limite = 200) {
  const cond: string[] = [];
  const valores: unknown[] = [];
  if (filtro === "archivados") cond.push("c.archivado");
  else cond.push("NOT c.archivado");
  if (filtro === "no_leidos") cond.push("c.no_leidos > 0");
  if (filtro === "atencion") cond.push("c.necesita_humano");
  if (filtro === "bot") cond.push("c.bot_activo");
  if (filtro === "humano") cond.push("NOT c.bot_activo");
  if (busqueda?.trim()) {
    valores.push(`%${busqueda.trim()}%`);
    const p = `$${valores.length}`;
    cond.push(`(c.nombre ILIKE ${p} OR c.nombre_guardado ILIKE ${p} OR c.telefono ILIKE ${p} OR t.nombre ILIKE ${p}
               OR EXISTS (SELECT 1 FROM wa_mensajes m WHERE m.jid = c.jid AND m.texto ILIKE ${p}))`);
  }
  valores.push(limite);
  const r = await pool.query(
    `SELECT c.* FROM wa_chats c LEFT JOIN terceros t ON t.id = c.tercero_id
     WHERE ${cond.join(" AND ")}
     ORDER BY c.necesita_humano DESC, c.ultimo_mensaje_en DESC NULLS LAST
     LIMIT $${valores.length}`,
    valores
  );
  return Promise.all(r.rows.map(chatParaPanel));
}

export async function listarMensajes(jid: string, opciones: { antesDe?: string; busqueda?: string; limite?: number }) {
  const valores: unknown[] = [jid];
  const cond = ["jid = $1"];
  if (opciones.antesDe) {
    valores.push(opciones.antesDe);
    cond.push(`id < $${valores.length}`);
  }
  if (opciones.busqueda?.trim()) {
    valores.push(`%${opciones.busqueda.trim()}%`);
    cond.push(`texto ILIKE $${valores.length}`);
  }
  const limite = Math.min(opciones.limite ?? 50, 200);
  valores.push(limite + 1);
  const r = await pool.query(
    `SELECT * FROM wa_mensajes WHERE ${cond.join(" AND ")} ORDER BY id DESC LIMIT $${valores.length}`,
    valores
  );
  const hayMas = r.rows.length > limite;
  const filas: FilaMensaje[] = r.rows.slice(0, limite).reverse();
  return { mensajes: filas.map(mensajeParaPanel), hayMas };
}

export async function marcarLeido(jid: string) {
  await actualizarChat(jid, { no_leidos: 0 });
}
