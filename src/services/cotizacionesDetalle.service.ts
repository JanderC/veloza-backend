import { pool } from "../db/pool";

interface RegistrarLineaInput {
  monedaId: number;
  tipo: "COMPRA" | "VENTA";
  etiqueta: string;
  valor?: string;
  ajustePct?: string;
  usuarioId: number;
}

export async function registrarLineaCotizacion(input: RegistrarLineaInput) {
  if ((input.valor && input.ajustePct) || (!input.valor && !input.ajustePct)) {
    throw Object.assign(new Error("Debe indicar exactamente uno: valor fijo O porcentaje de ajuste"), { status: 400 });
  }

  const result = await pool.query(
    `INSERT INTO cotizaciones_detalle (moneda_id, tipo, etiqueta, valor, ajuste_pct, creado_por_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.monedaId, input.tipo, input.etiqueta, input.valor ?? null, input.ajustePct ?? null, input.usuarioId]
  );
  return result.rows[0];
}

/** La cotización vigente = la fila más reciente por cada combinación moneda+tipo+etiqueta. */
export async function obtenerCotizacionesVigentes() {
  const result = await pool.query(`
    SELECT DISTINCT ON (cd.moneda_id, cd.tipo, cd.etiqueta)
      cd.*, m.codigo AS moneda_codigo
    FROM cotizaciones_detalle cd
    JOIN monedas m ON m.id = cd.moneda_id
    ORDER BY cd.moneda_id, cd.tipo, cd.etiqueta, cd.vigente_desde DESC
  `);
  return result.rows;
}

export async function obtenerHistorialCotizacion(monedaId: number, tipo: string, etiqueta: string) {
  const result = await pool.query(
    `SELECT * FROM cotizaciones_detalle
     WHERE moneda_id = $1 AND tipo = $2 AND etiqueta = $3
     ORDER BY vigente_desde DESC LIMIT 30`,
    [monedaId, tipo, etiqueta]
  );
  return result.rows;
}