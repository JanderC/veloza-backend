import fs from "fs";
import path from "path";

// Los stickers del negocio (los que se mandan al confirmar una transferencia). Viven en backend/assets/stickers
// ya en el formato que pide WhatsApp: WebP de 512x512 y livianos. Para sumar otro: dejar el .webp ahí y agregarlo acá.
export const STICKERS = [
  { id: "pago", nombre: "Pago", archivo: "pago.webp" },
  { id: "pagos-y-salvos", nombre: "Pagos y Salvos", archivo: "pagos-y-salvos.webp" },
] as const;

// tanto con ts-node (src/services/whatsapp) como compilado (dist/services/whatsapp) la carpeta queda tres niveles arriba
const CARPETA = path.join(__dirname, "..", "..", "..", "assets", "stickers");
const cache = new Map<string, Buffer>();

export function leerSticker(id: string): { id: string; nombre: string; buffer: Buffer } | null {
  const s = STICKERS.find((x) => x.id === id);
  if (!s) return null;
  let buffer = cache.get(s.id);
  if (!buffer) {
    buffer = fs.readFileSync(path.join(CARPETA, s.archivo));
    cache.set(s.id, buffer);
  }
  return { id: s.id, nombre: s.nombre, buffer };
}
