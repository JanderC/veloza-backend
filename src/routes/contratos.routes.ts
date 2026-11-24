import { Router, json } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  crearLink,
  firmarConLink,
  guardarContrato,
  guardarFirma,
  linkPublico,
  listarContratos,
  listarFirmas,
  listarLinks,
  obtenerContrato,
  quitarFirma,
} from "../services/contratos.service";

/**
 * Contratos y firmas. Lo de /publico/ se abre sin iniciar sesión: es la página donde el cliente o el titular firma
 * con el link que se le mandó. Todo lo demás es del administrador y el asesor.
 */
export const contratosRouter = Router();
const ROLES = requireRole("ADMIN", "ASESOR");
// las firmas son imágenes: más grandes que un pedido común
const conImagen = json({ limit: "1mb" });
const IMAGEN = z.string().startsWith("data:image/png;base64,");
const entero = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

// ---------- página pública del link ----------
contratosRouter.get("/publico/:token", async (req, res, next) => {
  try {
    res.json(await linkPublico(String(req.params.token)));
  } catch (err) {
    next(err);
  }
});
contratosRouter.post("/publico/:token", conImagen, async (req, res, next) => {
  try {
    const d = z.object({ imagen: IMAGEN, nombre: z.string().max(120).optional(), cedula: z.string().max(30).optional(), numeroCuenta: z.string().max(40).optional() }).parse(req.body);
    res.status(201).json(await firmarConLink(String(req.params.token), d));
  } catch (err) {
    next(err);
  }
});

// ---------- firmas ----------
contratosRouter.get("/firmas", requireAuth, ROLES, async (req, res, next) => {
  try {
    const tipo = z.enum(["CLIENTE", "TITULAR", "EMPRESA"]).optional().parse(req.query.tipo || undefined);
    res.json(await listarFirmas({ tipo, terceroId: entero(req.query.terceroId), buscar: typeof req.query.buscar === "string" ? req.query.buscar.slice(0, 80) : undefined }));
  } catch (err) {
    next(err);
  }
});
contratosRouter.post("/firmas", requireAuth, ROLES, conImagen, async (req, res, next) => {
  try {
    const d = z
      .object({
        tipo: z.enum(["CLIENTE", "TITULAR", "EMPRESA"]),
        terceroId: z.number().int().positive().nullable().optional(),
        nombre: z.string().trim().min(3).max(120),
        cedula: z.string().max(30).nullable().optional(),
        numeroCuenta: z.string().max(40).nullable().optional(),
        banco: z.string().max(60).nullable().optional(),
        imagen: IMAGEN,
      })
      .parse(req.body);
    res.status(201).json(await guardarFirma({ ...d, origen: "PANEL" }, req.user!.id));
  } catch (err) {
    next(err);
  }
});
contratosRouter.delete("/firmas/:id", requireAuth, ROLES, async (req, res, next) => {
  try {
    const id = entero(req.params.id);
    if (!id) return res.status(400).json({ error: "id inválido" });
    res.json(await quitarFirma(id));
  } catch (err) {
    next(err);
  }
});

// ---------- links para firmar ----------
contratosRouter.get("/links", requireAuth, ROLES, async (req, res, next) => {
  try {
    res.json(await listarLinks({ terceroId: entero(req.query.terceroId) }));
  } catch (err) {
    next(err);
  }
});
contratosRouter.post("/links", requireAuth, ROLES, async (req, res, next) => {
  try {
    const d = z
      .object({
        tipo: z.enum(["CLIENTE", "TITULAR"]),
        terceroId: z.number().int().positive(),
        nombre: z.string().max(120).nullable().optional(),
        cedula: z.string().max(30).nullable().optional(),
        numeroCuenta: z.string().max(40).nullable().optional(),
        banco: z.string().max(60).nullable().optional(),
      })
      .parse(req.body);
    res.status(201).json(await crearLink(d, req.user!.id));
  } catch (err) {
    next(err);
  }
});

// ---------- contratos ----------
contratosRouter.get("/", requireAuth, ROLES, async (req, res, next) => {
  try {
    res.json(await listarContratos({ terceroId: entero(req.query.terceroId), buscar: typeof req.query.buscar === "string" ? req.query.buscar.slice(0, 80) : undefined }));
  } catch (err) {
    next(err);
  }
});
contratosRouter.get("/:id", requireAuth, ROLES, async (req, res, next) => {
  try {
    const id = entero(req.params.id);
    if (!id) return res.status(400).json({ error: "id inválido" });
    res.json(await obtenerContrato(id));
  } catch (err) {
    next(err);
  }
});
contratosRouter.post("/", requireAuth, ROLES, json({ limit: "200kb" }), async (req, res, next) => {
  try {
    const d = z
      .object({
        terceroId: z.number().int().positive(),
        numero: z.string().max(40).nullable().optional(),
        clienteNombre: z.string().min(2).max(160),
        titularNombre: z.string().max(160).nullable().optional(),
        datos: z.record(z.unknown()),
        firmaClienteId: z.number().int().positive().nullable().optional(),
        firmaTitularId: z.number().int().positive().nullable().optional(),
        firmaEmpresaId: z.number().int().positive().nullable().optional(),
      })
      .parse(req.body);
    res.status(201).json(await guardarContrato(d, req.user!.id));
  } catch (err) {
    next(err);
  }
});
