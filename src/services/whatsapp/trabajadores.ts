import { pool } from "../../db/pool";
import { rechazarTransaccion } from "../transaccionService";
import { usuarioBotId } from "./herramientas";
import { autoIniciar } from "./conexion";
import { encolarOutbox, trabajarOutbox } from "./outbox";
import { guardarEstadoConversacion, notaInterna, obtenerChat } from "./mensajes";
import { tickResumenDueno } from "./dueno";

// Tareas de fondo del módulo WhatsApp: outbox, vencimiento de tasas congeladas y resumen al dueño.

/** Solicitudes del bot cuya tasa venció sin comprobante: se liberan y se avisa con amabilidad. */
export async function vencerSolicitudes() {
  const r = await pool.query(
    `SELECT t.id, t.wa_jid FROM transacciones t
     WHERE t.origen = 'WHATSAPP' AND t.estado = 'PENDIENTE' AND t.tasa_vence_en < now()
       AND NOT EXISTS (SELECT 1 FROM documentos_tercero d WHERE d.transaccion_id = t.id AND d.tipo = 'COMPROBANTE_PAGO')`
  );
  for (const tx of r.rows) {
    try {
      await rechazarTransaccion(tx.id, await usuarioBotId(), "La tasa congelada venció sin recibir el pago");
    } catch (err) {
      continue; // alguien la resolvió justo ahora
    }
    if (!tx.wa_jid) continue;
    const chat = await obtenerChat(tx.wa_jid);
    if (chat?.estado?.solicitudId === tx.id) await guardarEstadoConversacion(tx.wa_jid, { solicitudId: null, comprobanteRecibido: null });
    await notaInterna(tx.wa_jid, `La solicitud #${tx.id} venció sin comprobante: quedó rechazada automáticamente.`);
    const opciones = [
      `Hola, la tasa que te habíamos reservado en la solicitud #${tx.id} ya venció, así que la liberamos. Si todavía quieres hacer el cambio, escríbeme y te cotizo de nuevo con la tasa de ahora.`,
      `Te cuento que la solicitud #${tx.id} venció porque no nos llegó el pago a tiempo. No pasa nada: si aún lo necesitas, dime y te paso la tasa actualizada.`,
    ];
    await encolarOutbox({
      jid: tx.wa_jid,
      texto: opciones[Math.floor(Math.random() * opciones.length)]!,
      origen: `transaccion:${tx.id}:vencida`,
    });
  }
  return r.rows.length;
}

let timers: NodeJS.Timeout[] = [];

function cada(ms: number, fn: () => Promise<unknown>, nombre: string) {
  let corriendo = false;
  timers.push(
    setInterval(async () => {
      if (corriendo) return;
      corriendo = true;
      try {
        await fn();
      } catch (err) {
        console.error(`[wa] error en ${nombre}`, err);
      } finally {
        corriendo = false;
      }
    }, ms)
  );
}

export async function iniciarModuloWhatsapp() {
  cada(5_000, trabajarOutbox, "outbox");
  cada(60_000, vencerSolicitudes, "vencimientos");
  cada(60_000, tickResumenDueno, "resumen al dueño");
  await autoIniciar().catch((e) => console.error("[wa] no se pudo iniciar WhatsApp", e));
}

export function detenerTrabajadores() {
  timers.forEach(clearInterval);
  timers = [];
}
