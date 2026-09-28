import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { pool } from "../db/pool";
import { requireAuth, requireRole } from "../middleware/auth";
import { registrarMovimientoCuentaCorriente } from "../services/cuentaCorriente.service";
import { importarSaldosIniciales, ResultadoFila } from "../services/importacionSaldos.service"; 
import { cambiarEstadoCuentaCorriente } from "../services/cuentaCorriente.service";

export const cuentasCorrientesRouter = Router();
const estadoSchema = z.object({ estado: z.enum(["DISPONIBLE", "BLOQUEADA", "CERRADA"]) });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ---------- Catálogos ----------
cuentasCorrientesRouter.get("/canales", requireAuth, async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT * FROM canales_cuenta_corriente WHERE activo = true ORDER BY nombre`);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});


cuentasCorrientesRouter.put("/:id/estado", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

    const { estado } = estadoSchema.parse(req.body);
    const cuenta = await cambiarEstadoCuentaCorriente(id, estado);
    res.json(cuenta);
  } catch (err) {
    next(err);
  }
});



cuentasCorrientesRouter.get("/categorias", requireAuth, async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT * FROM categorias_movimiento WHERE activo = true ORDER BY nombre`);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// ---------- Cuentas corrientes ----------

cuentasCorrientesRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const terceroIdParam = req.query.terceroId;
    const canalIdParam = req.query.canalId;
    const condiciones: string[] = [];
    const valores: unknown[] = [];

    if (typeof terceroIdParam === "string" && Number.isInteger(Number(terceroIdParam))) {
      valores.push(Number(terceroIdParam));
      condiciones.push(`cc.tercero_id = $${valores.length}`);
    }
    if (typeof canalIdParam === "string" && Number.isInteger(Number(canalIdParam))) {
      valores.push(Number(canalIdParam));
      condiciones.push(`cc.canal_id = $${valores.length}`);
    }

    const where = condiciones.length > 0 ? `WHERE ${condiciones.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT cc.*, t.nombre AS tercero_nombre, ch.nombre AS canal_nombre, m.codigo AS moneda_codigo
       FROM cuentas_corrientes cc
       JOIN terceros t ON t.id = cc.tercero_id
       JOIN canales_cuenta_corriente ch ON ch.id = cc.canal_id
       JOIN monedas m ON m.id = cc.moneda_id
       ${where}
       ORDER BY t.nombre, ch.nombre`,
      valores
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

cuentasCorrientesRouter.get("/:id/movimientos", requireAuth, async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

    const result = await pool.query(
      `SELECT * FROM movimientos_cuenta_corriente WHERE cuenta_corriente_id = $1 ORDER BY fecha, id`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// ---------- Registrar movimiento ----------

const movimientoSchema = z.object({
  terceroId: z.number().int(),
  canalId: z.number().int(),
  monedaId: z.number().int(),
  tipo: z.enum(["COMPRA", "VENTA", "ABONO", "CARGO", "AJUSTE"]),
  monto: z.string(),
  descripcion: z.string().optional(),
  cantidadBase: z.string().optional(),
  monedaBaseId: z.number().int().optional(),
  tasa: z.string().optional(),
  transaccionId: z.number().int().optional(),
  fecha: z.string().optional(),
  categoriaId: z.number().int().optional(),
  // Opcional: si este movimiento también mueve efectivo/banco real
  cajaId: z.number().int().optional(),
  montoCaja: z.string().optional(),
  monedaCajaId: z.number().int().optional(),
  metodoPagoId: z.number().int().optional(),
});

cuentasCorrientesRouter.post(
  "/movimientos",
  requireAuth,
  requireRole("ADMIN", "ASESOR", "CAJERO"),
  async (req, res, next) => {
    try {
      const data = movimientoSchema.parse(req.body);
      const resultado = await registrarMovimientoCuentaCorriente({ ...data, usuarioId: req.user!.id });
      res.status(201).json(resultado);
    } catch (err) {
      next(err);
    }
  }
);

// ---------- Importar saldos iniciales (opcional, una sola vez) ----------

cuentasCorrientesRouter.post(
  "/importar-saldos-iniciales",
  requireAuth,
  requireRole("ADMIN"),
  upload.single("archivo"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Debes adjuntar el archivo con el campo 'archivo'" });
      }
      const resultados: ResultadoFila[] = await importarSaldosIniciales(req.file.buffer, req.user!.id);
      const exitosas = resultados.filter((r: ResultadoFila) => r.ok).length;
      const fallidas = resultados.filter((r: ResultadoFila) => !r.ok).length;
      res.status(207).json({ resumen: { exitosas, fallidas, total: resultados.length }, detalle: resultados });
    } catch (err) {
      next(err);
    }
  }
);