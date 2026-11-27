import { timingSafeEqual } from 'node:crypto';

export function normalizeImpactAction(action, id, observedAt) {
  const eventDate = new Date(action.EventDate);
  const state = String(action.State || '').toUpperCase();
  const amount = String(action.CurrentPayout ?? action.Payout ?? '');
  const currency = String(action.Currency || '').toUpperCase();
  const programId = String(action.CampaignId || '');
  const program = String(action.CampaignName || '').trim();
  if (String(action.Id) !== id || !Number.isFinite(eventDate.valueOf()) ||
      !['PENDING', 'APPROVED', 'REVERSED'].includes(state) ||
      !/^-?\d{1,13}(\.\d{1,5})?$/.test(amount) || !/^[A-Z]{3}$/.test(currency) ||
      !/^\d{1,20}$/.test(programId) || !program || program.length > 200) {
    throw new Error('Invalid Impact action');
  }
  const date = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Costa_Rica'
  }).formatToParts(eventDate);
  const day = Object.fromEntries(date.map(({ type, value }) => [type, value]));
  return {
    action_id: id, program_id: programId, program, event_date: day.year + '-' + day.month + '-' + day.day,
    currency, amount, source_state: state.toLowerCase(),
    observed_at: observedAt
  };
}

export async function receiveImpactAction(req, rest, env = process.env, fetcher = fetch) {
  const { ITBMO_IMPACT_ACCOUNT_SID: sid, ITBMO_IMPACT_AUTH_TOKEN: token,
    ITBMO_IMPACT_POSTBACK_SECRET: secret } = env;
  if (!sid || !token || !secret || secret.length < 32) return { status: 503, code: 'IMPACT_UNAVAILABLE' };
  const provided = Buffer.from(String(req.headers?.['x-itbmo-impact-secret'] || ''));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { status: 401, code: 'IMPACT_UNAUTHORIZED' };
  }
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const id = body?.action_id;
  if (typeof id !== 'string' || !/^\d+(?:\.\d+){1,4}$/.test(id) || id.length > 90) {
    return { status: 400, code: 'INVALID_IMPACT_ACTION' };
  }
  const observedAt = new Date().toISOString();
  const response = await fetcher('https://api.impact.com/Mediapartners/' +
    encodeURIComponent(sid) + '/Actions/' + encodeURIComponent(id), {
    headers: { Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64') },
    redirect: 'error', signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) return { status: 502, code: 'IMPACT_LOOKUP_FAILED' };
  const action = normalizeImpactAction(await response.json(), id, observedAt);
  await rest('/rpc/itbmo_accounting_save_impact_action', {
    method: 'POST', body: JSON.stringify({ p_action: action })
  });
  return { status: 200 };
}
