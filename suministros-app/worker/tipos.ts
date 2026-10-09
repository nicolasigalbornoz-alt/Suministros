export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_SECRET?: string;
  EJERCICIO?: string;
  RAFAMOR_URL?: string;
  /** "usuario:clave" del HTTP Basic de rafamor.pages.dev (secret). */
  RAFAMOR_BASIC?: string;
  /** Dirección del sitio de Alertas (Worker `alertas-suministros`). */
  ALERTAS_URL?: string;
  /** Compartido con el sitio de Alertas: firma el pase directo del botón "Alertas". */
  SSO_SECRET?: string;
}

export function ejercicio(env: Env): number {
  const n = Number(env.EJERCICIO);
  return Number.isInteger(n) && n > 2000 ? n : new Date().getFullYear();
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export const error = (status: number, mensaje: string, extra: Record<string, unknown> = {}) =>
  json({ ok: false, error: mensaje, ...extra }, status);

export async function leerJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
