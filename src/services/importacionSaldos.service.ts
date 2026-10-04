import * as XLSX from "xlsx";
import { pool } from "../db/pool";
import { registrarMovimientoCuentaCorriente } from "./cuentaCorriente.service";

interface FilaPlantilla {
  Tercero?: string;
  Identificacion?: string | number;
  Tipo?: string;
  Canal?: string;
  Moneda?: string;
  "Saldo Inicial"?: number | string;
  Descripcion?: string;
}

export interface ResultadoFila {
  fila: number;
  tercero: string;
  ok: boolean;
  error?: string;
  cuentaCorrienteId?: number;
}

const TIPOS_TERCERO_VALIDOS = ["CLIENTE", "PROVEEDOR", "MIXTO", "AMIGO"];

async function obtenerOCrearTercero(nombre: string, identificacion: string | null, tipo: string) {
  if (identificacion) {
    const existente = await pool.query(`SELECT * FROM terceros WHERE identificacion = $1`, [identificacion]);
    if (existente.rows.length > 0) return existente.rows[0];
  } else {
    const existente = await pool.query(`SELECT * FROM terceros WHERE nombre = $1`, [nombre]);
    if (existente.rows.length > 0) return existente.rows[0];
  }

  const insert = await pool.query(
    `INSERT INTO terceros (nombre, identificacion, tipo) VALUES ($1, $2, $3) RETURNING *`,
    [nombre, identificacion, tipo]
  );
  return insert.rows[0];
}

async function obtenerCanalPorNombre(nombre: string) {
  const result = await pool.query(`SELECT * FROM canales_cuenta_corriente WHERE nombre = $1`, [nombre]);
  return result.rows[0] ?? null;
}

async function obtenerMonedaPorCodigo(codigo: string) {
  const result = await pool.query(`SELECT * FROM monedas WHERE codigo = $1`, [codigo]);
  return result.rows[0] ?? null;
}

/**
 * Importa saldos iniciales desde el archivo de la plantilla. Cada fila se
 * procesa de forma independiente y atómica (vía registrarMovimientoCuentaCorriente
 * con tipo AJUSTE) -- si una fila falla, las demás se siguen procesando; el
 * resultado final indica exactamente qué filas entraron y cuáles no.
 */
export async function importarSaldosIniciales(buffer: Buffer, usuarioId: number): Promise<ResultadoFila[]> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const primeraHoja = workbook.SheetNames[0];
  if (!primeraHoja) {
    throw Object.assign(new Error("El archivo no tiene ninguna hoja"), { status: 400 });
  }

  const sheet = workbook.Sheets[primeraHoja];
  if (!sheet) {
    throw Object.assign(new Error(`No se pudo leer la hoja "${primeraHoja}"`), { status: 400 });
  }

  // range: 2 -> arranca a leer desde la fila 3 (índice 2), que es donde están los encabezados reales
  const filas: FilaPlantilla[] = XLSX.utils.sheet_to_json<FilaPlantilla>(sheet, { range: 2, defval: null });

  const resultados: ResultadoFila[] = [];

  for (let i = 0; i < filas.length; i++) {
    const fila = filas[i];
    const numeroFila = i + 4; // +4 porque los encabezados están en la fila 3 y los datos arrancan en la 4

    if (!fila) continue;

    const nombre = fila.Tercero?.toString().trim();

    if (!nombre) {
      // fila vacía de la plantilla (de las que se dejan en blanco para llenar) -- se ignora en silencio
      continue;
    }

    try {
      const tipo = fila.Tipo?.toString().trim().toUpperCase() ?? "MIXTO";
      if (!TIPOS_TERCERO_VALIDOS.includes(tipo)) {
        throw new Error(`Tipo de tercero inválido: "${fila.Tipo}". Debe ser CLIENTE, PROVEEDOR, MIXTO o AMIGO`);
      }

      const nombreCanal = fila.Canal?.toString().trim().toUpperCase();
      if (!nombreCanal) throw new Error("Falta el Canal");
      const canal = await obtenerCanalPorNombre(nombreCanal);
      if (!canal) throw new Error(`Canal no encontrado: "${fila.Canal}"`);

      const codigoMoneda = fila.Moneda?.toString().trim().toUpperCase();
      if (!codigoMoneda) throw new Error("Falta la Moneda");
      const moneda = await obtenerMonedaPorCodigo(codigoMoneda);
      if (!moneda) throw new Error(`Moneda no encontrada: "${fila.Moneda}"`);

      const saldoRaw = fila["Saldo Inicial"];
      if (saldoRaw === null || saldoRaw === undefined || saldoRaw === "") {
        throw new Error("Falta el Saldo Inicial");
      }
      const saldo = Number(saldoRaw);
      if (Number.isNaN(saldo)) {
        throw new Error(`Saldo Inicial inválido: "${saldoRaw}"`);
      }

      const identificacion = fila.Identificacion ? fila.Identificacion.toString().trim() : null;
      const tercero = await obtenerOCrearTercero(nombre, identificacion, tipo);

      const resultado = await registrarMovimientoCuentaCorriente({
        terceroId: tercero.id,
        canalId: canal.id,
        monedaId: moneda.id,
        tipo: "AJUSTE",
        monto: saldo.toFixed(4),
        descripcion: fila.Descripcion?.toString().trim() || "Saldo inicial importado desde Excel",
        usuarioId,
      });

      resultados.push({
        fila: numeroFila,
        tercero: nombre,
        ok: true,
        cuentaCorrienteId: resultado.movimiento.cuenta_corriente_id,
      });
    } catch (err) {
      resultados.push({
        fila: numeroFila,
        tercero: nombre,
        ok: false,
        error: err instanceof Error ? err.message : "Error desconocido",
      });
    }
  }

  return resultados;
}