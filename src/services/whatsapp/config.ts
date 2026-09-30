import { z } from "zod";
import { pool } from "../../db/pool";
import { PROVEEDORES, type Proveedor } from "./ia";

// Toda la configuración del bot vive en wa_config (BD), no en .env ni en git.

const horaSchema = z.string().regex(/^\d{2}:\d{2}$/, "Hora en formato HH:MM");

export const configSchema = z.object({
  ia: z.object({
    activa: z.boolean(), // apagada = el bot no responde (el panel sigue funcionando)
    proveedor: z.enum(PROVEEDORES as [Proveedor, ...Proveedor[]]),
    modelo: z.string(),
    modelosRespaldo: z.array(z.string()),
    vision: z.boolean(),
  }),
  personalidad: z.object({
    nombreAsistente: z.string(),
    instrucciones: z.string(), // tono y reglas propias del negocio
  }),
  negocio: z.object({
    nombre: z.string(),
    descripcion: z.string(),
    direccion: z.string(),
    zonaHoraria: z.string(),
    numeroWhatsapp: z.string(), // para wa.me (el cliente escribe primero)
    infoAdicional: z.string(), // preguntas frecuentes, requisitos, límites...
    // Cotizaciones que el bot puede usar: "MONEDA|COMPRA|etiqueta". Vacío = todas las de precio fijo.
    cotizacionesPermitidas: z.array(z.string()),
    // Cuenta de la empresa (caja tipo BANCO) por moneda: dónde paga el cliente y desde dónde se le paga
    cajasPorMoneda: z.record(z.string(), z.number().int()),
    minutosTasa: z.number().int().min(5).max(240),
  }),
  horario: z.object({
    // 0 = domingo. Vacío = sin horario de atención humana definido
    dias: z.array(z.object({ dia: z.number().int().min(0).max(6), desde: horaSchema, hasta: horaSchema })),
    responderFueraDeHorario: z.boolean(),
  }),
  antibloqueo: z.object({
    porMinuto: z.number().int().min(1).max(60),
    porDia: z.number().int().min(10).max(5000),
    pausaMinMs: z.number().int().min(0),
    pausaMaxMs: z.number().int().min(0),
    friosPorDia: z.number().int().min(0).max(200),
    friosPausaMinS: z.number().int().min(10),
    friosPausaMaxS: z.number().int().min(10),
    friosDesde: horaSchema,
    friosHasta: horaSchema,
    antiBucleMax: z.number().int().min(3).max(50), // respuestas del bot a un chat en 5 min
    viejosMinutos: z.number().int().min(1).max(1440), // al reconectar, lo más viejo que esto lo atiende una persona
  }),
  dueno: z.object({
    nombre: z.string(),
    telefono: z.string(), // solo dígitos con código de país
    avisos: z.boolean(),
    resumenCadaMin: z.number().int().min(0).max(1440), // 0 = sin resumen
    silencioDesde: horaSchema,
    silencioHasta: horaSchema,
  }),
  panel: z.object({
    respuestasRapidas: z.array(z.string()),
  }),
});

export type ConfigWa = z.infer<typeof configSchema>;
export type ClavesIA = Partial<Record<Proveedor, string>>;

export const CONFIG_POR_DEFECTO: ConfigWa = {
  ia: { activa: false, proveedor: "gemini", modelo: "", modelosRespaldo: [], vision: true },
  personalidad: {
    nombreAsistente: "Vale",
    instrucciones:
      "Hablas como una asesora amable y resolutiva de una casa de cambio. Tuteas, eres cercana pero profesional, " +
      "y vas al grano. Usas muy pocos emojis.",
  },
  negocio: {
    nombre: "Veloz al Cambio",
    descripcion: "Casa de cambio: compra y venta de dólares, euros, bolívares y USDT contra pesos colombianos.",
    direccion: "",
    zonaHoraria: "America/Bogota",
    numeroWhatsapp: "",
    infoAdicional: "",
    cotizacionesPermitidas: [],
    cajasPorMoneda: {},
    minutosTasa: 30,
  },
  horario: {
    dias: [1, 2, 3, 4, 5].map((dia) => ({ dia, desde: "08:00", hasta: "18:00" })).concat([{ dia: 6, desde: "09:00", hasta: "13:00" }]),
    responderFueraDeHorario: true,
  },
  antibloqueo: {
    porMinuto: 12,
    porDia: 400,
    pausaMinMs: 1200,
    pausaMaxMs: 3500,
    friosPorDia: 10,
    friosPausaMinS: 90,
    friosPausaMaxS: 240,
    friosDesde: "09:00",
    friosHasta: "19:00",
    antiBucleMax: 10,
    viejosMinutos: 15,
  },
  dueno: { nombre: "", telefono: "", avisos: true, resumenCadaMin: 60, silencioDesde: "22:00", silencioHasta: "07:00" },
  panel: {
    respuestasRapidas: [
      "Hola, ¿en qué te puedo ayudar?",
      "Dame un momento y ya te confirmo.",
      "Ya recibimos tu comprobante, lo estamos verificando.",
      "¡Listo! Tu operación quedó confirmada.",
    ],
  },
};

interface FilaConfig {
  config: ConfigWa;
  claves: ClavesIA;
}

let cache: { valor: FilaConfig; en: number } | null = null;

/** Mezcla lo guardado con los valores por defecto (una sección nueva no rompe configs viejas). */
function completar(guardado: Partial<ConfigWa> | undefined): ConfigWa {
  const base = structuredClone(CONFIG_POR_DEFECTO);
  if (!guardado) return base;
  for (const k of Object.keys(base) as (keyof ConfigWa)[]) {
    if (guardado[k]) Object.assign(base[k], guardado[k]);
  }
  return base;
}

export async function leerConfigCompleta(): Promise<FilaConfig> {
  if (cache && Date.now() - cache.en < 5_000) return cache.valor;
  const r = await pool.query(`SELECT datos FROM wa_config WHERE id = 1`);
  const datos = r.rows[0]?.datos ?? {};
  const valor = { config: completar(datos.config), claves: (datos.claves ?? {}) as ClavesIA };
  cache = { valor, en: Date.now() };
  return valor;
}

export async function leerConfig() {
  return (await leerConfigCompleta()).config;
}

export function enmascarar(clave: string) {
  if (clave.length <= 10) return "••••";
  return `${clave.slice(0, 5)}…${clave.slice(-4)}`;
}

/** Lo que ve el front: las claves solo enmascaradas. */
export async function leerConfigParaPanel() {
  const { config, claves } = await leerConfigCompleta();
  const clavesMascara: Partial<Record<Proveedor, string>> = {};
  for (const p of PROVEEDORES) {
    const c = claves[p];
    if (c) clavesMascara[p] = enmascarar(c);
  }
  return { config, claves: clavesMascara };
}

export async function guardarConfig(config: ConfigWa) {
  const valida = configSchema.parse(config);
  await pool.query(
    `UPDATE wa_config SET datos = jsonb_set(datos, '{config}', $1::jsonb), actualizado_en = now() WHERE id = 1`,
    [JSON.stringify(valida)]
  );
  cache = null;
  return leerConfigParaPanel();
}

/** clave vacía = borrar la de ese proveedor. */
export async function guardarClave(proveedor: Proveedor, clave: string) {
  const limpia = clave.trim();
  await pool.query(
    limpia
      ? `UPDATE wa_config SET datos = jsonb_set(jsonb_set(datos, '{claves}', coalesce(datos->'claves', '{}'::jsonb)), ARRAY['claves', $1::text], to_jsonb($2::text)), actualizado_en = now() WHERE id = 1`
      : `UPDATE wa_config SET datos = datos #- ARRAY['claves', $1::text], actualizado_en = now() WHERE id = 1`,
    limpia ? [proveedor, limpia] : [proveedor]
  );
  cache = null;
  return leerConfigParaPanel();
}

export async function claveDe(proveedor: Proveedor) {
  return (await leerConfigCompleta()).claves[proveedor] ?? null;
}

// ---------- Estado del asistente del dueño (cliente en foco, último resumen) ----------
export interface EstadoDueno {
  focoJid?: string | null;
  focoEn?: string | null;
  ultimoResumenEn?: string | null;
  modo?: "aviso" | "resumen" | null; // a qué se refiere un "1"/"2" del dueño
  modoEn?: string | null;
}

export async function leerEstadoDueno(): Promise<EstadoDueno> {
  const r = await pool.query(`SELECT estado_dueno FROM wa_config WHERE id = 1`);
  return r.rows[0]?.estado_dueno ?? {};
}

export async function guardarEstadoDueno(cambios: EstadoDueno) {
  await pool.query(`UPDATE wa_config SET estado_dueno = estado_dueno || $1::jsonb WHERE id = 1`, [JSON.stringify(cambios)]);
}

// ---------- Utilidades de hora local ----------
/** Hora local "HH:MM" y día de la semana en la zona del negocio. */
export function ahoraLocal(zona: string, fecha = new Date()) {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: zona,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(fecha);
  const get = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  const dias = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hora = `${get("hour").replace("24", "00")}:${get("minute")}`;
  return { hora, dia: dias.indexOf(get("weekday")) };
}

/** true si `hora` está en [desde, hasta). Soporta rangos que cruzan la medianoche (22:00-07:00). */
export function enRango(hora: string, desde: string, hasta: string) {
  if (desde === hasta) return false;
  return desde < hasta ? hora >= desde && hora < hasta : hora >= desde || hora < hasta;
}

export function enHorarioAtencion(config: ConfigWa, fecha = new Date()) {
  const { hora, dia } = ahoraLocal(config.negocio.zonaHoraria, fecha);
  return config.horario.dias.some((d) => d.dia === dia && enRango(hora, d.desde, d.hasta));
}
