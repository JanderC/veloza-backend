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
import { telefonoDeJid } from "../services/whatsapp/transporte";

export const whatsappRouter = Router();

const PANEL = requireRole("ADMIN", "ASESOR");
const SOLO_ADMIN = requireRole("ADMIN");

const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function jidParam(valor: string | undefined) {
  const jid = decodeURIComponent(valor ?? "");
  if (!/^\d{6,20}@(s\.whatsapp\.net|lid)$/.test(jid)) throw Object.assign(new Error("Chat inválido"), { status: 400 });
  return jid;
}

// ---------- Tiempo real (SSE). EventSource no manda cabeceras: el JWT va en ?token= ----------
whatsappRouter.get("/stream", (req, res) => {
  const usuario = typeof req.query.token === "string" ? verificarToken(req.query.token) : null;
  if (!usuario) return res.status(401).json({ error: "Token inválido o expirado" });
  if (!["ADMIN", "ASESOR"].includes(usuario.rol)) return res.status(403).json({ error: "No tienes permiso para esta acción" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const enviar = (tipo: string, datos: unknown) => res.write(`event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`);
  enviar("conexion", { ...estadoConexion(), qr: usuario.rol === "ADMIN" ? estadoConexion().qr : null });

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

// ---------- Conexión (solo admin) ----------
whatsappRouter.get("/estado", requireAuth, PANEL, (req, res) => {
  const e = estadoConexion();
  res.json({ ...e, qr: req.user!.rol === "ADMIN" ? e.qr : null, cola: estadoCola() });
});

whatsappRouter.post("/conexion/iniciar", requireAuth, SOLO_ADMIN, async (_req, res, next) => {
  try {
    if (estadoConexion().estado !== "CONECTADO") await iniciarConexion();
    res.json(estadoConexion());
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/conexion/reconectar", requireAuth, SOLO_ADMIN, async (_req, res, next) => {
  try {
    await iniciarConexion();
    res.json(estadoConexion());
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/conexion/codigo", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const { numero } = z.object({ numero: z.string().min(10) }).parse(req.body);
    const codigo = await pedirCodigoVinculacion(numero);
    res.json({ codigo });
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/conexion/cerrar-sesion", requireAuth, SOLO_ADMIN, async (_req, res, next) => {
  try {
    await cerrarSesion();
    res.json(estadoConexion());
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/conexion/reset", requireAuth, SOLO_ADMIN, async (_req, res, next) => {
  try {
    await resetearSesion();
    res.json(estadoConexion());
  } catch (err) {
    next(err);
  }
});

// ---------- Chats y mensajes ----------
const FILTROS: FiltroChats[] = ["todos", "no_leidos", "atencion", "bot", "humano", "archivados"];

whatsappRouter.get("/chats", requireAuth, PANEL, async (req, res, next) => {
  try {
    const filtro = FILTROS.includes(req.query.filtro as FiltroChats) ? (req.query.filtro as FiltroChats) : "todos";
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json(await listarChats(filtro, q));
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

async function nombreUsuario(id: number) {
  const r = await pool.query(`SELECT nombre FROM usuarios WHERE id = $1`, [id]);
  return (r.rows[0]?.nombre as string | undefined) ?? "Un asesor";
}

// Si una persona escribe desde el panel toma el control: el bot se pausa en ese chat
whatsappRouter.post("/chats/:jid/mensajes", requireAuth, PANEL, async (req, res, next) => {
  try {
    const jid = jidParam(req.params.jid);
    const { texto } = z.object({ texto: z.string().trim().min(1).max(4000) }).parse(req.body);
    if (!(await obtenerChat(jid))) return res.status(404).json({ error: "Chat no encontrado" });
    await tomarControl(jid, await nombreUsuario(req.user!.id));
    const fila = await enviarMensaje({ jid, autor: "humano", texto, usuarioId: req.user!.id, esperarEnvio: false });
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
      usuarioId: req.user!.id,
      esperarEnvio: false,
    });
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
