import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole } from "../middleware/auth";

export const usuariosRouter = Router();

// Todo este módulo es exclusivo de ADMIN -- nadie más puede crear usuarios
// ni cambiar roles, ni siquiera para verse a sí mismo en la lista.
usuariosRouter.use(requireAuth, requireRole("ADMIN"));

usuariosRouter.get("/", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, nombre, email, rol, activo, created_at FROM usuarios ORDER BY nombre`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

const crearUsuarioSchema = z.object({
  nombre: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
  rol: z.enum(["ADMIN", "ASESOR", "CAJERO", "OPERADOR"]),
});

usuariosRouter.post("/", async (req, res, next) => {
  try {
    const data = crearUsuarioSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(data.password, 10);

    const result = await pool.query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol)
       VALUES ($1, $2, $3, $4)
       RETURNING id, nombre, email, rol, activo, created_at`,
      [data.nombre, data.email, passwordHash, data.rol]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    // Email duplicado -- mensaje claro en vez del error crudo de Postgres
    if (err.code === "23505") {
      return res.status(409).json({ error: "Ya existe un usuario con ese correo" });
    }
    next(err);
  }
});

const actualizarUsuarioSchema = z.object({
  rol: z.enum(["ADMIN", "ASESOR", "CAJERO", "OPERADOR"]).optional(),
  activo: z.boolean().optional(),
});

usuariosRouter.put("/:id", async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

    if (id === req.user!.id && req.body.activo === false) {
      return res.status(400).json({ error: "No podés desactivar tu propio usuario" });
    }

    const actualResult = await pool.query(`SELECT * FROM usuarios WHERE id = $1`, [id]);
    const actual = actualResult.rows[0];
    if (!actual) return res.status(404).json({ error: "Usuario no encontrado" });

    const data = actualizarUsuarioSchema.parse(req.body);
    const result = await pool.query(
      `UPDATE usuarios SET rol = $1, activo = $2 WHERE id = $3
       RETURNING id, nombre, email, rol, activo, created_at`,
      [data.rol ?? actual.rol, data.activo ?? actual.activo, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

const resetPasswordSchema = z.object({
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
});

usuariosRouter.put("/:id/password", async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

    const { password } = resetPasswordSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `UPDATE usuarios SET password_hash = $1 WHERE id = $2 RETURNING id`,
      [passwordHash, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});