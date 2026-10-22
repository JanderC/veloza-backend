import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { atenderSolicitud, contarSolicitudes, listarSolicitudes } from "../services/solicitudesWa.service";

// Atención de Solicitudes: la bandeja de lo que piden los clientes por WhatsApp
export const solicitudesWaRouter = Router();
const ATIENDEN = requireRole("ADMIN", "ASESOR", "CAJERO");

solicitudesWaRouter.get("/", requireAuth, ATIENDEN, async (req, res, next) => {
  try {
    const estado = req.query.estado === "ATENDIDA" ? "ATENDIDA" : "PENDIENTE";
    res.json(await listarSolicitudes(estado));
  } catch (err) {
    next(err);
  }
});

solicitudesWaRouter.get("/contador", requireAuth, ATIENDEN, async (_req, res, next) => {
  try {
    res.json(await contarSolicitudes());
  } catch (err) {
    next(err);
  }
});

solicitudesWaRouter.post("/:id/atender", requireAuth, ATIENDEN, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    const { nota, descartar } = z.object({ nota: z.string().max(300).optional(), descartar: z.boolean().optional() }).parse(req.body ?? {});
    res.json(await atenderSolicitud(id, req.user!.id, nota, descartar));
  } catch (err) {
    next(err);
  }
});
