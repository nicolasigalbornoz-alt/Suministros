// Worker del Sistema de Suministros: exige sesión antes de entregar cualquier
// página de ../sitio-suministros (assets estáticos) y expone la API sobre D1.

import * as admin from "./admin";
import * as alertas from "./alertas";
import { cookieSesion, esAdmin, ingresar, usuarioDeSesion, type Usuario } from "./auth";
import { datosCuota } from "./cuota";
import * as sum from "./suministros";
import { sincronizar } from "./sync";
import { ejercicio, error, json, type Env } from "./tipos";

// Lo único que se entrega sin sesión: la página de ingreso y lo que ella usa.
const PUBLICAS = [/^\/ingresar\.html$/, /^\/global\.css$/, /^\/fonts\//, /^\/brand\//, /^\/img\//, /^\/favicon\.png$/];
// Páginas solo para el administrador (el resto del sitio filtra por Secretaría en la API).
const PAGINAS_ADMIN = [/^\/aprobaciones\.html$/, /^\/analitica\.html$/, /^\/admin-[\w-]+\.html$/];

const redirigir = (destino: string, extra: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { location: destino, ...extra } });

/** Solo rutas internas del sitio: evita redirigir a otro dominio con ?volver=//malo. */
function rutaSegura(volver: string | null): string {
  if (!volver || !volver.startsWith("/") || volver.startsWith("//") || volver.startsWith("/\\")) return "/dashboard.html";
  return volver;
}

async function conSeguridad(resp: Response): Promise<Response> {
  const r = new Response(resp.body, resp);
  r.headers.set("x-content-type-options", "nosniff");
  r.headers.set("referrer-policy", "same-origin");
  r.headers.set("x-frame-options", "DENY");
  return r;
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const metodo = request.method;

  // ---- ingreso / salida (formularios HTML clásicos, no JSON)
  if (path === "/api/auth/ingresar" && metodo === "POST") {
    const form = await request.formData();
    const volver = rutaSegura(String(form.get("volver") ?? ""));
    const r = await ingresar(env, String(form.get("legajo") ?? ""), String(form.get("clave") ?? ""));
    if (!r.ok) return redirigir(`/ingresar.html?error=${r.motivo}&volver=${encodeURIComponent(volver)}`);
    return redirigir(volver, { "set-cookie": cookieSesion(r.cookie) });
  }
  if (path === "/api/auth/salir" && metodo === "POST") {
    return redirigir("/ingresar.html", { "set-cookie": cookieSesion("", true) });
  }

  // Todo lo demás de la API: con sesión. Las escrituras, además, solo desde
  // este mismo sitio (Origin) y en JSON (un formulario de otro sitio no puede
  // mandar application/json sin preflight): protección CSRF junto con SameSite=Lax.
  const u = await usuarioDeSesion(env, request);
  if (!u) return error(401, "Sesión vencida. Vuelva a ingresar.");
  if (metodo !== "GET") {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return error(403, "Origen no permitido.");
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) return error(415, "Se espera JSON.");
  }

  if (path === "/api/sesion") {
    return json({ ok: true, usuario: { usuario: u.legajo, area: u.area, rol: u.rol }, anio: ejercicio(env) });
  }
  if (path === "/api/suministros" && metodo === "GET") return sum.listar(env, u);
  if (path === "/api/alertas/ir" && metodo === "GET") return alertas.ir(env, u);
  if (path === "/api/alertas/resumen" && metodo === "GET") return alertas.resumen(env, u);
  if (path === "/api/cuota" && metodo === "GET") return json({ ok: true, ...(await datosCuota(env.DB, ejercicio(env))) });

  const m = path.match(/^\/api\/suministros\/(\d{4})\/(\d+)(?:\/(aprobar|rechazar|reabrir))?$/);
  if (m) {
    const anio = Number(m[1]);
    const numero = Number(m[2]);
    if (!m[3] && metodo === "PATCH") return sum.actualizar(env, u, anio, numero, request);
    if (m[3] === "aprobar" && metodo === "POST") return sum.aprobar(env, u, anio, numero, request);
    if (m[3] === "rechazar" && metodo === "POST") return sum.rechazar(env, u, anio, numero, request);
    if (m[3] === "reabrir" && metodo === "POST") return sum.reabrir(env, u, anio, numero);
  }

  if (path.startsWith("/api/datos/") || path.startsWith("/api/admin/")) {
    if (!esAdmin(u)) return error(403, "Solo para el administrador.");
    return rutasAdmin(request, env, u, path, metodo);
  }

  return error(404, "Ruta inexistente.");
}

async function rutasAdmin(request: Request, env: Env, u: Usuario, path: string, metodo: string): Promise<Response> {
  if (path === "/api/datos/financiero" && metodo === "GET") {
    const f = await env.DB.prepare("SELECT json, actualizado_en FROM datos_json WHERE nombre = 'financiero'").first<{ json: string; actualizado_en: string }>();
    return json({ ok: true, datos: f ? JSON.parse(f.json) : null, actualizado: f?.actualizado_en ?? null });
  }
  if (path === "/api/admin/estado" && metodo === "GET") return admin.estado(env);
  if (path === "/api/admin/usuarios" && metodo === "GET") return admin.listarUsuarios(env);
  if (path === "/api/admin/usuarios" && metodo === "POST") return admin.accionUsuario(env, u, request);
  if (path === "/api/admin/cuota" && metodo === "POST") return admin.cargarCuota(env, u, request);
  if (path === "/api/admin/mapa" && metodo === "GET") return admin.verMapa(env);
  if (path === "/api/admin/mapa" && metodo === "POST") return admin.guardarMapa(env, request);
  if (path === "/api/admin/sync" && metodo === "POST") return admin.sincronizarAhora(env);
  return error(404, "Ruta inexistente.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) return conSeguridad(await api(request, env, url));
    if (PUBLICAS.some((re) => re.test(path))) return conSeguridad(await env.ASSETS.fetch(request));

    const u = await usuarioDeSesion(env, request);
    if (!u) {
      if (path === "/" || path.endsWith(".html")) {
        const volver = path === "/" || path === "/index.html" ? "/dashboard.html" : path + url.search;
        return redirigir(`/ingresar.html?volver=${encodeURIComponent(volver)}`);
      }
      return new Response("Sesión requerida", { status: 401 });
    }
    if (path === "/" || path === "/index.html") return redirigir("/dashboard.html");
    // Alertas es un sitio aparte: los marcadores viejos van directo, con la sesión.
    if (path === "/alertas.html" || path === "/alertas-salud.html") return alertas.ir(env, u);
    if (PAGINAS_ADMIN.some((re) => re.test(path)) && !esAdmin(u)) return redirigir("/dashboard.html");

    const resp = await env.ASSETS.fetch(request);
    const r = new Response(resp.body, resp);
    // Las páginas cambian con cada deploy y dependen de la sesión: sin caché.
    if (path.endsWith(".html")) r.headers.set("cache-control", "no-store");
    return conSeguridad(r);
  },

  async scheduled(_evento: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sincronizar(env, "cron").then((r) => console.log(`sync RAFAMOR: ${r.ok ? "ok" : "ERROR"} ${r.detalle}`)));
  },
};
