import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { obtenerCajaFuerte, registrarMovimientoCajaFuerte } from "../services/cajaFuerte.service";

export const cajaFuerteRouter = Router();
// La ven administración y caja; solo administración ingresa o egresa dinero
const VER = requireRole("ADMIN", "CAJERO");
const MOVER = requireRole("ADMIN");

const filtrosSchema = z.object({
  pagina: z.coerce.number().int().min(1).optional(),
  porPagina: z.coerce.number().int().min(5).max(100).optional(),
  moneda: z.enum(["USD", "COP", "EUR"]).optional(),
  tipo: z.enum(["INGRESO", "EGRESO"]).optional(),
  cajaId: z.coerce.number().int().optional(),
});

// Saldos en dólares, pesos y euros, lo de hoy y los movimientos paginados
cajaFuerteRouter.get("/", requireAuth, VER, async (req, res, next) => {
  try {
    res.json(await obtenerCajaFuerte(filtrosSchema.parse(req.query)));
  } catch (err) {
    next(err);
  }
});

// Ingresar o egresar dinero, con su concepto
cajaFuerteRouter.post("/movimientos", requireAuth, MOVER, async (req, res, next) => {
  try {
    const datos = z
      .object({ tipo: z.enum(["INGRESO", "EGRESO"]), monedaCodigo: z.enum(["USD", "COP", "EUR"]), monto: z.string(), concepto: z.string().max(300), porPagina: z.number().int().optional() })
      .parse(req.body);
    await registrarMovimientoCajaFuerte({ ...datos, usuarioId: req.user!.id });
    // vuelve la primera página, con el movimiento nuevo arriba
    res.status(201).json(await obtenerCajaFuerte({ porPagina: datos.porPagina }));
  } catch (err) {
    next(err);
  }
});
