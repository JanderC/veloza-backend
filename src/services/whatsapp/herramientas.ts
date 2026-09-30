import Decimal from "decimal.js";
import { z } from "zod";
import { pool } from "../../db/pool";
import { obtenerCotizacionesVigentes } from "../cotizacionesDetalle.service";
import { calcularCambio, registrarCambioDivisa } from "../transaccionService";
import { crearCuentaTercero, type DatosCuentaTercero } from "../cuentasTercero.service";
import type { ConfigWa } from "./config";
import type { HerramientaIA } from "./ia";
import { guardarEstadoConversacion, notaInterna, type EstadoConversacion } from "./mensajes";

// Herramientas del bot con datos REALES del negocio. La IA nunca inventa tasas, montos ni
// cuentas: los números exactos los manda el SISTEMA en un mensaje aparte (enviarSistema) y
// a la IA solo se le dice que ya se enviaron.

export interface ContextoBot {
  simulacion: boolean;
  jid: string;
  telefono: string;
  terceroId: number | null;
  estado: EstadoConversacion;
  config: ConfigWa;
  esDueno: boolean;
  /** Foto del cliente más reciente (id de wa_mensajes) que todavía no se registró */
  ultimaFotoId: string | null;
  /** Lo que la IA leyó de esa foto no se guarda: lo pasa ella en registrar_comprobante */
  enviarSistema: (texto: string) => Promise<void>;
  pasarAHumano: (motivo: string) => Promise<void>;
  /** Solo para el simulador: lo que se habría escrito en la base */
  efectos: string[];
}

const MONEDA_LOCAL = "COP";

let idUsuarioBot: number | null = null;
export async function usuarioBotId() {
  if (idUsuarioBot) return idUsuarioBot;
  const r = await pool.query(`SELECT id FROM usuarios WHERE email = 'bot-whatsapp@sistema.local'`);
  if (!r.rows[0]) throw new Error("Falta el usuario de sistema del bot (migración 006)");
  idUsuarioBot = r.rows[0].id as number;
  return idUsuarioBot;
}

// ---------- Formato de montos (sin pasar por float) ----------
export function formatearMonto(valor: string | Decimal, decimales: number) {
  const d = new Decimal(valor).toDecimalPlaces(decimales, Decimal.ROUND_HALF_UP);
  const [entero, fraccion] = d.abs().toFixed(decimales).split(".");
  const conPuntos = entero!.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${d.isNegative() ? "-" : ""}${conPuntos}${fraccion ? `,${fraccion}` : ""}`;
}

function textoMonto(valor: string | Decimal, codigo: string, decimales: number) {
  return codigo === MONEDA_LOCAL ? `$${formatearMonto(valor, decimales)} COP` : `${formatearMonto(valor, decimales)} ${codigo}`;
}

interface Moneda {
  id: number;
  codigo: string;
  nombre: string;
  decimales: number;
}

async function monedaPorCodigo(codigo: string): Promise<Moneda | null> {
  const r = await pool.query(`SELECT id, codigo, nombre, decimales FROM monedas WHERE upper(codigo) = upper($1) AND activo`, [codigo.trim()]);
  return r.rows[0] ? { ...r.rows[0], decimales: Number(r.rows[0].decimales) } : null;
}

// ---------- Cotizaciones que el bot puede usar ----------
interface CotizacionBot {
  id: number;
  monedaId: number;
  monedaCodigo: string;
  tipo: "COMPRA" | "VENTA";
  etiqueta: string;
  categoria: string;
  valor: string;
}

export function claveCotizacion(c: { monedaCodigo: string; tipo: string; etiqueta: string }) {
  return `${c.monedaCodigo}|${c.tipo}|${c.etiqueta}`;
}

export async function cotizacionesDelBot(config: ConfigWa): Promise<CotizacionBot[]> {
  const filas = await obtenerCotizacionesVigentes();
  const todas: CotizacionBot[] = filas
    .filter((f) => f.valor != null && f.moneda_codigo !== MONEDA_LOCAL)
    .map((f) => ({
      id: f.id,
      monedaId: f.moneda_id,
      monedaCodigo: f.moneda_codigo,
      tipo: f.tipo,
      etiqueta: f.etiqueta,
      categoria: f.categoria,
      valor: f.valor,
    }));
  const permitidas = config.negocio.cotizacionesPermitidas;
  return permitidas.length ? todas.filter((c) => permitidas.includes(claveCotizacion(c))) : todas;
}

/** "cliente_vende_divisa" = nosotros compramos (COMPRA_DIVISA). */
function tipoTransaccion(operacion: string): "COMPRA_DIVISA" | "VENTA_DIVISA" {
  return operacion === "cliente_vende_divisa" ? "COMPRA_DIVISA" : "VENTA_DIVISA";
}

// ---------- Definiciones que ve la IA ----------
const OPERACION = {
  type: "string",
  enum: ["cliente_vende_divisa", "cliente_compra_divisa"],
  description:
    "cliente_vende_divisa: el cliente nos entrega la divisa y recibe pesos. cliente_compra_divisa: el cliente paga en pesos y recibe la divisa.",
};

export function definicionesHerramientas(ctx: ContextoBot): HerramientaIA[] {
  const lista: HerramientaIA[] = [
    {
      nombre: "ver_tasas",
      descripcion:
        "Envía al cliente (como mensaje del sistema) las tasas vigentes de hoy y te devuelve qué opciones hay. Úsala cuando pregunten a cómo está una moneda. No repitas los valores: el cliente ya los recibió.",
      parametros: {
        type: "object",
        properties: { moneda: { type: "string", description: "Código opcional: USD, EUR, VES, USDT" } },
      },
    },
    {
      nombre: "cotizar",
      descripcion:
        "Calcula con la tasa real del día cuánto entrega y cuánto recibe el cliente, y el SISTEMA le envía la cotización exacta. Úsala en cuanto sepas la operación, la moneda y el monto. No escribas tú los montos.",
      parametros: {
        type: "object",
        properties: {
          operacion: OPERACION,
          moneda: { type: "string", description: "Código de la divisa: USD, EUR, VES, USDT" },
          monto: { type: "string", description: "Monto en números, sin separadores de miles. Ej: 150 o 250000" },
          monto_en: { type: "string", enum: ["divisa", "pesos"], description: "Si el monto está expresado en la divisa o en pesos colombianos" },
          etiqueta: { type: "string", description: "Solo si hay varias tasas para esa moneda (ver_tasas te dice cuáles)" },
        },
        required: ["operacion", "moneda", "monto", "monto_en"],
      },
    },
  ];
  if (ctx.esDueno) return lista;

  lista.push(
    {
      nombre: "registrar_cliente",
      descripcion:
        "Registra al cliente la primera vez (nombre completo y número de documento). Necesario antes de crear una solicitud si el contexto dice que el cliente no está registrado.",
      parametros: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "Nombre y apellido completos" },
          identificacion: { type: "string", description: "Número de cédula o documento, solo el número" },
        },
        required: ["nombre", "identificacion"],
      },
    },
    {
      nombre: "crear_solicitud",
      descripcion:
        "Crea la solicitud de cambio con la ÚLTIMA cotización enviada y congela la tasa. El SISTEMA le envía al cliente la cuenta de la empresa y el monto exacto a transferir. Requiere cliente registrado y saber a qué cuenta se le paga: una ya guardada (cuenta_id) o una nueva (nueva_cuenta). Úsala solo cuando el cliente confirme que quiere hacer la operación.",
      parametros: {
        type: "object",
        properties: {
          cuenta_id: { type: "number", description: "Id de una cuenta del cliente ya guardada (aparecen en el contexto)" },
          nueva_cuenta: {
            type: "object",
            description: "Cuenta donde el cliente recibe, si es nueva",
            properties: {
              tipo: { type: "string", enum: ["CUENTA_BANCARIA", "PAGO_MOVIL", "ZELLE", "NEQUI", "DAVIPLATA", "OTRO"] },
              banco: { type: "string" },
              numero_cuenta: { type: "string" },
              tipo_cuenta: { type: "string", enum: ["AHORRO", "CORRIENTE"] },
              titular: { type: "string" },
              identificacion_titular: { type: "string" },
              telefono: { type: "string" },
              email: { type: "string" },
            },
            required: ["tipo", "titular"],
          },
        },
      },
    },
    {
      nombre: "enviar_datos_pago",
      descripcion: "Vuelve a enviar (como mensaje del sistema) la cuenta de la empresa y el monto exacto de la solicitud activa.",
      parametros: { type: "object", properties: {} },
    },
    {
      nombre: "registrar_comprobante",
      descripcion:
        "Registra la última foto que mandó el cliente como comprobante de pago de su solicitud activa, y la deja pendiente de aprobación. Si pudiste leer la foto, pasa el monto, la referencia y el banco tal como aparecen.",
      parametros: {
        type: "object",
        properties: {
          monto_leido: { type: "string", description: "Monto que se ve en el comprobante, en números" },
          referencia: { type: "string", description: "Número de referencia o de operación" },
          banco: { type: "string", description: "Banco o app desde donde pagó" },
        },
      },
    },
    {
      nombre: "mis_operaciones",
      descripcion: "Envía al cliente (como mensaje del sistema) el estado de sus últimas operaciones. Úsala si pregunta cómo va su cambio.",
      parametros: { type: "object", properties: {} },
    },
    {
      nombre: "pasar_a_humano",
      descripcion:
        "Deriva la conversación a una persona del equipo. SOLO si el cliente lo pide explícitamente, si hay un reclamo que no puedes verificar, o si algo no se puede resolver con las herramientas. No por dudas normales ni porque el cliente esté impaciente.",
      parametros: {
        type: "object",
        properties: {
          motivo: { type: "string", description: "En tercera persona y breve. Ej: 'quiere pagar en efectivo', 'dice que transfirió hace 2 horas y no le han pagado'" },
        },
        required: ["motivo"],
      },
    }
  );
  return lista;
}

// ---------- Ejecución ----------
export async function ejecutarHerramienta(ctx: ContextoBot, nombre: string, args: Record<string, unknown>): Promise<string> {
  const r = await (async () => {
    switch (nombre) {
      case "ver_tasas":
        return verTasas(ctx, args);
      case "cotizar":
        return cotizar(ctx, args);
      case "registrar_cliente":
        return registrarCliente(ctx, args);
      case "crear_solicitud":
        return crearSolicitud(ctx, args);
      case "enviar_datos_pago":
        return enviarDatosPago(ctx);
      case "registrar_comprobante":
        return registrarComprobanteBot(ctx, args);
      case "mis_operaciones":
        return misOperaciones(ctx);
      case "pasar_a_humano":
        return pasarAHumano(ctx, args);
      default:
        return { error: `Herramienta desconocida: ${nombre}` };
    }
  })();
  return JSON.stringify(r);
}

async function actualizarEstado(ctx: ContextoBot, cambios: Partial<Record<keyof EstadoConversacion, unknown>>) {
  for (const [k, v] of Object.entries(cambios)) {
    if (v === null) delete (ctx.estado as Record<string, unknown>)[k];
    else (ctx.estado as Record<string, unknown>)[k] = v;
  }
  if (!ctx.simulacion) await guardarEstadoConversacion(ctx.jid, cambios);
}

async function verTasas(ctx: ContextoBot, args: Record<string, unknown>) {
  const filtro = typeof args.moneda === "string" && args.moneda.trim() ? args.moneda.trim().toUpperCase() : null;
  const cots = (await cotizacionesDelBot(ctx.config)).filter((c) => !filtro || c.monedaCodigo === filtro);
  if (cots.length === 0) {
    return { enviado: false, error: "No hay tasas cargadas para hoy. No inventes una: ofrece pasar con una persona." };
  }
  const porMoneda = new Map<string, CotizacionBot[]>();
  for (const c of cots) porMoneda.set(c.monedaCodigo, [...(porMoneda.get(c.monedaCodigo) ?? []), c]);
  const lineas: string[] = ["*Tasas de hoy*"];
  for (const [codigo, lista] of porMoneda) {
    for (const tipo of ["COMPRA", "VENTA"] as const) {
      const deTipo = lista.filter((c) => c.tipo === tipo);
      for (const c of deTipo) {
        const accion = tipo === "COMPRA" ? `Te compramos ${codigo}` : `Te vendemos ${codigo}`;
        const etiqueta = deTipo.length > 1 || porMoneda.get(codigo)!.some((x) => x.etiqueta !== c.etiqueta && x.tipo === tipo) ? ` (${c.etiqueta})` : "";
        lineas.push(`${accion}${etiqueta}: $${formatearMonto(c.valor, 2).replace(/,00$/, "")} COP`);
      }
    }
  }
  await ctx.enviarSistema(lineas.join("\n"));
  return {
    enviado: true,
    nota: "El cliente ya recibió los valores. No los repitas; pregúntale qué operación y monto quiere.",
    opciones: cots.map((c) => ({
      moneda: c.monedaCodigo,
      operacion: c.tipo === "COMPRA" ? "cliente_vende_divisa" : "cliente_compra_divisa",
      etiqueta: c.etiqueta,
    })),
  };
}

const cotizarSchema = z.object({
  operacion: z.enum(["cliente_vende_divisa", "cliente_compra_divisa"]),
  moneda: z.string().min(1),
  monto: z.union([z.string(), z.number()]).transform((v) => String(v).replace(/[^\d.,]/g, "")),
  monto_en: z.enum(["divisa", "pesos"]),
  etiqueta: z.string().optional(),
});

/** "1.500.000" / "1,500.50" / "150,5" -> "1500000" / "1500.50" / "150.5" */
function normalizarNumero(texto: string) {
  const t = texto.trim();
  const ultimoPunto = t.lastIndexOf(".");
  const ultimaComa = t.lastIndexOf(",");
  const sep = Math.max(ultimoPunto, ultimaComa);
  if (sep === -1) return t;
  const decimales = t.length - sep - 1;
  // Separador de miles si deja exactamente 3 dígitos y es el único tipo de separador repetido
  if (decimales === 3 && (ultimoPunto === -1 || ultimaComa === -1)) return t.replace(/[.,]/g, "");
  return t.slice(0, sep).replace(/[.,]/g, "") + "." + t.slice(sep + 1);
}

async function cotizar(ctx: ContextoBot, args: Record<string, unknown>) {
  const p = cotizarSchema.safeParse(args);
  if (!p.success) return { error: "Faltan datos: operacion, moneda, monto y monto_en" };
  const { operacion, monto_en } = p.data;
  const moneda = await monedaPorCodigo(p.data.moneda);
  const local = await monedaPorCodigo(MONEDA_LOCAL);
  if (!moneda || !local || moneda.codigo === MONEDA_LOCAL) return { error: `No trabajamos la moneda ${p.data.moneda}` };

  let monto: Decimal;
  try {
    monto = new Decimal(normalizarNumero(p.data.monto));
  } catch {
    return { error: "El monto no es un número válido; pídeselo de nuevo al cliente" };
  }
  if (monto.lte(0)) return { error: "El monto debe ser mayor a cero" };

  const tipo = tipoTransaccion(operacion);
  const tipoCot = tipo === "COMPRA_DIVISA" ? "COMPRA" : "VENTA";
  const opciones = (await cotizacionesDelBot(ctx.config)).filter((c) => c.monedaId === moneda.id && c.tipo === tipoCot);
  if (opciones.length === 0) {
    return { error: `Hoy no hay tasa de ${tipoCot === "COMPRA" ? "compra" : "venta"} de ${moneda.codigo} disponible por este medio. Ofrece pasar con una persona.` };
  }
  let cot = opciones[0]!;
  if (opciones.length > 1) {
    const elegida = p.data.etiqueta ? opciones.find((c) => c.etiqueta.toLowerCase() === p.data.etiqueta!.toLowerCase()) : undefined;
    if (!elegida) return { necesita_elegir: true, etiquetas: opciones.map((c) => c.etiqueta), nota: "Pregúntale al cliente cuál aplica y vuelve a cotizar con etiqueta" };
    cot = elegida;
  }

  const calculo = await calcularCambio(pool, {
    tipo,
    monedaExtranjeraId: moneda.id,
    monedaLocalId: local.id,
    cotizacionDetalleId: cot.id,
    ...(monto_en === "divisa" ? { cantidadExtranjera: monto.toString() } : { montoLocal: monto.toString() }),
  });

  const divisa = textoMonto(calculo.cantidadExtranjera, moneda.codigo, moneda.decimales);
  const pesos = textoMonto(calculo.montoLocal, MONEDA_LOCAL, local.decimales);
  const tasa = `$${formatearMonto(calculo.tasa, 2).replace(/,00$/, "")}`;
  const texto =
    tipo === "COMPRA_DIVISA"
      ? `*Cotización*\nNos entregas: ${divisa}\nRecibes: ${pesos}\nTasa: ${tasa} por ${moneda.codigo}`
      : `*Cotización*\nNos pagas: ${pesos}\nRecibes: ${divisa}\nTasa: ${tasa} por ${moneda.codigo}`;
  await ctx.enviarSistema(texto);

  await actualizarEstado(ctx, {
    cotizacion: {
      tipo,
      monedaId: moneda.id,
      monedaCodigo: moneda.codigo,
      cotizacionId: cot.id,
      etiqueta: cot.etiqueta,
      cantidadExtranjera: calculo.cantidadExtranjera.toString(),
      montoLocal: calculo.montoLocal.toString(),
      tasa: calculo.tasa.toString(),
      montoEn: monto_en,
      en: new Date().toISOString(),
    },
  });
  return {
    enviado: true,
    nota: "El cliente ya recibió la cotización exacta. NO repitas los montos. Pregúntale si quiere hacer la operación.",
    operacion,
    moneda: moneda.codigo,
  };
}

async function registrarCliente(ctx: ContextoBot, args: Record<string, unknown>) {
  const p = z.object({ nombre: z.string().min(3), identificacion: z.string().min(4) }).safeParse(args);
  if (!p.success) return { error: "Necesito nombre completo y número de documento" };
  const nombre = p.data.nombre.trim();
  const identificacion = p.data.identificacion.replace(/[^\dA-Za-z]/g, "").toUpperCase();

  if (ctx.terceroId) return { registrado: true, ya_existia: true };

  const existente = await pool.query(
    `SELECT id, telefono FROM terceros WHERE upper(regexp_replace(coalesce(identificacion, ''), '[^0-9A-Za-z]', '', 'g')) = $1 LIMIT 1`,
    [identificacion]
  );
  const otro = existente.rows[0];
  if (otro) {
    const mismoTelefono = otro.telefono && otro.telefono.replace(/\D/g, "").slice(-10) === ctx.telefono.slice(-10);
    if (!mismoTelefono) {
      // No se vincula solo: alguien podría usar la cédula de otra persona
      await ctx.pasarAHumano("su documento ya está registrado con otro número de teléfono");
      return { registrado: false, derivado_a_humano: true, nota: "Dile que una persona del equipo confirmará sus datos en un momento." };
    }
    if (ctx.simulacion) ctx.efectos.push(`Vincularía el chat con el cliente #${otro.id}`);
    else await pool.query(`UPDATE wa_chats SET tercero_id = $1 WHERE jid = $2`, [otro.id, ctx.jid]);
    ctx.terceroId = otro.id;
    return { registrado: true, ya_existia: true };
  }

  if (ctx.simulacion) {
    ctx.efectos.push(`Crearía el cliente "${nombre}" (doc. ${identificacion}, tel. ${ctx.telefono})`);
    ctx.terceroId = -1;
    return { registrado: true };
  }
  const nuevo = await pool.query(
    `INSERT INTO terceros (nombre, identificacion, telefono, tipo) VALUES ($1, $2, $3, 'CLIENTE') RETURNING id`,
    [nombre, identificacion, ctx.telefono]
  );
  ctx.terceroId = nuevo.rows[0].id;
  await pool.query(`UPDATE wa_chats SET tercero_id = $1 WHERE jid = $2`, [ctx.terceroId, ctx.jid]);
  await notaInterna(ctx.jid, `El bot registró al cliente ${nombre} (doc. ${identificacion}). Identidad sin verificar.`);
  return { registrado: true };
}

const nuevaCuentaSchema = z.object({
  tipo: z.enum(["CUENTA_BANCARIA", "PAGO_MOVIL", "ZELLE", "NEQUI", "DAVIPLATA", "OTRO"]),
  banco: z.string().optional(),
  numero_cuenta: z.string().optional(),
  tipo_cuenta: z.enum(["AHORRO", "CORRIENTE"]).optional(),
  titular: z.string().min(3),
  identificacion_titular: z.string().optional(),
  telefono: z.string().optional(),
  email: z.string().optional(),
});

interface CajaPago {
  id: number;
  nombre: string;
  banco: string | null;
  numero_cuenta: string | null;
  tipo_cuenta: string | null;
  titular: string | null;
  identificacion_titular: string | null;
  telefono: string | null;
  email: string | null;
  tipo: string;
}

async function cajaDeMoneda(config: ConfigWa, codigo: string): Promise<CajaPago | null> {
  const id = config.negocio.cajasPorMoneda[codigo];
  if (id) {
    const r = await pool.query(`SELECT * FROM cajas WHERE id = $1 AND activo`, [id]);
    return r.rows[0] ?? null;
  }
  // Sin configurar: la única cuenta bancaria activa de esa moneda, si hay una sola
  const r = await pool.query(
    `SELECT c.* FROM cajas c JOIN monedas m ON m.id = c.moneda_id WHERE c.activo AND c.tipo = 'BANCO' AND m.codigo = $1`,
    [codigo]
  );
  return r.rows.length === 1 ? r.rows[0] : null;
}

/** Texto con los datos de pago: lo arma y lo envía el SISTEMA, nunca la IA. */
function textoDatosPago(caja: CajaPago, monto: string, solicitudId: number, venceEn: Date, zona: string) {
  const hora = new Intl.DateTimeFormat("es-CO", { timeZone: zona, hour: "numeric", minute: "2-digit" }).format(venceEn);
  const lineas = [
    `*Solicitud #${solicitudId}*`,
    `Transfiere exactamente: *${monto}*`,
    "",
    caja.banco ? `Banco: ${caja.banco}` : `Cuenta: ${caja.nombre}`,
    caja.numero_cuenta ? `Número: ${caja.numero_cuenta}${caja.tipo_cuenta ? ` (${caja.tipo_cuenta.toLowerCase()})` : ""}` : null,
    caja.telefono && !caja.numero_cuenta ? `Teléfono: ${caja.telefono}` : null,
    caja.email ? `Correo: ${caja.email}` : null,
    caja.titular ? `Titular: ${caja.titular}` : null,
    caja.identificacion_titular ? `Documento: ${caja.identificacion_titular}` : null,
    "",
    `La tasa queda congelada hasta las ${hora}. Cuando pagues, envía por aquí la foto del comprobante.`,
  ];
  return lineas.filter((l) => l !== null).join("\n");
}

async function crearSolicitud(ctx: ContextoBot, args: Record<string, unknown>) {
  const cot = ctx.estado.cotizacion;
  if (!cot) return { error: "Primero hay que cotizar (herramienta cotizar)" };
  if (!ctx.terceroId) return { error: "El cliente no está registrado: pídele nombre completo y documento y usa registrar_cliente" };
  if (Date.now() - new Date(cot.en).getTime() > 60 * 60_000) {
    return { error: "La cotización tiene más de una hora. Vuelve a cotizar para usar la tasa actual." };
  }

  // No duplicar: si ya hay una solicitud activa sin pagar en este chat, se reutiliza
  if (ctx.estado.solicitudId && !ctx.simulacion) {
    const r = await pool.query(`SELECT id, estado, tasa_vence_en FROM transacciones WHERE id = $1`, [ctx.estado.solicitudId]);
    const activa = r.rows[0];
    if (activa && activa.estado === "PENDIENTE" && !ctx.estado.comprobanteRecibido && new Date(activa.tasa_vence_en) > new Date()) {
      return { error: `Ya hay una solicitud activa (#${activa.id}) esperando el pago. Usa enviar_datos_pago si necesita los datos otra vez.` };
    }
  }

  const monedaDivisa = cot.monedaCodigo;
  const clienteRecibe = cot.tipo === "COMPRA_DIVISA" ? MONEDA_LOCAL : monedaDivisa;
  const clientePaga = cot.tipo === "COMPRA_DIVISA" ? monedaDivisa : MONEDA_LOCAL;
  const cajaDivisa = await cajaDeMoneda(ctx.config, monedaDivisa);
  const cajaLocal = await cajaDeMoneda(ctx.config, MONEDA_LOCAL);
  if (!cajaDivisa || !cajaLocal) {
    await ctx.pasarAHumano(`quiere hacer un cambio de ${monedaDivisa} y no hay cuenta configurada para el bot`);
    return { error: "No hay cuenta configurada para esta operación; ya se avisó a una persona. Díselo con amabilidad." };
  }
  const cajaPago = clientePaga === MONEDA_LOCAL ? cajaLocal : cajaDivisa;

  // Cuenta donde recibe el cliente
  let cuentaId: number | null = null;
  const monedaRecibe = await monedaPorCodigo(clienteRecibe);
  if (typeof args.cuenta_id === "number") {
    const r = await pool.query(`SELECT id FROM cuentas_tercero WHERE id = $1 AND tercero_id = $2 AND activo`, [args.cuenta_id, ctx.terceroId]);
    if (!r.rows[0]) return { error: "Esa cuenta no es de este cliente" };
    cuentaId = r.rows[0].id;
  } else if (args.nueva_cuenta) {
    const p = nuevaCuentaSchema.safeParse(args.nueva_cuenta);
    if (!p.success) return { error: "Faltan datos de la cuenta: tipo y titular como mínimo" };
    const datos: DatosCuentaTercero = {
      tipo: p.data.tipo,
      monedaId: monedaRecibe?.id ?? null,
      banco: p.data.banco ?? null,
      numeroCuenta: p.data.numero_cuenta ?? null,
      tipoCuenta: p.data.tipo_cuenta ?? null,
      titular: p.data.titular,
      identificacionTitular: p.data.identificacion_titular ?? null,
      telefono: p.data.telefono ?? null,
      email: p.data.email ?? null,
      alias: "Registrada por WhatsApp",
    };
    if (ctx.simulacion) {
      ctx.efectos.push(`Guardaría la cuenta ${datos.tipo} de ${datos.titular}`);
    } else {
      try {
        cuentaId = (await crearCuentaTercero(ctx.terceroId, datos, await usuarioBotId())).id;
      } catch (err) {
        return { error: (err as Error).message };
      }
    }
  } else {
    return { error: `Falta la cuenta donde el cliente recibe los ${clienteRecibe}: pídesela (tipo, banco, número, titular, documento)` };
  }

  const minutos = ctx.config.negocio.minutosTasa;
  const venceEn = new Date(Date.now() + minutos * 60_000);
  const montoPagar = clientePaga === MONEDA_LOCAL ? cot.montoLocal : cot.cantidadExtranjera;
  const monedaPago = (await monedaPorCodigo(clientePaga))!;
  const textoPagar = textoMonto(montoPagar, clientePaga, monedaPago.decimales);

  if (ctx.simulacion) {
    ctx.efectos.push(`Crearía la solicitud PENDIENTE (${cot.tipo} ${cot.cantidadExtranjera} ${monedaDivisa} = ${cot.montoLocal} COP)`);
    await ctx.enviarSistema(textoDatosPago(cajaPago, textoPagar, 0, venceEn, ctx.config.negocio.zonaHoraria));
    await actualizarEstado(ctx, { solicitudId: 0, cotizacion: null });
    return { creada: true, solicitud: 0, nota: "El sistema ya envió los datos de pago y el monto. No los repitas." };
  }

  const local = (await monedaPorCodigo(MONEDA_LOCAL))!;
  const metodo = await pool.query(`SELECT id FROM metodos_pago WHERE activo AND cuenta_id = $1 ORDER BY id LIMIT 1`, [cajaPago.id]);
  let resultado;
  try {
    resultado = await registrarCambioDivisa({
      tipo: cot.tipo,
      monedaExtranjeraId: cot.monedaId,
      monedaLocalId: local.id,
      cotizacionDetalleId: cot.cotizacionId,
      ...(cot.montoEn === "divisa" ? { cantidadExtranjera: cot.cantidadExtranjera } : { montoLocal: cot.montoLocal }),
      terceroId: ctx.terceroId,
      cuentaTerceroId: cuentaId ?? undefined,
      cajaExtranjeraId: cajaDivisa.id,
      cajaLocalId: cajaLocal.id,
      metodoPagoId: metodo.rows[0]?.id,
      usuarioId: await usuarioBotId(),
    });
  } catch (err) {
    return { error: `No se pudo crear la solicitud: ${(err as Error).message}` };
  }
  const tx = resultado.transaccion;
  // Si la tasa cambió desde que se cotizó, el monto no coincide: se anula y se recotiza
  if (new Decimal(tx.monto_destino).cmp(cot.montoLocal) !== 0 || new Decimal(tx.monto_origen).cmp(cot.cantidadExtranjera) !== 0) {
    await pool.query(`UPDATE transacciones SET estado = 'ANULADA', motivo_rechazo = 'La tasa cambió al crearla' WHERE id = $1 AND estado = 'PENDIENTE'`, [tx.id]);
    return { error: "La tasa cambió desde la cotización. Vuelve a cotizar con cotizar y explícale que se actualizó." };
  }
  if (!resultado.requiereConfirmacion) {
    // Solo pasa si las dos cajas son físicas: el bot no mueve efectivo
    await ctx.pasarAHumano("la operación quedó registrada como efectivo; revisar");
    return { error: "Configuración inválida (cajas físicas). Ya se avisó a una persona." };
  }
  await pool.query(`UPDATE transacciones SET origen = 'WHATSAPP', wa_jid = $2, tasa_vence_en = $3, observacion = 'Solicitud creada por el bot de WhatsApp' WHERE id = $1`, [
    tx.id,
    ctx.jid,
    venceEn,
  ]);
  await actualizarEstado(ctx, { solicitudId: tx.id, cotizacion: null, comprobanteRecibido: null });
  await ctx.enviarSistema(textoDatosPago(cajaPago, textoPagar, tx.id, venceEn, ctx.config.negocio.zonaHoraria));
  await notaInterna(ctx.jid, `El bot creó la solicitud #${tx.id} (pendiente). Tasa congelada ${minutos} min.`);
  return { creada: true, solicitud: tx.id, vence_en_minutos: minutos, nota: "El sistema ya envió los datos de pago y el monto exacto. No los repitas." };
}

async function solicitudActiva(ctx: ContextoBot) {
  if (ctx.estado.solicitudId !== undefined && ctx.simulacion) return { id: ctx.estado.solicitudId, simulada: true } as const;
  const r = await pool.query(
    `SELECT t.*, m.codigo AS moneda_codigo, m.decimales AS moneda_decimales, ml.codigo AS moneda_local_codigo, ml.decimales AS moneda_local_decimales
     FROM transacciones t JOIN monedas m ON m.id = t.moneda_origen_id JOIN monedas ml ON ml.id = t.moneda_destino_id
     WHERE t.estado = 'PENDIENTE' AND t.origen = 'WHATSAPP' AND (t.wa_jid = $1 OR ($2::int IS NOT NULL AND t.tercero_id = $2))
     ORDER BY t.id DESC LIMIT 1`,
    [ctx.jid, ctx.terceroId && ctx.terceroId > 0 ? ctx.terceroId : null]
  );
  return r.rows[0] ?? null;
}

async function enviarDatosPago(ctx: ContextoBot) {
  const tx = await solicitudActiva(ctx);
  if (!tx) return { error: "No hay una solicitud activa. Si quiere operar, cotiza de nuevo." };
  if ("simulada" in tx) {
    await ctx.enviarSistema("(Simulación) Aquí iría de nuevo la cuenta de la empresa con el monto exacto.");
    return { enviado: true };
  }
  if (new Date(tx.tasa_vence_en) < new Date()) return { error: "La tasa de esa solicitud ya venció. Vuelve a cotizar." };
  const clientePagaDivisa = tx.tipo === "COMPRA_DIVISA";
  const cajaId = clientePagaDivisa ? tx.caja_id : tx.caja_destino_id;
  const caja = (await pool.query(`SELECT * FROM cajas WHERE id = $1`, [cajaId])).rows[0];
  const monto = clientePagaDivisa
    ? textoMonto(tx.monto_origen, tx.moneda_codigo, Number(tx.moneda_decimales))
    : textoMonto(tx.monto_destino, MONEDA_LOCAL, Number(tx.moneda_local_decimales));
  await ctx.enviarSistema(textoDatosPago(caja, monto, tx.id, new Date(tx.tasa_vence_en), ctx.config.negocio.zonaHoraria));
  return { enviado: true, nota: "Ya se reenviaron los datos. No los repitas." };
}

async function registrarComprobanteBot(ctx: ContextoBot, args: Record<string, unknown>) {
  if (!ctx.ultimaFotoId) return { error: "No hay una foto reciente del cliente. Pídele que envíe la foto del comprobante." };
  const leido = {
    monto: typeof args.monto_leido === "string" ? args.monto_leido : typeof args.monto_leido === "number" ? String(args.monto_leido) : null,
    referencia: typeof args.referencia === "string" ? args.referencia : null,
    banco: typeof args.banco === "string" ? args.banco : null,
  };
  if (ctx.simulacion) {
    ctx.efectos.push(`Registraría la foto como comprobante (monto ${leido.monto ?? "?"}, ref ${leido.referencia ?? "?"})`);
    await actualizarEstado(ctx, { comprobanteRecibido: true });
    return { registrado: true, nota: "Dile que lo recibiste y que en cuanto se verifique le pagamos." };
  }
  const r = await registrarComprobante({ jid: ctx.jid, mensajeId: ctx.ultimaFotoId, leido, porBot: true });
  if ("error" in r) {
    if (r.derivar) await ctx.pasarAHumano(r.derivar);
    return r;
  }
  ctx.ultimaFotoId = null;
  ctx.estado.comprobanteRecibido = true;
  return { ...r, nota: "Dile que lo recibiste, que está en verificación y que en cuanto se confirme le pagamos." };
}

/**
 * Registra una foto del chat como comprobante de la solicitud activa: documento COMPROBANTE_PAGO
 * vinculado a la transacción (reusa el archivo ya guardado en Cloudinary) y la referencia bancaria.
 * La usa el bot y también el botón "Este es el comprobante" del panel.
 */
export async function registrarComprobante(input: {
  jid: string;
  mensajeId: string;
  leido: { monto: string | null; referencia: string | null; banco: string | null };
  porBot: boolean;
  usuarioId?: number;
}): Promise<{ registrado: true; solicitud: number; alerta?: string } | { error: string; derivar?: string }> {
  const msg = (await pool.query(`SELECT * FROM wa_mensajes WHERE id = $1 AND jid = $2`, [input.mensajeId, input.jid])).rows[0];
  if (!msg || !msg.media_key) return { error: "Esa foto no se pudo guardar; pídele que la envíe otra vez." };

  const chat = (await pool.query(`SELECT * FROM wa_chats WHERE jid = $1`, [input.jid])).rows[0];
  const tx = (
    await pool.query(
      `SELECT t.*, m.codigo AS moneda_codigo FROM transacciones t JOIN monedas m ON m.id = t.moneda_origen_id
       WHERE t.estado = 'PENDIENTE' AND (t.wa_jid = $1 OR ($2::int IS NOT NULL AND t.tercero_id = $2))
       ORDER BY t.id DESC LIMIT 1`,
      [input.jid, chat?.tercero_id ?? null]
    )
  ).rows[0];
  if (!tx) return { error: "No hay una solicitud pendiente para este cliente.", derivar: "envió un comprobante pero no tiene una solicitud pendiente" };
  if (!tx.tercero_id) return { error: "La solicitud no tiene cliente asociado.", derivar: "envió un comprobante de una solicitud sin cliente" };

  const yaEsta = await pool.query(`SELECT id FROM documentos_tercero WHERE archivo_key = $1`, [msg.media_key]);
  if (yaEsta.rows[0]) return { error: "Esa foto ya estaba registrada como comprobante." };

  // Monto esperado: lo que paga el cliente
  const esperado = tx.tipo === "COMPRA_DIVISA" ? new Decimal(tx.monto_origen) : new Decimal(tx.monto_destino);
  let alerta: string | undefined;
  if (input.leido.monto) {
    try {
      const leido = new Decimal(normalizarNumero(input.leido.monto));
      if (!leido.eq(esperado)) alerta = `el monto leído (${leido.toString()}) no coincide con el esperado (${esperado.toString()})`;
    } catch {
      // monto ilegible: queda para la revisión humana
    }
  }

  const usuarioId = input.usuarioId ?? (await usuarioBotId());
  const partesLeidas = [
    input.leido.monto ? `monto ${input.leido.monto}` : null,
    input.leido.referencia ? `ref. ${input.leido.referencia}` : null,
    input.leido.banco ? `banco ${input.leido.banco}` : null,
  ].filter(Boolean);
  const descripcion =
    `Comprobante recibido por WhatsApp${input.porBot ? " (registrado por el bot)" : ""}.` +
    (partesLeidas.length ? ` Leído: ${partesLeidas.join(", ")}.` : "") +
    (alerta ? ` ⚠ ${alerta}.` : "");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO documentos_tercero (tercero_id, transaccion_id, tipo, descripcion, archivo_key, nombre_original, mime_type, tamano_bytes, subido_por_id)
       VALUES ($1, $2, 'COMPROBANTE_PAGO', $3, $4, $5, $6, $7, $8)`,
      [tx.tercero_id, tx.id, descripcion, msg.media_key, `whatsapp-${msg.id}`, msg.media_mime, msg.media_bytes ?? 0, usuarioId]
    );
    if (input.leido.referencia && !tx.referencia_id) {
      const codigo = input.leido.referencia.trim();
      const repetida = await client.query(`SELECT id FROM referencias WHERE codigo = $1`, [codigo]);
      if (repetida.rows[0]) {
        alerta = `la referencia ${codigo} ya fue usada en otra operación`;
        await client.query(`UPDATE documentos_tercero SET descripcion = descripcion || $2 WHERE archivo_key = $1`, [msg.media_key, ` ⚠ ${alerta}.`]);
      } else {
        const ref = await client.query(`INSERT INTO referencias (codigo, banco_origen, estado) VALUES ($1, $2, 'BLOQUEADA') RETURNING id`, [
          codigo,
          input.leido.banco,
        ]);
        await client.query(`UPDATE transacciones SET referencia_id = $1 WHERE id = $2`, [ref.rows[0].id, tx.id]);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await guardarEstadoConversacion(input.jid, { comprobanteRecibido: true });
  await notaInterna(
    input.jid,
    `Comprobante registrado en la solicitud #${tx.id}: queda pendiente de aprobación en la Bandeja.${alerta ? ` Atención: ${alerta}.` : ""}`
  );
  if (alerta?.includes("ya fue usada")) {
    return { error: "Hay que revisar ese comprobante.", derivar: `envió un comprobante con una referencia repetida (solicitud #${tx.id})` };
  }
  return { registrado: true, solicitud: tx.id, ...(alerta ? { alerta } : {}) };
}

async function misOperaciones(ctx: ContextoBot) {
  if (!ctx.terceroId || ctx.terceroId < 0) return { error: "No encontramos operaciones: el cliente aún no está registrado." };
  const r = await pool.query(
    `SELECT t.id, t.tipo, t.estado, t.monto_origen, t.monto_destino, t.created_at, m.codigo, m.decimales
     FROM transacciones t JOIN monedas m ON m.id = t.moneda_origen_id
     WHERE t.tercero_id = $1 AND t.tipo IN ('COMPRA_DIVISA', 'VENTA_DIVISA')
     ORDER BY t.id DESC LIMIT 5`,
    [ctx.terceroId]
  );
  if (r.rows.length === 0) return { enviado: false, nota: "No tiene operaciones registradas." };
  const estados: Record<string, string> = {
    PENDIENTE: "en verificación",
    CONFIRMADA: "completada",
    RECHAZADA: "rechazada",
    ANULADA: "anulada",
    BLOQUEADA: "en revisión",
  };
  const lineas = ["*Tus últimas operaciones*"];
  for (const t of r.rows) {
    const fecha = new Intl.DateTimeFormat("es-CO", { timeZone: ctx.config.negocio.zonaHoraria, day: "numeric", month: "short" }).format(t.created_at);
    const accion = t.tipo === "COMPRA_DIVISA" ? "Nos vendiste" : "Compraste";
    lineas.push(`#${t.id} · ${fecha} · ${accion} ${formatearMonto(t.monto_origen, Number(t.decimales))} ${t.codigo} · ${estados[t.estado] ?? t.estado}`);
  }
  await ctx.enviarSistema(lineas.join("\n"));
  return {
    enviado: true,
    operaciones: r.rows.map((t) => ({ id: t.id, estado: estados[t.estado] ?? t.estado })),
    nota: "El cliente ya recibió el listado. Comenta solo lo que pregunte.",
  };
}

async function pasarAHumano(ctx: ContextoBot, args: Record<string, unknown>) {
  const motivo = typeof args.motivo === "string" && args.motivo.trim() ? args.motivo.trim() : "pidió hablar con una persona";
  await ctx.pasarAHumano(motivo);
  return { derivado: true, nota: "Dile en una frase que una persona del equipo le escribe en breve. No prometas tiempos exactos." };
}
