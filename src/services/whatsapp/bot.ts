import { pool } from "../../db/pool";
import { ahoraLocal, claveDe, enHorarioAtencion, leerConfig, type ConfigWa } from "./config";
import { ejecutarTurno, ErrorIA, type LlamadaHerramienta, type MensajeNeutro, type ParteImagen } from "./ia";
import { definicionesHerramientas, ejecutarHerramienta, formatearMonto, type ContextoBot } from "./herramientas";
import { obtenerChat, type EstadoConversacion, type FilaChat, type FilaMensaje } from "./mensajes";
import { enviarMensaje } from "./envio";
import { leerMedia } from "./mediaMemoria";
import { transporte } from "./transporte";
import { marcarNecesitaHumano } from "./atencion";

// Bot conversacional. Concurrencia (fue un bug real): UNA cola por chat.
// - Las ráfagas se agrupan: se espera ~6 s sin mensajes nuevos antes de responder.
// - Lo que llega mientras corre un turno se atiende en UN turno siguiente, nunca en dos.
// - Cada turno solo ve el historial hasta su último mensaje (hastaId).

const ESPERA_RAFAGA_MS = Number(process.env.WA_DEBOUNCE_MS ?? 6_000);

interface ColaChat {
  timer: NodeJS.Timeout | null;
  corriendo: boolean;
  pendiente: boolean;
}
const colas = new Map<string, ColaChat>();

export function encolarTurno(jid: string) {
  let c = colas.get(jid);
  if (!c) {
    c = { timer: null, corriendo: false, pendiente: false };
    colas.set(jid, c);
  }
  if (c.timer) clearTimeout(c.timer);
  c.timer = setTimeout(() => void disparar(jid), ESPERA_RAFAGA_MS);
}

async function disparar(jid: string) {
  const c = colas.get(jid);
  if (!c) return;
  c.timer = null;
  if (c.corriendo) {
    c.pendiente = true; // se atiende en un único turno siguiente
    return;
  }
  c.corriendo = true;
  try {
    await turno(jid);
  } catch (err) {
    console.error(`[bot] error en el turno de ${jid}`, err);
  } finally {
    c.corriendo = false;
    if (c.pendiente) {
      c.pendiente = false;
      encolarTurno(jid);
    } else if (!c.timer) {
      colas.delete(jid);
    }
  }
}

/** Para pruebas: espera a que no quede ningún turno corriendo ni programado. */
export async function esperarColasVacias(timeoutMs = 60_000) {
  const inicio = Date.now();
  while (colas.size > 0) {
    if (Date.now() - inicio > timeoutMs) throw new Error("Las colas del bot no se vaciaron");
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Las pausas "humanas" (leer, escribiendo…) se acortan en las pruebas con WA_FACTOR_TIEMPO
const FACTOR_TIEMPO = Number(process.env.WA_FACTOR_TIEMPO ?? 1);
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms * FACTOR_TIEMPO));
const azar = (min: number, max: number) => min + Math.random() * (max - min);

// ---------- Formato WhatsApp ----------
/** Markdown -> WhatsApp: **x** -> *x*, sin títulos ni viñetas. Un párrafo = un mensaje. */
export function aFormatoWhatsapp(texto: string): string[] {
  const limpio = texto
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?```/g, (b) => b.replace(/```\w*\n?/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  const parrafos = limpio
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  // Más de 4 mensajes seguidos se ve raro: se juntan los últimos
  if (parrafos.length > 4) return [...parrafos.slice(0, 3), parrafos.slice(3).join("\n")];
  return parrafos;
}

/** Quita párrafos que contengan números de cuenta de la empresa (los datos de pago los manda el sistema). */
async function quitarDatosSensibles(partes: string[]) {
  const r = await pool.query(`SELECT numero_cuenta, telefono FROM cajas WHERE tipo = 'BANCO'`);
  const prohibidos = r.rows
    .flatMap((f) => [f.numero_cuenta, f.telefono])
    .map((v) => String(v ?? "").replace(/\D/g, ""))
    .filter((v) => v.length >= 6);
  return partes.filter((p) => {
    const digitos = p.replace(/\D/g, "");
    const filtrar = prohibidos.some((n) => digitos.includes(n));
    if (filtrar) console.warn("[bot] se descartó un párrafo de la IA con datos bancarios");
    return !filtrar;
  });
}

// ---------- Prompt ----------
function describirHorario(config: ConfigWa) {
  const nombres = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  if (config.horario.dias.length === 0) return "sin horario definido";
  return config.horario.dias.map((d) => `${nombres[d.dia]} ${d.desde}-${d.hasta}`).join(", ");
}

function sistemaFijo(config: ConfigWa) {
  const n = config.negocio;
  return [
    `Eres ${config.personalidad.nombreAsistente}, del equipo de ${n.nombre}. ${n.descripcion}`,
    config.personalidad.instrucciones,
    "",
    "Cómo escribes:",
    "- Es WhatsApp: mensajes cortos, como una persona. Cada párrafo se envía como un mensaje aparte; usa uno o dos, casi nunca más de tres.",
    "- Sin títulos, viñetas, listas ni markdown. Para resaltar algo puntual usa *así*, con moderación.",
    "- No digas que eres un bot o una IA. Solo si te lo preguntan directamente, responde con la verdad y naturalidad.",
    "",
    "Reglas de datos (muy importantes):",
    "- NUNCA escribas tasas, montos convertidos, números de cuenta ni datos bancarios. Los envía el sistema tal cual con tus herramientas; tú solo acompañas (ej: 'te acabo de pasar la cotización').",
    "- Nunca inventes precios, disponibilidad ni datos. Si una herramienta no te da la información, dilo con honestidad.",
    "- La moneda local es el peso colombiano (COP). Las tasas son pesos por cada unidad de divisa. No adivines la moneda: si no está claro, pregunta.",
    "",
    "Cómo se hace un cambio:",
    "1) Entiende qué quiere: vender o comprar divisa, cuál, y cuánto (en divisa o en pesos).",
    "2) Usa cotizar. El sistema le envía la cotización exacta.",
    "3) Si confirma que quiere hacerlo: si no está registrado, pide nombre completo y documento y usa registrar_cliente.",
    "4) Pide la cuenta donde recibe (o usa una guardada si confirma cuál) y usa crear_solicitud. El sistema envía la cuenta de la empresa, el monto exacto y hasta qué hora vale la tasa.",
    "5) Cuando mande la foto del comprobante, léela si puedes y usa registrar_comprobante. Queda en verificación; una persona lo aprueba y se le paga.",
    "",
    "Pasar a una persona (pasar_a_humano) SOLO si el cliente lo pide explícitamente, si hay un reclamo que no puedes verificar, o si algo no se puede resolver con tus herramientas (por ejemplo pagar en efectivo en la oficina, montos fuera de lo normal, problemas con un pago ya hecho). No lo hagas por dudas normales ni porque el cliente esté apurado.",
    "",
    "Datos del negocio:",
    n.direccion ? `- Dirección: ${n.direccion}` : null,
    `- Horario de atención de personas: ${describirHorario(config)}`,
    n.infoAdicional ? `- Información adicional:\n${n.infoAdicional}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

async function contextoVolatil(ctx: ContextoBot, chat: Pick<FilaChat, "nombre" | "nombre_guardado">) {
  const config = ctx.config;
  const ahora = new Date();
  const fecha = new Intl.DateTimeFormat("es-CO", {
    timeZone: config.negocio.zonaHoraria,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
  }).format(ahora);
  const lineas = [
    "",
    "Contexto de esta conversación (datos reales, actualizados ahora):",
    `- Fecha y hora local: ${fecha}. ${enHorarioAtencion(config, ahora) ? "Estamos en horario de atención." : "Estamos FUERA del horario de atención: las solicitudes se verifican cuando abramos."}`,
  ];

  if (ctx.esDueno) {
    lineas.push(`- Quien te escribe es ${config.dueno.nombre || "el dueño"}, el dueño del negocio. Háblale como a tu jefe, con confianza.`);
    return lineas.join("\n");
  }

  const nombreChat = chat.nombre_guardado ?? chat.nombre;
  if (ctx.terceroId === -1) {
    lineas.push("- Cliente registrado (simulación), sin cuentas guardadas ni operaciones previas.");
  } else if (ctx.terceroId && ctx.terceroId > 0) {
    const t = (await pool.query(`SELECT nombre, identificacion FROM terceros WHERE id = $1`, [ctx.terceroId])).rows[0];
    lineas.push(`- Cliente registrado: ${t?.nombre} (doc. ${t?.identificacion ?? "sin documento"}).`);
    const cuentas = await pool.query(
      `SELECT ct.id, ct.tipo, ct.banco, ct.numero_cuenta, ct.telefono, ct.email, m.codigo AS moneda
       FROM cuentas_tercero ct LEFT JOIN monedas m ON m.id = ct.moneda_id
       WHERE ct.tercero_id = $1 AND ct.activo ORDER BY ct.id DESC LIMIT 5`,
      [ctx.terceroId]
    );
    if (cuentas.rows.length) {
      lineas.push("- Cuentas guardadas donde recibe (usa cuenta_id si confirma una):");
      for (const c of cuentas.rows) {
        const fin = String(c.numero_cuenta ?? c.telefono ?? c.email ?? "").slice(-4);
        lineas.push(`  · cuenta_id ${c.id}: ${c.tipo}${c.banco ? ` ${c.banco}` : ""}${c.moneda ? ` (${c.moneda})` : ""} terminada en ${fin}`);
      }
    }
    const compras = await pool.query(
      `SELECT t.id, t.tipo, t.estado, t.monto_origen, m.codigo, m.decimales, t.created_at FROM transacciones t
       JOIN monedas m ON m.id = t.moneda_origen_id
       WHERE t.tercero_id = $1 AND t.tipo IN ('COMPRA_DIVISA','VENTA_DIVISA') ORDER BY t.id DESC LIMIT 3`,
      [ctx.terceroId]
    );
    if (compras.rows.length) {
      lineas.push("- Operaciones recientes:");
      for (const c of compras.rows) {
        lineas.push(
          `  · #${c.id} ${c.tipo === "COMPRA_DIVISA" ? "nos vendió" : "nos compró"} ${formatearMonto(c.monto_origen, Number(c.decimales))} ${c.codigo}, ${c.estado.toLowerCase()}`
        );
      }
    } else {
      lineas.push("- Es su primera operación con nosotros.");
    }
  } else {
    lineas.push(`- Cliente NO registrado todavía${nombreChat ? ` (en WhatsApp figura como "${nombreChat}")` : ""}.`);
  }

  const e = ctx.estado;
  if (e.cotizacion) {
    const c = e.cotizacion;
    lineas.push(
      `- Última cotización enviada: ${c.tipo === "COMPRA_DIVISA" ? "el cliente vende" : "el cliente compra"} ${c.monedaCodigo} (${c.etiqueta}), a las ${ahoraLocal(config.negocio.zonaHoraria, new Date(c.en)).hora}. Si confirma, esa es la que se usa en crear_solicitud.`
    );
  }
  if (e.solicitudId !== undefined && !ctx.simulacion) {
    const s = (await pool.query(`SELECT id, estado, tasa_vence_en FROM transacciones WHERE id = $1`, [e.solicitudId])).rows[0];
    if (s) {
      const vence = s.tasa_vence_en ? ahoraLocal(config.negocio.zonaHoraria, new Date(s.tasa_vence_en)).hora : "";
      lineas.push(
        `- Solicitud #${s.id}: ${s.estado.toLowerCase()}${e.comprobanteRecibido ? ", comprobante recibido (en verificación)" : `, esperando el pago (la tasa vale hasta las ${vence})`}.`
      );
    }
  } else if (e.solicitudId !== undefined) {
    lineas.push(`- Hay una solicitud simulada creada${e.comprobanteRecibido ? " y con comprobante" : ", esperando el pago"}.`);
  }
  if (ctx.ultimaFotoId) {
    lineas.push("- El cliente acaba de enviar una foto. Si tiene una solicitud esperando pago, probablemente es el comprobante.");
  }
  return lineas.join("\n");
}

// ---------- Historial ----------
const ETIQUETA_MEDIA: Record<string, string> = {
  imagen: "[envió una foto]",
  audio: "[envió una nota de voz, que no puedes escuchar: pídele que la escriba]",
  documento: "[envió un documento]",
  sticker: "[envió un sticker]",
  video: "[envió un video]",
};

async function historialDesdeBd(jid: string, hastaId: string, config: ConfigWa) {
  const r = await pool.query(
    `SELECT * FROM (
       SELECT * FROM wa_mensajes WHERE jid = $1 AND id <= $2 AND NOT interno ORDER BY id DESC LIMIT 30
     ) x ORDER BY id`,
    [jid, hastaId]
  );
  const filas: FilaMensaje[] = r.rows;
  // Fotos sin responder todavía: desde el último mensaje nuestro
  let ultimoNuestro = -1;
  filas.forEach((f, i) => {
    if (f.de_mi) ultimoNuestro = i;
  });
  const historial: MensajeNeutro[] = [];
  let ultimaFotoId: string | null = null;
  for (let i = 0; i < filas.length; i++) {
    const f = filas[i]!;
    let texto = f.texto ?? "";
    if (f.tipo !== "texto") texto = [ETIQUETA_MEDIA[f.tipo], f.texto].filter(Boolean).join(" ");
    const imagenes: ParteImagen[] = [];
    if (!f.de_mi && f.tipo === "imagen" && i > ultimoNuestro) {
      ultimaFotoId = String(f.id);
      if (config.ia.vision) {
        const m = await leerMedia(String(f.id));
        if (m) imagenes.push({ base64: m.buffer.toString("base64"), mime: m.mime });
      }
    }
    if (f.autor === "sistema") texto = `[Mensaje automático que el sistema le envió al cliente]\n${texto}`;
    else if (f.autor === "humano" || f.autor === "telefono") texto = `[Lo escribió una persona del equipo]\n${texto}`;
    historial.push({ rol: f.de_mi ? "assistant" : "user", texto, imagenes: imagenes.length ? imagenes : undefined });
  }
  return { historial, ultimaFotoId };
}

// ---------- Núcleo compartido (chat real, dueño y simulador) ----------
export interface ResultadoRespuesta {
  partes: string[];
  llamadas: LlamadaHerramienta[];
  modelo: string;
}

async function generarRespuesta(ctx: ContextoBot, chat: Pick<FilaChat, "nombre" | "nombre_guardado">, historial: MensajeNeutro[]) {
  const config = ctx.config;
  const clave = await claveDe(config.ia.proveedor);
  if (!clave) throw new ErrorIA(`Falta la API key de ${config.ia.proveedor}`, 401);
  if (!config.ia.modelo) throw new ErrorIA("No hay un modelo elegido", 400);

  const sistema = sistemaFijo(config) + "\n" + (await contextoVolatil(ctx, chat));
  const r = await ejecutarTurno({
    proveedor: config.ia.proveedor,
    clave,
    modelo: config.ia.modelo,
    modelosRespaldo: config.ia.modelosRespaldo,
    sistema,
    historial,
    herramientas: definicionesHerramientas(ctx),
    ejecutar: (nombre, args) => ejecutarHerramienta(ctx, nombre, args),
  });
  const partes = await quitarDatosSensibles(aFormatoWhatsapp(r.texto));
  return { partes, llamadas: r.llamadas, modelo: r.modeloUsado };
}

/** Escribe como una persona: "escribiendo…" proporcional al largo y luego el mensaje. */
async function enviarComoPersona(jid: string, partes: string[], seguirSi: () => Promise<boolean>) {
  const tr = transporte();
  for (const parte of partes) {
    await tr.presencia(jid, "composing").catch(() => {});
    await esperar(Math.min(7_000, Math.max(1_200, parte.length * 45)));
    await tr.presencia(jid, "paused").catch(() => {});
    if (!(await seguirSi())) return;
    await enviarMensaje({ jid, autor: "bot", texto: parte });
  }
}

function crearContexto(base: Omit<ContextoBot, "efectos" | "enviarSistema" | "pasarAHumano"> & Partial<ContextoBot>): ContextoBot {
  return {
    efectos: [],
    enviarSistema: async () => {},
    pasarAHumano: async () => {},
    ...base,
  };
}

async function turno(jid: string) {
  const config = await leerConfig();
  if (!config.ia.activa) return;
  const chat = await obtenerChat(jid);
  if (!chat || !chat.bot_activo || chat.necesita_humano) return;

  // hastaId: el turno solo ve hasta acá; lo que llegue después es del turno siguiente
  const ultimo = (await pool.query(`SELECT id, autor, de_mi, wa_key FROM wa_mensajes WHERE jid = $1 AND NOT interno ORDER BY id DESC LIMIT 1`, [jid]))
    .rows[0];
  if (!ultimo || ultimo.de_mi) return; // ya se respondió
  const hastaId = String(ultimo.id);

  if (!config.horario.responderFueraDeHorario && !enHorarioAtencion(config)) return;

  // Anti-bucle: demasiadas respuestas del bot a este chat en 5 minutos
  const recientes = await pool.query(
    `SELECT count(*)::int AS n FROM wa_mensajes WHERE jid = $1 AND autor = 'bot' AND created_at > now() - interval '5 minutes'`,
    [jid]
  );
  if (recientes.rows[0].n >= config.antibloqueo.antiBucleMax) {
    await marcarNecesitaHumano(jid, "el bot le respondió demasiadas veces seguidas; revisar la conversación");
    return;
  }

  // Leer (✓✓ azul) con una demora humana
  const noLeidos = await pool.query(
    `SELECT wa_key FROM wa_mensajes WHERE jid = $1 AND autor = 'cliente' AND id <= $2
       AND id > coalesce((SELECT max(id) FROM wa_mensajes WHERE jid = $1 AND de_mi AND NOT interno), 0)`,
    [jid, hastaId]
  );
  await esperar(azar(1_200, 4_000));
  const claves = noLeidos.rows.map((f) => f.wa_key).filter(Boolean);
  if (claves.length) await transporte().leer(claves).catch(() => {});

  const { historial, ultimaFotoId } = await historialDesdeBd(jid, hastaId, config);
  let derivado = false;
  const ctx = crearContexto({
    simulacion: false,
    jid,
    telefono: chat.telefono,
    terceroId: chat.tercero_id,
    estado: { ...(chat.estado ?? {}) } as EstadoConversacion,
    config,
    esDueno: false,
    ultimaFotoId,
    enviarSistema: async (texto) => {
      await enviarMensaje({ jid, autor: "sistema", texto });
    },
    pasarAHumano: async (motivo) => {
      derivado = true;
      await marcarNecesitaHumano(jid, motivo);
    },
  });

  let resultado: ResultadoRespuesta;
  try {
    resultado = await generarRespuesta(ctx, chat, historial);
  } catch (err) {
    console.error(`[bot] la IA falló en ${jid}:`, (err as Error).message);
    await marcarNecesitaHumano(jid, `el bot no pudo responder (${(err as Error).message.slice(0, 120)})`);
    return;
  }

  // Si mientras pensaba una persona escribió en el chat, el bot no responde encima
  const seguir = async () => {
    const intervino = await pool.query(
      `SELECT 1 FROM wa_mensajes WHERE jid = $1 AND id > $2 AND autor IN ('humano', 'telefono') LIMIT 1`,
      [jid, hastaId]
    );
    if (intervino.rows.length) return false;
    if (derivado) return true; // la despedida al derivar sí sale
    const actual = await obtenerChat(jid);
    return !!actual?.bot_activo;
  };
  await enviarComoPersona(jid, resultado.partes, seguir);
}

// ---------- Dueño: lo que no es una orden lo responde el bot sabiendo que es el dueño ----------
export async function responderAlDueno(jid: string, texto: string) {
  const config = await leerConfig();
  if (!config.ia.activa) return;
  const ctx = crearContexto({
    simulacion: false,
    jid,
    telefono: jid.split("@")[0]!,
    terceroId: null,
    estado: {},
    config,
    esDueno: true,
    ultimaFotoId: null,
    enviarSistema: async (t) => {
      await enviarMensaje({ jid, autor: "sistema", texto: t });
    },
  });
  const r = await generarRespuesta(ctx, { nombre: config.dueno.nombre, nombre_guardado: null }, [{ rol: "user", texto }]);
  await enviarComoPersona(jid, r.partes, async () => true);
}

/** Reescribe lo que el dueño quiere decirle a un cliente, con las palabras del bot. */
export async function redactarParaCliente(instruccion: string, nombreCliente: string) {
  const config = await leerConfig();
  const clave = await claveDe(config.ia.proveedor);
  if (!config.ia.activa || !clave || !config.ia.modelo) return instruccion;
  try {
    const r = await ejecutarTurno({
      proveedor: config.ia.proveedor,
      clave,
      modelo: config.ia.modelo,
      modelosRespaldo: config.ia.modelosRespaldo,
      sistema:
        `Eres ${config.personalidad.nombreAsistente}, de ${config.negocio.nombre}. ${config.personalidad.instrucciones}\n` +
        "Tu jefe te dice qué responderle a un cliente por WhatsApp. Escribe SOLO el mensaje final para el cliente, corto, natural, en primera persona del equipo, " +
        "sin agregar datos que tu jefe no dio y sin markdown.",
      historial: [{ rol: "user", texto: `Cliente: ${nombreCliente}\nLo que hay que decirle: ${instruccion}` }],
      herramientas: [],
      ejecutar: async () => "{}",
      maxPasos: 1,
    });
    return aFormatoWhatsapp(r.texto).join("\n\n") || instruccion;
  } catch {
    return instruccion;
  }
}

export async function enviarInstruccionAlCliente(jid: string, instruccion: string) {
  const chat = await obtenerChat(jid);
  if (!chat) throw Object.assign(new Error("Chat no encontrado"), { status: 404 });
  const texto = await redactarParaCliente(instruccion, chat.nombre_guardado ?? chat.nombre ?? "cliente");
  await enviarComoPersona(jid, aFormatoWhatsapp(texto), async () => true);
  return texto;
}

// ---------- Simulador: conversar como cliente sin tocar la base ni enviar nada ----------
export interface EntradaSimulador {
  historial: { rol: "cliente" | "bot" | "sistema"; texto: string }[];
  estado?: EstadoConversacion;
  registrado?: boolean;
}

export async function simular(entrada: EntradaSimulador) {
  const config = await leerConfig();
  const sistemaEnviados: string[] = [];
  const derivaciones: string[] = [];
  const ctx = crearContexto({
    simulacion: true,
    jid: "simulador@s.whatsapp.net",
    telefono: "000000000000",
    terceroId: entrada.registrado ? -1 : null,
    estado: { ...(entrada.estado ?? {}) },
    config,
    esDueno: false,
    ultimaFotoId: null,
    enviarSistema: async (t) => {
      sistemaEnviados.push(t);
    },
    pasarAHumano: async (motivo) => {
      derivaciones.push(motivo);
    },
  });
  const historial: MensajeNeutro[] = entrada.historial.map((m) => ({
    rol: m.rol === "cliente" ? "user" : "assistant",
    texto: m.rol === "sistema" ? `[Mensaje automático que el sistema le envió al cliente]\n${m.texto}` : m.texto,
  }));
  const r = await generarRespuesta(ctx, { nombre: "Cliente de prueba", nombre_guardado: null }, historial);
  return {
    respuestas: r.partes,
    sistema: sistemaEnviados,
    herramientas: r.llamadas.map((l) => ({ nombre: l.nombre, args: l.args, resultado: safeJson(l.resultado) })),
    efectos: ctx.efectos,
    derivaciones,
    estado: ctx.estado,
    registrado: ctx.terceroId !== null,
    modelo: r.modelo,
  };
}

function safeJson(texto: string) {
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}
