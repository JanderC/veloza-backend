import Anthropic from "@anthropic-ai/sdk";

// Capa de IA con varios proveedores y function calling.
// - Formato OpenAI (fetch): Gemini, OpenAI, Groq, OpenRouter, DeepSeek.
// - Claude: SDK oficial @anthropic-ai/sdk.
// Cada adaptador corre su propio ciclo de herramientas; lo común (429, respaldo) va acá arriba.

export type Proveedor = "gemini" | "openai" | "groq" | "openrouter" | "deepseek" | "anthropic";
export const PROVEEDORES: Proveedor[] = ["gemini", "openai", "groq", "openrouter", "deepseek", "anthropic"];

const BASES_OPENAI: Record<Exclude<Proveedor, "anthropic">, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com",
};

/** Proveedor según el prefijo de la clave (para seleccionarlo solo en la pantalla). */
export function detectarProveedor(clave: string): Proveedor | null {
  const c = clave.trim();
  if (c.startsWith("sk-ant-")) return "anthropic";
  if (c.startsWith("sk-or-")) return "openrouter";
  if (c.startsWith("gsk_")) return "groq";
  if (c.startsWith("AIza")) return "gemini";
  if (c.startsWith("sk-")) return "openai"; // DeepSeek también usa sk-: se elige a mano
  return null;
}

export interface ParteImagen {
  base64: string;
  mime: string;
}

/** Historial neutro: texto (y fotos) del cliente y respuestas anteriores del negocio. */
export interface MensajeNeutro {
  rol: "user" | "assistant";
  texto: string;
  imagenes?: ParteImagen[];
}

export interface HerramientaIA {
  nombre: string;
  descripcion: string;
  parametros: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface LlamadaHerramienta {
  nombre: string;
  args: Record<string, unknown>;
  resultado: string;
}

export interface OpcionesTurno {
  proveedor: Proveedor;
  clave: string;
  modelo: string;
  modelosRespaldo?: string[];
  sistema: string;
  historial: MensajeNeutro[];
  herramientas: HerramientaIA[];
  ejecutar: (nombre: string, args: Record<string, unknown>) => Promise<string>;
  maxPasos?: number;
}

export interface ResultadoTurno {
  texto: string;
  llamadas: LlamadaHerramienta[];
  modeloUsado: string;
}

export class ErrorIA extends Error {
  constructor(mensaje: string, public status?: number, public esperarMs?: number) {
    super(mensaje);
  }
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 429: esperar lo que dice el proveedor y reintentar; si sigue, modelo de respaldo ----------
const MAX_ESPERA_429_MS = 60_000;

async function conReintentos429<T>(fn: () => Promise<T>): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ErrorIA) || err.status !== 429 || intento >= 2) throw err;
      const espera = Math.min(err.esperarMs ?? 5_000 * (intento + 1), MAX_ESPERA_429_MS);
      console.warn(`[ia] 429, reintentando en ${Math.round(espera / 1000)} s`);
      await esperar(espera);
    }
  }
}

// Para pruebas: una IA simulada que decide respuestas y llamadas a herramientas
type IaSimulada = (op: OpcionesTurno) => Promise<ResultadoTurno>;
let iaSimulada: IaSimulada | null = null;
export function usarIaSimulada(fn: IaSimulada | null) {
  iaSimulada = fn;
}

export async function ejecutarTurno(op: OpcionesTurno): Promise<ResultadoTurno> {
  if (iaSimulada) return iaSimulada(op);
  const modelos = [op.modelo, ...(op.modelosRespaldo ?? []).filter((m) => m && m !== op.modelo)];
  let ultimoError: unknown;
  for (const modelo of modelos) {
    try {
      const adaptador = op.proveedor === "anthropic" ? turnoAnthropic : turnoOpenAI;
      return await conReintentos429(() => adaptador({ ...op, modelo }));
    } catch (err) {
      ultimoError = err;
      // Solo se pasa al modelo de respaldo si el problema es de límite o del modelo, no de la clave
      if (err instanceof ErrorIA && (err.status === 401 || err.status === 403)) throw err;
      console.warn(`[ia] falló ${op.proveedor}/${modelo}: ${(err as Error).message}`);
    }
  }
  throw ultimoError;
}

// ---------- Formato OpenAI ----------
interface MensajeOpenAI {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function esperaDesdeError(res: Response, cuerpo: string): number | undefined {
  const cabecera = res.headers.get("retry-after");
  if (cabecera && Number.isFinite(Number(cabecera))) return Number(cabecera) * 1000;
  // Gemini/Groq lo dicen en el texto: "retry in 23.5s" / "try again in 1m2.3s"
  const m = cuerpo.match(/(?:retry in|try again in)\s*(?:(\d+)m)?([\d.]+)s/i);
  if (m) return (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000;
  return undefined;
}

async function llamarOpenAI(proveedor: Exclude<Proveedor, "anthropic">, clave: string, ruta: string, cuerpo?: unknown) {
  const res = await fetch(`${BASES_OPENAI[proveedor]}${ruta}`, {
    method: cuerpo ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${clave}`,
      "Content-Type": "application/json",
      ...(proveedor === "openrouter" ? { "X-Title": "Veloz al Cambio" } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  const texto = await res.text();
  if (!res.ok) {
    let mensaje = texto.slice(0, 400);
    try {
      const j = JSON.parse(texto);
      const e = Array.isArray(j) ? j[0]?.error : j.error;
      mensaje = e?.message ?? mensaje;
    } catch {
      // cuerpo no JSON
    }
    throw new ErrorIA(`${proveedor} ${res.status}: ${mensaje}`, res.status, res.status === 429 ? esperaDesdeError(res, texto) : undefined);
  }
  return JSON.parse(texto);
}

async function turnoOpenAI(op: OpcionesTurno): Promise<ResultadoTurno> {
  const proveedor = op.proveedor as Exclude<Proveedor, "anthropic">;
  const mensajes: MensajeOpenAI[] = [{ role: "system", content: op.sistema }];
  for (const m of op.historial) {
    if (m.rol === "user" && m.imagenes?.length) {
      mensajes.push({
        role: "user",
        content: [
          { type: "text", text: m.texto || "(foto)" },
          ...m.imagenes.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.base64}` } })),
        ],
      });
    } else {
      mensajes.push({ role: m.rol, content: m.texto });
    }
  }
  const tools = op.herramientas.map((h) => ({
    type: "function",
    function: { name: h.nombre, description: h.descripcion, parameters: h.parametros },
  }));

  const llamadas: LlamadaHerramienta[] = [];
  for (let paso = 0; paso < (op.maxPasos ?? 8); paso++) {
    const r = await llamarOpenAI(proveedor, op.clave, "/chat/completions", {
      model: op.modelo,
      messages: mensajes,
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      temperature: 0.6,
    });
    const msg = r.choices?.[0]?.message;
    if (!msg) throw new ErrorIA(`${proveedor}: respuesta vacía`);
    const toolCalls: NonNullable<MensajeOpenAI["tool_calls"]> = msg.tool_calls ?? [];
    if (toolCalls.length === 0) return { texto: (msg.content ?? "").trim(), llamadas, modeloUsado: op.modelo };

    mensajes.push({ role: "assistant", content: msg.content ?? "", tool_calls: toolCalls });
    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = {};
      }
      const resultado = await ejecutarSeguro(op, tc.function.name, args);
      llamadas.push({ nombre: tc.function.name, args, resultado });
      mensajes.push({ role: "tool", tool_call_id: tc.id, content: resultado });
    }
  }
  throw new ErrorIA("La IA llamó demasiadas herramientas seguidas");
}

async function ejecutarSeguro(op: OpcionesTurno, nombre: string, args: Record<string, unknown>) {
  try {
    return await op.ejecutar(nombre, args);
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}

// ---------- Claude (SDK oficial) ----------
function clienteAnthropic(clave: string) {
  // Reintentos propios (conReintentos429) para tratar igual a todos los proveedores
  return new Anthropic({ apiKey: clave, maxRetries: 0, timeout: 90_000 });
}

// Modelos que aceptan el respaldo del lado del servidor cuando el modelo rechaza la petición
const ACEPTAN_FALLBACK_DEFAULT = ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];

function aErrorIA(err: unknown): unknown {
  if (err instanceof Anthropic.APIError) {
    const retry = err.headers?.get?.("retry-after");
    return new ErrorIA(`anthropic ${err.status}: ${err.message}`, err.status, retry ? Number(retry) * 1000 : undefined);
  }
  return err;
}

async function turnoAnthropic(op: OpcionesTurno): Promise<ResultadoTurno> {
  const client = clienteAnthropic(op.clave);
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of op.historial) {
    const contenido: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const i of m.imagenes ?? []) {
      contenido.push({
        type: "image",
        source: { type: "base64", media_type: i.mime as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data: i.base64 },
      });
    }
    contenido.push({ type: "text", text: m.texto || "(foto)" });
    messages.push({ role: m.rol, content: contenido });
  }
  // La API exige que empiece por el usuario
  while (messages[0]?.role === "assistant") messages.shift();

  const tools: Anthropic.Beta.BetaTool[] = op.herramientas.map((h) => ({
    name: h.nombre,
    description: h.descripcion,
    input_schema: h.parametros,
  }));
  const conFallback = ACEPTAN_FALLBACK_DEFAULT.includes(op.modelo);

  const llamadas: LlamadaHerramienta[] = [];
  for (let paso = 0; paso < (op.maxPasos ?? 8); paso++) {
    let respuesta: Anthropic.Beta.BetaMessage;
    try {
      respuesta = await client.beta.messages.create({
        model: op.modelo,
        max_tokens: 16000,
        system: op.sistema,
        messages,
        tools,
        // Chat corto: esfuerzo bajo (el pensamiento sigue activo, pero breve)
        output_config: { effort: "low" },
        ...(conFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
    } catch (err) {
      throw aErrorIA(err);
    }

    if (respuesta.stop_reason === "refusal") throw new ErrorIA("Claude rechazó responder este mensaje");
    if (respuesta.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: respuesta.content });
      continue;
    }
    const usos = respuesta.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (usos.length === 0) {
      const texto = respuesta.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { texto, llamadas, modeloUsado: respuesta.model };
    }

    // Se devuelve el contenido tal cual (incluye bloques de pensamiento) y todos los resultados juntos
    messages.push({ role: "assistant", content: respuesta.content });
    const resultados: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const uso of usos) {
      const args = (uso.input ?? {}) as Record<string, unknown>;
      const resultado = await ejecutarSeguro(op, uso.name, args);
      llamadas.push({ nombre: uso.name, args, resultado });
      resultados.push({ type: "tool_result", tool_use_id: uso.id, content: resultado });
    }
    messages.push({ role: "user", content: resultados });
  }
  throw new ErrorIA("La IA llamó demasiadas herramientas seguidas");
}

// ---------- Modelos en vivo ----------
export interface ModeloDisponible {
  id: string;
  nombre: string;
  vision: boolean;
}

const NO_CHAT = /embed|tts|whisper|dall-e|image|audio|realtime|moderation|transcribe|search|guard|aqa|imagen|veo|learnlm|computer-use|codex/i;

function adivinarVision(proveedor: Proveedor, id: string) {
  if (proveedor === "gemini") return true;
  if (proveedor === "openai") return /gpt-4o|gpt-4\.1|gpt-5|o3|o4/.test(id);
  if (proveedor === "groq") return /llama-4|vision/i.test(id);
  return false;
}

export async function listarModelos(proveedor: Proveedor, clave: string): Promise<ModeloDisponible[]> {
  if (proveedor === "anthropic") {
    const client = clienteAnthropic(clave);
    const lista: ModeloDisponible[] = [];
    try {
      for await (const m of client.models.list()) {
        const caps = m.capabilities as { image_input?: { supported?: boolean } } | null;
        lista.push({ id: m.id, nombre: m.display_name, vision: caps?.image_input?.supported ?? true });
      }
    } catch (err) {
      throw aErrorIA(err);
    }
    return lista;
  }

  const r = await llamarOpenAI(proveedor, clave, "/models");
  const datos: { id: string; name?: string; supported_parameters?: string[]; architecture?: { input_modalities?: string[] } }[] =
    r.data ?? [];
  return datos
    .filter((m) => !NO_CHAT.test(m.id))
    .filter((m) => proveedor !== "openrouter" || (m.supported_parameters ?? []).includes("tools"))
    .map((m) => ({
      id: m.id.replace(/^models\//, ""),
      nombre: m.name ?? m.id.replace(/^models\//, ""),
      vision: proveedor === "openrouter" ? (m.architecture?.input_modalities ?? []).includes("image") : adivinarVision(proveedor, m.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** "Probar conexión": el modelo tiene que llamar a una herramienta, no solo contestar texto. */
export async function probarConexion(proveedor: Proveedor, clave: string, modelo: string) {
  const inicio = Date.now();
  let llamo = false;
  const r = await ejecutarTurno({
    proveedor,
    clave,
    modelo,
    sistema: "Eres un asistente de prueba. Para saber la hora SIEMPRE usas la herramienta consultar_hora.",
    historial: [{ rol: "user", texto: "¿Qué hora es? Usa la herramienta y luego responde en una frase." }],
    herramientas: [
      { nombre: "consultar_hora", descripcion: "Devuelve la hora actual", parametros: { type: "object", properties: {} } },
    ],
    ejecutar: async () => {
      llamo = true;
      return JSON.stringify({ hora: new Date().toISOString() });
    },
    maxPasos: 3,
  });
  return { ok: llamo, usaHerramientas: llamo, respuesta: r.texto, modelo: r.modeloUsado, ms: Date.now() - inicio };
}
