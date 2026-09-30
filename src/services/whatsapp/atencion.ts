import { pool } from "../../db/pool";
import { emitirPanel } from "./eventos";
import { actualizarChat, chatParaPanel, notaInterna, obtenerChat } from "./mensajes";
import { avisarDueno } from "./dueno";

// ÚNICO punto para marcar que un cliente necesita a una persona: pausa el bot en ese
// chat, deja una nota en el panel y le avisa al dueño por WhatsApp.

export async function marcarNecesitaHumano(jid: string, motivo: string, opciones: { texto?: string | null } = {}) {
  const antes = await obtenerChat(jid);
  if (!antes) return;
  const chat = await actualizarChat(jid, {
    necesita_humano: true,
    motivo,
    necesita_humano_desde: antes.necesita_humano ? antes.necesita_humano_desde : new Date().toISOString(),
    bot_activo: false,
  });
  if (!chat) return;
  await notaInterna(jid, `Necesita atención: ${motivo}. El bot quedó en pausa en este chat.`);
  emitirPanel("atencion", await chatParaPanel(chat));

  let texto = opciones.texto ?? null;
  if (!texto) {
    const r = await pool.query(
      `SELECT texto FROM wa_mensajes WHERE jid = $1 AND autor = 'cliente' AND texto IS NOT NULL ORDER BY id DESC LIMIT 1`,
      [jid]
    );
    texto = r.rows[0]?.texto ?? null;
  }
  await avisarDueno(chat, motivo, texto).catch((e) => console.error("[wa] no se pudo avisar al dueño", e));
}

/** La persona terminó o decide que siga el bot. */
export async function devolverAlBot(jid: string, quien: string) {
  const chat = await actualizarChat(jid, { bot_activo: true, necesita_humano: false, motivo: null, necesita_humano_desde: null });
  if (chat) {
    await notaInterna(jid, `${quien} devolvió el chat al bot.`);
    emitirPanel("atencion", await chatParaPanel(chat));
  }
  return chat;
}

/** Una persona toma el chat: el bot se pausa y deja de figurar como "esperando". */
export async function tomarControl(jid: string, quien: string) {
  const antes = await obtenerChat(jid);
  if (!antes) return null;
  const chat = await actualizarChat(jid, { bot_activo: false, necesita_humano: false, motivo: null, necesita_humano_desde: null });
  if (antes.bot_activo || antes.necesita_humano) await notaInterna(jid, `${quien} tomó el chat: el bot quedó en pausa.`);
  if (chat) emitirPanel("atencion", await chatParaPanel(chat));
  return chat;
}

export async function listarEsperando() {
  const r = await pool.query(`SELECT * FROM wa_chats WHERE necesita_humano ORDER BY necesita_humano_desde ASC NULLS LAST`);
  return Promise.all(r.rows.map(chatParaPanel));
}
