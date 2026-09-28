import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole } from "../middleware/auth";

export const cajasRouter = Router();

const crearCajaSchema = z.object({
  nombre: z.string().min(1),
  tipo: z.enum(["FISICA", "FUERTE", "BANCO"]),
});

// Dar de alta un banco nuevo es exactamente esto -- POST con tipo "BANCO".
cajasRouter.post("/", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const data = crearCajaSchema.parse(req.body);
    const result = await pool.query(
      `INSERT INTO cajas (nombre, tipo) VALUES ($1, $2) RETURNING *`,
      [data.nombre, data.tipo]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// ?tipo=BANCO para listar solo los bancos, sin traer las cajas físicas
cajasRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const tipo = typeof req.query.tipo === "string" ? req.query.tipo : undefined;
    const result = tipo
      ? await pool.query(`SELECT * FROM cajas WHERE tipo = $1 AND activo = true ORDER BY nombre`, [tipo])
      : await pool.query(`SELECT * FROM cajas WHERE activo = true ORDER BY nombre`);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});