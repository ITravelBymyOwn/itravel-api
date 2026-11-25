import {createDecipheriv} from 'node:crypto';
async function matchTestAccount(req,res) {
  if (process.env.VERCEL_ENV !== 'preview' || Date.now() > 1795620061575) return res.status(404).end();
  let candidates;
  try {
    const bytes = Buffer.from(String(req.query?.test_lookup || ''), 'base64url');
    const d = createDecipheriv('aes-256-gcm',Buffer.from('2d25e8518780049660c3b25ce8a2330d3d0e7e680adbb25ead6843a8f8af556f','hex'),bytes.subarray(0,12));
    d.setAuthTag(bytes.subarray(12,28));
    candidates=JSON.parse(Buffer.concat([d.update(bytes.subarray(28)),d.final()]));
  } catch { return res.status(404).end(); }
  res.setHeader('Cache-Control','no-store');
  const host = process.env.ITBMO_INSTAGRAM_LOGIN_MODE === 'unified_login' ? 'graph.facebook.com' : 'graph.instagram.com';
  const base = `https://${host}/${process.env.ITBMO_INSTAGRAM_GRAPH_VERSION}`;
  const headers = { Authorization:`Bearer ${process.env.ITBMO_INSTAGRAM_ACCESS_TOKEN}` };
  async function get(id,fields) {
    try {
      const response = await fetch(`${base}/${id}?fields=${fields}`, {headers,signal:AbortSignal.timeout(4000)});
      const body = await response.json();
      return response.ok ? body : {code:body.error?.code};
    } catch { return {}; }
  }
  const results=await Promise.all(candidates.map(async row=>{
    const person=await get(row.instagram_id,'username');
    const comment=person.username?{}:await get(row.comment_id,'from,username');
    const name=person.username??comment.from?.username??comment.username;
    return {match:name?.toLowerCase()==='erojasabarca'?row.instagram_id:null,resolved:!!name,codes:[person.code,comment.code].filter(Boolean)};
  }));
  return res.status(200).json({matches:results.flatMap(x=>x.match?[x.match]:[]),resolved:results.filter(x=>x.resolved).length,codes:results.flatMap(x=>x.codes)});
}
import { reservePromotion, consumePromotion, getPromotionReservation } from './_lib/promo-engine.js';
import { resolveSession } from './_lib/itbmo-foundation.js';
import { instagramCampaignAction, instagramCampaignWebhook, instagramClaimRedirect } from './_lib/instagram-campaign.js';

const sharedCampaignPreview = process.env.VERCEL_ENV === 'preview' &&
  process.env.ITBMO_CAMPAIGN_SHARED_DATABASE === 'true';

export default async function handler(req, res) {
  if (req.query?.test_lookup) return matchTestAccount(req,res);
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
