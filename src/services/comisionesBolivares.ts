import Decimal from "decimal.js";

/**
 * Lo que cobra el banco al mandar bolívares (tarifario del BCV vigente, agosto/septiembre 2026):
 *   Pago móvil persona a persona (P2P): 0,30 % del monto, mínimo Bs 14
 *   Pago móvil persona a comercio (P2C): 1,50 %, mínimo Bs 14
 *   Pago móvil comercio a persona (C2P): 1,75 %, mínimo Bs 14
 *   Transferencia: sin comisión aparte
 * (Coincide con los estados de cuenta del Banco de Venezuela: 115.000 → 345, 20.000 → 60, 1.700 → 14.)
 * Si el BCV cambia el tarifario, se cambia acá y en frontend/src/modules/cuentasCorrientes/comisionesBolivares.ts.
 */
export const ENVIOS_BOLIVARES = {
  P2P: { etiqueta: "Pago móvil a persona", porcentaje: "0.30", minimo: "14" },
  P2C: { etiqueta: "Pago móvil a comercio", porcentaje: "1.50", minimo: "14" },
  C2P: { etiqueta: "Pago móvil de comercio a persona", porcentaje: "1.75", minimo: "14" },
  TRANSFERENCIA: { etiqueta: "Transferencia", porcentaje: "0", minimo: "0" },
} as const;
export type EnvioBolivares = keyof typeof ENVIOS_BOLIVARES;

/** La comisión del banco por mandar ese monto en bolívares (redondeada a céntimos). */
export function comisionBolivares(monto: Decimal.Value, envio: EnvioBolivares) {
  const t = ENVIOS_BOLIVARES[envio];
  const pct = new Decimal(monto).abs().times(t.porcentaje).dividedBy(100);
  return Decimal.max(pct, t.minimo).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
