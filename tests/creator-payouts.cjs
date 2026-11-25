const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../api/_lib/creator-payouts.js');
const id = '92981c8f-7c15-4b17-ae44-59d1bfd034d8';
const payout = { id, amount_cents: 2500, currency: 'USD', recipient: 'creator@example.com', state: 'prepared' };

test('payouts require the operator and an isolated Sandbox deployment', async () => {
  const { canOperateCreatorPayouts } = await load();
  const secret = 'example-secret-for-this-test-only-32';
  const env = {
    ITBMO_CREATOR_PAYOUT_SECRET: secret,
    ITBMO_CREATOR_PAYOUTS_ENABLED: 'true',
    ITBMO_CREATOR_PAYOUT_QA_SUPABASE_URL: 'qa',
    SUPABASE_URL: 'qa',
    VERCEL_ENV: 'preview'
  };
  assert.equal(canOperateCreatorPayouts('Bearer ' + secret, env, 'sandbox'), true);
  assert.equal(canOperateCreatorPayouts('Bearer ' + secret, { ...env, SUPABASE_URL: 'live' }, 'sandbox'), false);
  assert.equal(canOperateCreatorPayouts('Bearer ' + secret, env, 'live'), false);
  assert.equal(canOperateCreatorPayouts('Bearer wrong', env, 'sandbox'), false);
});

test('each payout submits the confirmed amount under a stable PayPal identifier', async () => {
  const { creatorPayoutAction } = await load();
  let row = { ...payout };
  const sent = [];
  const tools = {
    environment: 'sandbox',
    database: async (path, options) => {
      if (path === '/rpc/itbmo_start_creator_payout') {
        row.state = 'submitting';
        return row;
      }
      if (options?.method === 'PATCH') Object.assign(row, JSON.parse(options.body));
      return [row];
    },
    paypal: async (path, options) => {
      if (options) {
        sent.push(JSON.parse(options.body));
        assert.equal(options.headers['PayPal-Request-Id'], id);
        return { batch_header: { payout_batch_id: 'TESTBATCH' } };
      }
      return { items: [{ payout_item: { sender_item_id: id }, transaction_status: 'SUCCESS' }] };
    }
  };
  const submit = { action: 'creator_payout_submit', payout_id: id, amount_cents: 2500 };
  assert.equal((await creatorPayoutAction({ ...submit, amount_cents: 2400 }, tools)).ok, false);
  assert.equal((await creatorPayoutAction(submit, tools)).state, 'processing');
  assert.equal((await creatorPayoutAction(submit, tools)).state, 'processing');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sender_batch_header.sender_batch_id, id);
  assert.deepEqual(sent[0].items[0].amount, { value: '25.00', currency: 'USD' });
  assert.equal((await creatorPayoutAction({ action: 'creator_payout_reconcile', payout_id: id }, tools)).state, 'paid');
});
