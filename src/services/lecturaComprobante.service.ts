import { claveDe, leerConfig } from "./whatsapp/config";
import { ejecutarTurno, ErrorIA } from "./whatsapp/ia";

export interface DatosComprobante {
  referencia: string | null; // número de la transferencia o del comprobante
  monto: string | null; // decimal normalizado: "1250000" o "403.5"
  moneda: string | null; // COP, USD, VES, EUR, USDT
  fecha: string | null; // AAAA-MM-DD
  banco: string | null;
  remitente: string | null; // quién envió
  destinatario: string | null; // a quién se le envió (en Zelle: "A", "Para", "Enviado a")
}

function errorHttp(mensaje: string, status: number) {
  return Object.assign(new Error(mensaje), { status });
}

const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** "1.250.000,50", "1,250,000.50" o "403.5" -> "1250000.5" / "403.5". null si no es un número. */
function normalizarMonto(v: unknown): string | null {
  const crudo = typeof v === "number" ? String(v) : texto(v);
  if (!crudo) return null;
  let s = crudo.replace(/[^\d.,]/g, "");
  if (!/\d/.test(s)) return null;
  const ultimaComa = s.lastIndexOf(",");
  const ultimoPunto = s.lastIndexOf(".");
  const separador = Math.max(ultimaComa, ultimoPunto);
  // El último separador es decimal solo si deja 1 o 2 dígitos detrás; si deja 3, es de miles
  const decimales = separador >= 0 ? s.length - separador - 1 : 0;
  if (separador >= 0 && decimales >= 1 && decimales <= 2) {
    s = `${s.slice(0, separador).replace(/[.,]/g, "")}.${s.slice(separador + 1)}`;
  } else {
    s = s.replace(/[.,]/g, "");
  }
  const limpio = s.replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return /[1-9]/.test(limpio) ? limpio : null;
}

/** Deja lo leído por la IA en el formato de siempre, descartando lo que no sirve. */
function ordenar(datos: Record<string, unknown>): DatosComprobante {
  const fecha = texto(datos.fecha);
  const moneda = texto(datos.moneda)?.toUpperCase() ?? null;
  const limpio = (v: unknown) => {
    const t = texto(v);
    return t && !/^(null|n\/?a|ninguno|no aparece|desconocido)$/i.test(t) ? t : null;
  };
  return {
    referencia: limpio(datos.referencia)?.replace(/\s+/g, "") ?? null,
    monto: normalizarMonto(datos.monto),
    moneda: moneda && ["COP", "USD", "VES", "EUR", "USDT"].includes(moneda) ? moneda : null,
    fecha: fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) && !Number.isNaN(Date.parse(fecha)) ? fecha : null,
    banco: limpio(datos.banco),
    remitente: limpio(datos.remitente),
    destinatario: limpio(datos.destinatario),
  };
}

// ---------- Lectura directa con un modelo de visión de Groq ----------
// Se activa con GROQ_API_KEY en el servidor. COMPROBANTES_IA_MODELO permite cambiar el modelo sin tocar el código.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODELOS_GROQ = [process.env.COMPROBANTES_IA_MODELO, "meta-llama/llama-4-scout-17b-16e-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct"].filter(
  (m): m is string => !!m
);

const INSTRUCCIONES = [
  "Lees capturas de comprobantes de pago para una casa de cambio: Zelle (Bank of America, Chase, Wells Fargo y otros), transferencias, pago móvil, Nequi, Bancolombia, Binance, Western Union.",
  "Devuelve SOLO un objeto JSON con estas claves. Si un dato no aparece en la imagen va null. No inventes nada.",
  '- "referencia": el número o código de confirmación, referencia, transacción o MTCN, copiado EXACTO carácter por carácter, respetando mayúsculas y minúsculas (ejemplo: "e8kau6vdn"). No es el número de cuenta, ni los últimos 4 dígitos de la cuenta, ni un teléfono.',
  '- "monto": el monto enviado tal como aparece, sin símbolo (ejemplos: "10.00", "1.250.000"). Si hay una comisión aparte, el monto es lo enviado, no el total con comisión.',
  '- "moneda": COP, USD, VES, EUR o USDT. Zelle siempre es USD.',
  '- "fecha": la fecha de la transacción en formato AAAA-MM-DD (no la hora que marca el teléfono).',
  '- "banco": el medio o banco: "Zelle", "Bancolombia", "Nequi", "Banco de Venezuela", "Western Union"... Si es una pantalla de Zelle dentro de la app de un banco, es "Zelle".',
  '- "remitente": el nombre de la PERSONA que envía el dinero, solo si aparece como tal ("De", "From", "Enviado por"). El nombre de una cuenta ("Adv SafeBalance Banking - 2839") no es una persona.',
  '- "destinatario": el nombre de la persona que recibe ("A", "Para", "To", "Enviado a", "Inscrito como").',
].join("\n");

async function leerConGroq(clave: string, imagen: Buffer, mime: string): Promise<Record<string, unknown>> {
  let ultimo = "sin respuesta";
  for (const modelo of MODELOS_GROQ) {
    let res: Response;
    try {
      res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${clave}` },
        body: JSON.stringify({
          model: modelo,
          temperature: 0,
          max_completion_tokens: 400,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: INSTRUCCIONES },
                { type: "image_url", image_url: { url: `data:${mime};base64,${imagen.toString("base64")}` } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(25_000),
      });
    } catch (e) {
      ultimo = (e as Error).message;
      continue;
    }
    const cuerpo = await res.text();
    if (!res.ok) {
      // modelo dado de baja o saturado: se prueba el siguiente
      ultimo = `Groq ${res.status}: ${cuerpo.slice(0, 200)}`;
      console.warn(`[comprobantes] falló ${modelo}: ${ultimo}`);
      continue;
    }
    try {
      const contenido = JSON.parse(cuerpo).choices?.[0]?.message?.content as string | undefined;
      const leido: unknown = JSON.parse(contenido ?? "");
      if (leido && typeof leido === "object") return leido as Record<string, unknown>;
      ultimo = "la IA no devolvió datos";
    } catch {
      ultimo = "la IA no devolvió datos legibles";
    }
  }
  throw errorHttp(`La IA no pudo leer la imagen: ${ultimo}`, 502);
}

/**
 * Lee la foto o captura de un comprobante y saca la referencia, el monto y la fecha de la transacción.
 * Con GROQ_API_KEY en el servidor usa un modelo de visión de Groq. Si no, la IA configurada en WhatsApp → IA
 * (el modelo tiene que aceptar imágenes). Sin ninguna de las dos responde 501 y la pantalla lee la imagen por su cuenta.
 */
export async function leerComprobante(imagen: Buffer, mime: string): Promise<DatosComprobante> {
  const claveGroq = process.env.GROQ_API_KEY?.trim();
  if (claveGroq) return ordenar(await leerConGroq(claveGroq, imagen, mime));

  const config = await leerConfig();
  const clave = await claveDe(config.ia.proveedor);
  if (!clave || !config.ia.modelo) throw errorHttp("La lectura con IA no está configurada en el servidor", 501);

  let leido: Record<string, unknown> | null = null;
  try {
    await ejecutarTurno({
      proveedor: config.ia.proveedor,
      clave,
      modelo: config.ia.modelo,
      modelosRespaldo: config.ia.modelosRespaldo,
      sistema:
        "Lees comprobantes de pago (transferencias bancarias, Zelle, pago móvil, Nequi, Bancolombia, Binance) para una casa de cambio. " +
        "Mira la imagen y llama a registrar_comprobante con lo que se lee en ella. No inventes nada: si un dato no aparece, no lo mandes. " +
        "El monto va tal como aparece, sin símbolo de moneda. La fecha es la de la transacción, en formato AAAA-MM-DD. " +
        "La referencia se copia exacta, carácter por carácter.",
      historial: [{ rol: "user", texto: "Extrae los datos de este comprobante.", imagenes: [{ base64: imagen.toString("base64"), mime }] }],
      herramientas: [
        {
          nombre: "registrar_comprobante",
          descripcion: "Registra los datos leídos del comprobante.",
          parametros: {
            type: "object",
            properties: {
              referencia: { type: "string", description: "Número de referencia, de confirmación o de la transacción" },
              monto: { type: "string", description: "Monto transferido, como aparece en la imagen" },
              moneda: { type: "string", description: "COP, USD, VES, EUR o USDT" },
              fecha: { type: "string", description: "Fecha de la transacción, AAAA-MM-DD" },
              banco: { type: "string", description: "Banco o medio: Zelle, Bancolombia, Nequi, Banco de Venezuela..." },
              remitente: { type: "string", description: "Nombre de quien envía el dinero" },
              destinatario: { type: "string", description: "Nombre de quien recibe el dinero" },
            },
          },
        },
      ],
      ejecutar: async (_nombre, args) => {
        leido = args;
        return "Registrado.";
      },
      maxPasos: 2,
    });
  } catch (err) {
    if (err instanceof ErrorIA) throw errorHttp(`La IA no pudo leer la imagen: ${err.message}`, 502);
    throw err;
  }
  if (!leido) throw errorHttp("No pude sacar datos de esa imagen. Probá con una foto más nítida o cargalo a mano.", 422);
  return ordenar(leido as Record<string, unknown>);
}
