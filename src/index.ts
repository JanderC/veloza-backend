import express from "express";
import cors from "cors";
import "./config/env";
import { router } from "./routes";
import { errorHandler } from "./middleware/errorHandler";
import { iniciarModuloWhatsapp } from "./services/whatsapp/trabajadores";

const app = express();
app.use(cors());
// 1 MB: las firmas de los contratos viajan como imagen
app.use(express.json({ limit: "1mb" }));
app.use("/api", router);
app.use(errorHandler);

const PORT = process.env.PORT ?? 4000;
app.listen(PORT, () => {
  console.log(`>> Sist ema Cambiario backend corriendo en puerto ${PORT}`);
  void iniciarModuloWhatsapp();
});