import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole } from "../middleware/auth";
import { abrirCaja, cerrarCaja, obtenerCierreAbierto } from "../services/cierreCaja.service";

export const cierreCajaRouter = Router();

const abrirSchema = z.object({
  cajaId: z.number().int(),
  monedaId: z.number().int(),
});

cierreCajaRouter.post("/abrir", requireAuth, requireRole("ADMIN", "CAJERO", "ASESOR"), async (req, res, next) => {
  try {
    const data = abrirSchema.parse(req.body);
    const cierre = await abrirCaja({ ...data, usuarioId: req.user!.id });
    res.status(201).json(cierre);
  } catch (err) {
    next(err);
  }
});

const cerrarSchema = z.object({
  saldoReal: z.string(),
});

cierreCajaRouter.post("/:id/cerrar", requireAuth, requireRole("ADMIN", "CAJERO", "ASESOR"), async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

    const data = cerrarSchema.parse(req.body);
    const cierre = await cerrarCaja({ cierreId: id, saldoReal: data.saldoReal, usuarioId: req.user!.id });
    res.json(cierre);
  } catch (err) {
    next(err);
  }
});

cierreCajaRouter.get("/abierto", requireAuth, async (req, res, next) => {
  try {
    const cajaIdParam = req.query.cajaId;
    const monedaIdParam = req.query.monedaId;
    const cajaId = typeof cajaIdParam === "string" ? Number(cajaIdParam) : NaN;
    const monedaId = typeof monedaIdParam === "string" ? Number(monedaIdParam) : NaN;

    if (!Number.isInteger(cajaId) || !Number.isInteger(monedaId)) {
      return res.status(400).json({ error: "Se requieren cajaId y monedaId" });
    }

    const cierre = await obtenerCierreAbierto(cajaId, monedaId);
    if (!cierre) return res.status(404).json({ error: "No hay turno abierto para esa caja y moneda" });
    res.json(cierre);
  } catch (err) {
    next(err);
  }
});

cierreCajaRouter.get("/abierto", requireAuth, async (req, res, next) => {
  try {
    const cajaIdParam = req.query.cajaId;
    const monedaIdParam = req.query.monedaId;
    const cajaId = typeof cajaIdParam === "string" ? Number(cajaIdParam) : NaN;
    const monedaId = typeof monedaIdParam === "string" ? Number(monedaIdParam) : NaN;

    if (!Number.isInteger(cajaId) || !Number.isInteger(monedaId)) {
      return res.status(400).json({ error: "Se requieren cajaId y monedaId" });
    }

    const cierre = await obtenerCierreAbierto(cajaId, monedaId);
    if (!cierre) return res.status(404).json({ error: "No hay turno abierto para esa caja y moneda" });
    res.json(cierre);
  } catch (err) {
    next(err);
  }
});

cierreCajaRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const cajaIdParam = req.query.cajaId;
    const condiciones: string[] = [];
    const valores: unknown[] = [];

    if (typeof cajaIdParam === "string" && Number.isInteger(Number(cajaIdParam))) {
      valores.push(Number(cajaIdParam));
      condiciones.push(`cc.caja_id = $${valores.length}`);
    }

    const where = condiciones.length > 0 ? `WHERE ${condiciones.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT cc.*, c.nombre AS caja_nombre, m.codigo AS moneda_codigo, u.nombre AS usuario_nombre
       FROM cierres_caja cc
       JOIN cajas c ON c.id = cc.caja_id
       JOIN monedas m ON m.id = cc.moneda_id
       JOIN usuarios u ON u.id = cc.usuario_id
       ${where}
       ORDER BY cc.fecha_apertura DESC`,
      valores
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});