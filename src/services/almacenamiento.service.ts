import { createHash, createHmac } from "crypto";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env";

// Los archivos (comprobantes, documentos de clientes, fotos y notas de voz de WhatsApp) son privados: no hay URL
// pública. Para verlos se genera un enlace firmado que vence en minutos.
//
// Dónde se guardan:
//   - Cloudflare R2 (lo nuevo): con R2_* configuradas, todo lo que se sube va ahí. Su key en la base empieza con "r2/".
//   - Cloudinary (lo viejo): lo que ya estaba subido se sigue viendo desde ahí mientras existan las CLOUDINARY_*.
//     Si no hay R2, también se sube ahí, como antes.

// ---------- Cloudflare R2 (compatible con S3) ----------

const PREFIJO_R2 = "r2/";

interface ConfigR2 {
  endpoint: string; // https://<cuenta>.r2.cloudflarestorage.com
  host: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

let r2: { config: ConfigR2; cliente: S3Client } | null | undefined;

/** La configuración de R2, o null si no está. R2_ENDPOINT es la "S3 API" que muestra Cloudflare (con o sin el bucket). */
function configR2() {
  if (r2 !== undefined) return r2;
  const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return (r2 = null);
  const url = new URL(R2_ENDPOINT);
  const bucket = R2_BUCKET || url.pathname.split("/").filter(Boolean)[0];
  if (!bucket) throw Object.assign(new Error("Falta el nombre del bucket de R2 (R2_BUCKET)"), { status: 503 });
  const config = { endpoint: `${url.protocol}//${url.host}`, host: url.host, bucket, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY };
  const cliente = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return (r2 = { config, cliente });
}

/** Lo que va en la URL: cada parte del camino codificada como pide S3 (RFC 3986). */
const codificar = (t: string) => encodeURIComponent(t).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const hmac = (clave: Buffer | string, t: string) => createHmac("sha256", clave).update(t, "utf8").digest();

/**
 * Enlace firmado (AWS Signature V4, por query) para bajar un objeto de R2 sin credenciales. Se firma acá mismo, sin
 * esperar a nadie, así generarUrlTemporal sigue siendo inmediata para todos los que la usan.
 */
export function firmarUrlR2(config: ConfigR2, objeto: string, segundos: number, ahora = new Date()) {
  const fecha = ahora.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20261106T153000Z
  const dia = fecha.slice(0, 8);
  const alcance = `${dia}/auto/s3/aws4_request`;
  const camino = `/${codificar(config.bucket)}/${objeto.split("/").map(codificar).join("/")}`;
  const parametros: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${config.accessKeyId}/${alcance}`],
    ["X-Amz-Date", fecha],
    ["X-Amz-Expires", String(Math.max(1, Math.min(604800, Math.round(segundos))))],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const consulta = parametros
    .map(([k, v]) => [codificar(k), codificar(v)])
    .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const pedido = ["GET", camino, consulta, `host:${config.host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const aFirmar = ["AWS4-HMAC-SHA256", fecha, alcance, sha256(pedido)].join("\n");
  const clave = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dia), "auto"), "s3"), "aws4_request");
  const firma = createHmac("sha256", clave).update(aFirmar, "utf8").digest("hex");
  return `${config.endpoint}${camino}?${consulta}&X-Amz-Signature=${firma}`;
}

// ---------- Cloudinary (lo que ya estaba subido) ----------

type TipoRecurso = "image" | "video" | "raw";

let cloudinaryListo = false;

function asegurarCloudinary() {
  if (cloudinaryListo) return;
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw Object.assign(
      new Error("El almacenamiento de documentos no está configurado (faltan las variables R2_* en el servidor)"),
      { status: 503 }
    );
  }
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
  cloudinaryListo = true;
}

// Imágenes como "image"; audio y video como "video" (así los maneja Cloudinary); el resto (PDF, documentos) como "raw"
function tipoRecurso(mimeType: string): TipoRecurso {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/") || mimeType.startsWith("video/")) return "video";
  return "raw";
}

// La extensión de cada tipo de archivo
const EXTENSIONES: Record<string, string> = {
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
};

function extension(mimeType: string) {
  const base = mimeType.split(";")[0]?.trim() ?? "";
  return EXTENSIONES[base] ?? (base.startsWith("image/") ? base.split("/")[1] || "bin" : "bin");
}

// En "raw" la extensión es parte del public_id; en "image" y "video" va aparte como formato
function formatoDescarga(mimeType: string) {
  const tipo = tipoRecurso(mimeType);
  if (tipo === "raw") return "";
  if (tipo === "video") return extension(mimeType);
  return mimeType.split("/")[1] ?? "";
}

// ---------- Lo que usa el resto del sistema ----------

/** Sube el archivo y devuelve la key que se guarda en la base. */
export async function subirArchivo(carpeta: string, nombreBase: string, contenido: Buffer, mimeType: string) {
  const r = configR2();
  if (r) {
    const objeto = `${carpeta}/${nombreBase}.${extension(mimeType)}`;
    await r.cliente.send(new PutObjectCommand({ Bucket: r.config.bucket, Key: objeto, Body: contenido, ContentType: mimeType.split(";")[0]?.trim() || mimeType }));
    return `${PREFIJO_R2}${objeto}`;
  }
  asegurarCloudinary();
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
  if (key.startsWith(PREFIJO_R2)) {
    const r = configR2();
    if (!r) throw Object.assign(new Error("Ese archivo está en R2 y faltan las variables R2_* en el servidor"), { status: 503 });
    await r.cliente.send(new DeleteObjectCommand({ Bucket: r.config.bucket, Key: key.slice(PREFIJO_R2.length) }));
    return;
  }
  asegurarCloudinary();
  await cloudinary.uploader.destroy(key, { resource_type: tipoRecurso(mimeType), type: "private", invalidate: true });
}

/** Enlace temporal para ver/descargar el archivo. Vence en `segundos`. */
export function generarUrlTemporal(key: string, mimeType: string, segundos: number) {
  if (key.startsWith(PREFIJO_R2)) {
    const r = configR2();
    if (!r) throw Object.assign(new Error("Ese archivo está en R2 y faltan las variables R2_* en el servidor"), { status: 503 });
    return firmarUrlR2(r.config, key.slice(PREFIJO_R2.length), segundos);
  }
  asegurarCloudinary();
  return cloudinary.utils.private_download_url(key, formatoDescarga(mimeType), {
    resource_type: tipoRecurso(mimeType),
    type: "private",
    expires_at: Math.floor(Date.now() / 1000) + segundos,
  });
}
