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
  income_tax_treatment: 'Deducibilidad de renta', notes: 'Notas', original_name: 'Archivo'
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
  heading.append(makeNode('p', row.issuer), makeNode('p', [row.direction === 'income' ? 'Ingreso' : 'Gasto', row.category, row.currency + ' ' + row.total].join(' · '), 'metadata'));
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
  card.append(heading, download, details);
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
  notes: 'Notas', original_name: 'Archivo'
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

void loadArchive();
