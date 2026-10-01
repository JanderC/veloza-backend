/* Cuentas corrientes contra la BD real: se carga la hoja "DANIEL" del Excel del cliente y se
 * compara cada TOTAL corrido. Todo lo creado lleva "PRUEBA-CC" y se borra al final.
 * Uso: npm run test:cuentas-corrientes
 */
import assert from "node:assert/strict";
import { pool } from "../src/db/pool";
import {
  anularMovimiento,
  cambiarEstadoCuentaCorriente,
  crearCanal,
  crearCuentaCorriente,
  listarCuentasCorrientes,
  obtenerEstadoCuenta,
  registrarMovimientoCuentaCorriente,
} from "../src/services/cuentaCorriente.service";

// referencia, cantidad, tasa (null = monto directo), total esperado del Excel
const HOJA: [string, string, string | null, number][] = [
  ["Christian Moreno", "2000", "2990", 5980000],
  ["Venta de bss", "700000", "3.2", 8220000],
  ["Venta de bss", "200000", "3.2", 8860000],
  ["Venta de bss", "192000", "3.2", 9474400],
  ["Wilfredo Figueroa", "1000", "2990", 12464400],
  ["Venta de bss", "100000", "3.2", 12784400],
  ["Deteriorado", "1105", "2650", 15712650],
  ["Venta de bss", "80000", "3.2", 15968650],
  ["Andrea Velasquez", "1000", "2990", 18958650],
  ["Venta de USDT", "10091", "3075", 49988475],
  ["Ana Varillas", "1369", "2990", 54081785],
  ["Rosmer Moros", "500", "2990", 55576785],
  ["Erickson Paredes", "1620", "2990", 60420585],
  ["Venta de bss", "340000", "3.22", 61515385],
  ["Venta de bss", "380000", "3.22", 62738985],
  ["Venta de bss", "340000", "3.22", 63833785],
  ["Wilfredo Figueroa", "2000", "2990", 69813785],
  ["Abono dolares", "-12500", "3205", 29751285],
  ["Abono dolares", "-1000", "3195", 26556285],
  ["Abono efectivo", "-18530000", null, 8026285],
];

async function main() {
  const usuario = (await pool.query(`SELECT id FROM usuarios WHERE rol = 'ADMIN' ORDER BY id LIMIT 1`)).rows[0].id;
  const cop = (await pool.query(`SELECT id FROM monedas WHERE codigo = 'COP'`)).rows[0].id;
  const resultados: boolean[] = [];
  async function prueba(nombre: string, fn: () => Promise<void>) {
    try {
      await fn();
      resultados.push(true);
      console.log(`  ✓ ${nombre}`);
    } catch (err) {
      resultados.push(false);
      console.log(`  ✗ ${nombre}\n    ${(err as Error).message}`);
    }
  }

  console.log("\nPruebas de cuentas corrientes\n");
  let cuentaId = 0;
  let terceroId = 0;
  let canalId = 0;
  try {
    await prueba("se crea el canal de pago y la cuenta con un proveedor nuevo y saldo pendiente inicial", async () => {
      const canal = await crearCanal("prueba-cc canal");
      canalId = canal.id;
      assert.equal(canal.nombre, "PRUEBA-CC_CANAL");
      const cuenta = await crearCuentaCorriente({
        nuevoTercero: { nombre: "PRUEBA-CC Daniel", tipo: "PROVEEDOR" },
        canalId,
        monedaId: cop,
        saldoInicial: "-500",
        usuarioId: usuario,
      });
      cuentaId = cuenta.id;
      terceroId = cuenta.tercero_id;
      assert.equal(cuenta.tercero_tipo, "PROVEEDOR");
      assert.equal(Number(cuenta.saldo_actual), -500);
      await assert.rejects(
        crearCuentaCorriente({ terceroId, canalId, monedaId: cop, usuarioId: usuario }),
        /ya tiene una cuenta/
      );
      await assert.rejects(
        crearCuentaCorriente({ nuevoTercero: { nombre: "prueba-cc daniel", tipo: "PROVEEDOR" }, canalId, monedaId: cop, usuarioId: usuario }),
        /Ya existe/
      );
      // se deja en cero para comparar con el Excel
      await registrarMovimientoCuentaCorriente({ terceroId, canalId, monedaId: cop, tipo: "AJUSTE", monto: "500", usuarioId: usuario });
    });

    await prueba("la hoja DANIEL del Excel: MONTO = CANTIDAD x TASA y cada TOTAL corrido coincide", async () => {
      for (const [referencia, cantidad, tasa] of HOJA) {
        await registrarMovimientoCuentaCorriente({
          terceroId,
          canalId,
          monedaId: cop,
          tipo: cantidad.startsWith("-") ? "ABONO" : "CARGO",
          descripcion: referencia,
          ...(tasa ? { cantidadBase: cantidad, tasa } : { monto: cantidad }),
          usuarioId: usuario,
        });
      }
      const estado = await obtenerEstadoCuenta(cuentaId, {});
      const filas = estado.movimientos.slice(2); // sin el saldo inicial y su ajuste
      assert.equal(filas.length, HOJA.length);
      filas.forEach((f, i) => assert.equal(Number(f.total), HOJA[i]![3], `fila ${i + 1} (${HOJA[i]![0]})`));
      assert.equal(Number(filas[9]!.monto), 31029825); // 10.091 USDT x 3.075
      assert.equal(Number(estado.saldoFinal), 8026285);
      assert.equal(Number(estado.sumas) - 500, 69813785);
      assert.equal(Number(estado.abonos) + 500, -61787500);
      const lista = await listarCuentasCorrientes({ buscar: "prueba-cc", tipoTercero: "PROVEEDOR" });
      assert.equal(Number(lista.find((c) => c.id === cuentaId)!.saldo_actual), 8026285);
    });

    await prueba("no acepta un monto que no coincide con cantidad x tasa, ni tasa cero, ni monto cero", async () => {
      const base = { terceroId, canalId, monedaId: cop, tipo: "CARGO" as const, usuarioId: usuario };
      await assert.rejects(registrarMovimientoCuentaCorriente({ ...base, cantidadBase: "100", tasa: "3000", monto: "300001" }), /no coincide/);
      await assert.rejects(registrarMovimientoCuentaCorriente({ ...base, cantidadBase: "100", tasa: "0" }), /mayor a cero/);
      await assert.rejects(registrarMovimientoCuentaCorriente({ ...base, monto: "0" }), /cero/);
      await assert.rejects(registrarMovimientoCuentaCorriente({ ...base }), /Indicá el monto/);
    });

    await prueba("anular: registra el contrario, el saldo vuelve y no cuenta en las sumas; no se anula dos veces", async () => {
      const antes = await obtenerEstadoCuenta(cuentaId, {});
      const r = await registrarMovimientoCuentaCorriente({
        terceroId, canalId, monedaId: cop, tipo: "CARGO", cantidadBase: "100", tasa: "2990", descripcion: "Cargado por error", usuarioId: usuario,
      });
      assert.equal(Number(r.saldoNuevo), 8026285 + 299000);
      await anularMovimiento(r.movimiento.id, usuario);
      const despues = await obtenerEstadoCuenta(cuentaId, {});
      assert.equal(Number(despues.saldoFinal), 8026285);
      assert.equal(despues.sumas, antes.sumas);
      assert.equal(despues.movimientos.filter((m) => m.anulado).length, 2);
      await assert.rejects(anularMovimiento(r.movimiento.id, usuario), /ya está anulado/);
    });

    await prueba("por día: el saldo pendiente anterior arrastra lo de días previos y un movimiento con fecha vieja queda en su lugar", async () => {
      const ayer = new Date(Date.now() - 86_400_000);
      await registrarMovimientoCuentaCorriente({
        terceroId, canalId, monedaId: cop, tipo: "CARGO", monto: "1000", descripcion: "De ayer", fecha: ayer.toISOString(), usuarioId: usuario,
      });
      const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
      const delDia = await obtenerEstadoCuenta(cuentaId, { desde: hoy, hasta: hoy });
      assert.equal(Number(delDia.saldoAnterior), 1000);
      assert.ok(!delDia.movimientos.some((m) => m.descripcion === "De ayer"));
      assert.equal(Number(delDia.movimientos[0]!.total), 1000 - 500); // arranca sobre lo de ayer
      assert.equal(Number(delDia.saldoFinal), 8026285 + 1000);
      const todo = await obtenerEstadoCuenta(cuentaId, {});
      assert.equal(todo.movimientos[0]!.descripcion, "De ayer");
    });

    await prueba("una cuenta bloqueada no admite movimientos", async () => {
      await cambiarEstadoCuentaCorriente(cuentaId, "BLOQUEADA");
      await assert.rejects(
        registrarMovimientoCuentaCorriente({ terceroId, canalId, monedaId: cop, tipo: "CARGO", monto: "10", usuarioId: usuario }),
        /bloqueada/
      );
    });
  } finally {
    await pool.query(`DELETE FROM movimientos_cuenta_corriente WHERE cuenta_corriente_id IN (SELECT cc.id FROM cuentas_corrientes cc JOIN terceros t ON t.id = cc.tercero_id WHERE t.nombre ILIKE 'PRUEBA-CC%')`);
    await pool.query(`DELETE FROM cuentas_corrientes WHERE tercero_id IN (SELECT id FROM terceros WHERE nombre ILIKE 'PRUEBA-CC%')`);
    await pool.query(`DELETE FROM terceros WHERE nombre ILIKE 'PRUEBA-CC%'`);
    await pool.query(`DELETE FROM canales_cuenta_corriente WHERE nombre LIKE 'PRUEBA-CC%'`);
    const restos = (await pool.query(`SELECT (SELECT count(*) FROM terceros WHERE nombre ILIKE 'PRUEBA-CC%') + (SELECT count(*) FROM canales_cuenta_corriente WHERE nombre LIKE 'PRUEBA-CC%') AS n`)).rows[0].n;
    console.log(`\nLimpieza completa (restos: ${restos}).`);
    await pool.end();
  }
  const ok = resultados.filter(Boolean).length;
  console.log(`${ok}/${resultados.length} pruebas OK`);
  process.exit(ok === resultados.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
