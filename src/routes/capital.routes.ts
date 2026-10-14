import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { guardarCuadre, listarCuadres, obtenerCuadre, obtenerDatosDelSistema } from "../services/capital.service";

export const capitalRouter = Router();
// El capital de giros lo ve y lo llena solo el administrador
const SOLO_ADMIN = requireRole("ADMIN");

// Lo que el sistema ya sabe: saldos de las cajas y confirmaciones sin pagar
capitalRouter.get("/sistema", requireAuth, SOLO_ADMIN, async (_req, res, next) => {
  try {
    res.json(await obtenerDatosDelSistema());
  } catch (err) {
    next(err);
  }
});

capitalRouter.get("/cuadres", requireAuth, SOLO_ADMIN, async (_req, res, next) => {
  try {
    res.json(await listarCuadres());
  } catch (err) {
    next(err);
  }
});

capitalRouter.get("/cuadres/:id", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    res.json(await obtenerCuadre(id));
  } catch (err) {
    next(err);
  }
});

const cuadreSchema = z.object({
  datos: z.record(z.unknown()),
  capitalCop: z.number().finite(),
  capitalDivisa: z.number().finite(),
  capitalDivisaCop: z.number().finite(),
  nota: z.string().max(500).optional(),
});

capitalRouter.post("/cuadres", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    res.status(201).json(await guardarCuadre(cuadreSchema.parse(req.body), req.user!.id));
  } catch (err) {
    next(err);
  }
});
