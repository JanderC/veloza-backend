import { randomUUID } from "crypto";
import { pool } from "../db/pool";
import { subirArchivo, eliminarArchivo, generarUrlTemporal } from "./almacenamiento.service";

export type TipoDocumento = "CEDULA" | "RIF" | "PASAPORTE" | "COMPROBANTE_DOMICILIO" | "ORIGEN_FONDOS" | "OTRO";

export const MIME_PERMITIDOS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

// Documentos que identifican al cliente: con uno aprobado y vigente queda VERIFICADO
const DOCUMENTOS_IDENTIDAD: TipoDocumento[] = ["CEDULA", "PASAPORTE", "RIF"];

const SEGUNDOS_URL_TEMPORAL = 300;

// Columnas que se devuelven al front. fecha_vencimiento como texto AAAA-MM-DD:
// si pg la convierte a Date, la zona horaria la corre al día anterior en el front.
const COLUMNAS_DOCUMENTO = `id, tercero_id, transaccion_id, tipo, descripcion, nombre_original, mime_type, tamano_bytes,
  to_char(fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento, estado, motivo_rechazo, revisado_por_id,
  revisado_en, subido_por_id, created_at`;

interface SubirDocumentoInput {
  terceroId: number;
  tipo: TipoDocumento;
  descripcion?: string;
  fechaVencimiento?: string;
  transaccionId?: number;
  archivo: { buffer: Buffer; mimetype: string; originalname: string; size: number };
  usuarioId: number;
}

export async function subirDocumento(input: SubirDocumentoInput) {
  const extension = MIME_PERMITIDOS[input.archivo.mimetype];
  if (!extension) {
    throw Object.assign(new Error("Formato no permitido: solo JPG, PNG, WEBP o PDF"), { status: 400 });
  }

  const terceroResult = await pool.query(`SELECT id FROM terceros WHERE id = $1`, [input.terceroId]);
  if (terceroResult.rows.length === 0) throw Object.assign(new Error("Tercero no encontrado"), { status: 404 });

  if (input.transaccionId !== undefined) {
    const txResult = await pool.query(`SELECT tercero_id FROM transacciones WHERE id = $1`, [input.transaccionId]);
    const tx = txResult.rows[0];
    if (!tx) throw Object.assign(new Error("Transacción no encontrada"), { status: 404 });
    if (tx.tercero_id !== input.terceroId) {
      throw Object.assign(new Error("Esa transacción no pertenece a este cliente"), { status: 400 });
    }
  }

  // Primero el archivo, después la fila. Si el INSERT falla se intenta borrar el archivo huérfano.
  const archivoKey = await subirArchivo(
    `terceros/${input.terceroId}`,
    randomUUID(),
    input.archivo.buffer,
    input.archivo.mimetype
  );

  try {
    const result = await pool.query(
      `INSERT INTO documentos_tercero
        (tercero_id, transaccion_id, tipo, descripcion, archivo_key, nombre_original, mime_type, tamano_bytes,
         fecha_vencimiento, subido_por_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${COLUMNAS_DOCUMENTO}`,
      [
        input.terceroId,
        input.transaccionId ?? null,
        input.tipo,
        input.descripcion ?? null,
        archivoKey,
        input.archivo.originalname,
        input.archivo.mimetype,
        input.archivo.size,
        input.fechaVencimiento ?? null,
        input.usuarioId,
      ]
    );
    return result.rows[0];
  } catch (err) {
    await eliminarArchivo(archivoKey, input.archivo.mimetype).catch((e) => console.error("No se pudo borrar archivo huérfano", archivoKey, e));
    throw err;
  }
}

export async function listarDocumentosTercero(terceroId: number) {
  const result = await pool.query(
    `SELECT d.id, d.tercero_id, d.transaccion_id, d.tipo, d.descripcion, d.nombre_original, d.mime_type,
            d.tamano_bytes, to_char(d.fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento, d.estado, d.motivo_rechazo, d.revisado_en, d.created_at,
            (d.fecha_vencimiento IS NOT NULL AND d.fecha_vencimiento < current_date) AS vencido,
            us.nombre AS subido_por_nombre, ur.nombre AS revisado_por_nombre
     FROM documentos_tercero d
     JOIN usuarios us ON us.id = d.subido_por_id
     LEFT JOIN usuarios ur ON ur.id = d.revisado_por_id
     WHERE d.tercero_id = $1
     ORDER BY d.created_at DESC`,
    [terceroId]
  );
  return result.rows;
}

export async function obtenerUrlDocumento(documentoId: number) {
  const result = await pool.query(`SELECT archivo_key, nombre_original, mime_type FROM documentos_tercero WHERE id = $1`, [
    documentoId,
  ]);
  const doc = result.rows[0];
  if (!doc) throw Object.assign(new Error("Documento no encontrado"), { status: 404 });

  const url = generarUrlTemporal(doc.archivo_key, doc.mime_type, SEGUNDOS_URL_TEMPORAL);
  return { url, mimeType: doc.mime_type, expiraEnSegundos: SEGUNDOS_URL_TEMPORAL };
}

interface RevisarDocumentoInput {
  documentoId: number;
  estado: "APROBADO" | "RECHAZADO";
  motivo?: string;
  usuarioId: number;
}

/** Aprueba o rechaza. Quien subió el documento no puede revisarlo (mismo criterio que confirmar transacciones). */
export async function revisarDocumento(input: RevisarDocumentoInput) {
  if (input.estado === "RECHAZADO" && !input.motivo?.trim()) {
    throw Object.assign(new Error("Indicá el motivo del rechazo"), { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const docResult = await client.query(`SELECT * FROM documentos_tercero WHERE id = $1 FOR UPDATE`, [input.documentoId]);
    const doc = docResult.rows[0];
    if (!doc) throw Object.assign(new Error("Documento no encontrado"), { status: 404 });
    if (doc.estado !== "PENDIENTE") throw Object.assign(new Error("Este documento ya fue revisado"), { status: 409 });
    if (doc.subido_por_id === input.usuarioId) {
      throw Object.assign(new Error("Quien subió el documento no puede revisarlo"), { status: 403 });
    }

    const result = await client.query(
      `UPDATE documentos_tercero
       SET estado = $1, motivo_rechazo = $2, revisado_por_id = $3, revisado_en = now()
       WHERE id = $4
       RETURNING ${COLUMNAS_DOCUMENTO}`,
      [input.estado, input.estado === "RECHAZADO" ? input.motivo : null, input.usuarioId, input.documentoId]
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type EstadoVerificacion = "VERIFICADO" | "PENDIENTE_REVISION" | "NO_VERIFICADO" | "SIN_DOCUMENTOS";

export interface ResumenVerificacion {
  estado: EstadoVerificacion;
  aprobados: number;
  pendientes: number;
  rechazados: number;
  vencidos: number;
  tiposAprobados: string[];
}

/**
 * VERIFICADO: tiene al menos una CEDULA/PASAPORTE/RIF aprobada y no vencida.
 * PENDIENTE_REVISION: no está verificado pero tiene documentos esperando revisión.
 * NO_VERIFICADO: tiene documentos, pero ninguno de identidad aprobado y vigente.
 * SIN_DOCUMENTOS: nunca se le cargó nada.
 * Es informativo: NO bloquea operaciones.
 */
export async function obtenerVerificacionTercero(terceroId: number): Promise<ResumenVerificacion> {
  const result = await pool.query(
    `SELECT tipo, estado, (fecha_vencimiento IS NOT NULL AND fecha_vencimiento < current_date) AS vencido
     FROM documentos_tercero WHERE tercero_id = $1`,
    [terceroId]
  );
  const docs: { tipo: TipoDocumento; estado: string; vencido: boolean }[] = result.rows;

  const aprobadosVigentes = docs.filter((d) => d.estado === "APROBADO" && !d.vencido);
  const pendientes = docs.filter((d) => d.estado === "PENDIENTE").length;
  const identidadOk = aprobadosVigentes.some((d) => DOCUMENTOS_IDENTIDAD.includes(d.tipo));

  let estado: EstadoVerificacion;
  if (docs.length === 0) estado = "SIN_DOCUMENTOS";
  else if (identidadOk) estado = "VERIFICADO";
  else if (pendientes > 0) estado = "PENDIENTE_REVISION";
  else estado = "NO_VERIFICADO";

  return {
    estado,
    aprobados: aprobadosVigentes.length,
    pendientes,
    rechazados: docs.filter((d) => d.estado === "RECHAZADO").length,
    vencidos: docs.filter((d) => d.estado === "APROBADO" && d.vencido).length,
    tiposAprobados: [...new Set(aprobadosVigentes.map((d) => d.tipo))],
  };
}
