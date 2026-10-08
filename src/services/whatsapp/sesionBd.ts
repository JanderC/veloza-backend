import { pool } from "../../db/pool";
import { BufferJSON, initAuthCreds, proto, type AuthenticationState, type SignalDataTypeMap } from "@whiskeysockets/baileys";
import type { Linea } from "./transporte";

// Igual que useMultiFileAuthState de Baileys, pero cada "archivo" es una fila de wa_sesion.
// Railway borra el disco en cada deploy: si la sesión viviera en archivos habría que
// volver a escanear el QR después de cada despliegue.
//
// Hay una sesión por línea (teléfono vinculado). Las claves de la línea 1 van tal cual (como estaban antes);
// las de las líneas 2 y 3 llevan el prefijo "L2:" / "L3:".

const prefijo = (linea: Linea) => (linea === 1 ? "" : `L${linea}:`);
/** Las filas de una línea: las de la 1 son las que no tienen prefijo de otra. */
const sqlDeLaLinea = (linea: Linea) => (linea === 1 ? `clave NOT LIKE 'L_:%'` : `clave LIKE 'L${linea}:%'`);

async function leer(clave: string) {
  const r = await pool.query(`SELECT datos FROM wa_sesion WHERE clave = $1`, [clave]);
  const fila = r.rows[0];
  return fila ? JSON.parse(fila.datos, BufferJSON.reviver) : null;
}

async function escribir(filas: { clave: string; valor: unknown }[]) {
  if (filas.length === 0) return;
  await pool.query(
    `INSERT INTO wa_sesion (clave, datos, actualizado_en)
     SELECT * , now() FROM unnest($1::text[], $2::text[])
     ON CONFLICT (clave) DO UPDATE SET datos = EXCLUDED.datos, actualizado_en = now()`,
    [filas.map((f) => f.clave), filas.map((f) => JSON.stringify(f.valor, BufferJSON.replacer))]
  );
}

async function borrar(claves: string[]) {
  if (claves.length === 0) return;
  await pool.query(`DELETE FROM wa_sesion WHERE clave = ANY($1::text[])`, [claves]);
}

export async function haySesionGuardada(linea: Linea = 1) {
  const r = await pool.query(`SELECT 1 FROM wa_sesion WHERE clave = $1`, [`${prefijo(linea)}creds`]);
  return r.rows.length > 0;
}

/** Borra toda la sesión de una línea (logout o reset). Solo se llama por 401 o por pedido explícito del admin. */
export async function borrarSesion(linea: Linea = 1) {
  await pool.query(`DELETE FROM wa_sesion WHERE ${sqlDeLaLinea(linea)}`);
}

export async function usarSesionBd(linea: Linea = 1): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const p = prefijo(linea);
  const creds = (await leer(`${p}creds`)) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (tipo, ids) => {
          const claves = ids.map((id) => `${p}${tipo}-${id}`);
          const r = await pool.query(`SELECT clave, datos FROM wa_sesion WHERE clave = ANY($1::text[])`, [claves]);
          const porClave = new Map<string, string>(r.rows.map((f) => [f.clave, f.datos]));
          const datos: { [id: string]: SignalDataTypeMap[typeof tipo] } = {};
          for (const id of ids) {
            const crudo = porClave.get(`${p}${tipo}-${id}`);
            if (!crudo) continue;
            let valor = JSON.parse(crudo, BufferJSON.reviver);
            if (tipo === "app-state-sync-key" && valor) valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
            datos[id] = valor;
          }
          return datos;
        },
        set: async (data) => {
          const aEscribir: { clave: string; valor: unknown }[] = [];
          const aBorrar: string[] = [];
          for (const categoria in data) {
            const grupo = data[categoria as keyof SignalDataTypeMap];
            for (const id in grupo) {
              const valor = grupo[id];
              if (valor) aEscribir.push({ clave: `${p}${categoria}-${id}`, valor });
              else aBorrar.push(`${p}${categoria}-${id}`);
            }
          }
          await escribir(aEscribir);
          await borrar(aBorrar);
        },
      },
    },
    saveCreds: () => escribir([{ clave: `${p}creds`, valor: creds }]),
  };
}
