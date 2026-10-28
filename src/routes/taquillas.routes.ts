import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { crearTaquilla, editarTaquilla, listarTaquillas } from "../services/taquillas.service";

// Las taquillas como módulos: la lista la ven los que trabajan en taquilla; crearlas y habilitarlas, el administrador
export const taquillasRouter = Router();

taquillasRouter.get("/", requireAuth, requireRole("ADMIN", "ASESOR", "CAJERO"), async (_req, res, next) => {
  try {
    res.json(await listarTaquillas());
  } catch (err) {
    next(err);
  }
});

taquillasRouter.post("/", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const d = z.object({ nombre: z.string().max(80).optional() }).parse(req.body ?? {});
    res.status(201).json(await crearTaquilla(d.nombre));
  } catch (err) {
    next(err);
  }
});

taquillasRouter.patch("/:numero", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const numero = Number(req.params.numero);
    if (!Number.isInteger(numero) || numero <= 0) return res.status(400).json({ error: "número inválido" });
    const d = z.object({ nombre: z.string().max(80).optional(), activo: z.boolean().optional() }).parse(req.body);
    res.json(await editarTaquilla(numero, d));
  } catch (err) {
    next(err);
  }
});
