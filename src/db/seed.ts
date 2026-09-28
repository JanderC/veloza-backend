import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { pool } from "./pool";

async function seed() {
  const sqlPath = path.join(__dirname, "..", "..", "sql", "seed.sql");
  const sql = fs.readFileSync(sqlPath, "utf-8");

  console.log(">> Insertando catálogo base ...");
  await pool.query(sql);

  const passwordHash = await bcrypt.hash("CAMBIAR_ESTA_CLAVE", 10);
  await pool.query(
    `INSERT INTO usuarios (nombre, email, password_hash, rol)
     VALUES ($1, $2, $3, 'ADMIN')
     ON CONFLICT (email) DO NOTHING`,
    ["Administrador", "admin@sistema-cambiario.local", passwordHash]
  );

  console.log(">> Seed completo: monedas, métodos de pago, cajas y admin creados.");
  await pool.end();
}

seed().catch((err) => {
  console.error("Error en el seed:", err);
  process.exit(1);
});