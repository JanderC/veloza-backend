import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole } from "../middleware/auth";
import { crearCuentaPorPagar, registrarAbonoPagar } from "../services/cuentasPagar.service";

export const cuentasPorPagarRouter = Router();

const crearCuentaSchema = z.object({
  terceroId: z.number().int(),
  monedaId: z.number().int(),
  montoOriginal: z.string(),
});

cuentasPorPagarRouter.post("/", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const data = crearCuentaSchema.parse(req.body);
    const cuenta = await crearCuentaPorPagar(data);
    res.status(201).json(cuenta);
  } catch (err) {
    next(err);
  }
});

cuentasPorPagarRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const terceroIdParam = req.query.terceroId;
    const estadoParam = req.query.estado;

    const condiciones: string[] = [];
    const valores: unknown[] = [];

    if (typeof terceroIdParam === "string" && Number.isInteger(Number(terceroIdParam))) {
      valores.push(Number(terceroIdParam));
      condiciones.push(`cxp.tercero_id = $${valores.length}`);
    }
    if (typeof estadoParam === "string") {
      valores.push(estadoParam);
      condiciones.push(`cxp.estado = $${valores.length}`);
    }

    const where = condiciones.length > 0 ? `WHERE ${condiciones.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT cxp.*, t.nombre AS tercero_nombre, m.codigo AS moneda_codigo
       FROM cuentas_por_pagar cxp
       JOIN terceros t ON t.id = cxp.tercero_id
       JOIN monedas m ON m.id = cxp.moneda_id
       ${where}
       ORDER BY cxp.created_at DESC`,
      valores
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

cuentasPorPagarRouter.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

    const result = await pool.query(`SELECT * FROM cuentas_por_pagar WHERE id = $1`, [id]);
    const cuenta = result.rows[0];
    if (!cuenta) return res.status(404).json({ error: "Cuenta por pagar no encontrada" });
    res.json(cuenta);
  } catch (err) {
    next(err);
  }
});

const abonoSchema = z.object({
  monto: z.string(),
  cajaId: z.number().int(),
  metodoPagoId: z.number().int().optional(),
});

cuentasPorPagarRouter.post(
  "/:id/abonos",
  requireAuth,
  requireRole("ADMIN", "ASESOR", "CAJERO"),
  async (req, res, next) => {
    try {
      const idParam = req.params.id;
      const id = idParam ? Number(idParam) : NaN;
      if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

      const data = abonoSchema.parse(req.body);
      const resultado = await registrarAbonoPagar({
        cuentaPorPagarId: id,
        monto: data.monto,
        cajaId: data.cajaId,
        metodoPagoId: data.metodoPagoId,
        usuarioId: req.user!.id,
      });
      res.status(201).json(resultado);
    } catch (err) {
      next(err);
    }
  }
);