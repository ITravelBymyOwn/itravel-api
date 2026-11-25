import { resolveSession, supabaseFetch } from './itbmo-foundation.js';

const codePattern = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;
const projectUrl = 'https://gpfoqnnznncqisunmrlc.supabase.co';

export function isCreatorSandbox(env) {
  return env.VERCEL_ENV === 'preview' &&
    env.SUPABASE_URL?.replace(/\/$/, '') === projectUrl && env.PAYPAL_ENV === 'sandbox';
}

export async function creatorPortal(req, res, body) {
  res.setHeader('Cache-Control', 'no-store');

  // This pilot must not return creator data from an inherited production database.
  if (!isCreatorSandbox(process.env)) {
    return res.status(404).json({ ok: false, code: 'CREATOR_PORTAL_UNAVAILABLE' });
  }

  const session = await resolveSession(body.session_token);
  if (session?.auth_level !== 'supabase_auth') {
    return res.status(401).json({ ok: false, code: 'REGISTERED_SESSION_REQUIRED' });
  }

  const isAdmin = session.user_id === process.env.ITBMO_ADMIN_USER_ID;
  if (body.action === 'creator_summary') {
    const summary = await supabaseFetch('/rpc/itbmo_creator_summary', {
      method: 'POST',
      body: JSON.stringify({ p_profile: session.user_id, p_environment: 'sandbox' })
    });
    return summary || isAdmin
      ? res.status(200).json({ ok: true, summary, is_admin: isAdmin })
      : res.status(403).json({ ok: false, code: 'CREATOR_ACCESS_REQUIRED' });
  }

  if (!isAdmin) {
    return res.status(403).json({ ok: false, code: 'ADMIN_ACCESS_REQUIRED' });
  }

  const code = String(body.code || '').trim().toUpperCase();
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const payoutEmail = String(body.payout_email || '').trim().toLowerCase();
  const discount = Number(body.discount);
  const commission = Number(body.commission);
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!codePattern.test(code) || !name || name.length > 100 ||
      !emailPattern.test(email) || !emailPattern.test(payoutEmail) ||
      email.length > 254 || payoutEmail.length > 254 ||
      !Number.isSafeInteger(discount) || discount < 1 || discount > 99 ||
      !Number.isSafeInteger(commission) || commission < 1 || commission > 798) {
    return res.status(400).json({ ok: false, code: 'INVALID_CREATOR_AGREEMENT' });
  }

  try {
    const result = await supabaseFetch('/rpc/itbmo_create_creator', {
      method: 'POST',
      body: JSON.stringify({
        p_code: code, p_name: name, p_email: email, p_payout_email: payoutEmail,
        p_discount: discount, p_commission_cents: commission
      })
    });
    return result
      ? res.status(201).json({ ok: true, code })
      : res.status(409).json({ ok: false, code: 'VERIFIED_PROFILE_OR_MARGIN_REQUIRED' });
  } catch (error) {
    if (error.status === 409) return res.status(409).json({ ok: false, code: 'CREATOR_OR_CODE_EXISTS' });
    throw error;
  }
}
