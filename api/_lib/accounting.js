import { createHash } from 'node:crypto';
import { resolveSession } from './itbmo-foundation.js';
import { accountingFiscalProfile } from './accounting-fiscal.js';

const QA_PROJECT = 'https://gpfoqnnznncqisunmrlc.supabase.co';
const BUCKET = 'itbmo-accounting';
const MAX_BYTES = 3 * 1024 * 1024;
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
  requireValue(['expense', 'income'].includes(form.direction) &&
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

async function saveDocument(profileId, body) {
  const { metadata, bytes } = parseAccountingUpload(body);
  const [reservation] = await rest('/rpc/itbmo_accounting_reserve', {
    method: 'POST', body: JSON.stringify({ p_profile: profileId, p_document: metadata })
  });
  if (reservation.outcome === 'duplicate') throw new AccountingError(409, 'DUPLICATE_DOCUMENT');
  if (reservation.outcome === 'quota') throw new AccountingError(409, 'ACCOUNTING_QUOTA');
  if (!['reserved', 'retry'].includes(reservation.outcome)) throw new AccountingError(403, 'ACCOUNTING_FORBIDDEN');

  // Retrying the same bytes after an interruption reuses the reserved path and digest.
  await privateRequest(`/storage/v1/object/${BUCKET}/${reservation.object_path}`, {
    method: 'POST', headers: { 'Content-Type': metadata.content_type, 'x-upsert': 'true' }, body: bytes
  });
  await rest(`/accounting_documents?id=eq.${reservation.document_id}`, {
    method: 'PATCH', body: JSON.stringify({ ready: true })
  });
  return { id: reservation.document_id };
}

const SELECT_FIELDS = 'id,issue_date,direction,document_kind,jurisdiction,issuer,issuer_id,document_number,document_key,currency,subtotal::text,tax::text,total::text,exchange_rate::text,category,vat_treatment,income_tax_treatment,extraction_method,notes,original_name,byte_size,created_at';

function listDocuments(body) {
  const year = Number(body.year);
  const month = Number(body.month || 0);
  const offset = Number(body.offset || 0);
  requireValue(Number.isInteger(year) && year >= 1900 && year <= 2199 &&
    Number.isInteger(month) && month >= 0 && month <= 12 &&
    Number.isSafeInteger(offset) && offset >= 0, 'INVALID_PERIOD');
  const start = `${year}-${String(month || 1).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(year, month || 12, 1)).toISOString().slice(0, 10);
  const query = new URLSearchParams({ select: SELECT_FIELDS, ready: 'eq.true', order: 'issue_date.desc,id.asc', limit: '101', offset: String(offset) });
  query.append('issue_date', 'gte.' + start);
  query.append('issue_date', 'lt.' + end);
  return rest('/accounting_documents?' + query);
}

async function downloadDocument(body) {
  requireValue(typeof body.id === 'string' && UUID.test(body.id), 'INVALID_DOCUMENT');
  const [document] = await rest(`/accounting_documents?id=eq.${body.id}&ready=eq.true&select=storage_path`);
  if (!document) throw new AccountingError(404, 'DOCUMENT_NOT_FOUND');
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

export default async function accounting(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (!accountingEnabled()) return res.status(404).json({ ok: false, code: 'ACCOUNTING_UNAVAILABLE' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED' });
  try {
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
      case 'upload': result = await saveDocument(session.user_id, body); break;
      case 'download': result = await downloadDocument(body); break;
      default: throw new AccountingError(400, 'UNKNOWN_ACTION');
    }
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    const status = error instanceof AccountingError ? error.status : error instanceof SyntaxError ? 400 : 502;
    return res.status(status).json({ ok: false, code: error instanceof AccountingError ? error.message : 'ACCOUNTING_REQUEST_FAILED' });
  }
}
