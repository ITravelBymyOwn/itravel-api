import crypto from 'crypto';
import { resolveSession, supabaseFetch } from './itbmo-foundation.js';

const SAFE_SLUGS = new Set(['holafly', 'airalo', 'omio', 'viator', 'getyourguide']);
const SIGNING_SECRET = String(
  process.env.PARTNER_CLICK_SIGNING_SECRET || process.env.SUPABASE_SECRET_KEY || ''
).trim();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const VIATOR_PID = 'P00318254';
const VIATOR_MCID = '42383';
const GYG_PARTNER_ID = '3FZWELC';


// Only language capabilities verified for ITBMO's current affiliate integration
// are declared here. They are deliberately separated from URL mutation: if the
// partner does not document a safe locale mechanism for the exact link format
// ITBMO uses, the adapter leaves the provider URL untouched.
const PARTNER_LANGUAGE_CAPABILITIES = Object.freeze({
  viator: {
    supported: new Set(['en','es']),
    applicable: new Set(['en','es']),
    strategy: 'localized_path'
  },
  getyourguide: {
    supported: new Set(['en','es']),
    applicable: new Set(['en','es']),
    strategy: 'localized_domain'
  },
  omio: {
    supported: new Set(['en','es','de']),
    applicable: new Set(['en','es']),
    strategy: 'explicit_route'
  }
});

function clean(value, max = 240) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizeLanguage(value) {
  const raw = clean(value, 80)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (/\b(es|spa|spanish|espanol|castellano)\b/.test(raw)) return 'es';
  if (/\b(pt|por|portuguese|portugues)\b/.test(raw)) return 'pt';
  if (/\b(fr|fre|french|francais)\b/.test(raw)) return 'fr';
  if (/\b(de|ger|german|deutsch|aleman)\b/.test(raw)) return 'de';
  if (/\b(it|ita|italian|italiano)\b/.test(raw)) return 'it';
  if (/\b(ja|japanese|japones)\b/.test(raw)) return 'ja';
  if (/\b(ko|korean|coreano)\b/.test(raw)) return 'ko';
  if (/\b(zh-cn|chinese simplified|chino simplificado)\b/.test(raw)) return 'zh-cn';
  if (/\b(zh-tw|chinese traditional|chino tradicional)\b/.test(raw)) return 'zh-tw';
  if (/\b(en|eng|english|ingles)\b/.test(raw)) return 'en';
  return raw || '';
}

function resolvePartnerLocale(slug, uiLanguage) {
  const capability = PARTNER_LANGUAGE_CAPABILITIES[slug];
  // Commercial/affiliate language follows ITBMO UI only (ES/EN). The itinerary
  // language is intentionally excluded so a DE/FR/JA/etc. itinerary can never
  // mutate an affiliate link into an unverified locale.
  const ui = normalizeLanguage(uiLanguage) === 'es' ? 'es' : 'en';

  if (!capability) {
    return { locale: ui, applied: false, strategy: 'provider_default' };
  }

  const locale = capability.supported.has(ui) ? ui : 'en';
  return {
    locale,
    applied: capability.applicable.has(locale),
    strategy: capability.strategy
  };
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
    if (slug === 'getyourguide') return host === 'www.getyourguide.com' || host.endsWith('.getyourguide.com') || host === 'www.getyourguide.es' || host.endsWith('.getyourguide.es') || host === 'gyg.me';
    if (slug === 'omio') return host === 'omio.sjv.io' || host === 'www.omio.com' || host === 'www.omio.es';
    if (slug === 'holafly') return host === 'holafly.sjv.io' || host.endsWith('.holafly.com') || host === 'holafly.com';
    if (slug === 'airalo') return host === 'airalo.pxf.io' || host.endsWith('.airalo.com') || host === 'airalo.com';
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

async function getOmioTemplate() {
  return (await getOffer('omio', 'city_transport')) ||
    (await getOffer('omio', 'city_transport_contextual')) ||
    (await getOffer('omio'));
}

function searchQueryForNeed(need, city, language = 'en') {
  const entity = clean(need?.entity_name || need?.source_activity, 180);
  const safeCity = clean(city || need?.city, 120);
  const type = clean(need?.need_type, 80);
  const isSpanish = normalizeLanguage(language) === 'es';

  if (entity) {
    if (type === 'guided_tour_optional' && /^(?:city tour en |.+ city tour$)/i.test(entity)) {
      const tourCity = entity.replace(/^city tour en /i, '').replace(/ city tour$/i, '').trim() || safeCity;
      return `${tourCity} city tour`;
    }
    if (type === 'ticket_required' || type === 'reservation_recommended') {
      const intent = isSpanish ? 'entrada acceso sin tour' : 'entry ticket admission self guided';
      return [entity, safeCity, intent].filter(Boolean).join(' ');
    }
    if (type === 'guided_tour_optional') {
      const intent = isSpanish ? 'tour guiado experiencia' : 'guided tour experience';
      return [entity, safeCity, intent].filter(Boolean).join(' ');
    }
    return [entity, safeCity].filter(Boolean).join(' ');
  }

  if (!safeCity) return '';
  if (type === 'guided_tour_optional') {
    return isSpanish ? `${safeCity} tours experiencias guiadas` : `${safeCity} guided tours experiences`;
  }
  if (type === 'ticket_required' || type === 'reservation_recommended') {
    return isSpanish ? `${safeCity} entradas atracciones acceso` : `${safeCity} entry tickets attractions admission`;
  }
  return safeCity;
}

// Marketplace search is intentionally narrower than the traveler-facing title.
// Narrative activity names ("Palace - interior, towers and views") and negative
// qualifiers such as "without a tour" can be interpreted as unrelated tokens by
// provider search engines. Keep the canonical attraction plus its destination.
function canonicalMarketplaceEntity(value, city = '') {
  let entity = clean(value, 180)
    .replace(/\s+[—–]\s+.*/, '')
    .replace(/\s+-\s+(?:visita|visit|recorrido|paseo|interior|exterior|torres?|towers?|entrada|ticket|access|acceso)\b.*/i, '')
    .replace(/\s*\((?:interior|exterior|visita|visit|entrada|ticket|acceso|access)[^)]*\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const destination = clean(city, 120);
  if (destination && normalizeKey(entity) === normalizeKey(destination)) entity = destination;
  return entity;
}

function trackingCampaign(need, city, uiLanguage, partnerLocale = '') {
  const entityPart = campaignPart(need?.entity_name || need?.source_activity || city);
  const typePart = campaignPart(need?.need_type || 'context');
  const uiPart = campaignPart(normalizeLanguage(uiLanguage) || 'en');
  const localePart = campaignPart(partnerLocale || uiPart);
  return `itbmo-${entityPart}-${typePart}-${uiPart}-${localePart}`.slice(0, 120);
}

function contextualSearchUrl(slug, uiLanguage, partnerLocale, need, city) {
  let query = searchQueryForNeed(need, city, uiLanguage);
  // GYG performs better for admission inventory with a concise positive query.
  // Viator keeps the existing richer query because it already resolves correctly.
  if (slug === 'getyourguide' && ['ticket_required', 'reservation_recommended'].includes(clean(need?.need_type, 80))) {
    const entity = canonicalMarketplaceEntity(need?.entity_name || need?.source_activity, city);
    const destination = clean(city || need?.city, 120);
    const ticketIntent = normalizeLanguage(uiLanguage) === 'es' ? 'entradas' : 'tickets';
    query = [entity, destination && !normalizeKey(entity).includes(normalizeKey(destination)) ? destination : '', ticketIntent]
      .filter(Boolean).join(' ');
  }
  if (!query) return '';
  const campaign = trackingCampaign(need, city, uiLanguage, partnerLocale);

  if (slug === 'viator') {
    // Viator documents localized language/PoS URLs. Keep PID/MCID/medium/campaign
    // untouched so changing the traveler-facing language never breaks attribution.
    const base = partnerLocale === 'es'
      ? 'https://www.viator.com/es-ES/searchResults/all'
      : 'https://www.viator.com/searchResults/all';
    return appendParams(base, {
      text: query,
      pid: VIATOR_PID,
      mcid: VIATOR_MCID,
      medium: 'link',
      campaign
    });
  }

  if (slug === 'getyourguide') {
    // GYG deep links keep partner_id attribution. Use its Spanish storefront
    // when ITBMO is Spanish; English keeps the global .com storefront.
    const base = partnerLocale === 'es'
      ? 'https://www.getyourguide.es/s/'
      : 'https://www.getyourguide.com/s/';
    return appendParams(base, {
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

function signResolvedOffer({ template, partner, targetUrl, placement, need, city, resolutionType, travelDate = '', partnerLocale = '' }) {
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
    resolution_type: clean(resolutionType, 40),
    partner_locale: clean(partnerLocale, 20)
  };
  return signPayload(payload);
}

async function resolveExperiencePartner(slug, needs, city, uiLanguage, tripLanguage) {
  const partner = await getPartner(slug);
  if (!partner || !partner.enabled || partner.status !== 'approved') return [];
  const template = await getContextTemplate(slug);
  if (!template) return [];

  const offers = [];
  const seen = new Set();
  const localeResolution = resolvePartnerLocale(slug, uiLanguage);

  for (const need of needs) {
    if (!['ticket_required', 'reservation_recommended', 'guided_tour_optional'].includes(need?.need_type)) continue;

    const targetUrl = contextualSearchUrl(slug, uiLanguage, localeResolution.locale, need, city);
    if (!targetUrl || !allowedPartnerUrl(slug, targetUrl)) continue;

    const isTour = need?.need_type === 'guided_tour_optional';
    const placement = isTour ? 'city_experiences' : 'city_tickets';
    const resolutionType = isTour ? 'context_search_experience' : 'context_search_admission';
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
      resolution_type: resolutionType,
      provider_entity_type: isTour ? 'search_experience' : 'search_admission',
      partner_locale: localeResolution.locale,
      locale_applied: localeResolution.applied,
      provider_entity_id: null,
      partner: { id: partner.id, slug: partner.slug, name: partner.name },
      offer_token: signResolvedOffer({
        template,
        partner,
        targetUrl,
        placement,
        need,
        city,
        resolutionType,
        partnerLocale: localeResolution.locale
      })
    });
  }

  return offers;
}

const OMIO_EUROPE_COUNTRY_CODES = new Set(`AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GR HR HU IE IS IT LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS SE SI SK SM TR UA VA XK`.split(/\s+/));
const OMIO_EUROPE_COUNTRY_ALIASES = new Map(Object.entries({
  andorra:'AD', albania:'AL', austria:'AT', 'aland islands':'AX', 'islas aland':'AX',
  'bosnia and herzegovina':'BA', 'bosnia y herzegovina':'BA', belarus:'BY', bielorrusia:'BY',
  belgium:'BE', belgica:'BE', bulgaria:'BG', switzerland:'CH', suiza:'CH', cyprus:'CY', chipre:'CY',
  czechia:'CZ', 'czech republic':'CZ', chequia:'CZ', 'republica checa':'CZ', germany:'DE', alemania:'DE',
  denmark:'DK', dinamarca:'DK', estonia:'EE', spain:'ES', espana:'ES', finland:'FI', finlandia:'FI',
  'faroe islands':'FO', 'islas feroe':'FO', france:'FR', francia:'FR', 'united kingdom':'GB',
  'reino unido':'GB', uk:'GB', 'great britain':'GB', greece:'GR', grecia:'GR', croatia:'HR', croacia:'HR',
  hungary:'HU', hungria:'HU', ireland:'IE', irlanda:'IE', iceland:'IS', islandia:'IS', italy:'IT', italia:'IT',
  liechtenstein:'LI', lithuania:'LT', lituania:'LT', luxembourg:'LU', luxemburgo:'LU', latvia:'LV', letonia:'LV',
  monaco:'MC', moldova:'MD', moldavia:'MD', montenegro:'ME', 'north macedonia':'MK', 'macedonia del norte':'MK',
  malta:'MT', netherlands:'NL', 'paises bajos':'NL', norway:'NO', noruega:'NO', poland:'PL', polonia:'PL',
  portugal:'PT', romania:'RO', rumania:'RO', serbia:'RS', sweden:'SE', suecia:'SE', slovenia:'SI', eslovenia:'SI',
  slovakia:'SK', eslovaquia:'SK', 'san marino':'SM', turkey:'TR', turquia:'TR', ukraine:'UA', ucrania:'UA',
  'vatican city':'VA', 'ciudad del vaticano':'VA', kosovo:'XK'
}));

function normalizeCountryKey(value) {
  return clean(value, 120).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function destinationCountryCode(item) {
  const explicit = clean(item?.country_code || item?.countryCode, 8).toUpperCase();
  if (explicit) return explicit;
  return OMIO_EUROPE_COUNTRY_ALIASES.get(normalizeCountryKey(item?.country)) || '';
}

function omioRouteEligible(route) {
  return OMIO_EUROPE_COUNTRY_CODES.has(route?.origin_country_code) &&
    OMIO_EUROPE_COUNTRY_CODES.has(route?.destination_country_code);
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
      country: clean(item?.country, 120),
      country_code: destinationCountryCode(item),
      baseDate: clean(item?.base_date || item?.baseDate, 40)
    }))
    .filter(item => item.city);

  return destinations.slice(0, -1).map((from, index) => {
    const to = destinations[index + 1];
    return {
      id: `route:${index}:${from.city}:${to.city}`,
      origin: from.city,
      destination: to.city,
      origin_country_code: from.country_code,
      destination_country_code: to.country_code,
      travel_date: to.baseDate || ''
    };
  });
}

function omioLanding(origin, destination, locale) {
  const from = slugify(origin);
  const to = slugify(destination);
  if (!from || !to) return '';
  return locale === 'es'
    ? `https://www.omio.es/viajes/${from}/${to}`
    : `https://www.omio.com/travel/${from}/${to}`;
}

function omioTrackedUrl(trackingBase, origin, destination, locale) {
  const landing = omioLanding(origin, destination, locale);
  if (!landing || !allowedPartnerUrl('omio', trackingBase)) return '';
  const url = new URL(trackingBase);
  url.searchParams.set('u', landing);
  return url.toString();
}

function parseResolvedRoutePayload(value){
  const text=clean(value,6000);
  if(!text.startsWith('ITBMO_ROUTE_V1|')) return null;
  try{const parsed=JSON.parse(decodeURIComponent(text.slice('ITBMO_ROUTE_V1|'.length)));return parsed&&Array.isArray(parsed.legs)?parsed:null;}catch(_){return null;}
}
function omioCommercialEndpoint(value){
  // Safety net for historical/resolver payloads that predate commercial_*.
  // Omio SEO routes are city-to-city; station/airport slugs frequently 404.
  return clean(value,120)
    .replace(/\b(?:central|centre|center)\b/ig,' ')
    .replace(/\b(?:railway|train|bus)\s+station\b/ig,' ')
    .replace(/\b(?:station|estaci[oó]n|gare|terminal|airport|aeropuerto)\b/ig,' ')
    .replace(/\b(?:chamart[ií]n|atocha|barajas|orly|charles de gaulle|cdg|fiumicino|ciampino|midi|zuid|guillemins)\b/ig,' ')
    .replace(/^[\s-]*(?:de|del|des|du|of|di|da)\s+/i,' ')
    .replace(/[,-–—]+/g,' ')
    .replace(/\s+/g,' ').trim();
}
function commercialOmioSegments(need){
  const payload=parseResolvedRoutePayload(need?.source_route);
  if(!payload)return [];
  return payload.legs.filter(leg=>leg?.commerce_eligible && leg?.origin && leg?.destination && ['train','bus','coach','plane','flight','ferry'].includes(normalizeKey(leg?.mode))).map((leg,index)=>({...leg,segment_index:Number(leg.index||index+1),commercial_origin:omioCommercialEndpoint(clean(leg.commercial_origin,120)||leg.origin),commercial_destination:omioCommercialEndpoint(clean(leg.commercial_destination,120)||leg.destination),commercial_origin_es:omioCommercialEndpoint(clean(leg.commercial_origin_es,120)),commercial_destination_es:omioCommercialEndpoint(clean(leg.commercial_destination_es,120)),commercial_origin_en:omioCommercialEndpoint(clean(leg.commercial_origin_en,120)),commercial_destination_en:omioCommercialEndpoint(clean(leg.commercial_destination_en,120)),parent_origin:payload.parent?.origin||'',parent_destination:payload.parent?.destination||'',parent_summary:payload.summary||''}));
}

async function getOwnedTripDestination(tripId, userId, city) {
  if (!tripId || !userId || !city) return null;
  const rows = await supabaseFetch(
    `/trips?select=destinations&id=eq.${encodeURIComponent(tripId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`
  );
  const trip = Array.isArray(rows) ? rows[0] || null : null;
  return (Array.isArray(trip?.destinations) ? trip.destinations : []).find(item =>
    clean(item?.city,160).toLowerCase() === clean(city,160).toLowerCase()
  ) || null;
}

async function resolveOmioContextRoutes(tripId, userId, city, uiLanguage, needs=[]) {
  const transportNeeds=(Array.isArray(needs)?needs:[]).filter(item=>item && (item.need_type==='intercity_transport' || item.need_type==='transport_arrangement'));
  if(!transportNeeds.length) return [];
  const [partner,template,mainDestination]=await Promise.all([getPartner('omio'),getOmioTemplate(),getOwnedTripDestination(tripId,userId,city)]);
  if(!partner || !template || !mainDestination) return [];
  const countryCode=destinationCountryCode(mainDestination);
  if(!OMIO_EUROPE_COUNTRY_CODES.has(countryCode)) return [];
  const localeResolution=resolvePartnerLocale('omio',uiLanguage);
  const out=[]; const seen=new Set();
  for(const need of transportNeeds){
    const resolvedSegments=commercialOmioSegments(need);
    const fallbackRoute=null; // fail closed: never manufacture an Omio URL from an unresolved A→B label
    const routes=resolvedSegments.length?resolvedSegments.map(seg=>{
      const es=localeResolution.locale==='es';
      const localizedOrigin=es?(seg.commercial_origin_es||seg.commercial_origin):(seg.commercial_origin_en||seg.commercial_origin);
      const localizedDestination=es?(seg.commercial_destination_es||seg.commercial_destination):(seg.commercial_destination_en||seg.commercial_destination);
      if(!localizedOrigin||!localizedDestination)return null;
      return {origin:localizedOrigin,destination:localizedDestination,display_origin:seg.origin,display_destination:seg.destination,mode:seg.mode,segment_index:seg.segment_index,parent_origin:seg.parent_origin,parent_destination:seg.parent_destination,parent_summary:seg.parent_summary};
    }).filter(Boolean).filter(route=>normalizeKey(route.origin)!==normalizeKey(route.destination)):fallbackRoute?[fallbackRoute]:[];
    for(const route of routes){
      const key=`${normalizeKey(route.origin)}|${normalizeKey(route.destination)}|${normalizeKey(route.mode||'')}`;
      if(seen.has(key))continue;seen.add(key);
      const targetUrl=omioTrackedUrl(clean(template.target_url,1000),route.origin,route.destination,localeResolution.applied?localeResolution.locale:'en');
      if(!targetUrl)continue;
      const routeLabel=`${route.origin} → ${route.destination}`;
      out.push({...template,placement:'city_transport',title_es:routeLabel,title_en:routeLabel,
        description_es:'Compara opciones disponibles para este tramo del traslado.',description_en:'Compare available options for this leg of the journey.',target_url:undefined,confidence:resolvedSegments.length?'high':'medium',need_id:need.id,need_type:need.need_type,entity_name:routeLabel,city,travel_date:need.travel_date||null,resolution_type:resolvedSegments.length?'context_resolved_route_segment':'context_intercity_route',partner_locale:localeResolution.locale,locale_applied:localeResolution.applied,
        route_segment:{index:route.segment_index||1,mode:route.mode||'',parent_origin:route.parent_origin||'',parent_destination:route.parent_destination||'',parent_summary:route.parent_summary||''},
        partner:{id:partner.id,slug:partner.slug,name:partner.name},offer_token:signResolvedOffer({template,partner,targetUrl,placement:'city_transport',need:{...need,entity_name:routeLabel},city,resolutionType:resolvedSegments.length?'context_resolved_route_segment':'context_intercity_route',travelDate:need.travel_date||'',partnerLocale:localeResolution.locale})});
    }
  }
  return out;
}

function rankOffers(offers) {
  const resolution = { context_resolved_route_segment: 41, trip_sequence_route: 40, context_intercity_route: 39, context_search_admission: 38, context_search_experience: 35, context_search: 35, static: 10 };
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
  const [holafly, airalo] = await Promise.all([
    getOffer('holafly', 'trip_connectivity'),
    getOffer('airalo', 'trip_connectivity')
  ]);
  if (holafly) offers.push(holafly);
  if (airalo) offers.push(airalo);
  return { session, offers: rankOffers(offers) };
}

export async function resolveCityOffers({
  session_token,
  trip_id,
  city = '',
  language = 'es',
  ui_language = '',
  trip_language = '',
  needs = []
}) {
  const session = await resolveSession(session_token);
  if (!session) return { session: null, offers: [] };

  const safeNeeds = Array.isArray(needs) ? needs : [];
  const safeCity = clean(city || safeNeeds.find(Boolean)?.city, 160);
  const safeUiLanguage = normalizeLanguage(ui_language || language) === 'en' ? 'en' : 'es';
  const safeTripLanguage = normalizeLanguage(trip_language);

  const [viator, getyourguide, omioContext] = await Promise.all([
    resolveExperiencePartner('viator', safeNeeds, safeCity, safeUiLanguage, safeTripLanguage),
    resolveExperiencePartner('getyourguide', safeNeeds, safeCity, safeUiLanguage, safeTripLanguage),
    resolveOmioContextRoutes(trip_id, session.user_id, safeCity, safeUiLanguage, safeNeeds)
  ]);
  // Omio is fail-closed: only Route-Resolver segments may become commerce links.
  // The historical trip-sequence fallback guessed SEO slugs and could lead to
  // valid-looking but nonexistent Omio pages. Context still shows the journey
  // when no provider-safe segment is available; it simply has no broken CTA.
  const omio=[]; const seenOmio=new Set();
  omioContext.forEach(offer=>{const key=`${normalizeKey(offer?.entity_name)}|${offer?.travel_date||''}`;if(!seenOmio.has(key)){seenOmio.add(key);omio.push(offer);}});
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
      resolution_type: 'static',
      partner_locale: ''
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
    travel_date: resolved.travel_date || null,
    partner_locale: resolved.partner_locale || null
  };
}
