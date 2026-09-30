import { pool } from "../../db/pool";
import { generarUrlTemporal } from "../almacenamiento.service";

// Las fotos recién llegadas quedan unos minutos en memoria para que la IA las lea
// (comprobantes) sin volver a bajarlas de Cloudinary. Si ya no están, se bajan.

const TTL_MS = 15 * 60_000;
const memoria = new Map<string, { buffer: Buffer; mime: string; en: number }>();

export function guardarMediaEnMemoria(mensajeId: string, buffer: Buffer, mime: string) {
  memoria.set(String(mensajeId), { buffer, mime, en: Date.now() });
  for (const [k, v] of memoria) if (Date.now() - v.en > TTL_MS) memoria.delete(k);
}

export async function leerMedia(mensajeId: string): Promise<{ buffer: Buffer; mime: string } | null> {
  const enMemoria = memoria.get(String(mensajeId));
  if (enMemoria) return enMemoria;
  const r = await pool.query(`SELECT media_key, media_mime FROM wa_mensajes WHERE id = $1`, [mensajeId]);
  const fila = r.rows[0];
  if (!fila?.media_key) return null;
  try {
    const res = await fetch(generarUrlTemporal(fila.media_key, fila.media_mime, 120));
    if (!res.ok) return null;
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: fila.media_mime };
  } catch {
    return null;
  }
}
