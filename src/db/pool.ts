import { Pool, types } from "pg";
import dotenv from "dotenv";

dotenv.config();

// OID 1700 = NUMERIC. Lo forzamos a string explícito para dejar
// claro que un monto NUNCA pasa por float en ningún punto del camino.
types.setTypeParser(1700, (val: string) => val);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  console.error("Error inesperado en el pool de Postgres", err);
  process.exit(1);
});