// Suministros: lectura (columnar, el navegador arma las filas estilo Excel
// para gastar poca CPU del Worker) y las acciones del circuito de aprobación.

import { esAdmin, puedeCambiarOficina, secretariaVisible, type Usuario } from "./auth";
import { datosCuota, evaluar } from "./cuota";
import { ejercicio, error, json, leerJson, type Env } from "./tipos";

// Orden de columnas de la respuesta: script.js (SuministrosData) depende de
// estos nombres, no del orden.
const SELECT = `
  SELECT s.anio, s.numero, s.estado, s.origen, s.secretaria, s.fuente, s.dependencia,
         s.fecha_carga, s.mes_inicio, s.meses_consumo, s.oficina, s.observaciones, s.etiqueta,
         s.monto, s.adjudicado, s.cuota_estado, s.cuota_asignada, s.cuota_excedida,
         COALESCE(e.fecha_solgastos, s.fecha_solgastos)       AS fecha_solgastos,
         COALESCE(e.fecha_cotizacion, s.fecha_cotizacion)     AS fecha_cotizacion,
         COALESCE(e.fecha_adjudicacion, s.fecha_adjudicacion) AS fecha_adjudicacion,
         COALESCE(e.fecha_orden, s.fecha_orden)               AS fecha_orden,
         s.derivado_economia, s.fecha_derivacion_economia, s.hora_derivacion_economia, s.impreso,
         s.resuelto_por, s.resuelto_en, s.motivo_rechazo,
         e.ordenes, e.fecha_recepcion, e.ultima_etapa, e.ultimo_estado,
         p.jurisdiccion AS jurisdiccion_rafam
  FROM suministros s
  LEFT JOIN etapas_rafam e ON e.anio = s.anio AND e.numero = s.numero
  LEFT JOIN pedidos_rafam p ON p.anio = s.anio AND p.numero = s.numero`;

const COLS = [
  "anio", "numero", "estado", "origen", "secretaria", "fuente", "dependencia",
  "fecha_carga", "mes_inicio", "meses_consumo", "oficina", "observaciones", "etiqueta",
  "monto", "adjudicado", "cuota_estado", "cuota_asignada", "cuota_excedida",
  "fecha_solgastos", "fecha_cotizacion", "fecha_adjudicacion", "fecha_orden",
  "derivado_economia", "fecha_derivacion_economia", "hora_derivacion_economia", "impreso",
  "resuelto_por", "resuelto_en", "motivo_rechazo",
  "ordenes", "fecha_recepcion", "ultima_etapa", "ultimo_estado", "jurisdiccion_rafam",
];

export async function listar(env: Env, u: Usuario): Promise<Response> {
  const anio = ejercicio(env);
  const secretaria = secretariaVisible(u);
  const stmt = secretaria
    ? env.DB.prepare(`${SELECT} WHERE s.anio = ? AND s.secretaria = ? ORDER BY s.numero DESC`).bind(anio, secretaria)
    : env.DB.prepare(`${SELECT} WHERE s.anio = ? ORDER BY s.numero DESC`).bind(anio);
  const [rows, sync] = await Promise.all([
    stmt.raw(),
    env.DB.prepare("SELECT fin, origen FROM sync_log WHERE ok = 1 ORDER BY id DESC LIMIT 1").first<{ fin: string; origen: string }>(),
  ]);
  return json({ ok: true, anio, cols: COLS, rows, ultimaSync: sync ?? null });
}

interface FilaEstado {
  estado: string;
  origen: string;
  secretaria: string | null;
  fuente: number | null;
  monto: number | null;
}

async function buscar(env: Env, anio: number, numero: number): Promise<FilaEstado | null> {
  return env.DB.prepare("SELECT estado, origen, secretaria, fuente, monto FROM suministros WHERE anio = ? AND numero = ?")
    .bind(anio, numero)
    .first<FilaEstado>();
}

const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Datos que completa el área (mientras está pendiente) o el administrador. */
export async function actualizar(env: Env, u: Usuario, anio: number, numero: number, request: Request): Promise<Response> {
  const fila = await buscar(env, anio, numero);
  if (!fila) return error(404, `No existe el pedido N° ${numero}.`);
  const vis = secretariaVisible(u);
  if (vis && fila.secretaria !== vis) return error(403, "Ese pedido es de otra Secretaría.");

  const body = await leerJson<Record<string, unknown>>(request);
  if (!body) return error(400, "Cuerpo inválido.");

  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    binds.push(v);
  };

  // Datos de planificación: el área mientras está pendiente; el admin siempre.
  const editaPlan = esAdmin(u) || (u.rol === "area" && fila.estado === "pendiente");
  if ("mesInicio" in body) {
    if (!editaPlan) return error(403, "Solo se puede cambiar mientras el pedido está pendiente.");
    const v = String(body.mesInicio ?? "");
    if (!MES_RE.test(v) || Number(v.slice(0, 4)) !== anio) return error(400, `Mes de inicio inválido (tiene que ser un mes de ${anio}).`);
    set("mes_inicio", v);
  }
  if ("mesesConsumo" in body) {
    if (!editaPlan) return error(403, "Solo se puede cambiar mientras el pedido está pendiente.");
    const v = Number(body.mesesConsumo);
    if (!Number.isInteger(v) || v < 1 || v > 12) return error(400, "Los meses de consumo tienen que ser un entero entre 1 y 12.");
    set("meses_consumo", v);
  }
  if ("observaciones" in body) {
    if (!editaPlan) return error(403, "Solo se puede cambiar mientras el pedido está pendiente.");
    set("observaciones", String(body.observaciones ?? "").slice(0, 500) || null);
  }
  if ("oficina" in body) {
    if (!puedeCambiarOficina(u)) return error(403, "Su perfil no puede cambiar la oficina.");
    const v = String(body.oficina ?? "").trim();
    if (!v) return error(400, "Oficina vacía.");
    set("oficina", v.slice(0, 120));
  }
  if ("secretaria" in body) {
    if (!esAdmin(u)) return error(403, "Solo el administrador asigna la Secretaría.");
    if (fila.estado !== "pendiente") return error(409, "Solo se reasigna la Secretaría de un pedido pendiente.");
    const v = String(body.secretaria ?? "").trim();
    set("secretaria", v || null);
  }
  if (sets.length === 0) return error(400, "No hay nada para cambiar.");

  sets.push("actualizado_en = datetime('now')");
  await env.DB.prepare(`UPDATE suministros SET ${sets.join(", ")} WHERE anio = ? AND numero = ?`)
    .bind(...binds, anio, numero)
    .run();
  return json({ ok: true });
}

/** Aprobar = el pedido pasa a ser un suministro. Chequea la cuota en el servidor. */
export async function aprobar(env: Env, u: Usuario, anio: number, numero: number, request: Request): Promise<Response> {
  if (!esAdmin(u)) return error(403, "Solo el administrador aprueba pedidos.");
  const fila = await buscar(env, anio, numero);
  if (!fila) return error(404, `No existe el pedido N° ${numero}.`);
  if (fila.estado !== "pendiente") return error(409, `El pedido N° ${numero} ya está ${fila.estado}.`);
  if (!fila.secretaria) return error(409, "Asigne primero la Secretaría del pedido (no se pudo resolver desde RAFAM).");

  const body = (await leerJson<{ forzar?: boolean }>(request)) ?? {};
  const monto = fila.monto ?? 0;
  const ev = evaluar(await datosCuota(env.DB, anio), fila.secretaria, fila.fuente, monto);

  if (ev.controlada && ev.excede && !body.forzar) {
    return error(409, ev.tieneDatos
      ? `Aprobarlo excede la cuota de ${fila.secretaria} en la Fuente ${fila.fuente}.`
      : `${fila.secretaria} no tiene cuota cargada en la Fuente ${fila.fuente}.`, { ...ev });
  }

  const cuotaEstado = !ev.controlada ? "Afectado" : ev.excede ? "Insuficiente" : "Suficiente";
  await env.DB.prepare(
    `UPDATE suministros SET estado = 'aprobado', cuota_estado = ?, cuota_excedida = ?, resuelto_por = ?,
       resuelto_en = datetime('now'), motivo_rechazo = NULL, actualizado_en = datetime('now')
     WHERE anio = ? AND numero = ? AND estado = 'pendiente'`,
  )
    .bind(cuotaEstado, ev.controlada && ev.excede ? 1 : 0, u.legajo, anio, numero)
    .run();
  return json({ ok: true, cuota: cuotaEstado, ...ev });
}

export async function rechazar(env: Env, u: Usuario, anio: number, numero: number, request: Request): Promise<Response> {
  if (!esAdmin(u)) return error(403, "Solo el administrador rechaza pedidos.");
  const fila = await buscar(env, anio, numero);
  if (!fila) return error(404, `No existe el pedido N° ${numero}.`);
  if (fila.estado !== "pendiente") return error(409, `El pedido N° ${numero} ya está ${fila.estado}.`);
  const body = (await leerJson<{ motivo?: string }>(request)) ?? {};
  const motivo = String(body.motivo ?? "").trim().slice(0, 500);
  if (!motivo) return error(400, "Indique el motivo del rechazo.");
  await env.DB.prepare(
    `UPDATE suministros SET estado = 'rechazado', motivo_rechazo = ?, resuelto_por = ?, resuelto_en = datetime('now'),
       actualizado_en = datetime('now') WHERE anio = ? AND numero = ? AND estado = 'pendiente'`,
  )
    .bind(motivo, u.legajo, anio, numero)
    .run();
  return json({ ok: true });
}

/** Vuelve un rechazado (o un aprobado por error) a pendiente. */
export async function reabrir(env: Env, u: Usuario, anio: number, numero: number): Promise<Response> {
  if (!esAdmin(u)) return error(403, "Solo el administrador puede reabrir un pedido.");
  const fila = await buscar(env, anio, numero);
  if (!fila) return error(404, `No existe el pedido N° ${numero}.`);
  if (fila.origen !== "rafam") return error(409, "Los suministros heredados del Excel no se reabren.");
  if (fila.estado === "pendiente") return error(409, "Ya está pendiente.");
  await env.DB.prepare(
    `UPDATE suministros SET estado = 'pendiente', cuota_estado = NULL, cuota_excedida = 0, resuelto_por = NULL,
       resuelto_en = NULL, motivo_rechazo = NULL, actualizado_en = datetime('now') WHERE anio = ? AND numero = ?`,
  )
    .bind(anio, numero)
    .run();
  return json({ ok: true });
}
