import { pool } from "../../db/pool";
import { ahoraLocal, enRango, guardarEstadoDueno, leerConfig, leerEstadoDueno, type ConfigWa } from "./config";
import { asegurarChat, obtenerChat, type FilaChat, type FilaMensaje } from "./mensajes";
import { enviarMensaje } from "./envio";
import { jidDeTelefono, transporte } from "./transporte";
import { devolverAlBot, listarEsperando, tomarControl } from "./atencion";
import { encolarTurno, enviarInstruccionAlCliente, responderAlDueno } from "./bot";

// Asistente del dueño por WhatsApp: le avisa cuando un cliente necesita una persona y le
// deja responder desde ahí. Si el dueño usa el mismo número del bot, escribe en el chat "Tú".

const FOCO_MS = 30 * 60_000;
type Modo = "aviso" | "resumen";

function soloDigitos(t: string) {
  return t.replace(/\D/g, "");
}

export async function jidDelDueno(config?: ConfigWa) {
  const c = config ?? (await leerConfig());
  const tel = soloDigitos(c.dueno.telefono);
  return tel.length >= 10 ? jidDeTelefono(tel) : null;
}

/** true si el chat es el del dueño (cuando usa un número distinto al del bot). */
export async function esJidDelDueno(jid: string) {
  const dueno = await jidDelDueno();
  return !!dueno && dueno === jid && jid !== transporte().miJid();
}

function enSilencio(config: ConfigWa) {
  const { hora } = ahoraLocal(config.negocio.zonaHoraria);
  return enRango(hora, config.dueno.silencioDesde, config.dueno.silencioHasta);
}

function nombreDe(c: Pick<FilaChat, "nombre_guardado" | "nombre" | "telefono">) {
  return c.nombre_guardado ?? c.nombre ?? `+${c.telefono}`;
}

const azar = <T,>(lista: T[]) => lista[Math.floor(Math.random() * lista.length)]!;

async function escribirAlDueno(texto: string, jid?: string) {
  const destino = jid ?? (await jidDelDueno());
  if (!destino) return;
  await asegurarChat(destino);
  await enviarMensaje({ jid: destino, autor: "sistema", texto });
}

async function focoVigente() {
  const e = await leerEstadoDueno();
  if (!e.focoJid || !e.focoEn || Date.now() - new Date(e.focoEn).getTime() > FOCO_MS) return { estado: e, foco: null as FilaChat | null };
  return { estado: e, foco: await obtenerChat(e.focoJid) };
}

async function ponerFoco(jid: string | null, modo: Modo | null = "aviso") {
  await guardarEstadoDueno({ focoJid: jid, focoEn: jid ? new Date().toISOString() : null, modo, modoEn: new Date().toISOString() });
}

function textoAviso(config: ConfigWa, chat: FilaChat, motivo: string, texto: string | null) {
  const saludo = azar(["Hola", "Oye", "Ey"]);
  const nombre = config.dueno.nombre ? ` ${config.dueno.nombre}` : "";
  const lineas = [
    `${saludo}${nombre}, ${nombreDe(chat)} (+${chat.telefono}) necesita que lo atiendas: ${motivo}.`,
    texto ? `Lo último que escribió: "${texto.slice(0, 220)}"` : null,
    "",
    azar([
      "Responde *1* si lo atiendes tú, *2* si prefieres que siga el bot, o escríbeme lo que quieres que le diga.",
      "*1* lo atiendes tú · *2* que siga el bot · o dime qué le respondo.",
    ]),
  ];
  return lineas.filter((l) => l !== null).join("\n");
}

/** Aviso al dueño cuando un chat pasa a "necesita atención" (lo llama atencion.ts). */
export async function avisarDueno(chat: FilaChat, motivo: string, texto: string | null) {
  const config = await leerConfig();
  if (!config.dueno.avisos || !(await jidDelDueno(config))) return;
  if (!transporte().conectado()) return;
  if (enSilencio(config)) return; // lo verá en el resumen al terminar el silencio
  await escribirAlDueno(textoAviso(config, chat, motivo, texto));
  await ponerFoco(chat.jid, "aviso");
}

function sinAcentos(t: string) {
  return t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

const AYUDA = [
  "Esto es lo que puedo hacer por ti:",
  "*1* · atiendes tú al cliente del último aviso (pauso el bot y te paso su WhatsApp)",
  "*2* · que siga el bot con ese cliente",
  "Cualquier otro texto · se lo digo al cliente con mis palabras",
  "*cola* · quiénes están esperando",
  "*siguiente* · el próximo que espera",
  "*listo* · terminaste con el cliente en curso (vuelve al bot)",
  "*comprobante* · comprobantes por aprobar",
  "Si tu mensaje termina en *?* no se lo reenvío a nadie: te respondo yo.",
].join("\n");

export async function procesarMensajeDueno(jidOrigen: string, texto: string, _fila: FilaMensaje) {
  const t = texto.trim();
  if (!t) return;
  const orden = sinAcentos(t);
  const responder = (m: string) => escribirAlDueno(m, jidOrigen);
  const { estado, foco } = await focoVigente();
  const enResumen = estado.modo === "resumen" && estado.modoEn && Date.now() - new Date(estado.modoEn).getTime() < FOCO_MS;

  if (enResumen && ["1", "2", "3"].includes(orden)) {
    await ponerFoco(null, null);
    if (orden === "1") return responder("Dale, te los dejo en pausa. Cuando quieras escribe *siguiente* y te paso uno.");
    if (orden === "2") return siguiente(responder, null);
    const url = process.env.PANEL_URL ? `${process.env.PANEL_URL.replace(/\/$/, "")}/whatsapp` : "el módulo WhatsApp del sistema";
    return responder(`Los tienes en "Esperando por ti", arriba de los chats: ${url}`);
  }

  if (orden === "1" && foco) {
    await tomarControl(foco.jid, "El dueño");
    await ponerFoco(foco.jid, "aviso");
    return responder(`Listo, ${nombreDe(foco)} es tuyo; pausé el bot. Escríbele aquí: https://wa.me/${foco.telefono}\nCuando termines escribe *listo*.`);
  }
  if (orden === "2" && foco) {
    await devolverAlBot(foco.jid, "El dueño");
    await ponerFoco(null, null);
    encolarTurno(foco.jid); // su último mensaje quedó sin responder
    return responder(`Perfecto, el bot sigue con ${nombreDe(foco)}.`);
  }
  if (orden === "cola") return cola(responder);
  if (orden === "siguiente") return siguiente(responder, foco?.jid ?? null);
  if (orden === "listo") {
    if (!foco) return responder("No tengo a ningún cliente en curso. Escribe *cola* para ver quién espera.");
    await devolverAlBot(foco.jid, "El dueño");
    await ponerFoco(null, null);
    const quedan = (await listarEsperando()).length;
    return responder(`Hecho, ${nombreDe(foco)} vuelve al bot.${quedan ? ` Quedan ${quedan} esperando: escribe *siguiente*.` : " No queda nadie esperando."}`);
  }
  if (orden === "comprobante" || orden === "comprobantes") return comprobantes(responder);
  if (orden === "ayuda" || orden === "menu") return responder(AYUDA);

  // Texto libre con un cliente en foco: se lo decimos (salvo que sea una pregunta para el bot)
  if (foco && !t.endsWith("?")) {
    const enviado = await enviarInstruccionAlCliente(foco.jid, t);
    await devolverAlBot(foco.jid, "El dueño (respondió por WhatsApp)");
    await ponerFoco(foco.jid, "aviso");
    return responder(`Le envié a ${nombreDe(foco)}: «${enviado}»\nEl bot sigue la conversación; escribe *1* si prefieres atenderlo tú.`);
  }

  // Todo lo demás lo responde el bot normal, sabiendo que es el dueño
  await responderAlDueno(jidOrigen, t);
}

async function cola(responder: (m: string) => Promise<void>) {
  const esperando = await listarEsperando();
  if (esperando.length === 0) return responder("No hay nadie esperando. 🙌");
  const ahora = Date.now();
  const lineas = esperando.slice(0, 10).map((c, i) => {
    const min = c.necesitaHumanoDesde ? Math.round((ahora - new Date(c.necesitaHumanoDesde).getTime()) / 60_000) : 0;
    return `${i + 1}. ${c.nombre} — ${c.motivo ?? "sin motivo"} · hace ${min} min`;
  });
  return responder([`Esperando por ti (${esperando.length}):`, ...lineas, "", "Escribe *siguiente* para empezar."].join("\n"));
}

async function siguiente(responder: (m: string) => Promise<void>, actual: string | null) {
  const esperando = await listarEsperando();
  const prox = esperando.find((c) => c.jid !== actual) ?? esperando[0];
  if (!prox) {
    await ponerFoco(null, null);
    return responder("No queda nadie esperando. 🙌");
  }
  const chat = await obtenerChat(prox.jid);
  if (!chat) return;
  const ultimo = await pool.query(
    `SELECT texto FROM wa_mensajes WHERE jid = $1 AND autor = 'cliente' AND texto IS NOT NULL ORDER BY id DESC LIMIT 1`,
    [chat.jid]
  );
  await ponerFoco(chat.jid, "aviso");
  const config = await leerConfig();
  return responder(textoAviso(config, chat, chat.motivo ?? "necesita atención", ultimo.rows[0]?.texto ?? null));
}

async function comprobantes(responder: (m: string) => Promise<void>) {
  const r = await pool.query(
    `SELECT t.id, t.monto_origen, m.codigo, ter.nombre, max(d.created_at) AS recibido
     FROM transacciones t
     JOIN monedas m ON m.id = t.moneda_origen_id
     LEFT JOIN terceros ter ON ter.id = t.tercero_id
     JOIN documentos_tercero d ON d.transaccion_id = t.id AND d.tipo = 'COMPROBANTE_PAGO'
     WHERE t.estado = 'PENDIENTE'
     GROUP BY t.id, m.codigo, ter.nombre ORDER BY recibido LIMIT 10`
  );
  if (r.rows.length === 0) return responder("No hay comprobantes pendientes de aprobar.");
  const ahora = Date.now();
  const lineas = r.rows.map(
    (f) => `#${f.id} ${f.nombre ?? "sin cliente"} · ${Number(f.monto_origen)} ${f.codigo} · hace ${Math.round((ahora - new Date(f.recibido).getTime()) / 60_000)} min`
  );
  return responder(["Comprobantes por aprobar (Bandeja de solicitudes):", ...lineas].join("\n"));
}

/** Resumen periódico de pendientes (cada X minutos, fuera de las horas de silencio). */
export async function tickResumenDueno() {
  const config = await leerConfig();
  const m = config.dueno.resumenCadaMin;
  if (!m || !config.dueno.avisos || !(await jidDelDueno(config)) || !transporte().conectado() || enSilencio(config)) return;
  const estado = await leerEstadoDueno();
  if (estado.ultimoResumenEn && Date.now() - new Date(estado.ultimoResumenEn).getTime() < m * 60_000) return;
  const esperando = await listarEsperando();
  await guardarEstadoDueno({ ultimoResumenEn: new Date().toISOString() });
  if (esperando.length === 0) return;
  const nombres = esperando.slice(0, 5).map((c) => `${c.nombre} (${c.motivo ?? "necesita atención"})`);
  await escribirAlDueno(
    [
      `${azar(["Te cuento", "Resumen rápido", "Para que no se te pase"])}: hay ${esperando.length} ${esperando.length === 1 ? "cliente esperando" : "clientes esperando"}.`,
      nombres.join("\n"),
      "",
      "*1* los respondo yo poco a poco · *2* uno por uno · *3* el panel",
    ].join("\n")
  );
  await ponerFoco(null, "resumen");
}
