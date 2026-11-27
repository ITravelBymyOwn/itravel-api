import { resolveSession, supabaseFetch } from './itbmo-foundation.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const codePattern = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;
const projectUrl = 'https://gpfoqnnznncqisunmrlc.supabase.co';

export function isCreatorPreview(env) {
  return env.VERCEL_ENV === 'preview' &&
    env.VERCEL_GIT_COMMIT_REF === 'preview/creator-affiliates';
}

export function isCreatorQaDatabase(env) {
  return isCreatorPreview(env) && env.SUPABASE_URL?.replace(/\/$/, '') === projectUrl;
}

export function isCreatorSandbox(env) {
  return isCreatorQaDatabase(env) && env.PAYPAL_ENV === 'sandbox';
}

export async function creatorPortal(req, res, body) {
  res.setHeader('Cache-Control', 'no-store');

  // This pilot must not return creator data from an inherited production database.
  if (!isCreatorQaDatabase(process.env)) {
    return res.status(404).json({ ok: false, code: 'CREATOR_PORTAL_UNAVAILABLE' });
  }

  const session = await resolveSession(body.session_token);
  if (session?.auth_level !== 'supabase_auth') {
    return res.status(401).json({ ok: false, code: 'REGISTERED_SESSION_REQUIRED' });
  }

  const isAdmin = ['creator_summary', 'creator_create'].includes(body.action) &&
    await supabaseFetch('/rpc/itbmo_accounting_admin', {
      method: 'POST', body: JSON.stringify({ p_profile: session.user_id })
    }) === true;
  if (body.action === 'creator_summary') {
    const summary = await supabaseFetch('/rpc/itbmo_creator_summary', {
      method: 'POST',
      body: JSON.stringify({ p_profile: session.user_id, p_environment: 'sandbox' })
    });
    return res.status(200).json({ ok: true, summary, is_admin: isAdmin });
  }

  if (body.action === 'creator_payment_history') {
    const before = body.before;
    const id = body.before_id;
    if (typeof before !== 'string' || before.length > 40 || !Number.isFinite(Date.parse(before)) ||
        typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) {
      return res.status(400).json({ ok: false, code: 'INVALID_HISTORY_CURSOR' });
    }
    const rows = await supabaseFetch('/rpc/itbmo_creator_payment_history', {
      method: 'POST',
      body: JSON.stringify({ p_profile: session.user_id, p_environment: 'sandbox', p_before: before, p_before_id: id })
    });
    return res.status(200).json({ ok: true, payments: rows.slice(0, 24), more: rows.length > 24 });
  }

  if (body.action === 'creator_enroll') {
    const name = String(body.name || '').trim();
    const payoutEmail = String(body.payout_email || '').trim().toLowerCase();
    if (!name || name.length > 100 || !emailPattern.test(payoutEmail) || payoutEmail.length > 254) {
      return res.status(400).json({ ok: false, code: 'INVALID_CREATOR_AGREEMENT' });
    }
    const code = await supabaseFetch('/rpc/itbmo_enroll_creator', {
      method: 'POST',
      body: JSON.stringify({ p_profile: session.user_id, p_name: name, p_payout_email: payoutEmail })
    });
    return code
      ? res.status(200).json({ ok: true, code })
      : res.status(409).json({ ok: false, code: 'CREATOR_ENROLLMENT_UNAVAILABLE' });
  }

  if (!isAdmin) {
    return res.status(403).json({ ok: false, code: 'ADMIN_ACCESS_REQUIRED' });
  }

  const code = String(body.code || '').trim().toUpperCase();
  const operation = body.operation || 'create';
  const mode = body.discount_mode || 'percentage';
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const payoutEmail = String(body.payout_email || '').trim().toLowerCase();
  const discount = String(body.discount || '').trim();
  const commission = String(body.commission || '').trim();
  if (!codePattern.test(code) || !['create', 'edit'].includes(operation) ||
      !['percentage', 'fixed'].includes(mode) || !/^\d{1,6}(\.\d{1,2})?$/.test(discount) ||
      !/^\d{1,6}(\.\d{1,2})?$/.test(commission) ||
      (operation === 'create' && (!name || name.length > 100 ||
        !emailPattern.test(email) || !emailPattern.test(payoutEmail) || email.length > 254 || payoutEmail.length > 254))) {
    return res.status(400).json({ ok: false, code: 'INVALID_CREATOR_AGREEMENT' });
  }
  const [units, fraction = ''] = commission.split('.');
  const result = await supabaseFetch('/rpc/itbmo_admin_creator_deal', {
    method: 'POST',
    body: JSON.stringify({
      p_admin: session.user_id, p_code: code, p_mode: mode, p_discount: discount,
      p_commission_cents: Number(units) * 100 + Number(fraction.padEnd(2, '0')),
      p_name: operation === 'create' ? name : null,
      p_email: operation === 'create' ? email : null,
      p_payout_email: operation === 'create' ? payoutEmail : null
    })
  });
  if (result?.outcome === 'saved') return res.status(200).json({ ok: true, ...result });
  const errors = {
    forbidden: [403, 'ADMIN_ACCESS_REQUIRED'], not_found: [404, 'CREATOR_CODE_NOT_FOUND'],
    exists: [409, 'CREATOR_OR_CODE_EXISTS'], account_required: [409, 'VERIFIED_PROFILE_OR_MARGIN_REQUIRED']
  };
  const [status, error] = errors[result?.outcome] || [400, 'INVALID_CREATOR_AGREEMENT'];
  return res.status(status).json({ ok: false, code: error });
}
