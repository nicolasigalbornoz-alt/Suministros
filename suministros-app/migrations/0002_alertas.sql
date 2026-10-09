-- Alertas de renovación: ahora es un sitio aparte (alertas-app/, Worker
-- `alertas-suministros`) que comparte esta misma base. Antes el seguimiento
-- vivía en el localStorage de cada navegador; acá queda por legajo, así se ve
-- igual desde cualquier PC y el Inicio de Suministros puede resumirlo.
-- Misma lógica que antes (script.js, AlertasRenovacion): cada legajo elige qué
-- suministros seguir, con cuántos días de aviso, una etiqueta libre y la marca
-- de "completado".

CREATE TABLE IF NOT EXISTS alertas_seguimiento (
  legajo          TEXT NOT NULL,
  anio            INTEGER NOT NULL,
  numero          INTEGER NOT NULL,
  aviso_dias      INTEGER NOT NULL DEFAULT 30 CHECK (aviso_dias BETWEEN 1 AND 365),
  etiqueta        TEXT,
  completado      INTEGER NOT NULL DEFAULT 0,
  creado_en       TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (legajo, anio, numero)
);
