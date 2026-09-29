import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const detalles = err.issues.map((i) => {
      const campo = i.path.join(".");
      const mensaje = i.message === "Required" ? `El campo ${campo} es obligatorio` : i.message;
      return { campo, mensaje };
    });
    return res.status(400).json({ error: detalles[0]?.mensaje ?? "Datos inválidos", detalles });
  }
  if (err instanceof MulterError) {
    const mensaje = err.code === "LIMIT_FILE_SIZE" ? "El archivo supera el tamaño máximo permitido" : err.message;
    return res.status(400).json({ error: mensaje });
  }
  console.error(err);
  const status = err.status ?? 500;
  res.status(status).json({ error: err.message ?? "Error interno del servidor" });
}
