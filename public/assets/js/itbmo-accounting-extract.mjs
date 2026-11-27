const ASSETS = '/accounting-assets/';
const XML_KINDS = {
  FacturaElectronica: 'invoice', FacturaElectronicaCompra: 'invoice',
  FacturaElectronicaExportacion: 'invoice', TiqueteElectronico: 'receipt',
  ReciboElectronicoPago: 'receipt', NotaCreditoElectronica: 'credit_note',
  NotaDebitoElectronica: 'debit_note'
};

const direct = (element, name) => Array.from(element?.children || []).find(child => child.localName === name);
const value = (element, name) => direct(element, name)?.textContent.trim() || '';

export function extractXml(xml) {
  if (/<!doctype|<!entity/i.test(xml)) throw new Error('XML no compatible');
  const root = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
  if (root.localName === 'parsererror' || !Object.hasOwn(XML_KINDS, root.localName)) {
    throw new Error('XML sin estructura de comprobante reconocida');
  }
  const summary = direct(root, 'ResumenFactura');
  const money = direct(summary, 'CodigoTipoMoneda');
  const issuer = direct(root, 'Emisor');
  return {
    fields: {
      issue_date: value(root, 'FechaEmision').slice(0, 10),
      issuer: value(issuer, 'Nombre'),
      issuer_id: value(direct(issuer, 'Identificacion'), 'Numero'),
      document_kind: XML_KINDS[root.localName],
      jurisdiction: root.namespaceURI?.includes('comprobanteselectronicos.go.cr') ||
        root.namespaceURI?.includes('hacienda.go.cr') ? 'CR' : 'pending',
      document_number: value(root, 'NumeroConsecutivo'),
      document_key: value(root, 'Clave'),
      currency: value(money, 'CodigoMoneda') || value(summary, 'CodigoMoneda'),
      subtotal: value(summary, 'TotalVentaNeta'),
      tax: value(summary, 'TotalImpuesto'),
      total: value(summary, 'TotalComprobante'),
      exchange_rate: value(money, 'TipoCambio') || value(summary, 'TipoCambio')
    },
    method: 'xml'
  };
}

function decimal(text) {
  let number = text.replace(/[^0-9.,]/g, '');
  const last = Math.max(number.lastIndexOf('.'), number.lastIndexOf(','));
  const decimalLength = number.length - last - 1;
  if (last >= 0 && decimalLength === 3) return '';
  if (last >= 0 && decimalLength >= 1 && decimalLength <= 5) {
    number = number.slice(0, last).replace(/[^0-9]/g, '') + '.' + number.slice(last + 1);
  }
  return /^\d{1,13}(\.\d{1,5})?$/.test(number) ? number : '';
}

function dateFromText(text) {
  const date = text.match(/\b((?:19|20|21)\d\d)[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (date) return [date[1], date[2].padStart(2, '0'), date[3].padStart(2, '0')].join('-');
  const dmy = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.]((?:19|20|21)\d\d)\b/);
  if (!dmy || (Number(dmy[1]) <= 12 && Number(dmy[2]) <= 12 && dmy[1] !== dmy[2])) return '';
  const [a, b] = [dmy[1].padStart(2, '0'), dmy[2].padStart(2, '0')];
  return Number(a) > 12 ? `${dmy[3]}-${b}-${a}` : `${dmy[3]}-${a}-${b}`;
}

const amount = '(?:[A-Z]{3}\\s*|[₡$€]\\s*)?([0-9][0-9., ]*)';
function labeledAmount(text, label) {
  const line = text.match(new RegExp('(?:^|\\n)\\s*(?:' + label + ')\\s*[:=]?\\s*' + amount + '\\s*(?:$|\\n)', 'i'));
  return line ? decimal(line[1]) : '';
}

export function suggestFromText(text) {
  const dateLabel = text.match(/(?:fecha\s+(?:de\s+)?(?:emisi[oó]n|pago)|fecha\s+factura|invoice date|issue date|date issued|payout date|payment date)\s*[:=]?\s*([^\n]+)/i);
  const transfer = /retiro (?:bancario|a (?:tu |la )?cuenta bancaria)|withdrawal to (?:your |a )?bank|transfer to (?:your |a )?bank account/i.test(text);
  const affiliate = /(?:affiliate commission|affiliate payout|comisi[oó]n(?:es)? de afiliados|pago a afiliados)/i.test(text);
  const currencies = new Set(text.match(/\b(?:CRC|USD|EUR|CAD|GBP|MXN|JPY|AUD|PAB|CHF)\b/gi)?.map(code => code.toUpperCase()));
  if (text.includes('₡')) currencies.add('CRC');
  if (text.includes('€')) currencies.add('EUR');
  return {
    issue_date: dateLabel ? dateFromText(dateLabel[1]) : '',
    issuer: text.match(/(?:^|\n)\s*(?:emisor|proveedor|supplier|vendor|pagador|payer)\s*:\s*([^\n]+)/i)?.[1]?.trim() || '',
    direction: transfer ? 'transfer' : affiliate ? 'income' : '',
    category: transfer ? 'Retiro de PayPal al banco' : affiliate ? 'Comisiones de afiliados' : '',
    document_number: text.match(/(?:consecutivo|invoice\s*(?:number|no\.?|#)|factura\s*(?:n[uú]mero|n[°º]|#)|transaction id|id de transacci[oó]n)\s*[:=]?\s*([A-Z0-9][A-Z0-9/-]*)/i)?.[1] || '',
    document_key: text.match(/\b\d{50}\b/)?.[0] || '',
    currency: currencies.size === 1 ? [...currencies][0] : '',
    subtotal: labeledAmount(text, 'sub[ -]?total|total venta neta'),
    tax: labeledAmount(text, 'iva|vat|impuesto total|total impuesto|sales tax|tax'),
    total: labeledAmount(text, 'total(?: a pagar| comprobante| factura| pagado| due| amount)?|grand total|amount due|gross amount|monto bruto') ||
      (affiliate || transfer ? labeledAmount(text, 'payout amount|amount paid|monto pagado|importe del pago') : '')
  };
}

const affiliatePrograms = [
  [/(?:get\s*your\s*guide)/i, 'GetYourGuide'],
  [/\bviator\b|\bowl payments limited\b/i, 'Viator'],
  [/\bholafly\b/i, 'Holafly'], [/\bdiscover\s*cars\b/i, 'DiscoverCars'],
  [/\b12go\b/i, '12Go'], [/\bbookaway\b/i, 'Bookaway'],
  [/\brise\s*(?:&|and)\s*shield\b/i, 'Rise & Shield'], [/\bheymondo\b/i, 'Heymondo']
];

export function suggestAffiliateSettlement(text) {
  const { currency } = suggestFromText(text);
  const programs = affiliatePrograms.filter(([pattern]) => pattern.test(text));
  const date = text.match(/(?:^|\n)\s*(?:payout date|payment date|fecha (?:de )?(?:pago|liquidaci[oó]n))\s*[:=]?\s*([^\n]+)/i);
  const getId = label => text.match(new RegExp(String.raw`(?:^|\n)\s*(?:${label})\s*[:=#]?\s*([A-Z0-9][A-Z0-9./-]{2,89})\s*(?:$|\n)`, 'i'))?.[1] || '';
  const paypal = getId('paypal transaction id|id (?:de )?transacci[oó]n(?: de)? paypal') ||
    (/\bpaypal\b/i.test(text) ? getId('transaction id|id de transacci[oó]n') : '');
  return {
    issuer: programs.length === 1 ? programs[0][1] : '',
    issue_date: date ? dateFromText(date[1]) : '',
    currency,
    document_number: getId('(?:payout|remittance) (?:id|reference)|referencia (?:del pago|de liquidaci[oó]n)') || paypal,
    paypal_reference: /^[A-Z0-9-]{1,64}$/i.test(paypal) ? paypal.toUpperCase() : '',
    total: labeledAmount(text, 'gross (?:commission|amount|payout)|total commissions?|commission total|comisi[oó]n bruta|comisiones totales|monto bruto')
  };
}

let tesseractReady;
function tesseract() {
  if (globalThis.Tesseract) return Promise.resolve(globalThis.Tesseract);
  tesseractReady ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = ASSETS + 'tesseract.min.js';
    script.onload = () => resolve(globalThis.Tesseract);
    script.onerror = () => { tesseractReady = null; script.remove(); reject(new Error('OCR no disponible')); };
    document.head.append(script);
  });
  return tesseractReady;
}

async function createOcr() {
  const lib = await tesseract();
  return lib.createWorker(['spa', 'eng'], 1, {
    workerPath: ASSETS + 'worker.min.js', workerBlobURL: false,
    corePath: ASSETS + 'tesseract-core-lstm.wasm.js', langPath: ASSETS.replace(/\/$/, '')
  });
}

async function textFromPdf(file, interpret) {
  const pdf = await import(ASSETS + 'pdf.min.mjs');
  pdf.GlobalWorkerOptions.workerSrc = ASSETS + 'pdf.worker.min.mjs';
  const task = pdf.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, disableFontFace: true, useWasm: false });
  let worker;
  try {
    const document = await task.promise;
    const parts = [];
    const maxPages = Math.min(document.numPages, 8);
    let usedText = false;
    for (let i = 1; i <= maxPages; i++) {
      const page = await document.getPage(i);
      const items = (await page.getTextContent()).items;
      const text = items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join('').trim();
      if (text.length >= 45) {
        usedText = true;
        parts.push(text);
      } else {
        worker ||= await createOcr();
        const natural = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 1900 / Math.max(natural.width, natural.height)) });
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        try {
          await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
          parts.push((await worker.recognize(canvas)).data.text);
        } finally {
          canvas.width = canvas.height = 0;
        }
      }
      page.cleanup();
    }
    return { fields: interpret(parts.join('\n')), method: worker ? (usedText ? 'mixed' : 'ocr') : 'pdf_text', limited: document.numPages > maxPages };
  } finally {
    await Promise.allSettled([worker?.terminate(), task.destroy()]);
  }
}

export async function extractAccountingFile(file, { affiliate = false } = {}) {
  const interpret = affiliate ? suggestAffiliateSettlement : suggestFromText;
  const extension = file.name.split('.').pop().toLowerCase();
  if (extension === 'xml') return extractXml(await file.text());
  if (extension === 'pdf') return textFromPdf(file, interpret);
  const worker = await createOcr();
  try {
    const { data } = await worker.recognize(file);
    return { fields: interpret(data.text), method: 'ocr' };
  } finally {
    await worker.terminate();
  }
}

export async function prepareCameraPhoto(file) {
  if (/\.(?:jpe?g|png|webp)$/i.test(file.name) && file.size <= 3 * 1024 * 1024) return file;
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  try {
    const ratio = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.round(bitmap.width * ratio);
    canvas.height = Math.round(bitmap.height * ratio);
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!jpeg) throw new Error('No se pudo preparar la foto');
    return new File([jpeg], 'foto-comprobante.jpg', { type: 'image/jpeg' });
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}
