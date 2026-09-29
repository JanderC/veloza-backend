import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env";

// Bucket PRIVADO en Cloudflare R2 (API compatible con S3). Los archivos nunca
// son públicos: para verlos se genera una URL firmada que vence en minutos.

interface ConfigAlmacenamiento {
  client: S3Client;
  bucket: string;
}

let config: ConfigAlmacenamiento | null = null;

function obtenerConfig(): ConfigAlmacenamiento {
  if (config) return config;

  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    throw Object.assign(
      new Error("El almacenamiento de documentos no está configurado (faltan variables S3_* en el servidor)"),
      { status: 503 }
    );
  }

  config = {
    bucket: S3_BUCKET,
    client: new S3Client({
      endpoint: S3_ENDPOINT,
      region: S3_REGION,
      credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
    }),
  };
  return config;
}

export async function subirArchivo(key: string, contenido: Buffer, mimeType: string) {
  const { client, bucket } = obtenerConfig();
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: contenido, ContentType: mimeType }));
}

export async function eliminarArchivo(key: string) {
  const { client, bucket } = obtenerConfig();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** URL temporal para ver/descargar el archivo. Vence en `segundos`. */
export async function generarUrlTemporal(key: string, nombreArchivo: string, segundos: number) {
  const { client, bucket } = obtenerConfig();
  const nombreSeguro = nombreArchivo.replace(/[^\w.\- ]/g, "_");
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `inline; filename="${nombreSeguro}"`,
    }),
    { expiresIn: segundos }
  );
}
