import { pool } from "../db/pool";

/**
 * Atención de Solicitudes: cada mensaje que entra por un chat individual se clasifica según lo que más piden los
 * clientes (estudio de las conversaciones de octubre de 2026) y queda en la bandeja para que alguien lo atienda:
 *   TASA (preguntan a cómo está), CUENTA (piden la cuenta para transferir), COMPROBANTE (mandan la captura),
 *   PAGO (mandan los datos de una cuenta y un monto para que les paguemos), CONFIRMAR (preguntan si ya se confirmó),
 *   RETIRO (van a retirar, giros Western, horario), COMPRA (quieren cambiar o comprar).
 * Varios mensajes seguidos de lo mismo se juntan en una sola solicitud. Lo que responde el negocio en el chat cierra
 * las que se resuelven con una respuesta (tasa, cuenta, confirmar, retiro, compra).
 */
export type TipoSolicitud = "TASA" | "CUENTA" | "COMPROBANTE" | "PAGO" | "CONFIRMAR" | "RETIRO" | "COMPRA";

const sinTildes = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** ¿Qué pide este mensaje? null si no es una solicitud (saludo, gracias, conversación). */
export function clasificarMensaje(tipo: string, texto: string | null): TipoSolicitud | null {
  if (tipo === "imagen" || tipo === "documento") return "COMPROBANTE";
  if (tipo !== "texto" || !texto) return null;
  const t = sinTildes(texto);
  if (t.trim().length < 3) return null;
  const digitosLargos = /\d{10,}|\d{4}[\s-]\d{3,}[\s-]\d{3,}/.test(t.replace(/[.,]/g, ""));
  const datosDeCuenta = /ahorro|corriente|cedula|\bc\.?c\b|\bv-?\d{6,}|titular|tipo de cuenta|numero de cuenta|\bcta\b/.test(t);
  const banco = /nequi|bancolombia|daviplata|banco de venezuela|banesco|mercantil|provincial|\bbnc\b|bicentenario|pago movil|\b0102\b|\b0134\b|\b0105\b|\b0108\b/.test(t);
  // mandan los datos de una cuenta (número largo + banco o tipo de cuenta): hay que pagarles ahí
  if (digitosLargos && (datosDeCuenta || banco)) return "PAGO";
  if (
    /me (pasa|pasas|regala|regalas|envia|envias|das|da|puede[s]? (pasar|enviar|dar|regalar)|confirma[s]?) (la |el |los |una )?(cuenta|numero|datos|nequi|bancolombia)|a (que|cual) cuenta|datos (para|del|de la) (pago|transfer|consign|cuenta)|(cuenta|numero|datos) (para|pa) (transferir|enviar|pagar|consignar|el pago)|pago movil/.test(
      t
    )
  )
    return "CUENTA";
  if (
    /confirm|avis(a|e|ame|en)\b|ya (te |le |les )?(envi|mand|transfer|hice|pague|consigne)|ya esta (list|hech)|(comprobante|capture|captura) (por favor|porfa|xfa)|me (envia|regala|manda|pasa)s? (el |la )?(comprobante|capture|captura)/.test(
      t
    )
  )
    return "CONFIRMAR";
  if (/tasa|a como|a cuanto|cuanto (esta|va|dan|pagan|me da|sale|seria|me sale|recibe)|precio|cambio (de|en|hoy|del|para)|como (esta|amanecio|va) (el )?(cambio|dolar|bolivar)|comprando|recibiendo|vendiendo|cotiz|cuant[oa]s? (pesos|dolares|bs|bolivares|usdt) (me )?(das|dan|son|serian|seria|salen|me sale)|cuanto (seria|son|es|me sale) en/.test(t)) return "TASA";
  if (/retir|recoger|cobrar (un |el )?giro|western|mtcn|puedo pasar|paso (por|a|ya)|voy (para|a recoger|a retirar)|estan abiertos|hasta que hora|horario|laboran|trabajan (hoy|manana|el)|abren|atienden/.test(t)) return "RETIRO";
  if (/(quiero|necesito|tengo|quisiera|me interesa).{0,40}(cambiar|comprar|vender|enviar|transferir|bolivar|dolar|pesos|usdt|zelle|euro)|para (comprar|cambiar|enviar|transferir)\b|^(para|son|serian) \d[\d.,]*\s*(\$|mil|usd|bs|dolares|pesos|usdt)/.test(t)) return "COMPRA";
  return null;
}

/** Lo que se puede sacar del texto: monto, moneda y medio. */
export function datosDeMensaje(texto: string | null) {
  if (!texto) return {};
  const t = sinTildes(texto);
  const medio = /nequi/.test(t)
    ? "Nequi"
    : /bancolombia/.test(t)
      ? "Bancolombia"
      : /zelle/.test(t)
        ? "Zelle"
        : /usdt|binance/.test(t)
          ? "USDT"
          : /western|giro/.test(t)
            ? "Western"
            : /pago movil|venezuela|banesco|mercantil|provincial|\bbs\b|bolivar/.test(t)
              ? "Bolívares"
              : null;
  const moneda = /\bbs\b|bss|bolivar|\bves\b/.test(t) ? "VES" : /usdt/.test(t) ? "USDT" : /usd|dolar/.test(t) ? "USD" : /\bcop\b|pesos|\bmil\b/.test(t) ? "COP" : null;
  // el monto: un número con miles (250.000) o junto a su moneda; no un teléfono ni una cuenta
  const candidatos = t.match(/(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(mil|cop|bs|usd|\$|dolares|pesos|usdt)?/g) ?? [];
  const monto = candidatos.map((x) => x.trim()).find((x) => (/[.,]\d{3}/.test(x) && !/^\d{9,}$/.test(x.replace(/[.,\s]/g, ""))) || /\d\s*(mil|cop|bs|usd|\$|dolares|pesos|usdt)$/.test(x));
  return { ...(medio ? { medio } : {}), ...(moneda ? { moneda } : {}), ...(monto ? { monto } : {}) };
}

/** Entra un mensaje (o sale uno del negocio): se anota, se junta con la que ya estaba o se cierra. */
export async function anotarSolicitud(m: { jid: string; linea: number; deMi: boolean; tipo: string; texto: string | null; mensajeId: number; fecha?: Date }) {
  if (m.jid.includes("@g.us")) return; // los grupos no entran a la bandeja
  if (m.deMi) {
    // el negocio respondió en el chat: lo que se resuelve con una respuesta queda atendido
    await pool.query(
      `UPDATE solicitudes_wa SET estado = 'ATENDIDA', atendida_en = COALESCE($2, now()), nota = COALESCE(nota, 'Respondida en el chat'), updated_at = now()
       WHERE jid = $1 AND estado = 'PENDIENTE' AND tipo IN ('TASA', 'CUENTA', 'CONFIRMAR', 'RETIRO', 'COMPRA') AND updated_at <= COALESCE($2, now())`,
      [m.jid, m.fecha ?? null]
    );
    // el comprobante queda atendido cuando se le confirma ("la operación ha sido confirmada", "recibido", "listo");
    // el pago, cuando se le manda la captura o se le dice que ya se hizo
    const t = sinTildes(m.texto ?? "");
    const cierraComprobante = /confirmad|recibid|registrad|listo|ya qued|ya esta|llego|en proceso/.test(t);
    const cierraPago = m.tipo === "imagen" || /pagad|enviad|transferid|listo|hecho|ya se (le )?(envio|pago|hizo)|realizad/.test(t);
    const tipos = [cierraComprobante ? "COMPROBANTE" : null, cierraPago ? "PAGO" : null].filter(Boolean);
    if (tipos.length)
      await pool.query(
        `UPDATE solicitudes_wa SET estado = 'ATENDIDA', atendida_en = COALESCE($2, now()), nota = COALESCE(nota, 'Respondida en el chat'), updated_at = now()
         WHERE jid = $1 AND estado = 'PENDIENTE' AND tipo = ANY($3::text[]) AND updated_at <= COALESCE($2, now())`,
        [m.jid, m.fecha ?? null, tipos]
      );
    return;
  }
  const tipo = clasificarMensaje(m.tipo, m.texto);
  if (!tipo) return;
  const datos = datosDeMensaje(m.texto);
  const texto = (m.texto ?? "").trim().slice(0, 600) || (m.tipo === "imagen" ? "📷 Imagen" : "📄 Documento");
  // la que ya estaba pendiente del mismo tipo en este chat se actualiza (varios mensajes de lo mismo = una solicitud)
  const ya = await pool.query(
    `UPDATE solicitudes_wa SET texto = $3, datos = datos || $4::jsonb, mensaje_id = $5, mensajes = mensajes + 1, updated_at = COALESCE($6, now())
     WHERE id = (SELECT id FROM solicitudes_wa WHERE jid = $1 AND tipo = $2 AND estado = 'PENDIENTE' ORDER BY id DESC LIMIT 1) RETURNING id`,
    [m.jid, tipo, texto, JSON.stringify(datos), m.mensajeId, m.fecha ?? null]
  );
  if (ya.rows[0]) return;
  await pool.query(
    `INSERT INTO solicitudes_wa (jid, linea, tipo, texto, datos, mensaje_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), COALESCE($7, now()))`,
    [m.jid, m.linea, tipo, texto, JSON.stringify(datos), m.mensajeId, m.fecha ?? null]
  );
}

/** La bandeja: las pendientes (de la más vieja a la más nueva) o las atendidas de hoy. */
export async function listarSolicitudes(estado: "PENDIENTE" | "ATENDIDA") {
  const r = await pool.query(
    `SELECT s.*, c.nombre, c.nombre_guardado, c.telefono, c.tercero_id, t.nombre AS cliente, u.nombre AS atendida_por_nombre
     FROM solicitudes_wa s
     LEFT JOIN wa_chats c ON c.jid = s.jid
     LEFT JOIN terceros t ON t.id = c.tercero_id
     LEFT JOIN usuarios u ON u.id = s.atendida_por
     WHERE s.estado = $1 ${estado === "ATENDIDA" ? "AND (s.atendida_en AT TIME ZONE 'America/Bogota')::date = (now() AT TIME ZONE 'America/Bogota')::date" : ""}
     ORDER BY ${estado === "PENDIENTE" ? "s.created_at ASC" : "s.atendida_en DESC"} LIMIT 300`,
    [estado]
  );
  return r.rows;
}

export async function atenderSolicitud(id: number, usuarioId: number, nota?: string, descartar = false) {
  const r = await pool.query(
    `UPDATE solicitudes_wa SET estado = $2, atendida_por = $3, atendida_en = now(), nota = COALESCE($4, nota), updated_at = now() WHERE id = $1 RETURNING id, estado`,
    [id, descartar ? "DESCARTADA" : "ATENDIDA", usuarioId, nota?.trim() || null]
  );
  if (!r.rows[0]) throw Object.assign(new Error("Solicitud no encontrada"), { status: 404 });
  return r.rows[0];
}

/** Cuántas hay pendientes, por tipo (para los números de las pestañas). */
export async function contarSolicitudes() {
  const r = await pool.query(`SELECT tipo, count(*)::int n FROM solicitudes_wa WHERE estado = 'PENDIENTE' GROUP BY 1`);
  return Object.fromEntries(r.rows.map((x) => [x.tipo, x.n])) as Record<string, number>;
}
