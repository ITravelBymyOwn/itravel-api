import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const REST_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1` : '';

export const FOUNDATION_EVENT_NAMES = new Set([
  'view_home','planner_open','planner_started','guest_started','sign_up','login',
  'trip_configuration_started','destinations_saved','checkout_started','checkout_opened',
  'purchase','payment_approved','payment_cancelled','payment_failed',
  'generation_started','generation_completed','itinerary_generated',
  'workspace_opened','city_workspace_opened','partner_offer_view','partner_offer_click',
  'affiliate_click','trip_shared','trip_reopened','new_trip_started','new_planning_started',
  'export_pdf','export_csv','export_receipt','info_chat_question','start_chat'
]);

const ALLOWED_EVENT_PROPERTIES = new Set([
  'language','city_count','days_total','payment_provider','currency','generation_mode',
  'partner','partner_name','placement','destination','queries_used','queries_remaining',
  'file_type','error_stage','campaign_id','campaign_key','channel','source','medium',
  'content','creator','referral','landing_page','first_touch_source','last_touch_source'
]);

export function sanitizeEventName(value='') {
  const name = String(value || '').trim().toLowerCase();
  return FOUNDATION_EVENT_NAMES.has(name) ? name : '';
}

export function sanitizeProperties(input={}) {
  const clean = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!ALLOWED_EVENT_PROPERTIES.has(key) || value === undefined || value === null) continue;
    if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'boolean') clean[key] = value;
    else clean[key] = String(value).slice(0, 160);
  }
  return clean;
}

function headers(extra={}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra
  };
}

export async function supabaseFetch(path, options={}) {
  if (!REST_URL || !SUPABASE_SECRET_KEY) throw new Error('SUPABASE_NOT_CONFIGURED');
  const response = await fetch(`${REST_URL}${path}`, { ...options, headers: headers(options.headers || {}) });
  if (!response.ok) {
    const text = await response.text().catch(()=>'');
    const error = new Error(`Supabase request failed (${response.status})`);
    error.status = response.status;
    error.data = text;
    throw error;
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export function hashSessionToken(rawToken='') {
  return crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
}

export async function resolveSession(rawToken='') {
  const token = String(rawToken || '').trim();
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const rows = await supabaseFetch(
    `/user_sessions?select=id,user_id,auth_level,expires_at,revoked_at&token_hash=eq.${encodeURIComponent(tokenHash)}&limit=1`
  );
  const session = Array.isArray(rows) ? rows[0] : null;
  if (!session || session.revoked_at) return null;
  if (session.expires_at && new Date(session.expires_at).getTime() <= Date.now()) return null;
  return session;
}

export function newEventId() {
  return crypto.randomUUID();
}
