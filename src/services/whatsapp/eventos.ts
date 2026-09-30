import { EventEmitter } from "events";

// Bus en memoria hacia el panel (SSE). Un solo servidor: no hace falta nada más.
// Eventos: mensaje | estado | chat | conexion | outbox | atencion
export type TipoEventoPanel = "mensaje" | "estado" | "chat" | "conexion" | "outbox" | "atencion";

const bus = new EventEmitter();
bus.setMaxListeners(200);

export function emitirPanel(tipo: TipoEventoPanel, datos: unknown) {
  bus.emit("evento", { tipo, datos });
}

export function suscribirPanel(fn: (e: { tipo: TipoEventoPanel; datos: unknown }) => void) {
  bus.on("evento", fn);
  return () => {
    bus.off("evento", fn);
  };
}
