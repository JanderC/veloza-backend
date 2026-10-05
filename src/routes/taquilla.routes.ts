import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { abrirSesionTaquilla, cerrarSesionTaquilla, moverCajaTaquilla, obtenerTaquilla, pagarSolicitud } from "../services/taquilla.service";

export const taquillaRouter = Router();
const ROLES = requireRole("ADMIN", "ASESOR", "CAJERO");
const porMoneda = z.object({ COP: z.string().optional(), USD: z.string().optional(), EUR: z.string().optional() });

// La caja con su sesión, las solicitudes por pagar, las pagadas y el último cuadre
taquillaRouter.get("/", requireAuth, ROLES, async (_req, res, next) => {
  try {
    res.json(await obtenerTaquilla());
  } catch (err) {
    next(err);
  }
});

// Abrir la caja: con cuánto efectivo arranca en cada moneda
taquillaRouter.post("/sesion/abrir", requireAuth, ROLES, async (req, res, next) => {
  try {
    const { montos } = z.object({ montos: porMoneda }).parse(req.body);
    res.status(201).json(await abrirSesionTaquilla({ montos, usuarioId: req.user!.id }));
  } catch (err) {
    next(err);
  }
});

// Cerrar y cuadrar: lo contado en cada moneda contra lo que debía haber
taquillaRouter.post("/sesion/cerrar", requireAuth, ROLES, async (req, res, next) => {
  try {
    const { contado } = z.object({ contado: porMoneda }).parse(req.body);
    res.json(await cerrarSesionTaquilla({ contado, usuarioId: req.user!.id }));
  } catch (err) {
    next(err);
  }
});

// Sumar (+) o descontar (-) efectivo de la caja con la sesión abierta
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
