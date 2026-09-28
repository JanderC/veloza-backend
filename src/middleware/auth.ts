import { Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import { env } from "../config/env";

export interface AuthUser {
  id: number;
  rol: "ADMIN" | "ASESOR" | "CAJERO" | "OPERADOR";
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const ROLES_VALIDOS: AuthUser["rol"][] = ["ADMIN", "ASESOR", "CAJERO", "OPERADOR"];

function esPayloadDeUsuario(payload: string | JwtPayload): payload is JwtPayload & AuthUser {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as JwtPayload).id === "number" &&
    ROLES_VALIDOS.includes((payload as JwtPayload).rol)
  );
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token no proporcionado" });
  }

  const [, token] = header.split(" ");
  if (!token) {
    return res.status(401).json({ error: "Token no proporcionado" });
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);

    if (!esPayloadDeUsuario(payload)) {
      return res.status(401).json({ error: "Token inválido o expirado" });
    }

    req.user = { id: payload.id, rol: payload.rol };
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
}

export function requireRole(...roles: AuthUser["rol"][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.rol)) {
      return res.status(403).json({ error: "No tienes permiso para esta acción" });
    }
    next();
  };
}