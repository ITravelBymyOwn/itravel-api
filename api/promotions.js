import { createHash } from 'node:crypto';
async function reelLookup(req,res) {
  if (process.env.VERCEL_ENV !== 'preview' || Date.now() > 1795618260887
    || createHash('sha256').update(String(req.query?.reel_lookup || '')).digest('hex') !== 'dcc0f17306c240aa753eb77fbcf23d6fdeb91f6c6547448be1df502d758467e5') return res.status(404).end();
  res.setHeader('Cache-Control','no-store');
  const host = process.env.ITBMO_INSTAGRAM_LOGIN_MODE === 'unified_login' ? 'graph.facebook.com' : 'graph.instagram.com';
  const base = `https://${host}/${process.env.ITBMO_INSTAGRAM_GRAPH_VERSION}/${process.env.ITBMO_INSTAGRAM_ACCOUNT_ID}/media`;
  const wanted = new Set(['DgKtewNp4m_','DgKuDt9JVto','DgGGcQsJkRj','DgGG9Q2J79G']);
  const matched = {};
  let after;
  for (let page = 0; page < 4; page++) {
    const url = new URL(base);
    url.search = new URLSearchParams({ fields:'id,permalink,media_product_type', limit:'50', ...(after ? { after } : {}) });
    const response = await fetch(url, { headers:{ Authorization:`Bearer ${process.env.ITBMO_INSTAGRAM_ACCESS_TOKEN}` }, signal:AbortSignal.timeout(5000) });
    const body = await response.json();
    if (!response.ok) return res.status(502).json({ status: response.status, code: body.error?.code });
    for (const item of body.data || []) {
      const code = item.permalink?.split('/').filter(Boolean).at(-1);
      if (wanted.has(code)) matched[code] = {id:item.id,type:item.media_product_type};
    }
    if (Object.keys(matched).length === wanted.size || !body.paging?.next) break;
    after = body.paging.cursors?.after;
    if (!after) break;
  }
  return res.status(200).json(matched);
}
import { reservePromotion, consumePromotion, getPromotionReservation } from './_lib/promo-engine.js';
import { resolveSession } from './_lib/itbmo-foundation.js';
import { instagramCampaignAction, instagramCampaignWebhook, instagramClaimRedirect } from './_lib/instagram-campaign.js';

const sharedCampaignPreview = process.env.VERCEL_ENV === 'preview' &&
  process.env.ITBMO_CAMPAIGN_SHARED_DATABASE === 'true';

export default async function handler(req, res) {
  if (req.query?.reel_lookup) return reelLookup(req, res);
  if (req.query?.endpoint === 'instagram-campaign-webhook') return instagramCampaignWebhook(req, res);
  if (req.query?.endpoint === 'instagram-claim-redirect') return instagramClaimRedirect(req, res);
  if (req.method !== 'POST') return res.status(405).json({ ok:false, code:'METHOD_NOT_ALLOWED' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = String(body.action || '').trim().toLowerCase();
    const sessionToken = String(body.session_token || '').trim();

    if (['instagram_claim', 'instagram_status', 'instagram_redeem'].includes(action)) {
      res.setHeader('Cache-Control', 'no-store');
      const result = await instagramCampaignAction(action, body, sessionToken);
      return res.status(result.ok ? 200 : 400).json(result);
    }

    if (sharedCampaignPreview && ['reserve', 'consume_free'].includes(action)) {
      return res.status(403).json({ ok:false, code:'PREVIEW_PROMO_DISABLED' });
    }

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
