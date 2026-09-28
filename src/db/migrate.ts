import fs from "fs";
import path from "path";
import { pool } from "./pool";

async function migrate() {
  const sqlPath = path.join(__dirname, "..", "..", "sql", "schema.sql");
  const sql = fs.readFileSync(sqlPath, "utf-8");

  console.log(">> Aplicando schema.sql ...");
  await pool.query(sql);
  console.log(">> Migración completa.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Error aplicando la migración:", err);
  process.exit(1);
});