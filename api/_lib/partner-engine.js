import crypto from 'crypto';
import { resolveSession, supabaseFetch } from './itbmo-foundation.js';

const SAFE_SLUGS = new Set(['holafly', 'omio', 'viator', 'getyourguide']);
const SIGNING_SECRET = String(
  process.env.PARTNER_CLICK_SIGNING_SECRET || process.env.SUPABASE_SECRET_KEY || ''
).trim();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const VIATOR_PID = 'P00318254';
const VIATOR_MCID = '42383';
const GYG_PARTNER_ID = '3FZWELC';

function clean(value, max = 240) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizeKey(value) {
  return clean(value, 240)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value) {
  return normalizeKey(value).replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
}

function campaignPart(value) {
  return slugify(value).slice(0, 60) || 'context';
}

function base64urlEncode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64urlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function allowedPartnerUrl(slug, rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (slug === 'viator') return host === 'www.viator.com' || host.endsWith('.viator.com');
    if (slug === 'getyourguide') return host === 'www.getyourguide.com' || host.endsWith('.getyourguide.com') || host === 'gyg.me';
    if (slug === 'omio') return host === 'omio.sjv.io' || host === 'www.omio.com' || host === 'www.omio.es';
    if (slug === 'holafly') return host === 'holafly.sjv.io' || host.endsWith('.holafly.com') || host === 'holafly.com';
    return false;
  } catch (_) {
    return false;
  }
}

function signPayload(payload) {
  if (!SIGNING_SECRET) throw new Error('PARTNER_SIGNING_SECRET_MISSING');
  if (!allowedPartnerUrl(payload?.partner_slug, payload?.url)) throw new Error('PARTNER_TARGET_NOT_ALLOWED');
  const body = base64urlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', SIGNING_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyPayload(token) {
  if (!SIGNING_SECRET) return null;
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) return null;
  const expected = crypto.createHmac('sha256', SIGNING_SECRET).update(body).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(base64urlDecode(body));
    const issuedAt = Number(payload?.iat || 0);
    if (!issuedAt || Date.now() - issuedAt > TOKEN_TTL_MS) return null;
    if (!allowedPartnerUrl(payload?.partner_slug, payload?.url)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function appendParams(url, params) {
  const parsed = new URL(url);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value) !== '') {
      parsed.searchParams.set(key, String(value));
    }
  });
  return parsed.toString();
}

function hasRequiredAttribution(slug, rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (slug === 'viator') {
      return url.searchParams.get('pid') === VIATOR_PID &&
        url.searchParams.get('mcid') === VIATOR_MCID &&
        url.searchParams.get('medium') === 'link' &&
        Boolean(url.searchParams.get('campaign'));
    }
    if (slug === 'getyourguide') {
      return url.searchParams.get('partner_id') === GYG_PARTNER_ID &&
        url.searchParams.get('utm_medium') === 'online_publisher' &&
        Boolean(url.searchParams.get('cmp'));
    }
    return true;
  } catch (_) {
    return false;
  }
}

export async function getPartner(slug) {
  if (!SAFE_SLUGS.has(slug)) return null;
  const rows = await supabaseFetch(
    `/travel_partners?select=id,slug,name,category,status,enabled,metadata&slug=eq.${encodeURIComponent(slug)}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function getOffer(slug, placement = '') {
  const partner = await getPartner(slug);
  if (!partner || !partner.enabled || partner.status !== 'approved') return null;
  const q = `/partner_offers?select=id,partner_id,offer_key,need_type,placement,title_es,title_en,description_es,description_en,target_url,confidence,enabled,metadata&partner_id=eq.${partner.id}&enabled=eq.true&limit=50`;
  const rows = await supabaseFetch(q);
  const offer = (Array.isArray(rows) ? rows : []).find(x => !placement || x.placement === placement) || null;
  return offer ? { ...offer, partner: { id: partner.id, slug: partner.slug, name: partner.name } } : null;
}

async function getContextTemplate(slug) {
  return getOffer(slug, 'city_contextual');
}

function searchQueryForNeed(need, city) {
  const entity = clean(need?.entity_name || need?.source_activity, 180);
  const safeCity = clean(city || need?.city, 120);
  if (entity) return [entity, safeCity].filter(Boolean).join(' ');

  const type = clean(need?.need_type, 80);
  if (!safeCity) return '';
  if (type === 'guided_tour_optional') return `${safeCity} tours experiences`;
  if (type === 'ticket_required' || type === 'reservation_recommended') return `${safeCity} tickets attractions`;
  return safeCity;
}

function trackingCampaign(need, city, language) {
  const entityPart = campaignPart(need?.entity_name || need?.source_activity || city);
  const typePart = campaignPart(need?.need_type || 'context');
  const langPart = language === 'en' ? 'en' : 'es';
  return `itbmo-${entityPart}-${typePart}-${langPart}`.slice(0, 120);
}

function contextualSearchUrl(slug, language, need, city) {
  const query = searchQueryForNeed(need, city);
  if (!query) return '';
  const campaign = trackingCampaign(need, city, language);

  if (slug === 'viator') {
    return appendParams('https://www.viator.com/searchResults/all', {
      text: query,
      pid: VIATOR_PID,
      mcid: VIATOR_MCID,
      medium: 'link',
      campaign
    });
  }

  if (slug === 'getyourguide') {
    return appendParams('https://www.getyourguide.com/s/', {
      q: query,
      partner_id: GYG_PARTNER_ID,
      utm_medium: 'online_publisher',
      cmp: campaign
    });
  }

  return '';
}

function contextualTitle(need, language) {
  const entity = clean(need?.entity_name || need?.source_activity || '', 180);
  const isTicket = ['ticket_required', 'reservation_recommended'].includes(need?.need_type);
  if (language === 'en') {
    if (isTicket) return entity ? `Tickets for ${entity}` : 'Tickets for this visit';
    return entity ? `Experiences for ${entity}` : 'Experiences for this plan';
  }
  if (isTicket) return entity ? `Entradas para ${entity}` : 'Entradas para esta visita';
  return entity ? `Experiencias para ${entity}` : 'Experiencias para este plan';
}

function contextualDescription(slug, language) {
  const provider = slug === 'viator' ? 'Viator' : 'GetYourGuide';
  if (language === 'en') {
    return `Explore ${provider} using the exact place and destination detected in your itinerary.`;
  }
  return `Explora ${provider} usando exactamente el lugar y destino detectados en tu itinerario.`;
}

function signResolvedOffer({ template, partner, targetUrl, placement, need, city, resolutionType, travelDate = '' }) {
  if (!hasRequiredAttribution(partner?.slug, targetUrl)) {
    throw new Error('PARTNER_ATTRIBUTION_PARAMS_MISSING');
  }
  const payload = {
    iat: Date.now(),
    offer_id: template.id,
    partner_id: partner.id,
    partner_slug: partner.slug,
    partner_name: partner.name,
    url: targetUrl,
    placement,
    need_id: clean(need?.id, 120),
    need_type: clean(need?.need_type, 80),
    entity_name: clean(need?.entity_name || need?.source_activity, 180),
    city: clean(city || need?.city, 160),
    travel_date: clean(travelDate || need?.travel_date || need?.date, 40),
    resolution_type: clean(resolutionType, 40)
  };
  return signPayload(payload);
}

async function resolveExperiencePartner(slug, needs, city, language) {
  const partner = await getPartner(slug);
  if (!partner || !partner.enabled || partner.status !== 'approved') return [];
  const template = await getContextTemplate(slug);
  if (!template) return [];

  const offers = [];
  const seen = new Set();

  for (const need of needs) {
    if (!['ticket_required', 'reservation_recommended', 'guided_tour_optional'].includes(need?.need_type)) continue;

    const targetUrl = contextualSearchUrl(slug, language, need, city);
    if (!targetUrl || !allowedPartnerUrl(slug, targetUrl)) continue;

    const placement = need?.need_type === 'guided_tour_optional' ? 'city_experiences' : 'city_tickets';
    const dedupeKey = `${slug}|${clean(need?.id,120)}|${targetUrl}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    offers.push({
      ...template,
      placement,
      title_es: contextualTitle(need, 'es'),
      title_en: contextualTitle(need, 'en'),
      description_es: contextualDescription(slug, 'es'),
      description_en: contextualDescription(slug, 'en'),
      target_url: undefined,
      confidence: 'medium',
      need_id: clean(need?.id, 120),
      need_type: clean(need?.need_type, 80),
      entity_name: clean(need?.entity_name || need?.source_activity, 180),
      city: clean(city || need?.city, 160),
      resolution_type: 'context_search',
      provider_entity_type: 'search',
      provider_entity_id: null,
      partner: { id: partner.id, slug: partner.slug, name: partner.name },
      offer_token: signResolvedOffer({
        template,
        partner,
        targetUrl,
        placement,
        need,
        city,
        resolutionType: 'context_search'
      })
    });
  }

  return offers;
}

async function getOwnedTripRoutes(tripId, userId) {
  if (!tripId || !userId) return [];
  const rows = await supabaseFetch(
    `/trips?select=id,user_id,destinations&` +
    `id=eq.${encodeURIComponent(tripId)}&` +
    `user_id=eq.${encodeURIComponent(userId)}&limit=1`
  );
  const trip = Array.isArray(rows) ? rows[0] || null : null;
  const destinations = (Array.isArray(trip?.destinations) ? trip.destinations : [])
    .map((item, index) => ({
      index,
      city: clean(item?.city, 160),
      baseDate: clean(item?.base_date || item?.baseDate, 40)
    }))
    .filter(item => item.city);

  return destinations.slice(0, -1).map((from, index) => {
    const to = destinations[index + 1];
    return {
      id: `route:${index}:${from.city}:${to.city}`,
      origin: from.city,
      destination: to.city,
      travel_date: to.baseDate || ''
    };
  });
}

function omioLanding(origin, destination, language) {
  const from = slugify(origin);
  const to = slugify(destination);
  if (!from || !to) return '';
  return language === 'en'
    ? `https://www.omio.com/travel/${from}/${to}`
    : `https://www.omio.es/viajes/${from}/${to}`;
}

function omioTrackedUrl(trackingBase, origin, destination, language) {
  const landing = omioLanding(origin, destination, language);
  if (!landing || !allowedPartnerUrl('omio', trackingBase)) return '';
  const url = new URL(trackingBase);
  url.searchParams.set('u', landing);
  return url.toString();
}

async function resolveOmioTripRoutes(tripId, userId, city, language) {
  const partner = await getPartner('omio');
  const template = await getOffer('omio', 'city_transport_contextual');
  if (!partner || !template) return [];

  const routes = await getOwnedTripRoutes(tripId, userId);
  const eligible = routes.filter(route => route.origin === clean(city, 160));
  const result = [];

  for (const route of eligible) {
    const targetUrl = omioTrackedUrl(clean(template.target_url, 1000), route.origin, route.destination, language);
    if (!targetUrl) continue;

    const routeLabel = `${route.origin} → ${route.destination}`;
    const need = {
      id: route.id,
      need_type: 'intercity_transport',
      entity_name: routeLabel,
      source_activity: routeLabel,
      city: route.origin,
      travel_date: route.travel_date,
      derived_by: 'trip_sequence'
    };

    result.push({
      ...template,
      placement: 'city_transport',
      title_es: routeLabel,
      title_en: routeLabel,
      description_es: 'Compara opciones de tren, bus y otras conexiones entre tus destinos principales.',
      description_en: 'Compare train, bus and other connections between your main trip destinations.',
      target_url: undefined,
      confidence: 'high',
      need_id: route.id,
      need_type: 'intercity_transport',
      entity_name: routeLabel,
      city: route.origin,
      travel_date: route.travel_date || null,
      resolution_type: 'trip_sequence_route',
      partner: { id: partner.id, slug: partner.slug, name: partner.name },
      offer_token: signResolvedOffer({
        template,
        partner,
        targetUrl,
        placement: 'city_transport',
        need,
        city: route.origin,
        resolutionType: 'trip_sequence_route',
        travelDate: route.travel_date
      })
    });
  }

  return result;
}

function rankOffers(offers) {
  const resolution = { trip_sequence_route: 40, context_search: 35, static: 10 };
  const confidence = { high: 3, medium: 2, low: 1 };
  return [...offers].sort((a, b) => {
    const ra = resolution[a?.resolution_type] || 0;
    const rb = resolution[b?.resolution_type] || 0;
    const ca = confidence[a?.confidence] || 0;
    const cb = confidence[b?.confidence] || 0;
    if (rb !== ra) return rb - ra;
    if (cb !== ca) return cb - ca;
    return String(a?.partner?.slug || '').localeCompare(String(b?.partner?.slug || ''));
  });
}

export async function resolveTripOffers({ session_token, trip_id }) {
  const session = await resolveSession(session_token).catch(() => null);
  const offers = [];
  const holafly = await getOffer('holafly', 'trip_connectivity');
  if (holafly) offers.push(holafly);
  return { session, offers };
}

export async function resolveCityOffers({ session_token, trip_id, city = '', language = 'es', needs = [] }) {
  const session = await resolveSession(session_token);
  if (!session) return { session: null, offers: [] };

  const safeNeeds = Array.isArray(needs) ? needs : [];
  const safeCity = clean(city || safeNeeds.find(Boolean)?.city, 160);
  const safeLanguage = language === 'en' ? 'en' : 'es';

  const [viator, getyourguide, omio] = await Promise.all([
    resolveExperiencePartner('viator', safeNeeds, safeCity, safeLanguage),
    resolveExperiencePartner('getyourguide', safeNeeds, safeCity, safeLanguage),
    resolveOmioTripRoutes(trip_id, session.user_id, safeCity, safeLanguage)
  ]);

  return { session, offers: rankOffers([...viator, ...getyourguide, ...omio]) };
}

export async function registerPartnerClick({ session_token, trip_id, offer_id, offer_token, placement }) {
  const session = await resolveSession(session_token).catch(() => null);
  let resolved = verifyPayload(offer_token);

  if (!resolved && offer_id) {
    const rows = await supabaseFetch(
      `/partner_offers?select=id,partner_id,target_url,enabled&${`id=eq.${encodeURIComponent(offer_id)}`}`
    );
    const offer = Array.isArray(rows) ? rows[0] || null : null;
    if (!offer?.enabled || !/^https:\/\//i.test(String(offer.target_url || ''))) {
      return { ok: false, code: 'OFFER_NOT_AVAILABLE' };
    }
    resolved = {
      offer_id: offer.id,
      partner_id: offer.partner_id,
      partner_slug: '',
      partner_name: '',
      url: offer.target_url,
      placement: clean(placement, 80),
      city: '',
      need_type: '',
      entity_name: '',
      travel_date: '',
      resolution_type: 'static'
    };
  }

  if (!resolved) return { ok: false, code: 'OFFER_NOT_AVAILABLE' };
  if (resolved.partner_slug && !hasRequiredAttribution(resolved.partner_slug, resolved.url)) {
    console.error('ITBMO partner attribution blocked before navigation', { partner: resolved.partner_slug });
    return { ok: false, code: 'PARTNER_ATTRIBUTION_INVALID' };
  }

  const clickId = crypto.randomUUID();
  await supabaseFetch('/partner_clicks', {
    method: 'POST',
    body: JSON.stringify({
      click_id: clickId,
      partner_id: resolved.partner_id,
      offer_id: resolved.offer_id,
      user_id: session?.user_id || null,
      session_id: session?.id || null,
      trip_id: trip_id || null,
      placement: clean(resolved.placement || placement, 80),
      city: clean(resolved.city, 160) || null,
      need_type: clean(resolved.need_type, 80) || null,
      entity_name: clean(resolved.entity_name, 180) || null,
      travel_date: clean(resolved.travel_date, 40) || null,
      target_url: clean(resolved.url, 1500),
      resolution_type: clean(resolved.resolution_type, 40) || null
    })
  });

  return {
    ok: true,
    click_id: clickId,
    url: resolved.url,
    partner_slug: resolved.partner_slug || null,
    partner_name: resolved.partner_name || null,
    need_type: resolved.need_type || null,
    entity_name: resolved.entity_name || null,
    travel_date: resolved.travel_date || null
  };
}
