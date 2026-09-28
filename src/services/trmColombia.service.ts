import { pool } from "../db/pool";

interface TrmApiResponse {
  valor: number;
  nombre: string;
  unidad: string;
  fechaActualizacion: string;
}

export interface TrmHistoricoDia {
  fecha: string;
  valor: number;
}

export interface TrmColombiaData {
  actual: { valor: number; fechaActualizacion: string } | null;
  historico: TrmHistoricoDia[];
  variacionDiaAnteriorPct: number | null;
  variacion7dPct: number | null;
  variacion30dPct: number | null;
}

let cache: { datos: TrmColombiaData; expiraEn: number } | null = null;
const TTL_MS = 5 * 60_000; // 5 min

function variacionPct(actual: number | null, anterior: number | null): number | null {
  if (actual == null || anterior == null || anterior === 0) return null;
  return ((actual - anterior) / anterior) * 100;
}

async function obtenerTrmDesdeApi(): Promise<TrmApiResponse | null> {
  try {
    const res = await fetch("https://co.dolarapi.com/v1/trm");
    if (!res.ok) return null;
    return (await res.json()) as TrmApiResponse;
  } catch (err) {
    console.error("Error consultando co.dolarapi.com:", err);
    return null;
  }
}

export async function obtenerTrmColombia(): Promise<TrmColombiaData> {
  if (cache && cache.expiraEn > Date.now()) return cache.datos;

  const actual = await obtenerTrmDesdeApi();

  // Guardamos (o actualizamos) el snapshot de HOY -- así construimos
  // nuestro propio histórico día a día, sin depender de un tercero.
  if (actual) {
    const hoy = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO trm_colombia_historico (fecha, valor)
       VALUES ($1, $2)
       ON CONFLICT (fecha) DO UPDATE SET valor = $2`,
      [hoy, actual.valor]
    );
  }

  const historicoResult = await pool.query(
    `SELECT fecha, valor FROM trm_colombia_historico ORDER BY fecha ASC LIMIT 90`
  );
  const historico: TrmHistoricoDia[] = historicoResult.rows.map((r) => ({
    fecha: r.fecha.toISOString().slice(0, 10),
    valor: Number(r.valor),
  }));

  const valorActual = actual?.valor ?? historico[historico.length - 1]?.valor ?? null;
  const indiceHoy = historico.length - 1;
  const anterior = indiceHoy >= 1 ? historico[indiceHoy - 1] : null;
  const hace7 = indiceHoy - 7 >= 0 ? historico[indiceHoy - 7] : null;
  const hace30 = indiceHoy - 30 >= 0 ? historico[indiceHoy - 30] : null;

  const datos: TrmColombiaData = {
    actual: actual ? { valor: actual.valor, fechaActualizacion: actual.fechaActualizacion } : null,
    historico,
    variacionDiaAnteriorPct: variacionPct(valorActual, anterior?.valor ?? null),
    variacion7dPct: variacionPct(valorActual, hace7?.valor ?? null),
    variacion30dPct: variacionPct(valorActual, hace30?.valor ?? null),
  };

  cache = { datos, expiraEn: Date.now() + TTL_MS };
  return datos;
}