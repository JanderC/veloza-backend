import { Router } from "express";
import { notificarResultadoTransaccion } from "../services/whatsapp/outbox";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  registrarTransaccion,
  obtenerSolicitudesPendientes,
  confirmarTransaccion,
  rechazarTransaccion,
  obtenerTransacciones,
  registrarCambioDivisa,
  calcularCambio,
  calculoAJson,
} from "../services/transaccionService";
import { pool } from "../db/pool";
import { obtenerDetalleSolicitud } from "../services/solicitudes.service";

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

// Detalle completo para revisar una solicitud antes de confirmarla o rechazarla
transaccionesRouter.get("/:id/detalle", requireAuth, requireRole("ADMIN", "ASESOR", "CAJERO"), async (req, res, next) => {
  try {
    const id = req.params.id ? Number(req.params.id) : NaN;
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    res.json(await obtenerDetalleSolicitud(id));
  } catch (err) {
    next(err);
  }
});

const confirmarSchema = z
  .object({
    montoVerificado: z.string().trim().min(1).optional(),
    checklist: z.array(z.string().max(120)).max(20).optional(),
    nota: z.string().max(500).optional(),
  })
  .optional();

transaccionesRouter.post(
  "/:id/confirmar",
  requireAuth,
  requireRole("ADMIN", "ASESOR", "CAJERO"),
  async (req, res, next) => {
    try {
      const idParam = req.params.id;
      const id = idParam ? Number(idParam) : NaN;
      if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

      const verificacion = confirmarSchema.parse(req.body ?? undefined);
      const resultado = await confirmarTransaccion(id, req.user!.id, verificacion);
      // Aviso al cliente por WhatsApp: va a la outbox, nunca en esta misma petición
      notificarResultadoTransaccion(id, req.user!.id).catch((e) => console.error("[wa] aviso de confirmación", e));
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
      notificarResultadoTransaccion(id, req.user!.id).catch((e) => console.error("[wa] aviso de rechazo", e));
      res.json(resultado);
    } catch (err) {
      next(err);
    }
  }
);


// Montos y tasas viajan como string para no perder precisión en JSON
const decimalPositivo = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, "Debe ser un número positivo con punto decimal, ej. 3.2")
  .refine((v) => Number(v) > 0, "Debe ser mayor a cero");

// El cliente trae divisa -> mandar cantidadExtranjera (se MULTIPLICA por la tasa).
// El cliente trae pesos  -> mandar montoLocal (se DIVIDE por la tasa).
const calculoCambioSchema = z
  .object({
    tipo: z.enum(["COMPRA_DIVISA", "VENTA_DIVISA"]),
    monedaExtranjeraId: z.number().int(),
    monedaLocalId: z.number().int(),
    cantidadExtranjera: decimalPositivo.optional(),
    montoLocal: decimalPositivo.optional(),
    cotizacionDetalleId: z.number().int().optional(),
    tasaManual: decimalPositivo.optional(),
  })
  .refine((d) => (d.cantidadExtranjera === undefined) !== (d.montoLocal === undefined), {
    message: "Indicá exactamente uno: cantidadExtranjera (multiplica) o montoLocal (divide)",
    path: ["montoLocal"],
  })
  .refine((d) => d.cotizacionDetalleId !== undefined || d.tasaManual !== undefined, {
    message: "Indicá cotizacionDetalleId (tasa del día) o tasaManual",
    path: ["tasaManual"],
  });

const registrarCambioSchema = calculoCambioSchema.and(
  z.object({
    terceroId: z.number().int().optional(),
    cuentaTerceroId: z.number().int().optional(), // cuenta del cliente a donde se le paga
    cajaExtranjeraId: z.number().int(),
    cajaLocalId: z.number().int(),
    metodoPagoId: z.number().int().optional(),
    referenciaCodigo: z.string().optional(),
    bancoOrigen: z.string().optional(),
  })
);

// Solo calcula (no guarda nada): para mostrarle a la cajera el resultado antes de registrar
transaccionesRouter.post(
  "/cambio/calcular",
  requireAuth,
  requireRole("ADMIN", "CAJERO", "ASESOR"),
  async (req, res, next) => {
    try {
      const data = calculoCambioSchema.parse(req.body);
      const calculo = await calcularCambio(pool, data);
      res.json(calculoAJson(calculo));
    } catch (err) {
      next(err);
    }
  }
);

transaccionesRouter.post("/cambio", requireAuth, requireRole("ADMIN", "CAJERO", "ASESOR"), async (req, res, next) => {
  try {
    const data = registrarCambioSchema.parse(req.body);
    const resultado = await registrarCambioDivisa({ ...data, usuarioId: req.user!.id });
    res.status(201).json(resultado);
  } catch (err) {
    next(err);
  }
});
