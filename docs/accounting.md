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

## Siguiente incremento

1. **Libro y correcciones.** Asociar XML, PDF y confirmación de Hacienda a una misma ficha. Permitir corregir metadatos con historial, conservar el documento original y registrar notas de crédito y débito con sus referencias.
2. **Clasificación fiscal.** Versionar reglas por fecha, jurisdicción, actividad y régimen. Registrar base y tarifa de IVA por línea o desglose, crédito parcial con evidencia, deducibilidad de renta por separado y tipo de cambio con fuente y fecha. El criterio fiscal queda sujeto a revisión antes de consolidar.
3. **Conciliación.** Importar movimientos de PayPal y estados bancarios CRC/USD. Emparejar ventas, comisiones, reembolsos y transferencias sin contabilizar el abono bancario como otra venta. Conservar por separado bruto, comisión, neto, moneda y fecha.
4. **Cierre.** Preparar auxiliares de IVA mensual y utilidades anual, con trazabilidad a cada respaldo, pendientes y exportaciones Excel/CSV/PDF para traslado manual a TRIBU-CR. Confirmar la actividad, el régimen y los formularios aplicables antes de fijar reglas.
5. **Facturación.** Vincular ventas con comprobantes emitidos en Tico Factura. Definir emisión local y exterior según el tratamiento confirmado para ITBMO.
