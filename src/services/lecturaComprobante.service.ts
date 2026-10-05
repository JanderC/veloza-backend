import { claveDe, leerConfig } from "./whatsapp/config";
import { ejecutarTurno, ErrorIA } from "./whatsapp/ia";

export interface DatosComprobante {
  referencia: string | null; // número de la transferencia o del comprobante
  monto: string | null; // decimal normalizado: "1250000" o "403.5"
  moneda: string | null; // COP, USD, VES, EUR, USDT
  fecha: string | null; // AAAA-MM-DD
  banco: string | null;
  remitente: string | null; // quién envió
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

/**
 * Lee la foto o captura de un comprobante y saca la referencia, el monto y la fecha de la transacción.
 * Usa la IA configurada en WhatsApp → IA (el modelo tiene que aceptar imágenes).
 */
export async function leerComprobante(imagen: Buffer, mime: string): Promise<DatosComprobante> {
  const config = await leerConfig();
  const clave = await claveDe(config.ia.proveedor);
  if (!clave || !config.ia.modelo) {
    throw errorHttp("Para leer comprobantes hay que configurar la IA (clave y modelo) en WhatsApp → IA", 400);
  }

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
        "El monto va tal como aparece, sin símbolo de moneda. La fecha es la de la transacción, en formato AAAA-MM-DD.",
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

  const datos = leido as Record<string, unknown>;
  const fecha = texto(datos.fecha);
  const moneda = texto(datos.moneda)?.toUpperCase() ?? null;
  return {
    referencia: texto(datos.referencia),
    monto: normalizarMonto(datos.monto),
    moneda: moneda && ["COP", "USD", "VES", "EUR", "USDT"].includes(moneda) ? moneda : null,
    fecha: fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) && !Number.isNaN(Date.parse(fecha)) ? fecha : null,
    banco: texto(datos.banco),
    remitente: texto(datos.remitente),
  };
}
