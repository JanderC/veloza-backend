import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { router } from "./routes";
import { errorHandler } from "./middleware/errorHandler";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", router);
app.use(errorHandler);

const PORT = process.env.PORT ?? 4000;
app.listen(PORT, () => console.log(`>> Sist ema Cambiario backend corriendo en puerto ${PORT}`));