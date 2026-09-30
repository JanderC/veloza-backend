import express from "express";
import cors from "cors";
import "./config/env";
import { router } from "./routes";
import { errorHandler } from "./middleware/errorHandler";
import { iniciarModuloWhatsapp } from "./services/whatsapp/trabajadores";

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", router);
app.use(errorHandler);

const PORT = process.env.PORT ?? 4000;
app.listen(PORT, () => {
  console.log(`>> Sist ema Cambiario backend corriendo en puerto ${PORT}`);
  void iniciarModuloWhatsapp();
});