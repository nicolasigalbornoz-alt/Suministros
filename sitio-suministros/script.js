'use strict';

/* ======================================================================
   API
   Todo dato sale del Worker `suministros` (suministros-app/): la sesión es
   una cookie firmada que valida el servidor, y cada lectura/escritura pasa
   por /api/*. Un 401 (sesión vencida) lleva de vuelta al ingreso.
   ====================================================================== */
const Api = (() => {
    function aIngresar() {
        const volver = window.location.pathname + window.location.search;
        window.location.href = `/ingresar.html?volver=${encodeURIComponent(volver)}`;
    }

    async function pedir(method, path, body) {
        const resp = await fetch(path, {
            method,
            credentials: 'same-origin',
            headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        if (resp.status === 401) {
            aIngresar();
            throw new Error('Sesión vencida.');
        }
        const datos = await resp.json().catch(() => ({}));
        if (!resp.ok || datos.ok === false) {
            const error = new Error(datos.error || `El servidor respondió ${resp.status}.`);
            error.status = resp.status;
            error.datos = datos;
            throw error;
        }
        return datos;
    }

    return {
        get: (path) => pedir('GET', path),
        post: (path, body = {}) => pedir('POST', path, body),
        patch: (path, body = {}) => pedir('PATCH', path, body),
        aIngresar
    };
})();

/* ======================================================================
   AUTH
   La sesión la valida el servidor (ver suministros-app/worker/auth.ts:
   contraseña por usuario, cookie firmada). Acá solo se guarda lo que
   devolvió /api/sesion -- { usuario: legajo, area, rol } -- para que cada
   página sepa quién está y qué mostrarle. Los permisos de abajo solo
   deciden qué se MUESTRA: la API vuelve a verificarlos en cada acción.
   ====================================================================== */
const Auth = (() => {
    const ROLE_LABELS = {
        admin: 'Administración General · Acceso total',
        responsable: 'Responsable de Área',
        compras: 'Dirección de Compras · Validación',
        direccion_compras: 'Responsable de Área · Autoridad máxima',
        auditor: 'Consulta / Auditoría',
        area: 'Usuario de Secretaría'
    };

    // Permisos centralizados por rol: sumar un rol nuevo solo requiere una
    // entrada acá, sin tocar la lógica de negocio de cada página.
    // isAreaUser: cuenta de Secretaría, acceso restringido solo a Nuevo
    // suministro (simulador ficticio) y a su propia cuota real.
    // canValidateCompras: además de consultar Suministros, puede editar la
    // aprobación/desaprobación y la oficina (ubicación) de cada registro.
    const ROLE_PERMISSIONS = {
        admin: { canAuthorize: true, canValidateCompras: true, isDireccionCompras: true, isAreaUser: false },
        responsable: { canAuthorize: true, canValidateCompras: false, isDireccionCompras: false, isAreaUser: false },
        compras: { canAuthorize: false, canValidateCompras: true, isDireccionCompras: false, isAreaUser: false },
        direccion_compras: { canAuthorize: false, canValidateCompras: true, isDireccionCompras: true, isAreaUser: false },
        auditor: { canAuthorize: false, canValidateCompras: false, isDireccionCompras: false, isAreaUser: false },
        area: { canAuthorize: true, canValidateCompras: false, isDireccionCompras: false, isAreaUser: true }
    };

    const DEFAULT_PERMISSIONS = { canAuthorize: false, canValidateCompras: false, isDireccionCompras: false, isAreaUser: false };

    let sesion = null;

    // null si no hay sesión válida (quien llama manda a /ingresar.html).
    async function cargarSesion() {
        const resp = await fetch('/api/sesion', { credentials: 'same-origin' });
        if (resp.status === 401) return null;
        if (!resp.ok) throw new Error(`No se pudo verificar la sesión (${resp.status}).`);
        const body = await resp.json();
        sesion = body.usuario;
        return sesion;
    }

    function getSession() {
        return sesion;
    }

    function roleLabel(rol) {
        return ROLE_LABELS[rol] || rol;
    }

    function permissionsFor(rol) {
        return ROLE_PERMISSIONS[rol] || DEFAULT_PERMISSIONS;
    }

    return { cargarSesion, getSession, roleLabel, permissionsFor };
})();

/* ======================================================================
   STORE
   Datos de negocio (suministros, cuota, partidas) compartidos entre
   páginas. Sin backend aún: se persiste en sessionStorage para que la
   navegación entre páginas no pierda lo cargado durante la sesión.
   ====================================================================== */
const Store = (() => {
    const STATE_KEY = 'sgsStoreState';

    // Partidas presupuestarias contra las que se imputa cada suministro. El
    // crédito vigente es el techo autorizado por partida; lo comprometido se
    // calcula en vivo a partir de los suministros provisionales/aprobados.
    const PARTIDAS = [
        { codigo: '1.2.3.04', nombre: 'Bienes de consumo', creditoVigente: 320 },
        { codigo: '1.2.5.02', nombre: 'Servicios técnicos y profesionales', creditoVigente: 210 },
        { codigo: '1.3.1.01', nombre: 'Mantenimiento y reparaciones', creditoVigente: 150 },
        { codigo: '1.2.7.09', nombre: 'Equipamiento e insumos informáticos', creditoVigente: 95 }
    ];

    const INITIAL_SUPPLIES = [
        {
            id: 'SGS-P-001',
            area: 'Secretaría de Economía',
            periodo: '2026-01 → 2026-03',
            monto: 42,
            estado: 'provisional',
            remito: 'APR-2026-001',
            vigencia: 'Vigente',
            detalle: 'Aprobación provisional emitida por Responsable de Área. La ID queda vigente mientras la cuota esté reservada y puede ser anulada antes de Compras.',
            devengamiento: 35,
            partidaCodigo: '1.2.3.04',
            alertaDiasAnticipacion: 15
        },
        {
            id: 'SGS-P-002',
            area: 'Dirección de Compras',
            periodo: '2026-02 → 2026-04',
            monto: 25,
            estado: 'approved',
            remito: 'APR-2026-002',
            vigencia: 'Definitiva',
            detalle: 'Aprobación definitiva por Compras validada con ID vigente y remito presentado en forma formal.',
            devengamiento: 55,
            partidaCodigo: '1.2.5.02',
            alertaDiasAnticipacion: 15
        },
        {
            id: 'SGS-P-003',
            area: 'Subsecretaría de Administración',
            periodo: '2026-03 → 2026-05',
            monto: 18,
            estado: 'cancelled',
            remito: 'APR-2026-003',
            vigencia: 'No vigente',
            detalle: 'Aprobación provisional deshecha: la ID dejó de ser válida y la cuota reservada fue liberada.',
            devengamiento: 18,
            partidaCodigo: '1.3.1.01',
            alertaDiasAnticipacion: 20
        }
    ];

    function loadState() {
        try {
            const raw = sessionStorage.getItem(STATE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && Array.isArray(parsed.suppliesData)) return parsed;
            }
        } catch (error) {
            // Estado corrupto o inexistente: se reconstruye desde los datos iniciales.
        }
        return {
            suppliesData: structuredClone(INITIAL_SUPPLIES)
        };
    }

    let state = loadState();

    function persist() {
        sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
    }

    function getSupplies() {
        return state.suppliesData;
    }

    function getPartidas() {
        return PARTIDAS;
    }

    function getPartida(codigo) {
        return PARTIDAS.find((partida) => partida.codigo === codigo) || null;
    }

    // Comprometido: suma de suministros provisionales o aprobados imputados a la
    // partida (el anulado libera el crédito). excludeId permite recalcular sin
    // contar el propio registro, útil al revisar el remanente antes de guardar.
    function getPartidaComprometido(codigo, excludeId) {
        return state.suppliesData
            .filter((item) => item.partidaCodigo === codigo && item.id !== excludeId && item.estado !== 'cancelled')
            .reduce((sum, item) => sum + item.monto, 0);
    }

    function getPartidaDisponible(codigo, excludeId) {
        const partida = getPartida(codigo);
        if (!partida) return 0;
        return partida.creditoVigente - getPartidaComprometido(codigo, excludeId);
    }

    function nextId() {
        return `SGS-P-${String(state.suppliesData.length + 1).padStart(3, '0')}`;
    }

    function addSupply(supply) {
        state.suppliesData.unshift(supply);
        persist();
    }

    function updateSupply(id, patch) {
        const item = state.suppliesData.find((supply) => supply.id === id);
        if (!item) return null;
        Object.assign(item, patch);
        persist();
        return item;
    }

    return {
        getSupplies,
        getPartidas, getPartida, getPartidaComprometido, getPartidaDisponible,
        nextId, addSupply, updateSupply
    };
})();

/* ======================================================================
   SUPPLY UTILS
   Helpers de formato y de cálculo de alertas, sin estado propio, usados
   por las páginas que muestran suministros (Inicio y Suministros).
   ====================================================================== */
const SupplyUtils = (() => {
    const DEFAULT_ALERTA_DIAS = 15;

    const STATUS_INFO = {
        provisional: { text: 'Provisional', class: 'status-pending' },
        approved: { text: 'Aprobado', class: 'status-approved' },
        cancelled: { text: 'Anulado', class: 'status-rejected' }
    };

    function statusMap(status) {
        return STATUS_INFO[status] || { text: 'Sin estado', class: 'status-pending' };
    }

    function formatNumber(value) {
        return Number(value).toLocaleString('es-AR');
    }

    // Cierre de un período "YYYY-MM → YYYY-MM": último día del mes de cierre.
    function getCierreDate(periodo) {
        const cierre = periodo.split('→')[1]?.trim();
        if (!cierre) return null;
        const [year, month] = cierre.split('-').map(Number);
        if (!year || !month) return null;
        return new Date(year, month, 0);
    }

    function getAlertStatus(supply) {
        if (supply.estado !== 'provisional') return { level: 'none', dias: null };

        const cierreDate = getCierreDate(supply.periodo);
        if (!cierreDate) return { level: 'none', dias: null };

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        cierreDate.setHours(0, 0, 0, 0);

        const diffDias = Math.round((cierreDate - today) / (1000 * 60 * 60 * 24));
        const umbral = Number.isFinite(supply.alertaDiasAnticipacion) ? supply.alertaDiasAnticipacion : DEFAULT_ALERTA_DIAS;

        if (diffDias < 0) return { level: 'overdue', dias: diffDias };
        if (diffDias <= umbral) return { level: 'warning', dias: diffDias };
        return { level: 'none', dias: diffDias };
    }

    // Para inputs que disparan un re-render caro (listas de cientos de
    // filas) en cada tecla: espera a que la persona deje de tipear en vez
    // de volver a renderizar en cada pulsación.
    function debounce(fn, esperaMs = 200) {
        let timeoutId;
        return (...args) => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => fn(...args), esperaMs);
        };
    }

    // La cobertura de un suministro (Mes de inicio + Meses de consumo) se
    // calcula en el sitio de Alertas (alertas-app/public/alertas.js).

    return {
        DEFAULT_ALERTA_DIAS, statusMap, formatNumber, getCierreDate, getAlertStatus, debounce
    };
})();

/* ======================================================================
   MODAL
   Pop up modal compartido, usado para las advertencias que interrumpen un
   procedimiento (por ejemplo, intentar cargar un suministro ya existente).
   Es bloqueante por diseño: mientras está abierto no se puede operar el
   formulario que está detrás, y el procedimiento solo continúa si quien
   llama lo decide después de cerrarlo.
   ====================================================================== */
const Modal = (() => {
    let overlay = null;
    let lastFocused = null;

    const ICONS = { danger: '!', warning: '!', success: '✓', info: 'i' };

    function close() {
        if (!overlay) return;
        overlay.remove();
        overlay = null;
        document.removeEventListener('keydown', handleKeydown);
        lastFocused?.focus();
        lastFocused = null;
    }

    function handleKeydown(event) {
        if (event.key === 'Escape') close();
    }

    // detalle: pares [etiqueta, valor] que se muestran como ficha del
    // registro en conflicto, para que el usuario identifique el suministro
    // ya cargado sin tener que salir de la pantalla.
    // onPrimary/onSecondary: callbacks opcionales, se llaman DESPUÉS de
    // cerrar el modal (no antes) -- así si el callback abre otro modal o
    // hace foco en algo, no se pisa con el cierre de este. secondaryLabel
    // sin onSecondary sigue siendo válido: un botón que solo cierra (ej.
    // "Cancelar"), igual que ya hacía primaryLabel por defecto.
    function open({ variant = 'danger', title, message, detalle = [], primaryLabel = 'Entendido', onPrimary, secondaryLabel, onSecondary }) {
        close();
        lastFocused = document.activeElement;

        const detalleHtml = detalle.length
            ? `<div class="modal-detail">${detalle
                .filter(([, value]) => value !== null && value !== undefined && value !== '')
                .map(([label, value]) => `<div><strong>${label}:</strong> ${value}</div>`)
                .join('')}</div>`
            : '';

        const secondaryHtml = secondaryLabel
            ? `<button type="button" class="btn ghost" id="modalSecondaryBtn">${secondaryLabel}</button>`
            : '';

        overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-card modal-${variant}" role="alertdialog" aria-modal="true" aria-labelledby="modalTitle">
                <div class="modal-header-row">
                    <span class="modal-icon" aria-hidden="true">${ICONS[variant] || ICONS.info}</span>
                    <h3 class="modal-title" id="modalTitle">${title}</h3>
                </div>
                <div class="modal-message">${message}</div>
                ${detalleHtml}
                <div class="modal-actions">
                    ${secondaryHtml}
                    <button type="button" class="btn primary" id="modalPrimaryBtn">${primaryLabel}</button>
                </div>
            </div>
        `;

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        document.addEventListener('keydown', handleKeydown);

        document.body.appendChild(overlay);
        document.getElementById('modalPrimaryBtn')?.addEventListener('click', () => {
            close();
            if (onPrimary) onPrimary();
        });
        document.getElementById('modalSecondaryBtn')?.addEventListener('click', () => {
            close();
            if (onSecondary) onSecondary();
        });
        document.getElementById('modalPrimaryBtn')?.focus();
    }

    return { open, close };
})();

/* ======================================================================
   LAYOUT
   Encabezado, barra lateral y pie: única fuente de verdad para el marco
   visual, compartida por todas las páginas. El encabezado centraliza el
   dato de sesión y el cierre de sesión para no repetirlo por página.
   ====================================================================== */
const Layout = (() => {
    const NAV_ITEMS = [
        { key: 'inicio', label: 'Inicio', href: 'dashboard.html' },
        // Suministros es accesible para todos: los perfiles centrales ven la
        // planilla completa y cada Secretaría ve únicamente sus suministros.
        { key: 'suministros', label: 'Suministros', href: 'suministros.html' },
        { key: 'nuevo', label: 'Nuevo suministro', href: 'nuevo-suministro.html', requiresAuthorize: true },
        { key: 'presupuesto', label: 'Presupuesto', href: 'presupuesto.html', requiresNonArea: true },
        // Difusión: a diferencia de Presupuesto, sí es para áreas también
        // (es justamente el reporte pensado para comunicarles su propia
        // cuota liberada) — por eso no lleva requiresNonArea.
        { key: 'difusion', label: 'Difusión', href: 'difusion.html' },
        // Devengamiento: mismo criterio que Difusión -- cada área quiere
        // ver cuándo se le va a recepcionar lo suyo, no solo los perfiles
        // centrales.
        { key: 'devengamiento', label: 'Devengamiento', href: 'devengamiento.html' },
        // Analítica y Aprobaciones: visibles únicamente para el legajo
        // 310019 (no es un permiso de rol, es ese usuario puntual).
        { key: 'analitica', label: 'Analítica', href: 'analitica.html', requiresUsuario310019: true },
        { key: 'aprobaciones', label: 'Aprobaciones', href: 'aprobaciones.html', requiresUsuario310019: true, badge: 'aprobaciones' },
        // Alertas: disponible para cualquier perfil, cada legajo ve y
        // gestiona únicamente su propio seguimiento. Es un sitio aparte (ver
        // AlertasResumen): el link pasa directo con la sesión iniciada.
        { key: 'alertas', label: 'Alertas', href: '/api/alertas/ir', badge: 'alertas' },
        // Remitos: cada legajo ve los suyos ya aprobados (ver
        // RemitosAprobados) -- el badge es la única "notificación" posible
        // de que se aprobó algo, sin backend propio ni push/email.
        { key: 'remitos', label: 'Mis remitos', href: 'remitos.html', badge: 'remitos' }
    ];

    const HELP_ITEMS = [
        { label: 'Instructivo APP', href: 'manual.html' },
        // Antes era un link muerto (href="#"); ahora manda directo a las
        // preguntas frecuentes del manual, que es soporte real.
        { label: 'Soporte', href: 'manual.html#faq' }
    ];

    // Encabezado y pie institucionales de sde_v2 (global.css), iguales a los
    // del sitio de Alertas. #appSidebar queda sin uso (ver styles.css,
    // display:none) — se mantiene en el HTML de cada página por si hace
    // falta reactivarlo, pero Layout ya no le escribe nada.
    function render(activeKey) {
        renderTopbar(activeKey);
        renderFooter();
    }

    function renderTopbar(activeKey) {
        const header = document.getElementById('appHeader');
        if (!header) return;

        const session = Auth.getSession();

        // Login: página desnuda, sin barra de navegación.
        if (!session) {
            header.innerHTML = '';
            return;
        }

        const permissions = Auth.permissionsFor(session.rol);

        // Badge de pendientes de aprobación: solo tiene sentido para
        // 310019, y solo si ya cargó suministros-data.js en esta página
        // (getPendientesAprobacion cae a [] si no, no rompe nada).
        const pendientesCount = (session.usuario === '310019' && typeof SuministrosData !== 'undefined')
            ? SuministrosData.getPendientesAprobacion().length
            : 0;

        // Badge de Alertas: cuántos suministros seguidos por ESTE legajo ya
        // están vencidos o por vencer (ver AlertasResumen).
        const alertasCount = AlertasResumen.getAtencion().length;

        // Badge de Mis remitos: cuántos suministros de ESTA área ya se
        // aprobaron pero este legajo todavía no entró a verlos (ver
        // RemitosAprobados) -- la "notificación" de que se aprobó algo.
        const remitosCount = (typeof RemitosAprobados !== 'undefined' && typeof SuministrosData !== 'undefined')
            ? RemitosAprobados.getNuevosCount(session.usuario, session.area)
            : 0;

        const BADGE_COUNTS = { aprobaciones: pendientesCount, alertas: alertasCount, remitos: remitosCount };

        const links = NAV_ITEMS
            .filter((item) => (!item.requiresAuthorize || permissions.canAuthorize)
                && (!item.requiresNonArea || !permissions.isAreaUser)
                && (!item.requiresUsuario310019 || session.usuario === '310019'))
            .map((item) => {
                const count = item.badge ? (BADGE_COUNTS[item.badge] || 0) : 0;
                return `<a href="${item.href}"${item.key === activeKey ? ' class="active" aria-current="page"' : ''}>${item.label}${count > 0 ? ` <span class="nav-badge">${count}</span>` : ''}</a>`;
            })
            .join('');

        const helpLinks = HELP_ITEMS
            .map((item) => `<a href="${item.href}" class="nav-ayuda">${item.label}</a>`)
            .join('');

        // Encabezado institucional de sde_v2 (global.css): grafito con filete
        // rojo, escudo + Subsecretaría, cuenta a la derecha y el menú en su
        // propia fila debajo.
        header.className = 'municipal-header';
        header.innerHTML = `
            <div class="municipal-header-inner">
                <a href="dashboard.html" class="municipal-brand" aria-label="Sistema de Suministros · Inicio">
                    <img src="/brand/moron-logo.png" alt="Municipio de Morón" width="72" height="74">
                    <span>Subsecretaría de Planificación<br>Presupuestaria y Estadística<br><strong>Sistema de Suministros</strong></span>
                </a>
                <div class="municipal-account">
                    <div>
                        <strong>${escapeHtmlTexto(session.area)}</strong>
                        <small>Legajo ${escapeHtmlTexto(session.usuario)} · ${Auth.roleLabel(session.rol)}</small>
                    </div>
                    <button id="logoutBtn" class="header-button" type="button">Salir<span aria-hidden="true">↗</span></button>
                </div>
                <nav class="municipal-nav" aria-label="Secciones">
                    ${links}
                    ${helpLinks}
                </nav>
            </div>
        `;

        // La cookie de sesión es HttpOnly: solo el servidor la puede borrar.
        document.getElementById('logoutBtn')?.addEventListener('click', () => {
            const form = document.createElement('form');
            form.method = 'post';
            form.action = '/api/auth/salir';
            document.body.appendChild(form);
            form.submit();
        });
    }

    function renderFooter() {
        const footer = document.getElementById('appFooter');
        if (!footer) return;

        footer.className = 'municipal-footer';
        footer.innerHTML = `
            <div>
                <img src="/brand/moron-logo.png" alt="Municipio de Morón" width="60" height="72" loading="lazy">
                <p>
                    Subsecretaría de Planificación Presupuestaria y Estadística<br>
                    <span><a href="mailto:dir.presupuesto@moron.gob.ar">dir.presupuesto@moron.gob.ar</a> · Interno 7714</span>
                </p>
                <nav class="footer-links" aria-label="Enlaces del pie">
                    <a href="manual.html">Instructivo</a>
                    <a href="https://www.moron.gob.ar/" target="_blank" rel="noreferrer">Sitio del Municipio <span aria-hidden="true">↗</span></a>
                </nav>
            </div>
        `;
    }

    function escapeHtmlTexto(texto) {
        return String(texto ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    return { render };
})();

/* ======================================================================
   LOGIN PAGE
   ====================================================================== */
const LoginPage = (() => {
    const REMEMBER_KEY = 'sgsRememberedUser';

    function init() {
        const form = document.getElementById('loginForm');
        if (!form) return;

        form.addEventListener('submit', handleSubmit);
        document.getElementById('toggleClave')?.addEventListener('click', toggleClaveVisibility);

        prefillRememberedUser();
        document.getElementById('usuario')?.focus();
    }

    function prefillRememberedUser() {
        const remembered = localStorage.getItem(REMEMBER_KEY);
        if (!remembered) return;

        const usuarioInput = document.getElementById('usuario');
        const recordarInput = document.getElementById('recordarUsuario');
        if (usuarioInput) usuarioInput.value = remembered;
        if (recordarInput) recordarInput.checked = true;
        document.getElementById('clave')?.focus();
    }

    function toggleClaveVisibility() {
        const claveInput = document.getElementById('clave');
        const toggleBtn = document.getElementById('toggleClave');
        if (!claveInput || !toggleBtn) return;

        const isHidden = claveInput.type === 'password';
        claveInput.type = isHidden ? 'text' : 'password';
        toggleBtn.textContent = isHidden ? 'Ocultar' : 'Ver';
        toggleBtn.setAttribute('aria-label', isHidden ? 'Ocultar clave' : 'Mostrar clave');
        toggleBtn.setAttribute('aria-pressed', String(isHidden));
    }

    function handleSubmit(event) {
        event.preventDefault();

        const usuario = document.getElementById('usuario').value.trim();
        const clave = document.getElementById('clave').value;
        const recordar = document.getElementById('recordarUsuario')?.checked;
        const messageDiv = document.getElementById('loginMessage');
        const submitBtn = document.getElementById('loginSubmitBtn');

        if (!usuario || !clave) {
            setMessage(messageDiv, 'Por favor, complete todos los campos.', 'error');
            return;
        }

        const user = Auth.findUser(usuario, clave);
        if (!user) {
            setMessage(messageDiv, 'Legajo o clave incorrectos.', 'error');
            return;
        }

        if (recordar) {
            localStorage.setItem(REMEMBER_KEY, usuario);
        } else {
            localStorage.removeItem(REMEMBER_KEY);
        }

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Ingresando...';
        }

        Auth.setSession(user);
        window.location.href = 'dashboard.html';
    }

    function setMessage(element, text, type) {
        if (!element) return;
        element.textContent = text;
        element.className = `message ${type}`;
    }

    return { init };
})();

/* ======================================================================
   HOME PAGE (dashboard.html)
   Vista de inicio, concisa: KPIs, cuota, alertas activas y accesos
   directos al resto del sistema.
   ====================================================================== */
const HomePage = (() => {
    let session = null;
    let permissions = null;

    const QUICK_LINKS = [
        { key: 'suministros', href: 'suministros.html', title: 'Suministros', text: 'Planilla oficial completa: búsqueda, filtro por secretaría y detalle por registro.', requiresNonArea: true },
        { key: 'misSuministros', href: 'suministros.html', title: 'Mis suministros', text: 'Los suministros cargados por su Secretaría y la oficina en la que se encuentra cada uno.', requiresArea: true },
        { key: 'nuevo', href: 'nuevo-suministro.html', title: 'Nuevo suministro', text: 'Emitir una autorización provisional con reserva de cuota.', requiresAuthorize: true },
        { key: 'presupuesto', href: 'presupuesto.html', title: 'Presupuesto', text: 'Cuota, ejecución y exceso/economía real por Secretaría.', requiresNonArea: true }
    ];

    function init(activeSession) {
        session = activeSession;
        permissions = Auth.permissionsFor(session.rol);

        if (permissions.isAreaUser) {
            renderAreaHome();
            renderQuickLinks();
            renderRenovacion();
            return;
        }

        renderStats();
        renderQuota();
        renderAlerts();
        renderQuickLinks();
        renderRenovacion();
    }

    // Seguimiento de renovación (ver AlertasResumen): solo del propio
    // legajo, y solo se muestra si hay algo que realmente necesite
    // atención (vencido o por vencer) — si todo está vigente o todavía no
    // sigue ningún suministro, no hay nada que mostrar acá, no genera
    // ruido en el panel de todos los días. Cada aviso lleva al sitio de Alertas.
    function renderRenovacion() {
        const section = document.getElementById('renovacionSection');
        const list = document.getElementById('renovacionList');
        if (!section || !list) return;

        const atencion = AlertasResumen.getAtencion();
        if (atencion.length === 0) {
            section.hidden = true;
            return;
        }

        section.hidden = false;
        const MAX_VISIBLE = 6;
        const visibles = atencion.slice(0, MAX_VISIBLE);
        const url = AlertasResumen.URL_ALERTAS;

        list.innerHTML = visibles.map((item) => {
            const esVencido = item.nivel === 'vencido';
            const dias = Math.abs(item.diasRestantes);
            const texto = esVencido
                ? `Venció hace ${dias} día${dias === 1 ? '' : 's'}`
                : `Vence en ${dias} día${dias === 1 ? '' : 's'}`;
            return `
                <a class="alert-item ${esVencido ? 'alert-overdue' : 'alert-warning'}" href="${url}">
                    <div>
                        <strong>N° ${item.numero}</strong>
                        <span>${item.observaciones || '—'}</span>
                    </div>
                    <span class="alert-pill ${esVencido ? 'alert-pill-overdue' : 'alert-pill-warning'}">${texto}</span>
                </a>
            `;
        }).join('');

        if (atencion.length > MAX_VISIBLE) {
            list.innerHTML += `<p class="detail-text">Mostrando ${MAX_VISIBLE} de ${atencion.length}. Ver el resto en <a href="${url}">Alertas</a>.</p>`;
        }
    }

    // Vista para usuarios de Secretaría: su cuota real (hojas "cuota 110" y
    // "cuota 131", según corresponda) y sus propios suministros con la
    // oficina en la que se encuentra cada uno. Sin la planilla global ni el
    // simulador de cuota compartido.
    function renderAreaHome() {
        renderAreaStats();
        renderAreaSupplies();
        document.getElementById('quotaProgressWrapper')?.setAttribute('hidden', '');

        const title = document.getElementById('quotaSectionTitle');
        const subtitle = document.getElementById('quotaSectionSubtitle');
        const quotaInfo = document.getElementById('quotaInfo');
        if (title) title.textContent = `Cuota real de ${session.area}`;

        // Mostrar todas las fuentes con cuota o ejecución real (aunque sea
        // en cero solo para Fuente 110, que es la principal de referencia).
        const fuentes = CuotaReal.getFuentes().filter((fuente) => {
            const cuota = CuotaReal.getBySecretaria(session.area, fuente);
            return cuota && (fuente === '110' || cuota.cuotaAnual !== 0 || cuota.ejecucionAnual !== 0);
        });

        if (fuentes.length === 0) {
            if (subtitle) {
                subtitle.textContent = 'No se encontró información de cuota para su Secretaría en la planilla oficial.';
                subtitle.hidden = false;
            }
            if (quotaInfo) quotaInfo.innerHTML = '';
            return;
        }

        const trimestre = CuotaReal.getTrimestreActual();
        if (subtitle) {
            subtitle.textContent = `Cuota, ejecución y disponible acumulados desde el 1er trimestre hasta el ${trimestre}° trimestre (en curso), según la planilla oficial (Fuente${fuentes.length > 1 ? 's' : ''} ${fuentes.join(' y ')}).`;
            subtitle.hidden = false;
        }

        if (quotaInfo) {
            quotaInfo.innerHTML = fuentes.map((fuente) => {
                const cuota = CuotaReal.getBySecretaria(session.area, fuente);
                const acumulado = CuotaReal.getAcumuladoHasta(cuota, trimestre);
                const disponible = CuotaReal.getDisponible(session.area, fuente, trimestre);
                const excedida = disponible < 0;

                return `
                    <div class="quota-fuente-group">
                        <div class="quota-fuente-label">Fuente ${fuente}</div>
                        <div class="quota-info">
                            <div class="quota-card">
                                <div class="quota-label">Cuota a T${trimestre}</div>
                                <div class="quota-value">$${SupplyUtils.formatNumber(acumulado.cuota)}</div>
                            </div>
                            <div class="quota-card">
                                <div class="quota-label">Ejecutado</div>
                                <div class="quota-value">$${SupplyUtils.formatNumber(acumulado.ejecucion)}</div>
                            </div>
                            <div class="quota-card available-card">
                                <div class="quota-label">${excedida ? 'Excedido' : 'Disponible'}</div>
                                <div class="quota-value ${excedida ? 'presupuesto-exceso-negativo' : ''}">$${SupplyUtils.formatNumber(Math.abs(disponible))}</div>
                            </div>
                        </div>
                        <div class="quota-fuente-anual">Cuota total del año: $${SupplyUtils.formatNumber(cuota.cuotaAnual)}</div>
                    </div>
                `;
            }).join('');
        }
    }

    // Resumen de los suministros propios del área: cuántos son y en qué
    // oficina está cada grupo (dónde se encuentra el trámite).
    function renderAreaStats() {
        const statsRow = document.getElementById('statsRow');
        if (!statsRow) return;

        const propios = SuministrosData.getBySecretaria(session.area);
        const counts = propios.reduce((acc, item) => {
            acc[item.Oficina] = (acc[item.Oficina] || 0) + 1;
            return acc;
        }, {});

        const cards = [
            { label: 'Mis suministros', value: propios.length, cls: 'stat-total' },
            { label: 'En Dirección de Compras', value: counts['Dirección de Compras'] || 0, cls: 'stat-pending' },
            { label: 'En Secretaría de Economía', value: counts['Secretaría de Economía'] || 0, cls: 'stat-pending' },
            { label: 'Anulados', value: counts['Anulado'] || 0, cls: 'stat-rejected' },
            { label: 'Cuota insuficiente', value: propios.filter((item) => item.Cuota === 'Insuficiente').length, cls: 'stat-alert' }
        ];

        statsRow.innerHTML = cards.map((card) => `
            <div class="stat-card ${card.cls}">
                <div class="stat-value">${card.value}</div>
                <div class="stat-label">${card.label}</div>
            </div>
        `).join('');
    }

    // Listado corto de los suministros del área con la oficina en la que
    // está cada uno. El listado completo, con detalle y filtros, está en
    // Suministros.
    function renderAreaSupplies() {
        const section = document.getElementById('alertsSection');
        const list = document.getElementById('alertsList');
        if (!section || !list) return;

        const MAX_VISIBLE = 10;
        const propios = SuministrosData.getBySecretaria(session.area)
            .sort((a, b) => (b.Suministro || 0) - (a.Suministro || 0));

        const heading = section.querySelector('h3');
        const descripcion = section.querySelector('.detail-text');
        if (heading) heading.textContent = `Mis suministros · ${session.area}`;
        if (descripcion) descripcion.textContent = 'Suministros cargados por su Secretaría y oficina en la que se encuentra cada uno.';

        if (propios.length === 0) {
            list.innerHTML = `<div class="empty-state">Su Secretaría todavía no tiene suministros cargados. Puede cargar uno desde <a href="nuevo-suministro.html">Nuevo suministro</a>.</div>`;
            return;
        }

        const visibles = propios.slice(0, MAX_VISIBLE);
        const filas = visibles.map((item) => `
            <div class="mini-supply-row">
                <strong>N° ${item.Suministro ?? '—'}</strong>
                <span class="mini-supply-obs" title="${(item.Observaciones || '—').replace(/"/g, '&quot;')}">${item.Observaciones || '—'}</span>
                <span class="status-badge ${SuministrosData.oficinaClass(item.Oficina)}">${item.Oficina || '—'}</span>
            </div>
        `).join('');

        const restantes = propios.length > MAX_VISIBLE
            ? `<p class="detail-text">Mostrando ${MAX_VISIBLE} de ${propios.length}. Ver el listado completo en <a href="suministros.html">Suministros</a>.</p>`
            : '';

        list.innerHTML = `<div class="mini-supply-list">${filas}</div>${restantes}`;
    }

    function renderStats() {
        const statsRow = document.getElementById('statsRow');
        if (!statsRow) return;

        const supplies = SuministrosData.getAll();
        const counts = supplies.reduce((acc, item) => {
            acc[item.Oficina] = (acc[item.Oficina] || 0) + 1;
            return acc;
        }, {});
        const cuotaInsuficiente = supplies.filter((item) => item.Cuota === 'Insuficiente').length;

        const cards = [
            { label: 'Total suministros', value: supplies.length, cls: 'stat-total' },
            { label: 'En Dirección de Compras', value: counts['Dirección de Compras'] || 0, cls: 'stat-pending' },
            { label: 'En Secretaría de Economía', value: counts['Secretaría de Economía'] || 0, cls: 'stat-pending' },
            { label: 'Anulados', value: counts['Anulado'] || 0, cls: 'stat-rejected' },
            { label: 'Cuota insuficiente', value: cuotaInsuficiente, cls: 'stat-alert' }
        ];

        statsRow.innerHTML = cards.map((card) => `
            <div class="stat-card ${card.cls}">
                <div class="stat-value">${card.value}</div>
                <div class="stat-label">${card.label}</div>
            </div>
        `).join('');
    }

    // Totales reales del Municipio (Fuente 110, la principal). El detalle
    // completo por Secretaría y la Fuente 131 están en Presupuesto.
    function renderQuota() {
        const quotaInfo = document.getElementById('quotaInfo');
        const quotaProgressFill = document.getElementById('quotaProgressFill');
        const quotaProgressLabel = document.getElementById('quotaProgressLabel');
        const title = document.getElementById('quotaSectionTitle');
        const subtitle = document.getElementById('quotaSectionSubtitle');
        if (!quotaInfo) return;

        const total = CuotaReal.getTotal('110');
        const trimestre = CuotaReal.getTrimestreActual();
        if (title) title.textContent = 'Cuota real (Fuente 110)';
        if (subtitle) {
            subtitle.textContent = `Totales del Municipio, acumulados al ${trimestre}° trimestre (en curso). Ver detalle por Secretaría, por trimestre y la Fuente 131 en Presupuesto.`;
            subtitle.hidden = false;
        }

        if (!total) {
            quotaInfo.innerHTML = `<div class="empty-state">No se encontró el informe de cuota real (cuota-110-data.js).</div>`;
            return;
        }

        const acumulado = CuotaReal.getAcumuladoHasta(total, trimestre);
        const disponible = acumulado.exceso;
        const excedido = disponible < 0;

        quotaInfo.innerHTML = `
            <div class="quota-card">
                <div class="quota-label">Cuota a T${trimestre}</div>
                <div class="quota-value">$${SupplyUtils.formatNumber(acumulado.cuota)}</div>
            </div>
            <div class="quota-card">
                <div class="quota-label">Ejecutado</div>
                <div class="quota-value">$${SupplyUtils.formatNumber(acumulado.ejecucion)}</div>
            </div>
            <div class="quota-card available-card">
                <div class="quota-label">${excedido ? 'Excedido' : 'Disponible'}</div>
                <div class="quota-value ${excedido ? 'presupuesto-exceso-negativo' : ''}">$${SupplyUtils.formatNumber(Math.abs(disponible))}</div>
            </div>
        `;

        const usedPct = acumulado.cuota > 0
            ? Math.min(100, Math.max(0, Math.round((acumulado.ejecucion / acumulado.cuota) * 100)))
            : 0;

        if (quotaProgressFill) {
            quotaProgressFill.style.width = `${usedPct}%`;
            quotaProgressFill.classList.toggle('quota-progress-warn', usedPct >= 80);
        }
        if (quotaProgressLabel) {
            quotaProgressLabel.textContent = `${usedPct}% de la cuota acumulada a T${trimestre} ejecutada`;
        }
    }

    function renderAlerts() {
        const alertsList = document.getElementById('alertsList');
        if (!alertsList) return;

        const MAX_VISIBLE = 8;
        const insuficientes = SuministrosData.getAll().filter((item) => item.Cuota === 'Insuficiente');

        if (insuficientes.length === 0) {
            alertsList.innerHTML = `<div class="empty-state">No hay suministros con cuota insuficiente.</div>`;
            return;
        }

        const visibles = insuficientes.slice(0, MAX_VISIBLE);
        const filas = visibles.map((item) => `
            <div class="alert-item alert-warning">
                <div>
                    <strong>N° ${item.Suministro}</strong>
                    <span>${item.Secretaría || '—'}${item.Observaciones ? ` · ${item.Observaciones}` : ''}</span>
                </div>
                <span class="alert-pill alert-pill-warning">Cuota insuficiente</span>
            </div>
        `).join('');

        const restantes = insuficientes.length > MAX_VISIBLE
            ? `<p class="detail-text">Mostrando ${MAX_VISIBLE} de ${insuficientes.length}. Ver el listado completo en <a href="suministros.html">Suministros</a>.</p>`
            : '';

        alertsList.innerHTML = filas + restantes;
    }

    function renderQuickLinks() {
        const quickLinks = document.getElementById('quickLinks');
        if (!quickLinks) return;

        quickLinks.innerHTML = QUICK_LINKS
            .filter((link) => (!link.requiresAuthorize || permissions.canAuthorize)
                && (!link.requiresNonArea || !permissions.isAreaUser)
                && (!link.requiresArea || permissions.isAreaUser))
            .map((link) => `
                <a href="${link.href}" class="quick-link-card">
                    <h4>${link.title}</h4>
                    <p>${link.text}</p>
                </a>
            `).join('');
    }

    return { init };
})();

/* ======================================================================
   SUMINISTROS DATA
   Acceso a la planilla real de suministros, cargada por suministros-data.js
   (derivado de suministros.js / Excel oficial, sin modificar el archivo
   original). Si la planilla no está presente, el listado queda vacío en
   vez de romper la página.

   Edición (Oficina/aprobación): quienes tienen permiso canValidateCompras
   pueden cambiar la Oficina de un registro. El cambio no toca el Excel
   original: se guarda como una "corrección" aparte en sessionStorage
   (por número de Suministro) y se superpone sobre el dato base al leer,
   igual que hace Store con el simulador, para no perder lo editado al
   navegar entre páginas durante la sesión.

   Altas (líneas nuevas): los suministros cargados desde Nuevo suministro
   se agregan como filas completas con las mismas columnas del Excel, y se
   guardan aparte (sessionStorage) para no tocar el archivo original. Se
   leen junto con la planilla base, por lo que aparecen en el listado, en
   los filtros y en la vista de cada área igual que cualquier otra fila.
   Para llevarlas al Excel oficial se exportan en CSV con exactamente el
   mismo orden de columnas que la planilla.
   ====================================================================== */
const SuministrosData = (() => {
    const OVERRIDES_KEY = 'sgsSuministrosOverrides';
    const ALTAS_KEY = 'sgsSuministrosAltas';

    // Backend local (backend-local/, ver su README) — SQLite real en la PC
    // donde corre. Solo alcanzable desde la misma máquina — ver
    // backendLocalPuedeExistir() más abajo, que evita intentarlo siquiera
    // fuera de localhost/127.0.0.1/file://. No hace falta ninguna variable
    // de entorno ni configuración: si el backend no está corriendo, no
    // cambia nada.
    const API_BASE = 'http://127.0.0.1:5175';
    const API_TIMEOUT_MS = 600; // misma PC: si está arriba, responde casi al instante

    let apiConectada = false;
    let planillaApi = null; // reemplaza a SUMINISTROS_REAL_DATA cuando hay API

    function isApiConectada() {
        return apiConectada;
    }

    async function fetchConTimeout(url, options) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // El backend local solo puede estar corriendo en la MISMA PC que abre
    // la página (ver backend-local/README.md) — en el sitio público
    // (Cloudflare, un dominio real) nunca hay nada escuchando en
    // 127.0.0.1, así que ni vale la pena intentar el fetch: antes se
    // esperaba el timeout completo (1,2s) en cada carga de página, para
    // todos los usuarios reales, sin ningún beneficio. Ahora el intento
    // directamente no se hace fuera de localhost/127.0.0.1/file://.
    function backendLocalPuedeExistir() {
        const { protocol, hostname } = window.location;
        return protocol === 'file:' || hostname === 'localhost' || hostname === '127.0.0.1';
    }

    // Se llama una vez al arrancar cada página (ver bootstrap): si el
    // backend local está corriendo, la planilla pasa a leerse de ahí (la
    // base SQLite real) en vez del archivo estático. Si no responde a
    // tiempo o da error, se seguye usando suministros-data.js sin avisos
    // ni errores visibles — es un intento silencioso, no un requisito.
    async function syncFromApi() {
        if (!backendLocalPuedeExistir()) {
            apiConectada = false;
            planillaApi = null;
            return false;
        }
        try {
            const resp = await fetchConTimeout(`${API_BASE}/api/pedidos`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const body = await resp.json();
            if (!body.ok || !Array.isArray(body.pedidos)) throw new Error('Respuesta inesperada de /api/pedidos');
            planillaApi = body.pedidos;
            apiConectada = true;
        } catch (error) {
            apiConectada = false;
            planillaApi = null;
        }
        return apiConectada;
    }

    function loadOverrides() {
        try {
            const raw = JSON.parse(sessionStorage.getItem(OVERRIDES_KEY));
            return raw && typeof raw === 'object' ? raw : {};
        } catch (error) {
            return {};
        }
    }

    function loadAltas() {
        try {
            const raw = JSON.parse(sessionStorage.getItem(ALTAS_KEY));
            return Array.isArray(raw) ? raw : [];
        } catch (error) {
            return [];
        }
    }

    let overrides = loadOverrides();
    let altas = loadAltas();

    function persistOverrides() {
        sessionStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
    }

    function persistAltas() {
        sessionStorage.setItem(ALTAS_KEY, JSON.stringify(altas));
    }

    function getPlanilla() {
        if (Array.isArray(planillaApi)) return planillaApi;
        return Array.isArray(window.SUMINISTROS_REAL_DATA) ? window.SUMINISTROS_REAL_DATA : [];
    }

    // Planilla oficial + líneas nuevas de esta sesión: todo lo que lee el
    // resto del sistema pasa por acá, así un alta se comporta igual que
    // una fila del Excel. Sin altas todavía (el caso normal, la mayoría
    // de las sesiones) se devuelve la planilla tal cual, sin copiar un
    // array de ~1200 referencias que de todos modos no cambiaron.
    function getBase() {
        return altas.length === 0 ? getPlanilla() : [...getPlanilla(), ...altas];
    }

    // getAll() se llama decenas de veces por página (cada gráfico de
    // Analítica, cada re-render de Suministros al tipear en el buscador,
    // etc.) — sin overrides cargados (el caso normal: nadie cambió una
    // Oficina ni aprobó nada todavía en esta sesión) se devuelve la base
    // directamente, sin recorrer ~1200 filas para no modificar ninguna.
    function getAll() {
        const base = getBase();
        if (Object.keys(overrides).length === 0) return base;
        return base.map((item) => {
            const override = overrides[item.Suministro];
            return override ? { ...item, ...override } : item;
        });
    }

    function getOficinas() {
        return [...new Set(getAll().map((item) => item.Oficina).filter(Boolean))].sort();
    }

    function getSecretarias() {
        return [...new Set(getAll().map((item) => item.Secretaría).filter(Boolean))].sort();
    }

    function findById(suministroId) {
        return getAll().find((item) => item.Suministro === suministroId) || null;
    }

    function formatMonto(value) {
        return Number.isFinite(value) ? `$${SupplyUtils.formatNumber(value)}` : '—';
    }

    function formatFecha(value) {
        if (!value) return '—';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('es-AR');
    }

    // Solo "Anulado" es un desenlace negativo (desaprobación); el resto son
    // oficinas reales del circuito en curso (Secretaría de Economía,
    // Dirección de Compras, Subsecretaría de Planificación, etc.).
    function oficinaClass(oficina) {
        return oficina === 'Anulado' ? 'status-rejected' : 'status-pending';
    }

    // Cambia la oficina/estado de un suministro (aprobar, desaprobar o mover
    // a cualquier otra etapa). Uso exclusivo de perfiles con
    // canValidateCompras; la verificación de permiso la hace quien llama.
    function setOficina(suministroId, nuevaOficina) {
        if (!getBase().some((item) => item.Suministro === suministroId)) return null;
        overrides[suministroId] = { ...overrides[suministroId], Oficina: nuevaOficina };
        persistOverrides();
        return findById(suministroId);
    }

    // Suministros con Aprobacion: 'Pendiente' — solo los cargados desde acá
    // a partir de esta funcionalidad (ver buildAlta); la planilla real
    // nunca tiene este campo, así que nunca aparece acá.
    function getPendientesAprobacion() {
        return getAll().filter((item) => item.Aprobacion === 'Pendiente');
    }

    // Aprueba un suministro pendiente. Exclusivo del legajo 310019; la
    // verificación de permiso la hace quien llama (AprobacionesPage).
    function aprobar(suministroId, aprobadoPor) {
        if (!getBase().some((item) => item.Suministro === suministroId)) return null;
        overrides[suministroId] = {
            ...overrides[suministroId],
            Aprobacion: 'Aprobado',
            AprobadoPor: aprobadoPor,
            FechaAprobacion: new Date().toISOString()
        };
        persistOverrides();
        return findById(suministroId);
    }

    // Rechaza un alta pendiente (exclusivo del legajo 310019, mismo criterio
    // que aprobar). A diferencia de aprobar, esto NO deja un registro con
    // Aprobacion:'Rechazado' -- saca directamente el alta del array (y
    // cualquier override que tuviera), para que el N° de suministro quede
    // completamente libre y se pueda volver a cargar de cero. Solo aplica a
    // altas (buildAlta): un registro de la planilla real no tiene de dónde
    // sacarse, así que no hace nada si suministroId no es un alta.
    // Devuelve el registro removido (con su Fuente/Secretaría/Sum Total)
    // para que quien llama libere la cuota reservada -- ver CuotaReal.liberar.
    function rechazar(suministroId) {
        const idx = altas.findIndex((item) => item.Suministro === suministroId);
        if (idx === -1) return null;
        const [removida] = altas.splice(idx, 1);
        persistAltas();
        if (overrides[suministroId]) {
            delete overrides[suministroId];
            persistOverrides();
        }
        return removida;
    }

    /* ---------- Consulta por área ---------- */

    // Suministros de una Secretaría, para que cada área vea únicamente los
    // suyos (planilla oficial + altas propias de la sesión).
    function getBySecretaria(secretaria) {
        return getAll().filter((item) => item.Secretaría === secretaria);
    }

    /* ---------- Altas: nueva línea del Excel ---------- */

    // El número de suministro es la clave del Excel. Se compara en numérico
    // para que "1254" y 1254 sean el mismo suministro, ya que el formulario
    // entrega texto y la planilla, números.
    function findByNumero(numero) {
        const buscado = Number(numero);
        if (!Number.isFinite(buscado)) return null;
        return getAll().find((item) => {
            if (item.Suministro === null || item.Suministro === undefined || item.Suministro === '') return false;
            return Number(item.Suministro) === buscado;
        }) || null;
    }

    function existeNumero(numero) {
        return findByNumero(numero) !== null;
    }

    const MESES_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

    // "2026-02" (input type=month) → "feb-26", el formato de la columna
    // "Mes de inicio" del Excel.
    function toMesExcel(mesInput) {
        const [year, month] = String(mesInput || '').split('-').map(Number);
        if (!year || !month || month < 1 || month > 12) return null;
        return `${MESES_ABBR[month - 1]}-${String(year).slice(-2)}`;
    }

    // Columnas del Excel en su orden real: se toma la primera fila de la
    // planilla como plantilla para que la línea nueva tenga exactamente las
    // mismas columnas, en el mismo orden, y pueda pegarse en el archivo.
    function getColumnas() {
        const plantilla = getPlanilla()[0];
        return plantilla ? Object.keys(plantilla) : [];
    }

    // Arma la línea nueva del Excel a partir de lo que se carga en el
    // formulario. Los campos que se completan después en RAFAM (montos,
    // adjudicación, fechas del circuito) quedan vacíos, igual que en una
    // fila recién cargada de la planilla real.
    function buildAlta({ numeroSuministro, secretaria, jurisdiccion, mesInicio, mesesConsumo, fuente, oficina, observaciones, monto, etiqueta, cuotaExcedida }) {
        const fila = {};
        getColumnas().forEach((columna) => { fila[columna] = null; });

        Object.assign(fila, {
            'Suministro': Number(numeroSuministro),
            'Oficina': oficina,
            'Observaciones': observaciones || 'Autorización provisional cargada desde el sistema. Pendiente de completar en RAFAM.',
            'Meses de consumo (cantidad)': mesesConsumo,
            'Mes de inicio': toMesExcel(mesInicio),
            'Cuota': 'Suficiente',
            'Fecha de Carga': new Date().toISOString().slice(0, 19),
            'Secretaría': secretaria,
            'Jurisdicción': jurisdiccion ?? null,
            'Fuente de Financiamiento': Number(fuente),
            'Etiqueta': etiqueta || 'AUTORIZACIÓN PROVISIONAL'
        });

        // "Sum Total" es una fórmula en el Excel real (no se exporta acá:
        // ver COLUMNAS_MANUALES_EXCEL), pero mostrar el monto real de la
        // Orden de Compra en la propia app ayuda a ver de un vistazo cuánto
        // se está reservando mientras el suministro está pendiente.
        if (monto !== undefined) fila['Sum Total'] = monto;

        // Aprobación: todo suministro cargado desde acá, de ahora en más,
        // necesita aprobación del legajo 310019 antes de darse por válido
        // (ver AprobacionesPage). Los suministros de la planilla real
        // (getPlanilla) nunca pasan por buildAlta, así que no llevan este
        // campo y quedan afuera del circuito de aprobación — no es
        // retroactivo.
        fila['Aprobacion'] = 'Pendiente';

        // Se cargó a pesar de tener la Fuente excedida (ver "Solicitar
        // aprobación de todos modos" en NuevoSuministroPage) -- AprobacionesPage
        // lo marca aparte para que el legajo 310019 sepa que esta, a
        // diferencia de las demás, necesita autorizar un excedido de cuota,
        // no solo revisar una carga normal.
        if (cuotaExcedida) fila['CuotaExcedida'] = true;

        return fila;
    }

    // async porque, si el backend local está conectado (ver syncFromApi),
    // también escribe el alta ahí (base SQLite real) además de guardarla en
    // sessionStorage como siempre. sessionStorage se escribe primero y
    // siempre: si el POST a la API falla (el backend se cayó justo ahora,
    // o nunca estuvo conectado), la carga igual queda guardada, ni se
    // pierde ni se corta el flujo de Nuevo suministro.
    async function addAlta(datos) {
        const fila = buildAlta(datos);
        altas.push(fila);
        persistAltas();

        if (apiConectada) {
            try {
                await fetchConTimeout(`${API_BASE}/api/pedidos`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        numeroSuministro: fila['Suministro'],
                        secretaria: fila['Secretaría'],
                        fuente: fila['Fuente de Financiamiento'],
                        mesInicio: datos.mesInicio ? `${datos.mesInicio}-01` : null,
                        mesesConsumo: fila['Meses de consumo (cantidad)'],
                        oficina: fila['Oficina'],
                        observaciones: fila['Observaciones'],
                        monto: fila['Sum Total'],
                        etiqueta: fila['Etiqueta']
                    })
                });
            } catch (error) {
                // No se corta la carga por esto: ver comentario de arriba.
            }
        }

        return fila;
    }

    // Con los overrides aplicados (igual que getAll), para que si Compras
    // cambió la oficina de una línea nueva desde el listado, la exportación
    // baje la oficina actual y no la que tenía al momento de cargarse.
    function getAltas() {
        return altas.map((item) => {
            const override = overrides[item.Suministro];
            return override ? { ...item, ...override } : item;
        });
    }

    /* ---------- Exportación al Excel oficial ---------- */

    // La planilla real ("seguimiento de suministros 2026 - copia.xlsm") es
    // una Tabla de Excel: la mayoría de sus columnas (Cuota, montos,
    // Secretaría, Fuente de Financiamiento, meses, trimestres, Total, etc.)
    // son fórmulas calculadas que Excel completa solo al escribir en la
    // primera fila vacía debajo de la tabla — recién cuando RAFAM vincula
    // el número de suministro. Exportar esas columnas con texto o blancos
    // "a mano" pisaría la fórmula y rompería el autocompletado de esa fila.
    // Por eso acá se exportan ÚNICAMENTE las columnas que son dato manual
    // en el Excel real, en su mismo orden y con sus mismos encabezados,
    // para pegarlas tal cual en la fila nueva de la tabla "suministros".
    const COLUMNAS_MANUALES_EXCEL = [
        'Suministro', 'Oficina', 'Observaciones', 'Meses de consumo (cantidad)', 'Mes de inicio',
        'Derivado a Economía', 'Cuota asignada', 'Fecha de Carga', 'Fecha de derivación a Economía',
        'Jurisdicción', 'impreso', 'Hora de Derivación a Economía'
    ];

    // La oficina se muestra en el sistema con nombre completo, pero en el
    // Excel real la columna "Oficina" usa las abreviaturas históricas de la
    // planilla. Se traduce solo acá, al exportar: adentro del sistema se
    // sigue usando siempre el nombre completo.
    const OFICINA_EXCEL_LABELS = {
        'Dirección de Compras': 'En Compras',
        'Secretaría de Economía': 'Sec. Eco.',
        'Subsecretaría de Planificación Presupuestaria y Estadística': 'Subs. Presupuesto',
        'Anulado': 'Anulado'
    };

    function toOficinaExcel(oficina) {
        return OFICINA_EXCEL_LABELS[oficina] || oficina;
    }

    // dd/mm/aaaa: el Excel real guarda fecha (no texto), y ese formato es
    // el que reconoce como fecha al pegarlo, tanto en español como con
    // separador de miles/fecha regional de Argentina.
    function formatFechaExcel(isoString) {
        if (!isoString) return '';
        const date = new Date(isoString);
        if (Number.isNaN(date.getTime())) return '';
        const dd = String(date.getDate()).padStart(2, '0');
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        return `${dd}/${mm}/${date.getFullYear()}`;
    }

    function csvCell(value) {
        if (value === null || value === undefined) return '';
        const texto = String(value);
        return /[";\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
    }

    function altaToExcelRow(fila) {
        const salida = { ...fila, Oficina: toOficinaExcel(fila.Oficina), 'Fecha de Carga': formatFechaExcel(fila['Fecha de Carga']) };
        return COLUMNAS_MANUALES_EXCEL.map((columna) => csvCell(salida[columna]));
    }

    // CSV separado por ";" (formato que Excel en español abre en columnas)
    // y con BOM para que respete los acentos. secretaria acota la
    // exportación a un área, para que una Secretaría solo pueda bajar sus
    // propias líneas.
    function altasToCsv(secretaria) {
        const incluidas = secretaria ? getAltas().filter((fila) => fila.Secretaría === secretaria) : getAltas();
        const encabezado = COLUMNAS_MANUALES_EXCEL.map(csvCell).join(';');
        const filas = incluidas.map((fila) => altaToExcelRow(fila).join(';'));
        return `﻿${[encabezado, ...filas].join('\r\n')}`;
    }

    function descargarAltasCsv(secretaria) {
        if (altas.length === 0) return false;
        const blob = new Blob([altasToCsv(secretaria)], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'suministros-datos-manuales-para-excel.csv';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        return true;
    }

    return {
        getAll, getOficinas, getSecretarias, findById, formatMonto, formatFecha, oficinaClass, setOficina,
        getBySecretaria, findByNumero, existeNumero, addAlta, getAltas, altasToCsv, descargarAltasCsv,
        getPendientesAprobacion, aprobar, rechazar, syncFromApi, isApiConectada
    };
})();

/* ======================================================================
   CUOTA REAL (hojas "cuota 110" y "cuota 131" de la planilla oficial)
   Acceso de solo lectura a la cuota, ejecución y exceso/economía anual y
   trimestral por Secretaría, cargada por cuota-110-data.js y
   cuota-131-data.js — una hoja por Fuente de Financiamiento. Es la fuente
   del informe de Presupuesto y de "cuota disponible" en Inicio y en
   Nuevo suministro.
   ====================================================================== */
const CuotaReal = (() => {
    const FUENTES = {
        '110': { data: () => window.CUOTA_110_DATA, total: () => window.CUOTA_110_TOTAL, label: '110' },
        '131': { data: () => window.CUOTA_131_DATA, total: () => window.CUOTA_131_TOTAL, label: '131' }
    };
    const DEFAULT_FUENTE = '110';

    function getFuentes() {
        return Object.keys(FUENTES);
    }

    function hasFuente(fuente) {
        return Object.prototype.hasOwnProperty.call(FUENTES, fuente);
    }

    function getAll(fuente = DEFAULT_FUENTE) {
        const source = FUENTES[fuente];
        const data = source ? source.data() : null;
        return Array.isArray(data) ? data : [];
    }

    function getTotal(fuente = DEFAULT_FUENTE) {
        const source = FUENTES[fuente];
        return (source && source.total()) || null;
    }

    function getBySecretaria(secretaria, fuente = DEFAULT_FUENTE) {
        return getAll(fuente).find((item) => item.secretaria === secretaria) || null;
    }

    // Trimestre calendario actual (1=ene-mar ... 4=oct-dic), igual criterio
    // que las columnas I..IV de las hojas "cuota 110"/"cuota 131" del Excel.
    function getTrimestreActual(fecha = new Date()) {
        return Math.floor(fecha.getMonth() / 3) + 1;
    }

    // Cuota, ejecución y exceso/economía ACUMULADOS desde el trimestre I
    // hasta "trimestre" inclusive — no el total anual completo. Es el
    // equivalente real a "cuánto tengo disponible hoy": la cuota de
    // trimestres futuros todavía no corresponde, y la economía de
    // trimestres ya cerrados sí sigue disponible (mismo criterio que las
    // columnas "Excesos/Economías" del Excel, que son la diferencia
    // trimestre a trimestre, nunca negativas por adelantar cuota futura).
    function getAcumuladoHasta(cuota, trimestre) {
        const hasta = Math.min(Math.max(trimestre, 1), 4);
        const sumar = (arr) => (Array.isArray(arr) ? arr : []).slice(0, hasta).reduce((a, b) => a + (b || 0), 0);
        return {
            cuota: sumar(cuota.cuotaTrimestral),
            ejecucion: sumar(cuota.ejecucionTrimestral),
            exceso: sumar(cuota.excesoTrimestral)
        };
    }

    // Todas las fuentes en las que la Secretaría tiene fila cargada (aunque
    // sea con cuota/ejecución en cero), para mostrarle al usuario de área
    // solo lo que realmente le corresponde.
    function getFuentesConDatos(secretaria) {
        return getFuentes().filter((fuente) => getBySecretaria(secretaria, fuente) !== null);
    }

    // Reservas del simulador de Nuevo suministro: se descuentan del exceso/
    // economía real solo en memoria de esta sesión (sessionStorage), nunca
    // en cuota-110-data.js / cuota-131-data.js ni en el Excel original.
    const RESERVAS_KEY = 'sgsCuotaReservasReales';

    function loadReservas() {
        try {
            const raw = sessionStorage.getItem(RESERVAS_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            return {};
        }
    }

    let reservas = loadReservas();

    function persistReservas() {
        sessionStorage.setItem(RESERVAS_KEY, JSON.stringify(reservas));
    }

    function reservaKey(secretaria, fuente) {
        return `${fuente}::${secretaria}`;
    }

    function getReservado(secretaria, fuente = DEFAULT_FUENTE) {
        return reservas[reservaKey(secretaria, fuente)] || 0;
    }

    // Disponible real = (Cuota - Ejecución) ACUMULADO desde el trimestre I
    // hasta el trimestre actual (no el total anual completo, que incluiría
    // cuota de trimestres que todavía no llegaron) menos lo reservado en el
    // simulador durante esta sesión. null si no hay datos de esa fuente
    // para la Secretaría (por ejemplo, Fuente 132, sin hoja propia).
    function getDisponible(secretaria, fuente = DEFAULT_FUENTE, trimestre = getTrimestreActual()) {
        const cuota = getBySecretaria(secretaria, fuente);
        if (!cuota) return null;
        return getAcumuladoHasta(cuota, trimestre).exceso - getReservado(secretaria, fuente);
    }

    function reservar(secretaria, fuente, montoPesos) {
        const key = reservaKey(secretaria, fuente);
        reservas[key] = (reservas[key] || 0) + montoPesos;
        persistReservas();
    }

    // Inversa de reservar: libera lo reservado por un suministro que se
    // rechaza (ver SuministrosData.rechazar) o se retira del circuito. No
    // puede quedar negativo por error de redondeo -- si el registro
    // reservado era el único, vuelve a 0 en vez de a un residuo mínimo.
    function liberar(secretaria, fuente, montoPesos) {
        const key = reservaKey(secretaria, fuente);
        const restante = (reservas[key] || 0) - montoPesos;
        reservas[key] = Math.abs(restante) < 0.01 ? 0 : restante;
        persistReservas();
    }

    // Evalúa TODAS las rutas (fuentes de financiamiento) de una Secretaría
    // en un solo paso: cada una devuelve su cuota, su ejecución y si todavía
    // le queda economía — ACUMULADO al trimestre actual, no el total anual.
    // Es la base de la decisión al cargar un suministro nuevo, que no puede
    // depender de una sola fuente.
    function evaluarRutas(secretaria, trimestre = getTrimestreActual()) {
        return getFuentes().map((fuente) => {
            const cuota = getBySecretaria(secretaria, fuente);
            const disponible = getDisponible(secretaria, fuente, trimestre);
            const acumulado = cuota ? getAcumuladoHasta(cuota, trimestre) : { cuota: 0, ejecucion: 0, exceso: 0 };
            return {
                fuente,
                tieneDatos: cuota !== null,
                trimestreActual: trimestre,
                cuotaAcumulada: acumulado.cuota,
                ejecucionAcumulada: acumulado.ejecucion,
                cuotaAnual: cuota ? cuota.cuotaAnual : 0,
                ejecucionAnual: cuota ? cuota.ejecucionAnual : 0,
                jurisdiccion: cuota ? cuota.jurisdiccion : null,
                disponible: disponible === null ? 0 : disponible,
                tieneEconomia: disponible !== null && disponible > 0
            };
        });
    }

    // Ruta elegida para imputar el suministro: la que tenga economía y, si
    // hay más de una, la de mayor disponible. null si ninguna ruta tiene
    // economía, caso en el que la carga se bloquea.
    function elegirRutaConEconomia(secretaria) {
        return evaluarRutas(secretaria)
            .filter((ruta) => ruta.tieneEconomia)
            .sort((a, b) => b.disponible - a.disponible)[0] || null;
    }

    return {
        getFuentes, hasFuente, getAll, getTotal, getBySecretaria, getFuentesConDatos,
        getReservado, getDisponible, reservar, liberar, evaluarRutas, elegirRutaConEconomia,
        getTrimestreActual, getAcumuladoHasta
    };
})();

/* ======================================================================
   PEDIDOS DE SUMINISTRO (pedidos-suministro-data.js)
   Acceso de solo lectura a los Pedidos de Suministro reales, cruzando dos
   exports de RAFAM (ctr_hojaruta_x.csv + ctr_ordencomprageneral.csv, ver
   scripts/build_pedidos_data.py). El N° de suministro que se carga desde
   Nuevo suministro es el N° de Pedido de Suministros de la hoja de ruta
   (correlativo, asignado por orden de llegada) — NO el N° de Orden de
   Compra: un pedido puede integrar una o varias órdenes. De acá salen la
   Fuente de Financiamiento y el Monto reales (suma de sus órdenes), en
   vez de estimarlos. Si un número no está acá, no tiene ninguna Orden de
   Compra real todavía y no se puede cargar.
   ====================================================================== */
const PedidosSuministro = (() => {
    function getByNumero(numero) {
        const datos = window.PEDIDOS_SUMINISTRO_DATA || {};
        return datos[String(numero)] || null;
    }

    return { getByNumero };
})();

/* ======================================================================
   PROYECCIÓN DE TIEMPOS
   Estima cuándo un suministro va a llegar al próximo paso del circuito
   (y, más adelante, cuándo se va a devengar) usando la MEDIANA real de
   días entre pasos — no el promedio, porque unos pocos trámites
   larguísimos estiran mucho el promedio y lo alejan del caso típico.

   Se proyecta siempre desde el ÚLTIMO paso real conocido, no desde la
   Fecha de Carga — se comprobó con los ~1.200 suministros reales que
   conviene: el total tiene mucha dispersión (desvío ≈ el propio
   promedio), y esa incertidumbre se concentra sobre todo en el tramo
   Cotización → Adjudicación. Si el suministro ya pasó esa etapa, no
   tiene sentido seguir arrastrándola en la proyección.

   El "tipo de proceso" real de RAFAM (CDVP/CONC/CODI/LPRI/LPUB — compra
   directa, concurso de precios, licitación privada/pública) recién se
   conoce cuando existe una Orden de Compra real (ver tipoCompra en
   PedidosSuministro): antes de eso se usa "general". Se comprobó que
   importa mucho — sobre todo para cuándo se devenga (mediana ~27 días en
   CDVP contra ~70 en CONC): un suministro por Concurso de Precios no
   tarda más en aprobarse, pero sí tarda mucho más en recibirse.

   Medianas calculadas sobre la planilla real (ago-2026), n≈760-1.000
   según el tramo para CDVP, n=34-120 para el resto (LPUB con n<10 no
   tiene mediana propia confiable, usa "general"). Recalcular si en algún
   momento se junta bastante más historia.
   ====================================================================== */
const Proyeccion = (() => {
    const MEDIANAS = {
        general: { aSolicitudGastos: 2, aPedidoCotizacion: 1, aAdjudicacion: 7, aOrdenCompra: 0, aRecepcion: 33 },
        CDVP: { aSolicitudGastos: 2, aPedidoCotizacion: 1, aAdjudicacion: 5, aOrdenCompra: 0, aRecepcion: 27 },
        CONC: { aSolicitudGastos: 3.5, aPedidoCotizacion: 1, aAdjudicacion: 12, aOrdenCompra: 0, aRecepcion: 70 },
        CODI: { aSolicitudGastos: 1, aPedidoCotizacion: 0.5, aAdjudicacion: 2, aOrdenCompra: 0, aRecepcion: 46 },
        LPRI: { aSolicitudGastos: 2, aPedidoCotizacion: 1, aAdjudicacion: 12, aOrdenCompra: 6, aRecepcion: 61 }
        // LPUB: muy pocos casos reales (n<10) para tener mediana propia -- usa "general".
    };

    const NOMBRES_TIPO = {
        CDVP: 'Compra directa (CDVP)',
        CONC: 'Concurso de precios (CONC)',
        CODI: 'Compra directa especial (CODI)',
        LPRI: 'Licitación privada (LPRI)',
        LPUB: 'Licitación pública (LPUB)'
    };

    // Orden real del circuito de aprobación, con la clave de MEDIANAS que
    // corresponde a "tiempo desde el paso anterior hasta este".
    const PASOS_CIRCUITO = [
        { campo: 'Fecha de Carga', label: 'Fecha de carga' },
        { campo: 'Solicitud de Gastos', label: 'Solicitud de gastos', clave: 'aSolicitudGastos' },
        { campo: 'Pedido de Cotización', label: 'Pedido de cotización', clave: 'aPedidoCotizacion' },
        { campo: 'Adjud. ', label: 'Adjudicación', clave: 'aAdjudicacion' },
        { campo: 'Órden de Compra', label: 'Orden de compra', clave: 'aOrdenCompra' }
    ];

    function fechaValida(valor) {
        if (!valor) return null;
        const fecha = new Date(valor);
        return Number.isNaN(fecha.getTime()) ? null : fecha;
    }

    function sumarDias(fecha, dias) {
        return new Date(fecha.getTime() + dias * 86400000);
    }

    // suministro: fila de SuministrosData (fechas reales del circuito).
    // pedidoRafam: lo que devuelve PedidosSuministro.getByNumero() (o null
    // si todavía no tiene Orden de Compra real) -- se pasa ya resuelto
    // porque quien llama (renderDetail) ya lo necesita para Hoja de ruta.
    //
    // Devuelve null si no hay nada que proyectar (Anulado, o circuito ya
    // completo con devengamiento real). Si no, devuelve:
    //   { tipo, tipoConocido, pasosPendientes: [{label, fecha}], recepcion: {fecha, esReal} }
    function proyectar(suministro, pedidoRafam) {
        if (!suministro || suministro.Oficina === 'Anulado') return null;

        const tipoConocido = Boolean(pedidoRafam && pedidoRafam.tipoCompra && MEDIANAS[pedidoRafam.tipoCompra]);
        const tipo = tipoConocido ? pedidoRafam.tipoCompra : null;
        // Mientras no exista Orden de Compra real, el tipo de proceso se
        // desconoce -- se proyecta la cadena de aprobación siempre con
        // "general" (no puede ser de otra forma, todavía no hay OC de la
        // que sacarlo).
        const medianasAprobacion = MEDIANAS.general;

        let fechaBase = null;
        let indiceUltimoReal = -1;
        PASOS_CIRCUITO.forEach((paso, i) => {
            const fecha = fechaValida(suministro[paso.campo]);
            if (fecha) {
                fechaBase = fecha;
                indiceUltimoReal = i;
            }
        });
        if (!fechaBase) return null; // ni la Fecha de Carga está cargada -- no hay desde dónde proyectar

        const ocYaReal = Boolean(fechaValida(suministro['Órden de Compra']));
        const pasosPendientes = [];
        let cursor = fechaBase;
        if (!ocYaReal) {
            for (let i = indiceUltimoReal + 1; i < PASOS_CIRCUITO.length; i++) {
                const paso = PASOS_CIRCUITO[i];
                cursor = sumarDias(cursor, medianasAprobacion[paso.clave]);
                pasosPendientes.push({ label: paso.label, fecha: cursor });
            }
        }

        // Recepción (devengamiento): si ya es real, no hay nada que
        // proyectar. Si no, se proyecta desde la Orden de Compra (real si
        // ya existe, o la recién proyectada) con la mediana del tipo real
        // si ya se conoce, o "general" si todavía no.
        let recepcion;
        if (pedidoRafam && pedidoRafam.devengado) {
            recepcion = { fecha: fechaValida(pedidoRafam.fechaDevengamiento), esReal: true };
        } else {
            const fechaOc = ocYaReal ? fechaValida(suministro['Órden de Compra']) : cursor;
            const medianasRecepcion = tipoConocido ? MEDIANAS[tipo] : MEDIANAS.general;
            recepcion = { fecha: sumarDias(fechaOc, medianasRecepcion.aRecepcion), esReal: false };
        }

        if (pasosPendientes.length === 0 && recepcion.esReal) return null; // circuito completo, nada para mostrar

        return { tipo, tipoConocido, nombreTipo: tipo ? NOMBRES_TIPO[tipo] : null, pasosPendientes, recepcion };
    }

    return { proyectar };
})();

/* ======================================================================
   ALERTAS DE RENOVACIÓN
   Ahora es un sitio aparte (alertas-app/, Worker `alertas-suministros`)
   sobre la misma base: mismo seguimiento por legajo, misma lógica, para
   todas las áreas. Acá solo queda el resumen de lo que necesita atención
   (vencido o por vencer) para el número del menú y el aviso en Inicio; el
   botón "Alertas" pasa directo a ese sitio con la sesión iniciada
   (/api/alertas/ir en suministros-app/worker/alertas.ts).
   ====================================================================== */
const AlertasResumen = (() => {
    const URL_ALERTAS = '/api/alertas/ir';
    let atencion = [];

    // Si falla (sitio de alertas todavía sin publicar, etc.), no rompe nada:
    // simplemente no hay número ni aviso.
    async function cargar() {
        try {
            const r = await Api.get('/api/alertas/resumen');
            atencion = Array.isArray(r.atencion) ? r.atencion : [];
        } catch (error) {
            atencion = [];
        }
    }

    return { URL_ALERTAS, cargar, getAtencion: () => atencion };
})();

/* ======================================================================
   REMITOS APROBADOS (remitos.html)
   Qué suministros propios ya tienen la aprobación del legajo 310019, para
   que el área pueda bajar el remito -- separados en "con cuota" (el
   remito ya se había descargado al cargarlo) y "excepcionales" (se cargó
   con la Fuente excedida, así que no hubo remito hasta ahora: recién
   queda disponible acá, una vez aprobado).

   "Vistos" en localStorage (por legajo, para que
   sobreviva a cerrar el navegador): qué números ya vio esta persona en
   esta pantalla, para poder avisar con un número en la barra de arriba
   cuántos aprobados todavía no vio -- la única forma de "notificación"
   posible en un sitio sin backend propio ni push/email.
   ====================================================================== */
const RemitosAprobados = (() => {
    const KEY_PREFIX = 'sgsRemitosVistos::';

    function claveDe(usuario) {
        return `${KEY_PREFIX}${usuario}`;
    }

    function cargarVistos(usuario) {
        try {
            const raw = JSON.parse(localStorage.getItem(claveDe(usuario)));
            return new Set(Array.isArray(raw) ? raw : []);
        } catch (error) {
            return new Set();
        }
    }

    function guardarVistos(usuario, vistos) {
        localStorage.setItem(claveDe(usuario), JSON.stringify([...vistos]));
    }

    // Todos los suministros de esta área con Aprobacion:'Aprobado',
    // separados por si necesitaron aprobación excepcional (Fuente
    // excedida) o no. Nunca incluye la planilla real (esos suministros no
    // tienen el campo Aprobacion, ver buildAlta) -- solo los cargados
    // desde Nuevo suministro.
    function getAprobados(area) {
        const aprobados = SuministrosData.getBySecretaria(area).filter((item) => item.Aprobacion === 'Aprobado');
        return {
            conCuota: aprobados.filter((item) => !item.CuotaExcedida),
            excepcionales: aprobados.filter((item) => item.CuotaExcedida)
        };
    }

    // Cuántos de los aprobados de esta área todavía no vio este legajo --
    // el número que se muestra como notificación en la barra de arriba.
    function getNuevosCount(usuario, area) {
        const vistos = cargarVistos(usuario);
        const { conCuota, excepcionales } = getAprobados(area);
        return [...conCuota, ...excepcionales].filter((item) => !vistos.has(item.Suministro)).length;
    }

    // Se llama al entrar a Mis remitos: marca todos los aprobados de hoy
    // como vistos, así el número de notificación desaparece hasta que
    // se apruebe uno nuevo.
    function marcarTodosVistos(usuario, area) {
        const vistos = cargarVistos(usuario);
        const { conCuota, excepcionales } = getAprobados(area);
        [...conCuota, ...excepcionales].forEach((item) => vistos.add(item.Suministro));
        guardarVistos(usuario, vistos);
    }

    return { getAprobados, getNuevosCount, marcarTodosVistos };
})();

/* ======================================================================
   SUMINISTROS PAGE (suministros.html)
   Listado de solo lectura de la planilla real: búsqueda, filtro por
   oficina y por todas las secretarías, y detalle completo por registro.

   Alcance según el perfil: los usuarios centrales ven la planilla completa
   de todas las Secretarías; una cuenta de Secretaría ve únicamente los
   suministros de su área (planilla oficial y altas propias), con la
   oficina en la que se encuentra cada uno. El alcance se aplica en el
   origen de los datos (getScopedSupplies), no ocultando filas, para que
   ningún filtro ni búsqueda pueda exponer datos de otra área.
   ====================================================================== */
const SuministrosPage = (() => {
    let state = null;
    let permissions = null;
    let session = null;

    // Oficinas reales por las que circula un suministro, siempre disponibles
    // en el selector aunque la planilla cargada todavía no tenga ningún
    // registro en esa oficina. "Aprobado"/"Desaprobado" no son oficinas: la
    // aprobación se expresa moviendo el suministro a la oficina que
    // corresponda (o a "Anulado", que sí es un valor real de la planilla).
    const OFICINA_ETAPAS = ['Secretaría de Economía', 'Dirección de Compras', 'Subsecretaría de Planificación Presupuestaria y Estadística', 'Anulado'];

    // La planilla completa ronda ~1200 filas: armar un <div> por fila (con
    // sus listeners y, para Compras, un <select> con 4 opciones) para las
    // 1200 de una sola vez se sentía en cada tecla del buscador. Se
    // muestran de a tantas por vez, con un botón para pedir más — mismo
    // criterio que ya usan Inicio/Aprobaciones para sus listados cortos.
    const PAGINA_SUMINISTROS = 80;

    function init(activeSession) {
        session = activeSession;
        permissions = Auth.permissionsFor(session.rol);

        const subtitle = document.getElementById('suministrosSubtitle');
        if (subtitle) {
            if (permissions.isAreaUser) {
                subtitle.textContent = `Suministros cargados por ${session.area} y oficina en la que se encuentra cada uno. Datos de solo lectura.`;
            } else if (permissions.canValidateCompras) {
                subtitle.textContent = 'Seguimiento de suministros cargado desde planilla oficial. Puede aprobar, desaprobar y cambiar la oficina de cada registro desde su detalle.';
            }
        }

        const propios = getScopedSupplies();

        state = {
            searchQuery: '',
            filterOficina: '',
            filterSecretaria: '',
            ordenamiento: 'suministro',
            selectedId: propios[0]?.Suministro ?? null,
            visibleCount: PAGINA_SUMINISTROS
        };

        renderAreaScope();
        renderAltasExport();
        renderSourceNote(propios.length);
        populateFilterOptions();
        bindEvents();
        renderSupplies();
        renderDetail();
    }

    // Las líneas nuevas armadas desde Nuevo suministro se exportan en CSV
    // con las columnas del Excel, para pegarlas en la planilla oficial:
    // desde el navegador no se puede escribir el .xlsm directamente.
    function renderAltasExport() {
        const wrapper = document.getElementById('altasExport');
        if (!wrapper) return;

        const altas = SuministrosData.getAltas();
        const propias = permissions.isAreaUser
            ? altas.filter((item) => item.Secretaría === session.area)
            : altas;

        if (propias.length === 0) {
            wrapper.hidden = true;
            return;
        }

        wrapper.hidden = false;
        wrapper.innerHTML = `
            <span class="field-hint">
                ${propias.length} línea${propias.length > 1 ? 's' : ''} nueva${propias.length > 1 ? 's' : ''} cargada${propias.length > 1 ? 's' : ''} en esta sesión, todavía sin pasar al Excel real.
                El CSV trae solo los datos manuales (Suministro, Oficina, Observaciones, Mes de inicio, etc.): péguelos en la primera fila vacía de la tabla "suministros" en <strong>seguimiento de suministros 2026 - copia.xlsm</strong>; Excel completa solo el resto (Cuota, montos, Secretaría, Fuente) cuando RAFAM vincule el número.
            </span>
            <button type="button" class="btn ghost" id="descargarAltasBtn">Descargar datos manuales (CSV para pegar en el Excel)</button>
        `;
        document.getElementById('descargarAltasBtn')?.addEventListener('click', () => {
            SuministrosData.descargarAltasCsv(permissions.isAreaUser ? session.area : undefined);
        });
    }

    // Origen de datos del listado: la planilla completa para los perfiles
    // centrales, y solo los suministros de la propia Secretaría para una
    // cuenta de área.
    function getScopedSupplies() {
        return permissions.isAreaUser
            ? SuministrosData.getBySecretaria(session.area)
            : SuministrosData.getAll();
    }

    // Para una cuenta de área el filtro por Secretaría no tiene sentido
    // (siempre es la suya) y se agrega su cuota específica sobre el listado,
    // para que vea en una sola pantalla qué cargó y cuánto le queda. Para
    // un perfil central, el mismo bloque se despliega cuando elige una
    // Secretaría puntual en el filtro (ver bindEvents) — con 21
    // Secretarías a la vez no tendría sentido mostrar la cuota de todas
    // juntas, por eso solo aparece con el filtro aplicado.
    function renderAreaScope() {
        const secretariaSelect = document.getElementById('filterSecretaria');
        if (permissions.isAreaUser && secretariaSelect) secretariaSelect.hidden = true;

        const secretariaParaCuota = permissions.isAreaUser ? session.area : state.filterSecretaria;
        renderCuotaSecretaria(secretariaParaCuota);
    }

    function renderCuotaSecretaria(secretaria) {
        const cuotaWrapper = document.getElementById('suministrosCuotaArea');
        if (!cuotaWrapper) return;

        if (!secretaria) {
            cuotaWrapper.hidden = true;
            return;
        }

        const rutas = CuotaReal.evaluarRutas(secretaria).filter((ruta) => ruta.tieneDatos);
        const trimestre = CuotaReal.getTrimestreActual();
        cuotaWrapper.hidden = false;
        cuotaWrapper.innerHTML = `
            <h3>Cuota de ${secretaria}</h3>
            <p class="detail-text">Cuota, ejecución y economía disponible por fuente de financiamiento, acumuladas al ${trimestre}° trimestre (en curso), según la planilla oficial.</p>
            ${rutas.length === 0
                ? `<div class="empty-state">No se encontró información de cuota para ${secretaria}.</div>`
                : `<div class="rutas-grid">${rutas.map((ruta) => `
                    <div class="ruta-card ${ruta.tieneEconomia ? 'ruta-ok' : 'ruta-sin'}">
                        <div class="ruta-label">Fuente ${ruta.fuente}</div>
                        <div class="ruta-value">${ruta.disponible < 0 ? '-' : ''}$${SupplyUtils.formatNumber(Math.abs(ruta.disponible))}</div>
                        <div class="ruta-state">${ruta.tieneEconomia ? 'Economía disponible' : 'Cuota excedida'} · cuota a T${trimestre} $${SupplyUtils.formatNumber(ruta.cuotaAcumulada)} · ejecutado $${SupplyUtils.formatNumber(ruta.ejecucionAcumulada)}</div>
                    </div>
                `).join('')}</div>`}
        `;
    }

    function renderSourceNote(total) {
        const note = document.getElementById('suministrosSourceNote');
        if (!note) return;

        // Cuando el backend local está conectado (ver SuministrosData.
        // syncFromApi), los datos vienen de la base SQLite real, no del
        // archivo estático — se avisa acá para que quede claro con qué
        // fuente se está trabajando en este momento.
        const origen = SuministrosData.isApiConectada()
            ? ' · conectado a la base real (API local)'
            : '';

        if (total === 0) {
            note.textContent = (permissions.isAreaUser
                ? 'Su Secretaría todavía no tiene suministros cargados'
                : 'No se encontró la planilla de suministros (suministros-data.js)') + origen;
            return;
        }

        note.textContent = (permissions.isAreaUser
            ? `${total} suministros de ${session.area}`
            : `${total} registros cargados desde la planilla oficial`) + origen;
    }

    function populateFilterOptions() {
        const oficinaSelect = document.getElementById('filterOficina');
        const secretariaSelect = document.getElementById('filterSecretaria');

        // Las opciones salen del alcance del perfil: una cuenta de área solo
        // ve las oficinas por las que pasan sus propios suministros.
        const alcance = getScopedSupplies();
        const oficinas = [...new Set(alcance.map((item) => item.Oficina).filter(Boolean))].sort();

        if (oficinaSelect && oficinaSelect.options.length <= 1) {
            oficinas.forEach((oficina) => {
                const option = document.createElement('option');
                option.value = oficina;
                option.textContent = oficina;
                oficinaSelect.appendChild(option);
            });
        }

        // Todas las secretarías presentes en la planilla, no solo Economía,
        // ya que la Subsecretaría de Planificación hace seguimiento de todas.
        if (!permissions.isAreaUser && secretariaSelect && secretariaSelect.options.length <= 1) {
            SuministrosData.getSecretarias().forEach((secretaria) => {
                const option = document.createElement('option');
                option.value = secretaria;
                option.textContent = secretaria;
                secretariaSelect.appendChild(option);
            });
        }
    }

    // A diferencia de populateFilterOptions (que solo carga una vez), esta
    // función suma al filtro cualquier oficina nueva que haya aparecido por
    // una edición de Compras (por ejemplo, la primera vez que se usa
    // "Aprobado"), sin duplicar las que ya están.
    function syncOficinaFilterOptions() {
        const oficinaSelect = document.getElementById('filterOficina');
        if (!oficinaSelect) return;
        const existentes = new Set([...oficinaSelect.options].map((option) => option.value));
        SuministrosData.getOficinas().forEach((oficina) => {
            if (existentes.has(oficina)) return;
            const option = document.createElement('option');
            option.value = oficina;
            option.textContent = oficina;
            oficinaSelect.appendChild(option);
        });
    }

    function bindEvents() {
        const renderSuppliesDebounced = SupplyUtils.debounce(renderSupplies, 200);
        document.getElementById('searchSupply')?.addEventListener('input', (event) => {
            state.searchQuery = event.target.value;
            state.visibleCount = PAGINA_SUMINISTROS;
            renderSuppliesDebounced();
        });

        document.getElementById('filterOficina')?.addEventListener('change', (event) => {
            state.filterOficina = event.target.value;
            state.visibleCount = PAGINA_SUMINISTROS;
            renderSupplies();
        });

        document.getElementById('filterSecretaria')?.addEventListener('change', (event) => {
            state.filterSecretaria = event.target.value;
            state.visibleCount = PAGINA_SUMINISTROS;
            renderSupplies();
            // Solo aplica a perfiles centrales: para una cuenta de área el
            // filtro está oculto y su cuota ya se muestra siempre, fija.
            if (!permissions.isAreaUser) renderCuotaSecretaria(state.filterSecretaria);
        });

        document.getElementById('ordenamiento')?.addEventListener('change', (event) => {
            state.ordenamiento = event.target.value;
            state.visibleCount = PAGINA_SUMINISTROS;
            renderSupplies();
        });
    }

    function getFilteredSupplies() {
        const query = state.searchQuery.trim().toLowerCase();

        const filtrados = getScopedSupplies().filter((item) => {
            const matchesQuery = !query ||
                String(item.Suministro ?? '').includes(query) ||
                (item.Observaciones || '').toLowerCase().includes(query);
            const matchesOficina = !state.filterOficina || item.Oficina === state.filterOficina;
            const matchesSecretaria = !state.filterSecretaria || item.Secretaría === state.filterSecretaria;
            return matchesQuery && matchesOficina && matchesSecretaria;
        });

        filtrados.sort((a, b) => {
            switch (state.ordenamiento) {
                case 'fecha':
                    return new Date(b['Fecha de Carga'] || 0) - new Date(a['Fecha de Carga'] || 0);
                case 'secretaria':
                    return (a.Secretaría || '').localeCompare(b.Secretaría || '');
                case 'suministro':
                default:
                    return (a.Suministro || 0) - (b.Suministro || 0);
            }
        });

        return filtrados;
    }

    function renderSupplies() {
        const suppliesList = document.getElementById('suppliesList');
        const totalElement = document.getElementById('totalSupplies');
        const visibleElement = document.getElementById('visibleSupplies');
        if (!suppliesList || !totalElement) return;

        suppliesList.innerHTML = '';
        const filtered = getFilteredSupplies();

        if (filtered.length === 0) {
            suppliesList.innerHTML = `<div class="empty-state">No se encontraron suministros con los filtros aplicados.</div>`;
        }

        const visibles = filtered.slice(0, state.visibleCount);

        visibles.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'supply-row';
            row.tabIndex = 0;
            row.setAttribute('role', 'button');
            row.addEventListener('click', () => selectSupply(item.Suministro));
            row.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectSupply(item.Suministro);
                }
            });

            const observaciones = item.Observaciones || '—';

            // Columna Oficina: para quien puede validar (Dirección de Compras
            // y perfiles equivalentes) es un selector que despliega las 4
            // oficinas del circuito; para el resto sigue siendo solo lectura.
            const oficinaCell = permissions.canValidateCompras
                ? `<select class="oficina-select ${SuministrosData.oficinaClass(item.Oficina)}" aria-label="Cambiar oficina del suministro N° ${item.Suministro ?? ''}">${oficinaSelectOptions(item.Oficina)}</select>`
                : `<span class="status-badge ${SuministrosData.oficinaClass(item.Oficina)}">${item.Oficina || '—'}</span>`;

            // Adjudicado es el monto final real (lo que efectivamente salió
            // en la Orden de Compra); Sum Total es lo solicitado en un
            // principio. Pueden diferir mucho (se verificó: en el 73% de
            // los suministros con los dos datos cargados, difieren — a
            // veces varias veces el monto original). Se muestra Adjudicado
            // cuando ya existe, igual criterio que ya usan Analítica y el
            // detalle de este mismo listado.
            const montoMostrado = item.Adjudicado || item['Sum Total'] || item.Total || 0;
            const montoEsAdjudicado = Boolean(item.Adjudicado);

            row.innerHTML = `
                <div class="supply-id">N° ${item.Suministro ?? '—'}</div>
                <div class="supply-obs" title="${observaciones.replace(/"/g, '&quot;')}">${observaciones}</div>
                <div class="supply-estado">${oficinaCell}</div>
                <div class="supply-area">${item.Secretaría || '—'}</div>
                <div class="supply-estado">${item['Meses de consumo (cantidad)'] ?? '—'}</div>
                <div class="supply-periodo">${item['Mes de inicio'] || '—'}</div>
                <div class="supply-monto" title="${montoEsAdjudicado ? 'Adjudicado' : 'Solicitado (todavía sin Adjudicado)'}">${SuministrosData.formatMonto(montoMostrado)}</div>
            `;

            if (item.Suministro === state.selectedId) {
                row.classList.add('selected');
            }

            // El selector de oficina vive dentro de la fila clickeable: sin
            // frenar la propagación, abrir el menú o elegir una opción
            // dispararía también el click/keydown de la fila (que cambia el
            // suministro seleccionado en el detalle).
            const oficinaSelect = row.querySelector('.oficina-select');
            if (oficinaSelect) {
                ['click', 'mousedown', 'keydown'].forEach((evento) => {
                    oficinaSelect.addEventListener(evento, (event) => event.stopPropagation());
                });
                oficinaSelect.addEventListener('change', (event) => {
                    applyOficinaDesdeTabla(item.Suministro, event.target.value);
                });
            }

            suppliesList.appendChild(row);
        });

        if (filtered.length > visibles.length) {
            const restantes = filtered.length - visibles.length;
            const masBtn = document.createElement('button');
            masBtn.type = 'button';
            masBtn.className = 'btn ghost supplies-mostrar-mas';
            masBtn.textContent = `Mostrar ${Math.min(restantes, PAGINA_SUMINISTROS)} más (quedan ${restantes})`;
            masBtn.addEventListener('click', () => {
                state.visibleCount += PAGINA_SUMINISTROS;
                renderSupplies();
            });
            suppliesList.appendChild(masBtn);
        }

        totalElement.textContent = getScopedSupplies().length;
        if (visibleElement) visibleElement.textContent = filtered.length;
    }

    function selectSupply(id) {
        state.selectedId = id;
        renderSupplies();
        renderDetail();
    }

    function detailRow(label, value) {
        if (value === null || value === undefined || value === '') return '';
        return `<div><strong>${label}:</strong> ${value}</div>`;
    }

    function renderDetail() {
        const detailElement = document.getElementById('supplyDetail');
        if (!detailElement) return;

        // Se busca dentro del alcance del perfil: una cuenta de área nunca
        // puede abrir el detalle de un suministro de otra Secretaría.
        const selected = getScopedSupplies().find((item) => item.Suministro === state.selectedId) || null;
        if (!selected) {
            detailElement.innerHTML = `<div class="empty-state">Seleccione un suministro del listado para ver su detalle.</div>`;
            return;
        }

        // Aprobación: solo existe para suministros cargados desde Nuevo
        // suministro a partir de esta funcionalidad — la planilla real no
        // tiene este campo, así que acá no aparece la fila (detailRow ya
        // descarta undefined).
        let aprobacionTexto;
        if (selected.Aprobacion === 'Aprobado') {
            aprobacionTexto = `<span class="status-badge status-pending">Aprobado por ${selected.AprobadoPor} el ${SuministrosData.formatFecha(selected.FechaAprobacion)}</span>`;
        } else if (selected.Aprobacion === 'Pendiente') {
            aprobacionTexto = `<span class="status-badge status-rejected">Pendiente de aprobación (legajo 310019)</span>`;
        }

        const identificacion = [
            detailRow('N° Suministro', selected.Suministro),
            detailRow('Etiqueta', selected.Etiqueta),
            detailRow('Secretaría', selected.Secretaría),
            detailRow('Dependencia solicitante', selected['DependeNcia Solicitante']),
            detailRow('Oficina actual', `<span class="status-badge ${SuministrosData.oficinaClass(selected.Oficina)}">${selected.Oficina || '—'}</span>`),
            detailRow('Aprobación', aprobacionTexto),
            detailRow('Estado de cuota', selected.Cuota),
            detailRow('Mes de inicio', selected['Mes de inicio']),
            detailRow('Meses de consumo', selected['Meses de consumo (cantidad)']),
            detailRow('Fuente de financiamiento', selected['Fuente de Financiamiento'])
        ].filter(Boolean).join('');

        const montos = [
            detailRow('Monto solicitado', SuministrosData.formatMonto(selected['Sum Total'])),
            detailRow('Adjudicado', SuministrosData.formatMonto(selected.Adjudicado)),
            detailRow('Total', SuministrosData.formatMonto(selected.Total))
        ].filter(Boolean).join('');

        const fechas = [
            detailRow('Fecha de carga', SuministrosData.formatFecha(selected['Fecha de Carga'])),
            detailRow('Solicitud de gastos', SuministrosData.formatFecha(selected['Solicitud de Gastos'])),
            detailRow('Pedido de cotización', SuministrosData.formatFecha(selected['Pedido de Cotización'])),
            detailRow('Adjudicación', SuministrosData.formatFecha(selected['Adjud. '])),
            detailRow('Orden de compra', SuministrosData.formatFecha(selected['Órden de Compra'])),
            detailRow('Derivación a Economía', SuministrosData.formatFecha(selected['Fecha de derivación a Economía']))
        ].filter(Boolean).join('');

        // Hoja de ruta real de RAFAM (PedidosSuministro, cruce de
        // ctr_hojaruta_x.csv + ctr_ordencomprageneral.csv). El N° de
        // "Suministro" de esta planilla SÍ es el mismo número que el N°
        // de "Pedido de Suministro" de RAFAM (confirmado: coinciden 100%
        // de los montos comparables, 611/611). La duda que hubo antes fue
        // por un bug de parseo en build_pedidos_data.py -- confundía el N°
        // de Orden de Compra con el N° de Adjudicación (dos campos de
        // RAFAM que están pegados uno al lado del otro y son ambos
        // números, pero de entidades distintas), así que el cruce agarraba
        // la Orden de Compra equivocada casi siempre. Ya arreglado.
        const pedidoRafam = PedidosSuministro.getByNumero(selected.Suministro);

        // Proyección: cuánto falta para el próximo paso (y para el
        // devengamiento), estimado con la mediana real de días entre
        // pasos — no una fecha exacta, un "más o menos". Solo se muestra
        // si hay algo pendiente de verdad (ver Proyeccion.proyectar).
        const proyeccion = Proyeccion.proyectar(selected, pedidoRafam);
        let proyeccionHtml = '';
        if (proyeccion) {
            const pasosHtml = proyeccion.pasosPendientes
                .map((p) => detailRow(p.label, `~${SuministrosData.formatFecha(p.fecha.toISOString())}`))
                .filter(Boolean).join('');
            const recepcionHtml = !proyeccion.recepcion.esReal
                ? detailRow('Recepción (devengamiento)', `~${SuministrosData.formatFecha(proyeccion.recepcion.fecha.toISOString())}`)
                : '';
            const nota = proyeccion.tipoConocido
                ? `Estimado con los tiempos típicos de ${proyeccion.nombreTipo}.`
                : 'Estimado con el tiempo típico general (el tipo de proceso real recién se conoce cuando exista una Orden de Compra).';
            proyeccionHtml = `
                <h4 class="detail-subheading">Proyección</h4>
                <div class="detail-grid">${pasosHtml}${recepcionHtml}</div>
                <p class="field-hint">${nota} Son fechas aproximadas (mediana de suministros reales similares), no un compromiso.</p>
            `;
        }

        const hojaRuta = pedidoRafam
            ? [
                detailRow('Fuente (RAFAM)', pedidoRafam.fuente),
                detailRow('Proveedor', pedidoRafam.proveedor),
                detailRow('Concepto (RAFAM)', pedidoRafam.concepto),
                detailRow('Orden(es) de Compra', (pedidoRafam.ordenesCompra || []).length ? pedidoRafam.ordenesCompra.join(', ') : null),
                detailRow('Devengamiento', pedidoRafam.devengado
                    ? `Recibido el ${SuministrosData.formatFecha(pedidoRafam.fechaDevengamiento)}`
                    : 'Todavía no se registró la Recepción en RAFAM')
            ].filter(Boolean).join('')
            : '';

        detailElement.innerHTML = `
            <div class="detail-grid">${identificacion}</div>
            ${selected.Observaciones ? `<p class="detail-text"><strong>Observaciones:</strong> ${selected.Observaciones}</p>` : ''}
            <h4 class="detail-subheading">Montos</h4>
            <div class="detail-grid">${montos}</div>
            <h4 class="detail-subheading">Circuito administrativo</h4>
            <div class="detail-grid">${fechas}</div>
            ${proyeccionHtml}
            <h4 class="detail-subheading">Hoja de ruta (RAFAM)</h4>
            ${pedidoRafam
                ? `<div class="detail-grid">${hojaRuta}</div>${pedidoRafam.fuenteMixta ? `<p class="field-hint">Este pedido integra Órdenes de Compra de más de una Fuente; se muestra la de mayor monto — revisar en RAFAM.</p>` : ''}`
                : `<p class="detail-text">Sin Orden de Compra registrada todavía en RAFAM para este N° de Suministro.</p>`}
            ${permissions.canValidateCompras ? `<p class="detail-text">Para cambiar la oficina de este suministro, use el selector en la columna "Oficina" del listado.</p>` : ''}
        `;
    }

    // Gestión de Dirección de Compras (y perfiles con canValidateCompras):
    // mover el suministro a la oficina real que corresponda, directamente
    // desde la columna "Oficina" del listado (no desde el detalle). Elegir
    // una opción es aprobar (enviarlo a la oficina siguiente del circuito,
    // por ejemplo Secretaría de Economía o la Subsecretaría) o desaprobar
    // (enviarlo a "Anulado").
    function oficinaSelectOptions(actual) {
        // Las 4 oficinas reales del circuito, siempre en ese orden. Si el
        // dato cargado trae una oficina fuera de esa lista (dato viejo o
        // corregido a mano), se agrega igual como opción para no perder ni
        // reemplazar en silencio el valor actual al abrir el selector.
        const etapas = OFICINA_ETAPAS.includes(actual) || !actual
            ? OFICINA_ETAPAS
            : [...OFICINA_ETAPAS, actual];

        return etapas
            .map((etapa) => `<option value="${etapa}" ${etapa === actual ? 'selected' : ''}>${etapa}</option>`)
            .join('');
    }

    function showOficinaMessage(text) {
        const message = document.getElementById('oficinaUpdateMessage');
        if (!message) return;
        message.textContent = text;
        message.hidden = false;
    }

    function applyOficinaDesdeTabla(suministroId, nuevaOficina) {
        SuministrosData.setOficina(suministroId, nuevaOficina);
        syncOficinaFilterOptions();
        renderSupplies();
        renderDetail();
        showOficinaMessage(`Suministro N° ${suministroId}: oficina actualizada a "${nuevaOficina}".`);
    }

    return { init };
})();

/* ======================================================================
   EXCEL BRIDGE
   Conexión al backend local (sistema-de-suministros/backend) que escribe
   el alta directamente en la Tabla "suministros" del Excel real y guarda
   el archivo. Solo se llama para los legajos habilitados (secretarías
   320001-320022 y Secretaría de Economía 312890); el backend vuelve a
   validar el legajo del lado del servidor, así que esta lista es solo
   para decidir si conviene intentar la llamada, no la única barrera.
   Si el backend no está corriendo o falla, el alta queda igual en
   sessionStorage (como hasta ahora) y el CSV de Suministros sigue
   sirviendo de respaldo manual.
   ====================================================================== */
// Compartido entre los dos backends de altas automáticas (Excel local por
// COM y CSV en la nube vía GitHub): secretarías 320001-320022 y la
// Secretaría de Economía 312890. Cada backend vuelve a validar el legajo
// igual, esto solo decide si conviene intentar la llamada.
const LEGAJOS_AUTOMATIZADOS = new Set([
    ...Array.from({ length: 22 }, (_, i) => String(320001 + i)),
    '312890'
]);

const ExcelBridge = (() => {
    const BACKEND_URL = 'http://127.0.0.1:5175/api/altas';

    function aplicaPara(usuario) {
        return LEGAJOS_AUTOMATIZADOS.has(String(usuario));
    }

    // Devuelve { ok, error, dryRun } sin lanzar excepción: un backend caído
    // o inalcanzable es un resultado esperable (todavía no se instaló en
    // esta PC, o la app se está probando desde otro lugar), no un error de
    // programa.
    async function guardarAlta({ usuario, numeroSuministro, secretaria, jurisdiccion, mesInicio, mesesConsumo, fuente, oficina, observaciones }) {
        try {
            const response = await fetch(BACKEND_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ usuario, numeroSuministro, secretaria, jurisdiccion, mesInicio, mesesConsumo, fuente, oficina, observaciones })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) return { ok: false, error: data.error || `El backend respondió ${response.status}.` };
            return { ok: true, dryRun: Boolean(data.dryRun) };
        } catch (error) {
            return { ok: false, error: 'No se pudo conectar con el backend local (¿está corriendo sistema-de-suministros/backend?).' };
        }
    }

    return { aplicaPara, guardarAlta };
})();

/* ======================================================================
   CLOUD BRIDGE: backend en la nube (Flask, sin Excel/COM) que agrega el
   suministro nuevo como fila "pendiente" a ctr_hojaruta_x.csv en el
   repositorio de GitHub configurado (ver sistema-de-suministros/backend-cloud).
   Reemplazar BACKEND_URL por la URL real del servicio de Render una vez
   desplegado. Igual que ExcelBridge, nunca lanza excepción: si el backend
   en la nube está "dormido" (free tier) o inalcanzable, el alta sigue
   quedando en sessionStorage y el CSV manual sigue de respaldo.
   ====================================================================== */
const CloudBridge = (() => {
    const BACKEND_URL = 'https://suministros-backend-cloud.onrender.com/api/altas';

    function aplicaPara(usuario) {
        return LEGAJOS_AUTOMATIZADOS.has(String(usuario));
    }

    async function guardarAlta({ usuario, numeroSuministro, secretaria, jurisdiccion, mesInicio, mesesConsumo, fuente, oficina, observaciones }) {
        try {
            const response = await fetch(BACKEND_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ usuario, numeroSuministro, secretaria, jurisdiccion, mesInicio, mesesConsumo, fuente, oficina, observaciones })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) return { ok: false, error: data.error || `El backend en la nube respondió ${response.status}.` };
            return { ok: true, dryRun: Boolean(data.dryRun) };
        } catch (error) {
            return { ok: false, error: 'No se pudo conectar con el backend en la nube (puede estar "dormido": el primer pedido tras un rato sin uso tarda unos segundos).' };
        }
    }

    return { aplicaPara, guardarAlta };
})();

/* ======================================================================
   NUEVO SUMINISTRO PAGE (nuevo-suministro.html)
   Alta de una autorización provisional. Solo visible/operable para
   perfiles con permisos de autorización (responsables de área).

   El formulario solo pide número de suministro, mes de inicio y meses de
   consumo: el resto de los datos (dependencia, fuente, partida, monto,
   remito, etc.) se completa después en RAFAM al vincular el número de
   suministro con la planilla real.

   Controles que interrumpen la carga (pop up bloqueante):
   1. Suministro ya existente: si el número ya está en la planilla oficial
      o fue cargado antes en esta sesión, se muestra la advertencia con el
      registro en conflicto y no se crea nada.
   2. Sin economía en ninguna ruta: se evalúan TODAS las fuentes de
      financiamiento del área; si ninguna tiene economía, no se carga.

   Si el número es nuevo y alguna ruta tiene economía, se arma una línea
   nueva con las columnas del Excel de suministros, imputada a esa ruta.
   La línea queda visible en el listado de Suministros y en la página del
   área que la cargó.
   ====================================================================== */
const NuevoSuministroPage = (() => {
    let session = null;
    let permissions = null;

    // Datos de la última carga que se frenó en Control 3 por Fuente
    // excedida, guardados para "Solicitar aprobación de todos modos" (ver
    // ese botón más abajo) -- null en cualquier otro momento, y se
    // descarta al arrancar cualquier intento de carga nuevo (handleSupplySubmit).
    let solicitudCuotaExcedida = null;

    // Primera oficina del circuito: el suministro cargado por el área entra
    // por Secretaría de Economía, que es la que controla la cuota antes de
    // que el expediente pase a Dirección de Compras.
    const OFICINA_INICIAL = 'Secretaría de Economía';

    function init(activeSession) {
        session = activeSession;
        permissions = Auth.permissionsFor(session.rol);

        renderAccess();
        renderRutas();
        bindEvents();
    }

    function renderAccess() {
        const formWrapper = document.getElementById('supplyFormWrapper');
        const soloConsultaNote = document.getElementById('soloConsultaNote');
        const soloConsultaRol = document.getElementById('soloConsultaRol');

        if (formWrapper) formWrapper.hidden = !permissions.canAuthorize;
        if (soloConsultaNote) soloConsultaNote.hidden = permissions.canAuthorize;
        if (soloConsultaRol) soloConsultaRol.textContent = Auth.roleLabel(session.rol);

        const areaResponsable = document.getElementById('areaResponsable');
        if (areaResponsable) areaResponsable.value = session.area;
    }

    function pesos(value) {
        return `$${SupplyUtils.formatNumber(Math.abs(value))}`;
    }

    // Estado de las dos rutas (fuentes) del área, visible antes de cargar:
    // así el usuario sabe de antemano contra qué ruta se va a imputar el
    // suministro y cuánta economía queda en cada una.
    function renderRutas() {
        const wrapper = document.getElementById('rutasEvaluacion');
        if (!wrapper) return;

        const rutas = CuotaReal.evaluarRutas(session.area).filter((ruta) => ruta.tieneDatos);

        if (rutas.length === 0) {
            wrapper.innerHTML = `<div class="empty-state">No se encontró información de cuota para ${session.area}.</div>`;
            return;
        }

        wrapper.innerHTML = `
            <div class="rutas-grid">
                ${rutas.map((ruta) => `
                    <div class="ruta-card ${ruta.tieneEconomia ? 'ruta-ok' : 'ruta-sin'}">
                        <div class="ruta-label">Fuente ${ruta.fuente}</div>
                        <div class="ruta-value">${ruta.disponible < 0 ? '-' : ''}${pesos(ruta.disponible)}</div>
                        <div class="ruta-state">${ruta.tieneEconomia ? 'Con economía disponible' : 'Sin economía (cuota excedida)'}</div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    function bindEvents() {
        document.getElementById('supplyForm')?.addEventListener('submit', (event) => { handleSupplySubmit(event); });
    }

    // Pop up bloqueante: el suministro ya está cargado. Muestra dónde está
    // (oficina y secretaría) para que el usuario no vuelva a intentarlo.
    function advertirDuplicado(existente) {
        Modal.open({
            variant: 'danger',
            title: 'El suministro ya está cargado',
            message: `El suministro <strong>N° ${existente.Suministro}</strong> ya existe en la planilla de seguimiento. No se puede volver a cargar: si necesita corregirlo, debe hacerse sobre el registro existente.`,
            detalle: [
                ['Secretaría', existente.Secretaría || '—'],
                ['Oficina actual', existente.Oficina || '—'],
                ['Observaciones', existente.Observaciones || '—'],
                ['Mes de inicio', existente['Mes de inicio'] || '—'],
                ['Fecha de carga', SuministrosData.formatFecha(existente['Fecha de Carga'])]
            ]
        });
    }

    // Pop up bloqueante: el número ingresado no corresponde a ningún Pedido
    // de Suministro con Orden de Compra real en la hoja de ruta (ver
    // pedidos-suministro-data.js). Solo se pueden cargar números que ya
    // tengan al menos una orden real asociada.
    function advertirSinPedido(numero) {
        Modal.open({
            variant: 'danger',
            title: 'Todavía no está en el sistema',
            message: `El N° ${numero} todavía no está en el sistema: RAFAM no tiene registrada ninguna Orden de Compra real para ese número. Probá cargarlo más adelante, cuando ya tenga una orden real asociada — hasta entonces no se puede cargar.`
        });
    }

    // Pop up bloqueante: el N° de Pedido de Suministro es real, pero en
    // RAFAM (Jurisdicción/Unidad Ejecutora del pedido, ver
    // pedidos-suministro-data.js) pertenece a otra Secretaría, no a la de
    // la sesión iniciada. No es una cuestión de cuota -- no tiene sentido
    // ofrecer una excepción acá, así que no hay botón para forzarlo, a
    // diferencia de advertirPedidoSinEconomia.
    function advertirOtraSecretaria(numero, secretariaReal) {
        Modal.open({
            variant: 'danger',
            title: 'Ese N° no es de tu Secretaría',
            message: `El N° ${numero} pertenece a <strong>${secretariaReal}</strong> según RAFAM, no a ${session.area}. No se puede cargar desde esta cuenta.`
        });
    }

    // Pop up bloqueante: la Fuente real del pedido (no la 110 ni
    // necesariamente la elegida por margen) está excedida.
    function advertirPedidoSinEconomia(ruta) {
        Modal.open({
            variant: 'warning',
            title: `Fuente ${ruta.fuente} excedida`,
            message: `La Fuente ${ruta.fuente} está excedida. Puede solicitar una aprobación excepcional para cargarlo igual.`,
            detalle: [[
                `Fuente ${ruta.fuente}`,
                `excedido en ${pesos(ruta.disponible)}`
            ]],
            primaryLabel: 'Solicitar aprobación de todos modos',
            onPrimary: () => handleSolicitarAprobacion(),
            secondaryLabel: 'Cancelar',
            onSecondary: () => {
                solicitudCuotaExcedida = null;
                reiniciarFormulario();
            }
        });
    }

    // Deja el formulario listo para un intento nuevo: limpia los campos y
    // el cartel de abajo (que si no, se queda mostrando el error del
    // intento anterior aunque ya se haya cerrado el aviso -- confunde,
    // parece que el formulario quedó "trabado" en la carga cancelada).
    function reiniciarFormulario() {
        document.getElementById('supplyForm')?.reset();
        const messageDiv = document.getElementById('supplyMessage');
        if (messageDiv) {
            messageDiv.textContent = '';
            messageDiv.className = 'message';
        }
    }

    async function handleSupplySubmit(event) {
        event.preventDefault();
        const supplyForm = event.target;
        const submitBtn = supplyForm.querySelector('button[type="submit"]');

        // Cualquier intento de carga nuevo invalida una solicitud de
        // aprobación por cuota excedida que hubiera quedado de un intento
        // anterior (otro N°, u otra corrida del mismo) -- nunca debe poder
        // "Solicitar aprobación de todos modos" con datos de una carga que
        // ya no es la que se acaba de intentar.
        solicitudCuotaExcedida = null;

        if (!permissions.canAuthorize) {
            setMessage('Su perfil no está habilitado para emitir autorizaciones provisionales.', 'error');
            return;
        }

        // El área se toma de la sesión, nunca del formulario, para que la
        // autorización solo pueda ser emitida por el área habilitada.
        const area = session.area;
        const numeroSuministro = document.getElementById('numeroSuministro').value;
        const mesInicio = document.getElementById('mesInicio').value;
        const mesesConsumoInput = document.getElementById('mesesConsumo').value;
        const mesesConsumo = Number(mesesConsumoInput);

        if (!numeroSuministro || !mesInicio || !mesesConsumoInput) {
            setMessage('Por favor, complete el número de suministro, el mes de inicio y los meses de consumo.', 'error');
            return;
        }

        if (!Number.isInteger(mesesConsumo) || mesesConsumo < 1) {
            setMessage('Los meses de consumo deben ser un número entero mayor a 0. No se permiten decimales.', 'error');
            return;
        }

        // El mes de inicio + los meses de consumo no pueden terminar
        // después de diciembre de 2026. Se calcula el mes de fin como
        // índice absoluto (mes de inicio + N-1 meses) para no depender de
        // objetos Date, que corren el riesgo de desfasarse por huso
        // horario con inputs type="month".
        const [anioInicio, numeroMesInicio] = mesInicio.split('-').map(Number);
        const indiceMesFin = (anioInicio * 12 + (numeroMesInicio - 1)) + (mesesConsumo - 1);
        const anioFin = Math.floor(indiceMesFin / 12);
        const mesFin = (indiceMesFin % 12) + 1;
        if (anioFin > 2026) {
            setMessage(`El mes de inicio y los meses de consumo no pueden superar diciembre de 2026: con estos datos, el suministro terminaría en ${String(mesFin).padStart(2, '0')}/${anioFin}.`, 'error');
            return;
        }

        // Control 1: suministro ya cargado. Corta el procedimiento antes de
        // evaluar cuota, para no reservar ni imputar nada de un duplicado.
        const existente = SuministrosData.findByNumero(numeroSuministro);
        if (existente) {
            advertirDuplicado(existente);
            setMessage(`El suministro N° ${numeroSuministro} ya está cargado. La carga fue cancelada.`, 'error');
            return;
        }

        // Control 2: el número tiene que corresponder a un Pedido de
        // Suministro con al menos una Orden de Compra real en la hoja de
        // ruta (pedidos-suministro-data.js). No se cargan suministros "en
        // blanco": del pedido salen la Fuente y el Monto reales, no se
        // estiman.
        const pedido = PedidosSuministro.getByNumero(numeroSuministro);
        if (!pedido) {
            advertirSinPedido(numeroSuministro);
            setMessage(`El N° ${numeroSuministro} todavía no está en el sistema (sin Orden de Compra en RAFAM). Probá más adelante. La carga fue cancelada.`, 'error');
            return;
        }

        const fuenteTexto = String(pedido.fuente);
        const mensajeFuenteMixta = pedido.fuenteMixta
            ? ` Atención: este pedido integra Órdenes de Compra de más de una Fuente; se usó la de mayor monto (${fuenteTexto}) — revisar en RAFAM.`
            : '';

        // Control 2.5: el pedido tiene que ser realmente de la Secretaría
        // de la sesión -- no de otra. "pedido.secretaria" sale de cruzar la
        // Jurisdicción/Unidad Ejecutora real del pedido en RAFAM contra la
        // planilla oficial (ver build_pedidos_data.py); si no se pudo
        // resolver con certeza (pedido nuevo con un código nunca antes
        // visto), no hay con qué validar y se deja pasar, en vez de
        // bloquear por las dudas.
        if (pedido.secretaria && pedido.secretaria !== area) {
            advertirOtraSecretaria(numeroSuministro, pedido.secretaria);
            setMessage(`El N° ${numeroSuministro} pertenece a otra Secretaría. La carga fue cancelada.`, 'error');
            return;
        }

        // Control 3: si la Fuente del pedido es una de las que la app
        // controla (110/131), tiene que tener economía disponible. Fuentes
        // fuera de ese control (132, 220, etc. — sin planilla de cuota
        // cargada) se dejan pasar, avisando que no hay control de cuota
        // para esa fuente.
        if (CuotaReal.hasFuente(fuenteTexto)) {
            const ruta = CuotaReal.evaluarRutas(area).find((r) => r.fuente === fuenteTexto);
            if (!ruta || !ruta.tieneDatos) {
                setMessage(`No hay información de cuota real para ${area} en la Fuente ${fuenteTexto}. No se puede cargar el suministro.`, 'error');
                return;
            }
            if (!ruta.tieneEconomia) {
                // Se guarda todo lo que hace falta para completar la carga
                // si el usuario elige "Solicitar aprobación de todos modos"
                // en el pop up (ver handleSolicitarAprobacion) -- no se
                // reserva cuota ni se crea el alta todavía, eso solo pasa
                // si confirma ahí.
                solicitudCuotaExcedida = { numeroSuministro, mesInicio, mesesConsumo, pedido, area, fuenteTexto, ruta, mensajeFuenteMixta };
                advertirPedidoSinEconomia(ruta);
                return;
            }
            // Reserva en memoria de esta sesión: descuenta el monto real
            // del pedido de la cuota disponible mostrada mientras el
            // suministro esté pendiente de aprobación (no se toca la
            // planilla de cuota real).
            CuotaReal.reservar(area, fuenteTexto, pedido.monto);
        }

        await crearAltaCompleta({ numeroSuministro, mesInicio, mesesConsumo, pedido, area, mensajeFuenteMixta, cuotaExcedida: false, supplyForm, submitBtn });
    }

    // Confirma "Solicitar aprobación de todos modos" (Control 3 frenó por
    // Fuente excedida). Reserva igual el monto -- aunque ya esté en rojo,
    // así el legajo 310019 ve exactamente cuánto más se estaría
    // autorizando por encima de la cuota real al revisarlo en Aprobaciones
    // -- y arma el alta marcada con CuotaExcedida (ver buildAlta), para
    // que se distinga de una carga normal en el panel.
    async function handleSolicitarAprobacion() {
        if (!solicitudCuotaExcedida) return;
        const { numeroSuministro, mesInicio, mesesConsumo, pedido, area, fuenteTexto, mensajeFuenteMixta } = solicitudCuotaExcedida;
        solicitudCuotaExcedida = null;

        CuotaReal.reservar(area, fuenteTexto, pedido.monto);

        const supplyForm = document.getElementById('supplyForm');
        const submitBtn = supplyForm?.querySelector('button[type="submit"]');
        await crearAltaCompleta({ numeroSuministro, mesInicio, mesesConsumo, pedido, area, mensajeFuenteMixta, cuotaExcedida: true, supplyForm, submitBtn });
    }

    // Común a la carga normal (Control 3 con economía) y a "Solicitar
    // aprobación de todos modos" (Control 3 sin economía, pero igual se
    // pidió elevarlo): arma el alta, descarga el remito, intenta los dos
    // backends y arma el mensaje final. cuotaExcedida solo cambia el texto
    // del mensaje y la marca que lleva el alta (ver buildAlta).
    async function crearAltaCompleta({ numeroSuministro, mesInicio, mesesConsumo, pedido, area, mensajeFuenteMixta, cuotaExcedida, supplyForm, submitBtn }) {
        // Se arma la línea nueva del Excel, imputada a la Fuente real del
        // pedido, con el concepto real como Observaciones y el monto real
        // para el detalle de la app (no se exporta a la planilla real:
        // Sum Total sigue siendo una fórmula que completa RAFAM).
        const nuevaLinea = await SuministrosData.addAlta({
            numeroSuministro,
            secretaria: area,
            jurisdiccion: null,
            mesInicio,
            mesesConsumo,
            fuente: pedido.fuente,
            oficina: OFICINA_INICIAL,
            observaciones: pedido.concepto || undefined,
            monto: pedido.monto,
            etiqueta: 'PENDIENTE',
            cuotaExcedida
        });

        const newSupply = {
            id: Store.nextId(),
            area,
            numeroSuministro,
            mesInicio,
            mesesConsumo,
            fuente: pedido.fuente,
            monto: pedido.monto,
            concepto: pedido.concepto,
            proveedor: pedido.proveedor,
            estado: 'provisional',
            detalle: 'Autorización provisional emitida por responsable del área. El resto de los datos del suministro se completa en RAFAM al vincular el número de suministro.'
        };

        Store.addSupply(newSupply);

        // Remito de la solicitud de cuota (.pdf): es un comprobante de que
        // HAY cuota real reservada para esto -- si se cargó por "Solicitar
        // aprobación de todos modos" (Fuente ya excedida), todavía no hay
        // ninguna cuota real que lo respalde, así que no corresponde
        // generarlo. Para la carga normal, si falla (logo ausente,
        // navegador sin soporte), no debe frenar la carga, que ya quedó
        // guardada -- solo se avisa si no se pudo, en silencio si salió bien.
        let mensajeRemito;
        if (cuotaExcedida) {
            mensajeRemito = ' No se pudo descargar el remito: la cuota está excedida.';
        } else {
            const remito = await RemitoPDF.descargar({
                fecha: new Date(),
                secretaria: area,
                numeroSuministro,
                idSolicitud: newSupply.id
            });
            mensajeRemito = remito.ok ? '' : ' No se pudo generar el remito.';
        }

        // Carga automática, en paralelo, a los dos backends: el Excel real
        // local (COM, solo corre en la PC de la oficina) y la hoja de ruta
        // en la nube (CSV en GitHub, ver backend-cloud/). Se disparan juntos
        // con Promise.all para que el "despertar" del servicio en la nube
        // (free tier de Render) no duplique la espera del Excel local.
        // Ambos backends ya devuelven {ok, error} sin lanzar excepción, y
        // ninguno de los dos debe frenar al otro ni al alta ya guardada en
        // sessionStorage. Solo para los legajos habilitados; cada backend
        // vuelve a validar el legajo igual. Ninguno de los dos resultados
        // se muestra en el mensaje final (a pedido: cuanto menos explique
        // el cartel, mejor) -- si el Excel real necesita el CSV a mano
        // igual está disponible en Suministros.
        if (LEGAJOS_AUTOMATIZADOS.has(String(session.usuario))) {
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Guardando...'; }

            const datosAlta = {
                usuario: session.usuario,
                numeroSuministro,
                secretaria: area,
                jurisdiccion: null,
                mesInicio,
                mesesConsumo,
                fuente: pedido.fuente,
                oficina: OFICINA_INICIAL,
                observaciones: nuevaLinea.Observaciones
            };

            await Promise.all([
                ExcelBridge.guardarAlta(datosAlta),
                CloudBridge.guardarAlta(datosAlta)
            ]);

            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Solicitar aprobación provisional'; }
        }

        setMessage(
            `Suministro N° ${numeroSuministro} cargado. Está pendiente de aprobación.` +
            mensajeFuenteMixta +
            mensajeRemito,
            'success', newSupply.id
        );
        if (supplyForm) supplyForm.reset();
        renderAccess();
        renderRutas();
    }

    function setMessage(text, type, newSupplyId) {
        const messageDiv = document.getElementById('supplyMessage');
        if (!messageDiv) return;
        messageDiv.className = `message ${type}`;
        if (newSupplyId) {
            messageDiv.textContent = `${text} `;
            const link = document.createElement('a');
            link.href = 'suministros.html';
            link.textContent = 'Ver en Suministros →';
            messageDiv.appendChild(link);
        } else {
            messageDiv.textContent = text;
        }
    }

    return { init };
})();

/* ======================================================================
   PRESUPUESTO PAGE (presupuesto.html)
   Informe real de cuota, ejecución y exceso/economía anual por
   Secretaría, con selector de Fuente de Financiamiento (110 y 131),
   restringido a los usuarios centrales (responsable, compras, dirección
   de compras, auditoría).
   ====================================================================== */
const PresupuestoPage = (() => {
    let fuenteActual = '110';
    // 'acumulado' = desde el trimestre I hasta el actual (lo realmente
    // disponible hoy, mismo criterio que gatea la carga de un suministro
    // nuevo); '1'..'4' = un trimestre puntual; 'anual' = el total del año,
    // igual que mostraba este informe antes. Todas estas vistas ya vienen
    // calculadas en la planilla oficial (hojas "cuota 110"/"cuota 131"),
    // esto solo elige qué columnas mostrar.
    let periodoActual = 'acumulado';

    const PERIODOS = [
        { value: 'acumulado', label: `Acumulado a la fecha (a T${CuotaReal.getTrimestreActual()})` },
        { value: '1', label: '1er trimestre' },
        { value: '2', label: '2do trimestre' },
        { value: '3', label: '3er trimestre' },
        { value: '4', label: '4to trimestre' },
        { value: 'anual', label: 'Total anual' }
    ];

    function init(session) {
        const permissions = Auth.permissionsFor(session.rol);
        const content = document.getElementById('presupuestoContent');
        const restrictedNote = document.getElementById('presupuestoRestrictedNote');

        if (permissions.isAreaUser) {
            if (content) content.hidden = true;
            if (restrictedNote) restrictedNote.hidden = false;
            return;
        }

        populateFuenteOptions();
        populatePeriodoOptions();
        bindEvents();
        renderAll();
    }

    function populateFuenteOptions() {
        const select = document.getElementById('presupuestoFuente');
        if (!select || select.options.length > 0) return;

        CuotaReal.getFuentes().forEach((fuente) => {
            const option = document.createElement('option');
            option.value = fuente;
            option.textContent = `Fuente ${fuente}`;
            select.appendChild(option);
        });
        select.value = fuenteActual;
    }

    function populatePeriodoOptions() {
        const select = document.getElementById('presupuestoTrimestre');
        if (!select || select.options.length > 0) return;

        select.innerHTML = PERIODOS.map((p) => `<option value="${p.value}">${p.label}</option>`).join('');
        select.value = periodoActual;
    }

    function bindEvents() {
        document.getElementById('presupuestoFuente')?.addEventListener('change', (event) => {
            fuenteActual = event.target.value;
            renderAll();
        });
        document.getElementById('presupuestoTrimestre')?.addEventListener('change', (event) => {
            periodoActual = event.target.value;
            renderAll();
        });
    }

    // Cuota/Ejecución/Exceso del período elegido para un registro (Secretaría
    // o el total municipal) — mismos 3 datos, sea cual sea el período.
    function valoresPeriodo(registro) {
        if (!registro) return { cuota: 0, ejecucion: 0, exceso: 0 };
        if (periodoActual === 'anual') {
            return { cuota: registro.cuotaAnual, ejecucion: registro.ejecucionAnual, exceso: registro.excesoAnual };
        }
        if (periodoActual === 'acumulado') {
            return CuotaReal.getAcumuladoHasta(registro, CuotaReal.getTrimestreActual());
        }
        const t = Number(periodoActual) - 1;
        return {
            cuota: registro.cuotaTrimestral?.[t] || 0,
            ejecucion: registro.ejecucionTrimestral?.[t] || 0,
            exceso: registro.excesoTrimestral?.[t] || 0
        };
    }

    function labelPeriodo() {
        return PERIODOS.find((p) => p.value === periodoActual)?.label || '';
    }

    function renderAll() {
        const subtitle = document.getElementById('presupuestoSubtitle');
        if (subtitle) {
            subtitle.textContent = `Cuota, ejecución y exceso/economía por Secretaría — ${labelPeriodo()}, Fuente de Financiamiento ${fuenteActual}. Planilla oficial.`;
        }
        const nota = document.getElementById('presupuestoNotaExceso');
        if (nota) {
            nota.textContent = `Exceso/economía = Cuota − Ejecución del período elegido (${labelPeriodo()}). Negativo (en rojo) indica que la Secretaría ejecutó por encima de su cuota de ese período.`;
        }
        const header = document.getElementById('presupuestoTablaHeader');
        if (header) {
            header.innerHTML = `<div>Secretaría</div><div>Cuota</div><div>Ejecución</div><div>Exceso / economía</div>`;
        }
        renderStats();
        renderTabla();
    }

    function pesos(value) {
        return `$${SupplyUtils.formatNumber(value)}`;
    }

    function renderStats() {
        const statsRow = document.getElementById('presupuestoStats');
        if (!statsRow) return;

        const secretarias = CuotaReal.getAll(fuenteActual).map((s) => ({ s, v: valoresPeriodo(s) }));
        const total = CuotaReal.getTotal(fuenteActual);
        const totalValores = valoresPeriodo(total);
        const conExceso = secretarias.filter(({ v }) => v.exceso < 0).length;
        const conEconomia = secretarias.filter(({ v }) => v.exceso > 0).length;

        const cards = [
            { label: 'Secretarías', value: secretarias.length, cls: 'stat-total' },
            { label: 'Con exceso de cuota', value: conExceso, cls: 'stat-rejected' },
            { label: 'Con economía disponible', value: conEconomia, cls: 'stat-pending' },
            { label: 'Exceso/economía municipio', value: total ? pesos(totalValores.exceso) : '—', cls: total && totalValores.exceso < 0 ? 'stat-rejected' : 'stat-pending' }
        ];

        statsRow.innerHTML = cards.map((card) => `
            <div class="stat-card ${card.cls}">
                <div class="stat-value">${card.value}</div>
                <div class="stat-label">${card.label}</div>
            </div>
        `).join('');
    }

    function renderTabla() {
        const list = document.getElementById('presupuestoList');
        if (!list) return;

        const secretarias = CuotaReal.getAll(fuenteActual)
            .map((s) => ({ s, v: valoresPeriodo(s) }))
            .sort((a, b) => a.v.exceso - b.v.exceso);

        if (secretarias.length === 0) {
            list.innerHTML = `<div class="empty-state">No se encontró el informe de cuota para la Fuente ${fuenteActual}.</div>`;
            return;
        }

        list.innerHTML = secretarias.map(({ s, v }) => {
            // Sin "(pasada de cuota)"/"(cuota sobrante)" repetido en cada
            // fila: ya lo dice una sola vez arriba de la tabla
            // (presupuestoNotaExceso) y el color de cada fila ya distingue
            // una cosa de la otra -- decirlo de nuevo en las 22 filas es
            // ruido, no aclara nada que no se entienda ya.
            const excesoClass = v.exceso < 0 ? 'presupuesto-exceso-negativo' : 'presupuesto-exceso-positivo';
            const excesoTexto = v.exceso < 0 ? `-${pesos(Math.abs(v.exceso))}` : pesos(v.exceso);

            return `
                <div class="supply-row presupuesto-row">
                    <div class="supply-area">${s.secretaria}</div>
                    <div class="presupuesto-monto">${pesos(v.cuota)}</div>
                    <div class="presupuesto-monto">${pesos(v.ejecucion)}</div>
                    <div class="presupuesto-monto ${excesoClass}">${excesoTexto}</div>
                </div>
            `;
        }).join('');
    }

    return { init };
})();

/* ======================================================================
   DIFUSIÓN (difusion.html)
   Réplica de la hoja "difusión" de la planilla real: la cuota liberada
   trimestre a trimestre, pensada para comunicarle a cada Secretaría
   cuánto tiene disponible. A diferencia de Presupuesto, si es para
   cuentas de área (es justamente el reporte armado para mostrarles).

   "Cuota liberada inicial" y "Suministros en ejecución" son los mismos
   cuotaTrimestral/ejecucionTrimestral que ya usa el resto del sitio
   (CuotaReal) -- no son datos nuevos. "Cuota liberada restante" sí es un
   cálculo propio de esta hoja: la cuota de cada trimestre es un pozo
   fresco (un trimestre en economía NO le suma margen al siguiente), pero
   si un trimestre cerró en rojo, ese déficit sí se arrastra y hay que
   cubrirlo con la cuota del que sigue.

   Nota: la fórmula original del Excel (columna "Resultados trimestres
   anteriores") tenía esta misma regla en III y IV, pero en II el arrastre
   estaba hardcodeado en 0 en vez de tener la fórmula -- una inconsistencia
   del propio Excel, no un criterio a propósito. Acá se aplica la regla
   pareja a los 4 trimestres.
   ====================================================================== */
const DifusionPage = (() => {
    const TRIMESTRES = ['I', 'II', 'III', 'IV'];

    function pesos(value) {
        return Number.isFinite(value) ? `$${SupplyUtils.formatNumber(Math.round(value))}` : '—';
    }

    function init(session) {
        const permissions = Auth.permissionsFor(session.rol);
        const selectorWrapper = document.getElementById('difusionSelectorWrapper');
        const select = document.getElementById('difusionSecretariaSelect');
        const nota = document.getElementById('difusionNotaArea');

        if (permissions.isAreaUser) {
            if (selectorWrapper) selectorWrapper.hidden = true;
            if (nota) {
                nota.hidden = false;
                nota.textContent = `Mostrando la cuota liberada de ${session.area}.`;
            }
            render(session.area);
            return;
        }

        if (nota) nota.hidden = true;
        if (!selectorWrapper || !select) return;
        selectorWrapper.hidden = false;

        const secretarias = [...CuotaReal.getAll('110')].map((s) => s.secretaria).sort((a, b) => a.localeCompare(b, 'es'));
        select.innerHTML = secretarias.map((s) => `<option value="${s}">${s}</option>`).join('');
        select.addEventListener('change', () => render(select.value));
        if (secretarias.length) render(secretarias[0]);
    }

    // Cascada "el déficit se arrastra, la economía no": ver comentario del
    // módulo. Devuelve los 4 arrays (I..IV) que arma la tabla.
    function calcularBloque(secretaria, fuente) {
        const registro = CuotaReal.getBySecretaria(secretaria, fuente);
        const cuota = registro ? registro.cuotaTrimestral : [0, 0, 0, 0];
        const ejecucion = registro ? registro.ejecucionTrimestral : [0, 0, 0, 0];

        const resultadosAnteriores = [0, 0, 0, 0];
        const restante = [0, 0, 0, 0];
        for (let i = 0; i < 4; i++) {
            resultadosAnteriores[i] = i > 0 && restante[i - 1] < 0 ? restante[i - 1] : 0;
            restante[i] = cuota[i] - ejecucion[i] + resultadosAnteriores[i];
        }

        return { cuota, ejecucion, resultadosAnteriores, restante };
    }

    function filaHtml(etiqueta, valores, total, claseFila) {
        return `
            <tr${claseFila ? ` class="${claseFila}"` : ''}>
                <td>${etiqueta}</td>
                ${valores.map((v) => `<td>${pesos(v)}</td>`).join('')}
                <td>${pesos(total)}</td>
            </tr>
        `;
    }

    function bloqueHtml(titulo, secretaria, fuente) {
        const { cuota, ejecucion, resultadosAnteriores, restante } = calcularBloque(secretaria, fuente);
        const sum = (arr) => arr.reduce((a, b) => a + b, 0);

        return `
            <div class="dashboard-section">
                <h3>${titulo}</h3>
                <div class="table-scroll">
                    <table class="difusion-table">
                        <thead>
                            <tr><th></th>${TRIMESTRES.map((t) => `<th>${t}</th>`).join('')}<th>Total anual</th></tr>
                        </thead>
                        <tbody>
                            ${filaHtml('Cuota liberada inicial', cuota, sum(cuota))}
                            ${filaHtml('Suministros en ejecución (*)', ejecucion, sum(ejecucion))}
                            ${filaHtml('Resultados trimestres anteriores', resultadosAnteriores, sum(resultadosAnteriores))}
                            ${filaHtml('Cuota liberada restante', restante, sum(cuota) - sum(ejecucion), 'difusion-total')}
                        </tbody>
                    </table>
                </div>
                <p class="field-hint">(*) No incluye suministros recepcionados y luego anulados, ni los "pausados".</p>
            </div>
        `;
    }

    function render(secretaria) {
        const content = document.getElementById('difusionContent');
        if (!content) return;
        content.innerHTML = `
            ${bloqueHtml('Cuota de libre disponibilidad (Fuente 110)', secretaria, '110')}
            ${bloqueHtml('Cuota afectada (Fuente 131)', secretaria, '131')}
        `;
    }

    return { init };
})();

/* ======================================================================
   CHARTS
   Gráficos de barras horizontales en HTML/CSS puro (sin librerías ni
   canvas/SVG): cada barra es un <div> con ancho en % dentro de una pista,
   igual criterio que el resto del sitio. Dos formas:
     - renderBarChart: magnitud simple, crece desde cero (cantidades,
       montos, conceptos).
     - renderDivergingChart: polaridad, crece desde una línea central en
       cero hacia la izquierda (rojo, excedida) o la derecha (verde, con
       economía) — para exceso/economía de cuota.
   El valor completo va como texto al final de la fila (nunca se recorta),
   y la etiqueta lleva title="" con el texto completo por si el nombre no
   entra en la columna.
   ====================================================================== */
const Charts = (() => {
    function escapeHtml(texto) {
        return String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // items: [{ label, value, cls }] — cls opcional: 'chart-bar-good' /
    // 'chart-bar-bad' para colorear una barra puntual (si no, usa el azul
    // por defecto). formatValue(value) → texto del valor.
    function renderBarChart(containerId, items, { formatValue = String } = {}) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!items.length) {
            container.innerHTML = `<div class="empty-state">Sin datos para mostrar.</div>`;
            return;
        }

        const max = Math.max(...items.map((item) => Math.abs(item.value)), 1);

        container.innerHTML = items.map((item) => {
            const pct = Math.max((Math.abs(item.value) / max) * 100, item.value === 0 ? 0 : 1);
            const valorCls = item.cls === 'chart-bar-bad' ? 'chart-value-bad' : item.cls === 'chart-bar-good' ? 'chart-value-good' : '';
            return `
                <div class="chart-row">
                    <div class="chart-row-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</div>
                    <div class="chart-row-track">
                        <div class="chart-row-bar ${item.cls || ''}" style="width:${pct}%" title="${escapeHtml(item.label)}: ${escapeHtml(formatValue(item.value))}"></div>
                    </div>
                    <div class="chart-row-value ${valorCls}">${escapeHtml(formatValue(item.value))}</div>
                </div>
            `;
        }).join('');
    }

    // items: [{ label, value }], value puede ser negativo (excedida, rojo,
    // crece a la izquierda) o positivo (con economía, verde, crece a la
    // derecha), desde una línea central en cero.
    function renderDivergingChart(containerId, items, { formatValue = String } = {}) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!items.length) {
            container.innerHTML = `<div class="empty-state">Sin datos para mostrar.</div>`;
            return;
        }

        const maxAbs = Math.max(...items.map((item) => Math.abs(item.value)), 1);

        const legend = `
            <div class="chart-legend">
                <span class="chart-legend-item"><span class="chart-legend-swatch" style="background-color:var(--dark-gray)"></span>Con economía</span>
                <span class="chart-legend-item"><span class="chart-legend-swatch" style="background-color:var(--primary-red)"></span>Excedida</span>
            </div>
        `;

        const filas = items.map((item) => {
            const pct = Math.max((Math.abs(item.value) / maxAbs) * 50, item.value === 0 ? 0 : 1);
            const esExcedida = item.value < 0;
            const style = esExcedida
                ? `right:50%; width:${pct}%;`
                : `left:50%; width:${pct}%;`;
            const valorCls = esExcedida ? 'chart-value-bad' : 'chart-value-good';
            return `
                <div class="chart-row">
                    <div class="chart-row-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</div>
                    <div class="chart-diverge-track">
                        <div class="chart-diverge-zero"></div>
                        <div class="chart-diverge-bar ${esExcedida ? 'chart-bar-bad' : 'chart-bar-good'}" style="${style}" title="${escapeHtml(item.label)}: ${escapeHtml(formatValue(item.value))}"></div>
                    </div>
                    <div class="chart-row-value ${valorCls}">${escapeHtml(formatValue(item.value))}</div>
                </div>
            `;
        }).join('');

        container.innerHTML = legend + filas;
    }

    // Rótulo arriba de cada columna: los montos grandes van abreviados en
    // millones ("$6.373 M") para que las 12 columnas entren sin barra de
    // desplazamiento; el monto completo queda en el tooltip de la barra.
    function rotuloColumna(valor, formatValue) {
        const texto = formatValue(valor);
        if (!String(texto).startsWith('$') || Math.abs(valor) < 1e6) return texto;
        const millones = valor / 1e6;
        return `$${millones.toLocaleString('es-AR', { maximumFractionDigits: Math.abs(millones) >= 100 ? 0 : 1 })} M`;
    }

    // items: [{ label, value }], crecen en columna desde una base común —
    // para series en el tiempo (por mes) o histogramas (por bin), donde el
    // orden de izquierda a derecha importa (no se reordenan por valor).
    function renderColumnChart(containerId, items, { formatValue = String } = {}) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!items.length) {
            container.innerHTML = `<div class="empty-state">Sin datos para mostrar.</div>`;
            return;
        }

        const max = Math.max(...items.map((item) => item.value), 1);

        container.innerHTML = `<div class="chart-columns">${items.map((item) => {
            const pct = Math.max((item.value / max) * 100, item.value === 0 ? 0 : 2);
            return `
                <div class="chart-column">
                    <div class="chart-column-value">${escapeHtml(rotuloColumna(item.value, formatValue))}</div>
                    <div class="chart-column-bar" style="height:${pct}%" title="${escapeHtml(item.label)}: ${escapeHtml(formatValue(item.value))}"></div>
                    <div class="chart-column-label">${escapeHtml(item.label)}</div>
                </div>
            `;
        }).join('')}</div>`;
    }

    // series: [{ name, values, color }], todas con un valor por cada
    // entrada de "categories" (mismo orden) — para comparar 2 series en el
    // tiempo (ej. cuota vs. ejecutado por trimestre). Solo la última serie
    // lleva etiqueta directa en la punta (evita que choquen dos etiquetas);
    // el resto se lee por leyenda y por tooltip en cada punto.
    function renderTrendLines(containerId, { categories, series, formatValue = String }) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!categories.length || !series.length) {
            container.innerHTML = `<div class="empty-state">Sin datos para mostrar.</div>`;
            return;
        }

        const width = 640;
        const height = 220;
        const padL = 8;
        const padR = 90;
        const padT = 16;
        const padB = 30;
        const plotW = width - padL - padR;
        const plotH = height - padT - padB;

        // minV siempre incluye 0 (Math.min(..., 0)): con series todas
        // positivas (ej. Cuota vs. Ejecutado) da minV=0, idéntico al
        // comportamiento de antes. Con series que bajan de 0 (ej. Pasivo,
        // Patrimonio Neto en negativo), el eje arranca más abajo que 0 y
        // se dibuja una línea de cero aparte -- sin esto, un valor
        // negativo se salía del gráfico por abajo.
        const allValues = series.flatMap((s) => s.values);
        const minV = Math.min(...allValues, 0);
        const maxV = Math.max(...allValues, 1);
        const range = maxV - minV;
        const stepX = categories.length > 1 ? plotW / (categories.length - 1) : 0;
        const xFor = (i) => padL + stepX * i;
        const yFor = (v) => padT + plotH - ((v - minV) / range) * plotH;

        // 3 líneas de grilla horizontales (recesivas, hairline), en
        // minV/medio/maxV, con su valor a la izquierda.
        const grid = [0, 0.5, 1].map((frac) => {
            const y = padT + plotH - frac * plotH;
            const valor = minV + frac * range;
            return `
                <line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="var(--light-gray)" stroke-width="1"/>
                <text x="${padL}" y="${y - 4}" font-size="10" fill="var(--gray)">${escapeHtml(formatValue(valor))}</text>
            `;
        }).join('');

        // Eje de cero explícito (trazo más marcado, punteado) solo cuando
        // hay valores negativos y positivos a la vez -- si no, coincide
        // con alguna línea de grilla y sería redundante.
        const zeroLine = minV < 0 && maxV > 0 ? `
            <line x1="${padL}" y1="${yFor(0)}" x2="${padL + plotW}" y2="${yFor(0)}" stroke="var(--gray)" stroke-width="1" stroke-dasharray="3 3"/>
        ` : '';

        const xLabels = categories.map((cat, i) => `<text x="${xFor(i)}" y="${height - 8}" font-size="11" fill="var(--gray)" text-anchor="middle">${escapeHtml(cat)}</text>`).join('');

        const lines = series.map((s, sIdx) => {
            const points = s.values.map((v, i) => `${xFor(i)},${yFor(v)}`).join(' ');
            const dots = s.values.map((v, i) => `
                <circle cx="${xFor(i)}" cy="${yFor(v)}" r="4" fill="${s.color}" stroke="var(--white)" stroke-width="2">
                    <title>${escapeHtml(s.name)} · ${escapeHtml(categories[i])}: ${escapeHtml(formatValue(v))}</title>
                </circle>
            `).join('');
            // Solo la última serie lleva el valor final como etiqueta directa.
            const esUltimaSerie = sIdx === series.length - 1;
            const lastIdx = s.values.length - 1;
            const endLabel = esUltimaSerie
                ? `<text x="${xFor(lastIdx) + 10}" y="${yFor(s.values[lastIdx]) + 4}" font-size="11" font-weight="600" fill="var(--dark-gray)">${escapeHtml(formatValue(s.values[lastIdx]))}</text>`
                : '';
            return `<polyline points="${points}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}${endLabel}`;
        }).join('');

        const legend = series.length > 1 ? `
            <div class="chart-legend">
                ${series.map((s) => `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background-color:${s.color}"></span>${escapeHtml(s.name)}</span>`).join('')}
            </div>
        ` : '';

        container.innerHTML = legend + `
            <div class="chart-trend">
                <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">
                    ${grid}
                    ${zeroLine}
                    ${lines}
                    ${xLabels}
                </svg>
            </div>
        `;
    }

    // segments: [{ label, value, color }] — barra única apilada al 100%,
    // para composición/concentración (ej. top proveedores vs. resto,
    // devengado vs. comprometido). El rótulo del % solo se dibuja si el
    // segmento mide más de ~8% (si no, no entra el texto): el dato completo
    // sigue disponible en la leyenda y en el tooltip.
    // Blanco o negro según el brillo percibido del color de fondo, para que
    // el rótulo del segmento siempre tenga contraste (los grises claros de
    // la rampa necesitan texto oscuro, no blanco).
    function textoLegibleSobre(colorHex) {
        if (typeof colorHex !== 'string' || !colorHex.startsWith('#')) return 'var(--white)';
        const hex = colorHex.length === 4
            ? colorHex.replace(/#([0-9a-f])([0-9a-f])([0-9a-f])/i, '#$1$1$2$2$3$3')
            : colorHex;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const brillo = 0.299 * r + 0.587 * g + 0.114 * b;
        return brillo > 150 ? 'var(--dark-gray)' : 'var(--white)';
    }

    function renderComposition(containerId, segments, { formatValue = String } = {}) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const total = segments.reduce((sum, seg) => sum + seg.value, 0);
        if (!segments.length || total <= 0) {
            container.innerHTML = `<div class="empty-state">Sin datos para mostrar.</div>`;
            return;
        }

        const legend = `
            <div class="chart-legend">
                ${segments.map((seg) => `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background-color:${seg.color}"></span>${escapeHtml(seg.label)} (${escapeHtml(formatValue(seg.value))})</span>`).join('')}
            </div>
        `;

        const bar = segments.map((seg) => {
            const pct = (seg.value / total) * 100;
            const rotulo = pct >= 8 ? `${pct.toFixed(0)}%` : '';
            return `<div class="chart-composition-segment" style="width:${pct}%; background-color:${seg.color}; color:${textoLegibleSobre(seg.color)}" title="${escapeHtml(seg.label)}: ${escapeHtml(formatValue(seg.value))} (${pct.toFixed(1)}%)">${rotulo}</div>`;
        }).join('');

        container.innerHTML = legend + `<div class="chart-composition">${bar}</div>`;
    }

    // items: [{ label, real, proyectado }] -- columna apilada por mes: el
    // tramo Real (sólido, abajo) es lo que ya se devengó de verdad; el
    // tramo Proyectado (claro, arriba) es la estimación de lo que falta
    // (ver Proyeccion). Para meses ya cerrados, proyectado suele ser 0.
    function renderStackedColumnChart(containerId, items, { formatValue = String } = {}) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!items.length) {
            container.innerHTML = `<div class="empty-state">Sin datos para mostrar.</div>`;
            return;
        }

        const max = Math.max(...items.map((item) => item.real + item.proyectado), 1);
        const legend = `
            <div class="chart-legend">
                <span class="chart-legend-item"><span class="chart-legend-swatch chart-legend-swatch-real"></span>Real</span>
                <span class="chart-legend-item"><span class="chart-legend-swatch chart-legend-swatch-proyectado"></span>Proyectado</span>
            </div>
        `;

        const columnas = items.map((item) => {
            const total = item.real + item.proyectado;
            const pctTotal = Math.max((total / max) * 100, total === 0 ? 0 : 2);
            const pctReal = total > 0 ? (item.real / total) * 100 : 0;
            const pctProyectado = total > 0 ? (item.proyectado / total) * 100 : 0;
            return `
                <div class="chart-column">
                    <div class="chart-column-value" title="${escapeHtml(item.label)} · Total: ${escapeHtml(formatValue(total))}">${escapeHtml(rotuloColumna(total, formatValue))}</div>
                    <div class="chart-column-bar-stack" style="height:${pctTotal}%">
                        <div class="chart-column-bar-proyectado" style="height:${pctProyectado}%" title="${escapeHtml(item.label)} · Proyectado: ${escapeHtml(formatValue(item.proyectado))}"></div>
                        <div class="chart-column-bar-real" style="height:${pctReal}%" title="${escapeHtml(item.label)} · Real: ${escapeHtml(formatValue(item.real))}"></div>
                    </div>
                    <div class="chart-column-label">${escapeHtml(item.label)}</div>
                </div>
            `;
        }).join('');

        container.innerHTML = legend + `<div class="chart-columns">${columnas}</div>`;
    }

    return { renderBarChart, renderDivergingChart, renderColumnChart, renderTrendLines, renderComposition, renderStackedColumnChart };
})();

/* ======================================================================
   ANALÍTICA (analitica.html)
   Gráficos con datos reales (planilla de suministros, cuota 110/131 y
   pedidos con Orden de Compra real), desglosados por Secretaría, oficina
   y concepto. Visible únicamente para el legajo 310019 — no es un permiso
   de rol, es ese usuario puntual (aunque hoy coincide con el único rol
   "admin").
   ====================================================================== */
const AnaliticaPage = (() => {
    // Paleta estricta rojo / blanco / negro-gris: el rojo queda reservado
    // para lo que necesita atención (excedida, alerta); todo lo demás usa
    // la escala de grises (negro = dato firme/real, gris = referencia o
    // todavía no confirmado).
    const MESES_LABEL = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sept', 'Oct', 'Nov', 'Dic'];
    const COLOR_CUOTA = '#9b9b9b';
    const COLOR_EJECUTADO = '#1a1a1a';
    const COLOR_DEVENGADO = '#1a1a1a';
    const COLOR_COMPROMETIDO = '#b3b3b3';
    const COLORES_PROVEEDORES = ['#1a1a1a', '#404040', '#666666', '#8c8c8c', '#b3b3b3'];

    function pesos(value) {
        return `$${SupplyUtils.formatNumber(Math.round(value))}`;
    }

    function mesLabel(mesIso) {
        const mes = Number(mesIso.slice(5, 7));
        return MESES_LABEL[mes - 1] || mesIso;
    }

    // Igual que mesLabel pero con año de 2 dígitos -- RAFAMOR trae datos de
    // más de un año calendario (2025 y 2026), así que "Ene" solo (sin año)
    // sería ambiguo entre los dos eneros.
    function mesLabelConAnio(mesIso) {
        const [anio, mes] = mesIso.split('-');
        return `${MESES_LABEL[Number(mes) - 1] || mes} ${anio.slice(2)}`;
    }

    // "2026-08-31" -> "31/08" -- etiqueta corta para el eje semanal de
    // deuda con proveedores (semana_inicio de ctacte).
    function semanaLabel(fechaIso) {
        const [, mes, dia] = fechaIso.split('-');
        return `${dia}/${mes}`;
    }

    // Días de calendario entre dos fechas ISO ("YYYY-MM-DD..."). null si
    // falta alguna o si el resultado es negativo (dato de carga inconsistente
    // en la planilla real: no se inventa una explicación, se descarta).
    function diasEntre(fechaIsoA, fechaIsoB) {
        if (!fechaIsoA || !fechaIsoB) return null;
        const a = new Date(fechaIsoA.slice(0, 10));
        const b = new Date(fechaIsoB.slice(0, 10));
        if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
        const dias = Math.round((b - a) / 86400000);
        return dias >= 0 ? dias : null;
    }

    // Suministros de la planilla real con Fecha de Carga y Orden de Compra
    // (fecha), para calcular tiempos de trámite — se recalcula una sola vez
    // y se reusa en el histograma y en el stat de mediana.
    function diasDeTramite() {
        return SuministrosData.getAll()
            .map((item) => diasEntre(item['Fecha de Carga'], item['Órden de Compra']))
            .filter((d) => d !== null);
    }

    function mediana(numeros) {
        if (!numeros.length) return null;
        const ordenados = [...numeros].sort((a, b) => a - b);
        const mid = Math.floor(ordenados.length / 2);
        return ordenados.length % 2 ? ordenados[mid] : Math.round((ordenados[mid - 1] + ordenados[mid]) / 2);
    }

    function init(session) {
        const content = document.getElementById('analiticaContent');
        const restrictedNote = document.getElementById('analiticaRestrictedNote');

        if (session.usuario !== '310019') {
            if (content) content.hidden = true;
            if (restrictedNote) restrictedNote.hidden = false;
            return;
        }

        renderStats();
        renderTendenciaTrimestral('110', 'chartTendenciaTrimestral');
        renderRecursosAfectados();
        renderBalanceEvolucion();
        renderProveedoresDeuda();
        renderDevengamientoPorMes();
        renderComprometidoDevengado();
        renderSuministrosPorMes();
        renderHistogramaDias();
        renderConcentracionProveedores();
        renderOficinas();
        renderTopSecretariasPorCantidad();
        renderTopSecretariasPorMonto();
        renderTopConceptos();
        initSelectorSecretaria();
        initSelectorModo();
    }

    // Selector de modo, al inicio de la página: "Visión general" (todo el
    // municipio, sin filtrar) o "Por Secretaría" (elige una y ve solo su
    // desglose). Empieza siempre en "Visión general".
    function initSelectorModo() {
        const btnGeneral = document.getElementById('modoGeneralBtn');
        const btnSecretaria = document.getElementById('modoSecretariaBtn');
        const vistaGeneral = document.getElementById('analiticaGeneralView');
        const vistaSecretaria = document.getElementById('analiticaSecretariaView');
        const selectorWrapper = document.getElementById('analiticaSelectorWrapper');
        // Stats municipales de arriba de todo: solo tienen sentido en
        // "Visión general" -- en "Por Secretaría" ya aparecen las propias
        // (secDetalleStats, dentro de analiticaSecretariaDetalle) y tener
        // las dos juntas confunde (dos filas de números distintos, sin
        // ninguna etiqueta que diga "esto es el total del municipio").
        const statsGenerales = document.getElementById('analiticaStats');
        if (!btnGeneral || !btnSecretaria) return;

        function activar(modo) {
            const esGeneral = modo === 'general';
            btnGeneral.classList.toggle('active', esGeneral);
            btnGeneral.setAttribute('aria-selected', String(esGeneral));
            btnSecretaria.classList.toggle('active', !esGeneral);
            btnSecretaria.setAttribute('aria-selected', String(!esGeneral));
            if (vistaGeneral) vistaGeneral.hidden = !esGeneral;
            if (vistaSecretaria) vistaSecretaria.hidden = esGeneral;
            if (selectorWrapper) selectorWrapper.hidden = esGeneral;
            if (statsGenerales) statsGenerales.hidden = !esGeneral;
        }

        btnGeneral.addEventListener('click', () => activar('general'));
        btnSecretaria.addEventListener('click', () => activar('secretaria'));

        // Estado inicial explícito: nunca depender solo del atributo
        // "hidden" del HTML — el selector de Secretaría solo puede
        // aparecer dentro de la solapa "Por Secretaría".
        activar('general');
    }

    function renderStats() {
        const statsRow = document.getElementById('analiticaStats');
        if (!statsRow) return;

        const supplies = SuministrosData.getAll();
        const total110 = CuotaReal.getTotal('110');
        const total131 = CuotaReal.getTotal('131');
        const cuotaAnualMunicipio = (total110 ? total110.cuotaAnual : 0) + (total131 ? total131.cuotaAnual : 0);
        const pedidosConOC = Object.keys(window.PEDIDOS_SUMINISTRO_DATA || {}).length;
        const cuotaInsuficiente = supplies.filter((item) => item.Cuota === 'Insuficiente').length;
        const medianaDias = mediana(diasDeTramite());

        const cards = [
            { label: 'Suministros en planilla real', value: SupplyUtils.formatNumber(supplies.length), cls: 'stat-total' },
            { label: 'Cuota anual del municipio (110+131)', value: pesos(cuotaAnualMunicipio), cls: 'stat-total' },
            { label: 'Pedidos con Orden de Compra real', value: SupplyUtils.formatNumber(pedidosConOC), cls: 'stat-pending' },
            { label: 'Con cuota insuficiente', value: SupplyUtils.formatNumber(cuotaInsuficiente), cls: 'stat-alert' },
            { label: 'Mediana de días de trámite (carga → OC)', value: medianaDias === null ? '—' : `${medianaDias} días`, cls: 'stat-pending' }
        ];

        statsRow.innerHTML = cards.map((card) => `
            <div class="stat-card ${card.cls}">
                <div class="stat-value">${card.value}</div>
                <div class="stat-label">${card.label}</div>
            </div>
        `).join('');
    }

    // Cuota vs. ejecutado por trimestre — municipio (secretaria=null) o una
    // Secretaría puntual. El total anual puede esconder que un trimestre
    // puntual se haya ejecutado por encima de lo previsto.
    function renderTendenciaTrimestral(fuente, containerId, secretaria) {
        const datos = secretaria ? CuotaReal.getBySecretaria(secretaria, fuente) : CuotaReal.getTotal(fuente);
        if (!datos) {
            Charts.renderBarChart(containerId, [], {});
            return;
        }
        Charts.renderTrendLines(containerId, {
            categories: ['1er trim.', '2do trim.', '3er trim.', '4to trim.'],
            series: [
                { name: 'Cuota', values: datos.cuotaTrimestral, color: COLOR_CUOTA },
                { name: 'Ejecutado', values: datos.ejecucionTrimestral, color: COLOR_EJECUTADO }
            ],
            formatValue: pesos
        });
    }

    // Monto devengado (Recepción real registrada) por mes, de los pedidos
    // con Orden de Compra real.
    function renderDevengamientoPorMes() {
        const pedidos = Object.values(window.PEDIDOS_SUMINISTRO_DATA || {});
        const porMes = pedidos.reduce((acc, p) => {
            if (!p.devengado || !p.fechaDevengamiento) return acc;
            const mes = p.fechaDevengamiento.slice(0, 7);
            acc[mes] = (acc[mes] || 0) + p.monto;
            return acc;
        }, {});

        const items = Object.keys(porMes).sort().map((mes) => ({ label: mesLabel(mes), value: porMes[mes] }));
        Charts.renderColumnChart('chartDevengamientoPorMes', items, { formatValue: pesos });
    }

    // De los pedidos con Orden de Compra real: cuánto ya se devengó (llegó
    // a tener una Recepción real) contra cuánto sigue comprometido.
    function renderComprometidoDevengado() {
        const pedidos = Object.values(window.PEDIDOS_SUMINISTRO_DATA || {});
        const devengadoMonto = pedidos.filter((p) => p.devengado).reduce((sum, p) => sum + p.monto, 0);
        const totalMonto = pedidos.reduce((sum, p) => sum + p.monto, 0);
        const comprometidoMonto = Math.max(totalMonto - devengadoMonto, 0);

        Charts.renderComposition('chartComprometidoDevengado', [
            { label: 'Devengado — recepción registrada', value: devengadoMonto, color: COLOR_DEVENGADO },
            { label: 'Comprometido — pendiente de recepción', value: comprometidoMonto, color: COLOR_COMPROMETIDO }
        ], { formatValue: pesos });
    }

    // ---------------------------------------------------------------
    // Situación financiera (RAFAMOR): Recursos Afectados, Balance General
    // y Cuenta Corriente Proveedores -- ver rafamor-financiero-data.js
    // (scripts/build_rafamor_financiero_data.py). No pasa por la planilla
    // de suministros ni por pedidos-suministro-data.js: es RAFAM
    // Contabilidad directo, así que sigue disponible aunque esos otros dos
    // archivos no tengan todavía el pedido/año en cuestión.
    // ---------------------------------------------------------------
    function renderRecursosAfectados() {
        const datos = window.RAFAMOR_FINANCIERO_DATA;
        if (!datos) return;

        const porMes = datos.recursosAfectados.porMes.slice(-12);
        Charts.renderTrendLines('chartRecursosComprometidoDevengado', {
            categories: porMes.map((m) => mesLabelConAnio(m.mes)),
            series: [
                { name: 'Comprometido', values: porMes.map((m) => m.compromiso), color: COLOR_COMPROMETIDO },
                { name: 'Devengado de Gastos', values: porMes.map((m) => m.devengadoGastos), color: COLOR_DEVENGADO }
            ],
            formatValue: pesos
        });

        const topRubros = datos.recursosAfectados.topRubrosPorDevengadoGastos.map((r) => ({
            label: r.rubro,
            value: r.devengadoGastos
        }));
        Charts.renderBarChart('chartTopRubrosRecursos', topRubros, { formatValue: pesos });
    }

    function renderBalanceEvolucion() {
        const datos = window.RAFAMOR_FINANCIERO_DATA;
        if (!datos) return;

        const porMes = datos.balance.porMes.slice(-12).filter((m) => m.activo != null);
        Charts.renderTrendLines('chartBalanceEvolucion', {
            categories: porMes.map((m) => mesLabelConAnio(m.mes)),
            series: [
                { name: 'Activo', values: porMes.map((m) => m.activo || 0), color: '#1a1a1a' },
                { name: 'Pasivo', values: porMes.map((m) => m.pasivo || 0), color: '#666666' },
                { name: 'Patrimonio Neto', values: porMes.map((m) => m.patrimonio || 0), color: '#b3b3b3' }
            ],
            formatValue: pesos
        });
    }

    function renderProveedoresDeuda() {
        const datos = window.RAFAMOR_FINANCIERO_DATA;
        if (!datos) return;

        const top = datos.ctacte.topProveedoresDeuda.map((p) => ({ label: p.proveedor, value: p.deuda }));
        Charts.renderBarChart('chartTopProveedoresDeuda', top, { formatValue: pesos });

        // Línea (no columnas): con 12 semanas, un gráfico de columnas se
        // sale del ancho de la tarjeta y obliga a hacer scroll horizontal
        // para ver las últimas -- una línea de tendencia usa el mismo
        // ancho siempre y además lee mejor una evolución en el tiempo.
        const semanas = datos.ctacte.deudaTotalPorSemana.slice(-12);
        Charts.renderTrendLines('chartDeudaProveedoresSemanal', {
            categories: semanas.map((s) => semanaLabel(s.semana)),
            series: [{ name: 'Deuda total', values: semanas.map((s) => s.deuda), color: '#1a1a1a' }],
            formatValue: pesos
        });
    }

    // Cantidad de suministros de la planilla real cargados por mes.
    function renderSuministrosPorMes() {
        const supplies = SuministrosData.getAll();
        const porMes = supplies.reduce((acc, item) => {
            const fecha = item['Fecha de Carga'];
            if (!fecha) return acc;
            const mes = fecha.slice(0, 7);
            acc[mes] = (acc[mes] || 0) + 1;
            return acc;
        }, {});

        const items = Object.keys(porMes).sort().map((mes) => ({ label: mesLabel(mes), value: porMes[mes] }));
        Charts.renderColumnChart('chartSuministrosPorMes', items, { formatValue: (v) => SupplyUtils.formatNumber(v) });
    }

    // Histograma de días entre Fecha de Carga y Orden de Compra: la
    // mediana (ver stat) esconde la cola larga de trámites demorados.
    function renderHistogramaDias() {
        const bins = [
            { label: '0–7', min: 0, max: 7 },
            { label: '8–14', min: 8, max: 14 },
            { label: '15–21', min: 15, max: 21 },
            { label: '22–30', min: 22, max: 30 },
            { label: '31–60', min: 31, max: 60 },
            { label: '61–90', min: 61, max: 90 },
            { label: '91+', min: 91, max: Infinity }
        ];
        const counts = new Array(bins.length).fill(0);
        diasDeTramite().forEach((dias) => {
            const idx = bins.findIndex((b) => dias >= b.min && dias <= b.max);
            if (idx >= 0) counts[idx] += 1;
        });

        const items = bins.map((b, i) => ({ label: `${b.label} días`, value: counts[i] }));
        Charts.renderColumnChart('chartHistogramaDias', items, { formatValue: (v) => SupplyUtils.formatNumber(v) });
    }

    // Qué tan concentrado está el monto adjudicado en pocos proveedores:
    // top 5 por monto (rampa de un solo tono, por rango) + el resto.
    function renderConcentracionProveedores() {
        const pedidos = Object.values(window.PEDIDOS_SUMINISTRO_DATA || {});
        const porProveedor = pedidos.reduce((acc, p) => {
            const proveedor = p.proveedor || 'Sin proveedor';
            acc[proveedor] = (acc[proveedor] || 0) + p.monto;
            return acc;
        }, {});

        const ordenado = Object.entries(porProveedor).sort((a, b) => b[1] - a[1]);
        const totalMonto = ordenado.reduce((sum, [, v]) => sum + v, 0);
        const top5 = ordenado.slice(0, 5);
        const restoMonto = ordenado.slice(5).reduce((sum, [, v]) => sum + v, 0);

        const segments = top5.map(([label, value], i) => ({ label, value, color: COLORES_PROVEEDORES[i] }));
        if (restoMonto > 0) segments.push({ label: `Resto de proveedores (${ordenado.length - 5})`, value: restoMonto, color: '#d9d9d9' });

        Charts.renderComposition('chartConcentracionProveedores', segments, { formatValue: pesos });

        const nota = document.getElementById('notaConcentracionProveedores');
        if (nota && totalMonto > 0) {
            const pctTop5 = (top5.reduce((sum, [, v]) => sum + v, 0) / totalMonto) * 100;
            nota.textContent = `Los 5 proveedores más grandes concentran el ${pctTop5.toFixed(0)}% del monto de los pedidos con Orden de Compra real.`;
        }
    }

    // Cuántos suministros de la planilla real hay en cada oficina del
    // circuito administrativo. scope: lista ya filtrada (opcional, para el
    // detalle por Secretaría); si no se pasa, es toda la planilla.
    function renderOficinas(containerId = 'chartOficinas', scope) {
        const supplies = scope || SuministrosData.getAll();
        const counts = supplies.reduce((acc, item) => {
            const oficina = item.Oficina || 'Sin oficina';
            acc[oficina] = (acc[oficina] || 0) + 1;
            return acc;
        }, {});

        const items = Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([label, value]) => ({ label, value, cls: label === 'Anulado' ? 'chart-bar-bad' : undefined }));

        Charts.renderBarChart(containerId, items, { formatValue: (v) => SupplyUtils.formatNumber(v) });
    }

    // Top 10 Secretarías por cantidad de suministros cargados en la
    // planilla real.
    function renderTopSecretariasPorCantidad() {
        const supplies = SuministrosData.getAll();
        const counts = supplies.reduce((acc, item) => {
            const secretaria = item.Secretaría || 'Sin Secretaría';
            acc[secretaria] = (acc[secretaria] || 0) + 1;
            return acc;
        }, {});

        const items = Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([label, value]) => ({ label, value }));

        Charts.renderBarChart('chartTopCantidad', items, { formatValue: (v) => SupplyUtils.formatNumber(v) });
    }

    // Top 10 Secretarías por monto (Adjudicado si ya lo tiene, si no Monto
    // solicitado, si no Total) de la planilla real.
    function renderTopSecretariasPorMonto() {
        const supplies = SuministrosData.getAll();
        const montos = supplies.reduce((acc, item) => {
            const secretaria = item.Secretaría || 'Sin Secretaría';
            const monto = item.Adjudicado || item['Sum Total'] || item.Total || 0;
            acc[secretaria] = (acc[secretaria] || 0) + monto;
            return acc;
        }, {});

        const items = Object.entries(montos)
            .filter(([, value]) => value > 0)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([label, value]) => ({ label, value }));

        Charts.renderBarChart('chartTopMonto', items, { formatValue: pesos });
    }

    // Top 15 Pedidos de Suministro (con Orden de Compra real) por monto,
    // etiquetados con su concepto real — no es una categoría inventada,
    // es la observación real de la orden.
    function renderTopConceptos(containerId = 'chartTopConceptos', scope, cantidad = 15) {
        const entradas = scope
            ? scope.map((item) => [item.Suministro, {
                concepto: item.Observaciones,
                monto: item.Adjudicado || item['Sum Total'] || item.Total || 0
            }])
            : Object.entries(window.PEDIDOS_SUMINISTRO_DATA || {});

        const items = entradas
            .filter(([, datos]) => datos.monto > 0)
            .sort((a, b) => b[1].monto - a[1].monto)
            .slice(0, cantidad)
            .map(([numero, datos]) => ({
                label: `N° ${numero} — ${datos.concepto || 'Sin concepto'}`,
                value: datos.monto
            }));

        Charts.renderBarChart(containerId, items, { formatValue: pesos });
    }

    // Selector "Detalle por Secretaría": arma el panel (stats + su propia
    // tendencia trimestral + sus suministros por oficina + sus conceptos de
    // mayor monto) reusando los mismos renders de arriba, filtrados a una
    // sola Secretaría.
    function initSelectorSecretaria() {
        const select = document.getElementById('analiticaSecretariaSelect');
        if (!select) return;

        const secretarias = [...CuotaReal.getAll('110')].map((s) => s.secretaria).sort((a, b) => a.localeCompare(b, 'es'));
        select.innerHTML = secretarias.map((s) => `<option value="${s}">${s}</option>`).join('');

        select.addEventListener('change', () => renderSecretariaDetalle(select.value));
        if (secretarias.length) renderSecretariaDetalle(secretarias[0]);
    }

    function renderSecretariaDetalle(secretaria) {
        const wrapper = document.getElementById('analiticaSecretariaDetalle');
        if (!wrapper) return;

        wrapper.innerHTML = `
            <div class="stats-row stats-row-4" id="secDetalleStats"></div>
            <div class="dashboard-section">
                <h4 class="detail-subheading">Ejecución trimestral — Fuente 110</h4>
                <div id="secDetalleTrimestral" class="chart-wrap"></div>
            </div>
            <div class="dashboard-section">
                <h4 class="detail-subheading">Suministros por oficina</h4>
                <div id="secDetalleOficinas" class="chart-wrap"></div>
            </div>
            <div class="dashboard-section">
                <h4 class="detail-subheading">Conceptos de mayor monto</h4>
                <div id="secDetalleConceptos" class="chart-wrap"></div>
            </div>
        `;

        const supplies = SuministrosData.getBySecretaria(secretaria);
        const cuota110 = CuotaReal.getBySecretaria(secretaria, '110');
        const cuota131 = CuotaReal.getBySecretaria(secretaria, '131');
        const trimestre = CuotaReal.getTrimestreActual();
        const acum110 = cuota110 ? CuotaReal.getAcumuladoHasta(cuota110, trimestre) : { cuota: 0, ejecucion: 0 };
        const acum131 = cuota131 ? CuotaReal.getAcumuladoHasta(cuota131, trimestre) : { cuota: 0, ejecucion: 0 };
        const cuotaAcumulada = acum110.cuota + acum131.cuota;
        const ejecucion = acum110.ejecucion + acum131.ejecucion;
        const disponible = cuotaAcumulada - ejecucion;
        const cuotaInsuficiente = supplies.filter((item) => item.Cuota === 'Insuficiente').length;
        const montoTotal = supplies.reduce((sum, item) => sum + (item.Adjudicado || item['Sum Total'] || item.Total || 0), 0);

        const statsRow = document.getElementById('secDetalleStats');
        if (statsRow) {
            const cards = [
                { label: `Cuota a T${trimestre} (110+131)`, value: pesos(cuotaAcumulada), cls: 'stat-total' },
                { label: 'Ejecutado', value: pesos(ejecucion), cls: 'stat-total' },
                { label: disponible < 0 ? 'Excedido' : 'Disponible', value: pesos(Math.abs(disponible)), cls: disponible < 0 ? 'stat-rejected' : 'stat-pending' },
                { label: 'Suministros / Monto total', value: `${SupplyUtils.formatNumber(supplies.length)} / ${pesos(montoTotal)}`, cls: 'stat-total' },
                { label: 'Con cuota insuficiente', value: SupplyUtils.formatNumber(cuotaInsuficiente), cls: 'stat-alert' }
            ];
            statsRow.innerHTML = cards.map((card) => `
                <div class="stat-card ${card.cls}">
                    <div class="stat-value">${card.value}</div>
                    <div class="stat-label">${card.label}</div>
                </div>
            `).join('');
        }

        renderTendenciaTrimestral('110', 'secDetalleTrimestral', secretaria);
        renderOficinas('secDetalleOficinas', supplies);
        renderTopConceptos('secDetalleConceptos', supplies, 10);
    }

    return { init };
})();

/* ======================================================================
   DEVENGAMIENTO (devengamiento.html)
   Vista dedicada a una sola pregunta: ¿cuándo se recibió (o se estima que
   se va a recibir) cada suministro? No es lo mismo que la aprobación
   administrativa (Orden de Compra) ni que el pago -- es la Recepción real
   registrada en RAFAM (ver PedidosSuministro/Proyeccion, ya construidos
   para Suministros). Acá se junta esa misma info en dos vistas:

     - Curva de devengamiento: por mes, cuánto ya se devengó de verdad
       (Real) más cuánto se estima que falta devengar de lo pendiente
       (Proyectado, con Proyeccion) -- "promediando la diferencia entre
       las instancias de la hoja de ruta", como pidieron: la mediana real
       de días entre Orden de Compra y Recepción, por tipo de proceso.
     - Por suministro: el mismo dato, uno por fila, para ver el detalle.

   Mismo alcance que Suministros/Alertas/Difusión: un área ve lo suyo, los
   perfiles centrales ven todo.
   ====================================================================== */
const DevengamientoPage = (() => {
    const MESES_LABEL = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sept', 'Oct', 'Nov', 'Dic'];
    const ANIO = '2026';

    const ESTADO_INFO = {
        real: { texto: 'Ya devengado', cls: 'status-approved' },
        proyectado: { texto: 'Proyectado', cls: 'status-badge-proyectado' },
        sin_datos: { texto: 'Sin datos', cls: 'status-badge-sin-datos' }
    };

    let session = null;
    let permissions = null;
    let filas = [];
    let filtroTexto = '';
    let filtroEstado = '';

    function pesos(value) {
        return Number.isFinite(value) ? `$${SupplyUtils.formatNumber(Math.round(value))}` : '—';
    }

    function init(activeSession) {
        session = activeSession;
        permissions = Auth.permissionsFor(session.rol);
        bindEvents();
        render();
    }

    function getScopedSupplies() {
        return permissions.isAreaUser
            ? SuministrosData.getBySecretaria(session.area)
            : SuministrosData.getAll();
    }

    // Una fila por suministro en alcance, con su estado de devengamiento.
    // 'real': ya tiene Recepción registrada en RAFAM. 'proyectado': todavía
    // no, pero Proyeccion puede estimar cuándo (tiene al menos Fecha de
    // Carga y no está Anulado). 'sin_datos': ninguna de las dos.
    function calcularFilas() {
        return getScopedSupplies().map((item) => {
            const pedido = PedidosSuministro.getByNumero(item.Suministro);
            if (pedido && pedido.devengado) {
                return { item, estado: 'real', monto: pedido.monto, fecha: pedido.fechaDevengamiento };
            }
            const proyeccion = Proyeccion.proyectar(item, pedido);
            if (proyeccion) {
                const montoEstimado = pedido ? pedido.monto : (item.Adjudicado || item['Sum Total'] || item.Total || 0);
                return { item, estado: 'proyectado', monto: montoEstimado, fecha: proyeccion.recepcion.fecha.toISOString() };
            }
            return { item, estado: 'sin_datos', monto: 0, fecha: null };
        });
    }

    function bindEvents() {
        document.getElementById('devengamientoSearch')?.addEventListener('input', (event) => {
            filtroTexto = event.target.value.trim().toLowerCase();
            renderList();
        });
        document.getElementById('devengamientoFiltroEstado')?.addEventListener('change', (event) => {
            filtroEstado = event.target.value;
            renderList();
        });
    }

    function render() {
        filas = calcularFilas();
        renderStats();
        renderCurva();
        renderList();
    }

    function renderStats() {
        const statsRow = document.getElementById('devengamientoStats');
        if (!statsRow) return;

        const reales = filas.filter((f) => f.estado === 'real');
        const proyectados = filas.filter((f) => f.estado === 'proyectado');
        const montoReal = reales.reduce((sum, f) => sum + f.monto, 0);
        const montoProyectado = proyectados.reduce((sum, f) => sum + f.monto, 0);

        const cards = [
            { label: 'Ya devengados', value: SupplyUtils.formatNumber(reales.length), cls: 'stat-total' },
            { label: 'Proyectados (todavía no)', value: SupplyUtils.formatNumber(proyectados.length), cls: 'stat-pending' },
            { label: 'Monto ya devengado', value: pesos(montoReal), cls: 'stat-total' },
            { label: 'Monto proyectado pendiente', value: pesos(montoProyectado), cls: 'stat-pending' }
        ];
        statsRow.innerHTML = cards.map((card) => `
            <div class="stat-card ${card.cls}">
                <div class="stat-value">${card.value}</div>
                <div class="stat-label">${card.label}</div>
            </div>
        `).join('');
    }

    // Agrupa por mes calendario de ${ANIO} -- lo de otros años (muy poco,
    // algún arrastre) queda afuera del gráfico a propósito, para no
    // desproporcionar el eje con un mes suelto de otro año.
    function renderCurva() {
        const porMes = MESES_LABEL.map(() => ({ real: 0, proyectado: 0 }));
        filas.forEach((fila) => {
            if (!fila.fecha || fila.fecha.slice(0, 4) !== ANIO) return;
            const idx = Number(fila.fecha.slice(5, 7)) - 1;
            if (idx < 0 || idx > 11) return;
            if (fila.estado === 'real') porMes[idx].real += fila.monto;
            else if (fila.estado === 'proyectado') porMes[idx].proyectado += fila.monto;
        });

        const items = MESES_LABEL.map((label, i) => ({ label, real: porMes[i].real, proyectado: porMes[i].proyectado }));
        Charts.renderStackedColumnChart('devengamientoCurva', items, { formatValue: pesos });
    }

    function getFiltradas() {
        return filas.filter((fila) => {
            if (filtroEstado && fila.estado !== filtroEstado) return false;
            if (filtroTexto) {
                const texto = `${fila.item.Suministro} ${fila.item.Observaciones || ''}`.toLowerCase();
                if (!texto.includes(filtroTexto)) return false;
            }
            return true;
        });
    }

    function renderList() {
        const list = document.getElementById('devengamientoList');
        const totalEl = document.getElementById('devengamientoTotal');
        const visibleEl = document.getElementById('devengamientoVisibles');
        if (!list) return;

        if (totalEl) totalEl.textContent = SupplyUtils.formatNumber(filas.length);

        // Sin fecha (sin_datos) siempre al final; el resto por fecha de
        // devengamiento ascendente -- real o proyectada, da igual, es "a
        // qué distancia está" lo que importa para priorizar.
        const filtradas = getFiltradas().sort((a, b) => {
            if (!a.fecha && !b.fecha) return 0;
            if (!a.fecha) return 1;
            if (!b.fecha) return -1;
            return new Date(a.fecha) - new Date(b.fecha);
        });

        if (visibleEl) visibleEl.textContent = SupplyUtils.formatNumber(filtradas.length);

        if (!filtradas.length) {
            list.innerHTML = `<div class="empty-state">No se encontraron suministros con los filtros aplicados.</div>`;
            return;
        }

        list.innerHTML = filtradas.map((fila) => {
            const badge = ESTADO_INFO[fila.estado];
            const observaciones = fila.item.Observaciones || '—';
            const fechaHtml = fila.estado === 'real'
                ? `<span class="devengamiento-fecha devengamiento-fecha-real">${SuministrosData.formatFecha(fila.fecha)}</span>`
                : fila.estado === 'proyectado'
                    ? `<span class="devengamiento-fecha">~${SuministrosData.formatFecha(fila.fecha)}</span>`
                    : `<span class="devengamiento-fecha">—</span>`;

            return `
                <div class="supply-row devengamiento-row">
                    <div class="supply-id">N° ${fila.item.Suministro ?? '—'}</div>
                    <div class="supply-obs" title="${observaciones.replace(/"/g, '&quot;')}">${observaciones}</div>
                    <div class="supply-area">${fila.item.Secretaría || '—'}</div>
                    <div class="devengamiento-estado"><span class="status-badge ${badge.cls}">${badge.texto}</span></div>
                    <div class="devengamiento-monto">${pesos(fila.monto)}</div>
                    <div>${fechaHtml}</div>
                </div>
            `;
        }).join('');
    }

    return { init };
})();

/* ======================================================================
   APROBACIONES (aprobaciones.html)
   Suministros cargados desde Nuevo suministro que todavía no tienen la
   aprobación del legajo 310019 (ver Aprobacion: 'Pendiente' en buildAlta,
   SuministrosData). Es un corte hacia adelante: la planilla real cargada
   antes de esta funcionalidad no tiene el campo Aprobacion, así que nunca
   aparece acá — no es retroactivo. Visible y operable únicamente para
   310019.
   ====================================================================== */
const AprobacionesPage = (() => {
    let session = null;

    function init(activeSession) {
        session = activeSession;
        const content = document.getElementById('aprobacionesContent');
        const restrictedNote = document.getElementById('aprobacionesRestrictedNote');

        if (session.usuario !== '310019') {
            if (content) content.hidden = true;
            if (restrictedNote) restrictedNote.hidden = false;
            return;
        }

        initSelectorModo();
        render();
    }

    // Con cuota disponible / Excepcionales (cuota excedida): son decisiones
    // de distinto peso -- separadas en dos pestañas para que una excepción
    // no se pierda mezclada entre revisiones de rutina (o al revés, que
    // revisar lo de rutina no distraiga de una excepción real). Empieza
    // siempre en "Con cuota".
    function initSelectorModo() {
        const btnConCuota = document.getElementById('modoConCuotaBtn');
        const btnExcepcional = document.getElementById('modoExcepcionalBtn');
        const vistaConCuota = document.getElementById('vistaConCuota');
        const vistaExcepcional = document.getElementById('vistaExcepcional');
        if (!btnConCuota || !btnExcepcional) return;

        function activar(modo) {
            const esConCuota = modo === 'con-cuota';
            btnConCuota.classList.toggle('active', esConCuota);
            btnConCuota.setAttribute('aria-selected', String(esConCuota));
            btnExcepcional.classList.toggle('active', !esConCuota);
            btnExcepcional.setAttribute('aria-selected', String(!esConCuota));
            if (vistaConCuota) vistaConCuota.hidden = !esConCuota;
            if (vistaExcepcional) vistaExcepcional.hidden = esConCuota;
        }

        btnConCuota.addEventListener('click', () => activar('con-cuota'));
        btnExcepcional.addEventListener('click', () => activar('excepcional'));
        activar('con-cuota');
    }

    function pesos(value) {
        return Number.isFinite(value) ? `$${SupplyUtils.formatNumber(Math.round(value))}` : '—';
    }

    function render() {
        const todos = [...SuministrosData.getPendientesAprobacion()]
            .sort((a, b) => new Date(b['Fecha de Carga'] || 0) - new Date(a['Fecha de Carga'] || 0));

        const normales = todos.filter((item) => !item.CuotaExcedida);
        const excepcionales = todos.filter((item) => item.CuotaExcedida);

        renderTab(normales, 'aprobacionesStats', 'aprobacionesList', {
            label: 'Pendientes de aprobación',
            vacio: 'No hay suministros pendientes de aprobación.'
        });
        renderTab(excepcionales, 'aprobacionesExcepcionalStats', 'aprobacionesExcepcionalList', {
            label: 'Pendientes excepcionales',
            vacio: 'No hay solicitudes excepcionales pendientes.'
        });
    }

    function renderTab(pendientes, statsId, listId, textos) {
        const statsRow = document.getElementById(statsId);
        if (statsRow) {
            const montoTotal = pendientes.reduce((sum, item) => sum + (item['Sum Total'] || 0), 0);
            statsRow.innerHTML = [
                { label: textos.label, value: SupplyUtils.formatNumber(pendientes.length), cls: 'stat-alert' },
                { label: 'Monto total pendiente', value: pesos(montoTotal), cls: 'stat-alert' }
            ].map((card) => `
                <div class="stat-card ${card.cls}">
                    <div class="stat-value">${card.value}</div>
                    <div class="stat-label">${card.label}</div>
                </div>
            `).join('');
        }

        const list = document.getElementById(listId);
        if (!list) return;

        if (!pendientes.length) {
            list.innerHTML = `<div class="empty-state">${textos.vacio}</div>`;
            return;
        }

        list.innerHTML = pendientes.map((item) => `
            <div class="aprobacion-card">
                <div class="aprobacion-info">
                    <strong>N° ${item.Suministro} — ${item.Secretaría || 'Sin Secretaría'}</strong>
                    <div class="aprobacion-concepto">${item.Observaciones || 'Sin observaciones'}</div>
                    <div class="aprobacion-meta">Fuente ${item['Fuente de Financiamiento'] ?? '—'} · Cargado el ${SuministrosData.formatFecha(item['Fecha de Carga'])}</div>
                </div>
                <div class="aprobacion-actions">
                    <div class="aprobacion-monto">${pesos(item['Sum Total'])}</div>
                    <div class="aprobacion-botones">
                        <button type="button" class="btn ghost btn-rechazar" data-numero="${item.Suministro}">Rechazar</button>
                        <button type="button" class="btn primary btn-aprobar" data-numero="${item.Suministro}">Aprobar</button>
                    </div>
                </div>
            </div>
        `).join('');

        list.querySelectorAll('.btn-aprobar').forEach((btn) => {
            btn.addEventListener('click', () => {
                const numero = Number(btn.dataset.numero);
                SuministrosData.aprobar(numero, session.usuario);
                render();
            });
        });

        // Rechazar saca el alta por completo (no queda un registro marcado
        // "Rechazado": ver SuministrosData.rechazar) y libera la cuota que
        // se le había reservado -- el N° de suministro queda libre para
        // que el área lo pueda volver a cargar de cero si corresponde.
        list.querySelectorAll('.btn-rechazar').forEach((btn) => {
            btn.addEventListener('click', () => {
                const numero = Number(btn.dataset.numero);
                const removida = SuministrosData.rechazar(numero);
                if (removida) {
                    const fuente = String(removida['Fuente de Financiamiento']);
                    if (CuotaReal.hasFuente(fuente)) {
                        CuotaReal.liberar(removida['Secretaría'], fuente, removida['Sum Total'] || 0);
                    }
                }
                render();
            });
        });
    }

    return { init };
})();

/* ======================================================================
   MIS REMITOS (remitos.html)
   Suministros propios ya aprobados, separados en "con cuota" (el remito
   ya se descargó al cargarlo, acá se puede volver a bajar) y
   "excepcionales" (se cargaron con la Fuente excedida -- ver "Solicitar
   aprobación de todos modos" en Nuevo suministro -- así que no hubo
   remito hasta ahora: recién queda disponible acá, una vez aprobado).
   ====================================================================== */
const RemitosPage = (() => {
    let session = null;

    function pesos(value) {
        return Number.isFinite(value) ? `$${SupplyUtils.formatNumber(Math.round(value))}` : '—';
    }

    function init(activeSession) {
        session = activeSession;
        // Entrar acá es lo que "atiende" la notificación: se marcan todos
        // los aprobados de hoy como vistos y se vuelve a pintar la barra
        // de arriba, para que el número de "Mis remitos" desaparezca ya
        // mismo (no recién en la próxima página que visite).
        RemitosAprobados.marcarTodosVistos(session.usuario, session.area);
        Layout.render('remitos');

        initSelectorModo();
        render();
    }

    function initSelectorModo() {
        const btnConCuota = document.getElementById('modoRemitosConCuotaBtn');
        const btnExcepcional = document.getElementById('modoRemitosExcepcionalBtn');
        const vistaConCuota = document.getElementById('vistaRemitosConCuota');
        const vistaExcepcional = document.getElementById('vistaRemitosExcepcional');
        if (!btnConCuota || !btnExcepcional) return;

        function activar(modo) {
            const esConCuota = modo === 'con-cuota';
            btnConCuota.classList.toggle('active', esConCuota);
            btnConCuota.setAttribute('aria-selected', String(esConCuota));
            btnExcepcional.classList.toggle('active', !esConCuota);
            btnExcepcional.setAttribute('aria-selected', String(!esConCuota));
            if (vistaConCuota) vistaConCuota.hidden = !esConCuota;
            if (vistaExcepcional) vistaExcepcional.hidden = esConCuota;
        }

        btnConCuota.addEventListener('click', () => activar('con-cuota'));
        btnExcepcional.addEventListener('click', () => activar('excepcional'));
        activar('con-cuota');
    }

    function render() {
        const { conCuota, excepcionales } = RemitosAprobados.getAprobados(session.area);
        renderLista(conCuota, 'remitosConCuotaList', 'Todavía no tiene suministros aprobados con cuota.');
        renderLista(excepcionales, 'remitosExcepcionalList', 'Todavía no tiene suministros aprobados excepcionalmente.');
    }

    function renderLista(items, listId, vacio) {
        const list = document.getElementById(listId);
        if (!list) return;

        if (!items.length) {
            list.innerHTML = `<div class="empty-state">${vacio}</div>`;
            return;
        }

        // Más reciente primero: lo que se acaba de aprobar es lo más
        // probable que esté buscando.
        const ordenados = [...items].sort((a, b) => new Date(b.FechaAprobacion || 0) - new Date(a.FechaAprobacion || 0));

        list.innerHTML = ordenados.map((item) => `
            <div class="aprobacion-card">
                <div class="aprobacion-info">
                    <strong>N° ${item.Suministro}</strong>
                    <div class="aprobacion-concepto">${item.Observaciones || 'Sin observaciones'}</div>
                    <div class="aprobacion-meta">Fuente ${item['Fuente de Financiamiento'] ?? '—'} · Aprobado el ${SuministrosData.formatFecha(item.FechaAprobacion)}</div>
                </div>
                <div class="aprobacion-actions">
                    <div class="aprobacion-monto">${pesos(item['Sum Total'])}</div>
                    <button type="button" class="btn primary btn-descargar-remito" data-numero="${item.Suministro}">Descargar remito</button>
                </div>
            </div>
        `).join('');

        list.querySelectorAll('.btn-descargar-remito').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const numero = Number(btn.dataset.numero);
                const item = items.find((i) => i.Suministro === numero);
                if (!item) return;
                btn.disabled = true;
                const textoOriginal = btn.textContent;
                btn.textContent = 'Generando...';
                await RemitoPDF.descargar({
                    fecha: new Date(),
                    secretaria: session.area,
                    numeroSuministro: numero,
                    idSolicitud: `SGS-R-${numero}`
                });
                btn.disabled = false;
                btn.textContent = textoOriginal;
            });
        });
    }

    return { init };
})();

/* ======================================================================
   BOOTSTRAP
   Cada página se identifica por un contenedor único en su DOM y activa
   únicamente el módulo que le corresponde.
   ====================================================================== */
(async function bootstrap() {
    // El ingreso ahora es ingresar.html (formulario que valida el servidor).
    const session = await Auth.cargarSesion().catch(() => null);
    if (!session) {
        Api.aIngresar();
        return;
    }

    // Resumen de Alertas (sitio aparte) para el número del menú y el Inicio.
    await AlertasResumen.cargar();

    if (document.getElementById('pageHome')) {
        Layout.render('inicio', 'Inicio');
        HomePage.init(session);
    } else if (document.getElementById('pageSuministros')) {
        Layout.render('suministros', 'Suministros');
        SuministrosPage.init(session);
    } else if (document.getElementById('pageNuevoSuministro')) {
        Layout.render('nuevo', 'Nuevo suministro');
        NuevoSuministroPage.init(session);
    } else if (document.getElementById('pagePresupuesto')) {
        Layout.render('presupuesto', 'Presupuesto');
        PresupuestoPage.init(session);
    } else if (document.getElementById('pageDifusion')) {
        Layout.render('difusion', 'Difusión');
        DifusionPage.init(session);
    } else if (document.getElementById('pageDevengamiento')) {
        Layout.render('devengamiento', 'Devengamiento');
        DevengamientoPage.init(session);
    } else if (document.getElementById('pageAnalitica')) {
        Layout.render('analitica', 'Analítica');
        AnaliticaPage.init(session);
    } else if (document.getElementById('pageAprobaciones')) {
        Layout.render('aprobaciones', 'Aprobaciones');
        AprobacionesPage.init(session);
    } else if (document.getElementById('pageRemitos')) {
        Layout.render('remitos', 'Mis remitos');
        RemitosPage.init(session);
    }
})();
