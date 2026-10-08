import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { pool } from "../db/pool";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  actualizarCanal,
  anularMovimiento,
  avisarClientePorWhatsApp,
  buscarMovimientoPorNumero,
  cambiarEstadoCuentaCorriente,
  cambiarGrupoCobro,
  cambiarModuloCuentaCorriente,
  cerrarDiaCuentaCorriente,
  configurarCobroCuenta,
  confirmarMovimiento,
  crearCanal,
  crearCuentaCorriente,
  eliminarCuentaCorriente,
  generarExcelEstadoCuenta,
  guardarComprobanteMovimiento,
  guardarTasaHabitual,
  listarCuentasCorrientes,
  obtenerEstadoCuenta,
  obtenerTasasRecientes,
  registrarMovimientoCuentaCorriente,
  urlComprobanteMovimiento,
} from "../services/cuentaCorriente.service";
import { importarSaldosIniciales, ResultadoFila } from "../services/importacionSaldos.service";
import { leerComprobante } from "../services/lecturaComprobante.service";

export const cuentasCorrientesRouter = Router();
const estadoSchema = z.object({ estado: z.enum(["DISPONIBLE", "BLOQUEADA", "CERRADA"]) });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ---------- Catálogos ----------
cuentasCorrientesRouter.get("/canales", requireAuth, async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT * FROM canales_cuenta_corriente WHERE activo = true ORDER BY nombre`);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});


cuentasCorrientesRouter.post("/canales", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const { nombre } = z.object({ nombre: z.string().trim().min(2).max(40) }).parse(req.body);
    res.status(201).json(await crearCanal(nombre));
  } catch (err) {
    next(err);
  }
});

cuentasCorrientesRouter.put("/canales/:id", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    const cambios = z.object({ nombre: z.string().trim().min(2).max(40).optional(), activo: z.boolean().optional() }).parse(req.body);
    res.json(await actualizarCanal(id, cambios));
  } catch (err) {
    next(err);
  }
});

cuentasCorrientesRouter.put("/:id/estado", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

    const { estado } = estadoSchema.parse(req.body);
    const cuenta = await cambiarEstadoCuentaCorriente(id, estado);
    res.json(cuenta);
  } catch (err) {
    next(err);
  }
});



cuentasCorrientesRouter.get("/categorias", requireAuth, async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT * FROM categorias_movimiento WHERE activo = true ORDER BY nombre`);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// ---------- Cuentas corrientes ----------

const entero = (v: unknown) => (typeof v === "string" && Number.isInteger(Number(v)) ? Number(v) : undefined);
const fechaDia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha en formato AAAA-MM-DD");

cuentasCorrientesRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const tipo = typeof req.query.tipoTercero === "string" && ["CLIENTE", "PROVEEDOR", "MIXTO", "AMIGO"].includes(req.query.tipoTercero) ? req.query.tipoTercero : undefined;
    res.json(
      await listarCuentasCorrientes({
        terceroId: entero(req.query.terceroId),
        canalId: entero(req.query.canalId),
        buscar: typeof req.query.buscar === "string" ? req.query.buscar : undefined,
        tipoTercero: tipo,
        vista: req.query.vista === "corrientes" || req.query.vista === "cobrar" || req.query.vista === "cajas" ? req.query.vista : undefined,
      })
    );
  } catch (err) {
    next(err);
  }
});

// Abrir una cuenta: tercero existente o nuevo (proveedor/cliente) + canal de pago + moneda
const crearCuentaSchema = z
  .object({
    terceroId: z.number().int().optional(),
    nuevoTercero: z
      .object({
        nombre: z.string().trim().min(2),
        tipo: z.enum(["CLIENTE", "PROVEEDOR", "MIXTO", "AMIGO"]),
        identificacion: z.string().optional(),
        telefono: z.string().optional(),
      })
      .optional(),
    canalId: z.number().int().optional(), // sin banco: no es obligatorio
    monedaId: z.number().int(),
    saldoInicial: z.string().optional(),
    modulo: z.enum(["CORRIENTE", "POR_COBRAR", "CAJA"]).optional(),
    referencia: z.string().max(200).optional(),
    grupoCobro: z.string().max(60).optional(),
    usarExistente: z.boolean().optional(),
    monedaCobroId: z.number().int().optional(),
    tasaCobro: z.string().optional(),
  })
  .refine((d) => d.terceroId !== undefined || d.nuevoTercero !== undefined, { message: "Elegí un tercero o creá uno nuevo" });

cuentasCorrientesRouter.post("/", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const data = crearCuentaSchema.parse(req.body);
    res.status(201).json(await crearCuentaCorriente({ ...data, usuarioId: req.user!.id }));
  } catch (err) {
    next(err);
  }
});

// La "hoja" de la cuenta: saldo pendiente anterior, movimientos con total corrido y sumas
cuentasCorrientesRouter.get("/:id/estado-cuenta", requireAuth, async (req, res, next) => {
  try {
    const id = entero(req.params.id);
    if (id === undefined) return res.status(400).json({ error: "id inválido" });
    const filtros = z.object({ desde: fechaDia.optional(), hasta: fechaDia.optional() }).parse({
      desde: req.query.desde || undefined,
      hasta: req.query.hasta || undefined,
    });
    res.json(await obtenerEstadoCuenta(id, filtros));
  } catch (err) {
    next(err);
  }
});

// Pasar la cuenta a Cuentas por Cobrar o devolverla a Cuentas Corrientes
cuentasCorrientesRouter.put("/:id/modulo", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const id = entero(req.params.id);
    if (id === undefined) return res.status(400).json({ error: "id inválido" });
    const { modulo } = z.object({ modulo: z.enum(["CORRIENTE", "POR_COBRAR", "CAJA"]) }).parse(req.body);
    res.json(await cambiarModuloCuentaCorriente(id, modulo));
  } catch (err) {
    next(err);
  }
});

// Cuentas por Cobrar: cambiar de grupo a un cliente
cuentasCorrientesRouter.put("/:id/grupo", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const id = entero(req.params.id);
    if (id === undefined) return res.status(400).json({ error: "id inválido" });
    const { grupo } = z.object({ grupo: z.string().max(60).nullable() }).parse(req.body);
    res.json(await cambiarGrupoCobro(id, grupo));
  } catch (err) {
    next(err);
  }
});

// En qué moneda se le cobra (y a qué tasa manual) cuando no es la de la contabilidad
cuentasCorrientesRouter.put("/:id/cobro", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const id = entero(req.params.id);
    if (id === undefined) return res.status(400).json({ error: "id inválido" });
    const datos = z.object({ monedaCobroId: z.number().int().nullable(), tasaCobro: z.string().optional() }).parse(req.body);
    res.json(await configurarCobroCuenta(id, datos));
  } catch (err) {
    next(err);
  }
});

// Últimas tasas y comisiones usadas, para reutilizarlas al cargar un movimiento
cuentasCorrientesRouter.get("/:id/tasas-recientes", requireAuth, async (req, res, next) => {
  try {
    const id = entero(req.params.id);
    if (id === undefined) return res.status(400).json({ error: "id inválido" });
    res.json(await obtenerTasasRecientes(id));
  } catch (err) {
    next(err);
  }
});

// Cierre diario de la cuenta: queda anotado el saldo con el que cerró ese día
cuentasCorrientesRouter.post("/:id/cierres", requireAuth, requireRole("ADMIN", "ASESOR", "CAJERO"), async (req, res, next) => {
  try {
    const id = entero(req.params.id);
    if (id === undefined) return res.status(400).json({ error: "id inválido" });
    const { dia } = z.object({ dia: fechaDia }).parse(req.body);
    res.status(201).json(await cerrarDiaCuentaCorriente(id, dia, req.user!.id));
  } catch (err) {
    next(err);
  }
});

// La tasa que queda puesta en el formulario de la cuenta
cuentasCorrientesRouter.put("/:id/tasa-habitual", requireAuth, requireRole("ADMIN", "ASESOR", "CAJERO"), async (req, res, next) => {
  try {
    const id = entero(req.params.id);
    if (id === undefined) return res.status(400).json({ error: "id inválido" });
    const { tasa } = z.object({ tasa: z.string() }).parse(req.body);
    res.json(await guardarTasaHabitual(id, tasa));
  } catch (err) {
    next(err);
  }
});

// La imagen del comprobante de un movimiento: guardarla y verla
cuentasCorrientesRouter.post(
  "/movimientos/:id/comprobante",
  requireAuth,
  requireRole("ADMIN", "ASESOR", "CAJERO"),
  upload.single("imagen"),
  async (req, res, next) => {
    try {
      const id = entero(req.params.id);
      if (id === undefined) return res.status(400).json({ error: "id inválido" });
      if (!req.file) return res.status(400).json({ error: "Adjuntá la imagen del comprobante" });
      if (!/^image\/(jpeg|png|webp|gif)$/.test(req.file.mimetype)) return res.status(400).json({ error: "El comprobante tiene que ser una imagen (JPG, PNG o WebP)" });
      res.status(201).json(await guardarComprobanteMovimiento(id, req.file.buffer, req.file.mimetype));
    } catch (err) {
      next(err);
    }
  }
);

cuentasCorrientesRouter.get("/movimientos/:id/comprobante", requireAuth, async (req, res, next) => {
  try {
    const id = entero(req.params.id);
    if (id === undefined) return res.status(400).json({ error: "id inválido" });
    res.json(await urlComprobanteMovimiento(id));
  } catch (err) {
    next(err);
  }
});

// El movimiento en proceso de confirmación (ej. Western Union) ya fue verificado
cuentasCorrientesRouter.post("/movimientos/:id/confirmar", requireAuth, requireRole("ADMIN", "ASESOR", "CAJERO"), async (req, res, next) => {
  try {
    const id = entero(req.params.id);
    if (id === undefined) return res.status(400).json({ error: "id inválido" });
    res.json(await confirmarMovimiento(id));
  } catch (err) {
    next(err);
  }
});

// ¿Ya se registró un movimiento con ese número de transferencia? (para no cargarlo dos veces)
cuentasCorrientesRouter.get("/movimientos/numero/:numero", requireAuth, async (req, res, next) => {
  try {
    const numero = z.string().regex(/^[A-Za-z0-9-]{4,40}$/).parse(req.params.numero);
    // ?canalId=: solo dentro de ese medio de pago (Bancolombia, Nequi, Zelle…)
    res.json({ movimiento: await buscarMovimientoPorNumero(numero, entero(req.query.canalId)) });
  } catch (err) {
    next(err);
  }
});

// Eliminar la cuenta: deja de aparecer en las listas (los movimientos se conservan)
cuentasCorrientesRouter.delete("/:id", requireAuth, requireRole("ADMIN", "ASESOR"), async (req, res, next) => {
  try {
    const id = entero(req.params.id);
    if (id === undefined) return res.status(400).json({ error: "id inválido" });
    await eliminarCuentaCorriente(id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Confirmación al cliente por el WhatsApp conectado al sistema (ej. "he recibido tanto")
cuentasCorrientesRouter.post("/:id/avisar", requireAuth, requireRole("ADMIN", "ASESOR", "CAJERO"), async (req, res, next) => {
  try {
    const id = entero(req.params.id);
    if (id === undefined) return res.status(400).json({ error: "id inválido" });
    // linea: por cuál de los WhatsApp vinculados sale (1 Bolívares, 2 Pesos, 3 Dólares)
    const { texto, linea } = z.object({ texto: z.string().trim().min(1).max(2000), linea: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1) }).parse(req.body);
    await avisarClientePorWhatsApp(id, texto, req.user!.id, linea);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// La misma hoja, descargada como Excel
cuentasCorrientesRouter.get("/:id/excel", requireAuth, async (req, res, next) => {
  try {
    const id = entero(req.params.id);
    if (id === undefined) return res.status(400).json({ error: "id inválido" });
    const filtros = z.object({ desde: fechaDia.optional(), hasta: fechaDia.optional() }).parse({
      desde: req.query.desde || undefined,
      hasta: req.query.hasta || undefined,
    });
    const archivo = await generarExcelEstadoCuenta(id, filtros);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="estado-cuenta-${id}.xlsx"`);
    res.send(archivo);
  } catch (err) {
    next(err);
  }
});

cuentasCorrientesRouter.post(
  "/movimientos/:id/anular",
  requireAuth,
  requireRole("ADMIN", "ASESOR"),
  async (req, res, next) => {
    try {
      const id = entero(req.params.id);
      if (id === undefined) return res.status(400).json({ error: "id inválido" });
      res.status(201).json(await anularMovimiento(id, req.user!.id));
    } catch (err) {
      next(err);
    }
  }
);

cuentasCorrientesRouter.get("/:id/movimientos", requireAuth, async (req, res, next) => {
  try {
    const idParam = req.params.id;
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });

    const result = await pool.query(
      `SELECT * FROM movimientos_cuenta_corriente WHERE cuenta_corriente_id = $1 ORDER BY fecha, id`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// Lee la imagen de un comprobante y devuelve referencia, monto y fecha para llenar el movimiento
cuentasCorrientesRouter.post(
  "/leer-comprobante",
  requireAuth,
  requireRole("ADMIN", "ASESOR", "CAJERO"),
  upload.single("imagen"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Adjuntá la imagen del comprobante" });
      if (!/^image\/(jpeg|png|webp|gif)$/.test(req.file.mimetype)) return res.status(400).json({ error: "El comprobante tiene que ser una imagen (JPG, PNG o WebP)" });
      res.json(await leerComprobante(req.file.buffer, req.file.mimetype));
    } catch (err) {
      next(err);
    }
  }
);

// ---------- Registrar movimiento ----------

const movimientoSchema = z.object({
  terceroId: z.number().int(),
  canalId: z.number().int(),
  monedaId: z.number().int(),
  tipo: z.enum(["COMPRA", "VENTA", "ABONO", "CARGO", "AJUSTE"]),
  monto: z.string().optional(), // si falta, se calcula como cantidadBase x tasa
  descripcion: z.string().optional(),
  cantidadBase: z.string().optional(),
  monedaBaseId: z.number().int().optional(),
  tasa: z.string().optional(),
  tasaEsPorcentaje: z.boolean().optional(),
  comisionDescontada: z.boolean().optional(),
  comisionIncluida: z.boolean().optional(),
  canalMovimientoId: z.number().int().optional(),
  estadoConfirmacion: z.enum(["EN_PROCESO", "CONFIRMADA"]).optional(),
  cuentaDestino: z.string().max(120).optional(),
  transaccionId: z.number().int().optional(),
  fecha: z.string().optional(),
  categoriaId: z.number().int().optional(),
  // Opcional: si este movimiento también mueve efectivo/banco real
  cajaId: z.number().int().optional(),
  montoCaja: z.string().optional(),
  monedaCajaId: z.number().int().optional(),
  metodoPagoId: z.number().int().optional(),
});

cuentasCorrientesRouter.post(
  "/movimientos",
  requireAuth,
  requireRole("ADMIN", "ASESOR", "CAJERO"),
  async (req, res, next) => {
    try {
      const data = movimientoSchema.parse(req.body);
      const resultado = await registrarMovimientoCuentaCorriente({ ...data, usuarioId: req.user!.id });
      res.status(201).json(resultado);
    } catch (err) {
      next(err);
    }
  }
);

// ---------- Importar saldos iniciales (opcional, una sola vez) ----------

cuentasCorrientesRouter.post(
  "/importar-saldos-iniciales",
  requireAuth,
  requireRole("ADMIN"),
  upload.single("archivo"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Debes adjuntar el archivo con el campo 'archivo'" });
      }
      const resultados: ResultadoFila[] = await importarSaldosIniciales(req.file.buffer, req.user!.id);
      const exitosas = resultados.filter((r: ResultadoFila) => r.ok).length;
      const fallidas = resultados.filter((r: ResultadoFila) => !r.ok).length;
      res.status(207).json({ resumen: { exitosas, fallidas, total: resultados.length }, detalle: resultados });
    } catch (err) {
      next(err);
    }
  }
);