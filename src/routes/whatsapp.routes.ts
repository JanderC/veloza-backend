import { Router } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole, verificarToken } from "../middleware/auth";
import { subirArchivo } from "../services/almacenamiento.service";
import { obtenerVerificacionTercero } from "../services/documentosTercero.service";
import { suscribirPanel } from "../services/whatsapp/eventos";
import {
  cerrarSesion,
  estadoConexion,
  estadoLineas,
  iniciarConexion,
  pedirCodigoVinculacion,
  resetearSesion,
} from "../services/whatsapp/conexion";
import {
  actualizarChat,
  chatParaPanel,
  listarChats,
  listarMensajes,
  marcarLeido,
  noLeidosPorLinea,
  obtenerChat,
  type FiltroChats,
} from "../services/whatsapp/mensajes";
import { enviarMensaje, estadoCola } from "../services/whatsapp/envio";
import { devolverAlBot, listarEsperando, tomarControl } from "../services/whatsapp/atencion";
import { enviarInstruccionAlCliente, simular } from "../services/whatsapp/bot";
import { claveCotizacion, cotizacionesDelBot, registrarComprobante } from "../services/whatsapp/herramientas";
import { enlaceRecibirPorWhatsapp, listarOutbox, reintentarOutbox } from "../services/whatsapp/outbox";
import { CONFIG_POR_DEFECTO, claveDe, configSchema, guardarClave, guardarConfig, leerConfigParaPanel } from "../services/whatsapp/config";
import { detectarProveedor, listarModelos, PROVEEDORES, probarConexion, type Proveedor } from "../services/whatsapp/ia";
import { claveDeChat, esLinea, jidDeTelefono, telefonoDeJid, type Linea } from "../services/whatsapp/transporte";
import { asegurarChat } from "../services/whatsapp/mensajes";
import { leerSticker, STICKERS } from "../services/whatsapp/stickers";
import { actualizarRespuestaRapida, crearRespuestaRapida, eliminarRespuestaRapida, listarRespuestasRapidas, ordenarRespuestasRapidas } from "../services/whatsapp/respuestasRapidas";

export const whatsappRouter = Router();

// Leer y responder chats: también el cajero (es quien confirma las transferencias y le avisa al cliente)
const PANEL = requireRole("ADMIN", "ASESOR", "CAJERO");
const SOLO_ADMIN = requireRole("ADMIN");

const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function jidParam(valor: string | undefined) {
  const jid = decodeURIComponent(valor ?? "");
  // puede traer la línea al final: "...@s.whatsapp.net#2"
  // (los grupos son <id>@g.us; los viejos traen un guion en el id)
  if (!/^(\d{6,20}@(s\.whatsapp\.net|lid)|\d{6,30}(-\d{6,20})?@g\.us)(#[23])?$/.test(jid)) throw Object.assign(new Error("Chat inválido"), { status: 400 });
  return jid;
}

/** La línea (teléfono vinculado) de la que se habla: ?linea= o { linea } en el cuerpo. Sin dato, la 1. */
function lineaDe(req: { query: Record<string, unknown>; body?: unknown }): Linea {
  const cruda = req.query.linea ?? (req.body as { linea?: unknown } | undefined)?.linea;
  if (cruda === undefined || cruda === null || cruda === "") return 1;
  const n = Number(cruda);
  if (!esLinea(n)) throw Object.assign(new Error("Línea inválida"), { status: 400 });
  return n;
}

/** El estado de las tres líneas, con su cola de envío. El QR solo lo ve el administrador. */
function lineasParaPanel(esAdmin: boolean) {
  return estadoLineas().map((e) => ({ ...e, qr: esAdmin ? e.qr : null, cola: estadoCola(e.linea) }));
}

// ---------- Tiempo real (SSE). EventSource no manda cabeceras: el JWT va en ?token= ----------
whatsappRouter.get("/stream", (req, res) => {
  const usuario = typeof req.query.token === "string" ? verificarToken(req.query.token) : null;
  if (!usuario) return res.status(401).json({ error: "Token inválido o expirado" });
  if (!["ADMIN", "ASESOR", "CAJERO"].includes(usuario.rol)) return res.status(403).json({ error: "No tienes permiso para esta acción" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const enviar = (tipo: string, datos: unknown) => res.write(`event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`);
  // el estado de cada línea al conectar
  for (const e of estadoLineas()) enviar("conexion", { ...e, qr: usuario.rol === "ADMIN" ? e.qr : null });

  const desuscribir = suscribirPanel(({ tipo, datos }) => {
    if (tipo === "conexion" && usuario.rol !== "ADMIN") return enviar(tipo, { ...(datos as object), qr: null });
    enviar(tipo, datos);
  });
  const latido = setInterval(() => res.write(`: latido\n\n`), 20_000);
  req.on("close", () => {
    clearInterval(latido);
    desuscribir();
  });
});

// ---------- Conexión (solo admin). Cada acción es sobre una línea: ?linea=1|2|3 ----------
whatsappRouter.get("/estado", requireAuth, PANEL, (req, res, next) => {
  try {
    const linea = lineaDe(req);
    const e = estadoConexion(linea);
    res.json({ ...e, qr: req.user!.rol === "ADMIN" ? e.qr : null, cola: estadoCola(linea) });
  } catch (err) {
    next(err);
  }
});

// Las tres líneas de una vez, con los mensajes sin leer de cada una (campanita y pantalla de líneas)
whatsappRouter.get("/lineas", requireAuth, PANEL, async (req, res, next) => {
  try {
    const sinLeer = await noLeidosPorLinea();
    res.json(lineasParaPanel(req.user!.rol === "ADMIN").map((l) => ({ ...l, sinLeer: sinLeer[l.linea] })));
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/conexion/iniciar", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const linea = lineaDe(req);
    if (estadoConexion(linea).estado !== "CONECTADO") await iniciarConexion(linea);
    res.json(estadoConexion(linea));
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/conexion/reconectar", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const linea = lineaDe(req);
    await iniciarConexion(linea);
    res.json(estadoConexion(linea));
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/conexion/codigo", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const { numero } = z.object({ numero: z.string().min(10) }).parse(req.body);
    const codigo = await pedirCodigoVinculacion(numero, lineaDe(req));
    res.json({ codigo });
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/conexion/cerrar-sesion", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const linea = lineaDe(req);
    await cerrarSesion(linea);
    res.json(estadoConexion(linea));
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/conexion/reset", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const linea = lineaDe(req);
    await resetearSesion(linea);
    res.json(estadoConexion(linea));
  } catch (err) {
    next(err);
  }
});

// ---------- Chats y mensajes ----------
const FILTROS: FiltroChats[] = ["todos", "no_leidos", "atencion", "bot", "humano", "archivados", "grupos"];

whatsappRouter.get("/chats", requireAuth, PANEL, async (req, res, next) => {
  try {
    const filtro = FILTROS.includes(req.query.filtro as FiltroChats) ? (req.query.filtro as FiltroChats) : "todos";
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    // ?linea= deja solo los chats de ese teléfono; sin ella, los de las tres
    const linea = req.query.linea ? lineaDe(req) : undefined;
    res.json(await listarChats(filtro, q, 200, linea));
  } catch (err) {
    next(err);
  }
});

// El chat de un teléfono en una línea: lo devuelve si existe o lo crea vacío, para escribirle desde cualquier módulo.
// (Crear el chat no envía nada: el primer mensaje pasa por las mismas protecciones que todos.)
whatsappRouter.post("/chats/abrir", requireAuth, PANEL, async (req, res, next) => {
  try {
    const d = z.object({ telefono: z.string().min(8), linea: z.number().int().optional(), nombre: z.string().max(80).optional() }).parse(req.body);
    const linea = lineaDe({ query: {}, body: { linea: d.linea } });
    let digitos = d.telefono.replace(/\D/g, "").replace(/^00/, "");
    // celular colombiano o venezolano escrito sin código de país
    if (digitos.length === 10 && digitos.startsWith("3")) digitos = `57${digitos}`;
    if (digitos.length === 11 && digitos.startsWith("04")) digitos = `58${digitos.slice(1)}`;
    if (digitos.length < 10) return res.status(400).json({ error: "Número inválido: incluí el código de país" });
    const jid = claveDeChat(linea, jidDeTelefono(digitos));
    await asegurarChat(jid, d.nombre ?? null);
    const chat = await obtenerChat(jid);
    res.json(await chatParaPanel(chat!));
  } catch (err) {
    next(err);
  }
});

whatsappRouter.get("/chats/:jid/mensajes", requireAuth, PANEL, async (req, res, next) => {
  try {
    const jid = jidParam(req.params.jid);
    res.json(
      await listarMensajes(jid, {
        antesDe: typeof req.query.antesDe === "string" ? req.query.antesDe : undefined,
        busqueda: typeof req.query.q === "string" ? req.query.q : undefined,
      })
    );
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/chats/:jid/leer", requireAuth, PANEL, async (req, res, next) => {
  try {
    await marcarLeido(jidParam(req.params.jid));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const idMensaje = z.string().regex(/^\d{1,18}$/);

async function nombreUsuario(id: number) {
  const r = await pool.query(`SELECT nombre FROM usuarios WHERE id = $1`, [id]);
  return (r.rows[0]?.nombre as string | undefined) ?? "Un asesor";
}

// Si una persona escribe desde el panel toma el control: el bot se pausa en ese chat
whatsappRouter.post("/chats/:jid/mensajes", requireAuth, PANEL, async (req, res, next) => {
  try {
    const jid = jidParam(req.params.jid);
    // respondeA: el mensaje de este chat que se está contestando (sale citado)
    const { texto, respondeA } = z.object({ texto: z.string().trim().min(1).max(4000), respondeA: idMensaje.optional() }).parse(req.body);
    if (!(await obtenerChat(jid))) return res.status(404).json({ error: "Chat no encontrado" });
    await tomarControl(jid, await nombreUsuario(req.user!.id));
    const fila = await enviarMensaje({ jid, autor: "humano", texto, respondeA, usuarioId: req.user!.id, esperarEnvio: false });
    res.status(201).json({ id: String(fila.id) });
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/chats/:jid/imagen", requireAuth, PANEL, subida.single("archivo"), async (req, res, next) => {
  try {
    const jid = jidParam(req.params.jid);
    const archivo = req.file;
    if (!archivo || !["image/jpeg", "image/png", "image/webp"].includes(archivo.mimetype)) {
      return res.status(400).json({ error: "Enviá una foto JPG, PNG o WEBP" });
    }
    const texto = typeof req.body.texto === "string" && req.body.texto.trim() ? req.body.texto.trim() : undefined;
    const mediaKey = await subirArchivo(`whatsapp/${telefonoDeJid(jid)}`, randomUUID(), archivo.buffer, archivo.mimetype);
    await tomarControl(jid, await nombreUsuario(req.user!.id));
    const fila = await enviarMensaje({
      jid,
      autor: "humano",
      texto,
      imagen: { buffer: archivo.buffer, mime: archivo.mimetype, mediaKey },
      respondeA: typeof req.body.respondeA === "string" && /^\d{1,18}$/.test(req.body.respondeA) ? req.body.respondeA : null,
      usuarioId: req.user!.id,
      esperarEnvio: false,
    });
    res.status(201).json({ id: String(fila.id) });
  } catch (err) {
    next(err);
  }
});

// ---------- Respuestas rápidas: textos ya escritos que se ponen en el mensaje con un toque ----------
// Las ve todo el que atiende chats; las cargan y editan el admin y el asesor.
const EDITA_RAPIDAS = requireRole("ADMIN", "ASESOR");
const rapidaSchema = z.object({ titulo: z.string().trim().min(1, "Falta el título").max(60), texto: z.string().trim().min(1, "Falta el texto").max(4000) });

whatsappRouter.get("/respuestas-rapidas", requireAuth, PANEL, async (_req, res, next) => {
  try {
    res.json(await listarRespuestasRapidas());
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/respuestas-rapidas", requireAuth, EDITA_RAPIDAS, async (req, res, next) => {
  try {
    res.status(201).json(await crearRespuestaRapida(rapidaSchema.parse(req.body), req.user!.id));
  } catch (err) {
    next(err);
  }
});

whatsappRouter.put("/respuestas-rapidas/orden", requireAuth, EDITA_RAPIDAS, async (req, res, next) => {
  try {
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).max(500) }).parse(req.body);
    res.json(await ordenarRespuestasRapidas(ids));
  } catch (err) {
    next(err);
  }
});

whatsappRouter.put("/respuestas-rapidas/:id", requireAuth, EDITA_RAPIDAS, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    res.json(await actualizarRespuestaRapida(id, rapidaSchema.parse(req.body)));
  } catch (err) {
    next(err);
  }
});

whatsappRouter.delete("/respuestas-rapidas/:id", requireAuth, EDITA_RAPIDAS, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    await eliminarRespuestaRapida(id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Los stickers del negocio (los que se mandan al confirmar una transferencia)
whatsappRouter.get("/stickers", requireAuth, PANEL, (_req, res) => {
  res.json(STICKERS.map((s) => ({ id: s.id, nombre: s.nombre })));
});

// La imagen de un sticker, para mostrarlo en el selector
whatsappRouter.get("/stickers/:id", (req, res) => {
  const s = leerSticker(req.params.id ?? "");
  if (!s) return res.status(404).json({ error: "Sticker no encontrado" });
  res.set({ "Content-Type": "image/webp", "Cache-Control": "public, max-age=86400" }).send(s.buffer);
});

whatsappRouter.post("/chats/:jid/sticker", requireAuth, PANEL, async (req, res, next) => {
  try {
    const jid = jidParam(req.params.jid);
    const { sticker, respondeA } = z.object({ sticker: z.string().min(1).max(60), respondeA: idMensaje.optional() }).parse(req.body);
    const s = leerSticker(sticker);
    if (!s) return res.status(404).json({ error: "Sticker no encontrado" });
    if (!(await obtenerChat(jid))) return res.status(404).json({ error: "Chat no encontrado" });
    // se guarda una sola copia por sticker (misma clave siempre): así el panel puede mostrarlo en la conversación
    const mediaKey = await subirArchivo("whatsapp/stickers", s.id, s.buffer, "image/webp").catch(() => null);
    await tomarControl(jid, await nombreUsuario(req.user!.id));
    const fila = await enviarMensaje({ jid, autor: "humano", sticker: { buffer: s.buffer, mediaKey }, respondeA, usuarioId: req.user!.id, esperarEnvio: false });
    res.status(201).json({ id: String(fila.id) });
  } catch (err) {
    next(err);
  }
});

const actualizarChatSchema = z.object({
  nombreGuardado: z.string().trim().max(80).nullable().optional(),
  archivado: z.boolean().optional(),
  terceroId: z.number().int().nullable().optional(),
});

whatsappRouter.put("/chats/:jid", requireAuth, PANEL, async (req, res, next) => {
  try {
    const jid = jidParam(req.params.jid);
    const d = actualizarChatSchema.parse(req.body);
    const cambios: Parameters<typeof actualizarChat>[1] = {};
    if (d.nombreGuardado !== undefined) cambios.nombre_guardado = d.nombreGuardado || null;
    if (d.archivado !== undefined) cambios.archivado = d.archivado;
    if (d.terceroId !== undefined) cambios.tercero_id = d.terceroId;
    const chat = await actualizarChat(jid, cambios);
    if (!chat) return res.status(404).json({ error: "Chat no encontrado" });
    res.json(await chatParaPanel(chat));
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/chats/:jid/devolver-bot", requireAuth, PANEL, async (req, res, next) => {
  try {
    const chat = await devolverAlBot(jidParam(req.params.jid), await nombreUsuario(req.user!.id));
    if (!chat) return res.status(404).json({ error: "Chat no encontrado" });
    res.json(await chatParaPanel(chat));
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/chats/:jid/tomar", requireAuth, PANEL, async (req, res, next) => {
  try {
    const chat = await tomarControl(jidParam(req.params.jid), await nombreUsuario(req.user!.id));
    if (!chat) return res.status(404).json({ error: "Chat no encontrado" });
    res.json(await chatParaPanel(chat));
  } catch (err) {
    next(err);
  }
});

// "Dile al bot qué responder": lo redacta con sus palabras y el chat sigue con el bot
whatsappRouter.post("/chats/:jid/instruccion", requireAuth, PANEL, async (req, res, next) => {
  try {
    const jid = jidParam(req.params.jid);
    const { texto } = z.object({ texto: z.string().trim().min(2).max(1000) }).parse(req.body);
    const enviado = await enviarInstruccionAlCliente(jid, texto);
    await devolverAlBot(jid, await nombreUsuario(req.user!.id));
    res.json({ enviado });
  } catch (err) {
    next(err);
  }
});

// Panel lateral: datos del cliente y su historial en el negocio
whatsappRouter.get("/chats/:jid/cliente", requireAuth, PANEL, async (req, res, next) => {
  try {
    const chat = await obtenerChat(jidParam(req.params.jid));
    if (!chat) return res.status(404).json({ error: "Chat no encontrado" });
    if (!chat.tercero_id) return res.json({ chat: await chatParaPanel(chat), cliente: null, operaciones: [], cuentas: [] });
    const [cliente, operaciones, cuentas] = await Promise.all([
      pool.query(`SELECT id, nombre, identificacion, telefono, tipo, created_at FROM terceros WHERE id = $1`, [chat.tercero_id]),
      pool.query(
        `SELECT t.id, t.tipo, t.estado, t.monto_origen, t.monto_destino, t.created_at, t.origen,
                mo.codigo AS moneda_origen, md.codigo AS moneda_destino
         FROM transacciones t JOIN monedas mo ON mo.id = t.moneda_origen_id LEFT JOIN monedas md ON md.id = t.moneda_destino_id
         WHERE t.tercero_id = $1 ORDER BY t.id DESC LIMIT 10`,
        [chat.tercero_id]
      ),
      pool.query(`SELECT id, tipo, banco, numero_cuenta, titular FROM cuentas_tercero WHERE tercero_id = $1 AND activo ORDER BY id DESC`, [
        chat.tercero_id,
      ]),
    ]);
    res.json({
      chat: await chatParaPanel(chat),
      cliente: { ...cliente.rows[0], verificacion: await obtenerVerificacionTercero(chat.tercero_id) },
      operaciones: operaciones.rows,
      cuentas: cuentas.rows,
    });
  } catch (err) {
    next(err);
  }
});

// Botón "Este es el comprobante" en las fotos del cliente
whatsappRouter.post("/mensajes/:id/comprobante", requireAuth, PANEL, async (req, res, next) => {
  try {
    const id = req.params.id ?? "";
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id inválido" });
    const d = z
      .object({ monto: z.string().optional(), referencia: z.string().optional(), banco: z.string().optional() })
      .parse(req.body ?? {});
    const msg = (await pool.query(`SELECT jid FROM wa_mensajes WHERE id = $1 AND autor = 'cliente' AND tipo = 'imagen'`, [id])).rows[0];
    if (!msg) return res.status(404).json({ error: "Foto no encontrada" });
    const r = await registrarComprobante({
      jid: msg.jid,
      mensajeId: id,
      leido: { monto: d.monto ?? null, referencia: d.referencia ?? null, banco: d.banco ?? null },
      porBot: false,
      usuarioId: req.user!.id,
    });
    if ("error" in r) return res.status(409).json({ error: r.error });
    res.json(r);
  } catch (err) {
    next(err);
  }
});

whatsappRouter.get("/atencion", requireAuth, PANEL, async (_req, res, next) => {
  try {
    res.json(await listarEsperando());
  } catch (err) {
    next(err);
  }
});

// ---------- Envíos salientes (outbox) ----------
whatsappRouter.get("/outbox", requireAuth, PANEL, async (_req, res, next) => {
  try {
    res.json(await listarOutbox());
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/outbox/:id/reintentar", requireAuth, PANEL, async (req, res, next) => {
  try {
    await reintentarOutbox(req.params.id ?? "");
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// "Recibir por WhatsApp": link wa.me con el código de la operación (el cliente escribe primero)
whatsappRouter.get("/recibir/:txId", requireAuth, async (req, res, next) => {
  try {
    const txId = Number(req.params.txId);
    if (!Number.isInteger(txId)) return res.status(400).json({ error: "id inválido" });
    res.json(await enlaceRecibirPorWhatsapp(txId));
  } catch (err) {
    next(err);
  }
});

// ---------- Configuración de la IA (solo admin) ----------
whatsappRouter.get("/config", requireAuth, PANEL, async (req, res, next) => {
  try {
    const datos = await leerConfigParaPanel();
    // El asesor solo necesita las respuestas rápidas
    if (req.user!.rol !== "ADMIN") return res.json({ config: { panel: datos.config.panel }, claves: {} });
    res.json({ ...datos, porDefecto: CONFIG_POR_DEFECTO });
  } catch (err) {
    next(err);
  }
});

whatsappRouter.put("/config", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    res.json(await guardarConfig(configSchema.parse(req.body)));
  } catch (err) {
    next(err);
  }
});

const proveedorSchema = z.enum(PROVEEDORES as [Proveedor, ...Proveedor[]]);

whatsappRouter.put("/config/clave", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const d = z.object({ proveedor: proveedorSchema.optional(), clave: z.string() }).parse(req.body);
    const proveedor = d.proveedor ?? detectarProveedor(d.clave);
    if (!proveedor) return res.status(400).json({ error: "No se reconoce el proveedor de esa clave: elegilo a mano" });
    res.json({ proveedor, ...(await guardarClave(proveedor, d.clave)) });
  } catch (err) {
    next(err);
  }
});

whatsappRouter.get("/ia/modelos", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const proveedor = proveedorSchema.parse(req.query.proveedor);
    const clave = await claveDe(proveedor);
    if (!clave) return res.status(400).json({ error: `Primero guarda la API key de ${proveedor}` });
    res.json(await listarModelos(proveedor, clave));
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/ia/probar", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const d = z.object({ proveedor: proveedorSchema, modelo: z.string().min(1) }).parse(req.body);
    const clave = await claveDe(d.proveedor);
    if (!clave) return res.status(400).json({ error: `Primero guarda la API key de ${d.proveedor}` });
    try {
      res.json(await probarConexion(d.proveedor, clave, d.modelo));
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message });
    }
  } catch (err) {
    next(err);
  }
});

const simularSchema = z.object({
  historial: z.array(z.object({ rol: z.enum(["cliente", "bot", "sistema"]), texto: z.string() })).min(1),
  estado: z.record(z.string(), z.unknown()).optional(),
  registrado: z.boolean().optional(),
});

whatsappRouter.post("/ia/simular", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const d = simularSchema.parse(req.body);
    res.json(await simular({ historial: d.historial, estado: d.estado as never, registrado: d.registrado }));
  } catch (err) {
    next(err);
  }
});

// Datos para la pantalla de configuración: cotizaciones vigentes y cuentas de la empresa
whatsappRouter.get("/config/opciones", requireAuth, SOLO_ADMIN, async (_req, res, next) => {
  try {
    const { config } = await leerConfigParaPanel();
    const cotizaciones = await cotizacionesDelBot({ ...config, negocio: { ...config.negocio, cotizacionesPermitidas: [] } });
    const cajas = await pool.query(
      `SELECT c.id, c.nombre, c.banco, c.numero_cuenta, m.codigo AS moneda FROM cajas c LEFT JOIN monedas m ON m.id = c.moneda_id
       WHERE c.activo AND c.tipo = 'BANCO' ORDER BY c.nombre`
    );
    const monedas = await pool.query(`SELECT codigo, nombre FROM monedas WHERE activo ORDER BY id`);
    res.json({
      cotizaciones: cotizaciones.map((c) => ({ ...c, clave: claveCotizacion(c) })),
      cajas: cajas.rows,
      monedas: monedas.rows,
    });
  } catch (err) {
    next(err);
  }
});
