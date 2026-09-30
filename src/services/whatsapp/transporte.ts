import type { WAMessage, WAMessageKey } from "@whiskeysockets/baileys";

// Lo mínimo que el resto del módulo necesita de WhatsApp. En producción lo implementa
// el socket de Baileys (conexion.ts); en las pruebas se reemplaza por uno simulado.

export type ContenidoSalida =
  | { texto: string }
  | { imagen: Buffer; mime: string; texto?: string };

export interface Transporte {
  conectado(): boolean;
  /** jid propio canónico (<numero>@s.whatsapp.net) o null si no hay sesión */
  miJid(): string | null;
  enviar(jid: string, contenido: ContenidoSalida, messageId: string): Promise<WAMessageKey | undefined>;
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

let actual: Transporte = desconectado;

export function transporte() {
  return actual;
}

export function usarTransporte(t: Transporte | null) {
  actual = t ?? desconectado;
}

/** jid canónico a partir de un número (solo dígitos, con código de país). */
export function jidDeTelefono(telefono: string) {
  return `${telefono.replace(/\D/g, "")}@s.whatsapp.net`;
}

export function telefonoDeJid(jid: string) {
  return jid.split("@")[0]?.split(":")[0] ?? jid;
}
