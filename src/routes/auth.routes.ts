import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { pool } from "../db/pool";
import { env } from "../config/env";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const result = await pool.query(
      `SELECT id, nombre, email, password_hash, rol, activo FROM usuarios WHERE email = $1`,
      [email]
    );
    const usuario = result.rows[0];

    if (!usuario || !usuario.activo) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const valido = await bcrypt.compare(password, usuario.password_hash);
    if (!valido) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const token = jwt.sign({ id: usuario.id, rol: usuario.rol }, env.JWT_SECRET, {
      expiresIn: "8h",
    });

    // usuario: para que el front sepa quién está conectado (ej. ocultar Aprobar en sus propios documentos)
    res.json({ token, usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol } });
  } catch (err) {
    next(err);
  }
});