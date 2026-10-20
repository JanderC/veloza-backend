import os from "os";
import path from "path";
import { createWorker } from "tesseract.js";

/**
 * Lector de texto de imágenes en el servidor (el mismo que usa el navegador). Es el respaldo cuando el navegador no
 * puede leer la captura (no descarga el lector, poca memoria) y la IA no está disponible. Devuelve el texto tal cual:
 * la pantalla saca de ahí el monto, la referencia, la fecha y el método.
 */
type Worker = Awaited<ReturnType<typeof createWorker>>;
let lector: Promise<Worker> | null = null;
// los idiomas se descargan una vez y quedan en una carpeta temporal del servidor
const CACHE = path.join(os.tmpdir(), "veloz-ocr");

function obtenerLector() {
  lector ??= createWorker(["spa", "eng"], 1, { cachePath: CACHE }).catch((e) => {
    lector = null; // que el próximo intento vuelva a probar
    throw e;
  });
  return lector;
}

// de a una imagen por vez: el lector es uno solo
let cola: Promise<unknown> = Promise.resolve();

export async function leerTextoEnServidor(imagen: Buffer): Promise<string> {
  const turno = cola.then(async () => {
    const w = await obtenerLector();
    const { data } = await w.recognize(imagen);
    return data.text;
  });
  cola = turno.catch(() => {});
  const limite = new Promise<never>((_, rechazar) => setTimeout(() => rechazar(Object.assign(new Error("La lectura tardó demasiado"), { status: 504 })), 45_000));
  return Promise.race([turno, limite]);
}
