const FIELD_NAMES = ['Date', 'Name', 'Status', 'Currency', 'Gross', 'Fee', 'Net', 'Transaction ID', 'Transaction Event Code'];

function parseCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false, closed = false;
  for (let index = 0; index <= text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === undefined) throw new Error('INVALID_PAYPAL_CSV');
      if (char === '"' && text[index + 1] === '"') { value += '"'; index++; }
      else if (char === '"') { quoted = false; closed = true; }
      else value += char;
    } else if (char === ',' || char === '\r' || char === '\n' || char === undefined) {
      row.push(value);
      value = '';
      closed = false;
      if (char !== ',') {
        if (row.some(cell => cell.trim())) rows.push(row);
        row = [];
        if (char === '\r' && text[index + 1] === '\n') index++;
      }
    } else if (char === '"' && !value && !closed) quoted = true;
    else if (closed || char === '"') throw new Error('INVALID_PAYPAL_CSV');
    else value += char;
  }
  return rows;
}

function normalizeDate(value, format) {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parts = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const date = iso ? value : parts ?
    [parts[3], ...(format === 'MDY' ? [parts[1], parts[2]] : [parts[2], parts[1]]).map(v => v.padStart(2, '0'))].join('-') : '';
  const parsed = new Date(date + 'T00:00:00Z');
  if (!/^(19|20|21)/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('INVALID_PAYPAL_CSV');
  }
  return date;
}

export function parsePayPalActivity(input, format) {
  if (typeof input !== 'string' || input.length > 1024 * 1024 || !['MDY', 'DMY'].includes(format)) {
    throw new Error('INVALID_PAYPAL_CSV');
  }
  const [header, ...rows] = parseCsv(input.replace(/^\uFEFF/, ''));
  if (!header || !rows.length || rows.length > 1000) throw new Error('INVALID_PAYPAL_CSV');
  const normalized = header.map(field => field.trim().toLowerCase());
  const fields = FIELD_NAMES.map(field => normalized.indexOf(field.toLowerCase()));
  if (fields.includes(-1) || new Set(normalized).size !== normalized.length) throw new Error('INVALID_PAYPAL_CSV');
  return rows.flatMap(row => {
    if (row.length !== header.length) throw new Error('INVALID_PAYPAL_CSV');
    const [date, counterparty, status, currency, gross, fee, net, reference, code] = fields.map(i => row[i].trim());
    if (!['completed', 'cleared'].includes(status.toLowerCase())) return [];
    const amount = /^-?\d{1,13}(\.\d{1,5})?$/;
    if (!/^[A-Z]{3}$/.test(currency) || !/^[A-Za-z0-9-]{1,64}$/.test(reference) ||
        !amount.test(gross) || !amount.test(fee) || !amount.test(net) || !/^T\d{4}$/.test(code)) {
      throw new Error('INVALID_PAYPAL_CSV');
    }
    return [{ movement_date: normalizeDate(date, format), counterparty: counterparty.slice(0, 200), currency,
      gross_amount: gross, fee_amount: fee, net_amount: net, reference, event_code: code }];
  });
}
