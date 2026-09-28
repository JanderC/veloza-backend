import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const detalles = err.issues.map((i) => ({ campo: i.path.join("."), mensaje: i.message }));
    return res.status(400).json({ error: detalles[0]?.mensaje ?? "Datos inválidos", detalles });
  }
  console.error(err);
  const status = err.status ?? 500;
  res.status(status).json({ error: err.message ?? "Error interno del servidor" });
}
