import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  subirDocumento,
  listarDocumentosTercero,
  obtenerUrlDocumento,
  revisarDocumento,
  obtenerVerificacionTercero,
  MIME_PERMITIDOS,
} from "../services/documentosTercero.service";

// Montado en /terceros
export const documentosTerceroRouter = Router();

const TAMANO_MAXIMO_MB = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANO_MAXIMO_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (MIME_PERMITIDOS[file.mimetype]) return cb(null, true);
    cb(Object.assign(new Error("Formato no permitido: solo JPG, PNG, WEBP o PDF"), { status: 400 }));
  },
});

// multipart/form-data: todos los campos llegan como texto
const subirDocumentoSchema = z.object({
  tipo: z.enum(["CEDULA", "RIF", "PASAPORTE", "COMPROBANTE_DOMICILIO", "ORIGEN_FONDOS", "OTRO"]),
  descripcion: z.string().trim().min(1).optional(),
  fechaVencimiento: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "fechaVencimiento debe tener formato AAAA-MM-DD")
    .optional(),
  transaccionId: z.coerce.number().int().positive().optional(),
});

const revisarSchema = z.object({
  estado: z.enum(["APROBADO", "RECHAZADO"]),
  motivo: z.string().trim().optional(),
});

function parseId(valor: string | undefined) {
  const id = valor ? Number(valor) : NaN;
  return Number.isInteger(id) ? id : null;
}

documentosTerceroRouter.get("/:terceroId/verificacion", requireAuth, async (req, res, next) => {
  try {
    const terceroId = parseId(req.params.terceroId);
    if (terceroId === null) return res.status(400).json({ error: "id inválido" });
    res.json(await obtenerVerificacionTercero(terceroId));
  } catch (err) {
    next(err);
  }
});

documentosTerceroRouter.get("/:terceroId/documentos", requireAuth, async (req, res, next) => {
  try {
    const terceroId = parseId(req.params.terceroId);
    if (terceroId === null) return res.status(400).json({ error: "id inválido" });
    res.json(await listarDocumentosTercero(terceroId));
  } catch (err) {
    next(err);
  }
});

documentosTerceroRouter.post(
  "/:terceroId/documentos",
  requireAuth,
  requireRole("ADMIN", "ASESOR", "CAJERO"),
  upload.single("archivo"),
  async (req, res, next) => {
    try {
      const terceroId = parseId(req.params.terceroId);
      if (terceroId === null) return res.status(400).json({ error: "id inválido" });
      if (!req.file) {
        return res.status(400).json({ error: "Debes adjuntar el archivo con el campo 'archivo'" });
      }
      const data = subirDocumentoSchema.parse(req.body);
      const documento = await subirDocumento({ ...data, terceroId, archivo: req.file, usuarioId: req.user!.id });
      res.status(201).json(documento);
    } catch (err) {
      next(err);
    }
  }
);

documentosTerceroRouter.get("/documentos/:documentoId/archivo", requireAuth, async (req, res, next) => {
  try {
    const documentoId = parseId(req.params.documentoId);
    if (documentoId === null) return res.status(400).json({ error: "id inválido" });
    res.json(await obtenerUrlDocumento(documentoId));
  } catch (err) {
    next(err);
  }
});

documentosTerceroRouter.post(
  "/documentos/:documentoId/revisar",
  requireAuth,
  requireRole("ADMIN", "ASESOR"),
  async (req, res, next) => {
    try {
      const documentoId = parseId(req.params.documentoId);
      if (documentoId === null) return res.status(400).json({ error: "id inválido" });
      const data = revisarSchema.parse(req.body);
      res.json(await revisarDocumento({ ...data, documentoId, usuarioId: req.user!.id }));
    } catch (err) {
      next(err);
    }
  }
);
