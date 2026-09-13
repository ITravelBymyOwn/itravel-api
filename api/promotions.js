import { reservePromotion, consumePromotion, getPromotionReservation } from './_lib/promo-engine.js';
import { resolveSession } from './_lib/itbmo-foundation.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok:false, code:'METHOD_NOT_ALLOWED' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = String(body.action || '').trim().toLowerCase();
    const sessionToken = String(body.session_token || '').trim();

    if (action === 'reserve') {
      const result = await reservePromotion({
        session_token: sessionToken,
        trip_id: body.trip_id,
        code: body.code
      });
      return res.status(result.ok ? 200 : 400).json(result);
    }

    if (action === 'consume_free') {
      const session = await resolveSession(sessionToken);
      if (!session) return res.status(401).json({ ok:false, code:'SESSION_REQUIRED' });
      const tripId = String(body.trip_id || '').trim();
      const redemption = await getPromotionReservation({
        redemption_id: body.redemption_id,
        session,
        trip_id: tripId
      });
      if (!redemption || redemption.status !== 'reserved' || Number(redemption.final_amount) > 0) {
        return res.status(400).json({ ok:false, code:'PROMO_REDEMPTION_INVALID' });
      }
      if (redemption.reservation_expires_at && new Date(redemption.reservation_expires_at).getTime() <= Date.now()) {
        return res.status(400).json({ ok:false, code:'PROMO_RESERVATION_EXPIRED' });
      }
      const result = await consumePromotion({
        redemption_id: body.redemption_id,
        session,
        trip_id: tripId
      });
      return res.status(result.ok ? 200 : 400).json(result);
    }

    return res.status(400).json({ ok:false, code:'UNKNOWN_ACTION' });
  } catch (error) {
    console.error('ITBMO promotions endpoint error', error);
    return res.status(500).json({ ok:false, code:'PROMOTIONS_SERVICE_ERROR' });
  }
}
