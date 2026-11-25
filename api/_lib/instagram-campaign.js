import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveSession, supabaseFetch } from './itbmo-foundation.js';
import { commercePricing } from './promo-engine.js';

const HOUR = 3_600_000;
const CLAIM_LINK_HOURS = 24;
const MAX_BODY = 256_000;
const instagramId = /^[0-9]{1,40}$/;
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
const claimToken = /^([\da-f-]{36})\.(\d{13})\.([a-zA-Z0-9_-]{43})$/;
const graphHosts = new Map([
  ['instagram_login', 'graph.instagram.com'],
  ['unified_login', 'graph.facebook.com']
]);
const campaignCopy = {
  es: {
    link: `¡Gracias por participar! ✈️ Sigue a @itravelbymyown. Abre este enlace en las próximas ${CLAIM_LINK_HOURS} horas para activar tu itinerario gratis:`,
    recovery: 'Aquí tienes tu enlace para activar el itinerario gratis. Sigue a @itravelbymyown y úsalo antes de que venza el plazo original:',
    claimButton: 'Canjear itinerario'
  },
  en: {
    link: `Thanks for participating! ✈️ Follow @itravelbymyown. Open this link within ${CLAIM_LINK_HOURS} hours to activate your free itinerary:`,
    recovery: 'Here is your link to activate your free itinerary. Follow @itravelbymyown and use it before the original deadline:',
    claimButton: 'Claim free itinerary'
  }
};

function environment() {
  const value = process.env.VERCEL_ENV || 'preview';
  return process.env.ITBMO_INSTAGRAM_CAMPAIGN_ENABLED === 'true' &&
    ['preview', 'production'].includes(value) ? value : null;
}

function webhookConfig() {
  const config = {
    environment: environment(),
    account: process.env.ITBMO_INSTAGRAM_ACCOUNT_ID,
    accessToken: process.env.ITBMO_INSTAGRAM_ACCESS_TOKEN,
    appSecret: process.env.ITBMO_INSTAGRAM_APP_SECRET,
    verifyToken: process.env.ITBMO_INSTAGRAM_VERIFY_TOKEN,
    signingKey: process.env.ITBMO_INSTAGRAM_CLAIM_SECRET,
    version: process.env.ITBMO_INSTAGRAM_GRAPH_VERSION,
    graphHost: graphHosts.get(process.env.ITBMO_INSTAGRAM_LOGIN_MODE ?? 'instagram_login'),
    origin: process.env.ITBMO_INSTAGRAM_CAMPAIGN_ORIGIN
  };
  if (!config.environment || !instagramId.test(config.account || '') || !config.accessToken ||
      !config.appSecret || !config.verifyToken || !(config.signingKey?.length >= 32) ||
      !/^v\d+\.0$/.test(config.version || '') || !config.graphHost || !config.origin) return null;
  try {
    const origin = new URL(config.origin);
    if (origin.protocol !== 'https:' || origin.origin !== config.origin) return null;
  } catch { return null; }
  return config;
}

function hmac(value, key, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding);
}

function equal(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function countMentions(text, author) {
  const excluded = new Set(['itravelbymyown', String(author || '').toLowerCase()]);
  const matches = String(text || '').matchAll(/(?:^|[^\p{L}\p{N}_.@])@([a-z0-9_](?:[a-z0-9._]{0,28}[a-z0-9_])?)(?![\p{L}\p{N}_]|\.[a-z0-9_.])/giu);
  return new Set(Array.from(matches, match => match[1].toLowerCase()).filter(name => !excluded.has(name))).size;
}

async function instagramRequest(config, path, body) {
  const response = await fetch(`https://${config.graphHost}/${config.version}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) {
    const error = new Error(`Instagram API: ${response.status}`);
    error.instagramError = (await response.json().catch(() => null))?.error;
    throw error;
  }
  return response.json();
}

async function sendClaimMessage(config, recipient, message) {
  const sent = await instagramRequest(config, `${config.account}/messages`, { recipient, message });
  if (typeof sent?.message_id !== 'string' || !sent.message_id) {
    throw new Error('INSTAGRAM_CLAIM_MESSAGE_NOT_ACKNOWLEDGED');
  }
}

async function sendClaimButton(config, recipient, copy, url) {
  await sendClaimMessage(config, recipient, {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'button',
        text: `${copy.link}\n\n${url}`,
        buttons: [{ type: 'web_url', title: copy.claimButton, url }]
      }
    }
  });
}

function claimLink(config, participation, language, expiry) {
  const value = `${participation.id}.${expiry}`;
  const token = `${value}.${hmac(value, config.signingKey, 'base64url')}`;
  return `${config.origin}/c/${language}/${token}`;
}

function campaignPlannerPath(language, offer) {
  const query = new URLSearchParams({
    lang: language,
    utm_source: 'instagram',
    utm_medium: 'dm',
    utm_campaign: 'itbmo_instagram_itineraries',
    utm_content: `${offer}_${language}`
  });
  return `/planner.html?${query}`;
}

export function instagramClaimRedirect(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
  const { language, token } = req.query;
  if ((language !== 'es' && language !== 'en') ||
      typeof token !== 'string' || !claimToken.test(token)) return res.status(404).end();
  res.setHeader('Location', `${campaignPlannerPath(language, 'free')}#itbmo_campaign=${token}`);
  return res.status(302).end();
}

async function getSetting(campaignId, scope) {
  const rows = await supabaseFetch(`/instagram_campaign_settings?select=campaign_id,campaigns(status,starts_at,ends_at)&campaign_id=eq.${campaignId}&environment=eq.${scope}&limit=1`);
  return rows?.[0]?.campaigns;
}

function campaignIsOpen(campaign, moment = Date.now()) {
  return campaign?.status === 'active' && Date.parse(campaign.starts_at) <= moment &&
    (campaign.ends_at == null || moment < Date.parse(campaign.ends_at));
}

function patchParticipation(query, data) {
  return supabaseFetch(`/instagram_campaign_participation?${query}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(data)
  });
}

async function withOutboundLease(row, filter, delivery) {
  const now = new Date().toISOString();
  const lease = new Date(Date.now() + 30_000).toISOString();
  const rows = await patchParticipation(
    `id=eq.${row.id}&or=(outbound_lease_until.is.null,outbound_lease_until.lt.${encodeURIComponent(now)})&${filter}`,
    { outbound_lease_until: lease }
  );
  if (!rows?.length) {
    const latest = await supabaseFetch(`/instagram_campaign_participation?id=eq.${row.id}&${filter}&limit=1`);
    if (latest?.length) throw new Error('DELIVERY_IN_PROGRESS');
    return;
  }
  const locked = rows[0];
  const condition = `id=eq.${row.id}&outbound_lease_until=eq.${encodeURIComponent(lease)}`;
  try {
    const patch = await delivery(locked, condition);
    await patchParticipation(condition, { ...patch, outbound_lease_until: null });
  } catch (error) {
    await patchParticipation(condition, { outbound_lease_until: null });
    throw error;
  }
}

async function isCampaignSoldOut(campaignId, scope) {
  const offers = await supabaseFetch(
    `/itbmo_offer_settings?select=campaign_id&environment=eq.${scope}&campaign_id=eq.${campaignId}&limit=1`
  );
  if (!offers?.length) return false;

  const settings = await supabaseFetch(
    `/instagram_campaign_settings?select=quota&campaign_id=eq.${campaignId}&environment=eq.${scope}&limit=1`
  );
  const quota = settings?.[0]?.quota;
  if (!Number.isInteger(quota) || quota < 1) return false;

  // Current offer and claim RPCs both count granted entries against the quota.
  const entries = await supabaseFetch(
    `/instagram_campaign_participation?select=id&campaign_id=eq.${campaignId}&granted_at=not.is.null&order=granted_at.asc,id.asc&offset=${quota - 1}&limit=1`
  );
  return Boolean(entries?.length);
}

function soldOutMessage(origin, language, { regular_price, base_price }) {
  const price = `US$${Number(base_price).toFixed(2)}`;
  const discount = Math.round(100 * (regular_price - base_price) / regular_price);
  const link = `${origin}${campaignPlannerPath(language, 'sold_out')}`;
  const es = language === 'es';
  const intro = es
    ? '¡Gracias por participar! ✈️ Ya se agotaron los itinerarios gratuitos de esta campaña.'
    : 'Thanks for participating! ✈️ All free itineraries for this campaign have been claimed.';
  const offer = discount > 0
    ? (es ? `Crea tu itinerario por ${price} y ahorra ${discount} % sobre el precio regular.`
      : `Create your itinerary for ${price} and save ${discount}% off the regular price.`)
    : (es ? `Puedes crear tu itinerario por ${price}.` : `You can create your itinerary for ${price}.`);
  return `${intro} ${offer}\n\n${link}`;
}

async function handleComment(config, comment, eventTime) {
  const actor = comment?.from?.id;
  const media = comment?.media?.id;
  const commentId = comment?.id;
  if (comment?.parent_id || actor === config.account ||
      ![actor, media, commentId].every(value => typeof value === 'string' && instagramId.test(value)) ||
      countMentions(comment.text, comment.from.username) < 2) return;

  const reels = await supabaseFetch(`/instagram_campaign_reels?select=campaign_id,language,test_keyword&environment=eq.${config.environment}&media_id=eq.${media}&limit=1`);
  const reel = reels?.[0];
  if (!reel || (reel.test_keyword && !String(comment.text).split(/\s+/).some(
    word => word.toUpperCase() === reel.test_keyword.toUpperCase()))) return;
  const pricing = await commercePricing();
  // A different active offer means the comment belongs to an earlier campaign.
  if (pricing.campaign_id && pricing.campaign_id !== reel.campaign_id) return;
  const campaign = await getSetting(reel.campaign_id, config.environment);
  if (!campaignIsOpen(campaign) || !campaignIsOpen(campaign, eventTime)) return;
  const soldOut = !pricing.campaign_id;
  if (soldOut && !await isCampaignSoldOut(reel.campaign_id, config.environment)) return;

  await supabaseFetch('/instagram_campaign_participation?on_conflict=campaign_id,instagram_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify({ campaign_id: reel.campaign_id, instagram_id: actor, comment_id: commentId, language: reel.language })
  });
  const rows = await supabaseFetch(`/instagram_campaign_participation?campaign_id=eq.${reel.campaign_id}&instagram_id=eq.${actor}&limit=1`);
  const row = rows?.[0];
  if (!row || row.link_sent_at || row.user_id) return;
  // The old flow may already have used the private reply for this comment.
  if (row.intro_sent_at && row.comment_id === commentId) return;
  await withOutboundLease(row, 'link_sent_at=is.null&user_id=is.null', async (locked, condition) => {
    if (locked.intro_sent_at && locked.comment_id === commentId) return {};
    if (soldOut) {
      const text = soldOutMessage(config.origin, reel.language, pricing);
      await sendClaimMessage(config, { comment_id: commentId }, { text });
      return { comment_id: commentId, language: reel.language, intro_sent_at: new Date().toISOString() };
    }
    const expiry = Date.parse(locked.link_expires_at) > Date.now() ?
      Date.parse(locked.link_expires_at) : Date.now() + CLAIM_LINK_HOURS * HOUR;
    await patchParticipation(condition, { link_expires_at: new Date(expiry).toISOString() });
    const link = claimLink(config, locked, reel.language, expiry);
    await sendClaimMessage(config, { comment_id: commentId }, {
      text: `${campaignCopy[reel.language].link}\n\n${link}`
    });
    const sentAt = new Date().toISOString();
    return { comment_id: commentId, language: reel.language, intro_sent_at: sentAt, link_sent_at: sentAt };
  });
}

async function handleRecovery(config, event) {
  const actor = event?.sender?.id;
  const message = event?.message;
  if (typeof actor !== 'string' || !instagramId.test(actor) || actor === config.account ||
      event?.recipient?.id !== config.account || message?.is_echo || message?.is_deleted ||
      typeof message?.mid !== 'string' || !message.mid || message.mid.length > 300 ||
      typeof message.text !== 'string' || !/^(ITINERARIO|ITINERARY)$/i.test(message.text.trim())) return;

  console.info('ITBMO Instagram claim recovery requested');
  // Meta can send the event time as seconds in a string or milliseconds in a number.
  const time = Number(event.timestamp);
  const timestamp = time < 1e12 ? time * 1000 : time;
  const now = Date.now();
  if (!Number.isSafeInteger(time) || timestamp > now || now - timestamp >= 24 * HOUR) {
    console.info('ITBMO Instagram claim recovery skipped: invalid or stale event time');
    return;
  }
  const { campaign_id: campaignId } = await commercePricing();
  if (!uuid.test(campaignId || '') || !campaignIsOpen(await getSetting(campaignId, config.environment))) {
    console.info('ITBMO Instagram claim recovery skipped: campaign unavailable');
    return;
  }

  const eligible = `user_id=is.null&link_expires_at=gt.${encodeURIComponent(new Date(now).toISOString())}`;
  const rows = await supabaseFetch(`/instagram_campaign_participation?campaign_id=eq.${campaignId}&instagram_id=eq.${actor}&${eligible}&limit=1`);
  const row = rows?.[0];
  if (!row) {
    console.info('ITBMO Instagram claim recovery skipped: no eligible link');
    return;
  }
  const marker = `recovery:${timestamp}:${message.mid}`;

  await withOutboundLease(row, eligible, async locked => {
    const lastTimestamp = Number(locked.last_message_id?.match(/^recovery:(\d+):/)?.[1]);
    const expiry = Date.parse(locked.link_expires_at);
    const copy = campaignCopy[locked.language];
    if (!copy || !(expiry > Date.now()) || lastTimestamp >= timestamp) return {};
    const link = claimLink(config, locked, locked.language, expiry);
    await sendClaimButton(config, { id: actor }, { ...copy, link: copy.recovery }, link);
    console.info('ITBMO Instagram claim recovery accepted by Meta');
    return { last_message_id: marker, link_sent_at: locked.link_sent_at || new Date().toISOString() };
  });
}

export async function instagramCampaignWebhook(req, res) {
  const verifyOnly = process.env.VERCEL_ENV === 'preview' &&
    process.env.ITBMO_INSTAGRAM_WEBHOOK_VERIFY_ONLY === 'true';
  const config = verifyOnly ? {
    appSecret: process.env.ITBMO_INSTAGRAM_APP_SECRET,
    verifyToken: process.env.ITBMO_INSTAGRAM_VERIFY_TOKEN
  } : webhookConfig();
  res.setHeader('Cache-Control', 'no-store');
  if (!config?.appSecret || !config?.verifyToken) return res.status(404).end();
  if (req.method === 'GET') {
    const query = req.query || {};
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (query['hub.mode'] !== 'subscribe' || typeof token !== 'string' ||
        !equal(token, config.verifyToken) || typeof challenge !== 'string' || !/^\d+$/.test(challenge)) {
      return res.status(403).end();
    }
    return res.status(200).send(challenge);
  }
  if (req.method !== 'POST') return res.status(405).end();
  const signature = req.headers['x-hub-signature-256'];
  if (typeof signature !== 'string' || !/^sha256=[\da-f]{64}$/.test(signature)) return res.status(403).end();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) return res.status(413).end();
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks);
  if (!equal(signature, `sha256=${hmac(raw, config.appSecret, 'hex')}`)) return res.status(403).end();
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).end(); }
  if (verifyOnly || payload?.object !== 'instagram' || !Array.isArray(payload.entry)) {
    return res.status(200).end();
  }
  try {
    for (const entry of payload.entry || []) {
      if (entry.id !== config.account) continue;
      const time = Number(entry.time);
      const eventTime = Number.isFinite(time) && time > 0 ? (time < 1e12 ? time * 1000 : time) : Date.now();
      if (Date.now() - eventTime < 7 * 24 * HOUR) {
        for (const event of entry.changes || []) {
          if (event.field === 'comments') await handleComment(config, event.value, eventTime);
          if (event.field === 'messages') await handleRecovery(config, event.value);
        }
        for (const event of entry.messaging || []) await handleRecovery(config, event);
      }
    }
    return res.status(200).end();
  } catch (error) {
    console.error('ITBMO Instagram campaign delivery failed', {
      message: error.message,
      graphCode: error.instagramError?.code,
      graphSubcode: error.instagramError?.error_subcode
    });
    return res.status(503).end();
  }
}

export async function instagramCampaignAction(action, body, sessionToken) {
  const scope = environment();
  if (!scope) return action === 'instagram_status' ? { ok: true, available: false } : { ok: false, code: 'CAMPAIGN_UNAVAILABLE' };
  const session = await resolveSession(sessionToken);
  if (!session || session.auth_level !== 'supabase_auth') {
    return action === 'instagram_status' ? { ok: true, available: false } : { ok: false, code: 'VERIFIED_ACCOUNT_REQUIRED' };
  }
  if (action === 'instagram_status') {
    const rows = await supabaseFetch(`/instagram_campaign_participation?select=benefit_expires_at,instagram_campaign_settings!inner(environment)&user_id=eq.${session.user_id}&instagram_campaign_settings.environment=eq.${scope}&redemption_id=is.null&benefit_expires_at=gt.${encodeURIComponent(new Date().toISOString())}&order=benefit_expires_at.asc&limit=1`);
    return { ok: true, available: Boolean(rows?.length), expires_at: rows?.[0]?.benefit_expires_at || null };
  }
  let result;
  if (action === 'instagram_claim') {
    const token = typeof body.token === 'string' ? body.token.match(claimToken) : null;
    const key = process.env.ITBMO_INSTAGRAM_CLAIM_SECRET;
    if (!token || !uuid.test(token[1]) || !(key?.length >= 32) ||
        !equal(token[3], hmac(`${token[1]}.${token[2]}`, key, 'base64url'))) {
      return { ok: false, code: 'LINK_INVALID' };
    }
    result = await supabaseFetch('/rpc/itbmo_instagram_campaign_claim', {
      method: 'POST',
      body: JSON.stringify({
        p_participation: token[1], p_link_expires_at: new Date(Number(token[2])).toISOString(),
        p_user: session.user_id, p_environment: scope
      })
    });
  } else {
    if (typeof body.trip_id !== 'string' || !uuid.test(body.trip_id)) return { ok: false, code: 'TRIP_UNAVAILABLE' };
    const price = await commercePricing();
    result = await supabaseFetch('/rpc/itbmo_instagram_campaign_redeem', {
      method: 'POST',
      body: JSON.stringify({
        p_user: session.user_id, p_session: session.id, p_trip: body.trip_id,
        p_environment: scope, p_base: price.regular_price, p_currency: price.currency
      })
    });
  }
  return { ...result, ok: ['CLAIMED', 'REDEEMED', 'TRIP_AUTHORIZED'].includes(result?.code) };
}
