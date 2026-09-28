import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/auth";

export const metodosPagoRouter = Router();

metodosPagoRouter.get("/", requireAuth, async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT * FROM metodos_pago WHERE activo = true ORDER BY nombre`);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});