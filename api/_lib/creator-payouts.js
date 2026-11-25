import { createHash, timingSafeEqual } from 'node:crypto';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const batchId = /^[A-Z0-9]{1,50}$/i;
const balanceView = '/creator_payout_balances';
const table = '/creator_payouts';
const payoutEndpoint = '/v1/payments/payouts';
const hash = input => createHash('sha256').update(input).digest();

export function canOperateCreatorPayouts(authorization, env, paypalEnvironment) {
  const secret = env.ITBMO_CREATOR_PAYOUT_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 ||
      !timingSafeEqual(hash(String(authorization || '')), hash('Bearer ' + secret)) ||
      env.ITBMO_CREATOR_PAYOUTS_ENABLED !== 'true') return false;

  if (paypalEnvironment === 'sandbox') {
    const qaUrl = env.ITBMO_CREATOR_PAYOUT_QA_SUPABASE_URL;
    return env.VERCEL_ENV === 'preview' && Boolean(qaUrl) && qaUrl === env.SUPABASE_URL;
  }
  return paypalEnvironment === 'live' && env.VERCEL_ENV === 'production' &&
    env.ITBMO_CREATOR_LIVE_PAYOUTS_ENABLED === 'true';
}

export function paypalPayoutPayload(payout) {
  return {
    sender_batch_header: { sender_batch_id: payout.id, email_subject: 'ITBMO creator commission' },
    items: [{
      recipient_type: 'EMAIL',
      receiver: payout.recipient,
      amount: { value: (payout.amount_cents / 100).toFixed(2), currency: payout.currency },
      sender_item_id: payout.id
    }]
  };
}

function itemState(item) {
  switch (item.transaction_status) {
    case 'SUCCESS': return 'paid';
    case 'RETURNED':
    case 'REFUNDED': return 'returned';
    case 'FAILED':
    case 'DENIED':
    case 'BLOCKED': return 'failed';
    default: return 'processing';
  }
}

export async function creatorPayoutAction(body, { database, paypal, environment }) {
  const action = body.action;
  if (action === 'creator_payout_balances') {
    const rows = await database(`${balanceView}?select=creator_id,creator_code,display_name,currency,pending_cents,payable_cents&paypal_environment=eq.${environment}&order=creator_code&limit=500`);
    return { ok: true, balances: rows };
  }

  if (action === 'creator_payout_prepare') {
    if (!uuid.test(body.creator_id || '') || !Number.isSafeInteger(body.amount_cents) ||
        body.amount_cents <= 0 || body.amount_cents > 2147483647) return { ok: false, code: 'INVALID_AMOUNT_OR_CREATOR' };
    const row = await database('/rpc/itbmo_prepare_creator_payout', {
      method: 'POST',
      body: JSON.stringify({ p_creator: body.creator_id, p_environment: environment, p_amount_cents: body.amount_cents })
    });
    if (!row) return { ok: false, code: 'PAYOUT_BALANCE_CHANGED_OR_UNAVAILABLE' };
    return { ok: true, payout_id: row.id, state: row.state, amount_cents: row.amount_cents };
  }

  if (!uuid.test(body.payout_id || '')) return { ok: false, code: 'INVALID_PAYOUT' };
  const path = `${table}?id=eq.${body.payout_id}&paypal_environment=eq.${environment}`;
  const rows = await database(path + '&limit=1');
  const payout = rows?.[0];
  if (!payout) return { ok: false, code: 'PAYOUT_NOT_FOUND' };

  async function patch(stateFilter, fields) {
    return database(path + stateFilter, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(fields)
    });
  }

  if (action === 'creator_payout_submit') {
    if (payout.provider_batch_id) return { ok: true, state: payout.state };
    if (payout.state === 'submitting') return { ok: false, code: 'PAYOUT_OUTCOME_NEEDS_RECONCILIATION' };
    if (payout.state !== 'prepared' || body.amount_cents !== payout.amount_cents) {
      return { ok: false, code: 'PAYOUT_NOT_APPROVED_FOR_AMOUNT' };
    }
    // Before sending a live batch, reconcile refunds/disputes and recipient details.
    // This version deliberately does not transmit live funds from the payout endpoint.
    if (environment !== 'sandbox') return { ok: false, code: 'LIVE_RECONCILIATION_REQUIRED' };

    const reserved = await database('/rpc/itbmo_start_creator_payout', {
      method: 'POST',
      body: JSON.stringify({ p_payout: payout.id, p_environment: environment, p_amount_cents: payout.amount_cents })
    });
    if (!reserved) return { ok: false, code: 'PAYOUT_BALANCE_CHANGED_OR_UNAVAILABLE' };
    const result = await paypal(payoutEndpoint, {
      method: 'POST',
      headers: { 'PayPal-Request-Id': payout.id },
      body: JSON.stringify(paypalPayoutPayload(reserved))
    });
    const providerId = result?.batch_header?.payout_batch_id;
    if (!batchId.test(providerId || '')) return { ok: false, code: 'PAYOUT_PROVIDER_ID_MISSING' };
    await patch('&state=eq.submitting', { provider_batch_id: providerId, state: 'processing' });
    return { ok: true, state: 'processing' };
  }

  if (action === 'creator_payout_reconcile' && batchId.test(payout.provider_batch_id || '')) {
    const details = await paypal(`${payoutEndpoint}/${payout.provider_batch_id}`);
    const item = details?.items?.find(value => value.payout_item?.sender_item_id === payout.id);
    if (!item) return { ok: true, state: payout.state };
    const state = itemState(item);
    if ((payout.state === 'paid' && state !== 'returned') ||
        ['failed','returned'].includes(payout.state)) return { ok: true, state: payout.state };
    await patch(`&state=eq.${payout.state}`, { state });
    return { ok: true, state };
  }
  return { ok: false, code: 'PAYOUT_ACTION_UNAVAILABLE' };
}
