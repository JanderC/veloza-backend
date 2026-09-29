import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env";

// Documentos en Cloudinary como tipo PRIVATE: no hay URL pública. Para verlos
// se genera un enlace firmado de descarga que vence en minutos.
// Los PDF se suben como "raw" (las cuentas gratis bloquean PDF subidos como imagen).

type TipoRecurso = "image" | "raw";

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

function tipoRecurso(mimeType: string): TipoRecurso {
  return mimeType === "application/pdf" ? "raw" : "image";
}

// En "raw" la extensión es parte del public_id; en "image" va aparte como formato
function formatoDescarga(mimeType: string) {
  if (tipoRecurso(mimeType) === "raw") return "";
  return mimeType.split("/")[1] ?? "";
}

/** Sube el archivo y devuelve la key (public_id) que se guarda en la base. */
export async function subirArchivo(carpeta: string, nombreBase: string, contenido: Buffer, mimeType: string) {
  asegurarConfig();
  const resourceType = tipoRecurso(mimeType);
  const publicId = `${carpeta}/${nombreBase}${resourceType === "raw" ? ".pdf" : ""}`;

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
