import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { actualizarMetodoPago, crearMetodoPago, listarMetodosPago } from "../services/metodosPago.service";

export const metodosPagoRouter = Router();

// ?incluirInactivos=true (solo admin) para la pantalla de configuración
metodosPagoRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const incluirInactivos = req.query.incluirInactivos === "true" && req.user!.rol === "ADMIN";
    res.json(await listarMetodosPago({ incluirInactivos }));
  } catch (err) {
    next(err);
  }
});

const crearSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio").max(80),
  cuentaId: z.number().int().nullable().optional(),
});

metodosPagoRouter.post("/", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const data = crearSchema.parse(req.body);
    res.status(201).json(await crearMetodoPago(data));
  } catch (err) {
    next(err);
  }
});

const actualizarSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio").max(80).optional(),
  cuentaId: z.number().int().nullable().optional(),
  activo: z.boolean().optional(),
});

metodosPagoRouter.put("/:id", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const id = req.params.id ? Number(req.params.id) : NaN;
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    const data = actualizarSchema.parse(req.body);
    res.json(await actualizarMetodoPago(id, data));
  } catch (err) {
    next(err);
  }
});
