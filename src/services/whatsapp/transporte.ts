import type { WAMessage, WAMessageKey } from "@whiskeysockets/baileys";

// Lo mínimo que el resto del módulo necesita de WhatsApp. En producción lo implementa
// el socket de Baileys (conexion.ts); en las pruebas se reemplaza por uno simulado.

// ---------- Líneas ----------
// El negocio atiende con tres WhatsApp, uno por tipo de cambio. Cada línea es un teléfono vinculado con su propia
// sesión, su propia bandeja de chats y sus propios topes de envío (a Meta le importa cada número por separado).
export const LINEAS = [
  { id: 1, nombre: "Bolívares" },
  { id: 2, nombre: "Pesos" },
  { id: 3, nombre: "Dólares" },
] as const;
export type Linea = (typeof LINEAS)[number]["id"];

export function esLinea(n: unknown): n is Linea {
  return n === 1 || n === 2 || n === 3;
}
export function nombreDeLinea(linea: Linea) {
  return LINEAS.find((l) => l.id === linea)!.nombre;
}

// La clave de un chat es el jid del cliente, más "#2" o "#3" si es de la línea 2 o 3: el mismo cliente puede
// escribirle a dos líneas y son dos conversaciones distintas, como en cada teléfono. La línea 1 no lleva sufijo
// (así los chats que ya existían siguen valiendo).
export function claveDeChat(linea: Linea, jid: string) {
  const real = jidReal(jid);
  return linea === 1 ? real : `${real}#${linea}`;
}
export function lineaDeClave(clave: string): Linea {
  const n = Number(clave.split("#")[1]);
  return esLinea(n) ? n : 1;
}
/** El jid que entiende WhatsApp: la clave sin el sufijo de la línea. */
export function jidReal(clave: string) {
  return clave.split("#")[0]!;
}
/** ¿La clave es de un grupo de WhatsApp? (los grupos terminan en @g.us) */
export function esGrupo(clave: string) {
  return jidReal(clave).endsWith("@g.us");
}

/** Condición SQL para quedarse con los chats o mensajes de una línea, según su columna jid. */
export function sqlDeLinea(columna: string, linea: Linea) {
  return linea === 1 ? `${columna} NOT LIKE '%#_'` : `${columna} LIKE '%#${linea}'`;
}

export type ContenidoSalida =
  | { texto: string }
  | { imagen: Buffer; mime: string; texto?: string }
  | { sticker: Buffer }; // WebP de 512x512

/** El mensaje que se cita al responder: su clave en WhatsApp y el texto que se muestra en la cita. */
export interface CitaSalida {
  key: WAMessageKey;
  texto: string;
}

export interface Transporte {
  conectado(): boolean;
  /** jid propio canónico (<numero>@s.whatsapp.net) o null si no hay sesión */
  miJid(): string | null;
  /** cita: el mensaje al que se responde (sale citado arriba, como al "responder" en WhatsApp) */
  enviar(jid: string, contenido: ContenidoSalida, messageId: string, cita?: CitaSalida): Promise<WAMessageKey | undefined>;
  presencia(jid: string, tipo: "composing" | "paused" | "available"): Promise<void>;
  leer(claves: WAMessageKey[]): Promise<void>;
  /** jid si el número tiene WhatsApp, null si no */
  existe(telefono: string): Promise<string | null>;
  /** Descarga el adjunto de un mensaje entrante */
  descargar(msg: WAMessage): Promise<Buffer>;
}

const desconectado: Transporte = {
  conectado: () => false,
  miJid: () => null,
  enviar: async () => {
    throw new Error("WhatsApp no está conectado");
  },
  presencia: async () => {},
  leer: async () => {},
  existe: async () => {
    throw new Error("WhatsApp no está conectado");
  },
  descargar: async () => {
    throw new Error("WhatsApp no está conectado");
  },
};

const actuales = new Map<Linea, Transporte>();

/** El WhatsApp de una línea (la 1 si no se dice). Si no está vinculada o conectada, uno que rechaza todo. */
export function transporte(linea: Linea = 1) {
  return actuales.get(linea) ?? desconectado;
}

export function usarTransporte(linea: Linea, t: Transporte | null) {
  if (t) actuales.set(linea, t);
  else actuales.delete(linea);
}

export function algunaLineaConectada() {
  return LINEAS.some((l) => transporte(l.id).conectado());
}

/** jid canónico a partir de un número (solo dígitos, con código de país). */
export function jidDeTelefono(telefono: string) {
  return `${telefono.replace(/\D/g, "")}@s.whatsapp.net`;
}

export function telefonoDeJid(jid: string) {
  return jid.split("@")[0]?.split(":")[0] ?? jid;
}
