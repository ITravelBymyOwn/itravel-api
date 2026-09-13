import { resolveSession, supabaseFetch } from './itbmo-foundation.js';

const CURRENCY = 'USD';
const LAUNCH_PRICE = 2.99;
const REGULAR_PRICE = 5.99;

function clean(value, max = 160) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function upperCode(value) {
  return clean(value, 80).toUpperCase();
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

async function getProfile(userId) {
  const rows = await supabaseFetch(
    `/profiles?select=id,auth_user_id,email_verified,account_status&` +
    `id=eq.${encodeURIComponent(userId)}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getOwnedTrip(tripId, userId) {
  const rows = await supabaseFetch(
    `/trips?select=id,user_id,status&` +
    `id=eq.${encodeURIComponent(tripId)}&` +
    `user_id=eq.${encodeURIComponent(userId)}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

function promoError(error) {
  const raw = `${error?.data || ''} ${error?.message || ''}`;
  const known = [
    'PROMO_NOT_FOUND','PROMO_INACTIVE','PROMO_NOT_STARTED','PROMO_EXPIRED',
    'PROMO_REGISTERED_REQUIRED','PROMO_VERIFIED_REQUIRED','PROMO_CURRENCY_MISMATCH',
    'PROMO_EXHAUSTED','PROMO_USER_LIMIT','PROMO_IDENTITY_REQUIRED',
    'PROMO_REDEMPTION_NOT_FOUND','PROMO_REDEMPTION_INVALID','PROMO_RESERVATION_EXPIRED'
  ];
  return known.find(code => raw.includes(code)) || 'PROMO_UNAVAILABLE';
}

function normalizeReservation(row) {
  if (!row) return null;
  return {
    redemption_id: row.redemption_id,
    promo_code_id: row.promo_code_id,
    code: upperCode(row.code),
    promo_type: row.promo_type,
    discount_value: Number(row.discount_value || 0),
    base_amount: money(row.base_amount),
    discount_amount: money(row.discount_amount),
    final_amount: money(row.final_amount),
    currency: row.currency || CURRENCY,
    reservation_expires_at: row.reservation_expires_at || null,
    creator_id: row.creator_id || null,
    campaign_id: row.campaign_id || null,
    is_free: Number(row.final_amount || 0) <= 0
  };
}

export function commercePricing() {
  return {
    currency: CURRENCY,
    regular_price: money(REGULAR_PRICE),
    base_price: money(LAUNCH_PRICE)
  };
}

export async function reservePromotion({ session_token, trip_id, code }) {
  const session = await resolveSession(session_token);
  if (!session) return { ok: false, code: 'SESSION_REQUIRED' };

  const promoCode = upperCode(code);
  if (!promoCode) return { ok: false, code: 'PROMO_CODE_REQUIRED' };

  const [trip, profile] = await Promise.all([
    getOwnedTrip(clean(trip_id, 100), session.user_id),
    getProfile(session.user_id)
  ]);

  if (!trip) return { ok: false, code: 'TRIP_NOT_FOUND' };

  const isRegistered = String(session.auth_level || '') === 'supabase_auth' || Boolean(profile?.auth_user_id);
  const isVerified = Boolean(profile?.email_verified);

  try {
    const rows = await supabaseFetch('/rpc/itbmo_reserve_promo', {
      method: 'POST',
      body: JSON.stringify({
        p_code: promoCode,
        p_user_id: session.user_id,
        p_trip_id: trip.id,
        p_session_id: session.id,
        p_base_amount: LAUNCH_PRICE,
        p_currency: CURRENCY,
        p_is_registered: isRegistered,
        p_is_verified: isVerified
      })
    });

    const reservation = normalizeReservation(Array.isArray(rows) ? rows[0] || null : null);
    if (!reservation) return { ok: false, code: 'PROMO_UNAVAILABLE' };

    if (reservation.creator_id || reservation.campaign_id || reservation.promo_code_id) {
      try {
        const tokenRows = await supabaseFetch(
          `/attributions?select=id&session_id=eq.${encodeURIComponent(session.id)}&order=updated_at.desc&limit=1`
        );
        const attribution = Array.isArray(tokenRows) ? tokenRows[0] || null : null;
        if (attribution?.id) {
          await supabaseFetch(`/attributions?id=eq.${encodeURIComponent(attribution.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              campaign_id: reservation.campaign_id,
              creator_id: reservation.creator_id,
              promo_code_id: reservation.promo_code_id,
              updated_at: new Date().toISOString()
            })
          });
        }
      } catch (error) {
        console.error('ITBMO promo attribution update warning', error);
      }
    }

    return { ok: true, reservation };
  } catch (error) {
    return { ok: false, code: promoError(error) };
  }
}

export async function getPromotionReservation({ redemption_id, session, trip_id }) {
  if (!redemption_id || !session?.user_id || !trip_id) return null;
  const rows = await supabaseFetch(
    `/promo_redemptions?select=id,promo_code_id,user_id,trip_id,status,base_amount,discount_amount,final_amount,currency,reservation_expires_at&` +
    `id=eq.${encodeURIComponent(redemption_id)}&` +
    `user_id=eq.${encodeURIComponent(session.user_id)}&` +
    `trip_id=eq.${encodeURIComponent(trip_id)}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function consumePromotion({ redemption_id, session, trip_id }) {
  try {
    const rows = await supabaseFetch('/rpc/itbmo_consume_promo', {
      method: 'POST',
      body: JSON.stringify({
        p_redemption_id: redemption_id,
        p_user_id: session.user_id,
        p_trip_id: trip_id
      })
    });
    const row = Array.isArray(rows) ? rows[0] || null : null;
    return row ? { ok: true, redemption: row } : { ok: false, code: 'PROMO_REDEMPTION_NOT_FOUND' };
  } catch (error) {
    return { ok: false, code: promoError(error) };
  }
}

export async function findConsumedPromoEntitlement(tripId, userId) {
  if (!tripId || !userId) return null;
  const rows = await supabaseFetch(
    `/promo_redemptions?select=id,promo_code_id,discount_amount,final_amount,currency,consumed_at,status&` +
    `trip_id=eq.${encodeURIComponent(tripId)}&` +
    `user_id=eq.${encodeURIComponent(userId)}&` +
    `status=eq.consumed&final_amount=eq.0&order=consumed_at.desc&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function promoCodeForRedemption(redemption) {
  if (!redemption?.promo_code_id) return null;
  const rows = await supabaseFetch(
    `/promo_codes?select=id,code,promo_type,creator_id,campaign_id&id=eq.${encodeURIComponent(redemption.promo_code_id)}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}
