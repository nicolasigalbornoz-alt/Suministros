/* ======================================================================
   REMITO "SOLICITUD DE CUOTA" (.pdf)
   Genera, en el navegador y sin librerías externas, un .pdf de una sola
   página A4 con los datos del suministro recién cargado: Fecha,
   Secretaría, Suministro N° e ID de la solicitud, más el isologotipo
   municipal (assets/logo-remito.jpg, recorte fijo) y el pie institucional.

   Antes este remito se generaba clonando una plantilla .pptx (manipulando
   a mano el .zip OOXML). Ahora, en el mismo espíritu de no depender de
   ninguna librería, se escribe directamente un archivo PDF: el formato es
   texto plano + streams binarios, así que alcanza con armar a mano los
   objetos (Catalog, Pages, Page, Contents, dos fuentes estándar
   Helvetica/Helvetica-Bold que no requieren embeberse, y la imagen del
   logo como XObject con /Filter /DCTDecode) y la tabla xref que los
   indexa. No hace falta ninguna librería de PDF ni de maquetado: el
   contenido es un puñado de líneas de texto y separadores.
   ====================================================================== */
const RemitoPDF = (() => {
    const LOGO_URL = 'assets/logo-remito.jpg';
    // Dimensiones reales del recorte en píxeles (deben coincidir con el
    // archivo: si se reemplaza el logo por otro recorte, actualizar acá).
    const LOGO_ANCHO_PX = 134;
    const LOGO_ALTO_PX = 143;

    // Página A4 en puntos (1pt = 1/72"; A4 = 210 x 297mm).
    const PAGINA_ANCHO = 595;
    const PAGINA_ALTO = 842;
    const MARGEN = 70;
    const CONTENIDO_DER = PAGINA_ANCHO - MARGEN;
    const CONTENIDO_ANCHO = CONTENIDO_DER - MARGEN;

    function concatUint8(arrays) {
        const total = arrays.reduce((sum, a) => sum + a.length, 0);
        const out = new Uint8Array(total);
        let pos = 0;
        for (const a of arrays) { out.set(a, pos); pos += a.length; }
        return out;
    }

    // Los strings usados acá solo contienen ASCII y letras latinas con
    // acento (á é í ó ú ñ, mayúsculas, º), cuyo charCodeAt coincide
    // byte a byte con WinAnsiEncoding (la fuente PDF se declara con esa
    // codificación), así que basta truncar cada char code a un byte.
    function latin1ABytes(texto) {
        const bytes = new Uint8Array(texto.length);
        for (let i = 0; i < texto.length; i++) bytes[i] = texto.charCodeAt(i) & 0xFF;
        return bytes;
    }

    function escaparPdfTexto(texto) {
        return String(texto)
            .replace(/[\r\n]+/g, ' ')
            .replace(/\\/g, '\\\\')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)');
    }

    // Ancho aproximado de un texto en Helvetica: no hay tabla de métricas
    // por carácter (para no acarrear la AFM completa), se usa un ancho
    // promedio por carácter. Alcanza para decidir si hay que achicar la
    // tipografía y evitar que un nombre de secretaría largo se salga de
    // la página.
    function anchoAproximado(texto, tamano, negrita) {
        return String(texto).length * tamano * (negrita ? 0.60 : 0.52);
    }

    function tamanoQueEntra(texto, anchoMaximo, tamanoInicial, negrita, minimo = 9) {
        let tamano = tamanoInicial;
        while (tamano > minimo && anchoAproximado(texto, tamano, negrita) > anchoMaximo) {
            tamano -= 1;
        }
        return tamano;
    }

    // --- Contenido de la página (texto + líneas + logo) -------------------
    function construirContenido({ fechaTexto, secretaria, numeroSuministro, idSolicitud }) {
        const lineas = [];

        const texto = (contenido, tamano, negrita, x, yBase) => {
            lineas.push(`BT /${negrita ? 'F2' : 'F1'} ${tamano} Tf ${x} ${yBase} Td (${escaparPdfTexto(contenido)}) Tj ET`);
        };
        const separador = (x1, x2, y) => {
            lineas.push(`${x1} ${y} m ${x2} ${y} l S`);
        };

        // Encabezado: logo arriba a la derecha, título a la izquierda.
        const logoAncho = 30;
        const logoAlto = logoAncho * (LOGO_ALTO_PX / LOGO_ANCHO_PX);
        const logoX = CONTENIDO_DER - logoAncho;
        const logoY = PAGINA_ALTO - MARGEN - logoAlto;
        lineas.push(`q ${logoAncho.toFixed(2)} 0 0 ${logoAlto.toFixed(2)} ${logoX} ${logoY.toFixed(2)} cm /Im1 Do Q`);
        texto('Solicitud de Cuota', 22, true, MARGEN, PAGINA_ALTO - MARGEN - 20);

        // Filas de datos: etiqueta chica en negrita + valor debajo, y un
        // separador horizontal que cierra cada fila.
        const filas = [
            ['Fecha', fechaTexto],
            ['Secretaría', secretaria],
            ['Suministro N°', String(numeroSuministro)],
            ['ID de la solicitud', String(idSolicitud)]
        ];

        const altoFila = 62;
        let filaTop = PAGINA_ALTO - MARGEN - 60;
        for (const [etiqueta, valor] of filas) {
            texto(etiqueta, 11, true, MARGEN, filaTop - 14);
            const tamanoValor = tamanoQueEntra(valor, CONTENIDO_ANCHO, 13, false);
            texto(valor, tamanoValor, false, MARGEN, filaTop - 34);
            separador(MARGEN, CONTENIDO_DER, filaTop - 46);
            filaTop -= altoFila;
        }

        // Pie institucional.
        separador(MARGEN, CONTENIDO_DER, 130);
        texto('Subsecretaría de Planificación Presupuestaria y Estadística', 9, true, MARGEN, 112);
        texto('Secretaría de Economía y Finanzas', 9, false, MARGEN, 99);

        return lineas.join('\n') + '\n';
    }

    // --- Armado del archivo .pdf a mano ------------------------------------
    function construirPdf({ contentStream, imagenBytes }) {
        const partes = [];
        const offsets = [];
        let offset = 0;

        function push(valor) {
            const bytes = typeof valor === 'string' ? latin1ABytes(valor) : valor;
            partes.push(bytes);
            offset += bytes.length;
        }

        function nuevoObjeto(cuerpo) {
            offsets.push(offset);
            push(`${offsets.length} 0 obj\n`);
            for (const parte of (Array.isArray(cuerpo) ? cuerpo : [cuerpo])) push(parte);
            push('\nendobj\n');
        }

        // Cabecera + comentario binario (convención estándar para avisar
        // a herramientas intermedias que el archivo tiene bytes no-ASCII).
        push('%PDF-1.4\n%' + String.fromCharCode(0xE2, 0xE3, 0xCF, 0xD3) + '\n');

        nuevoObjeto('<< /Type /Catalog /Pages 2 0 R >>'); // 1: Catalog
        nuevoObjeto('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'); // 2: Pages
        nuevoObjeto(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGINA_ANCHO} ${PAGINA_ALTO}] ` +
            '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> /XObject << /Im1 7 0 R >> >> /Contents 4 0 R >>'
        ); // 3: Page

        const contentBytes = latin1ABytes(contentStream);
        nuevoObjeto([`<< /Length ${contentBytes.length} >>\nstream\n`, contentBytes, '\nendstream']); // 4: Contents

        nuevoObjeto('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 5: fuente regular
        nuevoObjeto('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'); // 6: fuente negrita

        nuevoObjeto([
            `<< /Type /XObject /Subtype /Image /Width ${LOGO_ANCHO_PX} /Height ${LOGO_ALTO_PX} ` +
            `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imagenBytes.length} >>\nstream\n`,
            imagenBytes,
            '\nendstream'
        ]); // 7: logo (jpeg embebido tal cual, sin recodificar)

        const xrefOffset = offset;
        let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
        for (const off of offsets) {
            xref += `${String(off).padStart(10, '0')} 00000 n \n`;
        }
        push(xref);
        push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

        return concatUint8(partes);
    }

    async function generarBuffer({ fechaTexto, secretaria, numeroSuministro, idSolicitud }) {
        const resp = await fetch(LOGO_URL);
        if (!resp.ok) throw new Error(`No se pudo cargar el logo del remito (HTTP ${resp.status}).`);
        const imagenBytes = new Uint8Array(await resp.arrayBuffer());
        const contentStream = construirContenido({ fechaTexto, secretaria, numeroSuministro, idSolicitud });
        return construirPdf({ contentStream, imagenBytes });
    }

    // Genera el remito y dispara la descarga. No lanza hacia arriba: si algo
    // falla (logo ausente, error de red, etc.) se resuelve con
    // { ok: false } para que quien llama pueda avisar sin interrumpir la
    // carga del suministro, que ya quedó guardada.
    async function descargar({ fecha, secretaria, numeroSuministro, idSolicitud }) {
        try {
            const fechaTexto = fecha instanceof Date ? fecha.toLocaleDateString('es-AR') : String(fecha);
            const bytes = await generarBuffer({ fechaTexto, secretaria, numeroSuministro, idSolicitud });

            const blob = new Blob([bytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `Solicitud de cuota - Suministro ${numeroSuministro}.pdf`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            return { ok: true };
        } catch (error) {
            console.error('No se pudo generar el remito de solicitud de cuota:', error);
            return { ok: false, error: error.message || String(error) };
        }
    }

    return { descargar };
})();
