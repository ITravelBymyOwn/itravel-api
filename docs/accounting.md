# Contabilidad privada de ITBMO

## Archivo y captura

- El portal usa una sesión registrada de ITBMO y una lista de perfiles autorizados. La lista arranca vacía. Se agregan únicamente los perfiles QA autorizados de Esteban y Laura para la prueba.
- La primera versión usa un bucket privado de Supabase. La ruta de cada archivo es `AAAA/MM/DD/UUID.ext`, con la fecha de emisión confirmada por el usuario. Postgres conserva la ficha, el usuario que realizó la carga, la fecha de carga y el vínculo al archivo.
- El XML costarricense tiene precedencia cuando está disponible. PDF.js extrae texto del PDF y Tesseract lee imágenes y páginas escaneadas. El procesamiento ocurre en el navegador con dependencias servidas por ITBMO. Hay revisión manual antes del archivo. La extracción XML no valida la firma electrónica ni la aceptación del comprobante por Hacienda.
- El navegador móvil ofrece una acción de cámara trasera en dispositivos compatibles y una opción para elegir archivos. Si una captura supera el límite o requiere conversión, se guarda la copia JPEG preparada por el navegador. Los archivos seleccionados en el explorador se conservan sin conversión.
- Límite inicial de 3 MiB por archivo y 100 MiB para el módulo. Los límites propios de Supabase y Vercel se comparten con el resto del proyecto. La aplicación no contrata ni invoca servicios de OCR de pago.
- Una carga repetida se detecta por SHA-256 o por clave electrónica. Una carga interrumpida se puede reintentar seleccionando el mismo archivo. El listado solo muestra comprobantes guardados por completo.

## Preview

La API requiere la rama `preview/accounting`, el proyecto Supabase QA y `ITBMO_ACCOUNTING_ENABLED=1`. Antes de activarla, aplicar la migración solo en QA, confirmar las variables de Supabase de esa rama y dar acceso explícito a los dos perfiles QA registrados. La ruta es `/contabilidad`. El entorno de producción requiere una decisión de despliegue posterior.

Las dependencias de extracción se construyen con `npm ci --prefix accounting-assets && npm run --prefix accounting-assets build`. El constructor estático de Vercel publica esos recursos en `/accounting-assets/`.

## Perfil fiscal propuesto

ITBMO cobra por generar un itinerario con su aplicación web. Con ese modelo, la candidata principal en TRIBU-CR es **6311.0 — Procesamiento de datos, hospedaje y actividades conexas**. La clase CIIU 6311 incluye la provisión de servicios de aplicaciones y el procesamiento de datos facilitados por clientes. [Clasificador de Hacienda](https://www.hacienda.go.cr/ClasificacionActividadesEconomicas.html) · [Detalle de la CIIU Rev. 4](https://unstats.un.org/unsd/classifications/Econ/Detail/EN/27/6311)

La clase **7990** merece validación si Hacienda considera que el servicio contratado consiste principalmente en entregar información turística al viajero. Su alcance incluye información al visitante, además de reservas. Cuando el cliente compra el uso de la aplicación para generar el itinerario, la clase 6311 es la hipótesis de trabajo. [Alcance de la clase 7990](https://unstats.un.org/unsd/classifications/Econ/Structure/Detail/EN/27/7990)

El CABYS candidato para la línea del itinerario es **8439200000000 — Servicios de programas informáticos en línea, n.c.p.**. Si se confirma que lo facturado es información al visitante, revisar **8556200000000**. Las comisiones de afiliados se registran por separado y su clasificación se confirma según el servicio previsto en cada contrato. [Catálogo CABYS del BCCR](https://www.bccr.fi.cr/cr/es/noticias/listado-de-noticias/2025/actualizacion-del-catalogo-de-bienes-y-servicios-cabys-2025.html)

El perfil interno queda en estado borrador hasta contrastar la actividad y el CABYS con OVi. Para valorar una exportación de servicios se documentará dónde se utiliza el servicio. La moneda, el medio de pago y el destino del itinerario no sustituyen esa evidencia. [Artículo 8 de la Ley 6826](https://www.pgrweb.go.cr/DOCS/NORMAS/1/VIGENTE/L/1980-1989/1980-1984/1982/7F0E/16282E.HTML)

## Siguiente incremento

1. **Libro y correcciones.** Asociar XML, PDF y confirmación de Hacienda a una misma ficha. Permitir corregir metadatos con historial, conservar el documento original y registrar notas de crédito y débito con sus referencias.
2. **Clasificación fiscal.** Versionar reglas por fecha, jurisdicción, actividad y régimen. Registrar base y tarifa de IVA por línea o desglose, crédito parcial con evidencia, deducibilidad de renta por separado y tipo de cambio con fuente y fecha. El criterio fiscal queda sujeto a revisión antes de consolidar.
3. **Conciliación.** Importar movimientos de PayPal y estados bancarios CRC/USD. Emparejar ventas, comisiones, reembolsos y transferencias sin contabilizar el abono bancario como otra venta. Conservar por separado bruto, comisión, neto, moneda y fecha.
4. **Cierre.** Preparar auxiliares de IVA mensual y utilidades anual, con trazabilidad a cada respaldo, pendientes y exportaciones Excel/CSV/PDF para traslado manual a TRIBU-CR. Confirmar la actividad, el régimen y los formularios aplicables antes de fijar reglas.
5. **Facturación.** Vincular ventas con comprobantes emitidos en Tico Factura. Definir emisión local y exterior según el tratamiento confirmado para ITBMO.

## Compras y comprobantes electrónicos

- Configuración acordada para ITBMO: **6311.0** como actividad principal de la aplicación y **7310.0 — Publicidad** como secundaria para publicidad y referencias remuneradas. El CABYS de itinerarios permanece como candidato hasta verificar su aplicación en OVi. Las comisiones de afiliados conservan su propia categoría y se revisan por contrato. [Catálogo de Hacienda](https://www.hacienda.go.cr/ClasificacionActividadesEconomicas.html)
- El piloto registra una tarea de facturación dentro de la misma transacción que confirma el pago PayPal Sandbox de un itinerario. La referencia de captura impide duplicados y los pagos pendientes, gratuitos o de producción quedan fuera del piloto.
- Una venta de prueba exige revisión del uso territorial. Para uso en Costa Rica se puede elegir factura (01) o tiquete de consumidor final (04). Para uso comprobado en el exterior se registra la propuesta de factura de exportación (09). La revisión conserva la evidencia, el perfil y la fecha. El piloto supone precio con IVA incluido para Costa Rica. Con USD 7.99, el borrador registra USD 7.07 de base y USD 0.92 de IVA. [Ley 6826, exenciones](https://www.pgrweb.go.cr/DOCS/NORMAS/1/VIGENTE/L/1980-1989/1980-1984/1982/7F0E/16282E.HTML) · [Tipos de comprobantes](https://www.hacienda.go.cr/docs/AspectosGeneralesComprobantesElectronicos.pdf)

### Conexión pendiente con Hacienda

1. Incorporar al checkout el correo de entrega, tipo de receptor, identificación cuando aplique y país de uso declarado con evidencia suficiente. País de cobro, moneda, país de la tarjeta y destino turístico son señales auxiliares. Los casos contradictorios requieren revisión.
2. Generar el XML v4.4, validar contra el XSD que corresponda y asignar clave y consecutivo una sola vez. Firmar con la llave criptográfica según las especificaciones de Hacienda. Obtener en Tico Factura las credenciales y la llave de **pruebas** y guardarlas como secretos de servidor. [Anexos técnicos](https://www.hacienda.go.cr/docs/ANEXOS_Y_ESTRUCTURAS_V4.4.pdf) · [Credenciales de pruebas](https://www.hacienda.go.cr/docs/GuiaparaCredencialesEntornodepruebas.pdf)
3. Enviar el XML firmado a la API de recepción de Hacienda mediante OIDC. Una recepción correcta deja el comprobante pendiente de validación. Consultar el estado por la misma clave antes de reenviar cuando se desconozca si se recibió. Conservar XML y respuesta de Hacienda en el bucket privado. [API de recepción](https://www.hacienda.go.cr/docs/ComprobantesElectronicosAPI.html)
4. Vincular comprobante y venta, generar la representación gráfica y entregar el comprobante por Brevo al correo de facturación. Usar un envío reintentable con estado independiente para evitar reenviar o volver a emitir por un error de correo. Registrar rechazos, devoluciones y notas de crédito con su referencia al comprobante original.
5. Validar en Sandbox el circuito completo, incluidas compras repetidas, rechazo de Hacienda y fallos de correo. La emisión, la entrega y la facturación de comisiones quedan pendientes de su conector y de la prueba oficial con credenciales.

### Libro de movimientos y PayPal

El libro se alimenta de los comprobantes archivados y las compras capturadas. Registra los retiros como transferencias y las notas de crédito con signo contrario. La moneda original se conserva.

El respaldo de una comisión puede cargarse como **Ingreso → Comisiones de afiliados**, con el socio o la red como emisor del pago y el ID exacto de PayPal en **Número de comprobante**, si existe. Usa un comprobante por movimiento. Al importar un Activity Download CSV en inglés con código de evento, el sistema cruza ese ID con el respaldo o la compra registrada. Conserva la información de PayPal para conciliación y deja en revisión los créditos que no tienen respaldo. El retiro bancario no genera ingreso. [Referencia de eventos de PayPal](https://developer.paypal.com/reports/reference/t-codes/) · [Activity Download](https://developer.paypal.com/reports/activity-download/)

El importador recibe hasta 1.000 filas por carga y conserva bruto, comisión de PayPal y neto. Para sincronizar automáticamente información externa se requiere acceso de consulta a Transaction Search de la cuenta comercial correspondiente. La sincronización no está conectada. El respaldo de un pago no resuelve por sí solo la obligación de emitir o quién sería el receptor fiscal. [Transaction Search](https://developer.paypal.com/api/transaction-search/v1)

### Comisiones de programas de afiliados

El módulo captura la comisión ganada por ITBMO desde el programa de afiliados. La venta del programa, la comisión y su liquidación en PayPal son operaciones distintas. Cada acción de Impact.com queda identificada por su ID en esa cuenta, con programa, fecha de la acción (hora de Costa Rica), moneda, importe de comisión y estado. Se actualiza la misma fila cuando cambia el estado o importe. En el libro, solo una acción aprobada se muestra como ingreso y una anulada queda en cero. La aprobación de Impact no acredita el pago efectivo ni determina automáticamente el tratamiento fiscal.

Para activar en QA, guardar `ITBMO_IMPACT_ACCOUNT_SID`, `ITBMO_IMPACT_AUTH_TOKEN` y `ITBMO_IMPACT_POSTBACK_SECRET` (aleatorio, mínimo 32 caracteres) en las variables privadas de Preview de `preview/accounting`. En Impact, confirmar qué programas están en la cuenta de ITBMO y si ya tiene un postback global. Configurar los avisos de ciclo y compensación que autorice la cuenta con POST a `/api/accounting/impact`, cabecera `X-ITBMO-Impact-Secret` y cuerpo JSON `{"action_id":"{ActionId}"}`. La ruta consulta la acción por API antes de escribir el resultado y devuelve error si no logró recuperarla o persistirla. Probar una acción nueva y sus modificaciones antes de habilitar en operación. La ruta tiene que ser accesible desde Impact mediante la protección de despliegue que se configure para QA.

El postback procesa eventos recibidos después de activarlo. La carga histórica requiere el reporte de acciones del programa. Cada programa fuera de Impact requiere verificar su propio API o reporte de **comisiones**. Cuando se carga evidencia manual de una comisión queda pendiente de conciliación en el libro, para evitar sumar el mismo dinero al cargar un reporte o comprobante que ya representa una acción registrada.
