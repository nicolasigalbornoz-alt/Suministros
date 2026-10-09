// Panel del administrador: usuarios, carga de cuota, mapa de Secretarías y
// sincronización manual con RAFAMOR.

import { generarClave, hashClave, type Rol, type Usuario } from "./auth";
import { sentenciasCola, sincronizar } from "./sync";
import { ejercicio, error, json, leerJson, type Env } from "./tipos";

const ROLES: Rol[] = ["admin", "responsable", "compras", "direccion_compras", "auditor", "area"];

// ---------------------------------------------------------------- usuarios

export async function listarUsuarios(env: Env): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT legajo, area, rol, activo, clave_hash IS NOT NULL AS tiene_clave, ultimo_ingreso
     FROM usuarios ORDER BY rol = 'area', area, legajo`,
  ).all();
  return json({ ok: true, usuarios: r.results ?? [] });
}

export async function accionUsuario(env: Env, admin: Usuario, request: Request): Promise<Response> {
  const b = await leerJson<{ accion?: string; legajo?: string; area?: string; rol?: string }>(request);
  if (!b?.accion || !b.legajo) return error(400, "Falta la acción o el legajo.");
  const legajo = String(b.legajo).trim();
  if (!/^\d{3,10}$/.test(legajo)) return error(400, "El legajo tiene que ser numérico.");
  const db = env.DB;

  switch (b.accion) {
    case "crear": {
      const area = String(b.area ?? "").trim();
      const rol = (b.rol ?? "area") as Rol;
      if (!area) return error(400, "Falta el área.");
      if (!ROLES.includes(rol)) return error(400, "Rol inválido.");
      const clave = generarClave();
      const r = await db
        .prepare("INSERT OR IGNORE INTO usuarios (legajo, area, rol, clave_hash) VALUES (?, ?, ?, ?)")
        .bind(legajo, area.slice(0, 120), rol, await hashClave(clave))
        .run();
      if (!r.meta.changes) return error(409, `El legajo ${legajo} ya existe.`);
      return json({ ok: true, legajo, clave });
    }
    case "clave": {
      const clave = generarClave();
      const r = await db
        .prepare("UPDATE usuarios SET clave_hash = ?, version_sesion = version_sesion + 1 WHERE legajo = ?")
        .bind(await hashClave(clave), legajo)
        .run();
      if (!r.meta.changes) return error(404, `No existe el legajo ${legajo}.`);
      return json({ ok: true, legajo, clave });
    }
    case "activar":
    case "desactivar": {
      if (b.accion === "desactivar" && legajo === admin.legajo) return error(409, "No puede desactivar su propio usuario.");
      const r = await db
        .prepare("UPDATE usuarios SET activo = ?, version_sesion = version_sesion + 1 WHERE legajo = ?")
        .bind(b.accion === "activar" ? 1 : 0, legajo)
        .run();
      if (!r.meta.changes) return error(404, `No existe el legajo ${legajo}.`);
      return json({ ok: true });
    }
    default:
      return error(400, "Acción desconocida.");
  }
}

// ---------------------------------------------------------------- cuota

/** Reemplaza la cuota del ejercicio con el contenido de cuota-trimestral.csv. */
export async function cargarCuota(env: Env, admin: Usuario, request: Request): Promise<Response> {
  const b = await leerJson<{ csv?: string; fechaCorte?: string }>(request);
  if (!b?.csv) return error(400, "Falta el contenido del CSV.");
  const fechaCorte = String(b.fechaCorte ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaCorte)) return error(400, "Indique la fecha de corte de la ejecución (AAAA-MM-DD).");

  const lineas = b.csv.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const sep = (lineas[0].match(/;/g)?.length ?? 0) > (lineas[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const encabezado = lineas[0].split(sep).map((c) => c.trim().toLowerCase());
  const esperado = ["jurisdiccion", "secretaria", "fuente", "trimestre", "cuota", "ejecucion"];
  if (esperado.some((c, i) => encabezado[i] !== c)) {
    return error(400, `El encabezado tiene que ser: ${esperado.join(sep)}`);
  }

  const filas: { jurisdiccion: string; secretaria: string; fuente: number; trimestre: number; cuota: number; ejecucion: number }[] = [];
  for (let n = 1; n < lineas.length; n++) {
    const c = lineas[n].split(sep).map((x) => x.trim());
    const fila = {
      jurisdiccion: c[0],
      secretaria: c[1],
      fuente: Number(c[2]),
      trimestre: Number(c[3]),
      cuota: Number(c[4]),
      ejecucion: Number(c[5]),
    };
    if (!fila.secretaria || !Number.isInteger(fila.fuente) || !(fila.trimestre >= 1 && fila.trimestre <= 4)
        || !Number.isFinite(fila.cuota) || !Number.isFinite(fila.ejecucion)) {
      return error(400, `Fila ${n + 1} inválida: "${lineas[n]}" (los montos van sin separador de miles, con punto decimal).`);
    }
    filas.push(fila);
  }
  if (filas.length === 0) return error(400, "El CSV no tiene filas.");

  const anio = ejercicio(env);
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM cuota WHERE anio = ?").bind(anio),
    db.prepare(
      `INSERT INTO cuota (anio, jurisdiccion, secretaria, fuente, trimestre, cuota, ejecucion)
       SELECT ?1, json_extract(value, '$.jurisdiccion'), json_extract(value, '$.secretaria'), json_extract(value, '$.fuente'),
              json_extract(value, '$.trimestre'), json_extract(value, '$.cuota'), json_extract(value, '$.ejecucion')
       FROM json_each(?2)`,
    ).bind(anio, JSON.stringify(filas)),
    db.prepare("INSERT INTO cuota_cortes (anio, fecha_corte, cargado_por, filas) VALUES (?, ?, ?, ?)").bind(anio, fechaCorte, admin.legajo, filas.length),
  ]);
  return json({ ok: true, filas: filas.length, fechaCorte });
}

// ---------------------------------------------------------------- mapa de Secretarías

export async function verMapa(env: Env): Promise<Response> {
  const anio = ejercicio(env);
  const db = env.DB;
  const [sinResolver, dependencias, secretarias] = await Promise.all([
    db.prepare(
      `SELECT p.jurisdiccion, p.dependencia, COUNT(*) AS pedidos, SUM(COALESCE(p.costo_total, 0)) AS monto
       FROM suministros s JOIN pedidos_rafam p ON p.anio = s.anio AND p.numero = s.numero
       WHERE s.anio = ? AND s.estado = 'pendiente' AND s.secretaria IS NULL
       GROUP BY p.jurisdiccion, p.dependencia ORDER BY pedidos DESC`,
    ).bind(anio).all(),
    db.prepare("SELECT jurisdiccion, dependencia, secretaria, origen FROM mapa_dependencias ORDER BY jurisdiccion, dependencia").all(),
    db.prepare("SELECT DISTINCT secretaria FROM cuota WHERE anio = ? ORDER BY secretaria").bind(anio).all(),
  ]);
  return json({
    ok: true,
    sinResolver: sinResolver.results ?? [],
    dependencias: dependencias.results ?? [],
    secretarias: (secretarias.results ?? []).map((r) => (r as { secretaria: string }).secretaria),
  });
}

export async function guardarMapa(env: Env, request: Request): Promise<Response> {
  const b = await leerJson<{ jurisdiccion?: string; dependencia?: string; secretaria?: string }>(request);
  const jurisdiccion = String(b?.jurisdiccion ?? "").trim();
  const dependencia = String(b?.dependencia ?? "").trim();
  const secretaria = String(b?.secretaria ?? "").trim();
  if (!jurisdiccion || !dependencia || !secretaria) return error(400, "Faltan jurisdicción, dependencia o Secretaría.");
  const db = env.DB;
  await db.batch([
    db.prepare(
      `INSERT INTO mapa_dependencias (jurisdiccion, dependencia, secretaria, origen) VALUES (?, ?, ?, 'manual')
       ON CONFLICT (jurisdiccion, dependencia) DO UPDATE SET secretaria = excluded.secretaria, origen = 'manual'`,
    ).bind(jurisdiccion, dependencia, secretaria),
    // Los pendientes que estaban sin Secretaría se resuelven en el acto.
    ...sentenciasCola(db, ejercicio(env)).slice(1, 2),
  ]);
  return json({ ok: true });
}

// ---------------------------------------------------------------- estado y sync

export async function estado(env: Env): Promise<Response> {
  const anio = ejercicio(env);
  const db = env.DB;
  const [conteos, syncs, corte] = await Promise.all([
    db.prepare("SELECT estado, origen, COUNT(*) AS n FROM suministros WHERE anio = ? GROUP BY estado, origen").bind(anio).all(),
    db.prepare("SELECT origen, inicio, fin, ok, pedidos, nuevos, detalle FROM sync_log ORDER BY id DESC LIMIT 10").all(),
    db.prepare("SELECT fecha_corte, cargado_por, cargado_en, filas FROM cuota_cortes WHERE anio = ? ORDER BY id DESC LIMIT 1").bind(anio).first(),
  ]);
  return json({ ok: true, anio, conteos: conteos.results ?? [], syncs: syncs.results ?? [], corte: corte ?? null });
}

export async function sincronizarAhora(env: Env): Promise<Response> {
  const r = await sincronizar(env, "panel");
  return json(r, r.ok ? 200 : 502);
}
