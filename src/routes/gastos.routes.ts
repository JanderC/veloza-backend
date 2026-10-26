import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { CATEGORIAS, borrarGasto, crearGasto, editarGasto, generarDelMes, guardarPlantillas, listarGastos, listarPlantillas, pagarGasto } from "../services/gastos.service";

// Gastos administrativos: nómina, sueldos, gastos de oficina y cualquier egreso. Solo el administrador.
export const gastosRouter = Router();
const SOLO_ADMIN = requireRole("ADMIN");
const PERIODO = z.string().regex(/^\d{4}-\d{2}$/);
const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MONTO = z.string().regex(/^\d*(\.\d+)?$/, "Monto inválido").optional();
const CATEGORIA = z.enum(CATEGORIAS);
const idDe = (v: string | undefined) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

gastosRouter.get("/", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    res.json(await listarGastos(PERIODO.parse(req.query.periodo)));
  } catch (err) {
    next(err);
  }
});

gastosRouter.post("/", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const d = z
      .object({
        periodo: PERIODO,
        categoria: CATEGORIA,
        descripcion: z.string().trim().min(1).max(200),
        montoCop: MONTO,
        montoUsd: MONTO,
        pagado: z.boolean(),
        fecha: FECHA.optional(),
        cajaId: z.number().int().positive().nullable().optional(),
        nota: z.string().max(300).optional(),
      })
      .parse(req.body);
    res.status(201).json(await crearGasto(d, req.user!.id));
  } catch (err) {
    next(err);
  }
});

gastosRouter.post("/:id/pagar", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const id = idDe(req.params.id);
    if (!id) return res.status(400).json({ error: "id inválido" });
    const d = z.object({ fecha: FECHA.optional(), cajaId: z.number().int().positive().nullable().optional() }).parse(req.body ?? {});
    res.json(await pagarGasto(id, d, req.user!.id));
  } catch (err) {
    next(err);
  }
});

gastosRouter.get("/plantillas", requireAuth, SOLO_ADMIN, async (_req, res, next) => {
  try {
    res.json(await listarPlantillas());
  } catch (err) {
    next(err);
  }
});

gastosRouter.put("/plantillas", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const { filas } = z
      .object({
        filas: z.array(
          z.object({
            id: z.number().int().positive().optional(),
            categoria: CATEGORIA,
            descripcion: z.string().trim().min(1).max(200),
            montoCop: MONTO,
            montoUsd: MONTO,
            frecuencia: z.enum(["MENSUAL", "SEMANAL"]),
            diaSemana: z.number().int().min(0).max(6).nullable().optional(),
          })
        ),
      })
      .parse(req.body);
    res.json(await guardarPlantillas(filas));
  } catch (err) {
    next(err);
  }
});

gastosRouter.post("/generar", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const d = z.object({ periodo: PERIODO, frecuencia: z.enum(["MENSUAL", "SEMANAL"]) }).parse(req.body);
    res.json(await generarDelMes(d.periodo, d.frecuencia, req.user!.id));
  } catch (err) {
    next(err);
  }
});

gastosRouter.put("/:id", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const id = idDe(req.params.id);
    if (!id) return res.status(400).json({ error: "id inválido" });
    const d = z
      .object({ descripcion: z.string().trim().min(1).max(200).optional(), categoria: CATEGORIA.optional(), montoCop: MONTO, montoUsd: MONTO, fecha: FECHA.nullable().optional(), nota: z.string().max(300).optional() })
      .parse(req.body);
    res.json(await editarGasto(id, d));
  } catch (err) {
    next(err);
  }
});

gastosRouter.delete("/:id", requireAuth, SOLO_ADMIN, async (req, res, next) => {
  try {
    const id = idDe(req.params.id);
    if (!id) return res.status(400).json({ error: "id inválido" });
    res.json(await borrarGasto(id, req.user!.id));
  } catch (err) {
    next(err);
  }
});
