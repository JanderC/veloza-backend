import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { moverCajaTaquilla, obtenerTaquilla, pagarSolicitud } from "../services/taquilla.service";

export const taquillaRouter = Router();
const ROLES = requireRole("ADMIN", "ASESOR", "CAJERO");

// La caja de taquilla, las solicitudes confirmadas por pagar y las pagadas hoy
taquillaRouter.get("/", requireAuth, ROLES, async (_req, res, next) => {
  try {
    res.json(await obtenerTaquilla());
  } catch (err) {
    next(err);
  }
});

// Sumar (+) o descontar (-) efectivo de la caja de taquilla
taquillaRouter.post("/caja", requireAuth, ROLES, async (req, res, next) => {
  try {
    const datos = z.object({ monedaCodigo: z.enum(["COP", "USD", "EUR"]), monto: z.string() }).parse(req.body);
    res.status(201).json(await moverCajaTaquilla({ ...datos, usuarioId: req.user!.id }));
  } catch (err) {
    next(err);
  }
});

// "Se pagó": descuenta de la caja y salda la cuenta del cliente
taquillaRouter.post("/solicitudes/:id/pagar", requireAuth, ROLES, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    res.json(await pagarSolicitud(id, req.user!.id));
  } catch (err) {
    next(err);
  }
});
