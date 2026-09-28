import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  iniciarSesionWhatsapp,
  obtenerEstadoWhatsapp,
  obtenerMensajesWhatsapp,
  marcarMensajeWhatsapp,
  obtenerConfiguracionWhatsapp,
  actualizarConfiguracionWhatsapp,
} from "../services/whatsapp.service";

export const whatsappRouter = Router();

whatsappRouter.get("/estado", requireAuth, requireRole("ADMIN", "ASESOR"), async (_req, res, next) => {
  try {
    res.json(obtenerEstadoWhatsapp());
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post("/iniciar", requireAuth, requireRole("ADMIN"), async (_req, res, next) => {
  try {
    const resultado = await iniciarSesionWhatsapp();
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

whatsappRouter.get("/mensajes", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const estado = typeof req.query.estado === "string" ? req.query.estado : undefined;
    const datos = await obtenerMensajesWhatsapp(estado);
    res.json(datos);
  } catch (err) {
    next(err);
  }
});

const marcarSchema = z.object({
  estado: z.enum(["CONVERTIDO", "DESCARTADO"]),
  terceroId: z.number().int().optional(),
});

whatsappRouter.put("/mensajes/:id", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

    const { estado, terceroId } = marcarSchema.parse(req.body);
    const mensaje = await marcarMensajeWhatsapp(id, estado, terceroId);
    res.json(mensaje);
  } catch (err) {
    next(err);
  }
});

whatsappRouter.get("/configuracion", requireAuth, requireRole("ADMIN"), async (_req, res, next) => {
  try {
    res.json(await obtenerConfiguracionWhatsapp());
  } catch (err) {
    next(err);
  }
});

const configSchema = z.object({
  activa: z.boolean(),
  mensaje: z.string().min(1),
});

whatsappRouter.put("/configuracion", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const { activa, mensaje } = configSchema.parse(req.body);
    res.json(await actualizarConfiguracionWhatsapp(activa, mensaje));
  } catch (err) {
    next(err);
  }
});