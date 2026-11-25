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

  const isAdmin = session.user_id === process.env.ITBMO_ADMIN_USER_ID;
  if (body.action === 'creator_summary') {
    const summary = await supabaseFetch('/rpc/itbmo_creator_summary', {
      method: 'POST',
      body: JSON.stringify({ p_profile: session.user_id, p_environment: 'sandbox' })
    });
    return res.status(200).json({ ok: true, summary, is_admin: isAdmin });
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
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const payoutEmail = String(body.payout_email || '').trim().toLowerCase();
  const discount = Number(body.discount);
  const commission = Number(body.commission);
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
