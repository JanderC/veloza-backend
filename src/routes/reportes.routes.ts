import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  obtenerCapitalConsolidado,
  obtenerMovimientosCaja,
  obtenerMovimientosCuentaCorriente,
  obtenerEstadoCuentaTercero,
  obtenerCuadresCaja,
} from "../services/reportes.service";

export const reportesRouter = Router();

reportesRouter.get("/capital-consolidado", requireAuth, requireRole("ADMIN", "ASESOR"), async (_req, res, next) => {
  try {
    const data = await obtenerCapitalConsolidado();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

reportesRouter.get("/movimientos-caja", requireAuth, async (req, res, next) => {
  try {
    const { desde, hasta, cajaId, monedaId } = req.query;
    const data = await obtenerMovimientosCaja({
      desde: typeof desde === "string" ? desde : undefined,
      hasta: typeof hasta === "string" ? hasta : undefined,
      cajaId: typeof cajaId === "string" && Number.isInteger(Number(cajaId)) ? Number(cajaId) : undefined,
      monedaId: typeof monedaId === "string" && Number.isInteger(Number(monedaId)) ? Number(monedaId) : undefined,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

reportesRouter.get("/movimientos-cuenta-corriente", requireAuth, async (req, res, next) => {
  try {
    const { desde, hasta, terceroId, canalId } = req.query;
    const data = await obtenerMovimientosCuentaCorriente({
      desde: typeof desde === "string" ? desde : undefined,
      hasta: typeof hasta === "string" ? hasta : undefined,
      terceroId: typeof terceroId === "string" && Number.isInteger(Number(terceroId)) ? Number(terceroId) : undefined,
      canalId: typeof canalId === "string" && Number.isInteger(Number(canalId)) ? Number(canalId) : undefined,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

reportesRouter.get("/estado-cuenta/:terceroId", requireAuth, async (req, res, next) => {
  try {
    const idParam = req.params.terceroId;
    const terceroId = idParam ? Number(idParam) : NaN;
    if (!Number.isInteger(terceroId)) return res.status(400).json({ error: "terceroId inválido" });

    const data = await obtenerEstadoCuentaTercero(terceroId);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

reportesRouter.get("/cuadres-caja", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const { cajaId, estado } = req.query;
    const data = await obtenerCuadresCaja({
      cajaId: typeof cajaId === "string" && Number.isInteger(Number(cajaId)) ? Number(cajaId) : undefined,
      estado: typeof estado === "string" ? estado : undefined,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});