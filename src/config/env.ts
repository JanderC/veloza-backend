import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET es obligatoria"),
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
