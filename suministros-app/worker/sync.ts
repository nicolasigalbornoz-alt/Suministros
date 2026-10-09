// Sincronización RAFAMOR -> D1 dentro del Worker (cron diario y botón del
// panel). Solo el dataset "suministros" (pedidos): es lo que alimenta la cola
// de aprobación. La hoja de ruta (etapas del circuito, ~7 MB) y los agregados
// de Situación financiera los sube la PC con scripts/sync_d1.py, porque
// procesarlos acá pasaría el tope de CPU de un Worker.
//
// Protocolo de rafamor.pages.dev (igual que scripts/rafamor_client.py):
// data_<nombre>_meta.json con content-type JSON = categoría partida en N
// partes (data_<nombre>_pN.json); si no, data_<nombre>.json. Cloudflare Pages
// responde 200 con el index.html para rutas que no existen, por eso se mira el
// content-type y no solo el status.

import { ejercicio, type Env } from "./tipos";

interface Paquete {
  cols: string[];
  rows: unknown[][];
}

// Desde el 25/09/2026 rafamor.pages.dev pide usuario y clave (HTTP Basic):
// secret RAFAMOR_BASIC = "usuario:clave" (`wrangler secret put RAFAMOR_BASIC`).
let cabeceras: Record<string, string> = { "user-agent": "suministros-worker/1.0" };

async function traer(url: string): Promise<Response> {
  const r = await fetch(url, { headers: cabeceras });
  if (r.status === 401) throw new Error("rafamor.pages.dev pide usuario y clave: falta o es incorrecto el secret RAFAMOR_BASIC.");
  return r;
}

async function obtenerJson(url: string): Promise<Paquete | null> {
  const r = await traer(url);
  if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
  return (await r.json()) as Paquete;
}

export async function obtenerCategoria(base: string, nombre: string, basic?: string): Promise<Paquete> {
  cabeceras = { "user-agent": "suministros-worker/1.0", ...(basic ? { authorization: `Basic ${btoa(basic)}` } : {}) };
  const metaResp = await traer(`${base}/data_${nombre}_meta.json`);
  if (metaResp.ok && (metaResp.headers.get("content-type") ?? "").includes("json")) {
    const meta = (await metaResp.json()) as { partes: number };
    let cols: string[] = [];
    const rows: unknown[][] = [];
    for (let i = 1; i <= meta.partes; i++) {
      const p = await obtenerJson(`${base}/data_${nombre}_p${i}.json`);
      if (!p) throw new Error(`No pude cargar data_${nombre}_p${i}.json`);
      cols = cols.length ? cols : p.cols;
      for (const r of p.rows) rows.push(r);
    }
    return { cols, rows };
  }
  const p = await obtenerJson(`${base}/data_${nombre}.json`);
  if (!p) throw new Error(`No pude cargar data_${nombre}.json (¿cambió el formato de rafamor.pages.dev?)`);
  return p;
}

export interface PedidoRafam {
  numero: number;
  fecha: string;
  dependencia: string | null;
  fuente: number | null;
  unidad_ejecutora: string | null;
  jurisdiccion: string | null;
  ingreso_compras: string | null;
  costo_total: number | null;
  estado_rafam: string | null;
}

// Una fila por N° de pedido. RAFAMOR repite el pedido por etapa (Sol. de
// Gastos, después Ped. Suministros): se queda con la más avanzada y, si hay
// empate, con la más reciente. Una fila anulada pierde contra cualquier otra.
const RANGO: Record<string, number> = { "Ped.Suministros": 2, "Sol.de Gastos": 1 };

export function pedidosDelEjercicio(p: Paquete, anio: number): PedidoRafam[] {
  const i = (c: string) => p.cols.indexOf(c);
  const ix = {
    fecha: i("fecha"), numero: i("numero_pedido"), dependencia: i("dependencia"), fuente: i("fuente"),
    ue: i("unidad_ejecutora"), jur: i("jurisdiccion"), ingreso: i("ingreso_compras"), costo: i("costo_total"), estado: i("estado"),
  };
  if (ix.numero < 0 || ix.fecha < 0) throw new Error("El dataset suministros de RAFAMOR cambió de columnas.");

  const mejor = new Map<number, { rango: number; fecha: string; p: PedidoRafam }>();
  const prefijo = String(anio);
  for (const r of p.rows) {
    const fecha = String(r[ix.fecha] ?? "");
    if (!fecha.startsWith(prefijo)) continue;
    const numero = Number(r[ix.numero]);
    if (!Number.isInteger(numero)) continue;
    const estado = r[ix.estado] == null ? null : String(r[ix.estado]);
    const rango = estado === "Anulado" ? -1 : (RANGO[estado ?? ""] ?? 0);
    const actual = mejor.get(numero);
    if (actual && (actual.rango > rango || (actual.rango === rango && actual.fecha >= fecha))) continue;
    const fuente = Number(r[ix.fuente]);
    const costo = Number(r[ix.costo]);
    mejor.set(numero, {
      rango,
      fecha,
      p: {
        numero,
        fecha,
        dependencia: r[ix.dependencia] == null ? null : String(r[ix.dependencia]),
        fuente: Number.isFinite(fuente) ? fuente : null,
        unidad_ejecutora: r[ix.ue] == null ? null : String(r[ix.ue]),
        jurisdiccion: r[ix.jur] == null ? null : String(r[ix.jur]),
        ingreso_compras: r[ix.ingreso] == null ? null : String(r[ix.ingreso]),
        costo_total: Number.isFinite(costo) ? costo : null,
        estado_rafam: estado,
      },
    });
  }
  return [...mejor.values()].map((v) => v.p);
}

// Secretaría de un pedido: por jurisdicción; si la jurisdicción se abre en
// varias (Jefatura), por dependencia. Mismo criterio en scripts/sync_d1.py.
const RESOLVER_SECRETARIA = `COALESCE(
  (SELECT mj.secretaria FROM mapa_jurisdicciones mj WHERE mj.jurisdiccion = p.jurisdiccion),
  (SELECT md.secretaria FROM mapa_dependencias md WHERE md.jurisdiccion = p.jurisdiccion AND md.dependencia = p.dependencia))`;

export function sentenciasPedidos(db: D1Database, anio: number, pedidos: PedidoRafam[]): D1PreparedStatement[] {
  const LOTE = 500;
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < pedidos.length; i += LOTE) {
    out.push(
      db.prepare(
        `INSERT INTO pedidos_rafam (anio, numero, fecha, dependencia, fuente, unidad_ejecutora, jurisdiccion, ingreso_compras, costo_total, estado_rafam, actualizado_en)
         SELECT ?1, json_extract(j.value, '$.numero'), json_extract(j.value, '$.fecha'), json_extract(j.value, '$.dependencia'),
                json_extract(j.value, '$.fuente'), json_extract(j.value, '$.unidad_ejecutora'), json_extract(j.value, '$.jurisdiccion'),
                json_extract(j.value, '$.ingreso_compras'), json_extract(j.value, '$.costo_total'), json_extract(j.value, '$.estado_rafam'),
                datetime('now')
         FROM json_each(?2) j WHERE 1
         ON CONFLICT (anio, numero) DO UPDATE SET
           fecha = excluded.fecha, dependencia = excluded.dependencia, fuente = excluded.fuente,
           unidad_ejecutora = excluded.unidad_ejecutora, jurisdiccion = excluded.jurisdiccion,
           ingreso_compras = excluded.ingreso_compras, costo_total = excluded.costo_total,
           estado_rafam = excluded.estado_rafam, actualizado_en = excluded.actualizado_en`,
      ).bind(anio, JSON.stringify(pedidos.slice(i, i + LOTE))),
    );
  }
  return [...out, ...sentenciasCola(db, anio)];
}

/** Después de actualizar pedidos_rafam: altas en la cola, refresco de pendientes y anulados. */
export function sentenciasCola(db: D1Database, anio: number): D1PreparedStatement[] {
  return [
    // Todo pedido nuevo del ejercicio entra a la cola como pendiente.
    db.prepare(
      `INSERT OR IGNORE INTO suministros (anio, numero, estado, origen, secretaria, fuente, dependencia, fecha_carga, mes_inicio, meses_consumo, monto)
       SELECT p.anio, p.numero, 'pendiente', 'rafam', ${RESOLVER_SECRETARIA}, p.fuente, p.dependencia, p.fecha,
              substr(p.fecha, 1, 7), 1, p.costo_total
       FROM pedidos_rafam p
       WHERE p.anio = ?1 AND COALESCE(p.estado_rafam, '') <> 'Anulado'`,
    ).bind(anio),
    // Mientras está pendiente, el monto/fuente siguen lo que diga RAFAM, y se
    // reintenta resolver la Secretaría (por si se cargó el mapa después).
    db.prepare(
      `UPDATE suministros AS s SET
         monto = p.costo_total, fuente = p.fuente, dependencia = p.dependencia,
         secretaria = COALESCE(s.secretaria, ${RESOLVER_SECRETARIA}),
         actualizado_en = datetime('now')
       FROM pedidos_rafam p
       WHERE p.anio = s.anio AND p.numero = s.numero AND s.anio = ?1 AND s.estado = 'pendiente' AND s.origen = 'rafam'`,
    ).bind(anio),
    // Anulado en RAFAM mientras esperaba aprobación: sale de la cola solo.
    db.prepare(
      `UPDATE suministros AS s SET estado = 'rechazado', motivo_rechazo = 'Anulado en RAFAM', resuelto_por = 'sync',
         resuelto_en = datetime('now'), actualizado_en = datetime('now')
       FROM pedidos_rafam p
       WHERE p.anio = s.anio AND p.numero = s.numero AND s.anio = ?1 AND s.estado = 'pendiente' AND p.estado_rafam = 'Anulado'`,
    ).bind(anio),
  ];
}

export interface ResultadoSync {
  ok: boolean;
  pedidos: number;
  nuevos: number;
  detalle: string;
}

export async function sincronizar(env: Env, origen: "cron" | "panel"): Promise<ResultadoSync> {
  const anio = ejercicio(env);
  const db = env.DB;
  const log = await db.prepare("INSERT INTO sync_log (origen) VALUES (?) RETURNING id").bind(origen).first<{ id: number }>();
  try {
    const antes = await db.prepare("SELECT COUNT(*) AS n FROM suministros WHERE anio = ?").bind(anio).first<{ n: number }>();
    const base = (env.RAFAMOR_URL || "https://rafamor.pages.dev").replace(/\/$/, "");
    const pedidos = pedidosDelEjercicio(await obtenerCategoria(base, "suministros", env.RAFAMOR_BASIC), anio);
    if (pedidos.length === 0) throw new Error(`RAFAMOR no trajo pedidos de ${anio}: no se toca nada.`);
    await db.batch(sentenciasPedidos(db, anio, pedidos));
    const despues = await db.prepare("SELECT COUNT(*) AS n FROM suministros WHERE anio = ?").bind(anio).first<{ n: number }>();
    const nuevos = (despues?.n ?? 0) - (antes?.n ?? 0);
    const detalle = `${pedidos.length} pedidos ${anio}, ${nuevos} nuevos en la cola`;
    await db.prepare("UPDATE sync_log SET fin = datetime('now'), ok = 1, pedidos = ?, nuevos = ?, detalle = ? WHERE id = ?")
      .bind(pedidos.length, nuevos, detalle, log?.id ?? 0).run();
    return { ok: true, pedidos: pedidos.length, nuevos, detalle };
  } catch (e) {
    const detalle = e instanceof Error ? e.message : String(e);
    await db.prepare("UPDATE sync_log SET fin = datetime('now'), ok = 0, detalle = ? WHERE id = ?").bind(detalle, log?.id ?? 0).run();
    return { ok: false, pedidos: 0, nuevos: 0, detalle };
  }
}
