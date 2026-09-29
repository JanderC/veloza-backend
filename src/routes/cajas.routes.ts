import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  actualizarCaja,
  crearCaja,
  fondearCaja,
  listarCajas,
  listarMovimientosInternos,
  marcarPrincipal,
  obtenerEstadoCaja,
  transferirEntreCajas,
} from "../services/cajas.service";

export const cajasRouter = Router();

const tipoCaja = z.enum(["FISICA", "FUERTE", "BANCO"]);

// Monto como string decimal positivo, hasta 4 decimales -- nunca pasa por float
const montoPositivo = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,4})?$/, "El monto debe ser un número positivo con hasta 4 decimales")
  .refine((v) => Number(v) > 0, "El monto debe ser mayor que cero");

// Datos bancarios de una cuenta de la empresa: undefined = no tocar, null = borrar
const textoOpcional = z.string().max(120).nullable().optional();
const datosCuenta = {
  banco: textoOpcional,
  numeroCuenta: textoOpcional,
  tipoCuenta: z.enum(["AHORRO", "CORRIENTE", "BILLETERA"]).nullable().optional(),
  titular: textoOpcional,
  identificacionTitular: textoOpcional,
  telefono: textoOpcional,
  email: z.string().trim().email("Email inválido").or(z.literal("")).nullable().optional(),
  pais: textoOpcional,
  monedaId: z.number().int().nullable().optional(),
};

const crearCajaSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio"),
  tipo: tipoCaja,
  descripcion: z.string().optional(),
  esPrincipal: z.boolean().optional(),
  ...datosCuenta,
});

// Dar de alta un banco nuevo es exactamente esto -- POST con tipo "BANCO".
cajasRouter.post("/", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const data = crearCajaSchema.parse(req.body);
    res.status(201).json(await crearCaja(data));
  } catch (err) {
    next(err);
  }
});

// ?tipo=BANCO para listar solo los bancos, sin traer las cajas físicas
cajasRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const tipo = typeof req.query.tipo === "string" ? req.query.tipo : undefined;
    const result = tipo
      ? await pool.query(`SELECT * FROM cajas WHERE tipo = $1 AND activo = true ORDER BY nombre`, [tipo])
      : await pool.query(`SELECT * FROM cajas WHERE activo = true ORDER BY es_principal DESC, nombre`);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// Tablero: cajas con saldos por moneda y turnos abiertos. ?incluirInactivas=true para el admin.
cajasRouter.get("/tablero", requireAuth, requireRole("ADMIN", "CAJERO"), async (req, res, next) => {
  try {
    const incluirInactivas = req.query.incluirInactivas === "true" && req.user!.rol === "ADMIN";
    res.json(await listarCajas({ incluirInactivas }));
  } catch (err) {
    next(err);
  }
});

cajasRouter.get("/movimientos-internos", requireAuth, requireRole("ADMIN", "CAJERO"), async (req, res, next) => {
  try {
    const cajaId = typeof req.query.cajaId === "string" ? Number(req.query.cajaId) : undefined;
    const limite = typeof req.query.limite === "string" ? Number(req.query.limite) : 50;
    res.json(
      await listarMovimientosInternos({
        cajaId: cajaId !== undefined && Number.isInteger(cajaId) ? cajaId : undefined,
        limite: Number.isInteger(limite) && limite > 0 && limite <= 500 ? limite : 50,
      })
    );
  } catch (err) {
    next(err);
  }
});

const fondeoSchema = z.object({
  cajaId: z.number().int().optional(),
  monedaId: z.number().int(),
  monto: montoPositivo,
  observacion: z.string().max(300).optional(),
  abrirTurno: z.boolean().default(true),
});

// Alimentar una caja con plata que entra al negocio. Sin cajaId va a la principal.
cajasRouter.post("/fondeo", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const data = fondeoSchema.parse(req.body);
    res.status(201).json(await fondearCaja({ ...data, usuarioId: req.user!.id }));
  } catch (err) {
    next(err);
  }
});

const transferenciaSchema = z.object({
  cajaOrigenId: z.number().int(),
  cajaDestinoId: z.number().int(),
  monedaId: z.number().int(),
  monto: montoPositivo,
  observacion: z.string().max(300).optional(),
  abrirTurnoDestino: z.boolean().default(true),
});

cajasRouter.post("/transferencias", requireAuth, requireRole("ADMIN", "CAJERO"), async (req, res, next) => {
  try {
    const data = transferenciaSchema.parse(req.body);
    res.status(201).json(await transferirEntreCajas({ ...data, usuarioId: req.user!.id }));
  } catch (err) {
    next(err);
  }
});

const fechaDia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (AAAA-MM-DD)");
const estadoCajaSchema = z.object({
  monedaId: z.coerce.number().int().optional(),
  desde: fechaDia.optional(),
  hasta: fechaDia.optional(),
  tipo: z.enum(["INGRESO", "EGRESO"]).optional(),
  limite: z.coerce.number().int().min(1).max(2000).default(300),
});

// Una caja por separado: saldos por moneda, cuadre del período y sus movimientos
cajasRouter.get("/:id/estado", requireAuth, requireRole("ADMIN", "CAJERO"), async (req, res, next) => {
  try {
    const id = leerId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id inválido" });
    const filtros = estadoCajaSchema.parse(req.query);
    res.json(await obtenerEstadoCaja(id, filtros));
  } catch (err) {
    next(err);
  }
});

const actualizarCajaSchema = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio").optional(),
  tipo: tipoCaja.optional(),
  descripcion: z.string().nullable().optional(),
  activo: z.boolean().optional(),
  ...datosCuenta,
});

function leerId(param: string | undefined) {
  const id = param ? Number(param) : NaN;
  return Number.isInteger(id) ? id : null;
}

cajasRouter.put("/:id", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const id = leerId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id inválido" });
    const data = actualizarCajaSchema.parse(req.body);
    res.json(await actualizarCaja(id, data));
  } catch (err) {
    next(err);
  }
});

cajasRouter.post("/:id/principal", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const id = leerId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id inválido" });
    res.json(await marcarPrincipal(id));
  } catch (err) {
    next(err);
  }
});
