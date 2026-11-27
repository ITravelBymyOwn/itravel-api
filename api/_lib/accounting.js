import { createHash } from 'node:crypto';
import { resolveSession } from './itbmo-foundation.js';
import { accountingFiscalProfile } from './accounting-fiscal.js';
import { parsePayPalActivity } from './accounting-paypal.js';
import { receiveImpactAction } from './accounting-impact.js';

const QA_PROJECT = 'https://gpfoqnnznncqisunmrlc.supabase.co';
const BUCKET = 'itbmo-accounting';
const MAX_BYTES = 3 * 1024 * 1024;
const CREATOR_CODE = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FISCAL = ['pending', 'eligible', 'ineligible', 'partial', 'not_applicable'];
const FILE_TYPES = {
  xml: ['application/xml', bytes => /^\s*(?:<\?xml\b[^]*?\?>\s*)?</i.test(bytes.toString('utf8', 0, 2048)) && !/<!doctype|<!entity/i.test(bytes.toString('utf8'))],
  pdf: ['application/pdf', bytes => bytes.subarray(0, 5).toString() === '%PDF-'],
  jpg: ['image/jpeg', bytes => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))],
  png: ['image/png', bytes => bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))],
  webp: ['image/webp', bytes => bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP']
};

class AccountingError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function requireValue(condition, code = 'INVALID_DOCUMENT') {
  if (!condition) throw new AccountingError(400, code);
}

export function accountingEnabled(env = process.env) {
  return env.ITBMO_ACCOUNTING_ENABLED === '1' && env.VERCEL_ENV === 'preview' &&
    env.VERCEL_GIT_COMMIT_REF === 'preview/accounting' &&
    env.SUPABASE_URL?.replace(/\/$/, '') === QA_PROJECT;
}

async function privateRequest(path, options = {}) {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new AccountingError(503, 'ACCOUNTING_UNAVAILABLE');
  const response = await fetch(QA_PROJECT + path, {
    ...options,
    headers: {
      apikey: key, ...(key.startsWith('eyJ') ? { Authorization: 'Bearer ' + key } : {}),
      'Content-Type': 'application/json', ...options.headers
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new AccountingError(502, 'ACCOUNTING_STORAGE_ERROR');
  if (response.status === 204) return null;
  const raw = await response.text();
  return raw ? JSON.parse(raw) : null;
}

const rest = (path, options) => privateRequest('/rest/v1' + path, options);

function field(value, size) {
  return typeof value === 'string' ? value.trim().slice(0, size) : '';
}

function money(value, required = false) {
  if (value == null || value === '') {
    requireValue(!required);
    return null;
  }
  requireValue(typeof value === 'string' && /^\d{1,13}(\.\d{1,5})?$/.test(value));
  return value;
}

function validDate(value) {
  const date = new Date(value + 'T00:00:00.000Z');
  return /^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function parseAccountingUpload(body) {
  const form = body.document || {};
  const date = field(form.issue_date, 11);
  const name = field(body.name, 160);
  const suffix = name.split('.').pop().toLowerCase();
  const extension = suffix === 'jpeg' ? 'jpg' : suffix;
  const type = Object.hasOwn(FILE_TYPES, extension) ? FILE_TYPES[extension] : null;
  requireValue(type && !/[\\/\x00-\x1f]/.test(name), 'INVALID_FILE_TYPE');
  requireValue(typeof body.file === 'string', 'INVALID_FILE');
  if (body.file.length > Math.ceil(MAX_BYTES / 3) * 4) throw new AccountingError(413, 'FILE_TOO_LARGE');
  requireValue(/^[A-Za-z0-9+/]+={0,2}$/.test(body.file) && body.file.length % 4 === 0, 'INVALID_FILE');
  const bytes = Buffer.from(body.file, 'base64');
  requireValue(bytes.length > 0 && bytes.length <= MAX_BYTES && type[1](bytes), 'INVALID_FILE');
  const issuer = field(form.issuer, 200);
  const currency = field(form.currency, 4).toUpperCase();
  const key = field(form.document_key, 51);
  const rate = money(form.exchange_rate);
  requireValue(validDate(date) && issuer && /^[A-Z]{3}$/.test(currency) && (!key || /^\d{50}$/.test(key)));
  requireValue(['expense', 'income', 'transfer'].includes(form.direction) &&
    ['invoice', 'receipt', 'credit_note', 'debit_note', 'other'].includes(form.document_kind) &&
    ['CR', 'foreign', 'pending'].includes(form.jurisdiction) &&
    FISCAL.includes(form.vat_treatment) && FISCAL.includes(form.income_tax_treatment) &&
    ['xml', 'pdf_text', 'ocr', 'mixed', 'manual'].includes(form.extraction_method) && (!rate || Number(rate) > 0));
  const metadata = {
    issue_date: date, issuer, currency, document_key: key || null,
    issuer_id: field(form.issuer_id, 50) || null,
    document_number: field(form.document_number, 90) || null,
    notes: field(form.notes, 800) || null, category: field(form.category, 100) || 'Pendiente',
    direction: form.direction, document_kind: form.document_kind, jurisdiction: form.jurisdiction,
    vat_treatment: form.vat_treatment, income_tax_treatment: form.income_tax_treatment,
    extraction_method: form.extraction_method, exchange_rate: rate,
    subtotal: money(form.subtotal), tax: money(form.tax), total: money(form.total, true),
    original_name: name, content_type: type[0], extension,
    byte_size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')
  };
  return { metadata, bytes };
}

const affiliatePrograms = {
  getyourguide: 'GetYourGuide', viator: 'Viator', viatorinc: 'Viator',
  viatorlimited: 'Viator', viatorsystemsptylimited: 'Viator', owlpaymentslimited: 'Viator',
  holafly: 'Holafly', discovercars: 'DiscoverCars', '12go': '12Go', bookaway: 'Bookaway',
  riseshield: 'Rise & Shield', riseandshield: 'Rise & Shield', heymondo: 'Heymondo'
};

export function parseAffiliateSettlement(body) {
  const form = body.document || {};
  const issuerInput = field(form.issuer, 151);
  const issuerKey = issuerInput.toLowerCase().replace(/[^a-z0-9]/g, '');
  const issuer = Object.hasOwn(affiliatePrograms, issuerKey) ? affiliatePrograms[issuerKey] : issuerInput.replace(/ +/g, ' ');
  const reference = field(form.document_number, 91);
  const paypal = field(form.paypal_reference, 65).toUpperCase();
  const currency = field(form.currency, 4).toUpperCase();
  const total = money(form.total, true);
  requireValue(issuer.length > 0 && issuerInput.length <= 150 && !/[\x00-\x1f]/.test(issuer) &&
    !/\b(?:omio|airalo|impact(?:\.com)?)\b/i.test(issuer) &&
    reference.length > 0 && reference.length <= 90 && !/[\x00-\x1f]/.test(reference) &&
    (!paypal || /^[A-Z0-9-]{1,64}$/.test(paypal)) && validDate(field(form.issue_date, 11)) &&
    /^[A-Z]{3}$/.test(currency) && Number(total) > 0 && form.confirmed === 'on', 'INVALID_AFFILIATE_SETTLEMENT');

  const document = {
    issue_date: form.issue_date, issuer, document_number: reference, currency, total,
    direction: 'income', document_kind: 'receipt', jurisdiction: 'pending',
    category: 'Comisiones de afiliados', vat_treatment: 'pending', income_tax_treatment: 'pending',
    notes: field(form.notes, 800) || null, extraction_method: 'manual'
  };
  if (body.file !== undefined) {
    requireValue(/\.(pdf|jpe?g|png|webp)$/i.test(body.name || ''), 'INVALID_FILE_TYPE');
    document.extraction_method = form.extraction_method;
    const parsed = parseAccountingUpload({ ...body, document });
    return { ...parsed, metadata: { ...parsed.metadata, affiliate_settlement: true, paypal_reference: paypal || null } };
  }
  return { metadata: { ...document, affiliate_settlement: true, paypal_reference: paypal || null } };
}

async function saveDocument(profileId, { metadata, bytes }) {
  const [reservation] = await rest('/rpc/itbmo_accounting_reserve', {
    method: 'POST', body: JSON.stringify({ p_profile: profileId, p_document: metadata })
  });
  if (reservation.outcome === 'duplicate') throw new AccountingError(409, 'DUPLICATE_DOCUMENT');
  if (reservation.outcome === 'quota') throw new AccountingError(409, 'ACCOUNTING_QUOTA');
  if (!['reserved', 'retry'].includes(reservation.outcome)) throw new AccountingError(403, 'ACCOUNTING_FORBIDDEN');

  if (!bytes) return { id: reservation.document_id };

  // Retrying the same bytes after an interruption reuses the reserved path and digest.
  await privateRequest(`/storage/v1/object/${BUCKET}/${reservation.object_path}`, {
    method: 'POST', headers: { 'Content-Type': metadata.content_type, 'x-upsert': 'true' }, body: bytes
  });
  await rest(`/accounting_documents?id=eq.${reservation.document_id}`, {
    method: 'PATCH', body: JSON.stringify({ ready: true })
  });
  return { id: reservation.document_id };
}

const SELECT_FIELDS = 'id,issue_date,direction,document_kind,jurisdiction,issuer,issuer_id,document_number,document_key,currency,subtotal::text,tax::text,total::text,exchange_rate::text,category,vat_treatment,income_tax_treatment,extraction_method,notes,original_name,byte_size,created_at,affiliate_settlement,paypal_reference';

function listPeriod(body, dateField, timeSuffix = '') {
  const year = Number(body.year);
  const month = Number(body.month || 0);
  const offset = Number(body.offset || 0);
  requireValue(Number.isInteger(year) && year >= 1900 && year <= 2199 &&
    Number.isInteger(month) && month >= 0 && month <= 12 &&
    Number.isSafeInteger(offset) && offset >= 0, 'INVALID_PERIOD');
  const start = `${year}-${String(month || 1).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(year, month || 12, 1)).toISOString().slice(0, 10);
  const query = new URLSearchParams({ limit: '101', offset: String(offset) });
  query.append(dateField, 'gte.' + start + timeSuffix);
  query.append(dateField, 'lt.' + end + timeSuffix);
  return query;
}

function listDocuments(body) {
  const query = listPeriod(body, 'issue_date');
  query.set('select', SELECT_FIELDS);
  query.set('ready', 'eq.true');
  query.set('order', 'issue_date.desc,id.asc');
  return rest('/accounting_documents?' + query);
}

function listBillingSales(body) {
  const query = listPeriod(body, 'paid_at', 'T00:00:00-06:00');
  query.set('select', 'payment_id,provider,capture_reference,paid_at,gross_amount::text,net_amount::text,vat_amount::text,currency,fiscal_status,delivery_status,document_type,regular_amount::text,promotion_code,creator_commission::text,creator_commission_reversed::text,itbmo_share::text,refund_amount::text,web_discount::text,code_discount::text');
  query.set('order', 'paid_at.desc,payment_id.asc');
  return rest('/accounting_sale_breakdown?' + query);
}

async function downloadDocument(body) {
  requireValue(typeof body.id === 'string' && UUID.test(body.id), 'INVALID_DOCUMENT');
  const [document] = await rest(`/accounting_documents?id=eq.${body.id}&ready=eq.true&select=storage_path`);
  if (!document?.storage_path) throw new AccountingError(404, 'DOCUMENT_NOT_FOUND');
  const signed = await privateRequest(`/storage/v1/object/sign/${BUCKET}/${document.storage_path}`, {
    method: 'POST', body: JSON.stringify({ expiresIn: 60 })
  });
  const url = new URL('/storage/v1' + signed.signedURL, QA_PROJECT);
  if (url.origin !== QA_PROJECT || !url.pathname.startsWith('/storage/v1/object/sign/' + BUCKET + '/')) {
    throw new AccountingError(502, 'ACCOUNTING_STORAGE_ERROR');
  }
  url.searchParams.set('download', 'true');
  return { url: url.href };
}

export function parseCreatorPayment(body) {
  const code = field(body.code, 41).toUpperCase();
  const amount = field(body.amount, 15);
  const reference = field(body.reference, 91);
  const date = field(body.date, 11);
  requireValue(CREATOR_CODE.test(code) && /^\d{1,8}(\.\d{1,2})?$/.test(amount) &&
    validDate(date) && ['bank', 'paypal', 'other'].includes(body.method) &&
    reference && reference.length <= 90 && !/[\x00-\x1f\x7f]/.test(reference) &&
    body.confirmed === 'on', 'INVALID_CREATOR_PAYMENT');
  const [units, decimals = ''] = amount.split('.');
  const cents = Number(units) * 100 + Number(decimals.padEnd(2, '0'));
  requireValue(cents > 0 && cents <= 2147483647, 'INVALID_CREATOR_PAYMENT');
  return { p_code: code, p_amount: cents, p_date: date, p_method: body.method, p_reference: reference };
}

export default async function accounting(req, res, impactPostback = false) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (!accountingEnabled()) return res.status(404).json({ ok: false, code: 'ACCOUNTING_UNAVAILABLE' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED' });
  try {
    if (impactPostback) {
      const { status, code } = await receiveImpactAction(req, rest);
      return res.status(status).json(code ? { ok: false, code } : { ok: true });
    }
    const rawToken = String(req.headers?.authorization || '').match(/^Bearer ([0-9a-f]{64})$/i)?.[1];
    const session = await resolveSession(rawToken);
    if (session?.auth_level !== 'supabase_auth') throw new AccountingError(401, 'ACCOUNTING_SIGN_IN');
    const [member] = await rest(`/accounting_members?select=profile_id,profiles!inner(email_verified,account_status)&profile_id=eq.${session.user_id}&enabled=eq.true&profiles.email_verified=eq.true&profiles.account_status=eq.active`);
    if (!member) throw new AccountingError(403, 'ACCOUNTING_FORBIDDEN');
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) || {};
    let result;
    switch (body.action) {
      case 'list': {
        const rows = await listDocuments(body);
        result = { documents: rows.slice(0, 100), more: rows.length > 100, fiscal_profile: accountingFiscalProfile };
        break;
      }
      case 'upload': result = await saveDocument(session.user_id, parseAccountingUpload(body)); break;
      case 'affiliate_settlement': result = await saveDocument(session.user_id, parseAffiliateSettlement(body)); break;
      case 'creator_balance': {
        const code = field(body.code, 41).toUpperCase();
        requireValue(CREATOR_CODE.test(code), 'INVALID_CREATOR_PAYMENT');
        const creator = await rest('/rpc/itbmo_accounting_creator_balance', {
          method: 'POST', body: JSON.stringify({ p_code: code })
        });
        if (!creator) throw new AccountingError(404, 'CREATOR_CODE_NOT_FOUND');
        result = { creator };
        break;
      }
      case 'creator_payment': {
        const recorded = await rest('/rpc/itbmo_accounting_record_creator_payment', {
          method: 'POST', body: JSON.stringify({ p_profile: session.user_id, ...parseCreatorPayment(body) })
        });
        if (recorded?.outcome === 'forbidden') throw new AccountingError(403, 'ACCOUNTING_FORBIDDEN');
        if (recorded?.outcome === 'unknown_code') throw new AccountingError(404, 'CREATOR_CODE_NOT_FOUND');
        if (recorded?.outcome === 'reference_conflict') throw new AccountingError(409, 'CREATOR_REFERENCE_CONFLICT');
        if (recorded?.outcome === 'insufficient_balance') throw new AccountingError(409, 'CREATOR_BALANCE_CHANGED');
        if (!['recorded', 'existing'].includes(recorded?.outcome)) throw new AccountingError(400, 'INVALID_CREATOR_PAYMENT');
        result = { id: recorded.id, duplicate: recorded.outcome === 'existing' };
        break;
      }
      case 'journal': {
        const query = listPeriod(body, 'entry_date');
        query.set('select', 'entry_id,entry_date,source,description,reference,currency,amount::text,direction,category,review_status');
        query.set('order', 'entry_date.desc,entry_id.asc');
        const rows = await rest('/accounting_journal?' + query);
        result = { entries: rows.slice(0, 100), more: rows.length > 100 };
        break;
      }
      case 'paypal_import': {
        let entries;
        try { entries = parsePayPalActivity(body.csv, body.date_format); }
        catch { throw new AccountingError(400, 'INVALID_PAYPAL_CSV'); }
        const stored = entries.length ? await rest('/accounting_paypal_movements?on_conflict=reference&select=reference', {
          method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
          body: JSON.stringify(entries.map(entry => ({ ...entry, imported_by: session.user_id })))
        }) : [];
        result = { imported: stored.length, duplicates: entries.length - stored.length };
        break;
      }
      case 'billing_sales': {
        const rows = await listBillingSales(body);
        result = { sales: rows.slice(0, 100), more: rows.length > 100 };
        break;
      }
      case 'billing_review': {
        requireValue(typeof body.id === 'string' && UUID.test(body.id) && typeof body.evidence === 'string' &&
          body.evidence.trim().length >= 5 && body.evidence.trim().length <= 500 &&
          ['domestic', 'export'].includes(body.treatment) && ['01', '04', '09'].includes(body.document_type),
        'INVALID_BILLING_REVIEW');
        const reviewed = await rest('/rpc/itbmo_review_billing_sale', {
          method: 'POST', body: JSON.stringify({
            p_payment: body.id, p_treatment: body.treatment, p_type: body.document_type,
            p_evidence: body.evidence.trim(), p_profile: session.user_id
          })
        });
        if (!reviewed) throw new AccountingError(409, 'INVALID_BILLING_REVIEW');
        result = {};
        break;
      }
      case 'download': result = await downloadDocument(body); break;
      default: throw new AccountingError(400, 'UNKNOWN_ACTION');
    }
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    const status = error instanceof AccountingError ? error.status : error instanceof SyntaxError ? 400 : 502;
    return res.status(status).json({ ok: false, code: error instanceof AccountingError ? error.message : 'ACCOUNTING_REQUEST_FAILED' });
  }
}
