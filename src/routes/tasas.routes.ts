import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole } from "../middleware/auth";
import { obtenerTasasExternas, obtenerHistoricoMercado } from "../services/tasasExternas.service";
import { obtenerTrmColombia } from "../services/trmColombia.service";
import { registrarLineaCotizacion, obtenerCotizacionesVigentes } from "../services/cotizacionesDetalle.service";

export const tasasRouter = Router();

const crearTasaSchema = z.object({
  monedaOrigenId: z.number().int(),
  monedaDestinoId: z.number().int(),
  valor: z.string(), // string para no perder precisión al viajar por JSON
});



tasasRouter.get("/", requireAuth, async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT tc.*, mo.codigo AS moneda_origen_codigo, md.codigo AS moneda_destino_codigo, u.nombre AS creado_por_nombre
      FROM tasas_cambio tc
      JOIN monedas mo ON mo.id = tc.moneda_origen_id
      JOIN monedas md ON md.id = tc.moneda_destino_id
      JOIN usuarios u ON u.id = tc.creado_por_id
      ORDER BY tc.vigente_desde DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});


tasasRouter.get("/externas", requireAuth, async (_req, res, next) => {
  try {
    const datos = await obtenerTasasExternas();
    res.json(datos);
  } catch (err) {
    next(err);
  }
});
// Registrar una nueva tasa NUNCA edita la anterior -- siempre inserta
// una fila nueva. El historial completo queda intacto para auditoría.
tasasRouter.post("/", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const data = crearTasaSchema.parse(req.body);
    const result = await pool.query(
      `INSERT INTO tasas_cambio (moneda_origen_id, moneda_destino_id, valor, creado_por_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [data.monedaOrigenId, data.monedaDestinoId, data.valor, req.user!.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});


// Trae la tasa más reciente para un par de monedas, por su código (USD, COP...)
tasasRouter.get("/vigente", requireAuth, async (req, res, next) => {
  try {
    const { origen, destino } = req.query;
    if (typeof origen !== "string" || typeof destino !== "string") {
      return res.status(400).json({ error: "Se requieren los parámetros origen y destino (código de moneda)" });
    }

    const result = await pool.query(
      `SELECT tc.* FROM tasas_cambio tc
       JOIN monedas mo ON mo.id = tc.moneda_origen_id
       JOIN monedas md ON md.id = tc.moneda_destino_id
       WHERE mo.codigo = $1 AND md.codigo = $2
       ORDER BY tc.vigente_desde DESC
       LIMIT 1`,
      [origen, destino]
    );

    const tasa = result.rows[0];
    if (!tasa) return res.status(404).json({ error: "No hay tasa registrada para ese par de monedas" });
    res.json(tasa);
  } catch (err) {
    next(err);
  }
});

tasasRouter.get("/publicas", async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (tc.moneda_origen_id)
        mo.codigo AS moneda_origen, md.codigo AS moneda_destino, tc.valor, tc.vigente_desde
      FROM tasas_cambio tc
      JOIN monedas mo ON mo.id = tc.moneda_origen_id
      JOIN monedas md ON md.id = tc.moneda_destino_id
      WHERE md.codigo = 'COP'
      ORDER BY tc.moneda_origen_id, tc.vigente_desde DESC
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

tasasRouter.get("/historico-mercado", requireAuth, async (req, res, next) => {
  try {
    const diasParam = req.query.dias;
    const dias = typeof diasParam === "string" && Number.isInteger(Number(diasParam)) ? Number(diasParam) : 30;
    const datos = await obtenerHistoricoMercado(Math.min(dias, 90));
    res.json(datos);
  } catch (err) {
    next(err);
  }
});

tasasRouter.get("/trm-colombia", requireAuth, async (_req, res, next) => {
  try {
    const datos = await obtenerTrmColombia();
    res.json(datos);
  } catch (err) {
    next(err);
  }
});


const registrarDetalleSchema = z.object({
  monedaId: z.number().int(),
  tipo: z.enum(["COMPRA", "VENTA"]),
  etiqueta: z.string().min(1),
  valor: z.string().optional(),
  ajustePct: z.string().optional(),
});

tasasRouter.post("/detalle", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const data = registrarDetalleSchema.parse(req.body);
    const linea = await registrarLineaCotizacion({ ...data, usuarioId: req.user!.id });
    res.status(201).json(linea);
  } catch (err) {
    next(err);
  }
});

tasasRouter.get("/detalle", requireAuth, async (_req, res, next) => {
  try {
    const datos = await obtenerCotizacionesVigentes();
    res.json(datos);
  } catch (err) {
    next(err);
  }
});