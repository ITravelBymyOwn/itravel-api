// Catalog matches are working proposals. Neither determines how a transaction is taxed.
export const accountingFiscalProfile = {
  version: '2026-11-26',
  review_status: 'draft',
  country: 'CR',
  activity: {
    code: '6311.0',
    catalog: 'TRIBU-CR (CIIU Rev. 4)',
    label: 'Procesamiento de datos, hospedaje y actividades conexas',
    source_url: 'https://www.hacienda.go.cr/ClasificacionActividadesEconomicas.html',
    business_description: 'Servicio de acceso a una aplicación web propia para generar itinerarios personalizados, con cobro por generación.'
  },
  itinerary_cabys: {
    code: '8439200000000',
    label: 'Servicios de programas informáticos (software) en línea (on-line), n.c.p.',
    source_url: 'https://www.bccr.fi.cr/cr/es/noticias/listado-de-noticias/2025/actualizacion-del-catalogo-de-bienes-y-servicios-cabys-2025.html'
  },
  categories: {
    income: ['Ventas de itinerarios', 'Comisiones de afiliados', 'Reembolsos y ajustes de ventas', 'Otros ingresos'],
    expense: ['Infraestructura y software', 'Publicidad', 'Comisiones de pago', 'Comisiones a colaboradores',
      'Servicios profesionales', 'Reembolsos y ajustes de gastos', 'Otros gastos']
  }
};
