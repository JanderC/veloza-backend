import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET es obligatoria"),
  // Almacenamiento de documentos (Cloudflare R2 / S3). Opcionales para que el
  // servidor arranque sin ellas; solo los endpoints de documentos las exigen.
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const faltantes = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  console.error(
    `>> Variables de entorno inválidas o faltantes:\n${faltantes}\n` +
      `   En local: revisar .env. En Railway: agregarlas en el panel de Variables y redeploy.`
  );
  process.exit(1);
}

export const env = parsed.data;
