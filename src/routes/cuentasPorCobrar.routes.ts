import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole } from "../middleware/auth";
import { crearCuentaPorCobrar, registrarAbonoCobrar } from "../services/cuentasCobrar.service";

export const cuentasPorCobrarRouter = Router();

const crearCuentaSchema = z.object({
  terceroId: z.number().int(),
  monedaId: z.number().int(),
  montoOriginal: z.string(),
});

cuentasPorCobrarRouter.post("/", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const data = crearCuentaSchema.parse(req.body);
    const cuenta = await crearCuentaPorCobrar(data);
    res.status(201).json(cuenta);
  } catch (err) {
    next(err);
  }
});

cuentasPorCobrarRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const terceroIdParam = req.query.terceroId;
    const estadoParam = req.query.estado;

    const condiciones: string[] = [];
    const valores: unknown[] = [];

    if (typeof terceroIdParam === "string" && Number.isInteger(Number(terceroIdParam))) {
      valores.push(Number(terceroIdParam));
      condiciones.push(`cxc.tercero_id = $${valores.length}`);
    }
    if (typeof estadoParam === "string") {
      valores.push(estadoParam);
      condiciones.push(`cxc.estado = $${valores.length}`);
    }

    const where = condiciones.length > 0 ? `WHERE ${condiciones.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT cxc.*, t.nombre AS tercero_nombre, m.codigo AS moneda_codigo
       FROM cuentas_por_cobrar cxc
       JOIN terceros t ON t.id = cxc.tercero_id
       JOIN monedas m ON m.id = cxc.moneda_id
       ${where}
       ORDER BY cxc.created_at DESC`,
      valores
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

cuentasPorCobrarRouter.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

    const result = await pool.query(`SELECT * FROM cuentas_por_cobrar WHERE id = $1`, [id]);
    const cuenta = result.rows[0];
    if (!cuenta) return res.status(404).json({ error: "Cuenta por cobrar no encontrada" });
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

cuentasPorCobrarRouter.post(
  "/:id/abonos",
  requireAuth,
  requireRole("ADMIN", "ASESOR", "CAJERO"),
  async (req, res, next) => {
    try {
      const idParam = req.params.id;
      const id = idParam ? Number(idParam) : NaN;
      if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

      const data = abonoSchema.parse(req.body);
      const resultado = await registrarAbonoCobrar({
        cuentaPorCobrarId: id,
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