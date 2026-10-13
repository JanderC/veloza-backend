import type { WAMessageKey } from "@whiskeysockets/baileys";
import { pool } from "../../db/pool";
import { emitirPanel } from "./eventos";
import { chatParaPanel } from "./mensajes";
import { claveDeChat, jidReal, lineaDeClave, transporte, type Linea } from "./transporte";

// Archivar chats, sincronizado con WhatsApp. En WhatsApp el archivado es de la cuenta (no de cada dispositivo): lo
// que se archiva en el sistema se archiva en el teléfono de esa línea, y lo que se archiva en el teléfono llega acá.

/**
 * WhatsApp avisó que un chat se archivó o se desarchivó (desde el teléfono u otro dispositivo): se refleja en la
 * bandeja. Si el chat no está en el sistema, no se crea.
 */
export async function marcarArchivadoDesdeWhatsapp(linea: Linea, jid: string, archivado: boolean) {
  const r = await pool.query(`UPDATE wa_chats SET archivado = $2 WHERE jid = $1 AND archivado IS DISTINCT FROM $2 RETURNING *`, [claveDeChat(linea, jid), archivado]);
  if (r.rows[0]) emitirPanel("chat", await chatParaPanel(r.rows[0]));
}

/**
 * Se archivó o desarchivó desde el sistema: se le pide lo mismo a WhatsApp, para que quede igual en el teléfono.
 * WhatsApp necesita el último mensaje del chat para aplicarlo. Si la línea no está conectada o WhatsApp no lo acepta,
 * el chat queda archivado igual en el sistema: devuelve si se pudo sincronizar.
 */
export async function archivarEnWhatsapp(clave: string, archivado: boolean): Promise<boolean> {
  const t = transporte(lineaDeClave(clave));
  if (!t.conectado()) return false;
  const r = await pool.query(`SELECT wa_id, wa_key, de_mi, created_at FROM wa_mensajes WHERE jid = $1 AND wa_id IS NOT NULL AND NOT interno ORDER BY created_at DESC LIMIT 1`, [clave]);
  const ultimo = r.rows[0];
  if (!ultimo) return false;
  const guardada = (ultimo.wa_key ?? null) as WAMessageKey | null;
  const key: WAMessageKey = guardada?.id ? { ...guardada, remoteJid: jidReal(guardada.remoteJid ?? clave) } : { remoteJid: jidReal(clave), id: ultimo.wa_id, fromMe: ultimo.de_mi };
  try {
    await t.archivar(clave, archivado, { key, messageTimestamp: Math.floor(new Date(ultimo.created_at).getTime() / 1000) });
    return true;
  } catch (e) {
    console.warn(`[whatsapp] no se pudo ${archivado ? "archivar" : "desarchivar"} ${clave} en WhatsApp:`, (e as Error).message);
    return false;
  }
}
