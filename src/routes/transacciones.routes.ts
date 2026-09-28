import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  registrarTransaccion,
  obtenerSolicitudesPendientes,
  confirmarTransaccion,
  rechazarTransaccion,
  obtenerTransacciones, 
  registrarCambioDivisa 
} from "../services/transaccionService";

export const transaccionesRouter = Router();

const registrarSchema = z.object({
  tipo: z.enum(["COMPRA_DIVISA", "VENTA_DIVISA", "DEPOSITO", "RETIRO"]),
  cajaId: z.number().int(),
  terceroId: z.number().int().optional(),
  monedaOrigenId: z.number().int(),
  montoOrigen: z.string(),
  monedaDestinoId: z.number().int().optional(),
  tasaCambioId: z.number().int().optional(),
  metodoPagoId: z.number().int().optional(),
  referenciaCodigo: z.string().optional(),
  bancoOrigen: z.string().optional(),
});

transaccionesRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const { desde, hasta, monedaId, cajaId, estado, tipo } = req.query;
    const data = await obtenerTransacciones({
      desde: typeof desde === "string" ? desde : undefined,
      hasta: typeof hasta === "string" ? hasta : undefined,
      monedaId: typeof monedaId === "string" && Number.isInteger(Number(monedaId)) ? Number(monedaId) : undefined,
      cajaId: typeof cajaId === "string" && Number.isInteger(Number(cajaId)) ? Number(cajaId) : undefined,
      estado: typeof estado === "string" ? estado : undefined,
      tipo: typeof tipo === "string" ? tipo : undefined,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

transaccionesRouter.get("/solicitudes", requireAuth, async (req, res, next) => {
  try {
    const cajaIdParam = req.query.cajaId;
    const terceroIdParam = req.query.terceroId;
    const cajaId = typeof cajaIdParam === "string" && Number.isInteger(Number(cajaIdParam)) ? Number(cajaIdParam) : undefined;
    const terceroId = typeof terceroIdParam === "string" && Number.isInteger(Number(terceroIdParam)) ? Number(terceroIdParam) : undefined;
    const data = await obtenerSolicitudesPendientes({ cajaId, terceroId });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

transaccionesRouter.post(
  "/:id/confirmar",
  requireAuth,
  requireRole("ADMIN", "ASESOR", "CAJERO"),
  async (req, res, next) => {
    try {
      const idParam = req.params.id;
      const id = idParam ? Number(idParam) : NaN;
      if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

      const resultado = await confirmarTransaccion(id, req.user!.id);
      res.json(resultado);
    } catch (err) {
      next(err);
    }
  }
);

const rechazarSchema = z.object({ motivo: z.string().optional() });

transaccionesRouter.post(
  "/:id/rechazar",
  requireAuth,
  requireRole("ADMIN", "ASESOR", "CAJERO"),
  async (req, res, next) => {
    try {
      const idParam = req.params.id;
      const id = idParam ? Number(idParam) : NaN;
      if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

      const { motivo } = rechazarSchema.parse(req.body);
      const resultado = await rechazarTransaccion(id, req.user!.id, motivo);
      res.json(resultado);
    } catch (err) {
      next(err);
    }
  }
);


const registrarCambioSchema = z.object({
  tipo: z.enum(["COMPRA_DIVISA", "VENTA_DIVISA"]),
  terceroId: z.number().int().optional(),
  monedaExtranjeraId: z.number().int(),
  cantidadExtranjera: z.string(),
  cotizacionDetalleId: z.number().int().optional(),
  tasaManual: z.string().optional(),
  cajaExtranjeraId: z.number().int(),
  monedaLocalId: z.number().int(),
  cajaLocalId: z.number().int(),
  metodoPagoId: z.number().int().optional(),
  referenciaCodigo: z.string().optional(),
  bancoOrigen: z.string().optional(),
});

transaccionesRouter.post("/cambio", requireAuth, requireRole("ADMIN", "CAJERO", "ASESOR"), async (req, res, next) => {
  try {
    const data = registrarCambioSchema.parse(req.body);
    const resultado = await registrarCambioDivisa({ ...data, usuarioId: req.user!.id });
    res.status(201).json(resultado);
  } catch (err) {
    next(err);
  }
});