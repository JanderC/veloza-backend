import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../middleware/auth";

export const monedasRouter = Router();

monedasRouter.get("/", requireAuth, async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT * FROM monedas WHERE activo = true ORDER BY codigo`);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});