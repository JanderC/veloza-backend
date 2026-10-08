import { pool } from "../../db/pool";

// Respuestas rápidas del panel de WhatsApp: textos ya escritos (con un título para encontrarlos) que quien atiende
// pone en el mensaje con un toque. Nunca se envían solas: se cargan en la casilla y la persona decide.
export interface RespuestaRapida {
  id: number;
  titulo: string;
  texto: string;
  orden: number;
}

const COLUMNAS = `id, titulo, texto, orden`;

export async function listarRespuestasRapidas(): Promise<RespuestaRapida[]> {
  return (await pool.query(`SELECT ${COLUMNAS} FROM wa_respuestas_rapidas ORDER BY orden, id`)).rows;
}

export async function crearRespuestaRapida(datos: { titulo: string; texto: string }, usuarioId: number): Promise<RespuestaRapida> {
  const r = await pool.query(
    `INSERT INTO wa_respuestas_rapidas (titulo, texto, orden, creado_por)
     VALUES ($1, $2, (SELECT COALESCE(max(orden), 0) + 1 FROM wa_respuestas_rapidas), $3) RETURNING ${COLUMNAS}`,
    [datos.titulo, datos.texto, usuarioId]
  );
  return r.rows[0];
}

export async function actualizarRespuestaRapida(id: number, datos: { titulo: string; texto: string }): Promise<RespuestaRapida> {
  const r = await pool.query(`UPDATE wa_respuestas_rapidas SET titulo = $2, texto = $3, actualizado_en = now() WHERE id = $1 RETURNING ${COLUMNAS}`, [id, datos.titulo, datos.texto]);
  if (!r.rows[0]) throw Object.assign(new Error("Esa respuesta rápida ya no existe"), { status: 404 });
  return r.rows[0];
}

export async function eliminarRespuestaRapida(id: number): Promise<void> {
  await pool.query(`DELETE FROM wa_respuestas_rapidas WHERE id = $1`, [id]);
}

/** Deja las respuestas en el orden recibido (los ids que no vengan quedan al final, como estaban). */
export async function ordenarRespuestasRapidas(ids: number[]): Promise<RespuestaRapida[]> {
  await pool.query(
    `UPDATE wa_respuestas_rapidas r SET orden = o.n
     FROM unnest($1::int[]) WITH ORDINALITY AS o(id, n) WHERE r.id = o.id`,
    [ids]
  );
  await pool.query(`UPDATE wa_respuestas_rapidas SET orden = orden + $2 WHERE NOT (id = ANY($1::int[]))`, [ids, ids.length]);
  return listarRespuestasRapidas();
}
