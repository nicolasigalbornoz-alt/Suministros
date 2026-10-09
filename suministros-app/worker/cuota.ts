// Cuota por Secretaría x Fuente x Trimestre, en el mismo formato que
// generaba scripts/build_cuota_data.py (window.CUOTA_110_DATA / _TOTAL),
// para que CuotaReal en script.js la consuma sin cambios.
//
// Disponible (misma regla que CuotaReal.getAcumuladoHasta + reservas):
//   Σ cuota − Σ ejecución, trimestres 1..actual
//   − lo aprobado DESPUÉS de la fecha de corte de la última carga de cuota
//     (eso todavía no figura en la ejecución que cargó Economía).

const r2 = (v: number) => Math.round(v * 100) / 100;

export interface RegistroCuota {
  jurisdiccion: string;
  secretaria: string;
  cuotaTrimestral: number[];
  cuotaAnual: number;
  ejecucionTrimestral: number[];
  ejecucionAnual: number;
  excesoTrimestral: number[];
  excesoAnual: number;
}

export interface DatosCuota {
  fuentes: Record<string, { data: RegistroCuota[]; total: RegistroCuota }>;
  corte: string | null;
  /** "fuente::secretaria" -> monto aprobado desde el corte. */
  comprometido: Record<string, number>;
}

export function trimestreActual(fecha = new Date()): number {
  return Math.floor(fecha.getUTCMonth() / 3) + 1;
}

export async function ultimoCorte(db: D1Database, anio: number): Promise<string | null> {
  const f = await db
    .prepare("SELECT fecha_corte FROM cuota_cortes WHERE anio = ? ORDER BY id DESC LIMIT 1")
    .bind(anio)
    .first<{ fecha_corte: string }>();
  return f?.fecha_corte ?? null;
}

export async function datosCuota(db: D1Database, anio: number): Promise<DatosCuota> {
  const filas =
    (
      await db
        .prepare("SELECT jurisdiccion, secretaria, fuente, trimestre, cuota, ejecucion FROM cuota WHERE anio = ? ORDER BY jurisdiccion, secretaria")
        .bind(anio)
        .all<{ jurisdiccion: string; secretaria: string; fuente: number; trimestre: number; cuota: number; ejecucion: number }>()
    ).results ?? [];

  const porFuente = new Map<string, Map<string, RegistroCuota>>();
  for (const f of filas) {
    const fuente = String(f.fuente);
    if (!porFuente.has(fuente)) porFuente.set(fuente, new Map());
    const regs = porFuente.get(fuente)!;
    if (!regs.has(f.secretaria)) {
      regs.set(f.secretaria, {
        jurisdiccion: f.jurisdiccion ?? "",
        secretaria: f.secretaria,
        cuotaTrimestral: [0, 0, 0, 0],
        cuotaAnual: 0,
        ejecucionTrimestral: [0, 0, 0, 0],
        ejecucionAnual: 0,
        excesoTrimestral: [0, 0, 0, 0],
        excesoAnual: 0,
      });
    }
    const reg = regs.get(f.secretaria)!;
    reg.cuotaTrimestral[f.trimestre - 1] = r2(f.cuota);
    reg.ejecucionTrimestral[f.trimestre - 1] = r2(f.ejecucion);
  }

  const fuentes: DatosCuota["fuentes"] = {};
  for (const [fuente, regs] of porFuente) {
    const data = [...regs.values()].map((reg) => {
      reg.excesoTrimestral = reg.cuotaTrimestral.map((c, t) => r2(c - reg.ejecucionTrimestral[t]));
      reg.cuotaAnual = r2(reg.cuotaTrimestral.reduce((a, b) => a + b, 0));
      reg.ejecucionAnual = r2(reg.ejecucionTrimestral.reduce((a, b) => a + b, 0));
      reg.excesoAnual = r2(reg.excesoTrimestral.reduce((a, b) => a + b, 0));
      return reg;
    });
    const sumaT = (k: "cuotaTrimestral" | "ejecucionTrimestral" | "excesoTrimestral") =>
      [0, 1, 2, 3].map((t) => r2(data.reduce((a, r) => a + r[k][t], 0)));
    const sumaA = (k: "cuotaAnual" | "ejecucionAnual" | "excesoAnual") => r2(data.reduce((a, r) => a + r[k], 0));
    fuentes[fuente] = {
      data,
      total: {
        jurisdiccion: "Total",
        secretaria: "Total municipio",
        cuotaTrimestral: sumaT("cuotaTrimestral"),
        cuotaAnual: sumaA("cuotaAnual"),
        ejecucionTrimestral: sumaT("ejecucionTrimestral"),
        ejecucionAnual: sumaA("ejecucionAnual"),
        excesoTrimestral: sumaT("excesoTrimestral"),
        excesoAnual: sumaA("excesoAnual"),
      },
    };
  }

  const corte = await ultimoCorte(db, anio);
  const comprometido: Record<string, number> = {};
  if (corte) {
    const aprobados =
      (
        await db
          .prepare(
            `SELECT fuente, secretaria, SUM(COALESCE(monto, 0)) AS monto FROM suministros
             WHERE anio = ? AND estado = 'aprobado' AND origen = 'rafam' AND resuelto_en > ?
             GROUP BY fuente, secretaria`,
          )
          .bind(anio, corte)
          .all<{ fuente: number; secretaria: string; monto: number }>()
      ).results ?? [];
    for (const a of aprobados) comprometido[`${a.fuente}::${a.secretaria}`] = r2(a.monto);
  }

  return { fuentes, corte, comprometido };
}

export interface Evaluacion {
  controlada: boolean; // la fuente tiene cuota cargada (110/131)
  tieneDatos: boolean; // la Secretaría tiene fila de cuota en esa fuente
  disponible: number;
  quedaria: number;
  excede: boolean;
}

/** Cuánto le queda a la Secretaría en esa fuente y si este monto lo excede. */
export function evaluar(datos: DatosCuota, secretaria: string | null, fuente: number | null, monto: number, trimestre = trimestreActual()): Evaluacion {
  const f = fuente == null ? undefined : datos.fuentes[String(fuente)];
  if (!f) return { controlada: false, tieneDatos: false, disponible: 0, quedaria: 0, excede: false };
  const reg = secretaria ? f.data.find((r) => r.secretaria === secretaria) : undefined;
  if (!reg) return { controlada: true, tieneDatos: false, disponible: 0, quedaria: -monto, excede: true };
  const hasta = Math.min(Math.max(trimestre, 1), 4);
  const exceso = reg.excesoTrimestral.slice(0, hasta).reduce((a, b) => a + b, 0);
  const disponible = r2(exceso - (datos.comprometido[`${fuente}::${secretaria}`] ?? 0));
  const quedaria = r2(disponible - monto);
  return { controlada: true, tieneDatos: true, disponible, quedaria, excede: quedaria < 0 };
}
