const assert = require('node:assert/strict');
const { test } = require('node:test');

const accounting = import('../api/_lib/accounting.js');
const extraction = import('../public/assets/js/itbmo-accounting-extract.mjs');

const qa = {
  ITBMO_ACCOUNTING_ENABLED: '1', VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: 'preview/accounting', SUPABASE_URL: 'https://gpfoqnnznncqisunmrlc.supabase.co'
};

test('accounting requires opt-in, its own Preview branch and the isolated QA database', async () => {
  const { accountingEnabled } = await accounting;
  assert.equal(accountingEnabled(qa), true);
  for (const change of [{ ITBMO_ACCOUNTING_ENABLED: '0' }, { VERCEL_ENV: 'production' },
    { VERCEL_GIT_COMMIT_REF: 'preview/creator-affiliates' }, { SUPABASE_URL: 'https://production.example' }]) {
    assert.equal(accountingEnabled({ ...qa, ...change }), false);
  }
});

test('accounting preserves the issue date and decimal amounts and rejects mismatched uploads', async () => {
  const { parseAccountingUpload } = await accounting;
  const bytes = Buffer.from('<?xml version="1.0"?><FacturaElectronica/>');
  const input = {
    name: 'compra.xml', file: bytes.toString('base64'),
    document: {
      issue_date: '2024-02-29', issuer: 'Proveedor de prueba', currency: 'USD', total: '100.01001',
      direction: 'expense', document_kind: 'invoice', jurisdiction: 'CR',
      vat_treatment: 'pending', income_tax_treatment: 'ineligible', extraction_method: 'xml'
    }
  };
  const result = parseAccountingUpload(input);
  assert.equal(result.metadata.issue_date, '2024-02-29');
  assert.equal(result.metadata.total, '100.01001');
  assert.equal(result.metadata.sha256.length, 64);
  assert.throws(() => parseAccountingUpload({ ...input, name: 'compra.pdf' }), { message: 'INVALID_FILE' });
  assert.throws(() => parseAccountingUpload({ ...input, document: { ...input.document, issue_date: '2026-02-29' } }), { message: 'INVALID_DOCUMENT' });
  assert.throws(() => parseAccountingUpload({ ...input, file: Buffer.from('<!DOCTYPE a><a/>').toString('base64') }), { message: 'INVALID_FILE' });
});

test('document suggestions distinguish total from subtotal and leave ambiguous currency and dates empty', async () => {
  const { suggestFromText } = await extraction;
  const receipt = suggestFromText('Emisor: Compañía Ejemplo\nFecha de emisión: 24/11/2026\nSubtotal: ₡ 1.000,25\nIVA: ₡130,00\nTotal a pagar: ₡1.130,25');
  assert.equal(receipt.issue_date, '2026-11-24');
  assert.equal(receipt.currency, 'CRC');
  assert.equal(receipt.subtotal, '1000.25');
  assert.equal(receipt.tax, '130.00');
  assert.equal(receipt.total, '1130.25');
  const ambiguous = suggestFromText('Invoice date: 02/03/2026\nTotal: $14.00');
  assert.equal(ambiguous.issue_date, '');
  assert.equal(ambiguous.currency, '');
  assert.equal(ambiguous.total, '14.00');
});

test('Impact postbacks read commission and state from the provider, using the same key for reversals', async () => {
  const { receiveImpactAction } = await import('../api/_lib/accounting-impact.js');
  const secret = 'a'.repeat(32);
  const env = {
    ITBMO_IMPACT_ACCOUNT_SID: 'publisher', ITBMO_IMPACT_AUTH_TOKEN: 'test-token',
    ITBMO_IMPACT_POSTBACK_SECRET: secret
  };
  const req = { body: { action_id: '10.20.30', payout: '5000' }, headers: { 'x-itbmo-impact-secret': secret } };
  const saved = [];
  const rest = async (path, options) => {
    assert.equal(path, '/rpc/itbmo_accounting_save_impact_action');
    saved.push(JSON.parse(options.body).p_action);
  };
  const fetcher = state => async (url, options) => {
    assert.equal(url, 'https://api.impact.com/Mediapartners/publisher/Actions/10.20.30');
    assert.equal(options.redirect, 'error');
    return Response.json({
      Id: '10.20.30', CampaignId: '10', CampaignName: 'Demo', Amount: '125.50',
      CurrentPayout: '8.759', Payout: '9.000', Currency: 'USD',
      EventDate: '2026-11-01T03:15:00Z', State: state
    });
  };
  const denied = await receiveImpactAction({ ...req, headers: {} }, rest, env, () => assert.fail('unauthorized lookup'));
  assert.equal(denied.status, 401);
  assert.equal((await receiveImpactAction(req, rest, env, fetcher('APPROVED'))).status, 200);
  assert.equal((await receiveImpactAction(req, rest, env, fetcher('REVERSED'))).status, 200);
  assert.equal(saved[0].event_date, '2026-10-31');
  assert.equal(saved[0].amount, '8.759');
  assert.equal(saved[0].source_state, 'approved');
  assert.equal(saved[1].action_id, saved[0].action_id);
  assert.equal(saved[1].source_state, 'reversed');
});
