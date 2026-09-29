import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  listarCuentasTercero,
  crearCuentaTercero,
  actualizarCuentaTercero,
  desactivarCuentaTercero,
} from "../services/cuentasTercero.service";

// Montado en /terceros
export const cuentasTerceroRouter = Router();

const textoOpcional = z.string().trim().min(1).nullable().optional();

const cuentaSchema = z.object({
  tipo: z.enum(["CUENTA_BANCARIA", "PAGO_MOVIL", "ZELLE", "NEQUI", "DAVIPLATA", "OTRO"]),
  monedaId: z.number().int().nullable().optional(),
  banco: textoOpcional,
  numeroCuenta: textoOpcional,
  tipoCuenta: z.enum(["AHORRO", "CORRIENTE"]).nullable().optional(),
  titular: z.string().trim().min(1),
  identificacionTitular: textoOpcional,
  telefono: textoOpcional,
  email: z.string().trim().email().nullable().optional(),
  alias: textoOpcional,
});

const actualizarCuentaSchema = cuentaSchema.partial().extend({ activo: z.boolean().optional() });

function parseId(valor: string | undefined) {
  const id = valor ? Number(valor) : NaN;
  return Number.isInteger(id) ? id : null;
}

cuentasTerceroRouter.get("/:terceroId/cuentas", requireAuth, async (req, res, next) => {
  try {
    const terceroId = parseId(req.params.terceroId);
    if (terceroId === null) return res.status(400).json({ error: "id inválido" });
    const incluirInactivas = req.query.incluirInactivas === "true";
    res.json(await listarCuentasTercero(terceroId, incluirInactivas));
  } catch (err) {
    next(err);
  }
});

cuentasTerceroRouter.post(
  "/:terceroId/cuentas",
  requireAuth,
  requireRole("ADMIN", "ASESOR", "CAJERO"),
  async (req, res, next) => {
    try {
      const terceroId = parseId(req.params.terceroId);
      if (terceroId === null) return res.status(400).json({ error: "id inválido" });
      const data = cuentaSchema.parse(req.body);
      res.status(201).json(await crearCuentaTercero(terceroId, data, req.user!.id));
    } catch (err) {
      next(err);
    }
  }
);

cuentasTerceroRouter.put(
  "/cuentas/:cuentaId",
  requireAuth,
  requireRole("ADMIN", "ASESOR", "CAJERO"),
  async (req, res, next) => {
    try {
      const cuentaId = parseId(req.params.cuentaId);
      if (cuentaId === null) return res.status(400).json({ error: "id inválido" });
      const data = actualizarCuentaSchema.parse(req.body);
      res.json(await actualizarCuentaTercero(cuentaId, data));
    } catch (err) {
      next(err);
    }
  }
);

cuentasTerceroRouter.delete("/cuentas/:cuentaId", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const cuentaId = parseId(req.params.cuentaId);
    if (cuentaId === null) return res.status(400).json({ error: "id inválido" });
    res.json(await desactivarCuentaTercero(cuentaId));
  } catch (err) {
    next(err);
  }
});
