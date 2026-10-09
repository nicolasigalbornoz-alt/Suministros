-- ============================================================================
-- Sistema de Suministros sobre D1 -- reemplaza al Excel "seguimiento de
-- suministros 2026" como fuente de verdad.
--
-- Idea central: un PEDIDO de RAFAM (pedidos_rafam, llega solo desde
-- rafamor.pages.dev) no es un SUMINISTRO. Cada pedido del ejercicio tiene una
-- fila en `suministros` que arranca en estado 'pendiente'; recién cuando el
-- administrador lo aprueba (con chequeo de cuota del área) pasa a
-- 'aprobado' y es un suministro. 'rechazado' queda registrado para que la
-- sincronización del día siguiente no lo vuelva a meter en la cola.
-- ============================================================================

-- ---------------------------------------------------------------- usuarios

CREATE TABLE IF NOT EXISTS usuarios (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  legajo          TEXT NOT NULL UNIQUE,
  area            TEXT NOT NULL,        -- lo que se muestra; para rol 'area' es el nombre de la Secretaría de la cuota
  rol             TEXT NOT NULL DEFAULT 'area'
                  CHECK (rol IN ('admin', 'responsable', 'compras', 'direccion_compras', 'auditor', 'area')),
  clave_hash      TEXT,                 -- pbkdf2$iteraciones$sal$hash; NULL = no puede entrar
  activo          INTEGER NOT NULL DEFAULT 1,
  version_sesion  INTEGER NOT NULL DEFAULT 1,  -- se incrementa al cambiar la clave: cierra sesiones abiertas
  creado_en       TEXT NOT NULL DEFAULT (datetime('now')),
  ultimo_ingreso  TEXT
);

CREATE TABLE IF NOT EXISTS ingresos_fallidos (
  legajo    TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ingresos_fallidos ON ingresos_fallidos (legajo, creado_en);

-- ---------------------------------------------------------------- RAFAM (espejo)

-- Pedidos de Suministro tal cual los publica RAFAMOR (dataset "suministros").
-- El número se reinicia cada ejercicio: la clave es (anio, numero).
CREATE TABLE IF NOT EXISTS pedidos_rafam (
  anio              INTEGER NOT NULL,
  numero            INTEGER NOT NULL,
  fecha             TEXT,
  dependencia       TEXT,
  fuente            INTEGER,
  unidad_ejecutora  TEXT,
  jurisdiccion      TEXT,
  ingreso_compras   TEXT,
  costo_total       REAL,
  estado_rafam      TEXT,
  actualizado_en    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (anio, numero)
);

-- Hoja de ruta agregada por pedido (dataset "hoja_ruta"): fechas del circuito.
CREATE TABLE IF NOT EXISTS etapas_rafam (
  anio                INTEGER NOT NULL,
  numero              INTEGER NOT NULL,
  fecha_solgastos     TEXT,
  fecha_cotizacion    TEXT,
  fecha_adjudicacion  TEXT,
  fecha_orden         TEXT,
  ordenes             TEXT,   -- JSON: [numeros de OC no anuladas]
  fecha_recepcion     TEXT,   -- última recepción no anulada = devengamiento
  ultima_etapa        TEXT,
  ultimo_estado       TEXT,
  actualizado_en      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (anio, numero)
);

-- Qué Secretaría es cada jurisdicción de RAFAM. secretaria NULL = la
-- jurisdicción se abre en varias (Jefatura de Gabinete): ver mapa_dependencias.
CREATE TABLE IF NOT EXISTS mapa_jurisdicciones (
  jurisdiccion  TEXT PRIMARY KEY,
  secretaria    TEXT
);

CREATE TABLE IF NOT EXISTS mapa_dependencias (
  jurisdiccion  TEXT NOT NULL,
  dependencia   TEXT NOT NULL,
  secretaria    TEXT NOT NULL,
  origen        TEXT NOT NULL DEFAULT 'manual' CHECK (origen IN ('excel', 'manual')),
  PRIMARY KEY (jurisdiccion, dependencia)
);

-- ---------------------------------------------------------------- suministros

CREATE TABLE IF NOT EXISTS suministros (
  anio                      INTEGER NOT NULL,
  numero                    INTEGER NOT NULL,
  estado                    TEXT NOT NULL DEFAULT 'pendiente'
                            CHECK (estado IN ('pendiente', 'aprobado', 'rechazado')),
  origen                    TEXT NOT NULL CHECK (origen IN ('excel', 'rafam')),
  secretaria                TEXT,     -- NULL = sin resolver (no se puede aprobar hasta asignarla)
  fuente                    INTEGER,
  dependencia               TEXT,
  fecha_carga               TEXT,     -- ISO; para pedidos de RAFAM, la fecha del pedido
  mes_inicio                TEXT,     -- 'AAAA-MM'
  meses_consumo             INTEGER NOT NULL DEFAULT 1,
  oficina                   TEXT NOT NULL DEFAULT 'Secretaría de Economía',
  observaciones             TEXT,
  etiqueta                  TEXT,
  monto                     REAL,     -- costo total del pedido (RAFAM) o "Sum Total" (Excel)
  adjudicado                REAL,
  cuota_estado              TEXT,     -- 'Suficiente' | 'Insuficiente' | 'Afectado'
  cuota_asignada            TEXT,     -- heredado del Excel ('Suspendido/Revisión', 'Anulado')
  cuota_excedida            INTEGER NOT NULL DEFAULT 0,
  -- Fechas del circuito que traía el Excel (para los que no tengan hoja de ruta en RAFAMOR)
  fecha_solgastos           TEXT,
  fecha_cotizacion          TEXT,
  fecha_adjudicacion        TEXT,
  fecha_orden               TEXT,
  derivado_economia         TEXT,
  fecha_derivacion_economia TEXT,
  hora_derivacion_economia  TEXT,
  impreso                   TEXT,
  resuelto_por              TEXT,
  resuelto_en               TEXT,
  motivo_rechazo            TEXT,
  creado_en                 TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en            TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (anio, numero)
);
CREATE INDEX IF NOT EXISTS idx_suministros_estado ON suministros (anio, estado);
CREATE INDEX IF NOT EXISTS idx_suministros_secretaria ON suministros (secretaria);

-- ---------------------------------------------------------------- cuota

-- Cuota asignada y ejecución por Secretaría x Fuente x Trimestre
-- (cuota-trimestral.csv, lo mantiene Economía).
CREATE TABLE IF NOT EXISTS cuota (
  anio          INTEGER NOT NULL,
  jurisdiccion  TEXT,
  secretaria    TEXT NOT NULL,
  fuente        INTEGER NOT NULL,
  trimestre     INTEGER NOT NULL CHECK (trimestre BETWEEN 1 AND 4),
  cuota         REAL NOT NULL DEFAULT 0,
  ejecucion     REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (anio, secretaria, fuente, trimestre)
);

-- Cada carga de cuota. La ejecución vale "al corte": lo aprobado DESPUÉS de
-- esa fecha todavía no está en la ejecución y se descuenta del disponible.
CREATE TABLE IF NOT EXISTS cuota_cortes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  anio         INTEGER NOT NULL,
  fecha_corte  TEXT NOT NULL,
  cargado_por  TEXT,
  filas        INTEGER,
  cargado_en   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- varios

-- Agregados chicos que se leen enteros (Situación financiera de Analítica).
CREATE TABLE IF NOT EXISTS datos_json (
  nombre          TEXT PRIMARY KEY,
  json            TEXT NOT NULL,
  actualizado_en  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  origen     TEXT NOT NULL,          -- 'cron' | 'panel' | 'pc'
  inicio     TEXT NOT NULL DEFAULT (datetime('now')),
  fin        TEXT,
  ok         INTEGER,
  pedidos    INTEGER,
  nuevos     INTEGER,
  detalle    TEXT
);
