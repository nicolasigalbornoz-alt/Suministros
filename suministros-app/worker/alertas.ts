// Alertas de renovación vive en otro sitio (alertas-app/, Worker
// `alertas-suministros`) sobre esta misma base. Desde acá: el pase directo a
// ese sitio (botón "Alertas") y el resumen de lo que necesita atención para
// el Inicio y el número del menú.

import { hmacHex, type Usuario } from "./auth";
import { ejercicio, error, json, type Env } from "./tipos";

/** Redirige al sitio de Alertas con un pase firmado válido por un minuto. */
export async function ir(env: Env, u: Usuario): Promise<Response> {
  if (!env.ALERTAS_URL || !env.SSO_SECRET) return error(503, "Falta configurar ALERTAS_URL / SSO_SECRET.");
  const vence = Date.now() + 60_000;
  const firma = await hmacHex(`sso:${u.legajo}.${vence}`, env.SSO_SECRET);
  const destino = `${env.ALERTAS_URL.replace(/\/$/, "")}/api/auth/sso?t=${encodeURIComponent(`${u.legajo}.${vence}.${firma}`)}&volver=%2Falertas.html`;
  return new Response(null, { status: 302, headers: { location: destino, "cache-control": "no-store" } });
}

const DIA_MS = 86_400_000;

/** Fecha de hoy en Argentina (UTC-3) como día UTC, para contar días sin corrimientos. */
function hoyAR(): number {
  const d = new Date(Date.now() - 3 * 3600_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Seguidos por este legajo que vencieron o están dentro de su aviso. Mismo
 * cálculo que alertas-app/public/alertas.js: la cobertura termina el último
 * día del mes (Mes de inicio + Meses de consumo - 1).
 */
export async function resumen(env: Env, u: Usuario): Promise<Response> {
  const filas =
    (
      await env.DB.prepare(
        `SELECT a.numero, a.aviso_dias, s.observaciones, s.mes_inicio, s.meses_consumo
         FROM alertas_seguimiento a
         JOIN suministros s ON s.anio = a.anio AND s.numero = a.numero AND s.estado = 'aprobado'
         WHERE a.legajo = ? AND a.anio = ? AND a.completado = 0`,
      )
        .bind(u.legajo, ejercicio(env))
        .all<{ numero: number; aviso_dias: number; observaciones: string | null; mes_inicio: string | null; meses_consumo: number | null }>()
    ).results ?? [];

  const hoy = hoyAR();
  const atencion = filas
    .map((f) => {
      const m = /^(\d{4})-(\d{2})$/.exec(f.mes_inicio ?? "");
      const meses = Number(f.meses_consumo);
      if (!m || !(meses >= 1)) return null;
      const idxFin = Number(m[1]) * 12 + (Number(m[2]) - 1) + (meses - 1);
      const fin = Date.UTC(Math.floor(idxFin / 12), (idxFin % 12) + 1, 0);
      const diasRestantes = Math.round((fin - hoy) / DIA_MS);
      const nivel = diasRestantes < 0 ? "vencido" : diasRestantes <= f.aviso_dias ? "por_vencer" : null;
      return nivel ? { numero: f.numero, observaciones: f.observaciones, diasRestantes, nivel } : null;
    })
    .filter((x) => x !== null)
    .sort((a, b) => a!.diasRestantes - b!.diasRestantes);

  return json({ ok: true, atencion });
}
