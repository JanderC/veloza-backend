import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole } from "../middleware/auth";
import { obtenerResumenTercero } from "../services/terceroResumen.service";

export const tercerosRouter = Router();

const crearTerceroSchema = z.object({
  nombre: z.string().min(1),
  identificacion: z.string().optional(),
  telefono: z.string().optional(),
  tipo: z.enum(["CLIENTE", "PROVEEDOR", "MIXTO", "AMIGO"]),
});

tercerosRouter.post("/", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const data = crearTerceroSchema.parse(req.body);
    const result = await pool.query(
      `INSERT INTO terceros (nombre, identificacion, telefono, tipo)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [data.nombre, data.identificacion ?? null, data.telefono ?? null, data.tipo]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

tercerosRouter.get("/:id/resumen", requireAuth, async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

    const resumen = await obtenerResumenTercero(id);
    if (!resumen) return res.status(404).json({ error: "Tercero no encontrado" });
    res.json(resumen);
  } catch (err) {
    next(err);
  }
});

tercerosRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const tipo = typeof req.query.tipo === "string" ? req.query.tipo : undefined;
    const buscar = typeof req.query.buscar === "string" ? req.query.buscar.trim() : undefined;

    const condiciones: string[] = ["activo = true"];
    const valores: unknown[] = [];

    if (tipo) {
      valores.push(tipo);
      condiciones.push(`tipo = $${valores.length}`);
    }
    if (buscar) {
      valores.push(`%${buscar}%`);
      condiciones.push(`(nombre ILIKE $${valores.length} OR identificacion ILIKE $${valores.length})`);
    }

    const where = `WHERE ${condiciones.join(" AND ")}`;
    const result = await pool.query(`SELECT * FROM terceros ${where} ORDER BY nombre LIMIT 20`, valores);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

tercerosRouter.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id inválido" });
    }

    const result = await pool.query(`SELECT * FROM terceros WHERE id = $1`, [id]);
    const tercero = result.rows[0];
    if (!tercero) return res.status(404).json({ error: "Tercero no encontrado" });
    res.json(tercero);
  } catch (err) {
    next(err);
  }
});

const actualizarTerceroSchema = crearTerceroSchema.partial();

tercerosRouter.put("/:id", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id inválido" });
    }

    const actual = await pool.query(`SELECT * FROM terceros WHERE id = $1`, [id]);
    const tercero = actual.rows[0];
    if (!tercero) return res.status(404).json({ error: "Tercero no encontrado" });

    const data = actualizarTerceroSchema.parse(req.body);
    const result = await pool.query(
      `UPDATE terceros SET nombre = $1, identificacion = $2, telefono = $3, tipo = $4 WHERE id = $5 RETURNING *`,
      [
        data.nombre ?? tercero.nombre,
        data.identificacion ?? tercero.identificacion,
        data.telefono ?? tercero.telefono,
        data.tipo ?? tercero.tipo,
        id,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    // la cédula es única: si ya la tiene otro, se dice claro en vez de un error genérico
    if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: "Esa cédula ya está registrada en otro cliente" });
    next(err);
  }
});