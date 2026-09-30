import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env";

// Documentos en Cloudinary como tipo PRIVATE: no hay URL pública. Para verlos
// se genera un enlace firmado de descarga que vence en minutos.
// Los PDF y demás documentos se suben como "raw" (las cuentas gratis bloquean PDF subidos como imagen).
// Audio y video (notas de voz de WhatsApp) van como "video".

type TipoRecurso = "image" | "video" | "raw";

let configurado = false;

function asegurarConfig() {
  if (configurado) return;
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw Object.assign(
      new Error("El almacenamiento de documentos no está configurado (faltan variables CLOUDINARY_* en el servidor)"),
      { status: 503 }
    );
  }
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
  configurado = true;
}

// Imágenes como "image"; audio y video como "video" (así los maneja Cloudinary); el resto (PDF, documentos) como "raw"
function tipoRecurso(mimeType: string): TipoRecurso {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/") || mimeType.startsWith("video/")) return "video";
  return "raw";
}

// Extensión de los "raw" (va dentro del public_id) y formato de descarga de audio/video
const EXTENSIONES: Record<string, string> = {
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
};

function extension(mimeType: string) {
  const base = mimeType.split(";")[0]?.trim() ?? "";
  return EXTENSIONES[base] ?? "bin";
}

// En "raw" la extensión es parte del public_id; en "image" y "video" va aparte como formato
function formatoDescarga(mimeType: string) {
  const tipo = tipoRecurso(mimeType);
  if (tipo === "raw") return "";
  if (tipo === "video") return extension(mimeType);
  return mimeType.split("/")[1] ?? "";
}

/** Sube el archivo y devuelve la key (public_id) que se guarda en la base. */
export async function subirArchivo(carpeta: string, nombreBase: string, contenido: Buffer, mimeType: string) {
  asegurarConfig();
  const resourceType = tipoRecurso(mimeType);
  const publicId = `${carpeta}/${nombreBase}${resourceType === "raw" ? `.${extension(mimeType)}` : ""}`;

  const resultado = await cloudinary.uploader.upload(`data:${mimeType};base64,${contenido.toString("base64")}`, {
    public_id: publicId,
    resource_type: resourceType,
    type: "private",
    overwrite: false,
  });
  return resultado.public_id;
}

export async function eliminarArchivo(key: string, mimeType: string) {
  asegurarConfig();
  await cloudinary.uploader.destroy(key, { resource_type: tipoRecurso(mimeType), type: "private", invalidate: true });
}

/** Enlace temporal para ver/descargar el archivo. Vence en `segundos`. */
export function generarUrlTemporal(key: string, mimeType: string, segundos: number) {
  asegurarConfig();
  return cloudinary.utils.private_download_url(key, formatoDescarga(mimeType), {
    resource_type: tipoRecurso(mimeType),
    type: "private",
    expires_at: Math.floor(Date.now() / 1000) + segundos,
  });
}
