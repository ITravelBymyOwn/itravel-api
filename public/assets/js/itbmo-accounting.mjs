import { extractAccountingFile, prepareCameraPhoto } from './itbmo-accounting-extract.mjs';

const byId = id => document.getElementById(id);
const intake = byId('intake');
const period = byId('period');
const archive = byId('documents');
const status = byId('status');
const intakeStatus = byId('intake-status');
const archiveStatus = byId('archive-status');
const fiscalLabels = {
  pending: 'Por revisar', eligible: 'Aplica', ineligible: 'No aplica', partial: 'Parcial', not_applicable: 'No corresponde'
};
const kindLabels = { invoice: 'Factura', receipt: 'Tiquete o recibo', credit_note: 'Nota de crédito', debit_note: 'Nota de débito', other: 'Otro' };
const fieldLabels = {
  document_kind: 'Tipo', jurisdiction: 'Origen fiscal', issuer_id: 'Identificación del emisor', document_number: 'Número', document_key: 'Clave electrónica',
  subtotal: 'Subtotal', tax: 'Impuesto', exchange_rate: 'Tipo de cambio a CRC', vat_treatment: 'Crédito de IVA',
  income_tax_treatment: 'Deducibilidad de renta', paypal_reference: 'ID de PayPal', notes: 'Notas', original_name: 'Archivo'
};
const errorMessages = {
  ACCOUNTING_UNAVAILABLE: 'El módulo aún no está habilitado en este entorno.',
  ACCOUNTING_SIGN_IN: 'Inicia sesión con tu cuenta de ITBMO.',
  ACCOUNTING_FORBIDDEN: 'Esta cuenta no tiene acceso al archivo contable.',
  ACCOUNTING_QUOTA: 'El archivo alcanzó su límite de almacenamiento configurado.',
  DUPLICATE_DOCUMENT: 'Este comprobante ya está registrado o tiene una carga pendiente con la misma clave.',
  FILE_TOO_LARGE: 'Este archivo supera el límite de 3 MB.',
  INVALID_FILE_TYPE: 'Selecciona un XML, PDF, JPG, PNG o WebP.',
  INVALID_FILE: 'El archivo no coincide con su formato o está dañado.',
  INVALID_DOCUMENT: 'Revisa la fecha, los importes y la información del comprobante.',
  INVALID_AFFILIATE_SETTLEMENT: 'Confirma una liquidación pagada y revisa el programa, la fecha, la referencia y la comisión bruta. Omio y Airalo corresponden a Impact.',
  INVALID_CREATOR_PAYMENT: 'Revisa el código, la fecha, el importe, el medio y la referencia del pago.',
  CREATOR_CODE_NOT_FOUND: 'No se encontró este código de colaborador.',
  CREATOR_REFERENCE_CONFLICT: 'Esa referencia ya está registrada para otro pago.',
  CREATOR_BALANCE_CHANGED: 'El importe supera el saldo disponible. Vuelve a consultar el código.',
  INVALID_PAYPAL_CSV: 'Usa el CSV de actividad de PayPal en inglés con código de evento, hasta 1.000 filas y el orden de fechas correcto.',
  INVALID_BILLING_REVIEW: 'Revisa la clasificación y la evidencia. Si la venta ya fue revisada, vuelve a consultar.',
  ACCOUNTING_STORAGE_ERROR: 'No pudimos guardar o consultar el archivo. Si estabas cargándolo, conserva esta selección y vuelve a intentar.'
};
let file;
let extractionMethod = 'manual';
let selectionVersion = 0;
let periodVersion = 0;
let rows = [];
let activePeriod;
let fiscalProfile;

for (const select of document.querySelectorAll('[data-fiscal]')) {
  for (const [value, label] of Object.entries(fiscalLabels)) select.append(new Option(label, value));
}
const monthFormat = new Intl.DateTimeFormat('es-CR', { month: 'long', timeZone: 'UTC' });
for (let i = 0; i < 12; i++) {
  period.elements.month.append(new Option(monthFormat.format(new Date(Date.UTC(2026, i, 1))), String(i + 1)));
}
period.elements.year.value = new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'America/Costa_Rica' }).format();

async function request(action, fields = {}) {
  let token;
  try { token = localStorage.getItem('itbmo_session_token'); } catch {}
  const response = await fetch('/api/accounting', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ action, ...fields })
  });
  if (response.status === 413) throw new Error(errorMessages.FILE_TOO_LARGE);
  const data = await response.json();
  if (data.code === 'ACCOUNTING_SIGN_IN' || data.code === 'ACCOUNTING_FORBIDDEN' || data.code === 'ACCOUNTING_UNAVAILABLE') {
    byId('ledger').hidden = true;
    byId('login').hidden = data.code === 'ACCOUNTING_UNAVAILABLE';
  }
  if (!response.ok || !data.ok) throw new Error(errorMessages[data.code] || 'No se pudo completar la operación. Intenta de nuevo.');
  return data;
}

function resetSelection() {
  selectionVersion++;
  file = undefined;
  extractionMethod = 'manual';
  intake.reset();
  updateCategoryOptions();
  intake.hidden = true;
  intakeStatus.textContent = '';
  byId('file').value = byId('camera').value = '';
}

async function selectFile(input, fromCamera) {
  const selected = input.files[0];
  if (!selected) return;
  resetSelection();
  const version = selectionVersion;
  intakeStatus.textContent = 'Leyendo comprobante en tu dispositivo…';
  try {
    const prepared = fromCamera ? await prepareCameraPhoto(selected) : selected;
    if (version !== selectionVersion) return;
    if (prepared.size > 3 * 1024 * 1024) throw new Error(errorMessages.FILE_TOO_LARGE);
    if (!prepared.size || !/\.(xml|pdf|jpe?g|png|webp)$/i.test(prepared.name)) throw new Error(errorMessages.INVALID_FILE_TYPE);
    file = prepared;
  } catch (error) {
    if (version === selectionVersion) intakeStatus.textContent = error.message;
    return;
  }
  try {
    const { fields, method, limited } = await extractAccountingFile(file);
    if (version !== selectionVersion) return;
    extractionMethod = method;
    for (const [name, value] of Object.entries(fields)) {
      if (value) intake.elements[name].value = value;
    }
    updateCategoryOptions();
    intakeStatus.textContent = limited
      ? 'Se analizaron las primeras 8 páginas. Completa los datos y revisa el comprobante completo antes de guardar.'
      : 'Revisa los campos propuestos y completa los que falten antes de guardar.';
  } catch {
    if (version !== selectionVersion) return;
    intakeStatus.textContent = 'La lectura automática no produjo datos utilizables. Puedes completar la ficha manualmente.';
  }
  intake.hidden = false;
  intake.elements.issue_date.focus();
}

function fileBase64(attachment) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('No se pudo leer el archivo seleccionado.'));
    reader.readAsDataURL(attachment);
  });
}

function makeNode(tag, label, className) {
  const element = document.createElement(tag);
  if (label) element.textContent = label;
  if (className) element.className = className;
  return element;
}

function updateCategoryOptions() {
  const choices = fiscalProfile?.categories[intake.elements.direction.value] || [];
  byId('categories').replaceChildren(...choices.map(category => new Option(category)));
}

function renderFiscalProfile(profile) {
  if (!profile) return;
  fiscalProfile = profile;
  for (const [id, info] of [['fiscal-activity', profile.activity], ['fiscal-cabys', profile.itinerary_cabys], ['fiscal-affiliate', profile.affiliate_activity]]) {
    if (!info) continue;
    const link = makeNode('a', `${info.code} · ${info.label}`);
    link.href = info.source_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    byId(id).replaceChildren(link);
  }
  byId('fiscal-description').textContent = profile.activity.business_description;
  byId('fiscal-profile').hidden = false;
  updateCategoryOptions();
}

function documentRow(row) {
  const card = makeNode('article', '', 'document');
  const heading = makeNode('div');
  heading.append(makeNode('p', row.issuer), makeNode('p', [movementLabels[row.direction], row.category, row.currency + ' ' + row.total].join(' · '), 'metadata'));
  const download = makeNode('button', 'Descargar');
  download.type = 'button';
  download.addEventListener('click', async () => {
    download.disabled = true;
    try {
      const { url } = await request('download', { id: row.id });
      window.location.assign(url);
    } catch (error) {
      archiveStatus.textContent = error.message;
    } finally {
      download.disabled = false;
    }
  });
  const details = makeNode('details');
  const values = makeNode('dl');
  const formatted = {
    ...row,
    document_kind: kindLabels[row.document_kind],
    jurisdiction: { pending: 'Por revisar', CR: 'Costa Rica', foreign: 'Exterior' }[row.jurisdiction],
    vat_treatment: fiscalLabels[row.vat_treatment], income_tax_treatment: fiscalLabels[row.income_tax_treatment]
  };
  for (const [key, label] of Object.entries(fieldLabels)) {
    const value = formatted[key];
    if (value != null && value !== '') values.append(makeNode('dt', label), makeNode('dd', String(value)));
  }
  details.append(makeNode('summary', 'Ver ficha'), values);
  if (row.affiliate_settlement) heading.append(makeNode('p', 'Liquidación de afiliados · Revisión fiscal pendiente', 'metadata'));
  card.append(heading);
  if (row.original_name) card.append(download);
  card.append(details);
  return card;
}

function renderArchive() {
  const fragment = document.createDocumentFragment();
  let month = '';
  let day = '';
  for (const row of rows) {
    const yearMonth = row.issue_date.slice(0, 7);
    if (month !== yearMonth) {
      month = yearMonth;
      const date = new Date(row.issue_date + 'T00:00:00Z');
      fragment.append(makeNode('h3', monthFormat.format(date) + ' de ' + row.issue_date.slice(0, 4)));
    }
    if (day !== row.issue_date) {
      day = row.issue_date;
      fragment.append(makeNode('h4', 'Día ' + Number(day.slice(-2))));
    }
    fragment.append(documentRow(row));
  }
  archive.replaceChildren(fragment);
}

async function loadArchive(append = false) {
  const version = ++periodVersion;
  if (!append) activePeriod = Object.fromEntries(new FormData(period));
  const offset = append ? rows.length : 0;
  byId('more').disabled = true;
  byId('export').disabled = true;
  archiveStatus.textContent = 'Buscando comprobantes…';
  try {
    const data = await request('list', { ...activePeriod, offset });
    if (version !== periodVersion) return;
    rows = append ? [...rows, ...data.documents] : data.documents;
    renderFiscalProfile(data.fiscal_profile);
    renderArchive();
    byId('ledger').hidden = false;
    byId('login').hidden = true;
    byId('more').hidden = !data.more;
    status.textContent = '';
    archiveStatus.textContent = rows.length ? `${rows.length} comprobante${rows.length === 1 ? '' : 's'} en pantalla.` : 'No hay comprobantes en este período.';
  } catch (error) {
    if (version === periodVersion) (byId('ledger').hidden ? status : archiveStatus).textContent = error.message;
  } finally {
    if (version === periodVersion) {
      byId('more').disabled = false;
      byId('export').disabled = false;
    }
  }
}

const columns = {
  issue_date: 'Fecha de emisión', direction: 'Movimiento', document_kind: 'Tipo', issuer: 'Emisor',
  issuer_id: 'Identificación del emisor', jurisdiction: 'Origen fiscal', document_number: 'Número', document_key: 'Clave', currency: 'Moneda',
  subtotal: 'Subtotal', tax: 'Impuesto', total: 'Total', exchange_rate: 'Tipo de cambio a CRC',
  category: 'Categoría', vat_treatment: 'Crédito de IVA', income_tax_treatment: 'Deducibilidad de renta',
  paypal_reference: 'ID de PayPal', notes: 'Notas', original_name: 'Archivo'
};

function csv(value) {
  const text = String(value ?? '');
  const escaped = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(text) ? "'" + text : text;
  return '"' + escaped.replaceAll('"', '""') + '"';
}

byId('export').addEventListener('click', async () => {
  if (!period.reportValidity()) return;
  const filters = Object.fromEntries(new FormData(period));
  const button = byId('export');
  button.disabled = true;
  archiveStatus.textContent = 'Preparando la exportación…';
  try {
    const result = [];
    let more;
    do {
      const data = await request('list', { ...filters, offset: result.length });
      result.push(...data.documents);
      more = data.more;
    } while (more);
    const lines = [Object.values(columns).map(csv).join(',')];
    lines.push(...result.map(row => Object.keys(columns).map(key => csv(key === 'document_key' && row[key] ? "'" + row[key] : row[key])).join(',')));
    const url = URL.createObjectURL(new Blob(['\uFEFF', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const anchor = makeNode('a');
    anchor.href = url;
    anchor.download = ['ITBMO-contabilidad', filters.year, filters.month].filter(Boolean).join('-') + '.csv';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    archiveStatus.textContent = 'Exportación preparada.';
  } catch (error) {
    archiveStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

for (const id of ['file', 'camera']) {
  byId(id).addEventListener('change', event => { void selectFile(event.currentTarget, id === 'camera'); });
}
byId('clear').addEventListener('click', resetSelection);
intake.elements.direction.addEventListener('change', updateCategoryOptions);
byId('retry').addEventListener('click', () => { void loadArchive(); });
byId('more').addEventListener('click', () => { void loadArchive(true); });
period.addEventListener('submit', event => { event.preventDefault(); void loadArchive(); });

const movementLabels = { income: 'Ingreso', expense: 'Gasto', transfer: 'Transferencia propia', unclassified: 'Conciliación de PayPal' };
const journalButton = byId('journal-load');
const journalMore = byId('journal-more');
const journalStatus = byId('journal-status');
const journalContainer = byId('journal-entries');
let journalPeriod;
let journalOffset = 0;

async function loadJournal(append = false) {
  if (journalButton.disabled || (!append && !period.reportValidity())) return;
  const filters = append ? journalPeriod : Object.fromEntries(new FormData(period));
  const offset = append ? journalOffset : 0;
  journalButton.disabled = journalMore.disabled = true;
  journalStatus.textContent = 'Consultando movimientos…';
  try {
    const data = await request('journal', { ...filters, offset });
    if (!append) journalContainer.replaceChildren();
    for (const row of data.entries) {
      const article = makeNode('article', '', 'document');
      const detail = makeNode('div');
      const review = {
        matched: 'Conciliado por referencia', pending_review: 'Pendiente de revisión',
        affiliate_settlement: 'Liquidación registrada · Revisión fiscal pendiente',
        pending: 'Comisión pendiente', approved: 'Comisión aprobada', reversed: 'Comisión anulada'
      }[row.review_status];
      detail.append(makeNode('p', `${row.entry_date} · ${row.description} · ${row.currency} ${row.amount}`),
        makeNode('p', [row.source === 'impact' ? 'Impact.com' : movementLabels[row.direction], row.category, row.reference, review].filter(Boolean).join(' · '), 'metadata'));
      article.append(detail);
      journalContainer.append(article);
    }
    journalPeriod = filters;
    journalOffset = offset + data.entries.length;
    journalMore.hidden = !data.more;
    journalStatus.textContent = journalOffset ? `${journalOffset} movimientos en pantalla.` : 'Sin movimientos en el período.';
  } catch (error) {
    journalStatus.textContent = error.message;
  } finally {
    journalButton.disabled = journalMore.disabled = false;
  }
}

journalButton.addEventListener('click', () => { void loadJournal(); });
journalMore.addEventListener('click', () => { void loadJournal(true); });
const paypalImport = byId('paypal-import');
paypalImport.addEventListener('submit', async event => {
  event.preventDefault();
  const file = paypalImport.elements.file.files[0];
  const button = paypalImport.querySelector('button[type="submit"]');
  const status = byId('paypal-status');
  if (file.size > 1024 * 1024) { status.textContent = 'El CSV supera 1 MiB.'; return; }
  button.disabled = true;
  status.textContent = 'Importando actividad…';
  try {
    const result = await request('paypal_import', { csv: await file.text(), date_format: paypalImport.elements.format.value });
    status.textContent = `${result.imported} movimientos nuevos. ${result.duplicates} referencias repetidas.`;
    await loadJournal();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

let salesPeriod;
let salesOffset = 0;
const salesStatus = byId('billing-status');
const salesMore = byId('billing-more');
const salesLoad = byId('billing-load');
const salesContainer = byId('billing-sales');
const saleDate = new Intl.DateTimeFormat('es-CR', { dateStyle: 'medium', timeZone: 'America/Costa_Rica' });
const saleStates = { pending_review: 'Pendiente de revisión fiscal', ready: 'Revisión fiscal completada',
  submitted: 'En validación', accepted: 'Aceptado por Hacienda', rejected: 'Rechazado por Hacienda' };

function billingReview(row) {
  const form = makeNode('form', '', 'fields');
  const typeLabel = makeNode('label', 'Tratamiento y comprobante');
  const type = makeNode('select');
  type.required = true;
  type.append(new Option('Seleccionar', ''), new Option('Costa Rica · Factura', '01'),
    new Option('Costa Rica · Tiquete', '04'), new Option('Exportación · Factura de exportación', '09'));
  typeLabel.append(type);
  const evidenceLabel = makeNode('label', 'Evidencia del lugar de uso');
  const evidence = makeNode('input');
  evidence.minLength = 5;
  evidence.maxLength = 500;
  evidence.required = true;
  evidenceLabel.append(evidence);
  const submit = makeNode('button', 'Guardar revisión');
  form.append(typeLabel, evidenceLabel, submit);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await request('billing_review', { id: row.payment_id, document_type: type.value,
        treatment: type.value === '09' ? 'export' : 'domestic', evidence: evidence.value });
      await loadBillingSales();
    } catch (error) {
      salesStatus.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  const details = makeNode('details');
  details.append(makeNode('summary', 'Revisar venta'), form);
  return details;
}

async function loadBillingSales(append = false) {
  if (!append && !period.reportValidity()) return;
  salesLoad.disabled = salesMore.disabled = true;
  const filters = append ? salesPeriod : Object.fromEntries(new FormData(period));
  const offset = append ? salesOffset : 0;
  salesStatus.textContent = 'Buscando ventas…';
  try {
    const data = await request('billing_sales', { ...filters, offset });
    const items = data.sales.map(row => {
      const entry = makeNode('article', '', 'document');
      const detail = makeNode('div');
      detail.append(makeNode('p', `${saleDate.format(new Date(row.paid_at))} · ${row.currency} ${row.gross_amount}`),
        makeNode('p', `PayPal · ${row.capture_reference} · ${saleStates[row.fiscal_status]}`, 'metadata'));
      if (row.promotion_code) {
        const figures = [
          ['Código', row.promotion_code], ['Precio regular', row.regular_amount],
          ['Facturado', row.gross_amount], ['Comisión', row.creator_commission],
          ['ITBMO antes de cargos e impuestos', row.itbmo_share]
        ];
        if (Number(row.refund_amount) > 0) figures.push(['Reembolso', row.refund_amount]);
        if (Number(row.creator_commission_reversed) > 0) figures.push(['Comisión revertida', row.creator_commission_reversed]);
        const breakdown = makeNode('dl');
        for (const [label, value] of figures) {
          breakdown.append(makeNode('dt', label), makeNode('dd',
            label === 'Código' ? value : new Intl.NumberFormat('es-CR', { style: 'currency', currency: row.currency }).format(Number(value))));
        }
        detail.append(breakdown);
      }
      entry.append(detail);
      if (row.fiscal_status === 'pending_review') entry.append(billingReview(row));
      if (row.vat_amount != null) {
        detail.append(makeNode('p', `Base ${row.net_amount} · IVA ${row.vat_amount} ${row.currency}`, 'metadata'));
      }
      return entry;
    });
    if (!append) salesContainer.replaceChildren();
    salesContainer.append(...items);
    salesPeriod = filters;
    salesOffset = offset + data.sales.length;
    salesMore.hidden = !data.more;
    const label = filters.month ? `${filters.year}/${String(filters.month).padStart(2, '0')}` : filters.year;
    salesStatus.textContent = salesOffset ? `${label} · ${salesOffset} ventas en pantalla.` : `${label} · Sin ventas de prueba.`;
  } catch (error) {
    salesStatus.textContent = error.message;
  } finally {
    salesLoad.disabled = salesMore.disabled = false;
  }
}

salesLoad.addEventListener('click', () => { void loadBillingSales(); });
salesMore.addEventListener('click', () => { void loadBillingSales(true); });

intake.addEventListener('submit', async event => {
  event.preventDefault();
  if (!file) return;
  const attachment = file;
  const form = Object.fromEntries(new FormData(intake));
  form.extraction_method = extractionMethod;
  const controls = ['save', 'file', 'camera', 'clear'].map(byId);
  for (const control of controls) control.disabled = true;
  intakeStatus.textContent = 'Archivando comprobante…';
  try {
    await request('upload', { document: form, name: attachment.name, file: await fileBase64(attachment) });
    resetSelection();
    period.elements.year.value = form.issue_date.slice(0, 4);
    period.elements.month.value = String(Number(form.issue_date.slice(5, 7)));
    await loadArchive();
    intakeStatus.textContent = 'Comprobante archivado por su fecha de emisión.';
  } catch (error) {
    intakeStatus.textContent = error.message;
  } finally {
    for (const control of controls) control.disabled = false;
  }
});

const affiliateIntake = byId('affiliate-intake');
const affiliateStatus = byId('affiliate-status');
const affiliateClear = byId('affiliate-clear');
let affiliateAttachment;
let affiliateExtraction = 'manual';
let affiliateSelection = 0;

function clearAffiliateAttachment() {
  affiliateSelection++;
  affiliateAttachment = undefined;
  affiliateExtraction = 'manual';
  byId('affiliate-file').value = byId('affiliate-camera').value = '';
  affiliateClear.hidden = true;
}

async function readAffiliateAttachment(input) {
  const selected = input.files[0];
  if (!selected) return;
  clearAffiliateAttachment();
  const version = affiliateSelection;
  const submit = affiliateIntake.querySelector('button[type="submit"]');
  submit.disabled = true;
  affiliateIntake.elements.confirmed.checked = false;
  affiliateStatus.textContent = 'Leyendo el respaldo en tu dispositivo…';
  try {
    const prepared = input.id === 'affiliate-camera' ? await prepareCameraPhoto(selected) : selected;
    if (version !== affiliateSelection) return;
    if (prepared.size > 3 * 1024 * 1024) throw new Error(errorMessages.FILE_TOO_LARGE);
    if (!prepared.size || !/\.(pdf|jpe?g|png|webp)$/i.test(prepared.name)) throw new Error(errorMessages.INVALID_FILE_TYPE);
    affiliateAttachment = prepared;
    affiliateClear.hidden = false;
    const { fields, method, limited } = await extractAccountingFile(prepared, { affiliate: true });
    if (version !== affiliateSelection) return;
    affiliateExtraction = method;
    for (const [name, value] of Object.entries(fields)) {
      if (value && !affiliateIntake.elements[name].value) affiliateIntake.elements[name].value = value;
    }
    affiliateStatus.textContent = limited
      ? 'Se leyeron las primeras 8 páginas. Verifica los datos contra el respaldo completo.'
      : 'Respaldo listo. Verifica los datos sugeridos y completa los campos faltantes.';
  } catch (error) {
    if (version === affiliateSelection) {
      affiliateStatus.textContent = affiliateAttachment
        ? 'Se adjuntó el respaldo. Completa los datos manualmente.'
        : error.message;
    }
  } finally {
    if (version === affiliateSelection) submit.disabled = false;
  }
}

for (const id of ['affiliate-file', 'affiliate-camera']) {
  byId(id).addEventListener('change', event => { void readAffiliateAttachment(event.currentTarget); });
}
affiliateClear.addEventListener('click', () => {
  clearAffiliateAttachment();
  affiliateIntake.elements.confirmed.checked = false;
  affiliateIntake.querySelector('button[type="submit"]').disabled = false;
  affiliateStatus.textContent = 'Respaldo quitado. Revisa los datos antes de registrar.';
});
affiliateIntake.addEventListener('submit', async event => {
  event.preventDefault();
  const form = Object.fromEntries(new FormData(affiliateIntake));
  const attachment = affiliateAttachment;
  const controls = [...affiliateIntake.elements, byId('affiliate-file'), byId('affiliate-camera')];
  for (const control of controls) control.disabled = true;
  affiliateStatus.textContent = 'Registrando liquidación…';
  try {
    const evidence = attachment ? { name: attachment.name, file: await fileBase64(attachment) } : {};
    await request('affiliate_settlement', { document: { ...form, extraction_method: affiliateExtraction }, ...evidence });
    affiliateIntake.reset();
    clearAffiliateAttachment();
    period.elements.year.value = form.issue_date.slice(0, 4);
    period.elements.month.value = String(Number(form.issue_date.slice(5, 7)));
    await Promise.all([loadArchive(), loadJournal()]);
    affiliateStatus.textContent = 'Comisión registrada como ingreso. Revisión fiscal pendiente.';
  } catch (error) {
    affiliateStatus.textContent = error.message;
  } finally {
    for (const control of controls) control.disabled = false;
  }
});

const creatorPayment = byId('creator-payment');
const creatorDetails = byId('creator-payment-details');
const creatorResult = byId('creator-result');
const creatorPaymentStatus = byId('creator-payment-status');
const creatorLookup = byId('creator-lookup');
const creatorCode = creatorPayment.elements.code;
const creatorDate = creatorPayment.elements.date;
const today = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Costa_Rica' }).formatToParts(new Date());
const todayParts = Object.fromEntries(today.map(({ type, value }) => [type, value]));
creatorDate.max = [todayParts.year, todayParts.month, todayParts.day].join('-');

function closeCreatorDetails() {
  creatorDetails.hidden = true;
  creatorDetails.disabled = true;
  creatorPayment.elements.confirmed.checked = false;
}
creatorCode.addEventListener('input', () => {
  closeCreatorDetails();
  creatorResult.textContent = '';
  creatorPaymentStatus.textContent = '';
});
creatorLookup.addEventListener('click', async () => {
  const code = creatorCode.value.trim();
  if (!creatorCode.reportValidity()) return;
  closeCreatorDetails();
  creatorLookup.disabled = true;
  creatorResult.textContent = 'Consultando saldo…';
  creatorPaymentStatus.textContent = '';
  try {
    const { creator } = await request('creator_balance', { code });
    if (creatorCode.value.trim() !== code) return;
    const balance = new Intl.NumberFormat('es-CR', { style: 'currency', currency: creator.currency }).format(creator.available_cents / 100);
    creatorCode.value = creator.code;
    creatorResult.textContent = `${creator.name} · ${creator.code} · Disponible ${balance}`;
    creatorDetails.hidden = false;
    creatorDetails.disabled = false;
  } catch (error) {
    if (creatorCode.value.trim() === code) creatorResult.textContent = error.message;
  } finally {
    creatorLookup.disabled = false;
  }
});
creatorPayment.addEventListener('submit', async event => {
  event.preventDefault();
  if (creatorDetails.disabled) return;
  const form = Object.fromEntries(new FormData(creatorPayment));
  creatorDetails.disabled = creatorLookup.disabled = creatorCode.disabled = true;
  creatorPaymentStatus.textContent = 'Registrando pago…';
  try {
    const data = await request('creator_payment', form);
    creatorPayment.reset();
    closeCreatorDetails();
    creatorResult.textContent = '';
    period.elements.year.value = form.date.slice(0, 4);
    period.elements.month.value = String(Number(form.date.slice(5, 7)));
    await loadJournal();
    creatorPaymentStatus.textContent = data.duplicate ? 'Este pago ya estaba registrado.' :
      'Pago registrado en el libro y en el historial del colaborador.';
  } catch (error) {
    creatorDetails.disabled = false;
    creatorPaymentStatus.textContent = error.message;
  } finally {
    creatorLookup.disabled = creatorCode.disabled = false;
  }
});

void loadArchive();
