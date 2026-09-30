/* Pruebas del módulo WhatsApp contra la BD real, con WhatsApp y la IA simulados.
 * Todo lo que crea queda marcado (números 5799…, etiqueta/cajas "PRUEBA-WA") y se borra al final.
 * Uso: npm run test:whatsapp
 */
import assert from "node:assert/strict";

process.env.WA_AUTOSTART = "false";
process.env.WA_DEBOUNCE_MS = "400";
process.env.WA_FACTOR_TIEMPO = "0.01";

import type { WAMessage, WAMessageKey } from "@whiskeysockets/baileys";
import type { OpcionesTurno, ResultadoTurno, LlamadaHerramienta } from "../src/services/whatsapp/ia";
import type { ContenidoSalida } from "../src/services/whatsapp/transporte";

const PREFIJO = "579900000";
const BOT = `${PREFIJO}099`;
const DUENO = `${PREFIJO}090`;
const jid = (tel: string) => `${tel}@s.whatsapp.net`;
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { pool } = await import("../src/db/pool");
  const transporteMod = await import("../src/services/whatsapp/transporte");
  const ia = await import("../src/services/whatsapp/ia");
  const config = await import("../src/services/whatsapp/config");
  const entrantes = await import("../src/services/whatsapp/entrantes");
  const bot = await import("../src/services/whatsapp/bot");
  const envio = await import("../src/services/whatsapp/envio");
  const outbox = await import("../src/services/whatsapp/outbox");
  const trabajadores = await import("../src/services/whatsapp/trabajadores");
  const herramientas = await import("../src/services/whatsapp/herramientas");
  const atencion = await import("../src/services/whatsapp/atencion");
  const almacenamiento = await import("../src/services/almacenamiento.service");
  const mensajes = await import("../src/services/whatsapp/mensajes");

  const resultados: { nombre: string; ok: boolean; error?: string }[] = [];
  async function prueba(nombre: string, fn: () => Promise<void>) {
    try {
      await fn();
      resultados.push({ nombre, ok: true });
      console.log(`  ✓ ${nombre}`);
    } catch (err) {
      resultados.push({ nombre, ok: false, error: (err as Error).message });
      console.log(`  ✗ ${nombre}\n    ${(err as Error).stack?.split("\n").slice(0, 4).join("\n    ")}`);
    }
  }

  // ---------- Transporte simulado ----------
  const enviados: { jid: string; contenido: ContenidoSalida; id: string }[] = [];
  const presencias: { jid: string; tipo: string }[] = [];
  const leidos: WAMessageKey[] = [];
  transporteMod.usarTransporte({
    conectado: () => true,
    miJid: () => jid(BOT),
    enviar: async (j, contenido, id) => {
      enviados.push({ jid: j, contenido, id });
      return { remoteJid: j, fromMe: true, id };
    },
    presencia: async (j, tipo) => {
      presencias.push({ jid: j, tipo });
    },
    leer: async (claves) => {
      leidos.push(...claves);
    },
    existe: async (tel) => (tel.endsWith("999") ? null : jid(tel)),
    descargar: async () => PNG_1x1,
  });
  const textosA = (tel: string) =>
    enviados.filter((e) => e.jid === jid(tel)).map((e) => ("texto" in e.contenido ? e.contenido.texto ?? "" : ""));

  // ---------- IA simulada con guion ----------
  const llamadasIa: OpcionesTurno[] = [];
  let demoraIa = 0;
  type Paso = { si: RegExp; hacer: (op: OpcionesTurno) => Promise<ResultadoTurno> };
  const guion: Paso[] = [];
  const usar = async (op: OpcionesTurno, nombre: string, args: Record<string, unknown>): Promise<LlamadaHerramienta> => ({
    nombre,
    args,
    resultado: await op.ejecutar(nombre, args),
  });
  const ultimoDelCliente = (op: OpcionesTurno) => {
    const textos: string[] = [];
    for (let i = op.historial.length - 1; i >= 0 && op.historial[i]!.rol === "user"; i--) textos.unshift(op.historial[i]!.texto);
    return textos.join("\n");
  };
  ia.usarIaSimulada(async (op) => {
    llamadasIa.push(op);
    if (demoraIa) await dormir(demoraIa);
    const texto = ultimoDelCliente(op);
    for (const p of guion) if (p.si.test(texto)) return p.hacer(op);
    return { texto: "Claro, cuéntame un poco más.", llamadas: [], modeloUsado: "falso" };
  });

  async function esperarQuieto() {
    await bot.esperarColasVacias(30_000);
    for (let i = 0; i < 200 && envio.estadoCola().enCola > 0; i++) await dormir(50);
    await dormir(150);
  }

  let n = 0;
  async function entra(tel: string, texto: string, o: { imagen?: boolean; hace?: number; tipo?: "notify" | "append"; deMi?: boolean; id?: string } = {}) {
    const msg = {
      key: { remoteJid: jid(tel), fromMe: !!o.deMi, id: o.id ?? `PRUEBAWA${Date.now()}${n++}` },
      message: o.imagen ? { imageMessage: { caption: texto || undefined, mimetype: "image/png" } } : { conversation: texto },
      messageTimestamp: Math.floor((Date.now() - (o.hace ?? 0)) / 1000),
      pushName: "Prueba WA",
    } as unknown as WAMessage;
    await entrantes.procesarEntrantes([msg], o.tipo ?? "notify");
    return msg.key.id!;
  }
  const chatDe = async (tel: string) => (await pool.query(`SELECT * FROM wa_chats WHERE jid = $1`, [jid(tel)])).rows[0];
  const msgsDe = async (tel: string) => (await pool.query(`SELECT * FROM wa_mensajes WHERE jid = $1 ORDER BY id`, [jid(tel)])).rows;

  // ---------- Datos de prueba ----------
  const respaldo = (await pool.query(`SELECT datos, estado_dueno FROM wa_config WHERE id = 1`)).rows[0];
  const botId = await herramientas.usuarioBotId();
  const usd = (await pool.query(`SELECT id FROM monedas WHERE codigo = 'USD'`)).rows[0].id;
  const cop = (await pool.query(`SELECT id FROM monedas WHERE codigo = 'COP'`)).rows[0].id;
  const cajaUsd = (
    await pool.query(
      `INSERT INTO cajas (nombre, tipo, banco, numero_cuenta, titular, moneda_id) VALUES ('PRUEBA-WA Zelle', 'BANCO', 'Zelle', '5550001111', 'Veloz Prueba', $1) RETURNING id`,
      [usd]
    )
  ).rows[0].id;
  const cajaCop = (
    await pool.query(
      `INSERT INTO cajas (nombre, tipo, banco, numero_cuenta, tipo_cuenta, titular, moneda_id) VALUES ('PRUEBA-WA Bancolombia', 'BANCO', 'Bancolombia', '99988877766', 'AHORRO', 'Veloz Prueba', $1) RETURNING id`,
      [cop]
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO cotizaciones_detalle (moneda_id, tipo, etiqueta, valor, creado_por_id) VALUES ($1, 'COMPRA', 'PRUEBA-WA', 3800, $2), ($1, 'VENTA', 'PRUEBA-WA', 3950, $2)`,
    [usd, botId]
  );

  const base = structuredClone(config.CONFIG_POR_DEFECTO);
  base.ia = { activa: true, proveedor: "gemini", modelo: "falso", modelosRespaldo: [], vision: true };
  base.negocio.cotizacionesPermitidas = ["USD|COMPRA|PRUEBA-WA", "USD|VENTA|PRUEBA-WA"];
  base.negocio.cajasPorMoneda = { USD: cajaUsd, COP: cajaCop };
  base.horario.responderFueraDeHorario = true;
  base.antibloqueo = { ...base.antibloqueo, porMinuto: 60, porDia: 5000, pausaMinMs: 0, pausaMaxMs: 5, friosPorDia: 1, friosPausaMinS: 10, friosPausaMaxS: 10, friosDesde: "00:00", friosHasta: "23:59" };
  base.dueno = { nombre: "Ana", telefono: DUENO, avisos: true, resumenCadaMin: 0, silencioDesde: "03:00", silencioHasta: "03:01" };
  await config.guardarConfig(base);
  await config.guardarClave("gemini", "AIza-clave-de-prueba");
  await pool.query(`UPDATE wa_config SET estado_dueno = '{}'::jsonb WHERE id = 1`);

  console.log("\nPruebas del módulo WhatsApp\n");

  try {
    // ================= Unitarias =================
    await prueba("markdown a formato WhatsApp y un párrafo = un mensaje", async () => {
      const partes = bot.aFormatoWhatsapp("## Hola\n\n**Claro** que sí:\n- uno\n- dos\n\nTe espero.");
      assert.deepEqual(partes, ["Hola", "*Claro* que sí:\nuno\ndos", "Te espero."]);
    });
    await prueba("detecta el proveedor por el prefijo de la clave", async () => {
      assert.equal(ia.detectarProveedor("gsk_abc"), "groq");
      assert.equal(ia.detectarProveedor("AIzaSy"), "gemini");
      assert.equal(ia.detectarProveedor("sk-ant-api03"), "anthropic");
      assert.equal(ia.detectarProveedor("sk-or-v1"), "openrouter");
      assert.equal(ia.detectarProveedor("xyz"), null);
    });
    await prueba("formato de montos sin float y rangos de hora que cruzan medianoche", async () => {
      assert.equal(herramientas.formatearMonto("380000.0000", 0), "380.000");
      assert.equal(herramientas.formatearMonto("1234567.5", 2), "1.234.567,50");
      assert.equal(config.enRango("23:30", "22:00", "07:00"), true);
      assert.equal(config.enRango("12:00", "22:00", "07:00"), false);
    });
    await prueba("las claves de IA se leen enmascaradas", async () => {
      const panel = await config.leerConfigParaPanel();
      assert.equal(panel.claves.gemini, "AIza-…ueba");
      assert.ok(!JSON.stringify(panel).includes("AIza-clave-de-prueba"));
    });

    // ================= Concurrencia =================
    const T1 = `${PREFIJO}001`;
    await prueba("ráfaga de 3 mensajes = 1 turno; lo que llega durante el turno = 1 turno más, sin duplicar", async () => {
      demoraIa = 800;
      await entra(T1, "hola");
      await entra(T1, "buenas");
      await entra(T1, "quiero info");
      for (let i = 0; i < 100 && !llamadasIa.some((l) => ultimoDelCliente(l).includes("quiero info")); i++) await dormir(50);
      await entra(T1, "otra cosa"); // llega mientras la IA "piensa"
      await entra(T1, "y otra más");
      await esperarQuieto();
      demoraIa = 0;
      const deT1 = llamadasIa.filter((l) => l.historial.some((h) => h.texto === "hola"));
      assert.equal(deT1.length, 2, `turnos: ${deT1.length}`);
      assert.equal(ultimoDelCliente(deT1[0]!), "hola\nbuenas\nquiero info");
      assert.ok(!deT1[0]!.historial.some((h) => h.texto === "otra cosa"), "el primer turno vio un mensaje posterior (hastaId)");
      assert.equal(ultimoDelCliente(deT1[1]!), "otra cosa\ny otra más");
      const bots = (await msgsDe(T1)).filter((m) => m.autor === "bot");
      assert.equal(bots.length, 2);
      assert.ok(bots.every((m) => m.estado === "enviado"));
      assert.ok(presencias.some((p) => p.jid === jid(T1) && p.tipo === "composing"), "no simuló escribiendo…");
      assert.ok(leidos.some((k) => k.remoteJid === jid(T1)), "no marcó como leídos");
      const chat = await chatDe(T1);
      assert.equal(chat.no_leidos, 5);
      assert.equal(chat.ultimo_entrante_en !== null, true);
    });

    await prueba("el eco de un mensaje propio (messages.upsert) no se duplica", async () => {
      const bots = (await msgsDe(T1)).filter((m) => m.autor === "bot");
      const antes = (await msgsDe(T1)).length;
      await entra(T1, "texto del bot", { deMi: true, id: bots[0].wa_id });
      assert.equal((await msgsDe(T1)).length, antes);
    });

    await prueba("estados ✓/✓✓/azul nunca retroceden", async () => {
      const waId = (await msgsDe(T1)).find((m) => m.autor === "bot").wa_id;
      await entrantes.procesarActualizaciones([{ key: { id: waId, fromMe: true, remoteJid: jid(T1) }, update: { status: 3 } }]);
      await entrantes.procesarActualizaciones([{ key: { id: waId, fromMe: true, remoteJid: jid(T1) }, update: { status: 2 } }]);
      let fila = (await pool.query(`SELECT estado FROM wa_mensajes WHERE wa_id = $1`, [waId])).rows[0];
      assert.equal(fila.estado, "entregado");
      await entrantes.procesarActualizaciones([{ key: { id: waId, fromMe: true, remoteJid: jid(T1) }, update: { status: 4 } }]);
      fila = (await pool.query(`SELECT estado FROM wa_mensajes WHERE wa_id = $1`, [waId])).rows[0];
      assert.equal(fila.estado, "leido");
    });

    await prueba("el historial sincronizado (append) se guarda pero no cuenta como no leído ni dispara al bot", async () => {
      const T = `${PREFIJO}002`;
      const antes = llamadasIa.length;
      await entra(T, "mensaje viejo sincronizado", { tipo: "append", hace: 86_400_000 });
      await esperarQuieto();
      const chat = await chatDe(T);
      assert.equal(chat.no_leidos, 0);
      assert.equal(llamadasIa.length, antes);
      assert.equal((await msgsDe(T)).length, 1);
    });

    await prueba("mensajes viejos al reconectar: los atiende una persona, el bot no responde en ráfaga", async () => {
      const T = `${PREFIJO}003`;
      const antes = llamadasIa.length;
      await entra(T, "hola? hay alguien", { hace: 40 * 60_000 });
      await esperarQuieto();
      assert.equal(llamadasIa.length, antes);
      const chat = await chatDe(T);
      assert.equal(chat.necesita_humano, true);
      assert.equal(chat.bot_activo, false);
    });

    // ================= Flujo completo de un cambio =================
    const T2 = `${PREFIJO}010`;
    guion.push(
      {
        si: /vender 100 d[oó]lares/i,
        hacer: async (op) => ({
          texto: "Perfecto, te acabo de pasar la cotización. ¿La hacemos?",
          llamadas: [await usar(op, "cotizar", { operacion: "cliente_vende_divisa", moneda: "USD", monto: "100", monto_en: "divisa" })],
          modeloUsado: "falso",
        }),
      },
      {
        si: /me llamo Juan Prueba/i,
        hacer: async (op) => {
          const a = await usar(op, "registrar_cliente", { nombre: "Juan Prueba WA", identificacion: "99887766" });
          const b = await usar(op, "crear_solicitud", {
            nueva_cuenta: { tipo: "NEQUI", telefono: "3001234567", titular: "Juan Prueba WA" },
          });
          return { texto: "Listo Juan, **ya quedó** tu solicitud.\n\nCualquier cosa me dices.", llamadas: [a, b], modeloUsado: "falso" };
        },
      },
      {
        si: /envió una foto/i,
        hacer: async (op) => ({
          texto: "¡Recibido! Lo estamos verificando.",
          llamadas: [await usar(op, "registrar_comprobante", { monto_leido: "100", referencia: "PRUEBAWA-REF-1", banco: "Chase" })],
          modeloUsado: "falso",
        }),
      },
      {
        si: /c[oó]mo va mi cambio/i,
        hacer: async (op) => ({ texto: "Te pasé el estado.", llamadas: [await usar(op, "mis_operaciones", {})], modeloUsado: "falso" }),
      }
    );

    let txId = 0;
    await prueba("cotizar: el SISTEMA envía los montos exactos de calcularCambio y la IA no los escribe", async () => {
      await entra(T2, "hola, quiero vender 100 dolares");
      await esperarQuieto();
      const msgs = await msgsDe(T2);
      const sistema = msgs.filter((m) => m.autor === "sistema" && !m.interno);
      assert.equal(sistema.length, 1);
      assert.match(sistema[0].texto, /Nos entregas: 100,00 USD/);
      assert.match(sistema[0].texto, /Recibes: \$380\.000 COP/);
      const orden = msgs.filter((m) => m.de_mi && !m.interno).map((m) => m.autor);
      assert.deepEqual(orden, ["sistema", "bot"], "la cotización tiene que salir antes del comentario");
      const chat = await chatDe(T2);
      assert.equal(chat.estado.cotizacion.montoLocal, "380000");
    });

    await prueba("registra al cliente nuevo, guarda su cuenta y crea la solicitud PENDIENTE con tasa congelada", async () => {
      await entra(T2, "sí dale, me llamo Juan Prueba, cc 99887766, a mi nequi 3001234567");
      await esperarQuieto();
      const chat = await chatDe(T2);
      assert.ok(chat.tercero_id, "no vinculó el cliente");
      txId = chat.estado.solicitudId;
      const tx = (await pool.query(`SELECT * FROM transacciones WHERE id = $1`, [txId])).rows[0];
      assert.equal(tx.estado, "PENDIENTE");
      assert.equal(tx.origen, "WHATSAPP");
      assert.equal(tx.tipo, "COMPRA_DIVISA");
      assert.equal(Number(tx.monto_origen), 100);
      assert.equal(Number(tx.monto_destino), 380000);
      assert.equal(tx.usuario_id, botId);
      assert.ok(tx.cuenta_tercero_id);
      const minutos = (new Date(tx.tasa_vence_en).getTime() - Date.now()) / 60_000;
      assert.ok(minutos > 28 && minutos <= 30, `vence en ${minutos} min`);
      const datosPago = (await msgsDe(T2)).filter((m) => m.autor === "sistema" && !m.interno).pop();
      assert.match(datosPago.texto, /Transfiere exactamente: \*100,00 USD\*/);
      assert.match(datosPago.texto, /5550001111/);
      const bots = (await msgsDe(T2)).filter((m) => m.autor === "bot").map((m) => m.texto);
      assert.ok(bots.includes("Listo Juan, *ya quedó* tu solicitud."), JSON.stringify(bots));
    });

    await prueba("la foto del comprobante queda como documento pendiente con la referencia leída", async () => {
      await entra(T2, "", { imagen: true });
      await esperarQuieto();
      const doc = (await pool.query(`SELECT * FROM documentos_tercero WHERE transaccion_id = $1`, [txId])).rows[0];
      assert.ok(doc, "no se creó el documento");
      assert.equal(doc.tipo, "COMPROBANTE_PAGO");
      assert.equal(doc.estado, "PENDIENTE");
      assert.match(doc.descripcion, /ref\. PRUEBAWA-REF-1/);
      const tx = (await pool.query(`SELECT r.codigo FROM transacciones t JOIN referencias r ON r.id = t.referencia_id WHERE t.id = $1`, [txId])).rows[0];
      assert.equal(tx.codigo, "PRUEBAWA-REF-1");
      const ultimaIa = llamadasIa[llamadasIa.length - 1]!;
      assert.ok(ultimaIa.historial.some((h) => h.imagenes?.length), "la foto no se le pasó a la IA (visión)");
      assert.equal((await chatDe(T2)).estado.comprobanteRecibido, true);
    });

    await prueba("mis_operaciones envía el estado real", async () => {
      await entra(T2, "cómo va mi cambio?");
      await esperarQuieto();
      const ultimoSistema = (await msgsDe(T2)).filter((m) => m.autor === "sistema" && !m.interno).pop();
      assert.match(ultimoSistema.texto, new RegExp(`#${txId} .*100,00 USD · en verificación`));
    });

    await prueba("al rechazar en la Bandeja, el aviso al cliente va a la outbox y sale una vez", async () => {
      const { rechazarTransaccion } = await import("../src/services/transaccionService");
      await rechazarTransaccion(txId, botId, "prueba");
      await outbox.notificarResultadoTransaccion(txId);
      await outbox.notificarResultadoTransaccion(txId); // duplicado: no debe encolar dos veces
      await outbox.trabajarOutbox();
      await esperarQuieto();
      const items = (await pool.query(`SELECT * FROM wa_outbox WHERE origen = $1`, [`transaccion:${txId}:rechazada`])).rows;
      assert.equal(items.length, 1);
      assert.equal(items[0].estado, "ENVIADO");
      assert.ok(textosA(T2).some((t) => t.includes(`#${txId}`) && /no (se pudo completar|se completó)/.test(t)));
      assert.equal((await chatDe(T2)).estado.solicitudId, undefined);
    });

    await prueba("el comprobante con referencia repetida se deriva a una persona", async () => {
      const T = `${PREFIJO}011`;
      guion.unshift({
        si: /vender 50 d[oó]lares ya/i,
        hacer: async (op) => {
          const l = [
            await usar(op, "cotizar", { operacion: "cliente_vende_divisa", moneda: "USD", monto: "50", monto_en: "divisa" }),
            await usar(op, "registrar_cliente", { nombre: "Pedro Prueba WA", identificacion: "11223344" }),
            await usar(op, "crear_solicitud", { nueva_cuenta: { tipo: "NEQUI", telefono: "3009998877", titular: "Pedro Prueba WA" } }),
          ];
          return { texto: "Listo.", llamadas: l, modeloUsado: "falso" };
        },
      });
      await entra(T, "quiero vender 50 dolares ya, soy Pedro");
      await esperarQuieto();
      await entra(T, "", { imagen: true }); // la IA lee la misma referencia de la prueba anterior
      await esperarQuieto();
      const chat = await chatDe(T);
      assert.equal(chat.necesita_humano, true, "no se derivó");
      assert.match(chat.motivo, /referencia repetida/);
    });

    // ================= Vencimiento de la tasa =================
    await prueba("si vence la tasa sin comprobante: se libera, se rechaza y se avisa con amabilidad", async () => {
      const T = `${PREFIJO}012`;
      guion.unshift({
        si: /vender 20 d[oó]lares/i,
        hacer: async (op) => {
          const l = [
            await usar(op, "cotizar", { operacion: "cliente_vende_divisa", moneda: "USD", monto: "20", monto_en: "divisa" }),
            await usar(op, "registrar_cliente", { nombre: "Luisa Prueba WA", identificacion: "55443322" }),
            await usar(op, "crear_solicitud", { nueva_cuenta: { tipo: "NEQUI", telefono: "3001112233", titular: "Luisa Prueba WA" } }),
          ];
          return { texto: "Hecho.", llamadas: l, modeloUsado: "falso" };
        },
      });
      await entra(T, "quiero vender 20 dolares");
      await esperarQuieto();
      const id = (await chatDe(T)).estado.solicitudId;
      await pool.query(`UPDATE transacciones SET tasa_vence_en = now() - interval '1 minute' WHERE id = $1`, [id]);
      const vencidas = await trabajadores.vencerSolicitudes();
      assert.ok(vencidas >= 1);
      const tx = (await pool.query(`SELECT estado, motivo_rechazo FROM transacciones WHERE id = $1`, [id])).rows[0];
      assert.equal(tx.estado, "RECHAZADA");
      await outbox.trabajarOutbox();
      await esperarQuieto();
      assert.ok(textosA(T).some((t) => t.includes(`#${id}`) && /venci/.test(t)));
    });

    // ================= Pasar a humano + asistente del dueño =================
    const T3 = `${PREFIJO}020`;
    guion.unshift(
      {
        si: /pagar en efectivo/i,
        hacer: async (op) => ({
          texto: "Te comunico con alguien del equipo.",
          llamadas: [await usar(op, "pasar_a_humano", { motivo: "quiere pagar en efectivo" })],
          modeloUsado: "falso",
        }),
      },
      {
        si: /Lo que hay que decirle: mañana abrimos a las 9/i,
        hacer: async () => ({ texto: "¡Hola! Te cuento que mañana abrimos a las 9 am, ahí te atendemos. 😊", llamadas: [], modeloUsado: "falso" }),
      },
      {
        si: /a cómo quedó el dólar hoy\?/i,
        hacer: async () => ({ texto: "Hoy estamos comprando y vendiendo con las tasas cargadas, jefa.", llamadas: [], modeloUsado: "falso" }),
      }
    );

    await prueba("pasar_a_humano: pausa el bot, marca el chat y avisa al dueño con opciones", async () => {
      await entra(T3, "quiero pagar en efectivo en la oficina");
      await esperarQuieto();
      const chat = await chatDe(T3);
      assert.equal(chat.necesita_humano, true);
      assert.equal(chat.bot_activo, false);
      assert.equal(chat.motivo, "quiere pagar en efectivo");
      const aviso = textosA(DUENO).pop() ?? "";
      assert.match(aviso, /Prueba WA \(\+579900000020\) necesita que lo atiendas: quiere pagar en efectivo/);
      assert.match(aviso, /pagar en efectivo en la oficina/);
      assert.match(aviso, /\*1\*/);
      assert.ok(textosA(T3).includes("Te comunico con alguien del equipo."), "la despedida del bot no salió");
      const antes = llamadasIa.length;
      await entra(T3, "hola??");
      await esperarQuieto();
      assert.equal(llamadasIa.length, antes, "el bot respondió estando en pausa");
    });

    await prueba("dueño: texto libre se le dice al cliente con palabras del bot y se confirma", async () => {
      await entra(DUENO, "mañana abrimos a las 9");
      await esperarQuieto();
      assert.ok(textosA(T3).some((t) => t.includes("mañana abrimos a las 9 am")));
      assert.match(textosA(DUENO).pop() ?? "", /Le envié a Prueba WA: «¡Hola! Te cuento/);
    });

    await prueba("dueño: un mensaje que termina en ? nunca se reenvía al cliente", async () => {
      const antes = textosA(T3).length;
      await entra(DUENO, "a cómo quedó el dólar hoy?");
      await esperarQuieto();
      assert.equal(textosA(T3).length, antes);
      assert.match(textosA(DUENO).pop() ?? "", /jefa/);
    });

    await prueba("dueño: 1 = lo atiende él (bot en pausa + wa.me), cola, siguiente y listo", async () => {
      await atencion.marcarNecesitaHumano(jid(T3), "quiere un monto grande");
      await esperarQuieto();
      await entra(DUENO, "1");
      await esperarQuieto();
      let chat = await chatDe(T3);
      assert.equal(chat.bot_activo, false);
      assert.equal(chat.necesita_humano, false);
      assert.match(textosA(DUENO).pop() ?? "", /wa\.me\/579900000020/);

      await entra(DUENO, "cola");
      await esperarQuieto();
      assert.match(textosA(DUENO).pop() ?? "", /Esperando por ti \(\d+\)|No hay nadie esperando/);

      await entra(DUENO, "listo");
      await esperarQuieto();
      chat = await chatDe(T3);
      assert.equal(chat.bot_activo, true);
      assert.match(textosA(DUENO).pop() ?? "", /vuelve al bot/);

      await entra(DUENO, "siguiente");
      await esperarQuieto();
      assert.match(textosA(DUENO).pop() ?? "", /necesita que lo atiendas|No queda nadie/);
      await entra(DUENO, "ayuda");
      await esperarQuieto();
      assert.match(textosA(DUENO).pop() ?? "", /\*cola\*/);
    });

    await prueba("dueño: 2 = sigue el bot y responde lo pendiente", async () => {
      const T = `${PREFIJO}021`;
      await entra(T, "necesito pagar en efectivo");
      await esperarQuieto();
      await entra(T, "sigo esperando, igual puedo transferir"); // llega con el bot en pausa
      await esperarQuieto();
      const antes = llamadasIa.length;
      await entra(DUENO, "2");
      await esperarQuieto();
      assert.ok((await msgsDe(T)).some((m) => m.interno && /El dueño devolvió el chat al bot/.test(m.texto)));
      assert.equal(llamadasIa.length > antes, true, "el bot no retomó la conversación");
    });

    // ================= Panel =================
    await prueba("si una persona escribe desde el panel, el bot se pausa en ese chat", async () => {
      const T = `${PREFIJO}030`;
      await entra(T, "hola");
      await esperarQuieto();
      await atencion.tomarControl(jid(T), "Asesor prueba");
      await envio.enviarMensaje({ jid: jid(T), autor: "humano", texto: "Hola, te atiendo yo" });
      const antes = llamadasIa.length;
      await entra(T, "gracias");
      await esperarQuieto();
      assert.equal(llamadasIa.length, antes);
      assert.equal((await chatDe(T)).bot_activo, false);
      await atencion.devolverAlBot(jid(T), "Asesor prueba");
      assert.equal((await chatDe(T)).bot_activo, true);
    });

    await prueba("si responden desde el teléfono del negocio, también toma el control", async () => {
      const T = `${PREFIJO}031`;
      await entra(T, "hola");
      await esperarQuieto();
      await entra(T, "te respondo desde el cel", { deMi: true });
      assert.equal((await chatDe(T)).bot_activo, false);
      assert.ok((await msgsDe(T)).some((m) => m.autor === "telefono"));
    });

    await prueba("búsqueda de chats por contenido de mensajes y filtros", async () => {
      const porTexto = await mensajes.listarChats("todos", "pagar en efectivo en la oficina");
      assert.ok(porTexto.some((c) => c.jid === jid(T3)));
      const atencionLista = await mensajes.listarChats("atencion", undefined);
      assert.ok(atencionLista.every((c) => c.necesitaHumano));
      const enChat = await mensajes.listarMensajes(jid(T2), { busqueda: "cotización" });
      assert.ok(enChat.mensajes.length >= 1);
    });

    await prueba("anti-bucle: si el bot responde demasiado en 5 min, se pausa en ese chat", async () => {
      const T = `${PREFIJO}040`;
      const c = await config.leerConfig();
      await config.guardarConfig({ ...c, antibloqueo: { ...c.antibloqueo, antiBucleMax: 3 } });
      for (let i = 0; i < 4; i++) {
        await entra(T, `mensaje ${i}`);
        await esperarQuieto();
      }
      const chat = await chatDe(T);
      assert.equal((await msgsDe(T)).filter((m) => m.autor === "bot").length, 3);
      assert.equal(chat.necesita_humano, true);
      assert.match(chat.motivo, /demasiadas veces/);
      await config.guardarConfig({ ...c, antibloqueo: { ...c.antibloqueo, antiBucleMax: 10 } });
    });

    await prueba("la IA nunca publica un número de cuenta de la empresa (se descarta el párrafo)", async () => {
      const T = `${PREFIJO}041`;
      guion.unshift({
        si: /dame la cuenta/i,
        hacer: async () => ({ texto: "Claro.\n\nTransfiere a Bancolombia 99988877766.", llamadas: [], modeloUsado: "falso" }),
      });
      await entra(T, "dame la cuenta");
      await esperarQuieto();
      const bots = (await msgsDe(T)).filter((m) => m.autor === "bot").map((m) => m.texto);
      assert.deepEqual(bots, ["Claro."]);
    });

    await prueba("tope diario de envíos: falla con un mensaje claro", async () => {
      const T = `${PREFIJO}042`;
      await entra(T, "hola", { tipo: "append" });
      const c = await config.leerConfig();
      await config.guardarConfig({ ...c, antibloqueo: { ...c.antibloqueo, porDia: 10 } });
      await assert.rejects(envio.enviarMensaje({ jid: jid(T), autor: "humano", texto: "hola" }), /tope diario/);
      const fila = (await msgsDe(T)).pop();
      assert.equal(fila.estado, "error");
      await config.guardarConfig({ ...c, antibloqueo: { ...c.antibloqueo, porDia: 5000 } });
    });

    // ================= Outbox y contactos fríos =================
    await prueba("outbox: contacto frío se verifica con onWhatsApp; tope de fríos -> espera que escriba y sale al instante", async () => {
      const F1 = `${PREFIJO}050`;
      const F2 = `${PREFIJO}051`;
      const NO = `${PREFIJO}999`;
      await outbox.encolarOutbox({ telefono: NO, texto: "Hola, tu recibo #3 ya está listo." });
      await outbox.encolarOutbox({ telefono: F1, texto: "Hola, tu recibo #1 ya está listo." });
      await outbox.encolarOutbox({ telefono: F2, texto: "Hola, tu recibo #2 ya está listo." });
      const outboxQuieto = async () => {
        for (let i = 0; i < 200; i++) {
          const r = await pool.query(`SELECT count(*)::int AS n FROM wa_outbox WHERE estado = 'ENVIANDO' AND jid LIKE '${PREFIJO}%'`);
          if (r.rows[0].n === 0) return;
          await dormir(100);
        }
      };
      for (let i = 0; i < 3; i++) {
        await outboxQuieto();
        await pool.query(`UPDATE wa_outbox SET proximo_intento = now() WHERE estado = 'EN_COLA' AND jid LIKE '${PREFIJO}%'`);
        await outbox.trabajarOutbox();
        await esperarQuieto();
      }
      await outboxQuieto();
      const estado = async (tel: string) => (await pool.query(`SELECT estado, error, frio FROM wa_outbox WHERE jid = $1`, [jid(tel)])).rows[0];
      const e1 = await estado(F1);
      const e2 = await estado(F2);
      const e3 = await estado(NO);
      const enviadoUno = [e1, e2].filter((e) => e.estado === "ENVIADO");
      const esperando = [e1, e2].filter((e) => e.estado === "ESPERA_CLIENTE");
      assert.equal(enviadoUno.length, 1, JSON.stringify([e1, e2]));
      assert.equal(enviadoUno[0].frio, true);
      assert.equal(esperando.length, 1, JSON.stringify([e1, e2]));
      assert.equal(e3.estado, "ERROR");
      assert.match(e3.error, /no tiene WhatsApp/);

      const telEspera = e1.estado === "ESPERA_CLIENTE" ? F1 : F2;
      await entra(telEspera, "hola, recibí algo?");
      await dormir(9_000);
      await outboxQuieto();
      await esperarQuieto();
      assert.equal((await estado(telEspera)).estado, "ENVIADO");
      assert.equal((await estado(telEspera)).frio, false);
    });

    await prueba("\"Recibir por WhatsApp\": el código VC-<id> une la operación al chat y encola el recibo", async () => {
      const T = `${PREFIJO}060`;
      const tx = (await pool.query(`SELECT id FROM transacciones WHERE id = $1`, [txId])).rows[0];
      const enlace = await outbox.enlaceRecibirPorWhatsapp(tx.id);
      assert.match(enlace.url, new RegExp(`wa\\.me/${BOT}\\?text=.*VC-${tx.id}`));
      await entra(T, `Hola, quiero recibir el comprobante de mi operación VC-${tx.id}`);
      const chat = await chatDe(T);
      assert.ok(chat.tercero_id, "no se unió el cliente al chat");
      const item = (await pool.query(`SELECT * FROM wa_outbox WHERE origen = $1`, [`transaccion:${tx.id}:recibo`])).rows[0];
      assert.ok(item);
      await esperarQuieto();
    });

    // ================= Simulador =================
    await prueba("simulador: conversa y usa herramientas sin escribir en la base ni enviar nada", async () => {
      const cuenta = async () =>
        (await pool.query(`SELECT (SELECT count(*) FROM terceros) + (SELECT count(*) FROM transacciones) + (SELECT count(*) FROM wa_mensajes) + (SELECT count(*) FROM cuentas_tercero) AS n`)).rows[0].n;
      const antesN = await cuenta();
      const antesEnv = enviados.length;
      const r1 = await bot.simular({ historial: [{ rol: "cliente", texto: "hola, quiero vender 100 dolares" }] });
      assert.equal(r1.herramientas[0]?.nombre, "cotizar");
      assert.match(r1.sistema[0] ?? "", /Recibes: \$380\.000 COP/);
      const r2 = await bot.simular({
        historial: [
          { rol: "cliente", texto: "hola, quiero vender 100 dolares" },
          { rol: "sistema", texto: r1.sistema[0]! },
          { rol: "bot", texto: r1.respuestas.join("\n") },
          { rol: "cliente", texto: "sí, me llamo Juan Prueba, cc 1, nequi 3001234567" },
        ],
        estado: r1.estado,
        registrado: true,
      });
      assert.deepEqual(
        r2.herramientas.map((h) => h.nombre),
        ["registrar_cliente", "crear_solicitud"]
      );
      assert.deepEqual(r2.derivaciones, []);
      assert.ok(r2.efectos.some((e) => e.includes("Crearía la solicitud")));
      assert.match(r2.sistema[0] ?? "", /Transfiere exactamente/);
      assert.equal(await cuenta(), antesN, "el simulador escribió en la base");
      assert.equal(enviados.length, antesEnv, "el simulador envió mensajes");
    });

    await prueba("ruta de modelos en vivo y 429: espera lo indicado y pasa al modelo de respaldo", async () => {
      ia.usarIaSimulada(null);
      const originalFetch = globalThis.fetch;
      const modelosPedidos: string[] = [];
      let llamadas = 0;
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        const cuerpo = JSON.parse(String(init?.body ?? "{}"));
        modelosPedidos.push(cuerpo.model);
        llamadas++;
        if (cuerpo.model === "principal") {
          return new Response(JSON.stringify({ error: { message: "Rate limit. Please retry in 0.05s" } }), { status: 429 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "hola desde respaldo" } }] }), { status: 200 });
      }) as typeof fetch;
      try {
        const r = await ia.ejecutarTurno({
          proveedor: "groq",
          clave: "gsk_x",
          modelo: "principal",
          modelosRespaldo: ["respaldo"],
          sistema: "s",
          historial: [{ rol: "user", texto: "hola" }],
          herramientas: [],
          ejecutar: async () => "{}",
        });
        assert.equal(r.texto, "hola desde respaldo");
        assert.equal(r.modeloUsado, "respaldo");
        assert.deepEqual(modelosPedidos, ["principal", "principal", "principal", "respaldo"]);
        assert.equal(llamadas, 4);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  } finally {
    // ---------- Limpieza ----------
    console.log("\nLimpiando datos de prueba…");
    ia.usarIaSimulada(null);
    trabajadores.detenerTrabajadores();
    const like = `${PREFIJO}%`;
    const medias = (await pool.query(`SELECT media_key, media_mime FROM wa_mensajes WHERE jid LIKE $1 AND media_key IS NOT NULL`, [like])).rows;
    const terceros = (await pool.query(`SELECT id FROM terceros WHERE telefono LIKE $1 OR nombre LIKE '%Prueba WA%'`, [like])).rows.map((r) => r.id);
    const txs = (
      await pool.query(`SELECT id, referencia_id FROM transacciones WHERE wa_jid LIKE $1 OR tercero_id = ANY($2::int[]) OR caja_id IN ($3, $4)`, [
        like,
        terceros,
        cajaUsd,
        cajaCop,
      ])
    ).rows;
    await pool.query(`DELETE FROM documentos_tercero WHERE transaccion_id = ANY($1::int[]) OR tercero_id = ANY($2::int[])`, [
      txs.map((t) => t.id),
      terceros,
    ]);
    await pool.query(`DELETE FROM transacciones WHERE id = ANY($1::int[])`, [txs.map((t) => t.id)]);
    await pool.query(`DELETE FROM referencias WHERE id = ANY($1::int[]) OR codigo LIKE 'PRUEBAWA%'`, [txs.map((t) => t.referencia_id).filter(Boolean)]);
    await pool.query(`DELETE FROM cuentas_tercero WHERE tercero_id = ANY($1::int[])`, [terceros]);
    await pool.query(`DELETE FROM wa_outbox WHERE jid LIKE $1`, [like]);
    await pool.query(`DELETE FROM wa_mensajes WHERE jid LIKE $1`, [like]);
    await pool.query(`DELETE FROM wa_chats WHERE jid LIKE $1`, [like]);
    await pool.query(`DELETE FROM terceros WHERE id = ANY($1::int[])`, [terceros]);
    await pool.query(`DELETE FROM cotizaciones_detalle WHERE etiqueta = 'PRUEBA-WA'`);
    await pool.query(`DELETE FROM cajas WHERE id IN ($1, $2)`, [cajaUsd, cajaCop]);
    await pool.query(`UPDATE wa_config SET datos = $1, estado_dueno = $2 WHERE id = 1`, [respaldo.datos, respaldo.estado_dueno]);
    for (const m of medias) await almacenamiento.eliminarArchivo(m.media_key, m.media_mime).catch(() => {});
    const quedan = (
      await pool.query(
        `SELECT (SELECT count(*) FROM wa_chats WHERE jid LIKE $1) + (SELECT count(*) FROM terceros WHERE nombre LIKE '%Prueba WA%') + (SELECT count(*) FROM cajas WHERE nombre LIKE 'PRUEBA-WA%') AS n`,
        [like]
      )
    ).rows[0].n;
    console.log(`Limpieza completa (restos: ${quedan}, archivos borrados en Cloudinary: ${medias.length}).`);
    await pool.end();
  }

  const fallidas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - fallidas.length}/${resultados.length} pruebas OK`);
  process.exit(fallidas.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
