import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { cargarSaldoBanco, crearCuentaBanco, guardarCuadre, listarCuadres, obtenerCuadre, obtenerDatosDelSistema } from "../services/capital.service";

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

// Cuentas de banco de la empresa: crear una y cargarle su saldo real
capitalRouter.post("/bancos", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const d = z.object({ nombre: z.string().trim().min(2).max(80), moneda: z.enum(["COP", "VES", "USD", "USDT", "EUR"]) }).parse(req.body);
    res.status(201).json(await crearCuentaBanco(d.nombre, d.moneda));
  } catch (err) {
    next(err);
  }
});

capitalRouter.post("/bancos/:id/saldo", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    const d = z.object({ moneda: z.enum(["COP", "VES", "USD", "USDT", "EUR"]), saldo: z.string().regex(/^-?\d+(\.\d+)?$/, "El saldo no es un número válido") }).parse(req.body);
    res.json(await cargarSaldoBanco(id, d.moneda, d.saldo, req.user!.id));
  } catch (err) {
    next(err);
  }
});
