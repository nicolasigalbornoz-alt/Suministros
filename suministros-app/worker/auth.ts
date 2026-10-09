// Ingreso por legajo, con la misma mecánica que formulario-17/src/lib/auth.ts:
// cookie firmada con HMAC (secret SESSION_SECRET) que lleva el id del usuario
// y su "versión de sesión" (cambiar la clave la invalida); contraseñas
// PBKDF2-SHA256 con sal guardadas en D1; bloqueo tras varios intentos fallidos.

import type { Env } from "./tipos";

export const SESSION_COOKIE = "sum_sesion";
export const SESSION_MAX_AGE_S = 12 * 60 * 60; // 12 hs

export type Rol = "admin" | "responsable" | "compras" | "direccion_compras" | "auditor" | "area";

export interface Usuario {
  id: number;
  legajo: string;
  area: string;
  rol: Rol;
}

const enc = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const toB64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function hmacHex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
}

/** Comparación sin cortocircuito (no filtra por tiempos cuántos caracteres coinciden). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 20.000 iteraciones: el mismo compromiso con el tope de CPU de Workers que
// formulario-17. Quedan guardadas en el hash, se pueden subir más adelante.
const ITERACIONES = 20_000;

async function pbkdf2(clave: string, sal: Uint8Array, iteraciones: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", enc.encode(clave), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: iteraciones }, key, 256);
}

export async function hashClave(clave: string): Promise<string> {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERACIONES}$${toB64(sal)}$${toB64(await pbkdf2(clave, sal, ITERACIONES))}`;
}

export async function verificarClave(clave: string, guardado: string): Promise<boolean> {
  const [tipo, iter, sal, hash] = guardado.split("$");
  if (tipo !== "pbkdf2" || !iter || !sal || !hash) return false;
  const calculado = toB64(await pbkdf2(clave, fromB64(sal), Number(iter)));
  return timingSafeEqual(calculado, hash);
}

/** Contraseña al azar legible (sin 0/O, 1/l/i): 12 caracteres en 3 grupos. */
export function generarClave(): string {
  const alfabeto = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const c = [...bytes].map((b) => alfabeto[b % alfabeto.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

async function crearSesion(id: number, version: number, secret: string): Promise<string> {
  const cuerpo = `${id}.${version}.${Date.now().toString(36)}`;
  return `${cuerpo}.${await hmacHex(`sesion:${cuerpo}`, secret)}`;
}

async function leerSesion(valor: string | undefined, secret: string): Promise<{ id: number; version: string } | null> {
  if (!valor) return null;
  const partes = valor.split(".");
  if (partes.length !== 4) return null;
  const [id, version, emitida, firma] = partes;
  const edad = Date.now() - parseInt(emitida, 36);
  if (!(edad >= 0 && edad <= SESSION_MAX_AGE_S * 1000)) return null;
  const esperada = await hmacHex(`sesion:${id}.${version}.${emitida}`, secret);
  return timingSafeEqual(esperada, firma) ? { id: Number(id), version } : null;
}

interface FilaUsuario {
  id: number;
  legajo: string;
  area: string;
  rol: Rol;
  clave_hash: string | null;
  activo: number;
  version_sesion: number;
}

const COLUMNAS = "id, legajo, area, rol, clave_hash, activo, version_sesion";

export function leerCookie(request: Request, nombre: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const parte of header.split(";")) {
    const [k, ...v] = parte.trim().split("=");
    if (k === nombre) return v.join("=");
  }
  return undefined;
}

/** Usuario de la cookie, o null si no hay sesión válida. */
export async function usuarioDeSesion(env: Env, request: Request): Promise<Usuario | null> {
  if (!env.SESSION_SECRET) return null;
  const s = await leerSesion(leerCookie(request, SESSION_COOKIE), env.SESSION_SECRET);
  if (!s) return null;
  const f = await env.DB.prepare(`SELECT ${COLUMNAS} FROM usuarios WHERE id = ?`).bind(s.id).first<FilaUsuario>();
  if (!f || !f.activo || !f.clave_hash || String(f.version_sesion) !== s.version) return null;
  return { id: f.id, legajo: f.legajo, area: f.area, rol: f.rol };
}

const MAX_FALLIDOS = 5; // por legajo, en 15 minutos

export type ResultadoIngreso =
  | { ok: true; usuario: Usuario; cookie: string }
  | { ok: false; motivo: "config" | "bloqueado" | "invalido" };

export async function ingresar(env: Env, legajo: string, clave: string): Promise<ResultadoIngreso> {
  if (!env.SESSION_SECRET) return { ok: false, motivo: "config" };
  const db = env.DB;
  const leg = legajo.trim().slice(0, 40);

  const fallidos = await db
    .prepare("SELECT COUNT(*) AS n FROM ingresos_fallidos WHERE legajo = ? AND creado_en > datetime('now', '-15 minutes')")
    .bind(leg)
    .first<{ n: number }>();
  if ((fallidos?.n ?? 0) >= MAX_FALLIDOS) return { ok: false, motivo: "bloqueado" };

  const f = await db.prepare(`SELECT ${COLUMNAS} FROM usuarios WHERE legajo = ?`).bind(leg).first<FilaUsuario>();
  if (!f || !f.activo || !f.clave_hash || !(await verificarClave(clave, f.clave_hash))) {
    await db.batch([
      db.prepare("INSERT INTO ingresos_fallidos (legajo) VALUES (?)").bind(leg),
      db.prepare("DELETE FROM ingresos_fallidos WHERE creado_en < datetime('now', '-1 day')"),
    ]);
    return { ok: false, motivo: "invalido" };
  }

  await db.prepare("UPDATE usuarios SET ultimo_ingreso = datetime('now') WHERE id = ?").bind(f.id).run();
  return {
    ok: true,
    usuario: { id: f.id, legajo: f.legajo, area: f.area, rol: f.rol },
    cookie: await crearSesion(f.id, f.version_sesion, env.SESSION_SECRET),
  };
}

export function cookieSesion(valor: string, borrar = false): string {
  const vida = borrar ? "Max-Age=0" : `Max-Age=${SESSION_MAX_AGE_S}`;
  return `${SESSION_COOKIE}=${valor}; Path=/; HttpOnly; Secure; SameSite=Lax; ${vida}`;
}

// ---------------------------------------------------------------- permisos

export const esAdmin = (u: Usuario) => u.rol === "admin";
/** Puede cambiar la oficina (etapa del circuito) de un suministro: mismo criterio que canValidateCompras en script.js. */
export const puedeCambiarOficina = (u: Usuario) => ["admin", "compras", "direccion_compras"].includes(u.rol);
/** Un usuario de Secretaría solo ve lo suyo; el resto de los perfiles ve todo. */
export const secretariaVisible = (u: Usuario): string | null => (u.rol === "area" ? u.area : null);
