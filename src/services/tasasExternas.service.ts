interface TasaExterna {
  origen: "DolarApi" | "MontosVE";
  fuente: string;
  moneda: string;
  compra: number | null;
  venta: number | null;
  promedio: number | null;
  fechaActualizacion: string | null;
}

// Cache simple en memoria -- evita golpear las APIs externas en cada
// poll del frontend. 60s alcanza para "tiempo real" a efectos prácticos.
let cache: { datos: TasaExterna[]; expiraEn: number } | null = null;
const TTL_MS = 60_000;

interface DolarApiItem {
  fuente?: string;
  nombre?: string;
  compra?: number;
  venta?: number;
  promedio?: number;
  fechaActualizacion?: string;
}

async function obtenerDolarApi(): Promise<TasaExterna[]> {
  const base = process.env.DOLARAPI_BASE_URL ?? "https://ve.dolarapi.com";
  try {
    const [dolaresRes, eurosRes] = await Promise.all([fetch(`${base}/v1/dolares`), fetch(`${base}/v1/euros`)]);

    const dolares = dolaresRes.ok ? ((await dolaresRes.json()) as DolarApiItem[]) : [];
    const euros = eurosRes.ok ? ((await eurosRes.json()) as DolarApiItem[]) : [];

    const mapear = (arr: DolarApiItem[], moneda: string): TasaExterna[] =>
      Array.isArray(arr)
        ? arr.map((d) => ({
            origen: "DolarApi" as const,
            fuente: d.fuente ?? d.nombre ?? "Desconocida",
            moneda,
            compra: typeof d.compra === "number" ? d.compra : null,
            venta: typeof d.venta === "number" ? d.venta : null,
            promedio: typeof d.promedio === "number" ? d.promedio : null,
            fechaActualizacion: d.fechaActualizacion ?? null,
          }))
        : [];

    return [...mapear(dolares, "USD"), ...mapear(euros, "EUR")];
  } catch (err) {
    console.error("Error consultando DolarApi:", err);
    return [];
  }
}

interface MontosVeItem {
  source?: string;
  fuente?: string;
  exchange?: string;
  name?: string;
  currency?: string;
  moneda?: string;
  symbol?: string;
  buy?: unknown;
  compra?: unknown;
  bid?: unknown;
  sell?: unknown;
  venta?: unknown;
  ask?: unknown;
  rate?: unknown;
  promedio?: unknown;
  average?: unknown;
  price?: unknown;
  updated_at?: string;
  fechaActualizacion?: string;
  timestamp?: string;
}

interface MontosVeResponse {
  data?: MontosVeItem[];
  rates?: MontosVeItem[];
}

/**
 * MontosVE: no pudimos confirmar el shape exacto de la respuesta desde acá
 * (la documentación es una SPA), así que este parser prueba varios nombres
 * de campo comunes. Si el formato real es distinto, revisar la respuesta
 * de /api/tasas/externas y ajustar solo esta función.
 */
async function obtenerMontosVe(): Promise<TasaExterna[]> {
  const url = process.env.MONTOS_VE_API_URL;
  const apiKey = process.env.MONTOS_VE_API_KEY;
  if (!url || !apiKey) return [];

  try {
    const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
    if (!res.ok) {
      const cuerpo = await res.text().catch(() => "");
      console.error(`MontosVE respondió con error ${res.status}:`, cuerpo);
      return [];
    }

    const body = (await res.json()) as MontosVeItem[] | MontosVeResponse;
    const lista: MontosVeItem[] = Array.isArray(body)
      ? body
      : Array.isArray(body.data)
      ? body.data
      : Array.isArray(body.rates)
      ? body.rates
      : [];

    return lista.map((r) => ({
      origen: "MontosVE" as const,
      fuente: r.source ?? r.fuente ?? r.exchange ?? r.name ?? "MontosVE",
      moneda: r.currency ?? r.moneda ?? r.symbol ?? "USD",
      compra: numeroOn(r.buy ?? r.compra ?? r.bid),
      venta: numeroOn(r.sell ?? r.venta ?? r.ask),
      promedio: numeroOn(r.rate ?? r.promedio ?? r.average ?? r.price),
      fechaActualizacion: r.updated_at ?? r.fechaActualizacion ?? r.timestamp ?? null,
    }));
  } catch (err) {
    console.error("Error consultando MontosVE:", err);
    return [];
  }
}

function numeroOn(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function obtenerTasasExternas(): Promise<TasaExterna[]> {
  if (cache && cache.expiraEn > Date.now()) return cache.datos;

  const [dolarApi, montosVe] = await Promise.all([obtenerDolarApi(), obtenerMontosVe()]);
  const datos = [...dolarApi, ...montosVe];

  cache = { datos, expiraEn: Date.now() + TTL_MS };
  return datos;
}

export interface HistoricoDia {
  fecha: string;
  oficial: number | null;
  paralelo: number | null;
}

export interface MetricasMercado {
  oficialActual: number | null;
  paraleloActual: number | null;
  brechaPct: number | null; // cuánto más caro es el paralelo respecto al oficial
  variacionOficial7d: number | null; // % de cambio en los últimos 7 días
  variacionParalelo7d: number | null;
}

interface HistoricoItem {
  fuente?: string;
  compra?: number;
  venta?: number;
  promedio?: number;
  fecha?: string;
}

let cacheHistorico: { datos: { historico: HistoricoDia[]; metricas: MetricasMercado }; expiraEn: number } | null = null;
const TTL_HISTORICO_MS = 10 * 60_000; // 10 min -- el histórico no cambia intradía

function valorRepresentativo(item: HistoricoItem): number | null {
  // promedio si existe, si no venta -- es el número más representativo del día
  return typeof item.promedio === "number" ? item.promedio : typeof item.venta === "number" ? item.venta : null;
}

function variacionPct(actual: number | null, anterior: number | null): number | null {
  if (actual == null || anterior == null || anterior === 0) return null;
  return ((actual - anterior) / anterior) * 100;
}

export async function obtenerHistoricoMercado(dias: number): Promise<{ historico: HistoricoDia[]; metricas: MetricasMercado }> {
  if (cacheHistorico && cacheHistorico.expiraEn > Date.now()) return cacheHistorico.datos;

  const base = process.env.DOLARAPI_BASE_URL ?? "https://ve.dolarapi.com";
  const vacio = { historico: [], metricas: { oficialActual: null, paraleloActual: null, brechaPct: null, variacionOficial7d: null, variacionParalelo7d: null } };

  try {
    const res = await fetch(`${base}/v1/historicos/dolares`);
    if (!res.ok) return vacio;

    const items = (await res.json()) as HistoricoItem[];
    if (!Array.isArray(items)) return vacio;

    // Agrupar por fecha: cada día trae una fila "oficial" (BCV) y una "paralelo" (Yadio)
    const porFecha = new Map<string, HistoricoDia>();
    for (const item of items) {
      if (!item.fecha) continue;
      const dia = porFecha.get(item.fecha) ?? { fecha: item.fecha, oficial: null, paralelo: null };
      const esOficial = (item.fuente ?? "").toLowerCase().includes("oficial") || (item.fuente ?? "").toLowerCase().includes("bcv");
      const valor = valorRepresentativo(item);
      if (esOficial) dia.oficial = valor;
      else dia.paralelo = valor;
      porFecha.set(item.fecha, dia);
    }

    const historicoCompleto = [...porFecha.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
    const historico = historicoCompleto.slice(-dias);

    const ultimo = historico[historico.length - 1] ?? null;
    const hace7Indice = historico.length - 8; // 7 días atrás del último
    const hace7 = hace7Indice >= 0 ? historico[hace7Indice] : historico[0] ?? null;

    const metricas: MetricasMercado = {
      oficialActual: ultimo?.oficial ?? null,
      paraleloActual: ultimo?.paralelo ?? null,
      brechaPct:
        ultimo?.oficial && ultimo?.paralelo ? ((ultimo.paralelo - ultimo.oficial) / ultimo.oficial) * 100 : null,
      variacionOficial7d: variacionPct(ultimo?.oficial ?? null, hace7?.oficial ?? null),
      variacionParalelo7d: variacionPct(ultimo?.paralelo ?? null, hace7?.paralelo ?? null),
    };

    const resultado = { historico, metricas };
    cacheHistorico = { datos: resultado, expiraEn: Date.now() + TTL_HISTORICO_MS };
    return resultado;
  } catch (err) {
    console.error("Error consultando histórico de DolarApi:", err);
    return vacio;
  }
}