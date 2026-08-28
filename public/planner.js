/* =========================================================
   ITBMO PLANNER v64 · Final Download & Branded Affiliate Upgrade — Precision Route & Anchor Upgrade

   Base: v63
   API contract: compatible with API v65

   Precision Route & Anchor Upgrade:
   - Global geographic sequence optimization with anti-backtracking logic
   - Mathematical row-time reconciliation against transport + activity duration
   - Intelligent category-based minimum dwell times
   - Semantic experience deduplication beyond exact place names
   - Strict single-language itinerary output
   - Expert macro-tour enrichment with high-value low-detour micro-stops
   - Incremental tourism-value and experience-diversity scoring
   - Trip-wide weakest-day quality review integrated into the existing final pass
   - Reservation/anchor experience protection with realistic full visit blocks
   - Compact duration parser repair for forms such as 2h15m–2h30m
   - Activity-location alignment: every visit occurs at the row's concrete To location
   - Gap-aware day reconciliation without compressing premium anchor experiences
   - Stronger macro-route candidate discovery and micro-stop coverage
   - Existing architecture, API contract, master plan, audits, repair loop, renderer and exports preserved
========================================================= */


/* ---------- Helpers DOM ---------- */
const qs  = (s, ctx=document)=>ctx.querySelector(s);
const qsa = (s, ctx=document)=>Array.from(ctx.querySelectorAll(s));

/* ---------- Config API ---------- */
const API_URL = '/api/chat';
const USER_API_URL = '/api/user';
const TRIP_API_URL = '/api/trip';
const PAYMENT_API_URL = '/api/payment';
const MODEL   = 'gpt-4o-mini';

const ITBMO_SESSION_KEY = 'itbmo_session_token';
const ITBMO_TERMS_VERSION = '1.0';
const ITBMO_PRIVACY_VERSION = '1.0';
const ITBMO_MARKETING_VERSION = '1.0';

let currentUser = null;
let currentTripId = null;
let authReady = false;

let savedDestinations = [];      // [{ city, country, days, baseDate, perDay:[{day,start,end}] }]

let itineraries = {};            // { [city]: { byDay, currentDay, baseDate, originalDays, masterPlan, audit } }
let cityMeta = {};               // { [city]: { baseDate, start, end, hotel, transport, perDay:[] } }

let session = [];                // historial para el agente principal
let infoSession = [];            // historial separado para Info Chat
let activeCity = null;

let planningStarted = false;
let metaProgressIndex = 0;
let collectingHotels = false;
let isItineraryLocked = false;

let pendingChange = null;
let hasSavedOnce = false;

/* Post-payment preferences checkpoint.
   This changes only WHEN specialConditions is confirmed.
   The downstream plannerState / agent / generator contract remains unchanged. */
let preferencesStageTripId = null;
let preferencesConfirmedTripId = null;

/* Agent conversation language is independent from ES/EN site UI and from
   the final itinerary language. It is locked from the user's first chat line. */
let agentConversationLang = null;

/* ---------- Defaults técnicos (NO rígidos) ---------- */
const DEFAULT_START = '';
const DEFAULT_END   = '';
const MAX_ITINERARY_CITIES = 3;

let plannerState = {
  destinations: [],
  specialConditions: '',
  travelers: {
    adults: 0,
    young: 0,
    children: 0,
    infants: 0,
    seniors: 0
  },
  travelerProfiles: null,
  budget: '',
  currency: 'USD',
  lang: 'en' // se setea abajo
};

(function initPlannerLang(){
  const normalize = (v)=>{
    const s = String(v || '').trim().toLowerCase();
    if(!s) return '';
    const base = s.split(/[-_]/)[0];
    return (base === 'es' || base === 'en') ? base : '';
  };

  // 1) <html lang="">
  let lang = normalize(document?.documentElement?.getAttribute('lang'));

  if(!lang){
    try{
      const p = String(window?.location?.pathname || '').toLowerCase();
      if(/^\/es(\/|$)/.test(p)) lang = 'es';
      else if(/^\/en(\/|$)/.test(p)) lang = 'en';
    }catch(_){}
  }

  // 3) Default MVP
  if(!lang) lang = 'en';

  plannerState.lang = lang;
})();

const I18N = {
  es: {
    hi: '¡Hola! Soy Astra ✨, tu concierge de viajes. Vamos a crear itinerarios inolvidables 🌍',
    askHotelTransport: (city)=>`Para <strong>${city}</strong>, dime tu <strong>hotel/zona</strong> y el <strong>medio de transporte</strong> (alquiler, público, taxi/uber, combinado o “recomiéndame”).`,
    confirmAll: '✨ Listo.',
    doneAll: '🎉 ¡Tus itinerarios están listos! Para dudas adicionales sobre las ciudades de este viaje, usa Info Chat 🌐.',
    fail: '⚠️ No se pudo contactar con el asistente. Revisa consola/Vercel (API Key, URL).',
    askConfirm: (summary)=>`¿Confirmas? ${summary}<br><small>Responde “sí” para aplicar o “no” para cancelar.</small>`,
    humanOk: 'Perfecto 🙌 Ajusté tu itinerario para que aproveches mejor el tiempo. ¡Va a quedar genial! ✨',
    humanCancelled: 'Anotado, no apliqué cambios. ¿Probamos otra idea? 🙂',
    cityAdded: (c)=>`✅ Añadí <strong>${c}</strong> y generé su itinerario.`,
    cityRemoved: (c)=>`🗑️ Eliminé <strong>${c}</strong> de tu plan y reoptimicé las pestañas.`,
    cannotFindCity: 'No identifiqué la ciudad. Dímela con exactitud, por favor.',
    thinking: 'Astra está pensando…',

    // UI / Sidebar cities
    uiCity: 'Ciudad',
    uiCountry: 'País',
    uiDays: 'Días',
    uiStart: 'Inicio',
    uiDateFormatSmall: 'DD/MM/AAAA',
    uiTimeHint: '⏰ Usa horario de 24 h — Ej: 08:30 (mañana) · 21:00 (noche)',
    uiStartTime: 'Hora Inicio',
    uiEndTime: 'Hora Final',
    uiDay: (d)=>`Día ${d}`,
    uiAriaStart: 'Hora inicio',
    uiAriaEnd: 'Hora final',

    // Itinerary
    uiNoActivities: 'No hay actividades aún. El asistente las generará aquí.',
    uiDayTitle: (n)=>`Día ${n}`,
    thStart: 'Hora inicio',
    thEnd: 'Hora final',
    thActivity: 'Actividad',
    thFrom: 'Desde',
    thTo: 'Hacia',
    thTransport: 'Transporte',
    thDuration: 'Duración',
    thNotes: 'Notas',

    // Overlay
    overlayDefault: '✨ ASTRA está creando tu itinerario — ciudad por ciudad, día por día.\n⏳ TIEMPO ESTIMADO DE GENERACIÓN\n1 ciudad: 4–5 min  ·  2 ciudades: 8–10 min  ·  3 ciudades: 12–15 min\n🔎 ¿Por qué toma tiempo? ASTRA investiga y compara rutas, horarios, traslados, prioridades, tus preferencias y la coherencia del viaje completo para convertir horas de investigación en un plan listo para explorar.\n⚠️ MANTÉN ESTA PESTAÑA ABIERTA hasta que tu itinerario esté listo.\n✈️ Mientras ASTRA trabaja, sigue dando forma a tu viaje con los enlaces de abajo: vuelos, hospedaje, transporte y experiencias.',
    overlayGenerating: '✨ ASTRA está creando tu itinerario — ciudad por ciudad, día por día.\n⏳ TIEMPO ESTIMADO DE GENERACIÓN\n1 ciudad: 4–5 min  ·  2 ciudades: 8–10 min  ·  3 ciudades: 12–15 min\n🔎 ¿Por qué toma tiempo? ASTRA investiga y compara rutas, horarios, traslados, prioridades, tus preferencias y la coherencia del viaje completo para convertir horas de investigación en un plan listo para explorar.\n⚠️ MANTÉN ESTA PESTAÑA ABIERTA hasta que tu itinerario esté listo.\n✈️ Mientras ASTRA trabaja, sigue dando forma a tu viaje con los enlaces de abajo: vuelos, hospedaje, transporte y experiencias.',
    overlayRebalancingCity: 'Astra está reequilibrando la ciudad…',
    overlayRebalancing: 'Agregando días y reoptimizando…',

    // Tooltip fechas
    tooltipDateMissing: 'Por favor ingresa la fecha de inicio (DD/MM/AAAA) para cada ciudad 🗓️',

    // Reset modal
    resetTitle: '¿Reiniciar planificación? 🧭',
    resetBody: 'Esto eliminará todos los destinos, preferencias, datos de planificación e itinerarios actuales.<br><br><strong>Antes de continuar, asegúrate de haber descargado tu itinerario, CSV y comprobante de pago.</strong><br><br>Si reinicias, tendrás que comenzar un nuevo viaje y <strong>realizar un nuevo pago para volver a generar un itinerario</strong>.<br><br><strong>Esta acción no se puede deshacer.</strong>',
    resetConfirm: 'Sí, reiniciar',
    resetCancel: 'Cancelar',

    // Travelers UI
    travelerLabel: (n)=>`Viajero ${n}`,
    travelerCompanion: 'Acompañante',
    travelerGender: 'Género',
    travelerAgeRange: 'Rango de edad',
    genderFemale: 'Femenino',
    genderMale: 'Masculino',
    genderNonBinary: 'No binario',
    genderAnotherIdentity: 'Otra identidad',
    genderNA: 'Prefiero no decirlo',
    ageBaby: 'Bebé (0–2)',
    agePreschool: 'Preescolar (3–5)',
    ageChild: 'Niño (6–12)',
    ageTeen: 'Adolescente (13–17)',
    ageYoungAdult: 'Joven adulto (18–24)',
    ageAdult2534: 'Adulto (25–34)',
    ageAdult3544: 'Adulto (35–44)',
    ageAdult4554: 'Adulto (45–54)',
    ageAdult5564: 'Adulto (55–64)',
    ageSenior: 'Mayor (65+)',

    fallbackLocal: '⚠️ Fallback local: revisa configuración de Vercel o API Key.'
  },

  en: {
    hi: 'Hi! I’m Astra ✨, your travel concierge. Let’s build unforgettable itineraries 🌍',
    askHotelTransport: (city)=>`For <strong>${city}</strong>, tell me your <strong>hotel/area</strong> and your <strong>transport</strong> (rental, public transit, taxi/uber, mixed, or “recommend”).`,
    confirmAll: '✨ Ready.',
    doneAll: '🎉 Your itineraries are ready! For additional questions about the cities in this trip, use Info Chat 🌐.',
    fail: '⚠️ Could not reach the assistant. Check console/Vercel (API Key, URL).',
    askConfirm: (summary)=>`Do you confirm? ${summary}<br><small>Reply “yes” to apply or “no” to cancel.</small>`,
    humanOk: 'Perfect 🙌 I adjusted your itinerary so you can use your time better. It’s going to be great! ✨',
    humanCancelled: 'Got it — I didn’t apply changes. Want to try another idea? 🙂',
    cityAdded: (c)=>`✅ I added <strong>${c}</strong> and generated its itinerary.`,
    cityRemoved: (c)=>`🗑️ I removed <strong>${c}</strong> from your plan and re-optimized the tabs.`,
    cannotFindCity: 'I couldn’t identify the city. Please tell me the exact name.',
    thinking: 'Astra is thinking…',

    // UI / Sidebar cities
    uiCity: 'City',
    uiCountry: 'Country',
    uiDays: 'Days',
    uiStart: 'Start',
    uiDateFormatSmall: 'DD/MM/YYYY',
    uiTimeHint: '⏰ Use 24h time — e.g., 08:30 (morning) · 21:00 (night)',
    uiStartTime: 'Start time',
    uiEndTime: 'End time',
    uiDay: (d)=>`Day ${d}`,
    uiAriaStart: 'Start time',
    uiAriaEnd: 'End time',

    // Itinerary
    uiNoActivities: 'No activities yet. The assistant will generate them here.',
    uiDayTitle: (n)=>`Day ${n}`,
    thStart: 'Start time',
    thEnd: 'End time',
    thActivity: 'Activity',
    thFrom: 'From',
    thTo: 'To',
    thTransport: 'Transport',
    thDuration: 'Duration',
    thNotes: 'Notes',

    // Overlay
    overlayDefault: '✨ ASTRA is creating your itinerary — city by city, day by day.\n⏳ ESTIMATED GENERATION TIME\n1 city: 4–5 min  ·  2 cities: 8–10 min  ·  3 cities: 12–15 min\n🔎 Why does it take time? ASTRA researches and compares routes, timing, transfers, priorities, your preferences and full-trip coherence to turn hours of research into a trip plan ready to explore.\n⚠️ KEEP THIS TAB OPEN until your itinerary is ready.\n✈️ While ASTRA works, keep shaping your trip with the links below: flights, stays, transport and experiences.',
    overlayGenerating: '✨ ASTRA is creating your itinerary — city by city, day by day.\n⏳ ESTIMATED GENERATION TIME\n1 city: 4–5 min  ·  2 cities: 8–10 min  ·  3 cities: 12–15 min\n🔎 Why does it take time? ASTRA researches and compares routes, timing, transfers, priorities, your preferences and full-trip coherence to turn hours of research into a trip plan ready to explore.\n⚠️ KEEP THIS TAB OPEN until your itinerary is ready.\n✈️ While ASTRA works, keep shaping your trip with the links below: flights, stays, transport and experiences.',
    overlayRebalancingCity: 'Astra is rebalancing the city…',
    overlayRebalancing: 'Adding days and re-optimizing…',

    // Tooltip fechas
    tooltipDateMissing: 'Please enter the start date (DD/MM/YYYY) for each city 🗓️',

    // Reset modal
    resetTitle: 'Reset planning? 🧭',
    resetBody: 'This will delete all current destinations, preferences, planning data, and itineraries.<br><br><strong>Before continuing, make sure you have downloaded your itinerary, CSV, and payment receipt.</strong><br><br>If you reset, you will need to start a new trip and <strong>make a new payment to generate another itinerary</strong>.<br><br><strong>This action cannot be undone.</strong>',
    resetConfirm: 'Yes, reset',
    resetCancel: 'Cancel',

    // Travelers UI
    travelerLabel: (n)=>`Traveler ${n}`,
    travelerCompanion: 'Companion',
    travelerGender: 'Gender',
    travelerAgeRange: 'Age range',
    genderFemale: 'Female',
    genderMale: 'Male',
    genderNonBinary: 'Non-binary',
    genderAnotherIdentity: 'Another identity',
    genderNA: 'Prefer not to say',
    ageBaby: 'Baby (0–2)',
    agePreschool: 'Preschool (3–5)',
    ageChild: 'Child (6–12)',
    ageTeen: 'Teen (13–17)',
    ageYoungAdult: 'Young adult (18–24)',
    ageAdult2534: 'Adult (25–34)',
    ageAdult3544: 'Adult (35–44)',
    ageAdult4554: 'Adult (45–54)',
    ageAdult5564: 'Adult (55–64)',
    ageSenior: 'Senior (65+)',

    fallbackLocal: '⚠️ Local fallback: check your Vercel configuration or API Key.'
  }
};

function getLang(){
  return (plannerState && (plannerState.lang === 'es' || plannerState.lang === 'en')) ? plannerState.lang : 'en';
}
function t(key, ...args){
  const lang = getLang();
  const pack = I18N[lang] || I18N.en;
  const v = pack[key];
  if(typeof v === 'function') return v(...args);
  if(typeof v === 'string') return v;
  const fb = (I18N.en && I18N.en[key]);
  if(typeof fb === 'function') return fb(...args);
  if(typeof fb === 'string') return fb;
  return '';
}

// (const tone redeclarado => "Identifier 'tone' has already been declared")
var tone = (typeof window !== 'undefined' && window.tone) ? window.tone : {
  hi: t('hi'),
  askHotelTransport: (city)=>t('askHotelTransport', city),
  confirmAll: t('confirmAll'),
  doneAll: t('doneAll'),
  fail: t('fail'),
  askConfirm: (summary)=>t('askConfirm', summary),
  humanOk: t('humanOk'),
  humanCancelled: t('humanCancelled'),
  cityAdded: (c)=>t('cityAdded', c),
  cityRemoved: (c)=>t('cityRemoved', c),
  cannotFindCity: t('cannotFindCity'),
  thinking: t('thinking')
};

if (typeof window !== 'undefined') window.tone = tone;

const $cityList = qs('#city-list');
const $addCity  = qs('#add-city-btn');
const $save     = qs('#save-destinations');
const $start    = qs('#start-planning');

const $chatBox  = qs('#chat-container');
const $chatM    = qs('#chat-messages');
const $chatI    = qs('#chat-input');
const $send     = qs('#send-btn');

const $tabs     = qs('#city-tabs');
const $itWrap   = qs('#itinerary-container');

const $upsell      = qs('#monetization-upsell');
const $upsellClose = qs('#upsell-close');
const $confirmCTA  = qs('#confirm-itinerary');

const $overlayWOW  = qs('#loading-overlay');
const $thinkingIndicator = qs('#thinking-indicator');

const $affiliateLoading = qs('#itbmo-affiliate-loading');
const $affiliateAfter   = qs('#itbmo-affiliate-after');

/* =========================================================
   ITBMO AFFILIATES — MVP monetization layer
   ---------------------------------------------------------
   PREVIEW WORKFLOW (before publishing):
   - previewMode: true  -> shows every partner using previewUrl.
   - This lets you evaluate the complete UX now.

   PUBLIC LAUNCH (before affiliate approvals):
   - Change ONLY previewMode to false.
   - Because every partner starts enabled:false, the surfaces disappear.

   AS EACH PARTNER APPROVES ITBMO:
   - Keep previewMode:false.
   - Set that partner enabled:true.
   - Paste its real affiliate URL in url.
   - Republish. Nothing else needs to change.

   IMPORTANT:
   - This layer never calls the itinerary API.
   - Links use target="_blank", so generation continues in this tab.
   - If GA4/gtag is available, clicks emit affiliate_click.
========================================================= */
const ITBMO_AFFILIATE_CONFIG = {
  previewMode: true, // TEST NOW. Set false immediately before public launch.

  partners: {
    kayak: {
      enabled: false,
      url: '',
      previewUrl: 'https://www.kayak.com/flights',
      name: 'KAYAK',
      category: 'flights'
    },
    skyscanner: {
      enabled: false,
      url: '',
      previewUrl: 'https://www.skyscanner.com/',
      name: 'Skyscanner',
      category: 'flights'
    },
    booking: {
      enabled: false,
      url: '',
      previewUrl: 'https://www.booking.com/',
      name: 'Booking.com',
      category: 'hotels'
    },
    getyourguide: {
      enabled: false,
      url: '',
      previewUrl: 'https://www.getyourguide.com/',
      name: 'GetYourGuide',
      category: 'experiences'
    },
    viator: {
      enabled: false,
      url: '',
      previewUrl: 'https://www.viator.com/',
      name: 'Viator',
      category: 'experiences'
    },
    omio: {
      enabled: false,
      url: '',
      previewUrl: 'https://www.omio.com/',
      name: 'Omio',
      category: 'transport'
    },
    airalo: {
      enabled: false,
      url: '',
      previewUrl: 'https://www.airalo.com/',
      name: 'Airalo',
      category: 'esim'
    },
    holafly: {
      enabled: false,
      url: '',
      previewUrl: 'https://esim.holafly.com/',
      name: 'Holafly',
      category: 'esim'
    }
  }
};

if (typeof window !== 'undefined') {
  window.ITBMO_AFFILIATE_CONFIG = ITBMO_AFFILIATE_CONFIG;
}

function _affiliateCopy_(){
  const es = getLang()==='es';
  return es ? {
    loadingEyebrow: 'Mientras Astra crea tu viaje',
    loadingTitle: 'Tu viaje empieza antes de que termine de generarse',
    loadingSub: 'Explora vuelos, hospedaje y experiencias mientras Astra sigue trabajando en esta pestaña.',
    afterEyebrow: 'Tu viaje ya tomó forma',
    afterTitle: 'Ahora hazlo realidad',
    afterSub: 'Da el siguiente paso. Compara, explora y reserva lo esencial para tu aventura.',
    flightsTitle: 'Encuentra tu próximo vuelo',
    flightsDesc: 'Compara opciones para llegar a tu destino.',
    hotelsTitle: 'Elige dónde quedarte',
    hotelsDesc: 'Encuentra el hospedaje ideal para tu viaje.',
    experiencesTitle: 'Vive algo inolvidable',
    experiencesDesc: 'Tours, entradas y experiencias para recordar.',
    transportTitle: 'Muévete sin complicaciones',
    transportDesc: 'Compara trenes, buses y conexiones.',
    esimTitle: 'Llega conectado',
    esimDesc: 'Activa datos para tu destino con una eSIM.',
    explore: 'Explorar',
    compare: 'Comparar',
    preview: 'Vista previa',
    trust: 'Se abre en una pestaña nueva · ITBMO continúa aquí'
  } : {
    loadingEyebrow: 'While Astra builds your trip',
    loadingTitle: 'Your journey can start right now',
    loadingSub: 'Explore flights, stays and experiences while Astra keeps working in this tab.',
    afterEyebrow: 'Your trip has taken shape',
    afterTitle: 'Now make it happen',
    afterSub: 'Take the next step. Compare, explore and book the essentials for your adventure.',
    flightsTitle: 'Find your next flight',
    flightsDesc: 'Compare options to get to your destination.',
    hotelsTitle: 'Choose where to stay',
    hotelsDesc: 'Find the right stay for your trip.',
    experiencesTitle: 'Make it unforgettable',
    experiencesDesc: 'Tours, tickets and experiences worth remembering.',
    transportTitle: 'Move with ease',
    transportDesc: 'Compare trains, buses and connections.',
    esimTitle: 'Land connected',
    esimDesc: 'Get data for your destination with an eSIM.',
    explore: 'Explore',
    compare: 'Compare',
    preview: 'Preview',
    trust: 'Opens in a new tab · ITBMO keeps working here'
  };
}

function _affiliateIcon_(key){
  const common = 'viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"';
  const icons = {
    flights:`<svg ${common}><path d="M28 14.4 18.8 17l-6.2-10.1-2.7.8 3.4 10.8-6.2 1.8-3-3.2-2 .6 2.5 5.2 1.1 2.4 2-.6.8-4.2 6.2-1.8.2 11.3 2.7-.8 1.7-11.8 9.2-2.7c1.3-.4 2-1.7 1.6-3-.4-1.3-1.7-2-3-1.6Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    hotels:`<svg ${common}><path d="M5 23V11.5A2.5 2.5 0 0 1 7.5 9H12a3 3 0 0 1 3 3v11M15 15h8.5A3.5 3.5 0 0 1 27 18.5V23M5 19h22M7 23v3M25 23v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 13h3.5a1.5 1.5 0 0 1 1.5 1.5V16H8v-3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
    experiences:`<svg ${common}><path d="M7 8.5h18a2 2 0 0 1 2 2v4.2a3.7 3.7 0 0 0 0 7.4v-.1a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v.1a3.7 3.7 0 0 0 0-7.4v-4.2a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M16 11.5v2M16 18.5v2M16 25.5v-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    transport:`<svg ${common}><rect x="7" y="4.5" width="18" height="21" rx="5" stroke="currentColor" stroke-width="1.8"/><path d="M10 15h12M11.5 9h9M11 27.5l2-2M21 27.5l-2-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="11.5" cy="20.5" r="1.3" fill="currentColor"/><circle cx="20.5" cy="20.5" r="1.3" fill="currentColor"/></svg>`,
    esim:`<svg ${common}><rect x="9" y="3.5" width="14" height="25" rx="4" stroke="currentColor" stroke-width="1.8"/><path d="M13.5 8h5M15 24.5h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M13 17.5a4.2 4.2 0 0 1 6 0M14.8 19.4a1.7 1.7 0 0 1 2.4 0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`
  };
  return icons[key] || icons.flights;
}

function _affiliatePartnerVisible_(partner){
  return !!(partner && (ITBMO_AFFILIATE_CONFIG.previewMode || (partner.enabled && partner.url)));
}

function _affiliatePartnerUrl_(partner){
  if(!partner) return '';
  if(partner.enabled && partner.url) return partner.url;
  if(ITBMO_AFFILIATE_CONFIG.previewMode) return partner.previewUrl || '';
  return '';
}

function _affiliateTrack_(partnerKey, placement){
  try{
    const partner = ITBMO_AFFILIATE_CONFIG.partners[partnerKey];
    const destination = activeCity || savedDestinations?.[0]?.city || '';
    if(typeof window !== 'undefined' && typeof window.gtag === 'function'){
      window.gtag('event','affiliate_click',{
        partner: partnerKey,
        partner_name: partner?.name || partnerKey,
        placement,
        destination
      });
    }
  }catch(_){}
}

function _affiliateCategoryModel_(){
  const c = _affiliateCopy_();
  return [
    { key:'flights', featured:true, title:c.flightsTitle, desc:c.flightsDesc, partners:['kayak','skyscanner'] },
    { key:'hotels', title:c.hotelsTitle, desc:c.hotelsDesc, partners:['booking'] },
    { key:'experiences', title:c.experiencesTitle, desc:c.experiencesDesc, partners:['getyourguide','viator'] },
    { key:'transport', title:c.transportTitle, desc:c.transportDesc, partners:['omio'] },
    { key:'esim', title:c.esimTitle, desc:c.esimDesc, partners:['airalo','holafly'] }
  ];
}

function _affiliateBrandClass_(key){
  const map={kayak:'kayak',skyscanner:'skyscanner',booking:'booking',getyourguide:'gyg',viator:'viator',omio:'omio',airalo:'airalo',holafly:'holafly'};
  return map[key] || 'default';
}

function _affiliatePartnerCopy_(key){
  const es=getLang()==='es';
  const copy={
    kayak: es ? ['Vuelos','Compara tus vuelos','Explora opciones para llegar a tus destinos.','Buscar vuelos'] : ['Flights','Compare flights','Explore options to reach your destinations.','Search flights'],
    skyscanner: es ? ['Vuelos','Compara más opciones','Explora alternativas de vuelo para tus destinos.','Comparar vuelos'] : ['Flights','Compare more options','Explore additional flight options for your destinations.','Compare flights'],
    booking: es ? ['Hospedaje','Encuentra tu alojamiento','Busca y compara alojamiento para tus destinos.','Buscar hoteles'] : ['Stays','Find your stay','Search and compare stays for your destinations.','Search hotels'],
    getyourguide: es ? ['Experiencias','Reserva actividades','Tours, entradas y actividades en destino.','Explorar experiencias'] : ['Experiences','Book activities','Tours, tickets and activities at your destination.','Explore experiences'],
    viator: es ? ['Experiencias','Explora tours','Compara excursiones y actividades disponibles.','Ver actividades'] : ['Experiences','Explore tours','Compare excursions and available activities.','View activities'],
    omio: es ? ['Transporte','Conecta tus destinos','Trenes, autobuses y conexiones entre destinos.','Buscar transporte'] : ['Transport','Connect your destinations','Trains, buses and connections between destinations.','Search transport'],
    airalo: es ? ['eSIM','Llega conectado','Opciones de datos móviles para tu destino.','Ver eSIM'] : ['eSIM','Land connected','Mobile data options for your destination.','View eSIM'],
    holafly: es ? ['eSIM','Datos para tu viaje','Alternativas para mantenerte conectado al viajar.','Explorar conectividad'] : ['eSIM','Data for your trip','Alternatives to stay connected while traveling.','Explore connectivity']
  };
  return copy[key] || ['',key,'','Explorar'];
}

function renderAffiliateSurface(placement='loading'){
  const root = placement==='loading' ? $affiliateLoading : $affiliateAfter;
  if(!root) return false;

  const c = _affiliateCopy_();
  const order=['kayak','skyscanner','booking','omio','getyourguide','viator','airalo','holafly'];
  const visible=order.filter(key=>_affiliatePartnerVisible_(ITBMO_AFFILIATE_CONFIG.partners[key]));

  if(!visible.length){
    root.innerHTML='';
    root.style.display='none';
    return false;
  }

  const isLoading=placement==='loading';
  const eyebrow=isLoading ? c.loadingEyebrow : c.afterEyebrow;
  const title=isLoading ? c.loadingTitle : c.afterTitle;
  const sub=isLoading ? c.loadingSub : c.afterSub;

  root.innerHTML=`
    <div class="itbmo-affiliate-shell itbmo-affiliate-shell--${placement}">
      <div class="itbmo-affiliate-heading">
        <div class="itbmo-affiliate-eyebrow"><span class="itbmo-affiliate-spark">✦</span><span>${eyebrow}</span>${ITBMO_AFFILIATE_CONFIG.previewMode ? `<span class="itbmo-affiliate-preview">${c.preview}</span>`:''}</div>
        <h3>${title}</h3><p>${sub}</p>
      </div>
      <div class="itbmo-affiliate-grid itbmo-affiliate-grid--brands" data-count="${visible.length}">
        ${visible.map(key=>{
          const p=ITBMO_AFFILIATE_CONFIG.partners[key];
          const pc=_affiliatePartnerCopy_(key);
          const url=_affiliatePartnerUrl_(p);
          return `<article class="itbmo-affiliate-card itbmo-affiliate-brand-card itbmo-affiliate-brand-card--${_affiliateBrandClass_(key)}">
            <div class="itbmo-affiliate-brand-head"><strong>${p.name}</strong>${ITBMO_AFFILIATE_CONFIG.previewMode?`<span>${c.preview}</span>`:''}</div>
            <div class="itbmo-affiliate-brand-body"><small>${pc[0]}</small><h4>${pc[1]}</h4><p>${pc[2]}</p>
              <a class="itbmo-affiliate-link" href="${url}" target="_blank" rel="sponsored noopener noreferrer" data-affiliate-partner="${key}" data-affiliate-placement="${placement}"><span>${pc[3]}</span><span class="itbmo-affiliate-arrow">↗</span></a>
            </div>
          </article>`;
        }).join('')}
      </div>
      <div class="itbmo-affiliate-trust"><span class="itbmo-affiliate-trust-dot"></span><span>${c.trust}</span></div>
    </div>`;
  root.style.display='block';
  qsa('[data-affiliate-partner]',root).forEach(a=>a.addEventListener('click',()=>_affiliateTrack_(a.dataset.affiliatePartner,a.dataset.affiliatePlacement||placement)));
  return true;
}

function setLoadingAffiliateVisibility(on){
  if(!$affiliateLoading) return;
  if(!on){
    $affiliateLoading.style.display='none';
    return;
  }
  renderAffiliateSurface('loading');
}

function refreshPostItineraryAffiliate(){
  if(!$affiliateAfter) return;
  const city = activeCity;
  const hasRows = !!(city && itineraries?.[city] &&
    Object.values(itineraries[city].byDay||{}).some(rows=>Array.isArray(rows) && rows.length));
  if(!hasRows){
    $affiliateAfter.innerHTML='';
    $affiliateAfter.style.display='none';
    return;
  }
  renderAffiliateSurface('after');
}

// 📌 Info Chat (IDs según tu HTML)
const $infoToggle   = qs('#info-chat-toggle');
const $infoModal    = qs('#info-chat-modal');
const $infoInput    = qs('#info-chat-input');
const $infoSend     = qs('#info-chat-send');
const $infoClose    = qs('#info-chat-close');
const $infoMinimize = qs('#info-chat-minimize');
const $infoMessages = qs('#info-chat-messages');
const $infoInlineNotice = qs('#info-chat-inline-notice');
const $infoInlineNoticeTitle = qs('#info-chat-inline-notice-title');
const $infoInlineNoticeMessage = qs('#info-chat-inline-notice-message');
const $infoInlineNoticeOk = qs('#info-chat-inline-notice-ok');
const $infoFloating = qs('#info-chat-floating');

const $sidebar = qs('.sidebar');
const $resetBtn = qs('#reset-planner');

const $plannerLanguageHelp = qs('#planner-language-help');
const $plannerLanguageHelpLabel = qs('#planner-language-help-label');
const $plannerLanguagePopover = qs('#planner-language-popover');
const $plannerLanguagePopoverClose = qs('#planner-language-popover-close');
const $plannerLanguagePopoverTitle = qs('#planner-language-popover-title');
const $plannerLanguagePopoverCopy = qs('#planner-language-popover-copy');
const $plannerLanguagePopoverNote = qs('#planner-language-popover-note');

const $preferencesStage = qs('#preferences-stage');
const $preferencesField = qs('#special-conditions');
const $preferencesContinue = qs('#continue-with-astra');

/* ---------- ITBMO Account / Supabase ---------- */
const $accountGuest = qs('#account-guest');
const $accountAuthenticated = qs('#account-authenticated');
const $accountRegisterToggle = qs('#account-register-toggle');
const $accountLoginToggle = qs('#account-login-toggle');
const $accountRegisterPanel = qs('#account-register-panel');
const $accountLoginPanel = qs('#account-login-panel');
const $accountRegisterSubmit = qs('#account-register-submit');
const $accountLoginSubmit = qs('#account-login-submit');
const $accountMessage = qs('#account-message');
const $accountUserBadge = qs('#account-user-badge');
const $accountWelcome = qs('#account-welcome');
const $accountReadyCopy = qs('#account-ready-copy');

const $accountFirstName = qs('#account-first-name');
const $accountLastName = qs('#account-last-name');
const $accountUsername = qs('#account-username');
const $accountEmail = qs('#account-email');
const $accountAgeRange = qs('#account-age-range');
const $accountCountry = qs('#account-country');
const $accountLegalConsent = qs('#account-legal-consent');
const $accountMarketingConsent = qs('#account-marketing-consent');
const $accountLoginUsername = qs('#account-login-username');
const $accountLoginEmail = qs('#account-login-email');

const $travelerMode      = qs('#traveler-mode');
const $travelerSoloPanel = qs('#traveler-solo-panel');
const $travelerGroupPanel= qs('#traveler-group-panel');

const $soloGender   = qs('#solo-gender');
const $soloAgeRange = qs('#solo-age-range');

const $travelerProfiles = qs('#traveler-profiles');
const $travelerAdd      = qs('#traveler-add');
const $travelerRemove   = qs('#traveler-remove');

/* =========================================================
   ITBMO ACCOUNT — Registro / Login + sesión persistente
   - Frontend: solo UX + token local.
   - Backend real: /api/user.
   - Nunca expone SUPABASE_SECRET_KEY.
========================================================= */
const AUTH_COPY = {
  es: {
    title:'Tu cuenta ITBMO',
    subtitle:'Regístrate una sola vez y sigue planificando sin volver a ingresar tus datos.',
    register:'Registrarse',
    login:'Iniciar sesión',
    firstName:'Nombre',
    lastName:'Apellidos',
    username:'Nombre de usuario',
    usernameHint:'3–30 caracteres: letras, números, punto, guion o guion bajo.',
    email:'Email',
    profileAge:'Rango de edad',
    country:'País de residencia',
    create:'Crear cuenta gratis',
    signIn:'Iniciar sesión',
    legalPrefix:'Acepto los ',
    terms:'Términos de Uso',
    legalMiddle:' y reconozco la ',
    privacy:'Política de Privacidad',
    legalSuffix:'.',
    marketing:'Quiero recibir inspiración de viaje, recomendaciones y ofertas especiales de ITBMO.',
    welcome:(name)=>`Hola, ${name} 👋`,
    ready:'Tu perfil está activo en este dispositivo. Continúa planificando normalmente.',
    registering:'Creando tu cuenta…',
    signingIn:'Iniciando sesión…',
    required:'Completa todos los campos obligatorios.',
    legalRequired:'Debes aceptar los Términos de Uso y la Política de Privacidad.',
    usernameInvalid:'El nombre de usuario debe tener 3–30 caracteres y usar solo letras minúsculas, números, punto, guion o guion bajo.',
    emailInvalid:'Ingresa un email válido.',
    duplicateUser:'Ese nombre de usuario ya está en uso.',
    duplicateEmail:'Ese email ya está registrado. Usa “Iniciar sesión”.',
    registerFail:'No pudimos crear tu cuenta. Intenta nuevamente.',
    loginFail:'El nombre de usuario y el email no coinciden.',
    connectionFail:'No se pudo conectar con tu cuenta ITBMO. Intenta nuevamente.',
    loginRequired:'Regístrate o inicia sesión antes de guardar destinos.',
    travelerRequired:'Indica con quién viajas antes de guardar destinos.',
    companionRequired:'Indica género y rango de edad de cada acompañante.',
    tripSaving:'Guardando tu viaje…',
    tripFail:'No pudimos guardar el viaje. Tus datos no se perdieron; intenta nuevamente.'
  },
  en: {
    title:'Your ITBMO account',
    subtitle:'Register once and keep planning without entering your details again.',
    register:'Register',
    login:'Sign in',
    firstName:'First name',
    lastName:'Last name',
    username:'Username',
    usernameHint:'3–30 characters: letters, numbers, dot, hyphen or underscore.',
    email:'Email',
    profileAge:'Age range',
    country:'Country of residence',
    create:'Create free account',
    signIn:'Sign in',
    legalPrefix:'I agree to the ',
    terms:'Terms of Use',
    legalMiddle:' and acknowledge the ',
    privacy:'Privacy Policy',
    legalSuffix:'.',
    marketing:'Send me travel inspiration, recommendations and special offers from ITBMO.',
    welcome:(name)=>`Hi, ${name} 👋`,
    ready:'Your profile is active on this device. Continue planning normally.',
    registering:'Creating your account…',
    signingIn:'Signing in…',
    required:'Complete all required fields.',
    legalRequired:'You must accept the Terms of Use and Privacy Policy.',
    usernameInvalid:'Username must contain 3–30 lowercase letters, numbers, dots, hyphens or underscores.',
    emailInvalid:'Enter a valid email.',
    duplicateUser:'That username is already in use.',
    duplicateEmail:'That email is already registered. Use “Sign in”.',
    registerFail:'We could not create your account. Please try again.',
    loginFail:'Username and email do not match.',
    connectionFail:'Could not connect to your ITBMO account. Please try again.',
    loginRequired:'Register or sign in before saving destinations.',
    travelerRequired:'Tell us who you are traveling with before saving destinations.',
    companionRequired:'Select gender and age range for every companion.',
    tripSaving:'Saving your trip…',
    tripFail:'We could not save the trip. Your entries are still here; please try again.'
  }
};

function authCopy(key, ...args){
  const pack = AUTH_COPY[getLang()] || AUTH_COPY.en;
  const value = pack[key];
  return typeof value === 'function' ? value(...args) : (value || '');
}

function setAccountMessage(message='', type=''){
  if(!$accountMessage) return;
  $accountMessage.textContent = message;
  $accountMessage.classList.remove('error','success');
  if(type) $accountMessage.classList.add(type);
}

function getStoredSessionToken(){
  try{ return String(localStorage.getItem(ITBMO_SESSION_KEY) || '').trim(); }
  catch(_){ return ''; }
}

function storeSessionToken(token){
  try{
    if(token) localStorage.setItem(ITBMO_SESSION_KEY, token);
  }catch(_){}
}

function clearSessionToken(){
  try{ localStorage.removeItem(ITBMO_SESSION_KEY); }catch(_){}
}

function setAuthBusy(on){
  [$accountRegisterSubmit,$accountLoginSubmit,$accountRegisterToggle,$accountLoginToggle]
    .forEach(el=>{ if(el) el.disabled = !!on; });
}

function updateSaveAvailability(){
  if(!$save) return;
  const lockedForCurrentTrip = Boolean(hasSavedOnce || planningStarted);
  $save.disabled = !currentUser || lockedForCurrentTrip;
  $save.setAttribute('aria-disabled', String($save.disabled));
}

function showAccountMode(mode){
  if(currentUser) return;
  if($accountRegisterPanel) $accountRegisterPanel.style.display = mode === 'register' ? 'block' : 'none';
  if($accountLoginPanel) $accountLoginPanel.style.display = mode === 'login' ? 'block' : 'none';
  setAccountMessage('');
}

function renderAuthState(){
  const logged = !!currentUser;

  if($accountGuest) $accountGuest.style.display = logged ? 'none' : 'block';
  if($accountAuthenticated) $accountAuthenticated.style.display = logged ? 'flex' : 'none';

  if($accountUserBadge){
    $accountUserBadge.style.display = logged ? 'inline-flex' : 'none';
    $accountUserBadge.textContent = logged ? `@${currentUser.username || ''}` : '';
  }

  if(logged){
    if($accountWelcome) $accountWelcome.textContent = authCopy('welcome', currentUser.first_name || currentUser.username || 'Traveler');
    if($accountReadyCopy) $accountReadyCopy.textContent = authCopy('ready');
  }

  updateSaveAvailability();
}

function applyAuthLanguage(){
  const set = (sel, txt)=>{ const el=qs(sel); if(el) el.textContent=txt; };

  set('#account-title', authCopy('title'));
  set('#account-subtitle', authCopy('subtitle'));
  set('#account-register-toggle', authCopy('register'));
  set('#account-login-toggle', authCopy('login'));
  set('#label-first-name', authCopy('firstName'));
  set('#label-last-name', authCopy('lastName'));
  set('#label-username', authCopy('username'));
  set('#username-hint', authCopy('usernameHint'));
  set('#label-email', authCopy('email'));
  set('#label-profile-age', authCopy('profileAge'));
  set('#label-country-residence', authCopy('country'));
  set('#label-login-username', authCopy('username'));
  set('#label-login-email', authCopy('email'));
  set('#account-register-submit', authCopy('create'));
  set('#account-login-submit', authCopy('signIn'));
  set('#account-marketing-copy', authCopy('marketing'));

  const legal = qs('#account-legal-copy');
  const terms = qs('#account-terms-link');
  const privacy = qs('#account-privacy-link');
  if(legal && terms && privacy){
    legal.innerHTML = '';
    legal.appendChild(document.createTextNode(authCopy('legalPrefix')));
    terms.textContent = authCopy('terms');
    legal.appendChild(terms);
    legal.appendChild(document.createTextNode(authCopy('legalMiddle')));
    privacy.textContent = authCopy('privacy');
    legal.appendChild(privacy);
    legal.appendChild(document.createTextNode(authCopy('legalSuffix')));
  }

  renderAuthState();
}

const ISO_COUNTRY_CODES = `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(/\s+/);

function populateAccountCountries(){
  if(!$accountCountry || $accountCountry.options.length > 1) return;

  let names = null;
  try{
    names = new Intl.DisplayNames([getLang()], { type:'region' });
  }catch(_){}

  const rows = ISO_COUNTRY_CODES.map(code=>({
    code,
    name: names ? (names.of(code) || code) : code
  })).sort((a,b)=>String(a.name).localeCompare(String(b.name), getLang()));

  rows.forEach(({code,name})=>{
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    $accountCountry.appendChild(opt);
  });
}

async function postUserAction(payload){
  const response = await fetch(USER_API_URL, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });

  let data = {};
  try{ data = await response.json(); }catch(_){}
  return { response, data };
}

async function registerITBMOUser(){
  const first_name = String($accountFirstName?.value || '').trim();
  const last_name = String($accountLastName?.value || '').trim();
  const username = String($accountUsername?.value || '').trim().toLowerCase();
  const email = String($accountEmail?.value || '').trim().toLowerCase();
  const age_range = String($accountAgeRange?.value || '').trim();
  const country_code = String($accountCountry?.value || '').trim().toUpperCase();

  if(!first_name || !last_name || !username || !email || !age_range || !country_code){
    setAccountMessage(authCopy('required'),'error');
    return;
  }

  if(!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)){
    setAccountMessage(authCopy('usernameInvalid'),'error');
    return;
  }

  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    setAccountMessage(authCopy('emailInvalid'),'error');
    return;
  }

  if(!$accountLegalConsent?.checked){
    setAccountMessage(authCopy('legalRequired'),'error');
    return;
  }

  setAuthBusy(true);
  setAccountMessage(authCopy('registering'));

  try{
    const params = new URLSearchParams(window.location.search);
    const { response, data } = await postUserAction({
      action:'register',
      first_name,
      last_name,
      username,
      email,
      age_range,
      country_code,
      preferred_language:getLang(),
      terms_accepted:true,
      privacy_accepted:true,
      marketing_consent:!!$accountMarketingConsent?.checked,
      terms_version:ITBMO_TERMS_VERSION,
      privacy_version:ITBMO_PRIVACY_VERSION,
      marketing_version:ITBMO_MARKETING_VERSION,
      terms_url:qs('#account-terms-link')?.href || null,
      privacy_url:qs('#account-privacy-link')?.href || null,
      registration_source:'planner',
      utm_source:params.get('utm_source') || null,
      utm_medium:params.get('utm_medium') || null,
      utm_campaign:params.get('utm_campaign') || null,
      utm_content:params.get('utm_content') || null,
      utm_term:params.get('utm_term') || null,
      referrer:document.referrer || null
    });

    if(response.ok && data?.ok && data?.session_token){
      storeSessionToken(data.session_token);
      currentUser = data.user || null;
      authReady = true;
      setAccountMessage('');
      renderAuthState();
      return;
    }

    if(response.status === 409){
      if(data?.username_taken) setAccountMessage(authCopy('duplicateUser'),'error');
      else if(data?.email_taken) setAccountMessage(authCopy('duplicateEmail'),'error');
      else setAccountMessage(authCopy('registerFail'),'error');
      return;
    }

    setAccountMessage(authCopy('registerFail'),'error');
  }catch(err){
    console.error('ITBMO register error:', err);
    setAccountMessage(authCopy('connectionFail'),'error');
  }finally{
    setAuthBusy(false);
  }
}

async function loginITBMOUser(){
  const username = String($accountLoginUsername?.value || '').trim().toLowerCase();
  const email = String($accountLoginEmail?.value || '').trim().toLowerCase();

  if(!username || !email){
    setAccountMessage(authCopy('required'),'error');
    return;
  }

  setAuthBusy(true);
  setAccountMessage(authCopy('signingIn'));

  try{
    const { response, data } = await postUserAction({
      action:'login',
      username,
      email
    });

    if(response.ok && data?.ok && data?.session_token){
      storeSessionToken(data.session_token);
      currentUser = data.user || null;
      authReady = true;
      setAccountMessage('');
      renderAuthState();
      return;
    }

    setAccountMessage(authCopy('loginFail'),'error');
  }catch(err){
    console.error('ITBMO login error:', err);
    setAccountMessage(authCopy('connectionFail'),'error');
  }finally{
    setAuthBusy(false);
  }
}

async function restoreITBMOSession(){
  const token = getStoredSessionToken();

  if(!token){
    authReady = true;
    currentUser = null;
    renderAuthState();
    return;
  }

  try{
    const { response, data } = await postUserAction({
      action:'session',
      session_token:token
    });

    if(response.ok && data?.ok && data?.user){
      currentUser = data.user;
    }else{
      clearSessionToken();
      currentUser = null;
    }
  }catch(err){
    console.warn('ITBMO session restore unavailable:', err);
    currentUser = null;
  }finally{
    authReady = true;
    renderAuthState();
  }
}

function bindAccountListeners(){
  $accountRegisterToggle?.addEventListener('click', ()=>showAccountMode('register'));
  $accountLoginToggle?.addEventListener('click', ()=>showAccountMode('login'));
  $accountRegisterSubmit?.addEventListener('click', registerITBMOUser);
  $accountLoginSubmit?.addEventListener('click', loginITBMOUser);

  $accountUsername?.addEventListener('input', ()=>{
    const normalized = String($accountUsername.value || '').toLowerCase().replace(/[^a-z0-9._-]/g,'');
    if($accountUsername.value !== normalized) $accountUsername.value = normalized;
  });

  populateAccountCountries();
  applyAuthLanguage();
  updateSaveAvailability();
}

/* =========================================================
   Travelers → contador técnico existente del planner
   La cuenta representa al titular (adulto 18+).
   Los acompañantes se traducen a los 5 buckets ya usados
   por plannerState para NO romper el contrato existente.
========================================================= */
function companionBucket(age){
  if(age === '0-2' || age === '3-5') return 'infants';
  if(age === '6-12') return 'children';
  if(age === '13-17') return 'young';
  if(age === '65+') return 'seniors';
  return 'adults';
}

function collectTravelerStateFromUI(){
  const mode = String($travelerMode?.value || '').toLowerCase();
  if(mode !== 'solo' && mode !== 'group'){
    return { ok:false, error:authCopy('travelerRequired') };
  }

  const counts = { adults:0, young:0, children:0, infants:0, seniors:0 };

  const primary = {
    age_range: String(currentUser?.age_range || '') || null,
    country_code: String(currentUser?.country_code || '') || null
  };

  if(primary.age_range === '65+') counts.seniors += 1;
  else counts.adults += 1;

  const companions = [];

  if(mode === 'group'){
    const cards = qsa('.traveler-profile', $travelerProfiles);
    if(cards.length === 0){
      return { ok:false, error:authCopy('companionRequired') };
    }

    for(const card of cards){
      const gender = String(qs('.traveler-gender',card)?.value || '');
      const age = String(qs('.traveler-age-range',card)?.value || '');

      if(!gender || !age){
        return { ok:false, error:authCopy('companionRequired') };
      }

      counts[companionBucket(age)] += 1;
      companions.push({ gender, age_range:age });
    }
  }

  const total = Object.values(counts).reduce((a,b)=>a+b,0);

  return { ok:true, mode, counts, primary, companions, total };
}

function writeLegacyTravelerCounts(counts){
  const mapping = {
    '#p-adults':'adults',
    '#p-young':'young',
    '#p-children':'children',
    '#p-infants':'infants',
    '#p-seniors':'seniors'
  };
  Object.entries(mapping).forEach(([sel,key])=>{
    const el = qs(sel);
    if(el) el.value = String(Number(counts?.[key] || 0));
  });
}

function dmyToISO(value){
  const d = parseDMY(String(value || '').trim());
  if(!d) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

async function saveTripRecord(list, travelerState){
  const token = getStoredSessionToken();
  if(!token || !currentUser) throw new Error('AUTH_REQUIRED');

  const firstISO = list.length ? dmyToISO(list[0].baseDate) : null;
  let finalISO = null;

  if(list.length){
    const last = list[list.length-1];
    const base = parseDMY(last.baseDate);
    if(base){
      const end = new Date(base);
      end.setDate(end.getDate() + Math.max(1,Number(last.days || 1)) - 1);
      finalISO = `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
    }
  }

  const destinations = list.map(d=>({
    city:d.city,
    country:d.country,
    days:d.days,
    base_date:dmyToISO(d.baseDate),
    per_day:Array.isArray(d.perDay) ? d.perDay : []
  }));

  const body = {
    action:'create',
    session_token:token,
    trip_name:list.map(x=>x.city).filter(Boolean).join(' · ').slice(0,150) || null,
    start_date:firstISO,
    end_date:finalISO,
    travelers_count:travelerState.total,
    travel_style:travelerState.mode,
    transportation:null,
    special_conditions:String(qs('#special-conditions')?.value || '').trim() || null,
    language:getLang(),
    destinations,
    planner_input:{
      destinations,
      traveler_mode:travelerState.mode,
      traveler_counts:travelerState.counts,
      primary_traveler:travelerState.primary,
      companion_profiles:travelerState.companions,
      special_conditions:String(qs('#special-conditions')?.value || '').trim() || null
    },
    planner_version:'v64',
    api_version:'v65'
  };

  const response = await fetch(TRIP_API_URL, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });

  let data = {};
  try{ data = await response.json(); }catch(_){}

  if(!response.ok || !data?.ok || !data?.trip?.id){
    if(response.status === 401){
      clearSessionToken();
      currentUser = null;
      renderAuthState();
    }
    throw new Error(data?.error || 'TRIP_SAVE_FAILED');
  }

  currentTripId = data.trip.id;
  return data.trip;
}

/* 🆕 Export buttons (PDF / CSV / Email) */
const $btnPDF   = qs('#btn-pdf');
const $btnCSV   = qs('#btn-csv');
const $btnReceipt = qs('#btn-receipt');
const $btnEmail = qs('#btn-email');
const $exportToolbar = qs('.toolbar');

function keepEmailExportComingSoon(){
  if(!$btnEmail) return;
  $btnEmail.disabled = true;
  $btnEmail.setAttribute('aria-disabled','true');
  $btnEmail.setAttribute('title', getLang()==='es' ? 'Próximamente' : 'Coming soon');
}

/* =========================================================
   QUIRÚRGICO v4 — Export actions visibility
   - Hidden before generation.
   - Revealed only when at least one real itinerary row exists.
   - Does not alter export logic.
========================================================= */
function hasGeneratedItineraryRows(){
  return Object.values(itineraries || {}).some(data=>
    Object.values(data?.byDay || {}).some(rows=>Array.isArray(rows) && rows.length > 0)
  );
}

function setExportToolbarVisibility(force){
  if(!$exportToolbar) return;
  const show = (typeof force === 'boolean') ? force : hasGeneratedItineraryRows();
  $exportToolbar.classList.toggle('itbmo-toolbar-ready', !!show);
  $exportToolbar.setAttribute('aria-hidden', show ? 'false' : 'true');
}

setExportToolbarVisibility(false);
keepEmailExportComingSoon();

function chatMsg(html, who='ai'){
  if(!html) return;
  const div = document.createElement('div');
  div.className = `chat-message ${who==='user'?'user':'ai'}`;
  div.innerHTML = String(html).replace(/\n/g,'<br>');
  $chatM.appendChild(div);
  $chatM.scrollTop = $chatM.scrollHeight;
  return div;
}

let thinkingTimer = null;
function showThinking(on){
  if(!$thinkingIndicator) return;
  if(on){
    if($thinkingIndicator.style.display==='flex') return;
    $thinkingIndicator.style.display = 'flex';
    let dots = $thinkingIndicator.querySelectorAll('span');
    let idx = 0;
    thinkingTimer = setInterval(()=>{
      dots.forEach((d,i)=> d.style.opacity = i===idx ? '1' : '0.3');
      idx = (idx+1)%3;
    }, 400);
  } else {
    clearInterval(thinkingTimer);
    $thinkingIndicator.style.display = 'none';
  }
}

function setChatBusy(on){
  if($chatI) $chatI.disabled = on;
  if($send)  $send.disabled  = on;
  showThinking(on);
}

function infoChatMsg(html, who='ai'){
  if(!html) return;
  const div = document.createElement('div');
  div.className = `chat-message ${who==='user'?'user':'ai'}`;
  div.innerHTML = String(html).replace(/\n/g,'<br>');
  const container = $infoMessages || qs('#info-chat-messages');
  if(!container) return;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

let infoTypingTimer = null;
const $infoTyping = document.createElement('div');
$infoTyping.className = 'chat-message ai typing';
// ✅ Puntos más grandes y llamativos
$infoTyping.innerHTML = `<span class="dot">•</span><span class="dot">•</span><span class="dot">•</span>`;

function setInfoChatBusy(on){
  const input = $infoInput || qs('#info-chat-input');
  const send  = $infoSend  || qs('#info-chat-send');
  if(input) input.disabled = on;
  if(send)  send.disabled  = on;

  const container = $infoMessages || qs('#info-chat-messages');
  if(container){
    if(on){
      if(!container.contains($infoTyping)){
        container.appendChild($infoTyping);
        container.scrollTop = container.scrollHeight;
      }
      let dots = $infoTyping.querySelectorAll('span.dot');
      let idx = 0;
      infoTypingTimer = setInterval(()=>{
        dots.forEach((d,i)=> d.style.opacity = i===idx ? '1' : '0.3');
        idx = (idx+1)%3;
      }, 400);
    } else {
      clearInterval(infoTypingTimer);
      if(container.contains($infoTyping)){
        container.removeChild($infoTyping);
      }
    }
  }
}

// ✅ Mejora UX del textarea: crece también cuando el texto hace wrap
function resizeInfoChatComposer(textarea){
  if(!textarea) return;
  textarea.style.height = 'auto';

  const styles = window.getComputedStyle(textarea);
  const maxHeight = parseFloat(styles.maxHeight) || 220;
  const nextHeight = Math.min(textarea.scrollHeight, maxHeight);

  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

if($infoInput){
  $infoInput.setAttribute('rows','1');
  resizeInfoChatComposer($infoInput);

  $infoInput.addEventListener('input', ()=>{
    resizeInfoChatComposer($infoInput);
  });

  // ✅ Shift+Enter → salto de línea | Enter → enviar
  $infoInput.addEventListener('keydown', e=>{
    if(e.key === 'Enter' && !e.shiftKey){
      e.preventDefault();
      const btn = $infoSend || qs('#info-chat-send');
      if(btn) btn.click();
    }
    // Shift+Enter deja pasar para crear nueva línea
  });
}

/* Nested chat scroll handoff.
   When a chat has reached its own edge, the existing Webflow parent bridge
   receives the remaining wheel movement so the embedded Planner does not
   trap page scrolling. */
function bindChatScrollHandoff(container){
  if(!container || container.dataset.itbmoScrollHandoff==='1') return;
  container.dataset.itbmoScrollHandoff='1';
  container.addEventListener('wheel',(event)=>{
    const atTop=container.scrollTop<=1;
    const atBottom=container.scrollTop+container.clientHeight>=container.scrollHeight-1;
    if(!((event.deltaY<0 && atTop) || (event.deltaY>0 && atBottom))) return;
    try{
      if(window.parent && window.parent!==window){
        window.parent.postMessage({type:'itbmo-scroll',deltaY:event.deltaY},'*');
      }else{
        window.scrollBy({top:event.deltaY,left:0,behavior:'auto'});
      }
    }catch(_){ }
  },{passive:true});
}

bindChatScrollHandoff($chatM);
bindChatScrollHandoff($infoMessages);

function autoFormatDMYInput(el){
  // 🆕 Placeholder visible + tooltip (UI consistente con DD/MM/AAAA)
  el.placeholder = 'DD/MM/AAAA';
  el.title = 'Formato: DD/MM/AAAA';
  el.addEventListener('input', ()=>{
    const v = el.value.replace(/\D/g,'').slice(0,8);
    if(v.length===8) el.value = `${v.slice(0,2)}/${v.slice(2,4)}/${v.slice(4,8)}`;
    else el.value = v;
  });
}

// - Se prefiere DD/MM cuando ambos son válidos.
function parseDMY(str){
  if(!str) return null;
  const m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(str.trim());
  if(!m) return null;

  const a = parseInt(m[1],10);
  const b = parseInt(m[2],10);
  const y = parseInt(m[3],10);

  const d1 = new Date(y, (b-1), a);
  const ok1 = (d1.getFullYear()===y && d1.getMonth()===(b-1) && d1.getDate()===a);

  const d2 = new Date(y, (a-1), b);
  const ok2 = (d2.getFullYear()===y && d2.getMonth()===(a-1) && d2.getDate()===b);

  if(ok1 && ok2){
    return d1;
  }
  if(ok1) return d1;
  if(ok2) return d2;
  return null;
}

function formatDMY(d){
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}
function addDays(d, n){ const x=new Date(d.getTime()); x.setDate(x.getDate()+n); return x; }
function addMinutes(hhmm, min){
  const [H,M] = (hhmm||DEFAULT_START).split(':').map(n=>parseInt(n||'0',10));
  const d = new Date(2000,0,1,H||0,M||0,0);
  d.setMinutes(d.getMinutes()+min);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function makeHoursBlock(days){
  const wrap = document.createElement('div');
  wrap.className = 'hours-block';

  // 🆕 Guía de horarios
  const guide = document.createElement('p');
  guide.className = 'time-hint';
  guide.textContent = t('uiTimeHint');
  wrap.appendChild(guide);

  const header = document.createElement('div');
  header.className = 'hours-header';
  header.innerHTML = `
    <span></span>
    <span class="header-start">${t('uiStartTime')}</span>
    <span class="header-end">${t('uiEndTime')}</span>
  `;
  wrap.appendChild(header);

  for(let d=1; d<=days; d++){
    const row = document.createElement('div');
    row.className = 'hours-day';
    row.innerHTML = `
      <span>${t('uiDay', d)}</span>
      <input class="start" type="time" aria-label="${t('uiAriaStart')}" placeholder="HH:MM">
      <input class="end"   type="time" aria-label="${t('uiAriaEnd')}"  placeholder="HH:MM">
    `;
    wrap.appendChild(row);
  }
  return wrap;
}

function updateAddCityButtonState(){
  if(!$addCity || !$cityList) return;
  const count=qsa('.city-row',$cityList).length;
  const atLimit=count>=MAX_ITINERARY_CITIES;
  $addCity.disabled=atLimit;
  $addCity.setAttribute('aria-disabled',atLimit?'true':'false');
  $addCity.title=atLimit
    ? (getLang()==='es' ? 'Máximo 3 ciudades por generación.' : 'Maximum 3 cities per generation.')
    : '';
}

function addCityRow(pref={city:'',country:'',days:'',baseDate:''}){
  if(!$cityList){
    console.error('[ITBMO] #city-list no encontrado. No se puede insertar city-row.');
    return;
  }

  const currentCount=qsa('.city-row',$cityList).length;
  if(currentCount>=MAX_ITINERARY_CITIES){
    updateAddCityButtonState();
    if(pref?.city){
      alert(getLang()==='es'
        ? 'Puedes incluir un máximo de 3 ciudades por generación.'
        : 'You can include a maximum of 3 cities per generation.');
    }
    return;
  }

  const row = document.createElement('div');
  row.className = 'city-row';
  row.innerHTML = `
    <label>${t('uiCity')}<input class="city" placeholder="${t('uiCity')}" value="${pref.city||''}"></label>
    <label>${t('uiCountry')}<input class="country" placeholder="${t('uiCountry')}" value="${pref.country||''}"></label>
    <label>${t('uiDays')}<select class="days"><option value="" selected disabled></option>${Array.from({length:30},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join('')}</select></label>
    <label class="date-label">
      ${t('uiStart')}
      <div class="date-wrapper">
        <input class="baseDate" placeholder="__/__/____" value="${pref.baseDate||''}">
        <small class="date-format">${t('uiDateFormatSmall')}</small>
      </div>
    </label>
    <button class="remove" type="button">✕</button>
  `;

  const baseDateEl = qs('.baseDate', row);

  if(baseDateEl){
    autoFormatDMYInput(baseDateEl);
  }

  const hoursWrap = document.createElement('div');
  hoursWrap.className = 'hours-block';
  row.appendChild(hoursWrap);

  const daysSelect = qs('.days', row);
  if(pref.days){
    daysSelect.value = String(pref.days);
    const tmp = makeHoursBlock(pref.days).children;
    Array.from(tmp).forEach(c=>hoursWrap.appendChild(c));
  }

  daysSelect.addEventListener('change', ()=>{
    const n = Math.max(0, parseInt(daysSelect.value||0,10));
    hoursWrap.innerHTML='';
    if(n>0){
      const tmp = makeHoursBlock(n).children;
      Array.from(tmp).forEach(c=>hoursWrap.appendChild(c));
    }
  });

  qs('.remove',row).addEventListener('click', ()=>{
    row.remove();
    updateAddCityButtonState();
  });
  $cityList.appendChild(row);
  updateAddCityButtonState();
}


/* =========================================================
   MULTILINGUAL PLANNER CAPABILITY
   ---------------------------------------------------------
   The site UI remains ES/EN, while free-text Planner interaction can
   use any currently supported language listed in the capability popover.
   ========================================================= */
function applyPlannerLanguageCapabilityCopy(){
  const es=getLang()==='es';

  if($plannerLanguageHelpLabel){
    $plannerLanguageHelpLabel.textContent=es ? 'Escribe en tu idioma' : 'Write in your language';
  }
  if($plannerLanguagePopoverTitle){
    $plannerLanguagePopoverTitle.textContent=es ? 'Usa tu idioma con ASTRA' : 'Use your language with ASTRA';
  }
  if($plannerLanguagePopoverCopy){
    $plannerLanguagePopoverCopy.textContent=es
      ? 'Escribe naturalmente en cualquier idioma soportado por el chat. ASTRA continuará la conversación de planificación en el idioma que utilices.'
      : 'Write naturally in any language supported by the chat. ASTRA will continue the planning conversation in the language you use.';
  }
  if($plannerLanguagePopoverNote){
    $plannerLanguagePopoverNote.textContent=es
      ? 'Si un idioma no es soportado, ASTRA te lo indicará en el chat. El idioma final del itinerario se selecciona más adelante durante la planificación.'
      : 'If a language is not supported, ASTRA will let you know in the chat. The final itinerary language is selected later in the planning flow.';
  }
  if($plannerLanguagePopoverClose){
    $plannerLanguagePopoverClose.setAttribute('aria-label',es ? 'Cerrar' : 'Close');
  }
}

function setPlannerLanguagePopover(open){
  if(!$plannerLanguageHelp || !$plannerLanguagePopover) return;
  $plannerLanguageHelp.setAttribute('aria-expanded',String(!!open));
  $plannerLanguagePopover.setAttribute('aria-hidden',String(!open));
  $plannerLanguagePopover.classList.toggle('is-open',!!open);
}

function bindPlannerLanguageCapability(){
  if(!$plannerLanguageHelp || !$plannerLanguagePopover) return;
  applyPlannerLanguageCapabilityCopy();

  $plannerLanguageHelp.addEventListener('click',(e)=>{
    e.preventDefault();
    e.stopPropagation();
    setPlannerLanguagePopover(!$plannerLanguagePopover.classList.contains('is-open'));
  });

  $plannerLanguagePopoverClose?.addEventListener('click',(e)=>{
    e.preventDefault();
    e.stopPropagation();
    setPlannerLanguagePopover(false);
  });

  $plannerLanguagePopover.addEventListener('click',(e)=>e.stopPropagation());

  document.addEventListener('click',()=>{
    setPlannerLanguagePopover(false);
  });

  document.addEventListener('keydown',(e)=>{
    if(e.key==='Escape') setPlannerLanguagePopover(false);
  });
}

/* =========================================================
   POST-PAYMENT PREFERENCES CHECKPOINT
   ---------------------------------------------------------
   Guardrails:
   - Account / travelers / destinations freeze after Save Destinations.
   - Preferences stay hidden until payment entitlement is confirmed.
   - Clicking Continue captures the SAME #special-conditions value into
     plannerState.specialConditions, then freezes the field.
   - startPlanning() itself is intentionally left unchanged.
   ========================================================= */
function setSavedSetupLocked(locked){
  ['#account-box','#travelers-box','#destinations-box'].forEach(sel=>{
    const el=qs(sel);
    if(!el) return;
    el.classList.toggle('is-setup-locked',!!locked);
    try{ el.inert=!!locked; }catch(_){}
    el.setAttribute('aria-disabled',locked?'true':'false');
  });

  if($save){
    $save.disabled=!!locked || !currentUser;
    $save.setAttribute('aria-disabled',String(!!locked || !currentUser));
  }
}

function autoGrowPreferencesField(){
  if(!$preferencesField) return;
  const minHeight=92;
  const maxHeight=260;
  $preferencesField.style.height='auto';
  const next=Math.max(minHeight,Math.min(maxHeight,$preferencesField.scrollHeight || minHeight));
  $preferencesField.style.height=`${next}px`;
  $preferencesField.style.overflowY=($preferencesField.scrollHeight > maxHeight) ? 'auto' : 'hidden';
}

function closePreferencesHelpPopovers(){
  qsa('.preferences-help-popover.is-open').forEach(pop=>{
    pop.classList.remove('is-open');
    pop.setAttribute('aria-hidden','true');
  });
  qsa('.preferences-help-button[aria-expanded="true"]').forEach(btn=>{
    btn.setAttribute('aria-expanded','false');
  });
}

function applyPreferencesStageLanguage(){
  if(!$preferencesStage) return;
  const es=getLang()==='es';
  const set=(sel,value)=>{ const el=qs(sel); if(el) el.textContent=value; };

  set('#preferences-stage-eyebrow', es ? 'Personalización ASTRA' : 'ASTRA personalization');
  set('#preferences-stage-title', es ? 'Personaliza tu viaje' : 'Personalize your trip');
  set(
    '#preferences-stage-intro',
    es
      ? 'Info Chat ya está disponible. Úsalo si necesitas investigar algo sobre tus destinos y, cuando estés listo, cuéntale a ASTRA cómo quieres vivir el viaje.'
      : 'Info Chat is now available. Use it if you want to research anything about your destinations, then tell ASTRA how you want to experience the trip.'
  );
  set(
    '#preferences-stage-field-title',
    es
      ? 'Preferencias / Restricciones / Condiciones especiales'
      : 'Preferences / Restrictions / Special conditions'
  );
  set(
    '#preferences-stage-optional',
    es
      ? 'Opcional · puedes continuar aunque no agregues información.'
      : 'Optional · you can continue without adding any information.'
  );

  if($preferencesContinue && !preferencesConfirmedTripId){
    $preferencesContinue.textContent=es ? 'Continuar con ASTRA →' : 'Continue with ASTRA →';
  }
}

function hidePreferencesStage({reset=false}={}){
  if(!$preferencesStage) return;
  $preferencesStage.classList.add('is-stage-hidden');
  $preferencesStage.classList.remove('is-stage-active','is-confirmed');
  $preferencesStage.setAttribute('aria-hidden','true');

  if(reset){
    preferencesStageTripId=null;
    preferencesConfirmedTripId=null;
    if($preferencesField){
      $preferencesField.readOnly=false;
      $preferencesField.removeAttribute('aria-readonly');
    }
    if($preferencesContinue){
      $preferencesContinue.disabled=false;
      $preferencesContinue.removeAttribute('aria-disabled');
    }
  }
}

function showPreferencesStage(){
  if(!$preferencesStage || !currentTripId) return;

  preferencesStageTripId=currentTripId;
  applyPreferencesStageLanguage();

  $preferencesStage.classList.remove('is-stage-hidden');
  $preferencesStage.classList.add('is-stage-active');
  $preferencesStage.setAttribute('aria-hidden','false');

  if($preferencesField){
    $preferencesField.readOnly=false;
    $preferencesField.removeAttribute('aria-readonly');
  }
  if($preferencesContinue){
    $preferencesContinue.disabled=false;
    $preferencesContinue.removeAttribute('aria-disabled');
  }

  /* Start Planning has already completed its job: payment + entitlement.
     It stays permanently disabled for this trip until Reset. */
  if($start){
    $start.disabled=true;
    $start.setAttribute('aria-disabled','true');
    $start.dataset.itbmoConsumed='1';
  }

  requestAnimationFrame(()=>{
    autoGrowPreferencesField();
    try{
      $preferencesStage.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});
    }catch(_){}
  });
}

function confirmPreferencesAndContinue(){
  if(!$preferencesStage || !$preferencesField || !currentTripId) return;
  if(preferencesStageTripId!==currentTripId) return;

  const confirmedValue=String($preferencesField.value || '').trim();

  /* CRITICAL: preserve the existing generation contract exactly. */
  if(typeof plannerState!=='undefined' && plannerState){
    plannerState.specialConditions=confirmedValue;
  }

  preferencesConfirmedTripId=currentTripId;

  $preferencesField.readOnly=true;
  $preferencesField.setAttribute('aria-readonly','true');
  $preferencesStage.classList.add('is-confirmed');

  if($preferencesContinue){
    $preferencesContinue.disabled=true;
    $preferencesContinue.setAttribute('aria-disabled','true');
    $preferencesContinue.textContent=getLang()==='es'
      ? '✓ Preferencias confirmadas'
      : '✓ Preferences confirmed';
  }

  /* Existing agent flow begins here, unchanged. */
  startPlanning();

  /* UX only: move the user directly to the agent input after confirmation. */
  setTimeout(()=>{
    try{
      $chatBox?.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});
      setTimeout(()=>{
        try{ $chatI?.focus({preventScroll:true}); }catch(_){ try{ $chatI?.focus(); }catch(__){} }
      },340);
    }catch(_){}
  },80);
}

async function normalizeDestinationsBeforeSave(list, rows){
  const response = await fetch(API_URL, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      mode:'normalize_destinations',
      language:getLang(),
      destinations:list.map(({city,country})=>({city,country}))
    })
  });

  let data=null;
  try{ data=await response.json(); }catch(_){ }
  if(!response.ok || !data?.ok || !Array.isArray(data.destinations) || data.destinations.length!==list.length){
    throw new Error(data?.code || 'DESTINATION_NORMALIZATION_FAILED');
  }

  const normalized=list.map((item,index)=>{
    const result=data.destinations.find(x=>Number(x?.index)===index);
    if(!result) throw new Error('DESTINATION_NORMALIZATION_INCOMPLETE');

    const status=String(result.status || '').toLowerCase();
    if(status==='ambiguous'){
      const question=String(result.question || '').trim();
      const fallback=getLang()==='es'
        ? `No pudimos confirmar con seguridad la ciudad “${item.city}”. Revísala e indica también el país.`
        : `We could not safely confirm the city “${item.city}”. Please review it and include the country.`;
      const error=new Error('DESTINATION_AMBIGUOUS');
      error.userMessage=question || fallback;
      error.rowIndex=index;
      throw error;
    }

    const city=String(result.city || '').trim();
    const country=String(result.country || item.country || '').trim();
    if(!city) throw new Error('DESTINATION_NORMALIZATION_INCOMPLETE');

    const row=rows[index];
    const cityInput=qs('.city',row);
    const countryInput=qs('.country',row);
    if(cityInput) cityInput.value=city;
    if(countryInput && country) countryInput.value=country;

    return {...item,city,country};
  });

  return normalized;
}

async function saveDestinations(){
  if(!currentUser || !getStoredSessionToken()){
    setAccountMessage(authCopy('loginRequired'),'error');
    try{ qs('#account-box')?.scrollIntoView({behavior:'smooth',block:'start'}); }catch(_){}
    return;
  }

  const travelerState = collectTravelerStateFromUI();
  if(!travelerState.ok){
    alert(travelerState.error);
    try{ $travelerMode?.scrollIntoView({behavior:'smooth',block:'center'}); }catch(_){}
    return;
  }

  writeLegacyTravelerCounts(travelerState.counts);

  const rows = qsa('.city-row', $cityList);
  if(rows.length>MAX_ITINERARY_CITIES){
    alert(getLang()==='es'
      ? 'Puedes incluir un máximo de 3 ciudades por generación.'
      : 'You can include a maximum of 3 cities per generation.');
    updateAddCityButtonState();
    return;
  }
  let list = [];

  rows.forEach(r=>{
    const city     = qs('.city',r).value.trim();
    const country  = qs('.country',r).value.trim().replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g,'');
    const daysVal  = qs('.days',r).value;
    const days     = Math.max(1, parseInt(daysVal||'0',10)||1);
    const baseDate = qs('.baseDate',r).value.trim();

    if(!city) return;

    const perDay = [];
    qsa('.hours-day', r).forEach((hd, idx)=>{
      const start = qs('.start',hd).value || DEFAULT_START;
      const end   = qs('.end',hd).value   || DEFAULT_END;
      perDay.push({ day: idx+1, start, end });
    });
    if(perDay.length===0){
      for(let d=1; d<=days; d++) perDay.push({day:d,start:DEFAULT_START,end:DEFAULT_END});
    }

    list.push({ city, country, days, baseDate, perDay });
  });

  if(list.length === 0) return;

  const previousSaveLabel = $save?.textContent || '';
  if($save){
    $save.disabled = true;
    $save.textContent = authCopy('tripSaving');
  }

  try{
    list = await normalizeDestinationsBeforeSave(list, rows);
    await saveTripRecord(list, travelerState);
  }catch(err){
    console.error('ITBMO trip save error:', err);
    if(err?.userMessage){
      alert(err.userMessage);
      const row=rows[Number(err.rowIndex) || 0];
      try{ qs('.city',row)?.focus(); }catch(_){ }
    }else if(String(err?.message || '').startsWith('DESTINATION_NORMALIZATION')){
      alert(getLang()==='es'
        ? 'No pudimos validar los destinos en este momento. Revísalos e inténtalo nuevamente.'
        : 'We could not validate the destinations right now. Please review them and try again.');
    }else{
      alert(authCopy('tripFail'));
    }
    if($save){
      $save.textContent = previousSaveLabel;
      updateSaveAvailability();
    }
    return;
  }

  if($save) $save.textContent = previousSaveLabel;

  list.forEach(({city, days})=>{
    const prevDays = itineraries[city] ? Object.keys(itineraries[city].byDay).length : 0;
    if(prevDays && days > prevDays){
      itineraries[city].byDay = {};
      for(let d=1; d<=days; d++){
        itineraries[city].byDay[d] = [];
      }
      // Marcar para regenerar en startPlanning
      if (typeof plannerState !== 'undefined') {
        if (!plannerState.forceReplan) plannerState.forceReplan = {};
        plannerState.forceReplan[city] = true;
      }
    }
  });

  savedDestinations = list;
  savedDestinations.forEach(({city,days,baseDate,perDay})=>{
    if(!itineraries[city]) itineraries[city] = { byDay:{}, currentDay:1, baseDate: baseDate||null, masterPlan:[], audit:null };
    if(!cityMeta[city]) cityMeta[city] = { baseDate: baseDate||null, start:null, end:null, hotel:'', transport:'', perDay: perDay||[] };
    else {
      cityMeta[city].baseDate = baseDate||null;
      cityMeta[city].perDay   = perDay||[];
    }
    for(let d=1; d<=days; d++){
      if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[];
    }
  });

  Object.keys(itineraries).forEach(c=>{ 
    if(!savedDestinations.find(x=>x.city===c)) delete itineraries[c]; 
  });
  Object.keys(cityMeta).forEach(c=>{ 
    if(!savedDestinations.find(x=>x.city===c)) delete cityMeta[c]; 
  });

  renderCityTabs();

  $start.disabled = savedDestinations.length === 0;
  hasSavedOnce = true;

  if ($resetBtn) {
    if (savedDestinations.length > 0) {
      $resetBtn.removeAttribute('disabled');
    } else {
      $resetBtn.setAttribute('disabled', 'true');
    }
  }

  if(!planningStarted){
    // Initial setup save: freeze only what has already been confirmed.
    // Preferences remain a separate post-payment checkpoint.
    setSavedSetupLocked(true);
    hidePreferencesStage({reset:true});

    /* Info Chat remains locked after Save Destinations.
       It unlocks only after server-side payment/admin entitlement is confirmed. */
    setInfoChatEntitlement({authorized:false,remaining:0,used:0,tripId:null});

    if (typeof plannerState !== 'undefined') {
      plannerState.destinations = [...savedDestinations];
      /* specialConditions is intentionally confirmed AFTER payment. */
      plannerState.specialConditions = '';
      plannerState.travelers = { ...travelerState.counts };
      plannerState.travelerProfiles = {
        mode: travelerState.mode,
        primary: travelerState.primary,
        companions: travelerState.companions
      };
      plannerState.budget = qs('#budget')?.value || '';
      plannerState.currency = qs('#currency')?.value || 'USD';
    }
  }else{
    /* Existing post-start reuse path preserved as it behaved before this upgrade. */
    if ($sidebar) $sidebar.classList.add('disabled');
    setInfoChatEntitlement({authorized:false,remaining:0,used:0,tripId:null});

    if (typeof plannerState !== 'undefined') {
      plannerState.destinations = [...savedDestinations];
      plannerState.specialConditions = (qs('#special-conditions')?.value || '').trim();
      plannerState.travelers = { ...travelerState.counts };
      plannerState.travelerProfiles = {
        mode: travelerState.mode,
        primary: travelerState.primary,
        companions: travelerState.companions
      };
      plannerState.budget = qs('#budget')?.value || '';
      plannerState.currency = qs('#currency')?.value || 'USD';
    }
  }

  /* QUIRÚRGICO v4: a newly saved plan must generate before export actions return. */
  setExportToolbarVisibility(false);

  /* QUIRÚRGICO v4: after saving, take the user directly to Start planning. */
  if($start && !$start.disabled){
    requestAnimationFrame(()=>{
      try{
        $start.scrollIntoView({behavior:'smooth', block:'center', inline:'nearest'});
        setTimeout(()=>{
          try{ $start.focus({preventScroll:true}); }catch(_){ }
        }, 420);
      }catch(_){ }
    });
  }
}

function setActiveCity(name){
  if(!name) return;
  activeCity = name;
  qsa('.city-tab', $tabs).forEach(b=>b.classList.toggle('active', b.dataset.city===name));
}

function renderCityTabs(){
  const prev = activeCity;
  $tabs.innerHTML = '';
  savedDestinations.forEach(({city})=>{
    const b = document.createElement('button');
    b.className = 'city-tab' + (city===prev?' active':'');
    b.textContent = city;
    b.dataset.city = city;
    b.addEventListener('click', ()=>{
      setActiveCity(city);
      renderCityItinerary(city);
    });
    $tabs.appendChild(b);
  });
  if(savedDestinations.length){
    const valid = prev && savedDestinations.some(x=>x.city===prev) ? prev : savedDestinations[0].city;
    setActiveCity(valid);
    renderCityItinerary(valid);
  }else{
    activeCity = null;
    $itWrap.innerHTML = '';
  }
}

function renderCityItinerary(city){
  if(!city || !itineraries[city]) return;
  const data = itineraries[city];
  const days = Object.keys(data.byDay||{}).map(n=>+n).sort((a,b)=>a-b);

  $itWrap.innerHTML = '';
  if(!days.length){
    $itWrap.innerHTML = `<p>${t('uiNoActivities')}</p>`;
    if($affiliateAfter) $affiliateAfter.style.display='none';
    syncImmersiveItineraryLauncher();
    return;
  }

  const base = parseDMY(data.baseDate || cityMeta[city]?.baseDate || '');
  const sections = [];

  function formatDurationForDisplay(val, transport=''){
    if(!val) return '';
    return _sanitizeDurationLines_(val, transport);
  }

  days.forEach(dayNum=>{
    const sec = document.createElement('div');
    sec.className = 'day-section';
    const dateLabel = base ? ` (${formatDMY(addDays(base, dayNum-1))})` : '';
    sec.innerHTML = `
      <div class="day-title"><strong>${t('uiDayTitle', dayNum)}</strong>${dateLabel}</div>
      <table class="itinerary">
        <thead>
          <tr>
            <th>${t('thStart')}</th><th>${t('thEnd')}</th><th>${t('thActivity')}</th><th>${t('thFrom')}</th>
            <th>${t('thTo')}</th><th>${t('thTransport')}</th><th>${t('thDuration')}</th><th>${t('thNotes')}</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    `;
    const tb = qs('tbody', sec);
    (data.byDay[dayNum]||[]).forEach(r=>{
      const cleanActivity = String(r.activity||'').replace(/^rev:\s*/i, '');
      const cleanNotes = String(r.notes||'').replace(/^\s*valid:\s*/i, '').trim();
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.start||''}</td>
        <td>${r.end||''}</td>
        <td>${cleanActivity}</td>
        <td>${r.from||''}</td>
        <td>${r.to||''}</td>
        <td>${r.transport||''}</td>
        <td>${formatDurationForDisplay(r.duration||'', r.transport||'')}</td>
        <td>${cleanNotes}</td>
      `;
      tb.appendChild(tr);
    });
    $itWrap.appendChild(sec);
    sections.push(sec);
  });

  const pager = document.createElement('div');
  pager.className = 'pager';
  const prev = document.createElement('button'); prev.textContent = '«';
  const next = document.createElement('button'); next.textContent = '»';
  pager.appendChild(prev);
  days.forEach(d=>{
    const b = document.createElement('button');
    b.textContent = d;
    b.dataset.day = d;
    pager.appendChild(b);
  });
  pager.appendChild(next);
  $itWrap.appendChild(pager);

  function show(n){
    sections.forEach((sec,i)=>sec.style.display = (days[i]===n?'block':'none'));
    qsa('button',pager).forEach(x=>x.classList.remove('active'));
    const btn = qsa('button',pager).find(x=>x.dataset.day==String(n));
    if(btn) btn.classList.add('active');
    prev.classList.toggle('ghost', n===days[0]);
    next.classList.toggle('ghost', n===days.at(-1));
    itineraries[city].currentDay = n;
  }
  pager.addEventListener('click', e=>{
    const t0 = e.target;
    if(t0===prev)      show(Math.max(days[0], (itineraries[city].currentDay||days[0])-1));
    else if(t0===next) show(Math.min(days.at(-1), (itineraries[city].currentDay||days[0])+1));
    else if(t0.dataset.day) show(+t0.dataset.day);
  });
  show(itineraries[city].currentDay || days[0]);

  // Post-itinerary monetization surface: independent of itinerary rendering.
  refreshPostItineraryAffiliate();

  // Immersive viewer launcher mirrors the already-generated state only.
  syncImmersiveItineraryLauncher();
}

/* =========================================================
   ITBMO · IMMERSIVE ITINERARY VIEWER · v77
   ---------------------------------------------------------
   Presentation-only layer:
   - Reads from the existing itineraries / cityMeta objects.
   - Does NOT call the itinerary API.
   - Does NOT mutate generated rows.
   - Does NOT change PDF / CSV / receipt logic.
   - The legacy flat renderer remains mounted but hidden by CSS.
========================================================= */
let immersiveItineraryCity = null;
let immersiveItineraryDay = null;
let immersiveTouchStartX = null;
let immersiveTouchStartY = null;
let immersiveRenderFrame = null;

function scheduleImmersiveItineraryRender(){
  if(immersiveRenderFrame!=null){
    cancelAnimationFrame(immersiveRenderFrame);
  }
  immersiveRenderFrame=requestAnimationFrame(()=>{
    immersiveRenderFrame=requestAnimationFrame(()=>{
      immersiveRenderFrame=null;
      renderImmersiveItinerary();
    });
  });
}

function _immersiveViewerCopy_(){
  const es = getLang()==='es';
  return es ? {
    ctaTitle:'Explora tu itinerario día a día',
    ctaSub:'Abre cada ciudad y recorre cada día en una vista inmersiva.',
    citySingular:'ciudad',
    cityPlural:'ciudades',
    daySingular:'día',
    dayPlural:'días',
    ready:'listos para explorar',
    eyebrow:'TU ITINERARIO ASTRA',
    title:'Tu viaje, día a día.',
    subtitle:'Elige una ciudad y recorre cada día a tu propio ritmo.',
    back:'Volver al Planner',
    close:'Cerrar itinerario',
    prev:'Día anterior',
    next:'Día siguiente',
    of:'de'
  } : {
    ctaTitle:'Explore your day-by-day itinerary',
    ctaSub:'Open every city and move through each day in an immersive view.',
    citySingular:'city',
    cityPlural:'cities',
    daySingular:'day',
    dayPlural:'days',
    ready:'ready to explore',
    eyebrow:'YOUR ASTRA ITINERARY',
    title:'Your trip, day by day.',
    subtitle:'Choose a city, then move through each day at your own pace.',
    back:'Back to Planner',
    close:'Close itinerary',
    prev:'Previous day',
    next:'Next day',
    of:'of'
  };
}

function _immersiveAvailableCities_(){
  const ordered = (savedDestinations||[]).map(x=>x.city).filter(Boolean);
  const extras = Object.keys(itineraries||{}).filter(city=>!ordered.includes(city));
  return [...ordered,...extras].filter(city=>{
    const byDay = itineraries?.[city]?.byDay || {};
    return Object.values(byDay).some(rows=>Array.isArray(rows) && rows.length);
  });
}

function _immersiveDaysForCity_(city){
  return Object.keys(itineraries?.[city]?.byDay || {})
    .map(Number)
    .filter(Number.isFinite)
    .sort((a,b)=>a-b);
}

function syncImmersiveItineraryLauncher(){
  const wrap = qs('#itinerary-focus-launch');
  const btn = qs('#open-itinerary-focus');
  if(!wrap || !btn) return;

  const cities = _immersiveAvailableCities_();
  const totalDays = cities.reduce((sum,city)=>sum + _immersiveDaysForCity_(city).length,0);
  const hasRows = cities.length>0 && totalDays>0;
  const copy = _immersiveViewerCopy_();

  wrap.classList.toggle('is-ready',hasRows);
  wrap.setAttribute('aria-hidden',hasRows?'false':'true');
  btn.disabled = !hasRows;
  btn.setAttribute('aria-disabled',hasRows?'false':'true');

  const title = qs('#itinerary-focus-cta-title');
  const sub = qs('#itinerary-focus-cta-subtitle');
  const meta = qs('#itinerary-focus-cta-meta');
  if(title) title.textContent = copy.ctaTitle;
  if(sub) sub.textContent = copy.ctaSub;
  if(meta){
    const cityLabel = cities.length===1 ? copy.citySingular : copy.cityPlural;
    const dayLabel = totalDays===1 ? copy.daySingular : copy.dayPlural;
    meta.textContent = hasRows ? `${cities.length} ${cityLabel} · ${totalDays} ${dayLabel} · ${copy.ready}` : '';
  }
}

function _immersiveFormatDuration_(val,transport=''){
  if(!val) return '';
  return _sanitizeDurationLines_(val,transport);
}

function _immersiveRenderDayTable_(city,dayNum){
  const target = qs('#itinerary-focus-day-content');
  if(!target) return;

  const rows = itineraries?.[city]?.byDay?.[dayNum] || [];
  if(!rows.length){
    target.innerHTML = `<p class="itinerary-focus-empty">${t('uiNoActivities')}</p>`;
    return;
  }

  const headers = [
    t('thStart'),t('thEnd'),t('thActivity'),t('thFrom'),
    t('thTo'),t('thTransport'),t('thDuration'),t('thNotes')
  ];

  const table = document.createElement('table');
  table.className='itinerary itinerary-focus-table';
  table.innerHTML=`
    <thead>
      <tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = qs('tbody',table);
  rows.forEach(r=>{
    const cleanActivity = String(r.activity||'').replace(/^rev:\s*/i,'');
    const cleanNotes = String(r.notes||'').replace(/^\s*valid:\s*/i,'').trim();
    const values = [
      r.start||'',
      r.end||'',
      cleanActivity,
      r.from||'',
      r.to||'',
      r.transport||'',
      _immersiveFormatDuration_(r.duration||'',r.transport||''),
      cleanNotes
    ];

    const tr=document.createElement('tr');
    tr.innerHTML=values.map((value,i)=>`<td data-label="${headers[i]}">${value}</td>`).join('');
    tbody.appendChild(tr);
  });

  target.replaceChildren(table);
}

function _immersiveRenderCities_(){
  const nav = qs('#itinerary-focus-cities');
  if(!nav) return;
  const cities = _immersiveAvailableCities_();
  nav.innerHTML='';

  cities.forEach((city,index)=>{
    const b=document.createElement('button');
    b.type='button';
    b.className='itinerary-focus-city-btn' + (city===immersiveItineraryCity?' active':'');
    b.dataset.city=city;
    b.innerHTML=`<span>${index+1}</span><strong>${city}</strong>`;
    b.addEventListener('click',()=>{
      immersiveItineraryCity=city;
      setActiveCity(city);
      const days=_immersiveDaysForCity_(city);
      const preferred=Number(itineraries?.[city]?.currentDay);
      immersiveItineraryDay=days.includes(preferred)?preferred:days[0];
      scheduleImmersiveItineraryRender();
    });
    nav.appendChild(b);
  });
}

function renderImmersiveItinerary(){
  const modal=qs('#itinerary-focus-modal');
  if(!modal) return;

  const cities=_immersiveAvailableCities_();
  if(!cities.length){
    closeImmersiveItinerary();
    syncImmersiveItineraryLauncher();
    return;
  }

  if(!immersiveItineraryCity || !cities.includes(immersiveItineraryCity)){
    immersiveItineraryCity=activeCity && cities.includes(activeCity) ? activeCity : cities[0];
  }

  const days=_immersiveDaysForCity_(immersiveItineraryCity);
  if(!days.length) return;

  if(!days.includes(Number(immersiveItineraryDay))){
    const preferred=Number(itineraries?.[immersiveItineraryCity]?.currentDay);
    immersiveItineraryDay=days.includes(preferred)?preferred:days[0];
  }

  itineraries[immersiveItineraryCity].currentDay=immersiveItineraryDay;
  setActiveCity(immersiveItineraryCity);

  const copy=_immersiveViewerCopy_();
  const data=itineraries[immersiveItineraryCity];
  const base=parseDMY(data?.baseDate || cityMeta?.[immersiveItineraryCity]?.baseDate || '');
  const dateLabel=base ? formatDMY(addDays(base,immersiveItineraryDay-1)) : '';
  const dayIndex=days.indexOf(immersiveItineraryDay);

  const eyebrow=qs('#itinerary-focus-eyebrow');
  const title=qs('#itinerary-focus-title');
  const subtitle=qs('#itinerary-focus-subtitle');
  const backLabel=qs('#itinerary-focus-back-label');
  const close=qs('#itinerary-focus-close');
  const prev=qs('#itinerary-focus-prev');
  const next=qs('#itinerary-focus-next');
  const cityLabel=qs('#itinerary-focus-city-label');
  const dayTitle=qs('#itinerary-focus-day-title');
  const dayCount=qs('#itinerary-focus-day-count');

  if(eyebrow) eyebrow.textContent=copy.eyebrow;
  if(title) title.textContent=copy.title;
  if(subtitle) subtitle.textContent=copy.subtitle;
  if(backLabel) backLabel.textContent=copy.back;
  if(close) close.setAttribute('aria-label',copy.close);
  if(prev) prev.setAttribute('aria-label',copy.prev);
  if(next) next.setAttribute('aria-label',copy.next);
  if(cityLabel) cityLabel.textContent=immersiveItineraryCity;
  if(dayTitle) dayTitle.textContent=`${t('uiDayTitle',immersiveItineraryDay)}${dateLabel ? ` · ${dateLabel}` : ''}`;
  if(dayCount) dayCount.textContent=`${dayIndex+1} ${copy.of} ${days.length}`;

  _immersiveRenderCities_();
  _immersiveRenderDayTable_(immersiveItineraryCity,immersiveItineraryDay);

  const dots=qs('#itinerary-focus-dots');
  if(dots){
    dots.innerHTML='';
    days.forEach((day,i)=>{
      const b=document.createElement('button');
      b.type='button';
      b.className='itinerary-focus-dot' + (day===immersiveItineraryDay?' active':'');
      b.setAttribute('aria-label',t('uiDayTitle',day));
      b.title=t('uiDayTitle',day);
      b.innerHTML=`<span>${i+1}</span>`;
      b.addEventListener('click',()=>{
        immersiveItineraryDay=day;
        scheduleImmersiveItineraryRender();
      });
      dots.appendChild(b);
    });
  }

  if(prev){
    prev.disabled=dayIndex<=0;
    prev.setAttribute('aria-disabled',dayIndex<=0?'true':'false');
  }
  if(next){
    next.disabled=dayIndex>=days.length-1;
    next.setAttribute('aria-disabled',dayIndex>=days.length-1?'true':'false');
  }
}

function _immersiveMoveDay_(delta){
  const days=_immersiveDaysForCity_(immersiveItineraryCity);
  if(!days.length) return;
  const currentIndex=Math.max(0,days.indexOf(Number(immersiveItineraryDay)));
  const nextIndex=Math.max(0,Math.min(days.length-1,currentIndex+delta));
  if(nextIndex===currentIndex) return;
  immersiveItineraryDay=days[nextIndex];
  scheduleImmersiveItineraryRender();
}

function openImmersiveItinerary(city){
  const modal=qs('#itinerary-focus-modal');
  if(!modal || !_immersiveAvailableCities_().length) return;

  immersiveItineraryCity=city && _immersiveAvailableCities_().includes(city)
    ? city
    : (activeCity && _immersiveAvailableCities_().includes(activeCity) ? activeCity : _immersiveAvailableCities_()[0]);

  const days=_immersiveDaysForCity_(immersiveItineraryCity);
  const preferred=Number(itineraries?.[immersiveItineraryCity]?.currentDay);
  immersiveItineraryDay=days.includes(preferred)?preferred:days[0];

  try{
    if(window.parent && window.parent!==window){
      window.parent.postMessage({type:'ITBMO_REQUEST_PLANNER_FOCUS',reason:'itinerary-viewer'},'*');
    }
  }catch(_){}

  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden','false');
  document.body.classList.add('itinerary-focus-open');

  // Let the focus surface paint first, then build the day table.
  // This prevents the CTA click from carrying the full table-render cost.
  scheduleImmersiveItineraryRender();

  setTimeout(()=>qs('#itinerary-focus-close')?.focus(),80);
}

function closeImmersiveItinerary(){
  const modal=qs('#itinerary-focus-modal');
  if(!modal) return;
  if(immersiveRenderFrame!=null){
    cancelAnimationFrame(immersiveRenderFrame);
    immersiveRenderFrame=null;
  }
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden','true');
  document.body.classList.remove('itinerary-focus-open');
  setTimeout(()=>qs('#open-itinerary-focus')?.focus(),40);
}

function bindImmersiveItineraryViewer(){
  const launch=qs('#open-itinerary-focus');
  const modal=qs('#itinerary-focus-modal');
  if(!launch || !modal) return;

  launch.addEventListener('click',()=>openImmersiveItinerary());
  qs('#itinerary-focus-back')?.addEventListener('click',closeImmersiveItinerary);
  qs('#itinerary-focus-close')?.addEventListener('click',closeImmersiveItinerary);
  qs('[data-itinerary-focus-close]')?.addEventListener('click',closeImmersiveItinerary);
  qs('#itinerary-focus-prev')?.addEventListener('click',()=>_immersiveMoveDay_(-1));
  qs('#itinerary-focus-next')?.addEventListener('click',()=>_immersiveMoveDay_(1));

  modal.addEventListener('touchstart',(e)=>{
    const p=e.touches?.[0];
    if(!p) return;
    immersiveTouchStartX=p.clientX;
    immersiveTouchStartY=p.clientY;
  },{passive:true});

  modal.addEventListener('touchend',(e)=>{
    if(immersiveTouchStartX==null || immersiveTouchStartY==null) return;
    const p=e.changedTouches?.[0];
    if(!p) return;
    const dx=p.clientX-immersiveTouchStartX;
    const dy=p.clientY-immersiveTouchStartY;
    immersiveTouchStartX=null;
    immersiveTouchStartY=null;
    if(Math.abs(dx)>58 && Math.abs(dx)>Math.abs(dy)*1.25){
      _immersiveMoveDay_(dx<0?1:-1);
    }
  },{passive:true});

  document.addEventListener('keydown',(e)=>{
    if(!modal.classList.contains('is-open')) return;
    if(e.key==='Escape'){
      e.preventDefault();
      closeImmersiveItinerary();
    }else if(e.key==='ArrowLeft'){
      e.preventDefault();
      _immersiveMoveDay_(-1);
    }else if(e.key==='ArrowRight'){
      e.preventDefault();
      _immersiveMoveDay_(1);
    }
  });

  syncImmersiveItineraryLauncher();
}

bindImmersiveItineraryViewer();

function getFrontendSnapshot(){
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(itineraries).map(([city,data])=>[
        city,
        {
          baseDate: data.baseDate || cityMeta[city]?.baseDate || null,
          transport: cityMeta[city]?.transport || '',
          days: Object.fromEntries(
            Object.entries(data.byDay||{}).map(([d,rows])=>[
              d,
              rows.map(r=>({
                day:+d, start:r.start||'', end:r.end||'', activity:r.activity||'',
                from:r.from||'', to:r.to||'', transport:r.transport||'',
                duration:r.duration||'', notes:r.notes||''
              }))
            ])
          )
        }
      ])
    )
  );
}
function buildIntake(){
  const pax = [
    ['adults','#p-adults'],
    ['young','#p-young'],
    ['children','#p-children'],
    ['infants','#p-infants'],
    ['seniors','#p-seniors']
  ].map(([k,id])=>`${k}:${qs(id)?.value||0}`).join(', ');

  const budgetVal = qs('#budget')?.value || 'N/A';
  const currencyVal = qs('#currency')?.value || 'USD';
  const budget = budgetVal !== 'N/A' ? `${budgetVal} ${currencyVal}` : 'N/A';
  const specialConditions = (qs('#special-conditions')?.value||'').trim()||'N/A';

  savedDestinations.forEach(dest=>{
    if(!cityMeta[dest.city]) cityMeta[dest.city] = {};
    if(!cityMeta[dest.city].perDay) cityMeta[dest.city].perDay = [];
    cityMeta[dest.city].perDay = Array.from({length:dest.days}, (_,i)=>{
      const prev = (cityMeta[dest.city].perDay||[]).find(x=>x.day===i+1) || dest.perDay?.[i];
      return {
        day: i+1,
        start: (prev && prev.start) ? prev.start : DEFAULT_START,
        end:   (prev && prev.end)   ? prev.end   : DEFAULT_END
      };
    });
  });

  const list = savedDestinations.map(x=>{
    const dates = x.baseDate ? `, start=${x.baseDate}` : '';
    return `${x.city} (${x.country||'—'} · ${x.days} días${dates})`;
  }).join(' | ');

  return [
    `Destinations: ${list}`,
    `Travelers: ${pax}`,
    `Budget: ${budget}`,
    `Special conditions: ${specialConditions}`,
    `Existing: ${getFrontendSnapshot()}`
  ].join('\n');
}

const FORMAT = `
Return ONLY valid JSON, without markdown, using one of these schemas:

A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"...","from":"...","to":"...","transport":"...","duration":"...","notes":"..."}]}],"followup":"Short question"}

B) {"destination":"City","rows":[{...}],"replace":false,"followup":"Short question"}

C) {"rows":[{...}],"replace":false,"followup":"Short question"}

D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" | ["HH:MM",...],"end":"HH:MM" | ["HH:MM",...],"hotel":"Text","transport":"Text"},"followup":"Short question"}

Mandatory rules:

- Use the explicitly selected itinerary language. If none was selected, use the dominant language of the user's natural-language content.
- Return at least one renderable row whenever itinerary rows are requested.
- Return no more than 20 rows per day.
- Optimize affected days globally: minimize unnecessary transfers, group logical zones, respect all daily windows and preserve continuity.
- Before finalizing each day, compare plausible sequences and choose the geographically strongest order: minimize door-to-door travel, avoid backtracking, cluster nearby areas, respect the natural direction of the route, and avoid returning to a previously completed district unless operationally necessary.
- Validate every row mathematically: the start-to-end interval must approximately equal transport time plus activity time. If the unexplained difference is significant, correct the schedule or regenerate only the affected row.
- The activity described in a row MUST occur at that row's concrete "to" location. Never describe a visit at "from" while setting "to" to the following stop. Use a separate transfer/departure row only when operationally useful.
- Protect reservation-based and destination-anchor experiences as complete visit blocks. Ticketed attractions, spas, thermal complexes, cruises, substantial tours and similar anchors must include realistic check-in, changing/boarding, core experience and exit time where applicable. Never compress an anchor merely to insert more stops.
- Do not leave an unexplained gap immediately after an anchor experience. Either include the full experience in its activity duration, add an explicit meaningful buffer/free-time row when justified, or schedule the next row continuously.
- Apply intelligent minimum dwell time by experience type. As a global guide: major waterfalls 30–45 min, viewpoints 15–30 min, neighborhoods 45–120 min, museums 60–180 min, food markets 45–90 min, beaches 45–90 min, national parks 45–180 min and churches 20–40 min. Allow 5–10 min only for an explicitly identified photographic micro-stop.
- Major destination spas and thermal complexes normally require at least 3 hours of activity time, excluding the incoming road transfer. Small local baths may be shorter only when clearly identified as such. Large museums normally require at least 90 minutes unless the row explicitly states a selective highlights-only visit.
- Detect semantic duplicate experiences, not only matching names. Merge or remove aliases, sub-area labels and repeated experiences that deliver essentially the same visit.
- Apply the global time-window policy: day 1 must respect any provided start time; the final day must respect any provided end time; intermediate-day times are preferences that may be optimized when this materially improves the itinerary, while remaining realistic and coherent.
- If an end time is blank, plan the day to reach at least approximately 19:00 local time when worthwhile content remains. Treat 19:00 as a minimum planning target, not a ceiling. Continue later for high-value evening experiences, shows, concerts, atmospheric districts, night viewpoints, special dinners or other destination-defining activities when they materially improve the itinerary. Do not force late nights without value. Any explicit user end time remains a hard boundary.
- On Day 1, the traveler reaches the lodging/checks in or drops luggage BEFORE sightseeing. The first sightseeing row must begin after that lodging step. Never invent an airport, flight or transfer origin if the user did not provide one.
- When a time or other detail is missing, infer a reasonable option without creating overlaps or inventing unsupported fixed logistics. When input is partial, complete it conservatively. When input is detailed, prioritize it and optimize around it.
- Treat the lodging, address, coordinates or area as the primary geographic base whenever provided. Minimize unnecessary transfers and begin/end at that base whenever operationally sensible.
- Treat preferences and restrictions as binding planning constraints, not merely note content. Translate them into concrete scheduling, routing, meal and activity decisions.
- Validate geography, season, useful daylight, route continuity, operational logistics and traveler fit.
- Never invent flights, airports, check-out, rental companies or vehicle-return logistics.
- Never claim live weather, live road conditions, live openings or guaranteed wildlife/aurora sightings.

Required non-empty row fields:
- activity
- from
- to
- transport
- duration
- notes

Activity:
- Use "Destination – Specific stop" when appropriate.
- Avoid generic labels such as "museum", "nearby village", "local restaurant" or "city walk".

Duration:
- Exactly two lines separated by \\n:
  "Transport: <realistic estimate or range>"
  "Activity: <realistic estimate or range>"
- Use localized labels in the selected itinerary language.
- Never use zero-minute values.
- The interval from start to end must contain both transport and activity.

Meals:
- Respect realistic local meal timing. On a full day that spans the local lunch period, include a real lunch/meal break unless the user explicitly prefers otherwise or a long fixed experience makes a different arrangement necessary.
- As a fallback when local customs are uncertain, place lunch roughly within 12:00–15:00; adapt to the destination's normal dining culture.
- When included, choose a concrete place or a clearly defined food district and give enough time to eat comfortably.
- Do not repeat the same named restaurant on another day.
- Dinner is optional; include it when it genuinely improves the itinerary, especially when the day naturally extends beyond 19:00 for worthwhile evening content.

Aurora:
- Include aurora only when plausible by latitude, season and darkness.
- Do NOT create a standalone aurora activity row by default.
- When auroras are plausible for the city/date, put aurora guidance as an ADDITIONAL note in the NOTES of the FINAL row of EVERY day in that city, with a realistic dark-hour window, a guided-tour option, weather/cloud/geomagnetic/road checks and a clear statement that visibility is not guaranteed.
- Because the aurora note is present on EVERY plausible day, the traveler automatically has multiple weather-dependent opportunities across the stay; never rely on only one selected night.
- Even when the user explicitly requests auroras or an aurora tour in Preferences / Restrictions / Special conditions, satisfy that preference through the final-row NOTE and guided-tour recommendation. Do not convert the preference itself into a standalone row. Only a genuinely confirmed booking with a fixed time, separately provided by the user and explicitly requested for scheduling, may be represented as a row.
- Avoid identical notes on consecutive nights.

Intelligent day-trip selection:
- Evaluate the complete trip before assigning days. Compare the marginal value of secondary city activities against nearby excursions using total trip length, the number of days required for the core city, relative tourism value, transfer time, season, traveler fit and route coherence.
- When a nearby excursion clearly adds more value, substitute lower-priority city filler with the stronger day trip. Do not force a day trip when the city itself still has higher-value unmet priorities.
- Apply this reasoning globally for every destination; never rely on city-name-specific logic.

Regional routes and macro-tours:
- Treat every important regional route as an expert-curated journey, not merely a list of headline attractions.
- Search for high-value viewpoints, minor waterfalls, picturesque villages, beaches, churches, bridges, monuments, geological formations, short trails and photographic stops that are directly on the route or require only a very small detour.
- Build a candidate pool before selecting the route. For a full-day scenic macro-route, evaluate enough candidates to avoid returning only the headline attractions; when daylight and the user window permit, normally retain a balanced set of roughly 4–8 meaningful visit stops plus the explicit return. This is a quality range, not a quota.
- Do not omit a strong low-detour micro-stop merely because the route already contains several headline stops. Conversely, never sacrifice realistic anchor dwell time, useful daylight or safe return timing just to increase the count.
- Use separate rows only for meaningful micro-stops that add real value, preserve rhythm and do not materially inflate the total route time.
- Rank candidate micro-stops by incremental tourism value: proximity alone is insufficient. Prefer stops that add a distinct experience category over repetitive variants of experiences already included that day.
- Remove weak micro-stops when a stronger nearby alternative exists. Never add activities merely to fill space.
- Keep the route geographically sequential and optimize its natural travel direction.
- End with an explicit return to the named base unless sleeping elsewhere.
- Do not place a major regional macro-route on the final day when stronger alternatives exist.
- Before returning the itinerary, identify the weakest day and improve it only when a clearly stronger, preference-compatible and logistically realistic alternative exists.

Merge behavior:
- Preserve existing rows by default.
- Use replace=true only when the request or generation flow explicitly requires full replacement.
`;

async function callAgent(text, useHistory = true){
  const history = useHistory ? session : [];
  const globalStyle = `
You are "Astra", an international travel planner.

CRITICAL RULE:
- When asked for an itinerary, output ONLY valid JSON (no extra text, no markdown).

LANGUAGE (CRITICAL):
Primary rule (highest priority):
- ALWAYS respond in the language explicitly selected by the user when the planner asks for the itinerary language.
- This selected language is the ONLY source of truth for the output language.
Secondary rule (fallback only):
- If no explicit language selection is provided, then:
  - Determine the language from the user's written content.
  - Ignore template/system labels (e.g., "Preferences", "Restrictions", "Start time", etc.).
  - Use only the natural language written by the user.
Mixed language handling:
- If the user mixes languages:
  • Prioritize the explicitly selected language.
  • If no selection exists, use the dominant language of the user's content.
  • If no dominant language exists, use the language of the last user entry.
Consistency (critical):
- The entire JSON output MUST be in ONE single language only.
- Do NOT mix languages inside the response.
Translation rule:
- Do NOT translate into the site/system language unless explicitly requested by the user.
- The output must strictly follow the selected or inferred language rules above.

Quality & coherence:
- Use common sense: geography, seasons, time windows, distances and basic logistics.
- Prioritize iconic daytime + nighttime highlights; if time is limited, focus on essentials.
- Optimize the actual visit sequence, not merely feasibility: compare plausible orders, minimize travel time, prevent backtracking, cluster nearby zones and preserve the natural direction of travel.
- Validate each row mathematically so its time interval approximately equals transport plus activity. Correct any significant mismatch before output.
- A row's activity must happen at its concrete To place. Do not write an activity at the From place while using To for the next destination.
- Protect ticketed/reservation anchor experiences as complete blocks, including realistic operational time. Never shorten a spa, cruise, major attraction or substantial tour to make room for extra stops, and never leave its real visit time as an unexplained gap.
- Enforce intelligent category-based dwell times and reject 5–10 minute visits unless explicitly justified as photographic micro-stops.
- Detect duplicate experiences semantically across aliases, districts and closely overlapping descriptions.
- If the user doesn't specify a specific day, review and adjust the entire city's itinerary, avoiding duplicates and absurd plans.
- Perform a final weakest-day review and improve only the clearly weakest day when a materially stronger option exists without violating constraints.

Itinerary rules (aligned with API v52.5):
- Max 20 rows per day.
- Non-empty fields: activity/from/to/transport/duration/notes (no "seed").
- Prefer activity format: "DESTINATION – Specific sub-stop" (avoid generic).
- duration must be 2 lines with \\n:
  "Transport: ...\\nActivity: ..."
  (no 0m, and do not use commas to separate).
- Meals: use realistic local meal timing. A full day spanning lunch should normally include a concrete lunch/meal break; if local customs are uncertain, use roughly 12:00–15:00 as a fallback. Dinner is optional; include it when the itinerary naturally extends into the evening and it adds real value.
- Intelligent day trips: evaluate the entire stay and decide whether a nearby excursion has greater tourism value than remaining secondary city activities. Consider total trip length, core-city coverage, relative quality, transfer time, season, traveler fit and logistical coherence. Substitute only lower-priority filler, never core unmet highlights. This rule is global and destination-agnostic.
- Lodging base: when hotel, Airbnb, address, coordinates or area are provided, use them as the primary geographic anchor; minimize transfers and start/end there whenever sensible.
- Preferences/restrictions: enforce them through actual choices and timing (for example photography → golden-hour opportunities; avoid crowds → earlier slots; no driving after sunset → return before darkness; walking limits → shorter walking segments; dietary needs → suitable concrete venues; celebrations → fitting experiences). Never leave them only in notes.
- Time policy: day 1 respects the provided start, the final day respects the provided end, and intermediate windows are preferences that may be optimized when beneficial. If an end time is blank, treat about 19:00 local as a minimum target, not a ceiling; do not routinely finish earlier, and continue later when high-value evening content materially improves the day. Day 1 reaches lodging/check-in or luggage drop before sightseeing.
- Missing data: infer reasonable options; complete partial input conservatively; prioritize detailed input.
- Macro-tours/day trips: first evaluate a broad candidate pool, then curate the strongest realistic set of major stops plus relevant low-detour micro-stops, followed by a final localized return row to the base. On a full-day scenic route, normally aim for roughly 4–8 meaningful visit stops when daylight, safety and the user window allow; this is a flexible quality range, never a quota. Do not compress anchor experiences or add filler. Avoid the final day when stronger scheduling alternatives exist.
- For every candidate micro-stop, evaluate incremental tourism value and experience diversity. A distinct lighthouse, cliff, historic church, geological formation or viewpoint may outrank another similar waterfall even at comparable distance.

Auroras (only if plausible by latitude/season):
- Do NOT create a standalone aurora row by default.
- Put the aurora opportunity as an ADDITIONAL note in the NOTES of the FINAL row of EVERY day when auroras are plausible for the city/date.
- Repeat the opportunity on EVERY plausible day so weather-dependent backup opportunities are naturally preserved across the stay.
- The note must include a realistic dark-hour window, guided-tour option, cloud/weather/geomagnetic/road checks and no-visibility guarantee.
- If the user explicitly provides a confirmed aurora booking/time and asks to schedule it, that confirmed fixed booking may be represented as a row.

Safety:
- Don't propose activities in areas with relevant risks, impossible hours, or obvious restrictions.
- Prefer safe, reasonable routes and experiences.
- If there's a reasonable warning, substitute with a safer alternative or note it briefly.

Edits:
- For edits: return the JSON per contract and merge by default (replace=false).
`.trim();

  const controller = new AbortController();
  const timeoutMs = 130000; // 130s (ajustable)
  const timer = setTimeout(()=>controller.abort(), timeoutMs);

  try{
    showThinking(true);

    const messages = [
      { role:'system', content: globalStyle },
      ...(Array.isArray(history) ? history : []),
      { role:'user', content: String(text || '') }
    ];

    const res = await fetch(API_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      signal: controller.signal,
      body: JSON.stringify({ model: MODEL, messages, mode: 'planner' })
    });

    if(!res.ok){
      const raw = await res.text().catch(()=> '');
      console.error('API error (planner):', res.status, res.statusText, raw);
      return `{"followup":"${tone.fail}"}`;
    }

    const data = await res.json().catch(()=>({text:''}));
    return data?.text || '';
  }catch(e){
    const isAbort = (e && (e.name === 'AbortError' || String(e).toLowerCase().includes('abort')));
    console.error("Failed to contact the API:", e);
    if(isAbort){
      return `{"followup":"⚠️ The assistant took too long to respond (timeout). Try again or reduce the number of days/cities."}`;
    }
    return `{"followup":"${tone.fail}"}`;
  }finally{
    clearTimeout(timer);
    showThinking(false);
  }
}

function parseJSON(s){
  if(!s) return null;
  try{ return JSON.parse(s); }catch(_){}
  const m1 = s.match(/```json\s*([\s\S]*?)```/i) || s.match(/```([\s\S]*?)```/i);
  if(m1 && m1[1]){ try{ return JSON.parse(m1[1]); }catch(_){ } }
  const m2 = s.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
  if(m2 && m2[1]){ try{ return JSON.parse(m2[1]); }catch(_){ } }
  try{
    const cleaned = s.replace(/^[^\{]+/,'').replace(/[^\}]+$/,'');
    return JSON.parse(cleaned);
  }catch(_){ return null; }
}

async function callInfoAgent(text){
  const history = infoSession;
  const globalStyle = `
You are "Astra", a premium expert travel concierge with the natural conversational quality of ChatGPT.

ROLE AND BEHAVIOR:
- Think like an expert travel concierge, not a search engine.
- Give a clear best recommendation when several options exist and briefly explain why it is the best fit.
- Prefer actionable recommendations over generic information.
- Personalize answers using the current itinerary, destinations, dates, travelers, lodging base, transport, budget, preferences and restrictions whenever relevant.
- Answer naturally, warmly and professionally.
- Reply in the same language as the user's latest message.
- Do NOT output JSON. Output helpful plain text.

ACCURACY:
- Never invent current facts.
- Clearly say when weather, prices, schedules, availability, tickets, road conditions, opening hours, entry rules or other time-sensitive facts should be verified.
- Distinguish reliable general guidance from information that may have changed.

FORMAT:
- Be concise by default and expand only when the user requests more detail or the topic requires it.
- Use short paragraphs.
- Use lists when they improve clarity.
- Use a compact comparison table when comparing several meaningful options.
- Use descriptive subheadings for longer answers.
- Avoid enormous blocks of text and repetitive disclaimers.

SCOPE:
- Help with lodging areas, local transportation, neighborhoods, local food and gastronomy, general safety and customs, photography, packing, indicative budgets, route organization and other general travel guidance related to the cities in this itinerary.
- Do not answer about unrelated destinations outside the current itinerary. Nearby places, excursions and day trips reasonably connected to the itinerary cities are allowed.

CURRENT PLANNER CONTEXT:
${buildIntake()}
`.trim();

  const controller = new AbortController();
  const timeoutMs = 45000; // 45s (ajustable)
  const timer = setTimeout(()=>controller.abort(), timeoutMs);

  try{
    setInfoChatBusy(true);

    const messages = [
      { role:'system', content: globalStyle },
      ...(Array.isArray(history) ? history : []),
      { role:'user', content: String(text || '') }
    ];

    const res = await fetch(API_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages,
        mode: 'info',
        session_token: getStoredSessionToken(),
        trip_id: currentTripId
      })
    });

    const data = await res.json().catch(()=>({text:''}));

    if(data?.code==='INFO_CHAT_OUT_OF_SCOPE'){
      const remaining=Number(data?.info_chat_remaining ?? infoChatQueriesRemaining);
      const cities=Array.isArray(data?.allowed_cities) ? data.allowed_cities.filter(Boolean) : [];
      const outside=Array.isArray(data?.out_of_scope_locations) ? data.out_of_scope_locations.filter(Boolean) : [];
      const es=getLang()==='es';

      return {
        text:'',
        remaining,
        notice:{
          title:es ? 'Esta consulta está fuera de tu viaje' : 'This question is outside your trip',
          message:es
            ? `Info Chat está disponible para las ciudades de este itinerario: ${cities.join(', ') || 'las ciudades seleccionadas'}.${outside.length ? ` ${outside.join(', ')} no forma parte de este itinerario.` : ''} Los lugares, excursiones y day trips razonablemente relacionados con tus ciudades sí están incluidos.`
            : `Info Chat is available for the cities in this itinerary: ${cities.join(', ') || 'your selected cities'}.${outside.length ? ` ${outside.join(', ')} is not part of this itinerary.` : ''} Places, excursions and reasonable day trips connected to your itinerary cities are included.`,
          code:'INFO_CHAT_OUT_OF_SCOPE'
        }
      };
    }

    if(data?.code==='INFO_CHAT_TOO_MANY_TOPICS'){
      const remaining=Number(data?.info_chat_remaining ?? infoChatQueriesRemaining);
      const count=Math.max(4,Number(data?.topic_count || 4));
      const es=getLang()==='es';

      return {
        text:'',
        remaining,
        notice:{
          title:es ? 'Demasiados temas en un solo mensaje' : 'Too many topics in one message',
          message:es
            ? `Detecté ${count} temas independientes. Puedes incluir hasta 3 temas por mensaje. Las preguntas relacionadas con una misma decisión se consideran una sola consulta. Divide este mensaje y continúa.`
            : `I detected ${count} independent topics. You can include up to 3 topics per message. Related questions about the same decision count as one query. Split this message and continue.`,
          code:'INFO_CHAT_TOO_MANY_TOPICS'
        }
      };
    }

    if(data?.code==='INFO_CHAT_INSUFFICIENT_REMAINING'){
      const remaining=Math.max(0,Number(data?.info_chat_remaining ?? infoChatQueriesRemaining));
      const count=Math.max(1,Number(data?.topic_count || 1));
      const es=getLang()==='es';

      return {
        text:'',
        remaining,
        notice:{
          title:es
            ? `Te ${remaining===1 ? 'queda' : 'quedan'} ${remaining} ${remaining===1 ? 'consulta' : 'consultas'}`
            : `You have ${remaining} ${remaining===1 ? 'query' : 'queries'} left`,
          message:es
            ? `Este mensaje contiene ${count} temas independientes. Reduce el mensaje a un máximo de ${remaining} ${remaining===1 ? 'tema' : 'temas'} para continuar.`
            : `This message contains ${count} independent topics. Reduce it to a maximum of ${remaining} ${remaining===1 ? 'topic' : 'topics'} to continue.`,
          code:'INFO_CHAT_INSUFFICIENT_REMAINING'
        }
      };
    }

    if(data?.code==='INFO_CHAT_SCOPE_CHECK_FAILED' || data?.code==='INFO_CHAT_SCOPE_CONTEXT_MISSING'){
      const es=getLang()==='es';
      return {
        text:'',
        remaining:infoChatQueriesRemaining,
        notice:{
          title:es ? 'No pudimos validar esta consulta' : 'We could not validate this query',
          message:es
            ? 'No se consumió ninguna consulta. Inténtalo nuevamente en unos segundos.'
            : 'No query was consumed. Please try again in a few seconds.',
          code:data.code
        }
      };
    }

    if(res.status===429 || data?.code==='INFO_CHAT_LIMIT_REACHED'){
      const remaining=Number(data?.info_chat_remaining || 0);
      return {
        text: getLang()==='es'
          ? 'Has utilizado las 10 consultas incluidas en este itinerario.'
          : 'You have used the 10 Info Chat queries included with this itinerary.',
        remaining,
        quotaExceeded:true
      };
    }

    if(res.status===401 || res.status===402 || data?.code==='INFO_CHAT_NOT_AUTHORIZED'){
      setInfoChatEntitlement({authorized:false,remaining:0,used:0,tripId:null});
      return {
        text: getLang()==='es'
          ? 'Info Chat está disponible después de confirmar el pago de este itinerario.'
          : 'Info Chat is available after payment for this itinerary is confirmed.',
        remaining:0
      };
    }

    if(!res.ok || data?.ok===false){
      console.error('API error (info):', res.status, res.statusText, data);
      return {text:tone.fail,remaining:infoChatQueriesRemaining};
    }

    const answer = (data?.text || '').trim();

    infoSession.push({ role:'user',      content: text });
    infoSession.push({ role:'assistant', content: answer });

    if (/^\s*\{/.test(answer)) {
      try {
        const j = JSON.parse(answer);
        if (j?.destination || j?.rows || j?.followup) {
          return {
            text:'The Info Chat response could not be parsed correctly. Check the API Key/URL in Vercel and try again.',
            remaining:Number(data?.info_chat_remaining ?? infoChatQueriesRemaining)
          };
        }
      } catch { /* no-op */ }
    }

    return {
      text: answer || 'Is there anything else you would like to know?',
      remaining: Number(data?.info_chat_remaining ?? infoChatQueriesRemaining)
    };
  }catch(e){
    const isAbort = (e && (e.name === 'AbortError' || String(e).toLowerCase().includes('abort')));
    console.error("Info Chat request failed:", e);
    if(isAbort) return {text:'⚠️ Info Chat took too long to respond. Please try again.',remaining:infoChatQueriesRemaining};
    return {text:tone.fail,remaining:infoChatQueriesRemaining};
  }finally{
    clearTimeout(timer);
    setInfoChatBusy(false);
  }
}

function dedupeInto(arr, row){
  const key = o => [o.day,o.start||'',o.end||'',(o.activity||'').toLowerCase().trim()].join('|');
  const has = arr.find(x=>key(x)===key(row));
  if(!has) arr.push(row);
}
function ensureDays(city){
  if(!itineraries[city]) itineraries[city]={byDay:{},currentDay:1,baseDate:null,masterPlan:[],audit:null};
  const byDay = itineraries[city].byDay || {};
  const present = Object.keys(byDay).map(n=>+n);
  const maxPresent = present.length?Math.max(...present):0;
  const saved = savedDestinations.find(x=>x.city===city)?.days || 0;
  const want = Math.max(saved, maxPresent) || 1;
  for(let d=1; d<=want; d++){
    if(!byDay[d]) byDay[d]=[];
  }
  itineraries[city].byDay = byDay;
}

function _hhmmToMinutes_(s){
  const m = String(s||'').trim().match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return null;
  const hh = Math.max(0, Math.min(23, parseInt(m[1],10)));
  const mm = Math.max(0, Math.min(59, parseInt(m[2],10)));
  return (hh * 60) + mm;
}
function _minutesToHHMM_(mins){
  let n = Number(mins);
  if(!Number.isFinite(n)) return '';
  while(n < 0) n += 24*60;
  n = n % (24*60);
  const hh = String(Math.floor(n/60)).padStart(2,'0');
  const mm = String(Math.floor(n%60)).padStart(2,'0');
  return `${hh}:${mm}`;
}
function _plannerOutputLang_(){
  const raw = String(plannerState?.itineraryLang || plannerState?.lang || getLang() || 'en')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'');
  if(/\b(es|spa|spanish|espanol|castellano)\b/.test(raw)) return 'es';
  if(/\b(pt|por|portuguese|portugues)\b/.test(raw)) return 'pt';
  if(/\b(fr|fre|french|francais)\b/.test(raw)) return 'fr';
  if(/\b(de|ger|german|deutsch|aleman)\b/.test(raw)) return 'de';
  if(/\b(it|ita|italian|italiano)\b/.test(raw)) return 'it';
  return 'en';
}

function _durationLabels_(){
  const lang = _plannerOutputLang_();
  const map = {
    es:['Transporte','Actividad'],
    pt:['Transporte','Atividade'],
    fr:['Transport','Activité'],
    de:['Transport','Aktivität'],
    it:['Trasporto','Attività'],
    en:['Transport','Activity']
  };
  return map[lang] || map.en;
}


function getPlannerCompletionMessage(){
  const lang = _plannerOutputLang_();
  const cities = savedDestinations.map(d=>d.city).filter(Boolean);
  const cityList = cities.join(', ');

  const messages = {
    en: `🎉 Your itineraries are ready!

For additional questions about ${cityList || 'the cities in this trip'}, open Info Chat 🌐.

It can help you with neighborhood and area comparisons, local transportation patterns, local cuisine and customs, general safety considerations, photography ideas, packing suggestions, approximate budgeting, and ways to organize your visits more efficiently.

Info Chat is focused on the cities included in this itinerary and does not check live availability or real-time reservations.`,
    es: `🎉 ¡Tus itinerarios están listos!

Para consultas adicionales sobre ${cityList || 'las ciudades de este viaje'}, abre Info Chat 🌐.

Puede ayudarte con comparación de zonas y barrios, formas habituales de transporte local, gastronomía y costumbres, consideraciones generales de seguridad, ideas de fotografía, qué llevar, presupuesto orientativo y cómo organizar mejor tus visitas.

Info Chat está enfocado en las ciudades incluidas en este itinerario y no consulta disponibilidad ni reservaciones en tiempo real.`,
    pt: `🎉 Seus itinerários estão prontos!

Para dúvidas adicionais sobre ${cityList || 'as cidades desta viagem'}, abra o Info Chat 🌐.

Ele pode ajudar com comparação de bairros e áreas, transporte local, gastronomia e costumes, considerações gerais de segurança, ideias de fotografia, o que levar, orçamento aproximado e como organizar melhor suas visitas.

O Info Chat é focado nas cidades incluídas neste itinerário e não consulta disponibilidade nem reservas em tempo real.`,
    fr: `🎉 Vos itinéraires sont prêts !

Pour toute question supplémentaire sur ${cityList || 'les villes de ce voyage'}, ouvrez Info Chat 🌐.

Il peut vous aider à comparer les quartiers, comprendre les transports locaux, découvrir la gastronomie et les coutumes, aborder des considérations générales de sécurité, trouver des idées photo, préparer vos bagages, estimer un budget et mieux organiser vos visites.

Info Chat se concentre sur les villes incluses dans cet itinéraire et ne vérifie pas les disponibilités ou réservations en temps réel.`,
    de: `🎉 Ihre Reisepläne sind fertig!

Für weitere Fragen zu ${cityList || 'den Städten dieser Reise'} öffnen Sie Info Chat 🌐.

Es kann bei der Auswahl von Vierteln, lokalen Verkehrsmöglichkeiten, Küche und Gepflogenheiten, allgemeinen Sicherheitshinweisen, Fotoideen, Packempfehlungen, grober Budgetplanung und einer besseren Organisation Ihrer Besuche helfen.

Info Chat konzentriert sich auf die Städte dieses Reiseplans und prüft keine Live-Verfügbarkeiten oder Echtzeit-Reservierungen.`,
    it: `🎉 I tuoi itinerari sono pronti!

Per ulteriori domande su ${cityList || 'le città di questo viaggio'}, apri Info Chat 🌐.

Può aiutarti a confrontare quartieri e zone, capire i trasporti locali, conoscere gastronomia e usanze, valutare considerazioni generali sulla sicurezza, trovare idee fotografiche, preparare i bagagli, stimare il budget e organizzare meglio le visite.

Info Chat è focalizzato sulle città incluse in questo itinerario e non verifica disponibilità o prenotazioni in tempo reale.`
  };

  return messages[lang] || messages.en;
}

function _extractDurationPart_(raw, kind='transport'){
  const s = String(raw||'').replace(/\r/g,'').trim();
  if(!s) return '';
  const transportLabels = '(?:Transport|Transporte|Trasporto)';
  const activityLabels = '(?:Activity|Actividad|Atividade|Activité|Aktivität|Attività)';
  const re = kind === 'transport'
    ? new RegExp(`${transportLabels}\\s*:\\s*([\\s\\S]*?)(?=\\n?\\s*${activityLabels}\\s*:|$)`, 'i')
    : new RegExp(`${activityLabels}\\s*:\\s*([\\s\\S]*)$`, 'i');
  return String(s.match(re)?.[1] || '').trim();
}

function _durationBoundsMinutes_(raw){
  let s = String(raw||'')
    .toLowerCase()
    .replace(/(\d+)\s*h\s*-\s*~\s*(\d{1,2})\s*h\b/g, (m,h,mins)=> Number(mins)<60 ? `${h} h ${mins} min` : m)
    .replace(/~\s*(\d+)\s*h\s*-\s*~\s*(\d{1,2})\s*h\b/g, (m,h,mins)=> Number(mins)<60 ? `${h} h ${mins} min` : m)
    .replace(/,/g,'.')
    .replace(/[–—]/g,'-')
    .replace(/[~≈]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
  if(!s) return null;

  // Compact hour/minute forms produced by models or transport fields:
  // 2h15m-2h30m, 2h15-2h30, 1h20m, 1h20.
  let m = s.match(/(\d+)\s*h\s*(\d{1,2})\s*m?\s*-\s*(\d+)\s*h\s*(\d{1,2})\s*m?/);
  if(m){
    const a=(+m[1]*60)+(+m[2]||0);
    const b=(+m[3]*60)+(+m[4]||0);
    return {min:Math.min(a,b),max:Math.max(a,b)};
  }

  m = s.match(/(\d+)\s*h\s*(\d{1,2})\s*m?\b/);
  if(m){
    const v=(+m[1]*60)+(+m[2]||0);
    return {min:v,max:v};
  }

  m = s.match(/(\d+)\s*h\s*(\d{1,2})?\s*-\s*(\d+)\s*h\s*(\d{1,2})?/);
  if(m){
    const a = (+m[1]*60)+(+m[2]||0);
    const b = (+m[3]*60)+(+m[4]||0);
    return {min:Math.min(a,b), max:Math.max(a,b)};
  }

  m = s.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|hora|horas)\b/);
  if(m){
    const a = Math.round(+m[1]*60), b = Math.round(+m[2]*60);
    return {min:Math.min(a,b), max:Math.max(a,b)};
  }

  m = s.match(/(\d+)\s*-\s*(\d+)\s*(m|min|mins|minute|minutes|minuto|minutos)\b/);
  if(m){
    const a=+m[1], b=+m[2];
    return {min:Math.min(a,b), max:Math.max(a,b)};
  }

  m = s.match(/(\d+)\s*h\s*(\d{1,2})\b/);
  if(m){
    const v=(+m[1]*60)+(+m[2]||0);
    return {min:v,max:v};
  }

  m = s.match(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|hora|horas)\b/);
  if(m){
    const v=Math.round(+m[1]*60);
    return {min:v,max:v};
  }

  m = s.match(/(\d+)\s*(m|min|mins|minute|minutes|minuto|minutos)\b/);
  if(m){
    const v=+m[1];
    return {min:v,max:v};
  }

  return null;
}

function _formatMinutesHuman_(minutes){
  const n=Math.max(1,Math.round(Number(minutes)||1));
  if(n<60) return `${n} min`;
  const h=Math.floor(n/60), m=n%60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function _formatDurationBounds_(b){
  if(!b) return '';
  if(b.min===b.max) return _formatMinutesHuman_(b.min);
  return `${_formatMinutesHuman_(b.min)}–${_formatMinutesHuman_(b.max)}`;
}

function _transportBoundsFromField_(raw){
  const s=String(raw||'');
  const candidates=[];
  const patterns=[
    /(\d+)\s*h\s*(\d{1,2})\s*m?\s*[-–—]\s*(\d+)\s*h\s*(\d{1,2})\s*m?/gi,
    /(\d+)\s*h\s*(\d{1,2})\s*m?\b/gi,
    /(\d+)\s*h\s*(\d{1,2})?\s*[-–—]\s*(\d+)\s*h\s*(\d{1,2})?/gi,
    /(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|hora|horas)\b/gi,
    /(\d+)\s*[-–—]\s*(\d+)\s*(m|min|mins|minute|minutes|minuto|minutos)\b/gi,
    /(\d+)\s*h\s*(\d{1,2})\b/gi,
    /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|hora|horas)\b/gi,
    /(\d+)\s*(m|min|mins|minute|minutes|minuto|minutos)\b/gi
  ];
  let m;
  while((m=patterns[0].exec(s))){
    const a=(+m[1]*60)+(+m[2]||0), b=(+m[3]*60)+(+m[4]||0);
    candidates.push({min:Math.min(a,b),max:Math.max(a,b)});
  }
  while((m=patterns[1].exec(s))){
    const v=(+m[1]*60)+(+m[2]||0); candidates.push({min:v,max:v});
  }
  while((m=patterns[2].exec(s))){
    const a=(+m[1]*60)+(+m[2]||0), b=(+m[3]*60)+(+m[4]||0);
    candidates.push({min:Math.min(a,b),max:Math.max(a,b)});
  }
  while((m=patterns[3].exec(s))){
    const a=Math.round(+m[1]*60),b=Math.round(+m[2]*60);
    candidates.push({min:Math.min(a,b),max:Math.max(a,b)});
  }
  while((m=patterns[4].exec(s))){
    candidates.push({min:Math.min(+m[1],+m[2]),max:Math.max(+m[1],+m[2])});
  }
  while((m=patterns[5].exec(s))){
    const v=(+m[1]*60)+(+m[2]||0); candidates.push({min:v,max:v});
  }
  while((m=patterns[6].exec(s))){
    const v=Math.round(+m[1]*60); candidates.push({min:v,max:v});
  }
  while((m=patterns[7].exec(s))){
    const v=+m[1]; candidates.push({min:v,max:v});
  }
  return candidates.length ? candidates.reduce((a,b)=>b.max>a.max?b:a) : null;
}

function _sanitizeDurationLines_(raw, transportField=''){
  const [transportLabel, activityLabel] = _durationLabels_();
  const s = (typeof raw === 'number') ? `${raw} min` : String(raw||'').trim();

  const declaredTransport = _durationBoundsMinutes_(_extractDurationPart_(s,'transport'));
  const transportFromField = _transportBoundsFromField_(transportField);
  const activity = _durationBoundsMinutes_(_extractDurationPart_(s,'activity'));

  let transport = declaredTransport;
  if(transportFromField && (!transport || transportFromField.max > transport.max)){
    transport = transportFromField;
  }

  if(transport && activity){
    return `${transportLabel}: ${_formatDurationBounds_(transport)}\n${activityLabel}: ${_formatDurationBounds_(activity)}`;
  }

  if(s){
    return s
      .replace(/^\s*(Transport|Transporte|Trasporto)\s*:/im, `${transportLabel}:`)
      .replace(/^\s*(Activity|Actividad|Atividade|Activité|Aktivität|Attività)\s*:/im, `${activityLabel}:`)
      .replace(/\s*\|\s*(Activity|Actividad|Atividade|Activité|Aktivität|Attività)\s*:/i, `\n${activityLabel}:`)
      .replace(/\s*,\s*(Activity|Actividad|Atividade|Activité|Aktivität|Attività)\s*:/i, `\n${activityLabel}:`);
  }

  return `${transportLabel}: Verificar\n${activityLabel}: Verificar`;
}

function _durationTotalBounds_(duration){
  const t=_durationBoundsMinutes_(_extractDurationPart_(duration,'transport'));
  const a=_durationBoundsMinutes_(_extractDurationPart_(duration,'activity'));
  if(!t || !a) return null;
  return {min:t.min+a.min,max:t.max+a.max};
}

function _reconcileRowTimeline_(row={}){
  const startMin=_hhmmToMinutes_(row.start);
  let endMin=_hhmmToMinutes_(row.end);
  const total=_durationTotalBounds_(row.duration);
  if(startMin==null || endMin==null || !total) return row;

  let span=endMin-startMin;
  if(span<=0) span+=24*60;
  const lower=Math.max(1,total.min);
  const upper=Math.max(lower,total.max);
  const unexplained = span<lower ? lower-span : (span>upper ? span-upper : 0);

  // Correct only meaningful inconsistencies; small buffers remain valid operational slack.
  if(unexplained>20){
    const target=Math.max(lower,upper);
    endMin=startMin+target;
    return {...row,end:_minutesToHHMM_(endMin)};
  }
  return row;
}

function _semanticExperienceKey_(row={}){
  const text=_canonicalText_(`${row.activity||''} ${row.to||''}`)
    .replace(/\b(port|harbour|harbor|puerto|district|barrio|quarter|area|zona|walk|paseo|galleries|galerias|gallery|galeria)\b/g,' ')
    .replace(/\s+/g,' ')
    .trim();
  const tokens=text.split(' ').filter(x=>x.length>=4);
  return [...new Set(tokens)].sort().join(' ');
}

function _semanticOverlapScore_(a='',b=''){
  const A=new Set(String(a||'').split(' ').filter(Boolean));
  const B=new Set(String(b||'').split(' ').filter(Boolean));
  if(!A.size || !B.size) return 0;
  let common=0;
  A.forEach(x=>{ if(B.has(x)) common++; });
  return common/Math.min(A.size,B.size);
}

function _dedupeSemanticSameDay_(rows=[]){
  const out=[];
  for(const row of rows){
    if(_isUtilityRow_(row)){ out.push(row); continue; }
    const key=_semanticExperienceKey_(row);
    const duplicate=out.some(prev=>
      !_isUtilityRow_(prev) &&
      _semanticOverlapScore_(key,_semanticExperienceKey_(prev))>=0.78
    );
    if(!duplicate) out.push(row);
  }
  return out;
}

function _setActivityDurationMinutes_(duration='', minutes=0){
  const [transportLabel, activityLabel]=_durationLabels_();
  const transport=_durationBoundsMinutes_(_extractDurationPart_(duration,'transport'));
  const safeMinutes=Math.max(1,Math.round(Number(minutes)||1));
  const transportText=transport ? _formatDurationBounds_(transport) : 'Verificar';
  return `${transportLabel}: ${transportText}\n${activityLabel}: ${_formatMinutesHuman_(safeMinutes)}`;
}

function _enforceMinimumDwell_(row={}){
  if(_isUtilityRow_(row)) return row;
  const profile=_activityProfile_(row);
  if(!profile) return row;
  const current=_activityDurationBounds_(row.duration);
  if(current && current.min>=profile.min) return row;
  return {...row,duration:_setActivityDurationMinutes_(row.duration,profile.min)};
}

function _isAnchorExperienceRow_(row={}){
  return Boolean(_activityProfile_(row)) || /\b(reservation|reserved|ticketed|timed entry|entry slot|booking|reserva|reservado|entrada con hora|horario de entrada|spa|thermal|termal|cruise|crucero|guided tour|tour guiado)\b/i.test(
    `${row?.activity||''} ${row?.to||''} ${row?.notes||''}`
  );
}

function _reconcileDayRows_(rows=[]){
  const source=(rows||[]).slice();
  const hasLateEvening=source.some(r=>{
    const m=_hhmmToMinutes_(r?.start);
    return m!=null && m>=18*60;
  });
  const logicalStartMinute=(row)=>{
    const m=_hhmmToMinutes_(row?.start);
    if(m==null) return 99999;
    // If a logical itinerary day continues after midnight, keep that return
    // after the evening activity instead of placing 00:xx at the top.
    return (hasLateEvening && m<4*60) ? m+(24*60) : m;
  };
  const sorted=source.sort((a,b)=>logicalStartMinute(a)-logicalStartMinute(b));

  // First enforce deterministic minimum dwell and row math.
  for(let i=0;i<sorted.length;i++){
    sorted[i]=_reconcileRowTimeline_(_enforceMinimumDwell_(sorted[i]));
  }

  // Then use a short operational gap after an anchor as part of the real visit block.
  // This prevents a 3-hour spa/cruise/museum from appearing as a 30-minute activity
  // followed by unexplained blank time.
  for(let i=0;i<sorted.length-1;i++){
    const cur=sorted[i], next=sorted[i+1];
    const end=_hhmmToMinutes_(cur.end), nextStart=_hhmmToMinutes_(next.start);
    if(end==null || nextStart==null) continue;
    let gap=nextStart-end;
    if(gap<0) gap+=1440;
    if(gap>20 && gap<=90 && _isAnchorExperienceRow_(cur)){
      const activity=_activityDurationBounds_(cur.duration);
      const extended=(activity?.max||0)+gap;
      cur.duration=_setActivityDurationMinutes_(cur.duration,extended);
      cur.end=next.start;
    }
  }
  return sorted;
}

function normalizeRow(r = {}, fallbackDay = 1){
  const startRaw = r.start ?? r.start_time ?? r.startTime ?? r.hora_inicio ?? '';
  const endRaw   = r.end   ?? r.end_time   ?? r.endTime   ?? r.hora_fin    ?? '';
  const act      = r.activity ?? r.title ?? r.name ?? r.descripcion ?? r.descripcion_actividad ?? '';
  const from     = r.from ?? r.origin ?? r.origen ?? '';
  const to       = r.to   ?? r.destination ?? r.destino ?? '';
  const trans    = r.transport ?? r.transportMode ?? r.modo_transporte ?? '';
  const durRaw   = r.duration ?? r.durationMinutes ?? r.duracion ?? '';
  const notes    = r.notes ?? r.nota ?? r.comentarios ?? '';
  const d = Math.max(1, parseInt(r.day ?? r.dia ?? fallbackDay, 10) || 1);

  let start = String(startRaw||'').trim();
  let end = String(endRaw||'').trim();
  let startMin=_hhmmToMinutes_(start), endMin=_hhmmToMinutes_(end);
  const duration=_sanitizeDurationLines_(durRaw, trans);
  const total=_durationTotalBounds_(duration);

  // Infer only genuinely missing times. Do not rewrite valid model schedules.
  if(startMin!=null && endMin==null && total){
    endMin=startMin+Math.max(30,total.max);
  }else if(startMin==null && endMin!=null && total){
    startMin=Math.max(0,endMin-Math.max(30,total.max));
  }

  if(startMin!=null && endMin!=null){
    let span=endMin-startMin;
    if(span<=0) span+=24*60;
    if(span<15) endMin=startMin+30;
  }

  start = startMin==null ? '' : _minutesToHHMM_(startMin);
  end = endMin==null ? '' : _minutesToHHMM_(endMin);

  const safeActivity = String(act||'').trim();
  const safeFrom = String(from||'').trim();
  const safeTo = String(to||'').trim();
  const safeTransport = String(trans||'').trim();
  const safeNotes = String(notes||'').trim();

  return _reconcileRowTimeline_(_enforceMinimumDwell_({
    day:d,
    start,
    end,
    activity:safeActivity,
    from:safeFrom,
    to:safeTo,
    transport:safeTransport,
    duration,
    notes:safeNotes
  }));
}

function dedupeSoftSameDay(rows){
  const seen = new Set();
  const out = [];
  for(const r of rows.sort((a,b)=> (a.start||'') < (b.start||'') ? -1 : 1)){
    const k = [String(r.activity||'').toLowerCase().trim(), (r.from||'').toLowerCase().trim(), (r.to||'').toLowerCase().trim()].join('|');
    if(seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function pushRows(city, rows, replace=false){
  if(!city || !rows) return;
  if(!itineraries[city]) itineraries[city] = {byDay:{},currentDay:1,baseDate:cityMeta[city]?.baseDate||null,masterPlan:[],audit:null};

  const byDay = itineraries[city].byDay;
  const daysToReplace = new Set();

  const mapped = rows.map(raw=>normalizeRow(raw, 1));
  if(replace){
    mapped.forEach(obj=>{ daysToReplace.add(obj.day); });
    daysToReplace.forEach(d=>{ byDay[d] = []; });
  }

  mapped.forEach(obj=>{
    const d = obj.day;
    if(!byDay[d]) byDay[d]=[];
    dedupeInto(byDay[d], obj);
    byDay[d] = dedupeSoftSameDay(byDay[d]);
    byDay[d] = _dedupeSemanticSameDay_(byDay[d]);
    byDay[d] = _reconcileDayRows_(byDay[d]);
    if(byDay[d].length>20) byDay[d] = byDay[d].slice(0,20);
  });

  itineraries[city].byDay = byDay;
  ensureDays(city);
}
function upsertCityMeta(meta){
  const name = meta.city || activeCity || savedDestinations[0]?.city;
  if(!name) return;
  if(!cityMeta[name]) cityMeta[name] = { baseDate:null, start:null, end:null, hotel:'', transport:'', perDay:[] };
  if(meta.baseDate) cityMeta[name].baseDate = meta.baseDate;
  if(meta.start)    cityMeta[name].start    = meta.start;
  if(meta.end)      cityMeta[name].end      = meta.end;
  if(typeof meta.hotel==='string'){
    const lodging=_normalizeLodgingInput_(meta.hotel);
    cityMeta[name].hotelOriginal = lodging.original;
    cityMeta[name].hotel = lodging.normalized;
  }
  if(typeof meta.transport==='string') cityMeta[name].transport = meta.transport;
  if(Array.isArray(meta.perDay)) cityMeta[name].perDay = meta.perDay;
  if(itineraries[name] && meta.baseDate) itineraries[name].baseDate = meta.baseDate;
}
function applyParsedToState(parsed){
  if(!parsed) return;
  if(parsed.itinerary) parsed = parsed.itinerary;
  if(parsed.destinos)  parsed.destinations = parsed.destinos;
  if(parsed.destino && parsed.rows) parsed.destination = parsed.destino;

  if(parsed.meta) upsertCityMeta(parsed.meta);

  let forceReplanCity = null;
  if (typeof plannerState !== 'undefined' && plannerState.forceReplan) {
    const candidate = parsed.destination || parsed.city || parsed.meta?.city;
    if (candidate && plannerState.forceReplan[candidate]) {
      forceReplanCity = candidate;
    }
  }

  if(Array.isArray(parsed.city_day)){
    const name = parsed.destination || parsed.city || parsed.meta?.city || activeCity || savedDestinations[0]?.city;
    if(name){
      const mustReplace = Boolean(parsed.replace) || (forceReplanCity === name);
      parsed.city_day.forEach(block=>{
        const dayNum = parseInt(block?.day, 10) || 1;
        const rows = Array.isArray(block?.rows) ? block.rows : [];
        pushRows(name, rows.map(r=>({ ...r, day: r.day ?? dayNum })), mustReplace);
      });
      if(forceReplanCity === name){
        delete plannerState.forceReplan[name];
      }
      return;
    }
  }

  if(Array.isArray(parsed.destinations)){
    parsed.destinations.forEach(d=>{
      const name = d.name || d.destination || d.meta?.city || activeCity || savedDestinations[0]?.city;
      if(!name) return;
      const mustReplace = Boolean(d.replace) || (forceReplanCity === name);

      if(d.rowsByDay && typeof d.rowsByDay === 'object'){
        Object.entries(d.rowsByDay).forEach(([k,rows])=>{
          pushRows(name, (rows||[]).map(r=>({...r, day:+k})), mustReplace);
        });
      } else if(Array.isArray(d.rows)){
        pushRows(name, d.rows, mustReplace);
      }

      if(Array.isArray(d.city_day)){
        d.city_day.forEach(block=>{
          const dayNum = parseInt(block?.day, 10) || 1;
          const rows = Array.isArray(block?.rows) ? block.rows : [];
          pushRows(name, rows.map(r=>({ ...r, day: r.day ?? dayNum })), mustReplace);
        });
      }

      if(forceReplanCity === name){
        delete plannerState.forceReplan[name];
      }
    });
    return;
  }

  if(parsed.destination && Array.isArray(parsed.rows)){
    const name = parsed.destination;
    const mustReplace = Boolean(parsed.replace) || (forceReplanCity === name);
    pushRows(name, parsed.rows, mustReplace);
    if(forceReplanCity === name){
      delete plannerState.forceReplan[name];
    }
    return;
  }

  if(Array.isArray(parsed.itineraries)){
    parsed.itineraries.forEach(x=>{
      const name = x.city || x.name || x.destination || activeCity || savedDestinations[0]?.city;
      if(!name) return;
      const mustReplace = Boolean(x.replace) || (forceReplanCity === name);

      if(x.rowsByDay && typeof x.rowsByDay==='object'){
        Object.entries(x.rowsByDay).forEach(([k,rows])=>{
          pushRows(name, (rows||[]).map(r=>({...r, day:+k})), mustReplace);
        });
      } else if(Array.isArray(x.rows)) {
        pushRows(name, x.rows, mustReplace);
      }

      if(Array.isArray(x.city_day)){
        x.city_day.forEach(block=>{
          const dayNum = parseInt(block?.day, 10) || 1;
          const rows = Array.isArray(block?.rows) ? block.rows : [];
          pushRows(name, rows.map(r=>({ ...r, day: r.day ?? dayNum })), mustReplace);
        });
      }

      if(forceReplanCity === name){
        delete plannerState.forceReplan[name];
      }
    });
    return;
  }

  if(Array.isArray(parsed.rows)){
    const city = activeCity || savedDestinations[0]?.city;
    const mustReplace = Boolean(parsed.replace) || (forceReplanCity === city);
    pushRows(city, parsed.rows, mustReplace);
    if(forceReplanCity === city){
      delete plannerState.forceReplan[city];
    }
  }
}

function addMultipleDaysToCity(city, extraDays){
  if(!city || extraDays <= 0) return;
  ensureDays(city);

  const byDay = itineraries[city].byDay || {};
  const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  let currentMax = days.length ? Math.max(...days) : 0;

  // 🧠 Establecer el último día original si no existe
  if (!itineraries[city].originalDays) {
    itineraries[city].originalDays = currentMax;
  }
  const lastOriginalDay = itineraries[city].originalDays;

  // 🆕 Agregar solo los días realmente nuevos
  for(let i=1; i<=extraDays; i++){
    const newDay = currentMax + i;
    if(!byDay[newDay]){  // evita duplicados
      insertDayAt(city, newDay);

      const start = cityMeta[city]?.perDay?.find(x=>x.day===newDay)?.start || DEFAULT_START;
      const end   = cityMeta[city]?.perDay?.find(x=>x.day===newDay)?.end   || DEFAULT_END;
      
      if(!cityMeta[city]) cityMeta[city] = { perDay: [] };
      if(!cityMeta[city].perDay.find(x=>x.day===newDay)){
        cityMeta[city].perDay.push({ day:newDay, start, end });
      }
    }
  }

  const dest = savedDestinations.find(x=>x.city===city);
  let newLastDay = currentMax + extraDays;
  if(dest){
    dest.days = newLastDay;
  }

  // 🧭 Definir rango de rebalanceo: incluye último día original
  const rebalanceStart = Math.max(1, lastOriginalDay);
  const rebalanceEnd = newLastDay;

  if (typeof plannerState !== 'undefined') {
    if (!plannerState.forceReplan) plannerState.forceReplan = {};
    plannerState.forceReplan[city] = true;
  }

  // 🧠 Rebalanceo automático sólo en el rango afectado
  showWOW(true, 'Astra está reequilibrando la ciudad…');
  rebalanceWholeCity(city, { start: rebalanceStart, end: rebalanceEnd })
    .catch(err => console.error('Error en rebalance automático:', err))
    .finally(() => showWOW(false));
}

async function validateRowsWithAgent(city, rows, baseDate){
  const payload = `
LANGUAGE (CRITICAL):
Primary rule (highest priority):
- ALWAYS respond in the language explicitly selected by the user when the planner asks for the itinerary language.
- This selected language is the ONLY source of truth for the output language.
Secondary rule (fallback only):
- If no explicit language selection is provided, then:
  - Determine the language from the user's written content.
  - Ignore template/system labels (e.g., "Preferences", "Restrictions", "Start time", etc.).
  - Use only the natural language written by the user.
Mixed language handling:
- If the user mixes languages:
  • Prioritize the explicitly selected language.
  • If no selection exists, use the dominant language of the user's content.
  • If no dominant language exists, use the language of the last user entry.
Consistency (critical):
- The entire JSON output MUST be in ONE single language only.
- Do NOT mix languages inside the response.
Translation rule:
- Do NOT translate into the site/system language unless explicitly requested by the user.
- The output must strictly follow the selected or inferred language rules above.

Devuelve SOLO JSON válido:
{
  "allowed":[
    {"day":1,"start":"..","end":"..","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}
  ],
  "removed":[
    {"reason":"..","row":{"day":..,"activity":".."}}
  ]
}

CRITERIOS GLOBALES (flexibles):
- Corrige horas solo si hay solapes evidentes o incoherencias claras.
- Transporte lógico según actividad:
  • Barco para whale watching (puerto local).
  • Tour/bus/van para excursiones extensas.
  • Tren/bus/auto interurbano cuando aplique.
  • A pie/metro en zonas urbanas.
- Day trips:
  • Evalúa con criterio experto si son razonables por distancia, duración total y experiencia real.
  • Permite hasta ~3h por trayecto (ida) como guía; usa sentido común turístico.
  • No limites la cantidad de day trips; decide según calidad/valor y tiempo total.
  • Si un day trip NO es razonable, muévelo a "removed" con reason "distance:" + alternativa viable.
- Seguridad y restricciones:
  • Si hay riesgo evidente, restricción oficial o ventana horaria claramente insegura, usa "removed" con reason "risk:".
  • Prioriza siempre opciones plausibles, seguras y razonables.
- Notes:
  • NUNCA vacías ni "seed".
  • Añade siempre al menos un tip útil o contexto breve.
- Duraciones:
  • Acepta rangos realistas (ej. "~90m", "~2–3h").
  • Si viene en minutos, permite "90m" o "1.5h".
  • Reconoce también formatos compactos como "2h15m-2h30m" y no los reduzcas a 30 minutos.
  • Una experiencia termal/spa de destino debe reservar normalmente al menos 3 horas de actividad, sin contar el traslado de llegada.
  • El horario de la fila debe cubrir la experiencia completa; no dejes su duración real escondida como un hueco entre filas.
- Máx. 20 filas por día; prioriza icónicas y evita redundancias.
- Activity (guía suave):
  • Prefiere el formato "Destino – Sub-parada específica" si aplica.
    - "Destino" NO es siempre la ciudad: si una fila pertenece a un day trip/macro-tour, "Destino" debe ser el nombre del macro-tour (ej. "Círculo Dorado", "Costa Sur", "Toledo").
    - Si NO es day trip, "Destino" puede ser la ciudad.
  • Evita genéricos tipo "tour" o "museo" sin especificar, cuando sea fácil concretar.
- From/To (muy importante):
  • La actividad descrita DEBE ocurrir en el lugar concreto indicado en "to". No describas una visita en "from" mientras "to" apunta a la siguiente parada.
  • "from" y "to" deben ser LUGARES reales (Hotel/Centro/atracción/pueblo/mirador), NUNCA el nombre del macro-tour.
    - Ejemplo incorrecto: to="Costa Sur" / from="Círculo Dorado".
    - Si detectas eso, corrígelo a un lugar real (p.ej., la primera/última sub-parada o el hotel/centro).
  • Evita filas tipo "<Ciudad> – Excursión a <Macro-tour>" sin sub-parada real.
    - Si existe una fila así, conviértela a "<Macro-tour> – Salida de <Ciudad>" y ajusta from/to a: from="Hotel/Centro en <Ciudad>" → to="<Primera sub-parada real>".

CASOS ESPECIALES (guía, no bloqueo):
1) Whale watching:
   - Transporte: Barco.
   - Duración típica total: 3–4h.
   - Añade en notes: "valid:" con referencia breve a temporada si aplica.
2) Auroras:
   - Actividad nocturna (horario local aproximado).
   - Transporte: Tour/Van o Auto si procede.
   - Incluir "valid:" con justificación breve (latitud/temporada/clima).
   - Si hay varias noches posibles, evita duplicar sin motivo.
3) Rutas escénicas en coche:
   - Considera conducción + paradas como experiencia integrada.
   - Si no hay coche ni tour viable, usa "risk" o "logistics" y sugiere alternativa.
4) Museos/monumentos:
   - Horario diurno realista.
5) Cenas/vida nocturna:
   - Horarios nocturnos razonables (flexibles según destino).

REGLAS DE FUSIÓN:
- Devuelve en "allowed" las filas ya corregidas.
- Mueve a "removed" SOLO lo claramente inviable o inseguro.
- Para excursiones extensas (day trips), si detectas un regreso claramente subestimado, corrige la duración/ventana de tiempo de forma realista.

Contexto:
- Ciudad: "${city}"
- Fecha base (Día 1): ${baseDate || 'N/A'}
- Filas a validar: ${JSON.stringify(rows)}
`.trim();

  try{
    const res = await callAgent(payload, true);
    const parsed = parseJSON(res);
    if(parsed?.allowed) return parsed;
  }catch(e){
    console.warn('Validator error', e);
  }

  // Fail-open seguro: solo sanitiza notes
  const sanitized = (rows||[]).map(r => {
    const notes = (r.notes||'').trim();
    return {
      ...r,
      notes: notes && notes.toLowerCase()!=='seed'
        ? notes
        : 'Tip: revisa horarios locales, logística real y reserva con antelación si aplica.'
    };
  });

  return { allowed: sanitized, removed: [] };
}

/* ==============================
   SECTION 15 · City generation
================================= */
function setOverlayMessage(msg=t('overlayDefault')){
  const p = $overlayWOW?.querySelector('p');
  if(!p) return;

  const isMainGenerationMessage =
    msg === t('overlayDefault') ||
    msg === t('overlayGenerating');

  if(!isMainGenerationMessage){
    p.classList.remove('astra-overlay-copy');
    p.textContent = msg;
    return;
  }

  const isEs = getLang() === 'es';
  p.classList.add('astra-overlay-copy');
  p.innerHTML = isEs
    ? `<span class="astra-overlay-hero"><strong>✨ ASTRA está investigando, organizando y optimizando tu itinerario</strong><span>Ciudad por ciudad. Día por día.</span></span><span class="astra-overlay-time"><span class="astra-overlay-time-label">⏳ <strong>Tiempo estimado de generación</strong></span><strong class="astra-overlay-time-ranges">1 ciudad 4–5 min <i>·</i> 2 ciudades 8–10 min <i>·</i> 3 ciudades 12–15 min</strong></span><span class="astra-overlay-value">ASTRA compara rutas, horarios, traslados, prioridades y tus preferencias para ahorrarte horas de investigación.<br><strong>Mantén esta pestaña abierta.</strong> Mientras ASTRA trabaja, explora los enlaces de abajo para vuelos, hospedaje, transporte y experiencias.</span>`
    : `<span class="astra-overlay-hero"><strong>✨ ASTRA is researching, organizing and optimizing your itinerary</strong><span>City by city. Day by day.</span></span><span class="astra-overlay-time"><span class="astra-overlay-time-label">⏳ <strong>Estimated generation time</strong></span><strong class="astra-overlay-time-ranges">1 city 4–5 min <i>·</i> 2 cities 8–10 min <i>·</i> 3 cities 12–15 min</strong></span><span class="astra-overlay-value">ASTRA compares routes, timing, transfers, priorities and your preferences to save you hours of research.<br><strong>Keep this tab open.</strong> While ASTRA works, explore the links below for flights, stays, transport and experiences.</span>`;
}

function showWOW(on, msg){
  if(!$overlayWOW) return;
  if(msg) setOverlayMessage(msg);
  $overlayWOW.style.display = on ? 'flex' : 'none';
  if(on) requestParentViewportFocus('loading-overlay', true);

  // Affiliate cards are anchors, not planner controls: they remain clickable
  // in a new tab while the generation request continues untouched.
  setLoadingAffiliateVisibility(!!on);

  const all = qsa('button, input, select, textarea');
  all.forEach(el=>{
    // ✅ Keep only the reset button enabled
    if (el.id === 'reset-planner') return;

    // 🆕 Also lock the floating Info Chat button
    if (el.id === 'info-chat-floating') {
      el.disabled = on;
      return;
    }

    if(on){
      el._prevDisabled = el.disabled;
      el.disabled = true;
    }else{
      if(typeof el._prevDisabled !== 'undefined'){
        el.disabled = el._prevDisabled;
        delete el._prevDisabled;
      }else{
        el.disabled = false;
      }
    }
  });

  /* Permanent trip-state guardrails after any global UI unlock. */
  if(!on){
    updateSaveAvailability();
    if($start?.dataset.itbmoConsumed==='1'){
      $start.disabled=true;
      $start.setAttribute('aria-disabled','true');
    }
  }
}

/* =========================================================
   ✅ SURGICAL (CRITICAL): preserve user's language
   - We do NOT send long instructions (in ES) as "user".
   - We send rules/prompt as "system".
   - The last "user" message will be an ANCHOR with real user text
     so the API answers in that language (even if site is EN/ES).
========================================================= */
function _lastUserFromSession_(){
  try{
    // ✅ Ultra-surgical FIX: avoid ReferenceError if session does not exist yet
    if(typeof session === 'undefined' || !session) return '';

    for(let i=(session?.length||0)-1; i>=0; i--){
      const m = session[i];
      if(String(m?.role||'').toLowerCase()==='user'){
        const s = String(m?.content||'').trim();
        if(s) return s;
      }
    }
  }catch(_){}
  return '';
}

function _userLanguageAnchor_(){
  try{
    const chosen = (typeof plannerState !== 'undefined' && plannerState)
      ? String(plannerState?.itineraryLang || '').trim()
      : '';
    if(chosen) return chosen;
  }catch(_){}

  // ✅ Ultra-surgical FIX: avoid ReferenceError if plannerState does not exist yet
  const sc = (typeof plannerState !== 'undefined' && plannerState)
    ? String(plannerState?.specialConditions || '').trim()
    : '';
  if(sc) return sc;

  // ✅ SURGICAL: also use the real textarea if plannerState isn't populated yet
  const sc2 = (typeof qs !== 'undefined')
    ? String(qs('#special-conditions')?.value || '').trim()
    : '';
  if(sc2) return sc2;

  // Next: last text written by the user in the planner chat (if exists)
  const last = _lastUserFromSession_();
  if(last) return last;

  return (getLang()==='es') ? 'Please generate the itinerary.' : 'Please generate the itinerary.';
}


/* =========================================================
   ITBMO · GENERATION DIAGNOSTICS
   Observability only. Does not change the generation flow.
   ========================================================= */
const _astraGenerationMetrics_ = {
  active:false,
  startedAt:0,
  finishedAt:0,
  calls:0,
  inputTokens:0,
  outputTokens:0,
  totalTokens:0,
  tokenUsageSamples:0,
  cities:[]
};

function _formatGenerationDuration_(ms){
  const safe=Math.max(0,Number(ms)||0);
  const totalSeconds=Math.round(safe/1000);
  const minutes=Math.floor(totalSeconds/60);
  const seconds=totalSeconds%60;
  return minutes>0 ? `${minutes}m ${String(seconds).padStart(2,'0')}s` : `${seconds}s`;
}

function _resetAstraGenerationMetrics_(){
  _astraGenerationMetrics_.active=true;
  _astraGenerationMetrics_.startedAt=performance.now();
  _astraGenerationMetrics_.finishedAt=0;
  _astraGenerationMetrics_.calls=0;
  _astraGenerationMetrics_.inputTokens=0;
  _astraGenerationMetrics_.outputTokens=0;
  _astraGenerationMetrics_.totalTokens=0;
  _astraGenerationMetrics_.tokenUsageSamples=0;
  _astraGenerationMetrics_.cities=[];
}

function _extractExactUsage_(data){
  const usage=data?.usage || data?.token_usage || data?.meta?.usage || data?.meta?.token_usage || null;
  if(!usage || typeof usage!=='object') return null;

  const input=Number(
    usage.input_tokens ??
    usage.prompt_tokens ??
    usage.inputTokens ??
    usage.promptTokens ??
    0
  ) || 0;

  const output=Number(
    usage.output_tokens ??
    usage.completion_tokens ??
    usage.outputTokens ??
    usage.completionTokens ??
    0
  ) || 0;

  const total=Number(
    usage.total_tokens ??
    usage.totalTokens ??
    (input+output)
  ) || (input+output);

  if(input<=0 && output<=0 && total<=0) return null;
  return {input,output,total};
}

function _captureExactUsage_(data){
  if(!_astraGenerationMetrics_.active) return;
  _astraGenerationMetrics_.calls++;

  const usage=_extractExactUsage_(data);
  if(!usage) return;

  _astraGenerationMetrics_.inputTokens+=usage.input;
  _astraGenerationMetrics_.outputTokens+=usage.output;
  _astraGenerationMetrics_.totalTokens+=usage.total;
  _astraGenerationMetrics_.tokenUsageSamples++;
}

function _finishAstraGenerationMetrics_(){
  _astraGenerationMetrics_.finishedAt=performance.now();
  _astraGenerationMetrics_.active=false;

  const totalMs=_astraGenerationMetrics_.finishedAt-_astraGenerationMetrics_.startedAt;
  const tokenUsageAvailable=_astraGenerationMetrics_.tokenUsageSamples>0;

  const snapshot={
    totalMs:Math.round(totalMs),
    total:_formatGenerationDuration_(totalMs),
    modelCalls:_astraGenerationMetrics_.calls,
    cities:_astraGenerationMetrics_.cities.map(x=>({...x})),
    tokenUsageAvailable,
    inputTokens:tokenUsageAvailable ? _astraGenerationMetrics_.inputTokens : null,
    outputTokens:tokenUsageAvailable ? _astraGenerationMetrics_.outputTokens : null,
    totalTokens:tokenUsageAvailable ? _astraGenerationMetrics_.totalTokens : null
  };

  window.__ITBMO_LAST_GENERATION_METRICS__=snapshot;

  console.log(`%c[ASTRA TIMER] FULL TRIP TOTAL: ${snapshot.total}`, 'font-weight:900;color:#087f9f;');
  console.log(`[ASTRA TIMER] Model/API calls during generation: ${snapshot.modelCalls}`);
  if(snapshot.cities.length) console.table(snapshot.cities);

  if(tokenUsageAvailable){
    console.log(
      `[ASTRA TOKENS] Input: ${snapshot.inputTokens.toLocaleString()} · Output: ${snapshot.outputTokens.toLocaleString()} · Total: ${snapshot.totalTokens.toLocaleString()}`
    );
  }else{
    console.info(
      '[ASTRA TOKENS] Exact token counts are not available because /api/chat did not expose usage metadata to the browser. No estimate was invented.'
    );
  }

  console.info(
    '[ASTRA METRICS] Type __ITBMO_LAST_GENERATION_METRICS__ in the console to inspect the last complete generation.'
  );

  return snapshot;
}

async function _callPlannerSystemPrompt_(systemPrompt, useHistory=true){
  const history = useHistory ? session : [];

  // timeout to avoid hangs (same pattern as SECTION 12)
  const controller = new AbortController();
  const timeoutMs = 130000;
  const timer = setTimeout(()=>controller.abort(), timeoutMs);

  try{
    showThinking(true);

    const anchor = _userLanguageAnchor_();

    // ✅ Important: the LAST user message must be the "anchor" (real user language)
    // and the system must contain the rules and structured request.
    const messages = [
      { role:'system', content: String(systemPrompt || '') },
      ...(Array.isArray(history) ? history : []),
      { role:'user', content: String(anchor || '') }
    ];

    const res = await fetch(API_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      signal: controller.signal,
      body: JSON.stringify({ model: MODEL, messages, mode: 'planner' })
    });

    if(!res.ok){
      const raw = await res.text().catch(()=> '');
      console.error('API error (planner):', res.status, res.statusText, raw);
      return `{"followup":"${tone.fail}"}`;
    }

    const data = await res.json().catch(()=>({text:''}));
    _captureExactUsage_(data);
    return data?.text || '';
  }catch(e){
    const isAbort = (e && (e.name === 'AbortError' || String(e).toLowerCase().includes('abort')));
    console.error("Failed to contact the API:", e);
    if(isAbort){
      return `{"followup":"⚠️ The assistant took too long to respond (timeout). Try again or reduce the number of days/cities."}`;
    }
    return `{"followup":"${tone.fail}"}`;
  }finally{
    clearTimeout(timer);
    showThinking(false);
  }
}

// ✅ SURGICAL: keep blank day hours blank; do not inject defaults into the prompt payload
function _normalizePerDayForPrompt_(city, totalDays, fallbackPerDay=[]){
  return Array.from({length: totalDays}, (_,i)=>{
    const src = (cityMeta[city]?.perDay||[])[i] || fallbackPerDay?.[i] || {};
    const start = (src.start != null && String(src.start).trim()) ? String(src.start).trim() : null;
    const end   = (src.end   != null && String(src.end).trim())   ? String(src.end).trim()   : null;
    return {
      day: i+1,
      start,
      end,
      start_provided: !!start,
      end_provided: !!end
    };
  });
}

// ✅ SURGICAL: support current preferred API shape (city_day) + legacy formats
function _extractPlannerRows_(parsed, city){
  if(!parsed) return [];

  if(Array.isArray(parsed.rows)){
    return parsed.rows.map(r=>normalizeRow(r));
  }

  if(parsed.destination && parsed.destination===city && Array.isArray(parsed.rows)){
    return parsed.rows.map(r=>normalizeRow(r));
  }

  // ✅ CRITICAL FIX: preserve block.day when rows inside city_day do not include their own day
  if(Array.isArray(parsed.city_day)){
    return parsed.city_day
      .filter(block => {
        const blockCity = block?.city || parsed.destination || city;
        return blockCity === city;
      })
      .flatMap(block => {
        const dayNum = parseInt(block?.day, 10) || 1;
        const rows = Array.isArray(block?.rows) ? block.rows : [];
        return rows.map(r => normalizeRow({ ...r, day: r?.day ?? dayNum }, dayNum));
      });
  }

  if(Array.isArray(parsed.destinations)){
    const dd = parsed.destinations.find(d=> (d.name||d.destination)===city);
    if(Array.isArray(dd?.rows)) return dd.rows.map(r=>normalizeRow(r));

    // ✅ same fix for nested city_day inside destinations
    if(Array.isArray(dd?.city_day)){
      return dd.city_day.flatMap(block=>{
        const dayNum = parseInt(block?.day, 10) || 1;
        const rows = Array.isArray(block?.rows) ? block.rows : [];
        return rows.map(r => normalizeRow({ ...r, day: r?.day ?? dayNum }, dayNum));
      });
    }

    return [];
  }

  if(Array.isArray(parsed.itineraries)){
    const ii = parsed.itineraries.find(x=> (x.city||x.name||x.destination)===city);
    if(Array.isArray(ii?.rows)) return ii.rows.map(r=>normalizeRow(r));

    // ✅ same fix for nested city_day inside itineraries
    if(Array.isArray(ii?.city_day)){
      return ii.city_day.flatMap(block=>{
        const dayNum = parseInt(block?.day, 10) || 1;
        const rows = Array.isArray(block?.rows) ? block.rows : [];
        return rows.map(r => normalizeRow({ ...r, day: r?.day ?? dayNum }, dayNum));
      });
    }

    return [];
  }

  return [];
}

/* =========================================================
   ✅ v60 · STAGED GENERATION WITH TRIP-WIDE LEDGER
========================================================= */
function _extractMasterPlanDays_(parsed, city, totalDays){
  if(!parsed) return [];
  const rows = _extractPlannerRows_(parsed, city);
  if(!Array.isArray(rows) || !rows.length) return [];

  const byDay = new Map();
  for(const row of rows){
    const day=Number(row?.day||0);
    if(day<1 || day>totalDays || byDay.has(day)) continue;
    const activity=String(row?.activity||'').trim();
    const m=activity.match(/^\s*PLAN\s*[–-]\s*(.+)$/i);
    const theme=String(m?.[1] || activity || row?.notes || row?.to || '').trim();
    if(theme) byDay.set(day,{day,theme});
  }

  const out=Array.from(byDay.values()).sort((a,b)=>a.day-b.day);
  return out.length===totalDays ? out : [];
}

function _canonicalText_(value=''){
  return String(value||'')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[’'"]/g,'')
    .replace(/\b(exterior|interior|tower|torre|viewpoint|mirador|museum|museo|market|mercado|street|calle|concert hall|sala de conciertos)\b/g,' ')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function _themeParts_(theme=''){
  const s=String(theme||'').replace(/^\s*PLAN\s*[–-]\s*/i,'').trim();
  const parts=s.split(/\|\s*Anchors?\s*:/i);
  return {
    identity:String(parts[0]||'').trim(),
    anchors:String(parts.slice(1).join(' | ')||'').trim()
  };
}

function _anchorItems_(theme=''){
  const {anchors}=_themeParts_(theme);
  return String(anchors||'')
    .split(/\s*;\s*|\s*,\s*/)
    .map(_canonicalText_)
    .filter(x=>x.length>=4);
}

function _poiKeyFromRow_(row={}){
  const to=_canonicalText_(row?.to);
  const activity=_canonicalText_(String(row?.activity||'').replace(/^.*?[–-]\s*/,''));
  return to || activity;
}

function _isMealRow_(row={}){
  return /\b(breakfast|desayuno|lunch|almuerzo|dinner|cena|brunch|restaurant|restaurante|cafe|café|cafeteria|cafetería|food hall|mercado gastron[oó]mico)\b/i.test(
    `${row?.activity||''} ${row?.to||''}`
  );
}

function _isGenericMealDestination_(value=''){
  return /\b(local restaurant|restaurante local|nearby restaurant|restaurante cercano|local cafe|café local|nearby cafe|café cercano|food option|opci[oó]n de comida|similar option|opci[oó]n similar)\b/i.test(
    String(value||'')
  );
}

function _isUtilityRow_(row={}){
  const text=`${row?.activity||''} ${row?.to||''}`;
  if(/\b(return|regreso|retorno|arrival|llegada|departure|salida|hotel|lodging|alojamiento|parking|aparcamiento|fuel|combustible|check in|check-in|check out|check-out)\b/i.test(text)){
    return true;
  }

  // A generic meal is operational. A named restaurant or concrete food venue is a real POI
  // and must remain visible to trip-wide duplicate detection.
  if(_isMealRow_(row)){
    const to=String(row?.to||'').trim();
    return !to || _isGenericMealDestination_(to);
  }

  return false;
}

function _rowsLedger_(rows=[]){
  return (rows||[])
    .filter(r=>!_isUtilityRow_(r))
    .map(r=>({
      day:Number(r?.day||0),
      poi:_poiKeyFromRow_(r),
      activity:String(r?.activity||''),
      to:String(r?.to||'')
    }))
    .filter(x=>x.day>0 && x.poi);
}

function _chunkMasterDays_(days=[]){
  const arr=(Array.isArray(days)?days:[]).slice().sort((a,b)=>a.day-b.day);
  const chunks=[];
  for(let i=0;i<arr.length;i+=2) chunks.push(arr.slice(i,i+2));
  return chunks;
}

function _forceRowsIntoValidDayRange_(rows=[], allowedDays=[]){
  const allowed=new Set((allowedDays||[]).map(Number));
  return (rows||[])
    .map(r=>{
      let day=Number(r?.day||0);
      if(!allowed.has(day)) day=Number(allowedDays?.[0]||1);
      return normalizeRow({...r,day},day);
    })
    .filter(r=>allowed.has(Number(r?.day)));
}

function _hasUsableRowsForAllBlockDays_(rows=[], blockDays=[]){
  const days=new Set((rows||[]).filter(r=>String(r?.activity||'').trim()).map(r=>Number(r?.day)));
  return (blockDays||[]).every(d=>days.has(Number(d)));
}

function _masterPlanLedgerText_(masterDays=[]){
  return (masterDays||[])
    .map(x=>`Day ${x.day}: ${x.theme}`)
    .join('\n');
}

function _normalizeLodgingInput_(value=''){
  const original=String(value||'').trim();
  if(!original) return {original:'',normalized:''};

  // Preserve relational expressions because they carry meaningful geographic nuance.
  if(/^(near|close to|walking distance(?: from| to)?|next to|around)\b/i.test(original)){
    return {original,normalized:original};
  }

  // Remove only a simple leading "in" used as a wrapper, never internal words.
  const normalized=original.replace(/^in\s+/i,'').trim() || original;
  return {original,normalized};
}

function _preferenceConstraintPolicy_(){
  return {
    rule:'Treat every stated preference and restriction as an operational planning constraint, not as decorative notes.',
    precedence:'Explicit user preferences, restrictions, must-dos and special conditions take priority over generic tourism defaults whenever they are compatible with safety, feasibility and hard time boundaries.',
    completeness:'Do not silently drop a stated preference, restriction or must-do. Apply it in the itinerary when feasible; if a conflict makes it impossible, preserve the closest practical interpretation instead of ignoring it.',
    examples:[
      'Photography: favor strong light, sunrise, sunset, blue hour or suitable viewpoints when seasonally realistic.',
      'Avoid crowds: use earlier, later or lower-congestion sequencing when practical.',
      'No driving after sunset: finish self-drive legs and return to base before local darkness.',
      'Walking limit or reduced mobility: reduce continuous walking, add realistic transfers and breaks, and avoid unsuitable terrain.',
      'Vegetarian or dietary needs: choose concrete suitable meal venues or districts.',
      'Anniversary or celebration: include a fitting romantic or memorable experience without sacrificing logistics.'
    ],
    inference:'Infer reasonable defaults for blank fields, conservatively complete partial information, and prioritize detailed user instructions.'
  };
}

function _globalTimeWindowPolicy_(totalDays, perDay=[]){
  return {
    first_day:'Any provided start time is a hard boundary. Before sightseeing on the arrival day, the traveler first reaches the lodging and completes check-in or luggage drop.',
    final_day:'Any provided end time is a hard boundary.',
    intermediate_days:'Provided start/end times are preferences. They may be optimized only when this materially improves quality or logistics, without creating impractical hours.',
    default_end_when_missing:'19:00 local time is the minimum planning target, not a ceiling. If the user did not provide an end time, do not routinely finish before about 19:00. Continue later when a high-value evening experience, show, concert, atmospheric district, night viewpoint, special dinner or other destination-defining activity materially improves the itinerary. Do not force late nights without value. Any explicit user end time remains a hard boundary.',
    arrival_day_lodging_first:'Day 1 must reach the lodging/check-in or luggage drop before any sightseeing. Never schedule sightseeing before the lodging. If arrival transport details are unknown, do not invent an airport, flight or transfer origin.',
    windows:perDay,
    total_days:totalDays
  };
}

function _globalDayTripPolicy_(){
  return {
    rule:'Evaluate day trips globally and destination-agnostically.',
    decision_factors:[
      'total trip duration',
      'days needed to cover the core destination well',
      'relative tourism value of nearby excursions versus remaining secondary city activities',
      'door-to-door transfer time',
      'season, useful daylight and operating practicality',
      'traveler preferences, restrictions and transport',
      'route coherence and return to the lodging base'
    ],
    action:'Substitute lower-value secondary city filler with a stronger nearby excursion when the comparison clearly favors the excursion. Never displace unmet core highlights merely to add a day trip.',
    macro_tour_enrichment:'For important regional routes, evaluate high-value micro-stops directly on the route or requiring only a very small detour. Rank them by tourism value, route cost, rhythm and distinctiveness.',
    incremental_value:'Prefer a candidate that adds a new experience category over a repetitive variant already represented, unless the repeated candidate is exceptionally iconic.',
    quality_not_quantity:'Do not add stops merely to fill time. Remove weaker candidates when stronger alternatives exist.',
    prohibition:'Never use destination-name-specific conditions or hardcoded city lists.'
  };
}

function _knownUserFactsForCity_(city, totalDays, perDay, baseDate, hotel, transport){
  const lodging=_normalizeLodgingInput_(hotel);
  return {
    city,
    total_days:totalDays,
    base_date:baseDate||null,
    daily_windows:perDay,
    lodging_base:lodging.normalized||null,
    lodging_original:lodging.original||null,
    lodging_normalization_applied:!!(lodging.original && lodging.normalized!==lodging.original),
    lodging_policy:'Use lodging_base as the principal geographic anchor. On Day 1, lodging arrival/check-in or luggage drop happens before sightseeing. Minimize unnecessary transfers and start/end there whenever sensible. Never invent airport/flight arrival details when they were not provided.',
    transport:transport||null,
    global_day_trip_policy:_globalDayTripPolicy_(),
    time_window_policy:_globalTimeWindowPolicy_(totalDays,perDay),
    preference_constraint_policy:_preferenceConstraintPolicy_(),
    special_conditions:String(plannerState?.specialConditions || qs('#special-conditions')?.value || '').trim() || null,
    special_conditions_instruction:'Use special_conditions as authoritative user input throughout strategic distribution, activity selection, sequencing, logistics and validation. Never treat it as optional commentary.',
    travelers:plannerState?.travelers || null,
    traveler_profiles:plannerState?.travelerProfiles || null,
    budget:plannerState?.budget || null,
    currency:plannerState?.currency || null,
    explicitly_provided_departure:
      /\b(flight|vuelo|airport|aeropuerto|departure|salida|check[- ]?out|devolver|return car|rental company|europcar|hertz|avis)\b/i.test(
        String(plannerState?.specialConditions || '')
      )
  };
}

async function _buildCityMasterPlan_(city,totalDays,perDay,baseDate='',hotel='',transport='recommend me'){
  const facts=_knownUserFactsForCity_(city,totalDays,perDay,baseDate,hotel,transport);
  const prompt=`
${FORMAT}
ROLE: Astra. Produce STRATEGIC DISTRIBUTION METADATA ONLY for "${city}".

Return exactly:
{"destination":"${city}","rows":[...]}
with EXACTLY ${totalDays} rows, one per day.

For every row:
- day: correct day number.
- activity MUST be:
  "PLAN – <exclusive identity and geographic corridor> | Anchors: <3–8 concrete reserved anchors separated by semicolons>"
- from: "Planning"
- to: "Planning"
- transport: "Planning"
- duration: "Transport: planning\\nActivity: planning"
- notes: short strategic justification.

TRIP-WIDE RULES:
- Audit all ${totalDays} rows together before returning.
- No anchor, alias, district, landmark, restaurant, museum, thermal experience, wildlife experience,
  macro-route or corridor may be reserved on two days.
- Arrival and final days must have disjoint anchors.
- Decide intelligently whether nearby day trips should replace lower-value secondary city content. Compare total trip duration, core-city coverage needs, relative excursion quality, door-to-door transfer time, season/daylight, traveler fit and route coherence.
- Prefer strong unused regional/signature buckets over generic city filler when the comparison clearly favors them, but never displace unmet core city highlights.
- Use the normalized lodging base as the primary geographic anchor and reserve corridors that minimize unnecessary transfers.
- Convert all preferences and restrictions into actual day identities, timing and routing decisions.
- Apply the first/intermediate/final-day time policy contained in KNOWN USER FACTS.
- If inventory is exhausted, make a deliberately light but distinct day; never recycle icons.
- Respect the actual daily windows, season, useful daylight, travelers, base and transport.
- Do not invent flight, airport, check-out, rental company or car-return logistics.
- This is metadata only; do not generate detailed itinerary rows.
- JSON only.

KNOWN USER FACTS:
${JSON.stringify(facts)}
`.trim();

  console.log(`[MASTER PLAN] Requesting ${city} (${totalDays} days)...`);
  const raw=await _callPlannerSystemPrompt_(prompt,false);
  const parsed=parseJSON(raw);
  const out=_extractMasterPlanDays_(parsed,city,totalDays);
  console.log(`[MASTER PLAN] ${out.length===totalDays?'OK':'FAIL'}`,out);
  return out;
}

async function _generateBlockFromThemes_(
  city,totalDays,blockDaysObjs,allMasterDays,previousRows,perDay,
  forceReplan=false,hotel='',transport='recommend me',baseDate=''
){
  const dayNums=blockDaysObjs.map(x=>Number(x.day));
  const windows=perDay.filter(x=>dayNums.includes(Number(x?.day)));
  const facts=_knownUserFactsForCity_(city,totalDays,perDay,baseDate,hotel,transport);
  const previousLedger=_rowsLedger_(previousRows);

  const prompt=`
${FORMAT}
ROLE: Astra. Generate FINAL itinerary rows ONLY for days ${dayNums.join(', ')} of "${city}".

Return:
{"destination":"${city}","rows":[...],"replace":${forceReplan?'true':'false'}}

APPROVED TRIP-WIDE RESERVATION LEDGER:
${_masterPlanLedgerText_(allMasterDays)}

CURRENT BLOCK:
${JSON.stringify(blockDaysObjs)}

ALREADY GENERATED POIs (FORBIDDEN TO REPEAT):
${JSON.stringify(previousLedger)}

KNOWN USER FACTS:
${JSON.stringify(facts)}

HARD RULES:
- Generate rows only for days ${dayNums.join(', ')}.
- Follow each day's approved identity/corridor and reserved anchors.
- For each day, compare plausible geographic sequences and select the best one: minimize travel time, avoid backtracking, cluster nearby zones, respect the natural route direction and avoid returning to a completed district unless necessary.
- Validate every row mathematically before returning it: start-to-end must approximately equal transport plus activity. Correct or regenerate only the inconsistent row.
- Apply intelligent minimum dwell times by experience category. Never create 5–10 minute activities except clearly labeled photographic micro-stops.
- Detect semantic duplicate experiences, including aliases and overlapping district/sub-area descriptions, and keep only the strongest representation.
- Use lodging_base as the geographic origin/end anchor whenever sensible and minimize unnecessary transfers.
- Enforce every preference/restriction through actual activity, timing, route, transport and meal choices; do not merely repeat it in notes.
- On a full day spanning lunch, reserve a realistic meal break using local dining customs (fallback roughly 12:00–15:00). On a day trip, integrate lunch along the route without breaking geographic continuity.
- Respect the hard first-day start and final-day end boundaries; optimize intermediate windows only when beneficial. If a day has no user-provided end, treat approximately 19:00 local as the minimum target, not a ceiling; continue later when a high-value evening experience materially improves the itinerary.
- On Day 1, lodging arrival/check-in or luggage drop MUST occur before sightseeing. If arrival origin is unknown, do not invent an airport, flight or transfer; begin the tourism sequence only after the lodging step.
- Infer reasonable missing details and conservatively complete partial input, while prioritizing detailed instructions.
- Do not borrow anchors from any other day.
- When the approved identity is a regional route or macro-tour, enrich it like an expert guide: evaluate iconic or highly recommendable low-detour viewpoints, minor waterfalls, villages, beaches, churches, bridges, monuments, geological formations, short trails and photographic stops.
- Include a micro-stop only when it adds meaningful incremental tourism value, preserves route rhythm and does not materially increase total route time.
- Prefer diversity of experiences: once a category is already well represented, favor a distinct high-value category over another similar minor stop.
- Do not force extra rows. Remove weak stops when stronger alternatives exist.
- Do not repeat a POI from ALREADY GENERATED POIs, including aliases, exterior/interior, tower,
  viewpoint, express visit, conditional repeat, "last chance", named restaurant or contextual reuse.
- Arrival and final day must remain distinct.
- Do not invent a flight, airport transfer, check-out, rental company or car-return unless explicitly
  present in KNOWN USER FACTS.
- A row's activity describes the place visited in THAT row.
- Its To field must be that same concrete primary destination, not the next attraction.
- The following row's From must continue from the preceding To.
- One To and one primary transport choice per row; alternatives belong in notes.
- Every row interval must realistically contain transport plus activity. No overlaps and no unexplained
  gap over about 20 minutes.
- Scenic outdoor visits must fit plausible useful daylight for the date/latitude. Driving, indoor
  activities, meals and thermal experiences may use darker hours.
- For winter paths, do not claim unconditional access; require verification and give a safe fallback.
- Macro-routes must be geographically sequential, contain meaningful separate micro-stops and end
  with an explicit return to the lodging/base.
- Do not create a standalone aurora row by default. When plausible, put concise conditional aurora guidance as an ADDITIONAL note in the NOTES of the FINAL row of EVERY day in that city: realistic dark-hour window, safe self-drive when appropriate, guided-tour option, cloud/geomagnetic/road checks and no guarantee.
- The final-row aurora note must appear on EVERY plausible day, including when auroras were explicitly requested in Preferences. An explicit aurora preference alone NEVER becomes a dedicated row. Only a genuinely confirmed booking with a fixed time, separately provided by the user and explicitly requested for scheduling, may become a dedicated row.
- Preserve official proper names; all generic user-facing text and duration labels must use the
  selected itinerary language.
- Never use generic destinations such as "nearby village", "local restaurant", "services",
  "recommended place" or "similar option".
- Notes must sound natural and expert. Do not repeat fixed labels such as "Emotion:" and "Tip:" on
  every row. Include one specific operational or experiential insight instead.
- Target 4–8 useful rows on a normal full day, fewer on genuinely short/light days.
- No text outside JSON.

REFERENCE WINDOWS FOR THIS BLOCK:
${JSON.stringify(windows)}
`.trim();

  const label=`${dayNums[0]}${dayNums.length>1?'-'+dayNums.at(-1):''}`;
  console.log(`[BLOCK ${label}] Requesting rows with global ledger...`);
  const raw=await _callPlannerSystemPrompt_(prompt,false);
  const parsed=parseJSON(raw);
  if(!parsed) return [];

  const rows=_forceRowsIntoValidDayRange_(_extractPlannerRows_(parsed,city),dayNums);
  if(rows.length && _hasUsableRowsForAllBlockDays_(rows,dayNums)) return rows;
  console.warn(`[BLOCK ${label}] invalid/incomplete`);
  return [];
}

function _dedupeRows_(rows=[]){
  const seen=new Set(),out=[];
  for(const row of (rows||[])){
    const r=normalizeRow(row,Number(row?.day||1));
    const exact=[
      Number(r.day),r.start,r.end,_canonicalText_(r.activity),
      _canonicalText_(r.from),_canonicalText_(r.to)
    ].join('|');
    if(seen.has(exact)) continue;
    seen.add(exact);
    out.push(r);
  }
  return out.sort((a,b)=>Number(a.day)-Number(b.day)||String(a.start).localeCompare(String(b.start)));
}

function _rowsCoverAllDays_(rows=[],totalDays=1){
  const set=new Set((rows||[]).map(r=>Number(r?.day)));
  for(let d=1;d<=totalDays;d++) if(!set.has(d)) return false;
  return true;
}

function _rowsByDayObject_(rows=[]){
  const out={};
  for(const row of rows||[]){
    const day=Number(row?.day||1);
    if(!out[day]) out[day]=[];
    out[day].push(row);
  }
  Object.values(out).forEach(arr=>arr.sort((a,b)=>String(a.start).localeCompare(String(b.start))));
  return out;
}

function _arePoiAliases_(a='',b=''){
  const A=_canonicalText_(a),B=_canonicalText_(b);
  if(!A||!B) return false;
  if(A===B) return true;
  if(A.length>=6&&B.length>=6&&(A.includes(B)||B.includes(A))) return true;
  const aa=new Set(A.split(' ').filter(x=>x.length>=4));
  const bb=new Set(B.split(' ').filter(x=>x.length>=4));
  if(!aa.size||!bb.size) return false;
  let common=0; for(const x of aa) if(bb.has(x)) common++;
  return common/Math.min(aa.size,bb.size)>=0.7;
}


function _parseBaseDate_(baseDate=''){
  const parsed=parseDMY(baseDate);
  return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

function _dayDate_(baseDate='',day=1){
  const base=_parseBaseDate_(baseDate);
  return base ? addDays(base,Math.max(0,Number(day||1)-1)) : null;
}

function _isHighLatitudeWinterContext_(city='',baseDate=''){
  const normalized=_canonicalText_(`${city} ${plannerState?.specialConditions||''}`);
  const date=_parseBaseDate_(baseDate);
  const month=date ? date.getMonth()+1 : null;

  const highLatitude=/\b(iceland|reykjavik|akureyri|husavik|vik|norway|tromso|alta|lofoten|svalbard|bodo|sweden|kiruna|abisko|finland|rovaniemi|lapland|greenland|nuuk|ilulissat|faroe|alaska|fairbanks|anchorage|yellowknife|whitehorse|nunavut|yukon|scotland|orkney|shetland)\b/i.test(normalized.replace(/\s+/g,' '));

  const northernWinter=month==null || [10,11,12,1,2,3].includes(month);
  return highLatitude && northernWinter;
}

function _winterUsefulDaylightWindow_(city='',baseDate='',day=1){
  if(!_isHighLatitudeWinterContext_(city,baseDate)) return null;
  const date=_dayDate_(baseDate,day);
  const month=date ? date.getMonth()+1 : 1;

  // Conservative planning windows. These are not live sunrise calculations.
  // They deliberately protect scenic visits from darkness at high latitude.
  const byMonth={
    10:{start:540,end:1050},
    11:{start:570,end:990},
    12:{start:600,end:930},
    1:{start:585,end:1005},
    2:{start:555,end:1050},
    3:{start:510,end:1110}
  };
  return byMonth[month] || {start:570,end:1020};
}

function _isScenicOutdoorRow_(row={}){
  return /\b(waterfall|cascada|beach|playa|cliff|acantilado|viewpoint|mirador|lookout|lighthouse|faro|crater|cr[aá]ter|geyser|g[eé]iser|geothermal field|campo geot[eé]rmico|volcano|volc[aá]n|lake|lago|lagoon shore|orilla|trail|sendero|hike|caminata|mountain|monta[nñ]a|canyon|ca[nñ][oó]n|coast|costa|fjord|fiordo|glacier|glaciar|national park|parque nacional|rock formation|formaci[oó]n rocosa|black sand|arena negra)\b/i.test(`${row?.activity||''} ${row?.to||''} ${row?.notes||''}`.replace(/\s+/g,' '));
}

function _isAuroraRow_(row={}){
  return /\b(aurora|northern lights|luces del norte|aurore bor[eé]ale|nordlicht)\b/i.test(
    `${row?.activity||''} ${row?.to||''} ${row?.notes||''}`
  );
}

function _isAuroraActivityRow_(row={}){
  return /\b(aurora|northern lights|luces del norte|aurore bor[eé]ale|nordlicht)\b/i.test(
    `${row?.activity||''} ${row?.to||''}`
  );
}

function _explicitlyRequestedFixedAurora_(){
  const text=String(plannerState?.specialConditions||'').replace(/\s+/g,' ');
  const hasAurora=/\b(aurora|northern lights|luces del norte|aurore bor[eé]ale|nordlicht)\b/i.test(text);
  const hasConfirmedBooking=/\b(confirmed|confirmad[oa]|booked|reservad[oa]|reservation confirmed|reserva confirmada|booking confirmed)\b/i.test(text);
  const hasFixedTime=/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(text);
  return hasAurora && hasConfirmedBooking && hasFixedTime;
}

function _genericPlaceReason_(value=''){
  const text=String(value||'').trim();
  if(!text) return 'EMPTY_PLACE';

  const generic=/\b(nearby village|pueblo cercano|local village|pueblo local|nearby town|ciudad cercana|local restaurant|restaurante local|similar option|opci[oó]n similar|recommended place|lugar recomendado|selected place|lugar seleccionado|local cafe|café local|nearby cafe|café cercano|city center|centro de la ciudad|main area|zona principal|services|servicios|planning)\b/i;

  if(generic.test(text.replace(/\s+/g,' '))) return 'GENERIC_PLACE';
  return '';
}

function _activityProfile_(row={}){
  const text=_canonicalText_(`${row?.activity||''} ${row?.to||''} ${row?.transport||''} ${row?.notes||''}`);

  if(/\b(blue lagoon|thermal lagoon|termal lagoon|spa complex|hot spring complex|laguna termal|complejo termal)\b/.test(text)){
    return {type:'MAJOR_THERMAL',min:180};
  }
  if(/\b(whale watching|avistamiento de ballenas|wildlife cruise|marine safari|safari marino|boat wildlife)\b/.test(text)){
    return {type:'WILDLIFE_CRUISE',min:150};
  }
  if(/\b(food tour|walking tour|guided tour|tour gastron[oó]mico|tour guiado|recorrido guiado)\b/.test(text)){
    return {type:'SUBSTANTIAL_GUIDED_TOUR',min:150};
  }
  if(/\b(large museum|major museum|immersive museum|museo nacional|museo grande|exposici[oó]n inmersiva)\b/.test(text)){
    return {type:'LARGE_MUSEUM',min:90};
  }
  if(/\b(theme park|parque tem[aá]tico|palace complex|complejo palaciego|archaeological complex|complejo arqueol[oó]gico)\b/.test(text)){
    return {type:'MAJOR_COMPLEX',min:180};
  }
  if(/\b(round trip walk|round-trip walk|return hike|hike to|walk to the wreck|caminata ida y vuelta|sendero ida y vuelta|caminata al fuselaje|plane wreck|restos del avi[oó]n)\b/.test(text)){
    return {type:'SUBSTANTIAL_HIKE',min:90};
  }
  return null;
}

function _activityDurationBounds_(duration=''){
  return _durationBoundsMinutes_(_extractDurationPart_(duration,'activity'));
}

function _regionalDayLooksThin_(rows=[]){
  const meaningful=(rows||[]).filter(r=>!_isUtilityRow_(r));
  const regionalSignal=(rows||[]).some(r=>
    /\b(route|ruta|circle|c[ií]rculo|peninsula|pen[ií]nsula|coast|costa|day trip|excursi[oó]n|region|regional)\b/i.test(
      `${r?.activity||''} ${r?.notes||''}`
    )
  );
  return regionalSignal && meaningful.length<4;
}

function _noteTemplateRatio_(rows=[]){
  const useful=(rows||[]).filter(r=>String(r?.notes||'').trim());
  if(useful.length<4) return 0;
  const templated=useful.filter(r=>
    /^\s*(emotion|emoci[oó]n|tip|consejo|highlight|destacado)\s*:/i.test(String(r.notes||''))
  ).length;
  return templated/useful.length;
}

function _auditSeverity_(error={}){
  const critical=new Set([
    'MISSING_DAY','INVALID_TIME','OVERLAP','CONTINUITY','GLOBAL_DUPLICATE_POI',
    'ROW_TOO_SHORT','INVENTED_DEPARTURE_LOGISTICS','OUTDOOR_OUTSIDE_USEFUL_DAYLIGHT',
    'CATEGORY_DWELL_TOO_SHORT','ANCHOR_TIME_HIDDEN_AS_GAP','AMBIGUOUS_TO','GENERIC_TO',
    'END_BEFORE_MINIMUM_TARGET','MISSING_AURORA_FINAL_NOTE'
  ]);
  const major=new Set([
    'ROW_INTERVAL_UNEXPLAINED','DURATION_UNPARSEABLE','AMBIGUOUS_TRANSPORT',
    'RIGID_AURORA_ROW','REGIONAL_DAY_TOO_THIN','REPETITIVE_NOTE_TEMPLATE'
  ]);
  if(critical.has(error?.code)) return 10;
  if(major.has(error?.code)) return 4;
  return 1;
}

function _auditScore_(report={}){
  return (report?.errors||[]).reduce((sum,error)=>sum+_auditSeverity_(error),0);
}

function _hasCriticalAuditErrors_(report={}){
  return (report?.errors||[]).some(error=>_auditSeverity_(error)>=10);
}

function _localGlobalAudit_(city,rows,totalDays,masterDays,perDay,baseDate=''){
  const errors=[];
  const byDay=_rowsByDayObject_(rows);
  const seenPois=[];

  for(let day=1;day<=totalDays;day++){
    const dayRows=byDay[day]||[];
    if(!dayRows.length) errors.push({code:'MISSING_DAY',day});

    const daylight=_winterUsefulDaylightWindow_(city,baseDate,day);
    let priorEnd=null;
    let priorTo='';

    for(let i=0;i<dayRows.length;i++){
      const r=dayRows[i];
      const row=i+1;
      const start=_hhmmToMinutes_(r.start);
      const end=_hhmmToMinutes_(r.end);

      if(start==null||end==null){
        errors.push({code:'INVALID_TIME',day,row,start:r.start,end:r.end});
      }else{
        let span=end-start;
        if(span<=0) span+=1440;

        const total=_durationTotalBounds_(r.duration);
        if(total){
          if(total.min>span+5){
            errors.push({code:'ROW_TOO_SHORT',day,row,span,needed:total.min});
          }
          if(span-total.max>25){
            errors.push({
              code:'ROW_INTERVAL_UNEXPLAINED',
              day,row,span,explained:total.max,unexplained:span-total.max
            });
          }
        }else{
          errors.push({code:'DURATION_UNPARSEABLE',day,row,duration:r.duration});
        }

        if(priorEnd!=null && start<priorEnd){
          errors.push({code:'OVERLAP',day,row});
        }
        priorEnd=end;

        if(daylight && _isScenicOutdoorRow_(r) && !_isAuroraRow_(r)){
          const outdoorStart=start;
          const outdoorEnd=end;
          const tolerance=15;
          if(outdoorStart<daylight.start-tolerance || outdoorEnd>daylight.end+tolerance){
            errors.push({
              code:'OUTDOOR_OUTSIDE_USEFUL_DAYLIGHT',
              day,row,start:r.start,end:r.end,
              useful_window:`${_minutesToHHMM_(daylight.start)}-${_minutesToHHMM_(daylight.end)}`
            });
          }
        }
      }

      if(i>0 && priorTo && r.from && !_arePoiAliases_(priorTo,r.from)){
        errors.push({
          code:'CONTINUITY',
          day,row,
          previous_to:priorTo,
          current_from:r.from
        });
      }
      priorTo=r.to;

      if(!_isUtilityRow_(r)){
        const poi=_poiKeyFromRow_(r);
        for(const prior of seenPois){
          if(prior.day!==day && _arePoiAliases_(poi,prior.poi)){
            errors.push({
              code:'GLOBAL_DUPLICATE_POI',
              days:[prior.day,day],
              first:prior.label,
              second:r.to||r.activity
            });
            break;
          }
        }
        if(poi){
          seenPois.push({day,poi,label:r.to||r.activity});
        }
      }

      const genericReason=_genericPlaceReason_(r.to);
      if(genericReason){
        errors.push({code:'GENERIC_TO',day,row,to:r.to,reason:genericReason});
      }

      if(/\s\/\s|\bor\b|\bo\b|\balternative\b|\balternativa\b|\bif full\b|\bsi est[aá] lleno\b/i.test(String(r.to||''))){
        errors.push({code:'AMBIGUOUS_TO',day,row,to:r.to});
      }

      if(/\s\/\s|\bor\b|\bo\b|\balternative\b|\balternativa\b|\bif preferred\b|\bsi prefieres\b/i.test(String(r.transport||''))){
        errors.push({code:'AMBIGUOUS_TRANSPORT',day,row,transport:r.transport});
      }

      const profile=_activityProfile_(r);
      const activityBounds=_activityDurationBounds_(r.duration);
      if(profile && (!activityBounds || activityBounds.min<profile.min)){
        errors.push({
          code:'CATEGORY_DWELL_TOO_SHORT',
          day,row,
          category:profile.type,
          required_minimum_minutes:profile.min,
          actual_minimum_minutes:activityBounds?.min||0
        });
      }

      if(profile && i<dayRows.length-1){
        const nextStart=_hhmmToMinutes_(dayRows[i+1]?.start);
        if(end!=null && nextStart!=null){
          let gap=nextStart-end;
          if(gap<0) gap+=1440;
          if(gap>30 && gap<=120){
            errors.push({
              code:'ANCHOR_TIME_HIDDEN_AS_GAP',day,row,gap,
              category:profile.type,
              instruction:'Include the complete anchor experience in the row activity duration and end time; do not hide it as blank time.'
            });
          }
        }
      }

      if(_isAuroraActivityRow_(r) && !_explicitlyRequestedFixedAurora_()){
        errors.push({
          code:'RIGID_AURORA_ROW',
          day,row,
          instruction:'Remove the standalone aurora row. Even when auroras or an aurora tour were explicitly requested in Preferences, aurora guidance belongs as an ADDITIONAL note in the FINAL row of EVERY plausible day. Only a genuinely confirmed fixed-time booking may remain as a row.'
        });
      }
    }

    if(_regionalDayLooksThin_(dayRows)){
      errors.push({code:'REGIONAL_DAY_TOO_THIN',day,row_count:dayRows.length});
    }

    // HARD QUALITY RULE: when the user leaves the end time blank,
    // ~19:00 is the minimum planning target, not a ceiling.
    const dayWindow=(perDay||[]).find(x=>Number(x?.day)===day) || {};
    if(dayRows.length && !dayWindow?.end_provided){
      const lastRow=dayRows[dayRows.length-1] || {};
      const lastStart=_hhmmToMinutes_(lastRow.start);
      let lastEnd=_hhmmToMinutes_(lastRow.end);
      if(lastStart!=null && lastEnd!=null && lastEnd<=lastStart) lastEnd+=1440;

      if(lastEnd!=null && lastEnd < (19*60)){
        errors.push({
          code:'END_BEFORE_MINIMUM_TARGET',
          day,
          actual_end:lastRow.end,
          minimum_target:'19:00',
          instruction:'The user did not provide an end time. Rebuild the day so useful planning reaches at least approximately 19:00. It may continue later for genuinely high-value evening experiences. Do not add filler merely to reach the clock.'
        });
      }
    }

    // HARD QUALITY RULE: in a plausible aurora city/season, EVERY day must carry
    // an additional aurora opportunity note in the Notes of that day's FINAL row.
    // An explicit aurora preference still remains a note; it does not become a row.
    if(dayRows.length && _isHighLatitudeWinterContext_(city,baseDate)){
      const lastRow=dayRows[dayRows.length-1] || {};
      if(!_isAuroraRow_({notes:lastRow.notes||''})){
        errors.push({
          code:'MISSING_AURORA_FINAL_NOTE',
          day,
          row:dayRows.length,
          instruction:'Add an aurora opportunity as an ADDITIONAL note in the Notes field of this day\'s FINAL row. Do this for every day in this city when latitude/season/darkness make auroras plausible, even if the user explicitly requested auroras in Preferences. Mention clear/cloud conditions, geomagnetic conditions, no guarantee, and guided-tour option. Do not create a standalone aurora row.'
        });
      }
    }
  }

  const known=String(plannerState?.specialConditions||'');
  const inventedDeparture=
    !/\b(flight|vuelo|airport|aeropuerto|departure|salida|check[- ]?out|devolver|return car|rental company|europcar|hertz|avis)\b/i.test(known) &&
    (rows||[]).some(r=>
      /\b(airport|aeropuerto|check[- ]?out|europcar|hertz|avis|return.*car|devoluci[oó]n.*veh[ií]culo)\b/i.test(
        `${r.activity} ${r.to} ${r.notes}`
      )
    );
  if(inventedDeparture){
    errors.push({code:'INVENTED_DEPARTURE_LOGISTICS'});
  }

  const noteRatio=_noteTemplateRatio_(rows);
  if(noteRatio>=0.55){
    errors.push({
      code:'REPETITIVE_NOTE_TEMPLATE',
      ratio:Number(noteRatio.toFixed(2)),
      instruction:'Rewrite notes naturally without repeating fixed labels such as Emotion/Tip on every row.'
    });
  }

  return {
    ok:errors.length===0,
    score:errors.reduce((sum,error)=>sum+_auditSeverity_(error),0),
    errors
  };
}
async function _runTripWideRepairCall_(
  city,rows,totalDays,masterDays,facts,report,forceReplan=false,precisionPass=false
){
  const passTitle=precisionPass
    ? 'FINAL PRECISION REPAIR'
    : 'FINAL TRIP-WIDE REPAIR';

  const prompt=`
${FORMAT}
ROLE: Astra, expert final itinerary auditor and concierge.

${passTitle}

Return ONLY:
{"destination":"${city}","rows":[...],"replace":${forceReplan?'true':'false'}}

You are receiving the COMPLETE itinerary for all ${totalDays} days.
Return the COMPLETE corrected itinerary, never a report and never only changed rows.

APPROVED TRIP-WIDE RESERVATION LEDGER:
${_masterPlanLedgerText_(masterDays)}

KNOWN USER FACTS:
${JSON.stringify(facts)}

DETERMINISTIC AUDIT:
${JSON.stringify(report)}

CURRENT COMPLETE ITINERARY:
${JSON.stringify(rows)}

NON-NEGOTIABLE FINAL REQUIREMENTS:
- Preserve strong valid content while resolving every critical and major audit issue.
- Treat this as the trip-wide second quality pass: score all days comparatively, identify the weakest day, and improve it only when a clearly stronger alternative exists within preferences, schedule, logistics, budget and lodging constraints.
- Cover exactly days 1 through ${totalDays}; no missing or extra days.
- Enforce global uniqueness across aliases and contexts. A named restaurant, landmark, district,
  museum, viewpoint, thermal experience, wildlife experience and macro-route may appear on one day only.
- Arrival and final days must use disjoint major anchors.
- Replace a repeated POI with a strong unused on-theme option. If premium inventory is exhausted,
  keep the day intentionally light rather than repeating icons.
- Never invent flights, airports, check-out, rental companies or vehicle-return logistics.
- The To field is the concrete place visited in that row. The next row's From must continue from it.
- The activity described in each row must occur at that row's To place. Never shift the activity to From while To points at the next stop.
- Reservation-based anchor experiences must occupy their complete realistic block. For a destination spa/thermal complex, use at least 3 hours of activity and include check-in/changing/exit time as appropriate; never represent the real stay as a blank gap after a short row.
- Keep exact geographic continuity and avoid teleporting, backtracking and shifted destinations.
- When an end time is blank, approximately 19:00 local is a MINIMUM planning target, not a ceiling. Do not finish a normal day before about 19:00 without a real constraint. Continue later when genuinely high-value evening content improves the itinerary. Respect any explicit user end time as a hard boundary.
- Day 1 must complete lodging arrival/check-in or luggage drop before sightseeing. Do not invent arrival transport details.
- A full day spanning lunch should contain a realistic meal break using local dining customs; for day trips, place lunch on-route without creating backtracking.
- Re-sequence each day when needed to minimize travel time, cluster nearby areas, preserve natural route direction and avoid revisiting a completed district.
- Use one concrete To and one primary transport choice per row. Put conditional alternatives in Notes.
- Reject generic destinations such as "nearby village", "local restaurant", "services" or "similar option".
- Every row interval must contain transport plus activity with no more than about 20 minutes unexplained.
- Reconcile duration with the transport field and preserve realistic long ranges.
- Keep category dwell realistic:
  * major thermal experience: at least 3 hours when comparable to a destination spa;
  * whale watching or wildlife cruise: normally at least 2 hours 30 minutes of activity;
  * substantial guided tour: normally at least 2 hours 30 minutes;
  * large museum or immersive exhibition: normally at least 1 hour 30 minutes;
  * substantial round-trip hike: include the complete walking time.
- Protect plausible useful daylight for scenic outdoor stops at the actual date and latitude.
  Driving, indoor attractions, meals and thermal experiences may use darker hours.
- If a regional route does not fit daylight, remove the weakest stop instead of moving it into darkness.
- A regional day should contain a useful, geographically coherent set of major stops and expert-selected micro-stops, with an explicit return to the named base unless sleeping elsewhere.
- For a full-day scenic route, evaluate a broad candidate pool and normally retain roughly 4–8 meaningful visit stops when daylight, safety and timing allow. This is not a quota: preserve realistic dwell at anchor experiences and remove weak filler.
- For macro-tours, evaluate low-detour viewpoints, villages, beaches, churches, bridges, monuments, geological formations, short trails and photographic stops; retain only those with strong incremental tourism value.
- Prefer experience diversity over repetitive minor variants, and never add rows merely to fill space.
- In every city/date where auroras are plausible, add an aurora opportunity as an ADDITIONAL note in the NOTES of the FINAL row of EVERY day, not just one selected night. This applies even when the user explicitly requested auroras or an aurora tour in Preferences. Each daily note should mention that visibility is not guaranteed and depends on clear/cloud conditions and geomagnetic activity, and should mention the guided-tour option. Do not create a standalone aurora row. Only a genuinely confirmed fixed-time booking separately provided by the user may remain as a dedicated row.
- Use the selected itinerary language consistently, including duration labels.
- Write like an expert human concierge:
  * specific, practical and destination-aware;
  * no repeated "Emotion:" / "Tip:" formula on every row;
  * no generic filler, unsupported facts, live-condition claims or promotional clichés;
  * one genuinely useful operational or experiential insight per row.
- Preserve official proper names.
- JSON only.
`.trim();

  const raw=await _callPlannerSystemPrompt_(prompt,false);
  const parsed=parseJSON(raw);
  if(!parsed) return null;

  const repaired=_dedupeRows_(_extractPlannerRows_(parsed,city));
  if(!repaired.length || !_rowsCoverAllDays_(repaired,totalDays)) return null;
  return repaired;
}

async function _finalTripWideRepair_(
  city,rows,totalDays,masterDays,perDay,baseDate,hotel,transport,forceReplan=false
){
  const facts=_knownUserFactsForCity_(city,totalDays,perDay,baseDate,hotel,transport);
  let currentRows=_dedupeRows_(rows);
  let currentReport=_localGlobalAudit_(
    city,currentRows,totalDays,masterDays,perDay,baseDate
  );

  const firstRepair=await _runTripWideRepairCall_(
    city,currentRows,totalDays,masterDays,facts,currentReport,forceReplan,false
  );

  if(firstRepair){
    const firstReport=_localGlobalAudit_(
      city,firstRepair,totalDays,masterDays,perDay,baseDate
    );
    if(_auditScore_(firstReport)<_auditScore_(currentReport)){
      currentRows=firstRepair;
      currentReport=firstReport;
    }
  }

  // A second call is allowed only when critical deterministic issues still remain.
  // This keeps latency bounded while preventing publication of obvious duplicates,
  // impossible timing, daylight violations or invented logistics.
  if(_hasCriticalAuditErrors_(currentReport)){
    const precisionRepair=await _runTripWideRepairCall_(
      city,currentRows,totalDays,masterDays,facts,currentReport,forceReplan,true
    );
    if(precisionRepair){
      const precisionReport=_localGlobalAudit_(
        city,precisionRepair,totalDays,masterDays,perDay,baseDate
      );
      if(_auditScore_(precisionReport)<_auditScore_(currentReport)){
        currentRows=precisionRepair;
        currentReport=precisionReport;
      }
    }
  }

  return {
    rows:currentRows,
    report:currentReport,
    repaired:_auditScore_(currentReport)<_auditScore_(
      _localGlobalAudit_(city,rows,totalDays,masterDays,perDay,baseDate)
    )
  };
}
async function generateCityItinerary(city){
  const _cityGenerationStartedAt_=performance.now();
  const _recordCityGenerationTime_=()=>{
    if(!_astraGenerationMetrics_.active) return;
    const elapsed=performance.now()-_cityGenerationStartedAt_;
    const existing=_astraGenerationMetrics_.cities.find(x=>x.city===city);
    if(existing){
      existing.ms=Math.round(elapsed);
      existing.duration=_formatGenerationDuration_(elapsed);
    }else{
      _astraGenerationMetrics_.cities.push({
        city,
        ms:Math.round(elapsed),
        duration:_formatGenerationDuration_(elapsed)
      });
    }
    console.log(`[ASTRA TIMER] ${city}: ${_formatGenerationDuration_(elapsed)}`);
  };

  const dest=savedDestinations.find(x=>x.city===city);
  if(!dest) return;

  const perDay=_normalizePerDayForPrompt_(city,dest.days,dest.perDay||[]);
  const baseDate=cityMeta[city]?.baseDate||dest.baseDate||'';
  const hotel=cityMeta[city]?.hotel||'';
  const transport=cityMeta[city]?.transport||'recommend me';
  const forceReplan=!!plannerState?.forceReplan?.[city];

  showWOW(true,t('overlayDefault'));

  try{
    const masterDays=await _buildCityMasterPlan_(city,dest.days,perDay,baseDate,hotel,transport);
    if(masterDays.length!==dest.days) throw new Error(`MASTER_PLAN_INVALID:${city}`);

    if(!itineraries[city]) itineraries[city]={byDay:{},currentDay:1,baseDate:baseDate||null,masterPlan:[],audit:null};
    itineraries[city].masterPlan=masterDays;

    const blocks=_chunkMasterDays_(masterDays);
    let stitchedRows=[];

    for(const block of blocks){
      const blockRows=await _generateBlockFromThemes_(
        city,dest.days,block,masterDays,stitchedRows,perDay,
        forceReplan,hotel,transport,baseDate
      );
      if(!blockRows.length){
        const first=Number(block?.[0]?.day||1),last=Number(block?.at(-1)?.day||first);
        throw new Error(`BLOCK_FAIL:${city}:${first}-${last}`);
      }
      stitchedRows.push(...blockRows);
      stitchedRows=_dedupeRows_(stitchedRows);
    }

    if(!_rowsCoverAllDays_(stitchedRows,dest.days)) throw new Error(`MISSING_DAYS_AFTER_STITCH:${city}`);

    const finalResult=await _finalTripWideRepair_(
      city,stitchedRows,dest.days,masterDays,perDay,baseDate,hotel,transport,forceReplan
    );

    const finalRows=_dedupeRows_(finalResult.rows);
    itineraries[city].audit=finalResult.report;

    // Replace every generated day atomically; do not merge stale rows.
    pushRows(city,finalRows,true);

    renderCityTabs();
    setActiveCity(city);
    renderCityItinerary(city);
    $resetBtn?.removeAttribute('disabled');
    if(plannerState?.forceReplan) delete plannerState.forceReplan[city];

    showWOW(false);
    console.log(`[CITY ${city}] SUCCESS v63`,{
      rows:finalRows.length,
      repaired:finalResult.repaired,
      remainingIssues:finalResult.report?.errors?.length||0
    });
    _recordCityGenerationTime_();
    return;
  }catch(err){
    console.error(`[CITY ${city}] v63 staged flow failed; using coherent one-shot recovery`,err);
  }

  // Coherent one-shot recovery still receives all user facts and must return the complete city.
  try{
    const facts=_knownUserFactsForCity_(city,dest.days,perDay,baseDate,hotel,transport);
    const prompt=`
${FORMAT}
ROLE: Astra. Generate the COMPLETE final itinerary for "${city}" covering days 1–${dest.days}.
Return {"destination":"${city}","rows":[...],"replace":true} and JSON only.

KNOWN USER FACTS:
${JSON.stringify(facts)}

HARD RULES:
- Respect the global time policy: first-day provided start and final-day provided end are hard boundaries; intermediate windows are preferences that may be optimized when useful. If end is blank, treat approximately 19:00 local as the minimum target, not a ceiling, and continue later when worthwhile evening content materially improves the itinerary.
- Day 1 reaches the lodging/checks in or drops luggage before any sightseeing; do not invent airport/flight/arrival transport details when unknown.
- Use the lodging/address/coordinates/area as the primary geographic base, minimizing unnecessary transfers and returning there when sensible.
- Enforce every preference and restriction through actual planning choices, not merely notes.
- Intelligently evaluate nearby day trips against remaining secondary city content using trip length, core coverage, relative tourism value, transfer time and logistics.
- Infer sensible defaults for missing information, complete partial input conservatively and prioritize detailed instructions.
- Do not invent airport, flight, check-out, rental company or return logistics.
- Build globally distinct day identities before generating rows.
- No major POI, district, restaurant, museum, viewpoint, thermal experience or macro-route may repeat.
- Arrival and final days must be different.
- To is the place visited in the same row; the next From continues from it.
- Every interval must contain transport plus activity; use realistic category dwell and conservative
  regional transfers.
- Scenic outdoor stops must fit plausible useful daylight.
- Regional days require logical micro-stops, a realistic on-route lunch/meal break when the day spans lunch, and explicit return to the lodging/base near the applicable end time.
- Aurora, when plausible, belongs as an ADDITIONAL note in the NOTES of the FINAL row of EVERY day in that city rather than a standalone activity. This applies even when explicitly requested in Preferences.
- One concrete To and one transport choice per row.
- Use one selected language consistently, including duration labels.
`.trim();

    const raw=await _callPlannerSystemPrompt_(prompt,false);
    const parsed=parseJSON(raw);
    let rows=_dedupeRows_(_extractPlannerRows_(parsed,city));
    if(!rows.length || !_rowsCoverAllDays_(rows,dest.days)) throw new Error('ONE_SHOT_INVALID');

    const syntheticMaster=Array.from({length:dest.days},(_,i)=>({
      day:i+1,theme:`Distinct day ${i+1} | Anchors: unique unused experiences`
    }));
    const finalResult=await _finalTripWideRepair_(
      city,rows,dest.days,syntheticMaster,perDay,baseDate,hotel,transport,true
    );
    rows=_dedupeRows_(finalResult.rows);
    pushRows(city,rows,true);
    itineraries[city].audit=finalResult.report;

    renderCityTabs();
    setActiveCity(city);
    renderCityItinerary(city);
    $resetBtn?.removeAttribute('disabled');
    if(plannerState?.forceReplan) delete plannerState.forceReplan[city];
    showWOW(false);
    _recordCityGenerationTime_();
    return;
  }catch(err2){
    console.error(`[CITY ${city}] v61 recovery failed`,err2);
  }finally{
    showWOW(false);
  }

  _recordCityGenerationTime_();

  const msg=getLang()==='es'
    ? 'I could not complete a coherent itinerary. Please retry or temporarily reduce the number of days.'
    : 'I could not complete a coherent itinerary. Please retry or temporarily reduce the number of days.';
  chatMsg(msg,'ai');
}

/* =========================================================
   End v60 staged generation
========================================================= */

/* 🆕 Bulk rebalance after changes (add days / requested day trip) */
async function rebalanceWholeCity(city, opts={}){
  const data = itineraries[city];
  const totalDays = Object.keys(data.byDay||{}).length;
  const perDay = _normalizePerDayForPrompt_(city, totalDays);
  const baseDate = data.baseDate || cityMeta[city]?.baseDate || '';
  const wantedTrip = (opts.dayTripTo||'').trim();

  // 🆕 Determine rebalance range
  const startDay = opts.start || 1;
  const endDay = opts.end || totalDays;
  const lockedDaysText = startDay > 1 
    ? `Keep days 1 to ${startDay - 1} intact.`
    : '';

  // 🧭 Detect if we must force replanning
  const forceReplan = (typeof plannerState !== 'undefined' && plannerState.forceReplan && plannerState.forceReplan[city]) ? true : false;

  const prompt = `
${FORMAT}
**ROLE:** Rebalance the city "${city}" between days ${startDay} and ${endDay}, keeping what is plausible and filling gaps.
${lockedDaysText}
- Format B {"destination":"${city}","rows":[...],"replace": ${forceReplan ? 'true' : 'false'}}.

KEY RULES (MANDATORY):
- "activity" MUST ALWAYS: "Destination – <Specific sub-stop>" (includes returns/transfers).
  • "Destination" is NOT always the city: if a row belongs to a day trip/macro-tour, "Destination" must be the macro-tour name (e.g., "Golden Circle", "South Coast", "Toledo").
  • If it's NOT a day trip, "Destination" can be "${city}".
- from/to/transport/notes: NEVER empty. Avoid generic items without clear names.
- VERY IMPORTANT:
  • "from" and "to" must be REAL places, NEVER the macro-tour name.
  • Avoid rows like "${city} – Excursion to <Macro-tour>" where "to" is the macro-tour. If there is a macro-tour, the first row must be "<Macro-tour> – Departure from ${city}" with "to" = first real sub-stop.

TRANSPORT (smart priority, no invention):
- In city: Walk/Metro/Bus/Tram depending on real availability.
- For DAY TRIPS:
  1) If there is a reasonable public transport option that is clearly “the best choice” for that route, use it (realistic intercity train/bus).
  2) If it’s NOT clearly viable/best (many scattered stops, weak schedules, difficult season), use EXACTLY: "Rental Car or Guided Tour".
- Avoid generic "Bus" label for day trips if it's actually a tour: use "Guided Tour (Bus/Van)" or the fallback above.

AURORAS (if plausible):
- Do NOT create a standalone aurora activity merely because the user asked for auroras.
- Add an aurora opportunity as an ADDITIONAL note in the NOTES of the FINAL row of EVERY day in that city.
- Each note must use a realistic dark-hour window, explain that visibility is not guaranteed and depends on clouds/weather and geomagnetic activity, and mention a guided-tour option.
- Only a genuinely confirmed fixed-time booking separately supplied by the user may be represented as a dedicated row.

DAY TRIPS / MACRO-TOURS (no hard limits, with judgment):
- You may include day trips if they add value (no fixed rule). Decide intelligently.
- Guideline: ideally ≤ ~3h per one-way drive. If near the limit, adjust stops/window.
- If you include a day trip:
  • 5–8 sub-stops (rows) with realistic sequence.
  • The FIRST macro-tour row must be: "<Macro-tour> – Departure from ${city}" (and "to" = first real sub-stop).
  • Must end with a final dedicated row using the macro-tour Destination: "<Macro-tour> – Return to ${city}".
  • If it's a classic route, reach the logical end highlight before returning.
  • Avoid optimistic returns: use conservative estimates in winter or at night.

QUALITY:
- Respect time windows as reference: ${JSON.stringify(perDay.filter(x => x.day >= startDay && x.day <= endDay))}.
- Consider key highlights and distribute without duplication.
${wantedTrip ? `- User preference: day trip to "${wantedTrip}". If reasonable, integrate it (complete macro-tour) and close with return.` : ''}
- The last day can be lighter, but don’t leave it “empty” if key highlights remain.
- Validate plausibility and safety; replace with safe alternatives when needed.
- Notes must ALWAYS be useful (never empty or "seed").

Current context (to merge without deleting): 
${buildIntake()}
`.trim();

  showWOW(true, t('overlayDefault'));

  // ✅ SURGICAL (CRITICAL): prompt as SYSTEM, language anchor as USER
  const ans = await _callPlannerSystemPrompt_(prompt, true);
  const parsed = parseJSON(ans);
  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries || parsed.city_day)){
    let rows = _extractPlannerRows_(parsed, city);

    const val = await validateRowsWithAgent(city, rows, baseDate);
    pushRows(city, val.allowed, forceReplan);

    // 🧠 Optimize only affected range
    for(let d=startDay; d<=endDay; d++) await optimizeDay(city, d);

    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    showWOW(false);
    $resetBtn?.removeAttribute('disabled');

    if(forceReplan && plannerState.forceReplan) delete plannerState.forceReplan[city];

  }else{
    showWOW(false);
    $resetBtn?.removeAttribute('disabled');
    chatMsg(getLang()==='es' ? 'I did not receive valid changes for rebalancing. Want to try another way?' : 'I did not receive valid changes for rebalancing. Want to try another way?','ai');
  }
}


function getPlanningInfoChatPreparationMessage(){
  const cities = savedDestinations.map(d=>d.city).filter(Boolean);
  const list = cities.join(', ');
  const es = getLang()==='es';
  return es
    ? `💡 <strong>Antes de continuar:</strong> si todavía no tienes clara la mejor <strong>zona para hospedarte</strong> o qué <strong>medio de transporte</strong> te conviene en ${list || 'alguna de tus ciudades'}, abre <strong>Info Chat 🌐</strong> ahora. Puede ayudarte a comparar zonas, barrios y formas habituales de moverte según el contexto de tu viaje. Luego vuelve aquí y dime tu decisión para cada ciudad.`
    : `💡 <strong>Before we continue:</strong> if you are not sure about the best <strong>area to stay</strong> or which <strong>transport option</strong> makes most sense in ${list || 'one of your cities'}, open <strong>Info Chat 🌐</strong> now. It can help you compare neighborhoods, areas and common ways to get around based on your trip context. Then come back here and tell me your choice for each city.`;
}

function setPlanningChatLocked(locked){
  if(!$chatBox || !$chatI || !$send) return;
  const es = getLang()==='es';

  $chatBox.classList.toggle('is-planning-complete', !!locked);
  $chatI.disabled = !!locked;
  $send.disabled = !!locked;
  $chatI.setAttribute('aria-disabled', locked ? 'true' : 'false');
  $send.setAttribute('aria-disabled', locked ? 'true' : 'false');

  if(locked){
    $chatI.value = '';
    $chatI.placeholder = es
      ? 'Planificación completada · usa Info Chat para consultas sobre tus ciudades.'
      : 'Planning completed · use Info Chat for questions about your cities.';
    $send.title = es ? 'Planificación completada' : 'Planning completed';
  }else{
    $chatI.placeholder = es ? 'Escribe tu mensaje...' : 'Type your message...';
    $send.removeAttribute('title');
  }
}

function detectAgentConversationLanguage(text){
  const raw=String(text||'').trim();
  if(!raw) return null;

  /* Script-first detection for non-Latin languages. */
  if(/[\u3040-\u30ff]/.test(raw)) return 'ja';
  if(/[\uac00-\ud7af]/.test(raw)) return 'ko';
  if(/[\u4e00-\u9fff]/.test(raw)) return 'zh';
  if(/[\u0400-\u04ff]/.test(raw)) return 'ru';
  if(/[\u0600-\u06ff]/.test(raw)) return 'ar';

  const s=` ${raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')} `;
  const patterns={
    es:[/\b(quiero|voy|usar|usare|transporte|publico|hotel|zona|barrio|recomiendame|para|con|una|un|el|la|los|las|y)\b/g],
    pt:[/\b(quero|vou|usar|transporte|publico|hotel|zona|bairro|recomende|para|com|uma|um|o|a|os|as|e)\b/g],
    fr:[/\b(je|veux|vais|utiliser|transport|public|hotel|quartier|zone|recommande|pour|avec|un|une|le|la|les|et)\b/g],
    de:[/\b(ich|mochte|will|nutzen|verkehr|offentlich|hotel|viertel|gebiet|empfehle|fur|mit|ein|eine|der|die|das|und)\b/g],
    it:[/\b(voglio|usero|usare|trasporto|pubblico|hotel|zona|quartiere|consiglia|per|con|un|una|il|la|gli|le|e)\b/g],
    en:[/\b(i|want|will|use|transport|public|hotel|area|neighborhood|recommend|for|with|a|an|the|and)\b/g]
  };

  let best=null, bestScore=0;
  Object.entries(patterns).forEach(([lang,res])=>{
    let score=0;
    res.forEach(re=>{ score += (s.match(re)||[]).length; });
    if(score>bestScore){ bestScore=score; best=lang; }
  });

  if(bestScore>=2) return best;

  /* Browser language is safer than site-language when a short first reply
     contains mostly proper nouns (e.g. "Eixample, metro"). */
  const browser=String(navigator.language||'').slice(0,2).toLowerCase();
  if(['es','en','pt','fr','de','it','ja','ko','zh','ru','ar'].includes(browser)) return browser;

  return getLang()==='es' ? 'es' : 'en';
}

function agentConversationCopy(){
  const lang=agentConversationLang || (getLang()==='es' ? 'es' : 'en');
  const map={
    es:{
      hotel:(city)=>`Para <strong>${city}</strong>, dime tu <strong>hotel/zona</strong> y tu <strong>transporte</strong> (vehículo alquilado, transporte público, taxi/Uber, mixto o “recomiéndame”).`,
      itinerary:'Antes de generar: ¿en qué <strong>idioma</strong> quieres tu itinerario? (Ej: Español, English, Português, Français, Deutsch…)'
    },
    en:{
      hotel:(city)=>`For <strong>${city}</strong>, tell me your <strong>hotel/area</strong> and your <strong>transport</strong> (rental car, public transit, taxi/Uber, mixed, or “recommend”).`,
      itinerary:'Before I generate: what <strong>language</strong> do you want your itinerary in? (e.g., English, Español, Português, Français, Deutsch…)'
    },
    pt:{
      hotel:(city)=>`Para <strong>${city}</strong>, diga-me o seu <strong>hotel/área</strong> e o seu <strong>transporte</strong> (carro alugado, transporte público, táxi/Uber, misto ou “recomende”).`,
      itinerary:'Antes de gerar: em que <strong>idioma</strong> você quer o seu itinerário? (Ex.: Português, Español, English, Français, Deutsch…)'
    },
    fr:{
      hotel:(city)=>`Pour <strong>${city}</strong>, indiquez-moi votre <strong>hôtel/quartier</strong> et votre <strong>transport</strong> (voiture de location, transports publics, taxi/Uber, mixte ou « recommandez-moi »).`,
      itinerary:'Avant de générer : dans quelle <strong>langue</strong> souhaitez-vous votre itinéraire ? (Ex. : Français, English, Español, Português, Deutsch…)'
    },
    de:{
      hotel:(city)=>`Für <strong>${city}</strong>: Nenne mir bitte dein <strong>Hotel/Gebiet</strong> und dein <strong>Verkehrsmittel</strong> (Mietwagen, öffentliche Verkehrsmittel, Taxi/Uber, gemischt oder „empfehlen“).`,
      itinerary:'Bevor ich den Reiseplan erstelle: In welcher <strong>Sprache</strong> möchtest du deinen Reiseplan? (z. B. Deutsch, English, Español, Português, Français…)'
    },
    it:{
      hotel:(city)=>`Per <strong>${city}</strong>, indicami il tuo <strong>hotel/zona</strong> e il tuo <strong>trasporto</strong> (auto a noleggio, trasporto pubblico, taxi/Uber, misto o “consigliami”).`,
      itinerary:'Prima di generare: in quale <strong>lingua</strong> vuoi il tuo itinerario? (Es.: Italiano, English, Español, Português, Français…)'
    },
    ja:{
      hotel:(city)=>`<strong>${city}</strong>での<strong>ホテル／滞在エリア</strong>と<strong>移動手段</strong>（レンタカー、公共交通機関、タクシー/Uber、組み合わせ、または「おすすめ」）を教えてください。`,
      itinerary:'生成する前に、旅程をどの<strong>言語</strong>で作成しますか？（例：日本語、English、Español、Português、Français…）'
    },
    ko:{
      hotel:(city)=>`<strong>${city}</strong>에서의 <strong>호텔/숙박 지역</strong>과 <strong>교통수단</strong>(렌터카, 대중교통, 택시/Uber, 혼합 또는 “추천”)을 알려주세요.`,
      itinerary:'생성하기 전에 여행 일정을 어떤 <strong>언어</strong>로 만들까요? (예: 한국어, English, Español, Português, Français…)'
    },
    zh:{
      hotel:(city)=>`请告诉我您在<strong>${city}</strong>的<strong>酒店/住宿区域</strong>以及<strong>交通方式</strong>（租车、公共交通、出租车/Uber、混合或“推荐”）。`,
      itinerary:'生成之前：您希望行程使用哪种<strong>语言</strong>？（例如：中文、English、Español、Português、Français…）'
    },
    ru:{
      hotel:(city)=>`Для <strong>${city}</strong> укажите ваш <strong>отель/район</strong> и <strong>транспорт</strong> (арендованный автомобиль, общественный транспорт, такси/Uber, смешанный вариант или «порекомендуй»).`,
      itinerary:'Перед созданием: на каком <strong>языке</strong> вы хотите получить маршрут? (например: Русский, English, Español, Português, Français…)'
    },
    ar:{
      hotel:(city)=>`بالنسبة إلى <strong>${city}</strong>، أخبرني عن <strong>الفندق/المنطقة</strong> و<strong>وسيلة التنقل</strong> (سيارة مستأجرة، نقل عام، تاكسي/Uber، مزيج، أو «اقترح»).`,
      itinerary:'قبل الإنشاء: بأي <strong>لغة</strong> تريد برنامج الرحلة؟ (مثال: العربية، English، Español، Português، Français…)'
    }
  };
  return map[lang] || map.en;
}

async function startPlanning(){
  if(savedDestinations.length===0) return;
  setExportToolbarVisibility(false);
  $chatBox.style.display='flex';
  setPlanningChatLocked(false);
  planningStarted = true;
  collectingHotels = true;
  session = [];
  metaProgressIndex = 0;
  agentConversationLang = null;

  chatMsg(`${tone.hi}`);
  chatMsg(getPlanningInfoChatPreparationMessage(),'ai');
  askNextHotelTransport();
}
function askNextHotelTransport(){
  if(metaProgressIndex >= savedDestinations.length){
    collectingHotels = false;

    if (typeof plannerState !== 'undefined' && plannerState) {
      plannerState.collectingItineraryLang = true;
    }

    chatMsg(agentConversationCopy().itinerary, 'ai');

    return;
  }

  const city = savedDestinations[metaProgressIndex].city;
  setActiveCity(city); renderCityItinerary(city);
  chatMsg(agentConversationCopy().hotel(city),'ai');
}

const WORD_NUM = {
  'una':1,'uno':1,'un':1,'dos':2,'tres':3,'cuatro':4,'cinco':5,
  'seis':6,'siete':7,'ocho':8,'nueve':9,'diez':10,
  'once':11,'doce':12,'trece':13,'catorce':14,'quince':15
};

function normalizeHourToken(tok){
  tok = tok.toLowerCase().trim();
  const yM = tok.match(/^(\d{1,2}|\w+)\s+y\s+(media|cuarto|tres\s+cuartos)$/i);
  if(yM){
    let h = yM[1];
    let hh = WORD_NUM[h] || parseInt(h,10);
    if(!isFinite(hh)) return null;
    let mm = 0; const frag = yM[2].replace(/\s+/g,' ');
    if(frag==='media') mm=30; else if(frag==='cuarto') mm=15; else if(frag==='tres cuartos') mm=45;
    if(hh>=0 && hh<=24) return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
    return null;
  }
  const mapWords = { 'mediodía':'12:00', 'medianoche':'00:00' };
  if(mapWords[tok]) return mapWords[tok];

  const w = WORD_NUM[tok]; if(w) return String(w).padStart(2,'0')+':00';
  const m = tok.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if(!m) return null;
  let hh = parseInt(m[1],10), mm = m[2]?parseInt(m[2],10):0; const ap = m[3]?.toLowerCase();
  if(ap){ if((ap==='pm' || ap==='p.m.') && hh<12) hh += 12; if((ap==='am' || ap==='a.m.') && hh===12) hh = 0; }
  if(hh>=0 && hh<=24 && mm>=0 && mm<60) return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  return null;
}

function parseTimeRangeFromText(text){
  const t = text.toLowerCase();
  let m = t.match(/(?:de|entre)\s+([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)\s*(?:a|hasta|y)\s*([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)/i);
  if(m){ const s=normalizeHourToken(m[1]); const e=normalizeHourToken(m[2]); if(s||e) return {start:s||null, end:e||null}; }
  m = t.match(/(?:iniciar|empezar|arrancar|inicio)\s*(?:el día|la jornada)?\s*(?:a|a las)?\s*([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)/i);
  const startOnly = m ? normalizeHourToken(m[1]) : null;
  m = t.match(/(?:terminar|finalizar|hasta|acabar)\s*(?:a las|a)?\s*([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)/i);
  const endOnly = m ? normalizeHourToken(m[1]) : null;
  return {start:startOnly, end:endOnly};
}

function detectCityInText(text){
  const lowered = text.toLowerCase();
  const list = savedDestinations.map(d=>d.city).sort((a,b)=>b.length-a.length);
  for(const c of list){
    if(lowered.includes(c.toLowerCase())) return c;
  }
  // Fuzzy extra
  for(const c of list){
    const clean = c.toLowerCase();
    if(clean.startsWith(lowered) || lowered.startsWith(clean)) return c;
    if(levenshteinDistance(lowered, clean) <= 2) return c;
  }
  return null;
}

function detectCityFromCountryInText(text){
  const lowered = text.toLowerCase();
  const countryMap = {
    'islandia':'reykjavik','españa':'madrid','francia':'parís','italia':'roma',
    'inglaterra':'londres','reino unido':'londres','japón':'tokio',
    'eeuu':'nueva york','estados unidos':'nueva york','alemania':'berlín',
    'portugal':'lisboa','brasil':'rio de janeiro','argentina':'buenos aires',
    'chile':'santiago','méxico':'ciudad de méxico'
  };
  for(const k in countryMap){
    if(lowered.includes(k)) return countryMap[k];
  }
  return null;
}

function levenshteinDistance(a,b){
  const m = [];
  for(let i=0;i<=b.length;i++){ m[i]=[i]; }
  for(let j=0;j<=a.length;j++){ m[0][j]=j; }
  for(let i=1;i<=b.length;i++){
    for(let j=1;j<=a.length;j++){
      m[i][j] = b.charAt(i-1)==a.charAt(j-1)
        ? m[i-1][j-1]
        : Math.min(m[i-1][j-1]+1, Math.min(m[i][j-1]+1, m[i-1][j]+1));
    }
  }
  return m[b.length][a.length];
}

function intentFromText(text){
  const t = text.toLowerCase().trim();

  if(/^(sí|si|ok|dale|hazlo|confirmo|de una|aplica)\b/.test(t)) return {type:'confirm'};
  if(/^(no|mejor no|cancela|cancelar|cancelá)\b/.test(t)) return {type:'cancel'};

  // Agregar un día al FINAL (prioridad sobre varios días)
  if(/\b(me\s+quedo|quedarme)\s+un\s+d[ií]a\s+m[aá]s\b/.test(t) || /\b(un\s+d[ií]a\s+m[aá]s)\b/.test(t) || /(agrega|añade|suma)\s+un\s+d[ií]a/.test(t)){
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    const placeM = t.match(/para\s+ir\s+a\s+([a-záéíóúüñ\s]+)$/i);
    return {type:'add_day_end', city, dayTripTo: placeM ? placeM[1].trim() : null};
  }

  // Agregar varios días / noches — robusto
  const addMulti = t.match(/(agrega|añade|suma|extiende|prolonga|quedarme|me\s+quedo|me\s+voy\s+a\s+quedar)\s+(\d+|\w+)\s+(d[ií]as?|noches?)/i);
  if(addMulti){
    const n = WORD_NUM[addMulti[2]] || parseInt(addMulti[2],10) || 1;
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    return {type:'add_days', city, extraDays:n};
  }

  const rem = t.match(/(quita|elimina|borra)\s+el\s+d[ií]a\s+(\d+)/i);
  if(rem){ return {type:'remove_day', city: detectCityInText(t) || detectCityFromCountryInText(t) || activeCity, day: parseInt(rem[2],10)}; }

  const swap = t.match(/(?:pasa|mueve|cambia)\s+el\s+d[ií]a\s+(\d+)\s+(?:al|a)\s+(?:d[ií]a\s+)?(\d+)/i);
  if(swap && !/actividad|museo|visita|tour|cena|almuerzo|desayuno/i.test(t)){
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    return {type:'swap_day', city, from: parseInt(swap[1],10), to: parseInt(swap[2],10)};
  }

  const mv = t.match(/(?:mueve|pasa|cambia)\s+(.*?)(?:\s+del\s+d[ií]a\s+(\d+)|\s+del\s+(\d+))\s+(?:al|a)\s+(?:d[ií]a\s+)?(\d+)/i);
  if(mv){ return {type:'move_activity', city: detectCityInText(t) || detectCityFromCountryInText(t) || activeCity, query:(mv[1]||'').trim(), fromDay:parseInt(mv[2]||mv[3],10), toDay:parseInt(mv[4],10)}; }

  if(/\b(no\s+quiero|sustituye|reemplaza|quita|elimina|borra)\b/.test(t)){
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    const m = t.match(/no\s+quiero\s+ir\s+a\s+(.+?)(?:,|\.)?$/i);
    return {type:'swap_activity', city, target: m ? m[1].trim() : null, details:text};
  }

  const range = parseTimeRangeFromText(text);
  if(range.start || range.end) return {type:'change_hours', city: detectCityInText(t) || detectCityFromCountryInText(t) || activeCity, range};

  const addCity = t.match(/(?:agrega|añade|suma)\s+([a-záéíóúüñ\s]+?)\s+(?:con\s+)?(\d+)\s*d[ií]as?(?:\s+(?:desde|iniciando)\s+(\d{1,2}\/\d{1,2}\/\d{4}))?/i);
  if(addCity){
    return {type:'add_city', city: addCity[1].trim(), days:parseInt(addCity[2],10), baseDate:addCity[3]||''};
  }

  const delCity = t.match(/(?:elimina|borra|quita)\s+(?:la\s+ciudad\s+)?([a-záéíóúüñ\s]+)/i);
  if(delCity){ return {type:'remove_city', city: delCity[1].trim()}; }

  // Preguntas informativas (clima, seguridad, etc.)
  if(/\b(clima|tiempo|temperatura|lluvia|horas de luz|moneda|cambio|propina|seguridad|visado|visa|fronteras|aduana|vuelos|aerol[ií]neas|equipaje|salud|vacunas|enchufes|taxis|alquiler|conducci[oó]n|peatonal|festivos|temporada|mejor época|gastronom[ií]a|restaurantes|precios|presupuesto|wifi|sim|roaming)\b/.test(t)){
    return {type:'info_query', details:text};
  }

  return {type:'free_edit', details:text};
}

function insertDayAt(city, position){
  ensureDays(city);
  const byDay = itineraries[city].byDay || {};
  const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  const maxD = days.length ? Math.max(...days) : 0;
  const pos = Math.min(Math.max(1, position), maxD+1);
  for(let d = maxD; d >= pos; d--){
    byDay[d+1] = (byDay[d]||[]).map(r=>({...r, day:d+1}));
  }
  byDay[pos] = [];
  itineraries[city].byDay = byDay;
  const dest = savedDestinations.find(x=>x.city===city);
  if(dest) dest.days = (dest.days||maxD) + 1;
}

function removeDayAt(city, day){
  ensureDays(city);
  const byDay = itineraries[city].byDay || {};
  const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  if(!days.includes(day)) return;
  delete byDay[day];
  const maxD = days.length ? Math.max(...days) : 0;
  for(let d=day+1; d<=maxD; d++){
    byDay[d-1] = (byDay[d]||[]).map(r=>({...r, day:d-1}));
    delete byDay[d];
  }
  itineraries[city].byDay = byDay;
  const dest = savedDestinations.find(x=>x.city===city);
  if(dest) dest.days = Math.max(0, (dest.days||days.length)-1);
}

function swapDays(city, a, b){
  ensureDays(city);
  if(a===b) return;
  const byDay = itineraries[city].byDay || {};
  const A = (byDay[a]||[]).map(r=>({...r, day:b}));
  const B = (byDay[b]||[]).map(r=>({...r, day:a}));
  byDay[a] = B;
  byDay[b] = A;
  itineraries[city].byDay = byDay;
}

function moveActivities(city, fromDay, toDay, query=''){
  ensureDays(city);
  const byDay = itineraries[city].byDay || {};
  const src = byDay[fromDay] || [];
  const dst = byDay[toDay] || [];
  const q = String(query||'').toLowerCase().trim();
  const moved = [];
  const remain = [];
  src.forEach(r=>{
    const hay = !q || String(r.activity||'').toLowerCase().includes(q);
    if(hay){ moved.push(r); } else { remain.push(r); }
  });
  byDay[fromDay] = remain.map(normalizeRow);
  moved.forEach(r=>{ dedupeInto(dst, {...r, day: toDay}); });
  byDay[toDay] = dst.map(normalizeRow).sort((a,b)=> (a.start||'') < (b.start||'') ? -1 : 1);
  itineraries[city].byDay = byDay;
}

async function optimizeDay(city, day){
  const data = itineraries[city];
  const rows = (data?.byDay?.[day]||[]).map(r=>({
    day, start:r.start||'', end:r.end||'', activity:r.activity||'',
    from:r.from||'', to:r.to||'', transport:r.transport||'',
    duration:r.duration||'', notes:r.notes||''
  }));
  const perDay = (cityMeta[city]?.perDay||[]).find(x=>x.day===day) || {start:DEFAULT_START,end:DEFAULT_END};
  const baseDate = data.baseDate || cityMeta[city]?.baseDate || '';

  let forceReplanBlock = '';
  if (typeof plannerState !== 'undefined' && plannerState.forceReplan && plannerState.forceReplan[city]) {
    forceReplanBlock = `
👉 IMPORTANTE:
- El usuario ha extendido su estadía en ${city}.
- Reequilibra TODO el itinerario considerando el nuevo total de días.
- Evalúa day trips completos y experiencias icónicas si aportan más valor.
- Evita duplicados y prioriza calidad sobre cantidad.
`;
  }

  const langDirective = `
LANGUAGE (CRITICAL):
Primary rule (highest priority):
- ALWAYS respond in the language explicitly selected by the user when the planner asks for the itinerary language.
- This selected language is the ONLY source of truth for the output language.
Secondary rule (fallback only):
- If no explicit language selection is provided, then:
  - Determine the language from the user's written content.
  - Ignore template/system labels (e.g., "Preferences", "Restrictions", "Start time", etc.).
  - Use only the natural language written by the user.
Mixed language handling:
- If the user mixes languages:
  • Prioritize the explicitly selected language.
  • If no selection exists, use the dominant language of the user's content.
  • If no dominant language exists, use the language of the last user entry.
Consistency (critical):
- The entire JSON output MUST be in ONE single language only.
- Do NOT mix languages inside the response.
Translation rule:
- Do NOT translate into the site/system language unless explicitly requested by the user.
- The output must strictly follow the selected or inferred language rules above.

`.trim();

  const prompt = `
${FORMAT}
${langDirective}
Ciudad: ${city}
Día: ${day}
Fecha base (d1): ${baseDate||'N/A'}
Ventanas (orientativas, no rígidas): ${JSON.stringify(perDay)}
Filas actuales:
${JSON.stringify(rows)}
${forceReplanBlock}

Instrucción:
- Optimiza el día con criterio experto (flujo lógico, zonas, ritmo).
- Si el usuario no indicó hora final, usa aproximadamente las 19:00 como objetivo mínimo, no como límite. No cierres rutinariamente el día antes de esa hora y extiéndelo más tarde cuando haya shows, espectáculos, miradores nocturnos, barrios con ambiente, cenas especiales u otras experiencias de alto valor que realmente mejoren el itinerario.
- En el Día 1, el ingreso/check-in o depósito de equipaje en el alojamiento ocurre antes de cualquier visita.
- Si el día atraviesa el horario de almuerzo, integra una comida realista según costumbre local (como referencia, 12:00–15:00).
- Cuando las auroras sean plausibles por ubicación, época y oscuridad, agrega una nota adicional sobre auroras en las notas de la ÚLTIMA fila de TODOS los días de esa ciudad. Esto aplica incluso si el usuario pidió auroras explícitamente en Preferencias. No crees una fila independiente salvo una reserva real confirmada con hora fija y explícitamente solicitada.
- Day trips: decide libremente si aportan valor; si los propones, hazlos completos, realistas, con comida en ruta cuando corresponda y regreso coherente con la hora final.
- No limites trayectos por regla fija; usa sentido común y experiencia turística real.
- Valida plausibilidad global y seguridad.
- Notes siempre útiles (nunca vacías ni "seed").
- Devuelve C {"rows":[...],"replace":false}.

Contexto:
${buildIntake()}
`.trim();

  const ans = await callAgent(prompt, true);
  const parsed = parseJSON(ans);
  if(parsed?.rows){
    const normalized = parsed.rows.map(x=>normalizeRow({...x, day}));
    const val = await validateRowsWithAgent(city, normalized, baseDate);
    pushRows(city, val.allowed, false);
  }
}

function detectTransportFromUserText(text){
  const s=String(text||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');

  if(/\b(recomiendame|recomienda|recommend|recommande|recommandez|empfehle|empfehlung|consiglia|consigliami|recomende|おすすめ|추천|推荐|порекомендуй|рекомендуй|اقترح)\b/i.test(s)){
    return 'recomiéndame';
  }

  if(/\b(alquilad|rent(?:al|ed)?|vehiculo|coche|auto|carro|voiture\s+de\s+location|location\s+de\s+voiture|mietwagen|noleggio|auto\s+a\s+noleggio|carro\s+alugado|aluguel\s+de\s+carro|レンタカー|렌터카|租车|арендованн|аренда\s+авто|سيارة\s+مستأجرة)\b/i.test(s)){
    return 'vehículo alquilado';
  }

  if(/\b(metro|tren|train|bus|autobus|publico|public\s+transit|public\s+transport|transports?\s+publics?|transport\s+public|offentliche|verkehrsmittel|trasporto\s+pubblico|transporte\s+publico|公共交通|대중교통|公共交通機関|общественн|نقل\s+عام)\b/i.test(s)){
    return 'transporte público';
  }

  if(/\b(uber|taxi|cabify|lyft|такси|出租车|택시|タクシー|تاكسي)\b/i.test(s)){
    return 'otros (Uber/Taxi)';
  }

  return '';
}

function stripRecognizedTransportTail(text){
  const raw=String(text||'').trim();
  if(!raw) return '';

  /*
    Keep this conservative: it only strips an obvious transport phrase at the
    end. If unsure, the full user text is retained as lodging context so no
    information is discarded.
  */
  return raw
    .replace(
      /(?:,|;|\||\band\b|\by\b|\bet\b|\bund\b|\be\b|\be\b|\bou\b|\boder\b|\bo\b|\bor\b)?\s*(?:i(?:'|’)ll\s+use|i\s+will\s+use|usar[eé]|voy\s+a\s+usar|je\s+vais\s+utiliser|j['’]utiliserai|ich\s+nutze|ich\s+werde|user[oò]|vou\s+usar|transport(?:e)?\s*[:=-]?)?\s*(?:rental\s*car|public\s*transit|public\s*transport|metro|train|tren|bus|taxi|uber|cabify|lyft|veh[ií]culo\s*alquilado|auto\s*alquilado|coche\s*alquilado|transporte\s*p[uú]blico|voiture\s+de\s+location|transports?\s+publics?|mietwagen|[oö]ffentliche\s+verkehrsmittel|auto\s+a\s+noleggio|trasporto\s+pubblico|carro\s+alugado|transporte\s+p[uú]blico|レンタカー|公共交通機関|タクシー|렌터카|대중교통|택시|租车|公共交通|出租车|арендованн\w*\s+автомобил\w*|общественн\w*\s+транспорт\w*|такси|سيارة\s+مستأجرة|نقل\s+عام|تاكسي|recomi[eé]ndame|recommend|recommande|empfehle|consigliami|recomende|おすすめ|추천|推荐|порекомендуй|اقترح)\s*$/i,
      ''
    )
    .trim() || raw;
}

async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  if(!agentConversationLang){
    agentConversationLang=detectAgentConversationLanguage(text);
  }

  // Colecta hotel/transporte
  if(collectingHotels){
    const city = savedDestinations[metaProgressIndex].city;
    const transport = detectTransportFromUserText(text);
    const lodgingText = stripRecognizedTransportTail(text);
    upsertCityMeta({ city, hotel: lodgingText, transport });
    metaProgressIndex++;
    askNextHotelTransport();
    return;
  }

  if (typeof plannerState !== 'undefined' && plannerState && plannerState.collectingItineraryLang) {
    plannerState.collectingItineraryLang = false;
    plannerState.itineraryLang = String(text || '').trim();

    (async ()=>{
      _resetAstraGenerationMetrics_();
      showWOW(true, t('overlayGenerating'));
      for(const {city} of savedDestinations){
        await generateCityItinerary(city);
      }
      _finishAstraGenerationMetrics_();
      showWOW(false);
      setExportToolbarVisibility();
      chatMsg(getPlannerCompletionMessage(), 'ai');
      setPlanningChatLocked(true);
      setTimeout(()=>showFinalDownloadModal(),260);
    })();

    return;
  }

  const intent = intentFromText(text);

  // Normaliza "un día más" → add_day_end
  if(intent && intent.type==='add_days'){
    const t = text.toLowerCase();
    const isOneMoreDay = /\b(me\s+quedo|quedarme)\s+un\s+d[ií]a\s+m[aá]s\b|\bun\s+d[ií]a\s+m[aá]s\b/.test(t);
    const tripMatch = t.match(/para\s+ir\s+a\s+([a-záéíóúüñ\s]+)$/i);
    if(isOneMoreDay || tripMatch){
      intent.type = 'add_day_end';
      intent.city = intent.city || activeCity;
      if(tripMatch) intent.dayTripTo = (tripMatch[1]||'').trim();
    }
  }

  // Agregar varios días (con rebalanceo global)
  if(intent.type==='add_days' && intent.city && intent.extraDays>0){
    const city = intent.city;
    showWOW(true, getLang()==='es' ? 'Agregando días y reoptimizando…' : 'Adding days and re-optimizing…');
    addMultipleDaysToCity(city, intent.extraDays);
    await rebalanceWholeCity(city, { dayTripTo: intent.dayTripTo||'' });
    showWOW(false);
    const _rb = qs('#reset-planner'); if(_rb) _rb.disabled = false;

    chatMsg(
      (getLang()==='es')
        ? `✅ Agregué ${intent.extraDays} día(s) a ${city} y reoptimicé el itinerario.`
        : `✅ I added ${intent.extraDays} day(s) to ${city} and re-optimized the itinerary.`,
      'ai'
    );
    return;
  }

  // 1) Agregar día al FINAL — ⬅️ AJUSTE CLAVE AQUÍ
  if(intent.type==='add_day_end' && intent.city){
    const city = intent.city;
    showWOW(true, getLang()==='es' ? 'Insertando día y optimizando…' : 'Adding a day and optimizing…');

    ensureDays(city);
    const byDay = itineraries[city].byDay || {};
    const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
    const numericPos = days.length + 1;

    insertDayAt(city, numericPos);

    // ❌ ELIMINADO: seeds rígidos de day-trip
    // ✅ El planner decidirá estructura, paradas y horarios reales

    await rebalanceWholeCity(city, {
      start: itineraries[city]?.originalDays || 1,
      end: numericPos,
      dayTripTo: intent.dayTripTo || ''
    });

    renderCityTabs(); 
    setActiveCity(city); 
    renderCityItinerary(city);

    showWOW(false);
    const _rb = qs('#reset-planner'); if(_rb) _rb.disabled = false;

    chatMsg(getLang()==='es' ? '✅ Día agregado y plan reoptimizado inteligentemente.' : '✅ Day added and plan re-optimized intelligently.','ai');
    return;
  }

  // 2) Quitar día
  if(intent.type==='remove_day' && intent.city && Number.isInteger(intent.day)){
    showWOW(true, getLang()==='es' ? 'Eliminando día…' : 'Removing day…');
    removeDayAt(intent.city, intent.day);
    const totalDays = Object.keys(itineraries[intent.city].byDay||{}).length;
    for(let d=1; d<=totalDays; d++) await optimizeDay(intent.city, d);
    renderCityTabs(); setActiveCity(intent.city); renderCityItinerary(intent.city);
    showWOW(false);
    const _rb = qs('#reset-planner'); if(_rb) _rb.disabled = false;

    chatMsg(getLang()==='es' ? '✅ Día eliminado y plan reequilibrado.' : '✅ Day removed and plan re-balanced.','ai');
    return;
  }

  // 3) Swap de días
  if(intent.type==='swap_day' && intent.city){
    showWOW(true, getLang()==='es' ? 'Intercambiando días…' : 'Swapping days…');
    swapDays(intent.city, intent.from, intent.to);
    await optimizeDay(intent.city, intent.from);
    if(intent.to!==intent.from) await optimizeDay(intent.city, intent.to);
    renderCityTabs(); setActiveCity(intent.city); renderCityItinerary(intent.city);
    showWOW(false);
    const _rb = qs('#reset-planner'); if(_rb) _rb.disabled = false;

    chatMsg(getLang()==='es' ? '✅ Intercambié el orden y optimicé ambos días.' : '✅ I swapped the order and optimized both days.','ai');
    return;
  }

  // 4) Mover actividad
  if(intent.type==='move_activity' && intent.city){
    showWOW(true, getLang()==='es' ? 'Moviendo actividad…' : 'Moving activity…');
    moveActivities(intent.city, intent.fromDay, intent.toDay, intent.query||'');
    await optimizeDay(intent.city, intent.fromDay);
    await optimizeDay(intent.city, intent.toDay);
    renderCityTabs(); setActiveCity(intent.city); renderCityItinerary(intent.city);
    showWOW(false);
    const _rb = qs('#reset-planner'); if(_rb) _rb.disabled = false;

    chatMsg(getLang()==='es' ? '✅ Moví la actividad y reoptimicé los días implicados.' : '✅ I moved the activity and re-optimized the affected days.','ai');
    return;
  }

  // 5) Sustituir / eliminar actividad
  if(intent.type==='swap_activity' && intent.city){
    const city = intent.city;
    const day  = itineraries[city]?.currentDay || 1;
    showWOW(true, getLang()==='es' ? 'Ajustando actividades…' : 'Adjusting activities…');
    const q = intent.target ? intent.target.toLowerCase() : '';
    if(q){
      const before = itineraries[city].byDay[day]||[];
      itineraries[city].byDay[day] =
        before.filter(r => !String(r.activity||'').toLowerCase().includes(q));
    }
    await optimizeDay(city, day);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    showWOW(false);
    const _rb = qs('#reset-planner'); if(_rb) _rb.disabled = false;

    chatMsg(getLang()==='es' ? '✅ Sustituí la actividad y reoptimicé el día.' : '✅ I replaced the activity and re-optimized the day.','ai');
    return;
  }

  if(intent.type==='change_hours' && intent.city){
    showWOW(true, getLang()==='es' ? 'Ajustando horarios…' : 'Adjusting times…');
    const city = intent.city;
    const day = itineraries[city]?.currentDay || 1;
    if(!cityMeta[city]) cityMeta[city]={perDay:[]};
    let pd = cityMeta[city].perDay.find(x=>x.day===day);
    if(!pd){ pd = {day, start:DEFAULT_START, end:DEFAULT_END}; cityMeta[city].perDay.push(pd); }
    if(intent.range.start) pd.start = intent.range.start;
    if(intent.range.end)   pd.end   = intent.range.end;
    await optimizeDay(city, day);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    showWOW(false);
    const _rb = qs('#reset-planner'); if(_rb) _rb.disabled = false;

    chatMsg(getLang()==='es' ? '✅ Ajusté los horarios y reoptimicé tu día.' : '✅ I adjusted the times and re-optimized your day.','ai');
    return;
  }

  // 7) Agregar ciudad
  if(intent.type==='add_city' && intent.city){
    if(qsa('.city-row',$cityList).length>=MAX_ITINERARY_CITIES){
      chatMsg(
        getLang()==='es'
          ? 'Puedes incluir un máximo de <strong>3 ciudades</strong> por generación.'
          : 'You can include a maximum of <strong>3 cities</strong> per generation.',
        'ai'
      );
      updateAddCityButtonState();
      return;
    }
    const name = intent.city.trim().replace(/\s+/g,' ').replace(/^./,c=>c.toUpperCase());
    const days = intent.days || 2;
    addCityRow({city:name, days:'', baseDate:intent.baseDate||''});
    const lastRow = $cityList.lastElementChild;
    const sel = lastRow?.querySelector('.days');
    if(sel){ sel.value = String(days); sel.dispatchEvent(new Event('change')); }
    saveDestinations();
    chatMsg(
      (getLang()==='es')
        ? `✅ Añadí <strong>${name}</strong>. Dime tu hotel/zona y transporte para generar el plan.`
        : `✅ I added <strong>${name}</strong>. Tell me your hotel/area and transport to generate the plan.`,
      'ai'
    );
    return;
  }

  // 8) Eliminar ciudad
  if(intent.type==='remove_city' && intent.city){
    const name = intent.city.trim();
    savedDestinations = savedDestinations.filter(x=>x.city!==name);
    delete itineraries[name];
    delete cityMeta[name];
    renderCityTabs();
    chatMsg(
      (getLang()==='es')
        ? `🗑️ Eliminé <strong>${name}</strong> de tu itinerario.`
        : `🗑️ I removed <strong>${name}</strong> from your itinerary.`,
      'ai'
    );
    return;
  }

  // 9) Preguntas informativas
  if(intent.type==='info_query'){
    try{
      setChatBusy(true);

      const ans = await callAgent(
`Reply in the SAME language as the user's message (no JSON):\n"${text}"`,
        true
      );

      chatMsg(ans || (getLang()==='es' ? 'Is there anything else you would like to know?' : 'Anything else you want to know?'));
    } finally {
      setChatBusy(false);
    }
    return;
  }

  // 10) Edición libre
  if(intent.type==='free_edit'){
    const city = activeCity || savedDestinations[0]?.city;
    if(!city){ chatMsg(getLang()==='es' ? 'Aún no hay itinerario en pantalla.' : 'There is no itinerary on screen yet.'); return; }
    const day = itineraries[city]?.currentDay || 1;
    showWOW(true, getLang()==='es' ? 'Aplicando tu cambio…' : 'Applying your change…');

    const data = itineraries[city];
    const dayRows = (data?.byDay?.[day]||[]).map(r=>`• ${r.start||''}-${r.end||''} ${r.activity}`).join('\n') || '(vacío)';
    const allDays = Object.keys(data?.byDay||{}).map(n=>{
      const rows = data.byDay[n]||[];
      return `Día ${n}:\n${rows.map(r=>`• ${r.start||''}-${r.end||''} ${r.activity}`).join('\n') || '(vacío)'}`;
    }).join('\n\n');
    const perDay = (cityMeta[city]?.perDay||[]).map(pd=>({day:pd.day, start:pd.start||DEFAULT_START, end:pd.end||DEFAULT_END}));

    const langDirective = `
LANGUAGE (CRITICAL):
- Output MUST be in the same language as the user's instruction text below (any language).
- Ignore any system/template labels (e.g., "Día", "Contexto", "Resumen") when choosing the output language.
`.trim();

    const prompt = `
${FORMAT}
${langDirective}
Contexto:
${buildIntake()}

Ciudad: ${city}
Día visible: ${day}
Actividades del día:
${dayRows}

Resumen resto de días:
${allDays}

Ventanas orientativas: ${JSON.stringify(perDay)}
Instrucción del usuario: ${text}

- Integra lo pedido sin borrar lo existente.
- Si no se indica día concreto, reoptimiza TODA la ciudad.
- Para auroras: si aplican por ubicación, época y oscuridad, agrega una nota adicional de oportunidad de auroras en las notas de la ÚLTIMA fila de TODOS los días de esa ciudad. Esto aplica aunque el usuario las pida explícitamente en Preferencias. No crees una fila independiente por esa preferencia; solo una reserva real confirmada con hora fija, indicada separadamente por el usuario, puede representarse como fila.
- Devuelve formato B {"destination":"${city}","rows":[...],"replace": false}.
`.trim();

    const ans = await callAgent(prompt, true);
    const parsed = parseJSON(ans);

    if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
      let rows = [];
      if(parsed.rows) rows = parsed.rows.map(r=>normalizeRow(r));
      else if(parsed.destination===city && parsed.rows) rows = parsed.rows.map(r=>normalizeRow(r));
      else if(Array.isArray(parsed.destinations)){
        const dd = parsed.destinations.find(d=> (d.name||d.destination)===city);
        rows = (dd?.rows||[]).map(r=>normalizeRow(r));
      }else if(Array.isArray(parsed.itineraries)){
        const ii = parsed.itineraries.find(x=> (x.city||x.name||x.destination)===city);
        rows = (ii?.rows||[]).map(r=>normalizeRow(r));
      }
      const baseDate = data.baseDate || cityMeta[city]?.baseDate || '';
      const val = await validateRowsWithAgent(city, rows, baseDate);
      pushRows(city, val.allowed, false);

      const totalDays = Object.keys(itineraries[city].byDay||{}).length;
      for(let d=1; d<=totalDays; d++) await optimizeDay(city, d);

      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
      showWOW(false);
      const _rb = qs('#reset-planner'); if(_rb) _rb.disabled = false;

      chatMsg(getLang()==='es' ? '✅ Cambio aplicado y ciudad reoptimizada.' : '✅ Change applied and city re-optimized.','ai');
    }else{
      showWOW(false);
      const _rb = qs('#reset-planner'); if(_rb) _rb.disabled = false;

      chatMsg(parsed?.followup || (getLang()==='es' ? 'No recibí cambios válidos.' : 'I did not receive valid changes.'),'ai');
    }
    return;
  }
}

/* City order controls intentionally removed for the MVP.
   Destination order is defined by the order in which the user enters the cities.
   This keeps the Planner cleaner and avoids accidental reordering. */

// País: solo letras y espacios (protección suave en input)
document.addEventListener('input', (e)=>{
  if(e.target && e.target.classList && e.target.classList.contains('country')){
    const original = e.target.value;
    const filtered = original.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g,'');
    if(filtered !== original){
      const pos = e.target.selectionStart;
      e.target.value = filtered;
      if(typeof pos === 'number'){ e.target.setSelectionRange(Math.max(0,pos-1), Math.max(0,pos-1)); }
    }
  }
});

$addCity?.addEventListener('click', ()=>{
  if(qsa('.city-row',$cityList).length>=MAX_ITINERARY_CITIES){
    updateAddCityButtonState();
    return;
  }
  addCityRow();
});

function validateBaseDatesDMY(){
  // Valida inputs .baseDate (DD/MM/AAAA) y muestra tooltip si falta alguno
  const rows = qsa('.city-row', $cityList);
  let firstInvalid = null;
  for(const r of rows){
    const el = qs('.baseDate', r);
    const v = (el?.value||'').trim();
    if(!v || !/^(\d{2})\/(\d{2})\/(\d{4})$/.test(v) || !parseDMY(v)){
      firstInvalid = el;
      // microanimación
      el?.classList.add('shake-highlight');
      setTimeout(()=>el?.classList.remove('shake-highlight'), 800);
      break;
    }
  }
  if(firstInvalid){
    const tooltip = document.createElement('div');
    tooltip.className = 'date-tooltip';
    tooltip.textContent = t('tooltipDateMissing');
    document.body.appendChild(tooltip);
    const rect = firstInvalid.getBoundingClientRect();
    tooltip.style.left = rect.left + window.scrollX + 'px';
    tooltip.style.top  = rect.bottom + window.scrollY + 6 + 'px';
    setTimeout(() => tooltip.classList.add('visible'), 20);
    setTimeout(() => {
      tooltip.classList.remove('visible');
      setTimeout(() => tooltip.remove(), 300);
    }, 3500);
    firstInvalid.focus();
    return false;
  }
  return true;
}

$save?.addEventListener('click', saveDestinations);

/* =========================================================
   🧍‍♂️🧍‍♀️ MVP — Viajeros (UI compacto)
   - Máximo: 10 perfiles de acompañantes
   - "Just me": usa la edad del perfil ITBMO, sin pedir datos otra vez
   - "With others": género inclusivo + rango de edad por acompañante
   - Mantiene los buckets técnicos existentes y añade perfiles ricos al agente
========================================================= */
const MAX_TRAVELERS = 10;

function travelerCount(){
  if(!$travelerProfiles) return 0;
  return qsa('.traveler-profile', $travelerProfiles).length;
}

function renumberTravelerProfiles(){
  if(!$travelerProfiles) return;
  const items = qsa('.traveler-profile', $travelerProfiles);
  items.forEach((card, idx)=>{
    const n = idx + 1;
    const title = qs('.traveler-title', card);
    if(title) title.textContent = t('travelerLabel', n);
  });
}

function setTravelerButtonsState(){
  if(!$travelerAdd || !$travelerRemove) return;

  const mode = String($travelerMode?.value || '').toLowerCase();
  if(mode !== 'group'){
    // fuera de "acompañado": botones no aplican
    $travelerAdd.disabled = true;
    $travelerRemove.disabled = true;
    return;
  }

  const n = travelerCount();
  $travelerAdd.disabled = (n >= MAX_TRAVELERS);
  $travelerRemove.disabled = (n <= 0); // permitir 0 → si no hay perfiles, no hay nada que quitar
}

function createTravelerProfileCard(index1){
  // index1 = 1..N (solo para etiqueta visible)
  const wrap = document.createElement('div');
  wrap.className = 'traveler-profile';
  wrap.style.border = '1px solid #ccc';
  wrap.style.borderRadius = '.8rem';
  wrap.style.padding = '.75rem';

  wrap.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:.5rem;">
      <strong class="traveler-title" style="font-size:.9rem;">${t('travelerLabel', index1)}</strong>
      <span style="font-size:.85rem; color:rgba(11,31,59,.65);">${t('travelerCompanion')}</span>
    </div>
    <div style="display:flex; gap:.6rem; flex-wrap:wrap;">
      <label style="flex:1; min-width:160px; display:flex; flex-direction:column; gap:.25rem; font-size:.9rem; font-weight:600;">
        ${t('travelerGender')}
        <select class="traveler-gender" style="padding:.55rem .7rem; border:1px solid #ccc; border-radius:.55rem; background:#fff;">
          <option value="" selected disabled></option>
          <option value="female">${t('genderFemale')}</option>
          <option value="male">${t('genderMale')}</option>
          <option value="non_binary">${t('genderNonBinary')}</option>
          <option value="another_identity">${t('genderAnotherIdentity')}</option>
          <option value="na">${t('genderNA')}</option>
        </select>
      </label>

      <label style="flex:1; min-width:160px; display:flex; flex-direction:column; gap:.25rem; font-size:.9rem; font-weight:600;">
        ${t('travelerAgeRange')}
        <select class="traveler-age-range" style="padding:.55rem .7rem; border:1px solid #ccc; border-radius:.55rem; background:#fff;">
          <option value="" selected disabled></option>
          <option value="0-2">${t('ageBaby')}</option>
          <option value="3-5">${t('agePreschool')}</option>
          <option value="6-12">${t('ageChild')}</option>
          <option value="13-17">${t('ageTeen')}</option>
          <option value="18-24">${t('ageYoungAdult')}</option>
          <option value="25-34">${t('ageAdult2534')}</option>
          <option value="35-44">${t('ageAdult3544')}</option>
          <option value="45-54">${t('ageAdult4554')}</option>
          <option value="55-64">${t('ageAdult5564')}</option>
          <option value="65+">${t('ageSenior')}</option>
        </select>
      </label>
    </div>
  `;
  return wrap;
}

function addTravelerProfile(){
  if(!$travelerProfiles) return;
  const mode = String($travelerMode?.value || '').toLowerCase();
  if(mode !== 'group') return;

  const n = travelerCount();
  if(n >= MAX_TRAVELERS) return;

  const card = createTravelerProfileCard(n + 1);
  $travelerProfiles.appendChild(card);
  renumberTravelerProfiles();
  setTravelerButtonsState();
}

function removeTravelerProfile(){
  if(!$travelerProfiles) return;
  const mode = String($travelerMode?.value || '').toLowerCase();
  if(mode !== 'group') return;

  const items = qsa('.traveler-profile', $travelerProfiles);
  if(items.length <= 0) return;

  items[items.length - 1].remove();
  renumberTravelerProfiles();
  setTravelerButtonsState();
}

function resetTravelersUI(){
  // Dropdown + panels
  if($travelerMode){
    $travelerMode.value = '';
  }
  if($travelerSoloPanel) $travelerSoloPanel.style.display = 'none';
  if($travelerGroupPanel) $travelerGroupPanel.style.display = 'none';

  // Solo selects
  if($soloGender) $soloGender.value = '';
  if($soloAgeRange) $soloAgeRange.value = '';

  const $meGender = qs('#me-gender');
  if($meGender) $meGender.value = '';
  const $meAge = qs('#me-age-range');
  if($meAge) $meAge.value = '';

  // Group profiles: permitir 0 → dejamos vacío
  if($travelerProfiles){
    $travelerProfiles.innerHTML = '';
  }

  // botones
  setTravelerButtonsState();
}

function bindTravelersListeners(){
  if($travelerMode){
    $travelerMode.addEventListener('change', ()=>{
      const v = String($travelerMode.value || '').toLowerCase();
      if(v === 'solo'){
        if($travelerSoloPanel) $travelerSoloPanel.style.display = 'none';
        if($travelerGroupPanel) $travelerGroupPanel.style.display = 'none';
      }else if(v === 'group'){
        if($travelerSoloPanel) $travelerSoloPanel.style.display = 'none';
        if($travelerGroupPanel) $travelerGroupPanel.style.display = 'block';
        if(travelerCount() === 0) addTravelerProfile();
      }else{
        if($travelerSoloPanel) $travelerSoloPanel.style.display = 'none';
        if($travelerGroupPanel) $travelerGroupPanel.style.display = 'none';
      }
      setTravelerButtonsState();
    });
  }

  $travelerAdd?.addEventListener('click', (e)=>{
    e.preventDefault();
    addTravelerProfile();
  });

  $travelerRemove?.addEventListener('click', (e)=>{
    e.preventDefault();
    removeTravelerProfile();
  });

  setTravelerButtonsState();
}


function safeFilePart(s){
  return String(s || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function isMobileFileExperience(){
  return window.matchMedia?.('(max-width: 820px)').matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

async function deliverGeneratedFile(blob, filename){
  if(isMobileFileExperience()){
    let webShareAllowed=true;
    try{
      const policy=document.permissionsPolicy || document.featurePolicy;
      if(policy?.allowsFeature) webShareAllowed=policy.allowsFeature('web-share');
    }catch(_){ }

    try{
      const file=new File([blob],filename,{type:blob.type || 'application/octet-stream'});
      if(webShareAllowed && navigator.share && (!navigator.canShare || navigator.canShare({files:[file]}))){
        await navigator.share({files:[file],title:filename});
        return;
      }
    }catch(err){
      /* A user-cancelled share sheet must not trigger a second action. */
      if(err?.name==='AbortError') return;
      console.warn('[ITBMO MOBILE SHARE FALLBACK]',err);
    }

    const mobileUrl=URL.createObjectURL(blob);
    const mobileLink=document.createElement('a');
    mobileLink.href=mobileUrl;
    mobileLink.target='_blank';
    mobileLink.rel='noopener noreferrer';
    document.body.appendChild(mobileLink);
    mobileLink.click();
    mobileLink.remove();
    setTimeout(()=>URL.revokeObjectURL(mobileUrl),120000);
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

function detectCsvDelimiter(){
  try{
    const dec = (new Intl.NumberFormat().format(1.1) || '');
    return dec.includes(',') ? ';' : ',';
  }catch(_){
    return ',';
  }
}

function csvEscape(v, delim){
  const s = String(v ?? '');
  const d = String(delim || ',');
  // escapamos si hay comillas, saltos, o el delimitador
  const re = new RegExp(`[\"\\n\\r${d.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')}]`);
  if(re.test(s)){
    return `"${s.replace(/"/g,'""')}"`;
  }
  return s;
}

function getCityBaseDateDMY(city){
  // Prioridad: itineraries[city].baseDate -> cityMeta[city].baseDate -> null
  const d0 = itineraries?.[city]?.baseDate || cityMeta?.[city]?.baseDate || null;
  if(!d0) return null;
  const parsed = parseDMY(String(d0));
  return parsed || null;
}

function getDayDateLabel(city, dayNum){
  const base = getCityBaseDateDMY(city);
  if(!base) return '';
  try{
    const d = addDays(base, (dayNum-1));
    return formatDMY(d);
  }catch(_){
    return '';
  }
}

function getOrderedCitiesForExport(){
  // Orden exacto: savedDestinations
  const cities = (savedDestinations || []).map(x=>x?.city).filter(Boolean);
  return cities;
}

function getOrderedDaysForCity(city){
  const byDay = itineraries?.[city]?.byDay || {};
  const days = Object.keys(byDay).map(n=>+n).filter(n=>Number.isFinite(n)).sort((a,b)=>a-b);
  if(!days.length){
    const savedN = savedDestinations?.find(x=>x.city===city)?.days;
    if(savedN && Number.isFinite(+savedN) && +savedN>0){
      return Array.from({length:+savedN}, (_,i)=>i+1);
    }
  }
  return days;
}

function normalizeCellText(v){
  let s = String(v ?? '');

  // normaliza saltos
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // reemplazos unicode comunes a ASCII/Latin1-friendly
  s = s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, '-');

  // quitar emojis / surrogate pairs
  s = s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');

  // quitar otros chars no Latin-1 (mantiene acentos Latin1, elimina símbolos raros)
  s = s.replace(/[^\x00-\xFF]/g, '');

  // Excel-friendly: no saltos de línea dentro de celda
  s = s.replace(/\n+/g, ' | ');

  // compactar espacios
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function exportItineraryToCSV(){
  const cities = getOrderedCitiesForExport();
  if(!cities.length){
    alert('No hay ciudades guardadas todavía para exportar.');
    return;
  }

  // Validación: al menos una ciudad con byDay
  const hasAny = cities.some(city=>{
    const byDay = itineraries?.[city]?.byDay;
    return byDay && Object.keys(byDay).length;
  });
  if(!hasAny){
    alert('No hay itinerarios generados todavía para exportar.');
    return;
  }

  const delim = detectCsvDelimiter();
  const lines = [];

  // Header localizado según el idioma elegido por el usuario para el itinerario.
  const csvHeadersByLang = {
    es:['Ciudad','Día','Fecha','Hora inicio','Hora final','Actividad','Desde','Hacia','Transporte','Duración','Notas'],
    en:['City','Day','Date','Start time','End time','Activity','From','To','Transport','Duration','Notes'],
    pt:['Cidade','Dia','Data','Hora início','Hora final','Atividade','De','Para','Transporte','Duração','Notas'],
    fr:['Ville','Jour','Date','Heure début','Heure fin','Activité','Depuis','Vers','Transport','Durée','Notes'],
    de:['Stadt','Tag','Datum','Startzeit','Endzeit','Aktivität','Von','Nach','Transport','Dauer','Hinweise'],
    it:['Città','Giorno','Data','Ora inizio','Ora fine','Attività','Da','A','Trasporto','Durata','Note']
  };
  const csvHeaders = csvHeadersByLang[_plannerOutputLang_()] || csvHeadersByLang.en;
  lines.push(csvHeaders.map(x=>csvEscape(x, delim)).join(delim));

  cities.forEach(city=>{
    const days = getOrderedDaysForCity(city);
    days.forEach(dayNum=>{
      const rows = itineraries?.[city]?.byDay?.[dayNum] || [];
      const dateLabel = getDayDateLabel(city, dayNum);

      rows.forEach(r=>{
        const row = [
          city,
          dayNum,
          dateLabel,
          normalizeCellText(r.start),
          normalizeCellText(r.end),
          normalizeCellText(r.activity),
          normalizeCellText(r.from),
          normalizeCellText(r.to),
          normalizeCellText(r.transport),
          normalizeCellText(r.duration),
          normalizeCellText(r.notes)
        ];
        lines.push(row.map(x=>csvEscape(x, delim)).join(delim));
      });

      // Si un día no tiene filas, igual lo dejamos sin filas (honesto)
    });
  });

  const csv = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });

  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  const filename = `ITBMO-Itinerary-${yyyy}-${mm}-${dd}.csv`;

  return deliverGeneratedFile(blob, filename);
}

async function exportItineraryToPDF(){
  // jsPDF verificación
  if(!window.jspdf || !window.jspdf.jsPDF){
    alert('jsPDF no está disponible. Verifica que los scripts (jsPDF + AutoTable) estén cargando en Webflow.');
    return;
  }
  if(typeof window.jspdf.jsPDF !== 'function'){
    alert('jsPDF no está inicializado correctamente.');
    return;
  }
  if(typeof (window.jspdf?.jsPDF)?.API === 'undefined' && typeof (window.jspdf?.jsPDF) === 'function'){
    // fail-open: no hacemos nada
  }

  const cities = getOrderedCitiesForExport();
  if(!cities.length){
    alert('No hay ciudades guardadas todavía para exportar.');
    return;
  }

  const hasAny = cities.some(city=>{
    const byDay = itineraries?.[city]?.byDay;
    return byDay && Object.keys(byDay).length;
  });
  if(!hasAny){
    alert('No hay itinerarios generados todavía para exportar.');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'pt', format:'a4' });

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const dd = String(now.getDate()).padStart(2,'0');

  /* =========================================================
     ⚠️ Logo / Watermark (ABORTADO por ahora)
     Razón honesta:
     - Para hacerlo perfecto en Webflow, necesito DataURL (base64) real
       o URLs con CORS permitido para poder rasterizar e insertar.
     - Si no, es inestable y puede romper en producción.
     ✅ Hook opcional seguro:
       - Si en el futuro defines:
         window.ITBMO_PDF_LOGO_DATAURL = 'data:image/png;base64,...'
         window.ITBMO_PDF_WATERMARK_DATAURL = 'data:image/png;base64,...'
       entonces se podría activar de forma controlada.
     - En este parche NO lo dibujamos.
  ========================================================= */

  // helper: encabezado por página
  function pageHeader(city, dayNum){
    const left = 40;

    doc.setFontSize(14);
    doc.text(String(normalizeCellText(city || 'Itinerary')), left, 46);

    const dateLabel = getDayDateLabel(city, dayNum);
    doc.setFontSize(11);
    const dayLine = dateLabel ? `${t('uiDayTitle', dayNum)} (${normalizeCellText(dateLabel)})` : `${t('uiDayTitle', dayNum)}`;
    doc.text(normalizeCellText(dayLine), left, 66);

    doc.setFontSize(9);
    doc.text(`${yyyy}-${mm}-${dd}`, left, 84);
  }

  // Encabezados de la tabla (usa i18n del UI si existe)
  const head = [[
    normalizeCellText(t('thStart')),
    normalizeCellText(t('thEnd')),
    normalizeCellText(t('thActivity')),
    normalizeCellText(t('thFrom')),
    normalizeCellText(t('thTo')),
    normalizeCellText(t('thTransport')),
    normalizeCellText(t('thDuration')),
    normalizeCellText(t('thNotes'))
  ]];

  let isFirstPage = true;

  cities.forEach(city=>{
    const days = getOrderedDaysForCity(city);

    days.forEach(dayNum=>{
      const rows = itineraries?.[city]?.byDay?.[dayNum] || [];

      // 1 día = 1 página
      if(!isFirstPage) doc.addPage();
      isFirstPage = false;

      pageHeader(city, dayNum);

      // body
      const body = rows.map(r => ([
        normalizeCellText(r.start),
        normalizeCellText(r.end),
        normalizeCellText(r.activity),
        normalizeCellText(r.from),
        normalizeCellText(r.to),
        normalizeCellText(r.transport),
        normalizeCellText(r.duration),
        normalizeCellText(r.notes)
      ]));

      // Si no hay filas, ponemos nota (honesto) y seguimos
      if(!body.length){
        doc.setFontSize(10);
        doc.text(normalizeCellText(t('uiNoActivities')), 40, 120);
        return;
      }

      try{
        doc.autoTable({
          head,
          body,
          startY: 98,
          margin: { left: 40, right: 40 },
          styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
          headStyles: { fontSize: 8 },
          didDrawPage: () => {}
        });
      }catch(err){
        doc.setFontSize(10);
        doc.text('No se pudo generar la tabla en PDF para este dia.', 40, 120);
      }
    });
  });

  const filename = `ITBMO-Itinerary-${yyyy}-${mm}-${dd}.pdf`;
  const blob=doc.output('blob');
  await deliverGeneratedFile(blob,filename);
}

function sendItineraryByEmail(){
  // MVP honesto: mailto sin adjuntos
  const cities = getOrderedCitiesForExport();
  if(!cities.length){
    alert('No hay ciudades guardadas todavía.');
    return;
  }
  const subject = encodeURIComponent('ITravelByMyOwn · Itinerary');
  let body = 'Here is my itinerary (exported from ITravelByMyOwn):\n\n';

  cities.forEach(city=>{
    const days = getOrderedDaysForCity(city);
    body += `=== ${city} ===\n`;
    days.forEach(dayNum=>{
      const dateLabel = getDayDateLabel(city, dayNum);
      body += `- Day ${dayNum}${dateLabel ? ` (${dateLabel})` : ''}\n`;
    });
    body += '\n';
  });

  body += '\nNote: Attachments (PDF/CSV) require a backend email endpoint.';
  const maxLen = 1800;
  if(body.length > maxLen) body = body.slice(0, maxLen) + '\n...';

  const href = `mailto:?subject=${subject}&body=${encodeURIComponent(body)}`;
  window.location.href = href;
}

async function getPaymentReceiptData(){
  const token=getStoredSessionToken();
  if(!token || !currentTripId) return null;
  try{
    const data=await paymentApi({action:'status',session_token:token,trip_id:currentTripId});
    if(data?.admin_bypass && !data?.payment){
      return {test:true,id:`ADMIN-${String(currentTripId).slice(0,8).toUpperCase()}`,provider:'admin_test_bypass',amount:'0.00',currency:'USD',paid_at:new Date().toISOString(),provider_transaction_id:null};
    }
    return data?.payment ? {...data.payment,test:false} : null;
  }catch(err){ console.warn('[RECEIPT STATUS]',err); return null; }
}

async function exportPaymentReceiptToPDF(preloadedPayment=null){
  const lang = _plannerOutputLang_();

  const copy = {
    es:{
      prep:'No se pudo preparar el comprobante PDF.',
      noPayment:'No encontramos un pago confirmado para este viaje. Si acabas de pagar, espera unos segundos y vuelve a intentarlo.',
      title:'COMPROBANTE DE PAGO',
      summary:'Resumen de la transacción',
      paid:'PAGADO', test:'PRUEBA',
      payment:'Pago', trip:'Viaje',
      date:'Fecha', provider:'Proveedor', amount:'Importe',
      destinations:'Destino(s)', service:'Servicio',
      serviceValue:'1 generación de itinerario ITBMO · hasta 3 ciudades',
      transaction:'REFERENCIA DE TRANSACCIÓN',
      about:'Sobre este comprobante',
      realNote:'Este comprobante confirma el pago registrado por ITBMO para una generación de itinerario de hasta 3 ciudades. Se entrega para control y referencia del usuario.',
      testNote:'Este documento fue generado mediante el bypass administrativo de pruebas. No se procesó ningún pago y este documento no representa una transacción real.',
      important:'IMPORTANTE',
      legal:'Este documento es un comprobante de pago y no constituye factura ni comprobante fiscal. Para soporte: support@itravelbymyown.com',
      operated:'Operado desde Costa Rica'
    },
    en:{
      prep:'Could not prepare the PDF receipt.',
      noPayment:'No confirmed payment was found for this trip. If you just paid, wait a few seconds and try again.',
      title:'PAYMENT RECEIPT',
      summary:'Transaction summary',
      paid:'PAID', test:'TEST',
      payment:'Payment', trip:'Trip',
      date:'Date', provider:'Provider', amount:'Amount',
      destinations:'Destination(s)', service:'Service',
      serviceValue:'1 ITBMO itinerary generation · up to 3 cities',
      transaction:'TRANSACTION REFERENCE',
      about:'About this receipt',
      realNote:'This receipt confirms the payment recorded by ITBMO for one itinerary generation of up to 3 cities. It is provided for the user’s records and reference.',
      testNote:'This document was generated through the administrative test bypass. No payment was processed and this document does not represent a real transaction.',
      important:'IMPORTANT',
      legal:'This document is a payment receipt and is not a tax invoice or fiscal document. For support: support@itravelbymyown.com',
      operated:'Operated from Costa Rica'
    },
    pt:{
      prep:'Não foi possível preparar o comprovante em PDF.',
      noPayment:'Não encontramos um pagamento confirmado para esta viagem. Se você acabou de pagar, aguarde alguns segundos e tente novamente.',
      title:'COMPROVANTE DE PAGAMENTO',
      summary:'Resumo da transação',
      paid:'PAGO', test:'TESTE',
      payment:'Pagamento', trip:'Viagem',
      date:'Data', provider:'Provedor', amount:'Valor',
      destinations:'Destino(s)', service:'Serviço',
      serviceValue:'1 geração de itinerário ITBMO · até 3 cidades',
      transaction:'REFERÊNCIA DA TRANSAÇÃO',
      about:'Sobre este comprovante',
      realNote:'Este comprovante confirma o pagamento registrado pela ITBMO para uma geração de itinerário de até 3 cidades. É fornecido para controle e referência do usuário.',
      testNote:'Este documento foi gerado pelo bypass administrativo de testes. Nenhum pagamento foi processado e este documento não representa uma transação real.',
      important:'IMPORTANTE',
      legal:'Este documento é um comprovante de pagamento e não constitui nota fiscal ou documento fiscal. Suporte: support@itravelbymyown.com',
      operated:'Operado a partir da Costa Rica'
    },
    fr:{
      prep:'Impossible de préparer le reçu PDF.',
      noPayment:'Aucun paiement confirmé n’a été trouvé pour ce voyage. Si vous venez de payer, attendez quelques secondes puis réessayez.',
      title:'REÇU DE PAIEMENT',
      summary:'Résumé de la transaction',
      paid:'PAYÉ', test:'TEST',
      payment:'Paiement', trip:'Voyage',
      date:'Date', provider:'Prestataire', amount:'Montant',
      destinations:'Destination(s)', service:'Service',
      serviceValue:'1 génération d’itinéraire ITBMO · jusqu’à 3 villes',
      transaction:'RÉFÉRENCE DE TRANSACTION',
      about:'À propos de ce reçu',
      realNote:'Ce reçu confirme le paiement enregistré par ITBMO pour une génération d’itinéraire allant jusqu’à 3 villes. Il est fourni pour les dossiers et la référence de l’utilisateur.',
      testNote:'Ce document a été généré via le mode de test administratif. Aucun paiement n’a été traité et ce document ne représente pas une transaction réelle.',
      important:'IMPORTANT',
      legal:'Ce document est un reçu de paiement et ne constitue pas une facture fiscale ni un document fiscal. Support : support@itravelbymyown.com',
      operated:'Exploité depuis le Costa Rica'
    },
    de:{
      prep:'Der PDF-Zahlungsbeleg konnte nicht erstellt werden.',
      noPayment:'Für diese Reise wurde keine bestätigte Zahlung gefunden. Wenn Sie gerade bezahlt haben, warten Sie einige Sekunden und versuchen Sie es erneut.',
      title:'ZAHLUNGSBELEG',
      summary:'Transaktionsübersicht',
      paid:'BEZAHLT', test:'TEST',
      payment:'Zahlung', trip:'Reise',
      date:'Datum', provider:'Anbieter', amount:'Betrag',
      destinations:'Reiseziel(e)', service:'Leistung',
      serviceValue:'1 ITBMO-Reiseplangenerierung · bis zu 3 Städte',
      transaction:'TRANSAKTIONSREFERENZ',
      about:'Über diesen Beleg',
      realNote:'Dieser Beleg bestätigt die von ITBMO registrierte Zahlung für eine Reiseplangenerierung mit bis zu 3 Städten. Er dient den Unterlagen und der Referenz des Nutzers.',
      testNote:'Dieses Dokument wurde über den administrativen Test-Bypass erstellt. Es wurde keine Zahlung verarbeitet und dieses Dokument stellt keine echte Transaktion dar.',
      important:'WICHTIG',
      legal:'Dieses Dokument ist ein Zahlungsbeleg und keine Steuerrechnung oder steuerliche Bescheinigung. Support: support@itravelbymyown.com',
      operated:'Betrieben von Costa Rica aus'
    },
    it:{
      prep:'Impossibile preparare la ricevuta PDF.',
      noPayment:'Non è stato trovato un pagamento confermato per questo viaggio. Se hai appena pagato, attendi qualche secondo e riprova.',
      title:'RICEVUTA DI PAGAMENTO',
      summary:'Riepilogo della transazione',
      paid:'PAGATO', test:'TEST',
      payment:'Pagamento', trip:'Viaggio',
      date:'Data', provider:'Provider', amount:'Importo',
      destinations:'Destinazione/i', service:'Servizio',
      serviceValue:'1 generazione itinerario ITBMO · fino a 3 città',
      transaction:'RIFERIMENTO TRANSAZIONE',
      about:'Informazioni sulla ricevuta',
      realNote:'Questa ricevuta conferma il pagamento registrato da ITBMO per una generazione di itinerario fino a 3 città. È fornita per controllo e riferimento dell’utente.',
      testNote:'Questo documento è stato generato tramite il bypass amministrativo di test. Nessun pagamento è stato elaborato e questo documento non rappresenta una transazione reale.',
      important:'IMPORTANTE',
      legal:'Questo documento è una ricevuta di pagamento e non costituisce fattura fiscale o documento fiscale. Supporto: support@itravelbymyown.com',
      operated:'Operato dalla Costa Rica'
    }
  };

  const c = copy[lang] || copy.en;

  if(!window.jspdf?.jsPDF){
    alert(c.prep);
    return false;
  }

  const payment = preloadedPayment || await getPaymentReceiptData();
  if(!payment){
    alert(c.noPayment);
    return false;
  }

  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({unit:'pt',format:'a4'});
  const W=595.28, H=841.89;
  const M=42;
  const cities=getOrderedCitiesForExport();
  const paidDate = payment.paid_at ? new Date(payment.paid_at) : new Date();

  const dateForId = `${paidDate.getFullYear()}${String(paidDate.getMonth()+1).padStart(2,'0')}${String(paidDate.getDate()).padStart(2,'0')}`;
  const shortPaymentId = String(payment.id || currentTripId || '00000000')
    .replace(/[^A-Za-z0-9]/g,'').slice(0,8).toUpperCase();

  const receiptNo = payment.test
    ? `ADMIN-TEST-${shortPaymentId}`
    : `ITBMO-${dateForId}-${shortPaymentId}`;

  const localeByLang = {
    es:'es-CR', en:'en-GB', pt:'pt-BR', fr:'fr-FR', de:'de-DE', it:'it-IT'
  };
  const locale = localeByLang[lang] || 'en-GB';
  const dateText = new Intl.DateTimeFormat(locale,{
    day:'2-digit', month:'short', year:'numeric',
    hour:'2-digit', minute:'2-digit'
  }).format(paidDate);

  const amountValue = Number(payment.amount || 0);
  const currency = String(payment.currency || 'USD').toUpperCase();
  const provider = payment.test ? 'ADMIN TEST' : String(payment.provider || 'PayPal').toUpperCase();
  const paymentStatus = payment.test
    ? c.test
    : (String(payment.status || 'paid').toLowerCase()==='paid'
        ? c.paid
        : String(payment.status || '').toUpperCase());

  // Fondo
  doc.setFillColor(248,251,253);
  doc.rect(0,0,W,H,'F');

  // Cabecera de marca
  doc.setFillColor(5,44,86);
  doc.roundedRect(M,38,W-(M*2),82,14,14,'F');

  doc.setTextColor(255,255,255);
  doc.setFont('helvetica','bold');
  doc.setFontSize(24);
  doc.text('I Travel',M+22,75);
  doc.setFontSize(11);
  doc.text('By My Own',M+23,94);

  doc.setFontSize(10);
  doc.setFont('helvetica','normal');
  doc.text(c.title,W-M-22,66,{align:'right'});
  doc.setFont('helvetica','bold');
  doc.setFontSize(12);
  doc.text(receiptNo,W-M-22,88,{align:'right'});

  // Título + estado
  doc.setTextColor(7,34,66);
  doc.setFont('helvetica','bold');
  doc.setFontSize(22);
  doc.text(c.summary,M,158);

  const chipW = payment.test ? 100 : 82;
  if(payment.test){
    doc.setFillColor(238,241,246);
    doc.setTextColor(82,92,112);
  }else{
    doc.setFillColor(228,248,239);
    doc.setTextColor(22,120,77);
  }
  doc.roundedRect(W-M-chipW,138,chipW,28,14,14,'F');
  doc.setFont('helvetica','bold');
  doc.setFontSize(9);
  doc.text(paymentStatus,W-M-(chipW/2),156,{align:'center'});

  // Tarjetas
  const cardY=184, cardH=164, gap=14;
  const cardW=(W-(M*2)-gap)/2;

  doc.setFillColor(255,255,255);
  doc.setDrawColor(222,231,239);
  doc.roundedRect(M,cardY,cardW,cardH,12,12,'FD');
  doc.roundedRect(M+cardW+gap,cardY,cardW,cardH,12,12,'FD');

  function labelValue(x,y,label,value,maxWidth=cardW-34){
    doc.setFont('helvetica','bold');
    doc.setFontSize(8.5);
    doc.setTextColor(102,124,145);
    doc.text(String(label).toUpperCase(),x,y);

    doc.setFont('helvetica','normal');
    doc.setFontSize(11);
    doc.setTextColor(7,34,66);
    const lines=doc.splitTextToSize(String(value || '—'),maxWidth);
    doc.text(lines,x,y+17);
  }

  doc.setFont('helvetica','bold');
  doc.setFontSize(11);
  doc.setTextColor(7,34,66);
  doc.text(c.payment,M+17,cardY+24);
  doc.text(c.trip,M+cardW+gap+17,cardY+24);

  labelValue(M+17,cardY+49,c.date,dateText);
  labelValue(M+17,cardY+91,c.provider,provider);
  labelValue(M+17,cardY+133,c.amount,`${currency} ${amountValue.toFixed(2)}`);

  const tripX=M+cardW+gap+17;
  labelValue(tripX,cardY+49,c.destinations,cities.join(' · ') || '—');
  labelValue(tripX,cardY+91,c.service,c.serviceValue);
  labelValue(tripX,cardY+133,'Trip ID',currentTripId || '—');

  // Referencia
  const refY=370;
  doc.setFillColor(242,248,251);
  doc.setDrawColor(210,230,237);
  doc.roundedRect(M,refY,W-(M*2),72,12,12,'FD');
  doc.setFont('helvetica','bold');
  doc.setFontSize(8.5);
  doc.setTextColor(75,112,134);
  doc.text(c.transaction,M+17,refY+23);

  doc.setFont('helvetica','normal');
  doc.setFontSize(11);
  doc.setTextColor(7,34,66);
  doc.text(
    payment.test ? '—' : String(payment.provider_transaction_id || '—'),
    M+17,refY+45,{maxWidth:W-(M*2)-34}
  );

  // Explicación
  doc.setFont('helvetica','bold');
  doc.setFontSize(12);
  doc.setTextColor(7,34,66);
  doc.text(c.about,M,486);

  doc.setFont('helvetica','normal');
  doc.setFontSize(9.5);
  doc.setTextColor(76,95,113);
  doc.text(
    doc.splitTextToSize(payment.test ? c.testNote : c.realNote,W-(M*2)),
    M,507
  );

  // Legal / soporte
  doc.setFillColor(255,250,235);
  doc.setDrawColor(240,221,166);
  doc.roundedRect(M,564,W-(M*2),74,12,12,'FD');
  doc.setFont('helvetica','bold');
  doc.setFontSize(9);
  doc.setTextColor(99,72,12);
  doc.text(c.important,M+17,587);

  doc.setFont('helvetica','normal');
  doc.setFontSize(9);
  doc.text(doc.splitTextToSize(c.legal,W-(M*2)-34),M+17,607);

  // Footer
  doc.setDrawColor(224,231,237);
  doc.line(M,704,W-M,704);
  doc.setFont('helvetica','bold');
  doc.setFontSize(9);
  doc.setTextColor(7,34,66);
  doc.text('I Travel By My Own',M,727);

  doc.setFont('helvetica','normal');
  doc.setTextColor(100,116,132);
  doc.text(c.operated,M,744);
  doc.text('support@itravelbymyown.com',W-M,727,{align:'right'});
  doc.text(receiptNo,W-M,744,{align:'right'});

  const filename = payment.test
    ? `ITBMO-ADMIN-TEST-Receipt-${dateForId}.pdf`
    : `ITBMO-Payment-Receipt-${dateForId}.pdf`;

  const blob=doc.output('blob');
  await deliverGeneratedFile(blob,filename);
  return true;
}

function showFinalDownloadModal(){
  if(document.querySelector('.itbmo-download-overlay')) return;
  const es=getLang()==='es';
  const mobileFiles=isMobileFileExperience();
  const overlay=document.createElement('div'); overlay.className='itbmo-download-overlay';
  overlay.innerHTML=`<div class="itbmo-download-card" role="dialog" aria-modal="true" aria-labelledby="itbmo-download-title">
    <div class="itbmo-download-spark">✓</div><div class="itbmo-download-eyebrow">${es?'ASTRA TERMINÓ':'ASTRA IS DONE'}</div>
    <h3 id="itbmo-download-title">${es?'Tu itinerario está listo.':'Your itinerary is ready.'}</h3>
    <p>${mobileFiles
      ? (es?'Abre y comparte ahora tus documentos. Podrás enviarlos por correo, WhatsApp u otra aplicación, o guardarlos en tu dispositivo.':'Open and share your documents now. You can send them by email, WhatsApp or another app, or save them on your device.')
      : (es?'Descarga ahora tus documentos. ITBMO no conserva permanentemente estos archivos, así que guárdalos en tu dispositivo.':'Download your documents now. ITBMO does not permanently store these files, so save them on your device.')}</p>
    <div class="itbmo-download-files"><span>PDF · ${es?'Itinerario':'Itinerary'}</span><span>CSV · Excel</span><span>PDF · ${es?'Comprobante':'Receipt'}</span></div>
    ${mobileFiles ? `<div class="itbmo-mobile-file-actions" style="display:grid;gap:.65rem;width:100%;margin:.9rem 0">
      <button class="btn primary itbmo-mobile-open-pdf" type="button">${es?'Abrir / compartir itinerario PDF':'Open / share itinerary PDF'}</button>
      <button class="btn primary itbmo-mobile-open-csv" type="button">${es?'Abrir / compartir CSV':'Open / share CSV'}</button>
      <button class="btn primary itbmo-mobile-open-receipt" type="button" disabled>${es?'Preparando comprobante…':'Preparing receipt…'}</button>
    </div>` : `<button class="btn primary itbmo-download-all" type="button">${es?'Descargar mis documentos':'Download my documents'}</button>`}
    <div class="itbmo-download-status" aria-live="polite"></div>
    <label class="itbmo-download-ack"><input type="checkbox"> <span>${es?'He leído esta información y entiendo que debo conservar mis documentos.':'I have read this information and understand that I must keep my documents.'}</span></label>
    <button class="btn itbmo-download-close" type="button" disabled>${es?'Continuar':'Continue'}</button>
    <small>${mobileFiles
      ? (es?'Cada botón abrirá el archivo o mostrará las opciones disponibles para compartirlo y guardarlo.':'Each button will open the file or show the available options to share and save it.')
      : (es?'Si alguna descarga no aparece, usa los botones individuales que quedan disponibles debajo del itinerario.':'If any download does not appear, use the individual buttons available below the itinerary.')}</small>
  </div>`;
  document.body.appendChild(overlay); requestParentViewportFocus('download-ready',true); requestAnimationFrame(()=>overlay.classList.add('active'));
  const ack=overlay.querySelector('input'); const close=overlay.querySelector('.itbmo-download-close'); const status=overlay.querySelector('.itbmo-download-status');
  ack.addEventListener('change',()=>{close.disabled=!ack.checked;});
  close.addEventListener('click',()=>{if(!ack.checked)return;overlay.classList.remove('active');setTimeout(()=>overlay.remove(),220);});
  if(mobileFiles){
    const pdfButton=overlay.querySelector('.itbmo-mobile-open-pdf');
    const csvButton=overlay.querySelector('.itbmo-mobile-open-csv');
    const receiptButton=overlay.querySelector('.itbmo-mobile-open-receipt');
    let preparedReceipt=null;

    getPaymentReceiptData().then(payment=>{
      preparedReceipt=payment;
      if(receiptButton){
        receiptButton.disabled=!payment;
        receiptButton.textContent=payment
          ? (es?'Abrir / compartir comprobante PDF':'Open / share receipt PDF')
          : (es?'Comprobante no disponible':'Receipt unavailable');
      }
    });

    pdfButton?.addEventListener('click',async()=>{
      await exportItineraryToPDF();
      status.textContent=es ? '✓ Itinerario PDF preparado.' : '✓ Itinerary PDF prepared.';
    });
    csvButton?.addEventListener('click',async()=>{
      await exportItineraryToCSV();
      status.textContent=es ? '✓ CSV preparado.' : '✓ CSV prepared.';
    });
    receiptButton?.addEventListener('click',async()=>{
      if(!preparedReceipt) return;
      await exportPaymentReceiptToPDF(preparedReceipt);
      status.textContent=es ? '✓ Comprobante PDF preparado.' : '✓ Receipt PDF prepared.';
    });
  }else{
    overlay.querySelector('.itbmo-download-all')?.addEventListener('click',async()=>{
    /*
      Mantener las tres descargas dentro de la interacción directa del usuario.
      Algunos navegadores bloquean descargas automáticas posteriores cuando se
      disparan desde setTimeout. Los botones individuales permanecen como fallback.
    */
    exportItineraryToPDF();
    exportItineraryToCSV();
    await exportPaymentReceiptToPDF();
    status.textContent=es
      ? '✓ Se iniciaron 3 descargas: itinerario PDF, CSV y comprobante PDF. Revisa tu carpeta de Descargas. Si falta alguna, usa los botones individuales.'
      : '✓ Three downloads were started: itinerary PDF, CSV and payment receipt PDF. Check your Downloads folder. If one is missing, use the individual buttons.';
    });
  }
}

function bindExportListeners(){
  if(isMobileFileExperience()){
    if($btnPDF) $btnPDF.textContent=getLang()==='es' ? 'Abrir / compartir PDF' : 'Open / share PDF';
    if($btnCSV) $btnCSV.textContent=getLang()==='es' ? 'Abrir / compartir CSV' : 'Open / share CSV';
    if($btnReceipt) $btnReceipt.textContent=getLang()==='es' ? 'Abrir / compartir comprobante' : 'Open / share receipt';
  }

  $btnPDF?.addEventListener('click', (e)=>{
    e.preventDefault();
    exportItineraryToPDF();
  });

  $btnCSV?.addEventListener('click', (e)=>{
    e.preventDefault();
    exportItineraryToCSV();
  });

  $btnReceipt?.addEventListener('click', async (e)=>{
    e.preventDefault();
    await exportPaymentReceiptToPDF();
  });

  /* MVP · Email export intentionally disabled until transactional email is activated. */
  if($btnEmail){
    $btnEmail.disabled = true;
    $btnEmail.setAttribute('aria-disabled','true');
    $btnEmail.setAttribute('title', getLang()==='es' ? 'Próximamente' : 'Coming soon');
  }
}

/* =========================================================
   MODAL VISIBILITY · planner iframe -> parent page
   Critical windows request that the parent page brings the top of the
   Planner into view. Standalone Vercel use falls back to window.scrollTo.
   ========================================================= */
function requestParentViewportFocus(reason='modal', immediate=false){
  try{
    if(window.parent && window.parent !== window){
      window.parent.postMessage({
        type:'ITBMO_FOCUS_PLANNER_MODAL',
        reason:String(reason || 'modal'),
        immediate:Boolean(immediate)
      }, '*');
    }else{
      window.scrollTo({top:0,behavior:immediate ? 'auto' : 'smooth'});
    }
  }catch(_){}
}

function showPlannerNotice(title, message){
  qsa('.itbmo-notice-overlay').forEach(el=>el.remove());

  const overlay=document.createElement('div');
  overlay.className='itbmo-notice-overlay';
  overlay.setAttribute('role','presentation');

  const card=document.createElement('div');
  card.className='itbmo-notice-card';
  card.setAttribute('role','dialog');
  card.setAttribute('aria-modal','true');

  const safeTitle=String(title || '');
  const safeMessage=String(message || '');
  const buttonLabel=getLang()==='es' ? 'Entendido' : 'Got it';

  card.innerHTML=`
    <button class="itbmo-notice-close" type="button" aria-label="${getLang()==='es' ? 'Cerrar' : 'Close'}">✕</button>
    <div class="itbmo-notice-symbol">✦</div>
    <h3></h3>
    <p></p>
    <button class="btn primary itbmo-notice-ok" type="button">${buttonLabel}</button>
  `;

  card.querySelector('h3').textContent=safeTitle;
  card.querySelector('p').textContent=safeMessage;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const close=()=>{
    overlay.classList.remove('active');
    setTimeout(()=>overlay.remove(),220);
  };

  overlay.querySelector('.itbmo-notice-close')?.addEventListener('click',close);
  overlay.querySelector('.itbmo-notice-ok')?.addEventListener('click',close);
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) close(); });

  requestParentViewportFocus('info-chat-notice', true);
  requestAnimationFrame(()=>overlay.classList.add('active'));
}

// ⛔ Reset con confirmación modal (corregido: visible → active)
qs('#reset-planner')?.addEventListener('click', ()=>{
  const overlay = document.createElement('div');
  overlay.className = 'reset-overlay';

  const modal = document.createElement('div');
  modal.className = 'reset-modal';
  modal.innerHTML = `
    <h3>${t('resetTitle')}</h3>
    <p>${t('resetBody')}</p>
    <div class="reset-actions">
      <button id="confirm-reset" class="btn warn">${t('resetConfirm')}</button>
      <button id="cancel-reset" class="btn ghost">${t('resetCancel')}</button>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  requestParentViewportFocus('reset-modal', true);
  setTimeout(()=>overlay.classList.add('active'), 10);

  const confirmReset = overlay.querySelector('#confirm-reset');
  const cancelReset  = overlay.querySelector('#cancel-reset');

  confirmReset.addEventListener('click', ()=>{
    $cityList.innerHTML=''; savedDestinations=[]; itineraries={}; cityMeta={};
    addCityRow();
    $start.disabled = true;
    $tabs.innerHTML=''; $itWrap.innerHTML='';
    closeImmersiveItinerary();
    syncImmersiveItineraryLauncher();
    $chatBox.style.display='none'; $chatM.innerHTML='';
    session = []; hasSavedOnce=false; pendingChange=null;
    currentTripId = null;

    planningStarted = false;
    metaProgressIndex = 0;
    collectingHotels = false;
    isItineraryLocked = false;
    activeCity = null;
    agentConversationLang = null;
    if($start){
      delete $start.dataset.itbmoConsumed;
      $start.disabled = true;
      $start.setAttribute('aria-disabled','true');
    }
    setExportToolbarVisibility(false);

    try { $overlayWOW && ($overlayWOW.style.display = 'none'); } catch(_) {}
    qsa('.date-tooltip').forEach(t0 => t0.remove());

    // 🔄 Restaurar formulario lateral a valores por defecto
    const $sc = qs('#special-conditions'); if($sc){ $sc.value = ''; $sc.style.height=''; $sc.style.overflowY='hidden'; }
    const $ad = qs('#p-adults');   if($ad) $ad.value = '1';
    const $yo = qs('#p-young');    if($yo) $yo.value = '0';
    const $ch = qs('#p-children'); if($ch) $ch.value = '0';
    const $in = qs('#p-infants');  if($in) $in.value = '0';
    const $se = qs('#p-seniors');  if($se) $se.value = '0';
    const $bu = qs('#budget');     if($bu) $bu.value = '';
    const $cu = qs('#currency');   if($cu) $cu.value = 'USD';

    resetTravelersUI();

    if (typeof plannerState !== 'undefined') {
      plannerState.destinations = [];
      plannerState.specialConditions = '';
      plannerState.travelers = { adults:1, young:0, children:0, infants:0, seniors:0 };
      plannerState.travelerProfiles = null;
      plannerState.budget = '';
      plannerState.currency = 'USD';
      plannerState.forceReplan = {}; // 🧼 limpiar banderas de replanificación
    }

    overlay.classList.remove('active');
    setTimeout(()=>overlay.remove(), 300);

    // Restore pre-save setup state and hide the post-payment preferences checkpoint.
    if ($sidebar) $sidebar.classList.remove('disabled');
    setSavedSetupLocked(false);
    hidePreferencesStage({reset:true});

    paymentGateSatisfiedTripId = null;
    setInfoChatEntitlement({authorized:false,remaining:0,used:0,tripId:null});

    if ($resetBtn) $resetBtn.setAttribute('disabled','true');
    updateSaveAvailability();

    // UX: enfocar primer input de ciudad
    const firstCity = qs('.city-row .city');
    if (firstCity) firstCity.focus();
  });

  cancelReset.addEventListener('click', ()=>{
    overlay.classList.remove('active');
    setTimeout(()=>overlay.remove(), 300);
  });

  document.addEventListener('keydown', function escHandler(e){
    if(e.key === 'Escape'){
      overlay.classList.remove('active');
      setTimeout(()=>overlay.remove(), 300);
      document.removeEventListener('keydown', escHandler);
    }
  });
});



/* =========================================================
   ITBMO · COMMERCE + CUSTOMER CARE · v70
   ---------------------------------------------------------
   One switchboard controls the complete launch workflow.

   BEFORE PAYMENT PROVIDERS ARE APPROVED:
   previewMode: true
   requirePayment: false
   paypal.enabled: false
   tilopay.enabled: false

   PUBLIC LAUNCH WITHOUT PAYMENTS:
   commerceEnabled: false

   WHEN PAYMENTS GO LIVE:
   commerceEnabled: true
   previewMode: false
   requirePayment: true
   enable approved providers individually.
========================================================= */
const ITBMO_COMMERCE_CONFIG = {
  commerceEnabled: true,
  previewMode: false,
  requirePayment: true,

  currency: 'USD',
  regularPrice: 5.99,
  promoPrice: 2.99,
  promotionCode: 'launch_offer',
  promotionLabel: 'Limited-time launch offer',

  support: {
    enabled: true,
    email: 'support@itravelbymyown.com'
  },

  paypal: {
    enabled: true
  },

  tilopay: {
    enabled: false
  }
};

if(typeof window !== 'undefined'){
  window.ITBMO_COMMERCE_CONFIG = ITBMO_COMMERCE_CONFIG;
}

const $checkoutModal = qs('#checkout-modal');
const $checkoutClose = qs('#checkout-close');
const $checkoutStatus = qs('#checkout-status');
const $checkoutTilopay = qs('#checkout-tilopay');
const $checkoutPayPalFallback = qs('#checkout-paypal-fallback');
const $checkoutPreviewContinue = qs('#checkout-preview-continue');
const $paypalButtonContainer = qs('#paypal-button-container');
const $checkoutSupportLink = qs('#checkout-support-link');

const $needHelp = qs('#need-help-floating');
const $supportModal = qs('#support-modal');
const $supportClose = qs('#support-close');
const $supportEmailButton = qs('#support-email-button');

let paymentGateSatisfiedTripId = null;
let paypalSdkLoadingPromise = null;

/* ---------- Info Chat entitlement ---------- */
const INFO_CHAT_MAX_QUERIES = 10;
let infoChatAuthorizedTripId = null;
let infoChatQueriesRemaining = 0;
let infoChatQueriesUsed = 0;

function _infoChatCopy_(){
  const es = getLang()==='es';
  return es ? {
    locked:'Disponible después del pago',
    unlocked:'Info Chat incluido',
    exhausted:'Límite de Info Chat alcanzado',
    lockedUsage:'Info Chat bloqueado',
    remaining:(n)=>`${n} consulta${n===1?'':'s'} disponible${n===1?'':'s'}`,
    placeholder:'Pregunta sobre las ciudades de tu viaje…',
    lockedPlaceholder:'Info Chat se habilita después del pago',
    exhaustedPlaceholder:'Has utilizado las 10 consultas incluidas'
  } : {
    locked:'Available after payment',
    unlocked:'Info Chat included',
    exhausted:'Info Chat limit reached',
    lockedUsage:'Info Chat locked',
    remaining:(n)=>`${n} quer${n===1?'y':'ies'} remaining`,
    placeholder:'Ask about the cities in your trip…',
    lockedPlaceholder:'Info Chat unlocks after payment',
    exhaustedPlaceholder:'You have used the 10 included queries'
  };
}

function setInfoChatEntitlement({authorized=false, remaining=0, used=0, tripId=null} = {}){
  const copy=_infoChatCopy_();
  const safeRemaining=Math.max(0,Math.min(INFO_CHAT_MAX_QUERIES,Number(remaining)||0));
  const safeUsed=Math.max(0,Math.min(INFO_CHAT_MAX_QUERIES,Number(used)||0));
  const exhausted=authorized && safeRemaining<=0;

  infoChatAuthorizedTripId = authorized ? (tripId || currentTripId || infoChatAuthorizedTripId) : null;
  infoChatQueriesRemaining = safeRemaining;
  infoChatQueriesUsed = safeUsed;

  const btn=qs('#info-chat-floating');
  const input=qs('#info-chat-input');
  const send=qs('#info-chat-send');
  const entitlement=qs('#info-chat-entitlement');
  const entText=qs('#info-chat-entitlement-text');
  const entIcon=qs('#info-chat-entitlement-icon');
  const usageLabel=qs('#info-chat-usage-label');
  const remainingEl=qs('#info-chat-remaining');

  if(btn){
    btn.disabled=!authorized || exhausted;
    btn.setAttribute('aria-disabled', String(!authorized || exhausted));
    btn.classList.toggle('is-locked',!authorized);
    btn.classList.toggle('is-unlocked',authorized && !exhausted);
    btn.textContent = !authorized ? '🔒 Info Chat' : (exhausted ? '✓ Info Chat · 10/10' : `💬 Info Chat · ${safeRemaining}`);
    btn.title = !authorized ? copy.locked : (exhausted ? copy.exhausted : copy.remaining(safeRemaining));
    btn.style.pointerEvents = (!authorized || exhausted) ? 'none' : 'auto';
    btn.style.opacity = (!authorized || exhausted) ? '0.62' : '1';
  }

  if(input){
    input.disabled=!authorized || exhausted;
    input.placeholder=!authorized ? copy.lockedPlaceholder : (exhausted ? copy.exhaustedPlaceholder : copy.placeholder);
  }
  if(send) send.disabled=!authorized || exhausted;

  if(entitlement){
    entitlement.classList.toggle('is-locked',!authorized);
    entitlement.classList.toggle('is-unlocked',authorized && !exhausted);
    entitlement.classList.toggle('is-exhausted',exhausted);
  }
  if(entText) entText.textContent=!authorized ? copy.locked : (exhausted ? copy.exhausted : copy.unlocked);
  if(entIcon) entIcon.textContent=!authorized ? '🔒' : (exhausted ? '✓' : '✓');
  if(usageLabel) usageLabel.textContent=!authorized ? copy.lockedUsage : (exhausted ? copy.exhausted : copy.remaining(safeRemaining));
  if(remainingEl) remainingEl.textContent=`${safeUsed} / ${INFO_CHAT_MAX_QUERIES}`;
}

function applyInfoChatStatus(data){
  const authorized=Boolean(data?.paid || data?.admin_bypass || data?.info_chat_authorized);
  const remaining=Number.isFinite(Number(data?.info_chat_remaining))
    ? Number(data.info_chat_remaining)
    : (authorized ? INFO_CHAT_MAX_QUERIES : 0);
  const used=Number.isFinite(Number(data?.info_chat_used))
    ? Number(data.info_chat_used)
    : Math.max(0,INFO_CHAT_MAX_QUERIES-remaining);

  setInfoChatEntitlement({
    authorized,
    remaining,
    used,
    tripId:currentTripId
  });
}

function _commerceCopy_(){
  const es = getLang()==='es';
  return es ? {
    helpLabel:'¿Necesitas ayuda?',
    supportEyebrow:'Atención al Cliente ITBMO',
    supportTitle:'¿Necesitas una mano?',
    supportCopy:'Si algo salió mal con tu itinerario, pago o cuenta, nuestro equipo está aquí para ayudarte.',
    support1:'Problemas al generar el itinerario',
    support2:'Pagos y reembolsos',
    support3:'Ayuda con tu cuenta',
    supportEmail:'Contactar Atención al Cliente',
    supportFoot:'Incluiremos tu Trip ID automáticamente cuando esté disponible.',
    checkoutEyebrow:'ITBMO Premium Journey',
    checkoutTitle:'Tu viaje está listo para ser creado',
    checkoutSub:'Desbloquea tu itinerario completo y personalizado con Astra.',
    offer:'OFERTA DE LANZAMIENTO · TIEMPO LIMITADO',
    priceNote:'Pago único · Viaje completo · Todas las ciudades configuradas',
    inc1:'Itinerario personalizado completo',
    inc2:'Inteligencia de viaje de Astra',
    inc3:'Exportación PDF y CSV · Email próximamente',
    cardTitle:'Tarjeta de crédito o débito',
    cardCopy:'Visa · Mastercard · American Express',
    secureTitle:'Procesamiento de pago seguro',
    secureCopy:'Los pagos son procesados de forma segura por nuestros proveedores. ITBMO nunca almacena los datos de tu tarjeta.',
    trust1:'Pago seguro',
    trust2:'Política de reembolso clara',
    trust3:'Atención humana',
    supportLink:'¿Necesitas ayuda? Contacta Atención al Cliente',
    preview:'Modo de prueba · Continuar con Astra',
    providerSoon:'Este método todavía no está activado.',
    processing:'Procesando pago…',
    paid:'✓ Pago confirmado. Astra está lista.',
    error:'No pudimos confirmar el pago. Inténtalo nuevamente o contacta soporte.'
  } : {
    helpLabel:'Need help?',
    supportEyebrow:'ITBMO Customer Care',
    supportTitle:'Need a hand?',
    supportCopy:'If something went wrong with your itinerary, payment or account, our team is here to help.',
    support1:'Itinerary generation issues',
    support2:'Payments and refunds',
    support3:'Account assistance',
    supportEmail:'Contact Customer Support',
    supportFoot:'We’ll include your Trip ID automatically when available.',
    checkoutEyebrow:'ITBMO Premium Journey',
    checkoutTitle:'Your journey is ready to be created',
    checkoutSub:'Unlock your complete personalized itinerary with Astra.',
    offer:'LIMITED-TIME LAUNCH OFFER',
    priceNote:'One-time payment · Complete trip · All configured cities',
    inc1:'Complete personalized itinerary',
    inc2:'Astra travel intelligence',
    inc3:'PDF & CSV exports · Email coming soon',
    cardTitle:'Credit or Debit Card',
    cardCopy:'Visa · Mastercard · American Express',
    secureTitle:'Secure payment processing',
    secureCopy:'Payments are securely handled by our payment providers. ITBMO never stores your card details.',
    trust1:'Secure payment',
    trust2:'Clear refund policy',
    trust3:'Human customer support',
    supportLink:'Need help? Contact Customer Support',
    preview:'Preview mode · Continue to Astra',
    providerSoon:'This payment method is not active yet.',
    processing:'Processing payment…',
    paid:'✓ Payment confirmed. Astra is ready.',
    error:'We could not confirm the payment. Please try again or contact support.'
  };
}

function applyCommerceI18n(){
  const c = _commerceCopy_();
  const map = {
    '#need-help-label':c.helpLabel,
    '#support-eyebrow':c.supportEyebrow,
    '#support-title':c.supportTitle,
    '#support-copy':c.supportCopy,
    '#support-item-1':c.support1,
    '#support-item-2':c.support2,
    '#support-item-3':c.support3,
    '#support-email-label':c.supportEmail,
    '#support-footnote':c.supportFoot,
    '#checkout-eyebrow':c.checkoutEyebrow,
    '#checkout-title':c.checkoutTitle,
    '#checkout-subtitle':c.checkoutSub,
    '#checkout-offer-badge':c.offer,
    '#checkout-price-note':c.priceNote,
    '#checkout-inc-1':c.inc1,
    '#checkout-inc-2':c.inc2,
    '#checkout-inc-3':c.inc3,
    '#checkout-card-title':c.cardTitle,
    '#checkout-card-copy':c.cardCopy,
    '#checkout-secure-title':c.secureTitle,
    '#checkout-secure-copy':c.secureCopy,
    '#checkout-trust-1':c.trust1,
    '#checkout-trust-2':c.trust2,
    '#checkout-trust-3':c.trust3,
    '#checkout-support-link':c.supportLink,
    '#checkout-preview-continue':c.preview
  };
  Object.entries(map).forEach(([sel,val])=>{
    const el=qs(sel); if(el) el.textContent=val;
  });

  const oldP = qs('#checkout-price-old');
  const newP = qs('#checkout-price-new');
  if(oldP) oldP.textContent = `US$${Number(ITBMO_COMMERCE_CONFIG.regularPrice).toFixed(2)}`;
  if(newP) newP.textContent = `US$${Number(ITBMO_COMMERCE_CONFIG.promoPrice).toFixed(2)}`;

  if($needHelp) $needHelp.style.display = ITBMO_COMMERCE_CONFIG.support.enabled ? 'flex' : 'none';

  if($checkoutPreviewContinue){
    $checkoutPreviewContinue.style.display = ITBMO_COMMERCE_CONFIG.previewMode ? 'block' : 'none';
  }

  [$checkoutTilopay,$checkoutPayPalFallback].forEach(el=>el?.classList.remove('is-disabled'));
  if($checkoutTilopay && !ITBMO_COMMERCE_CONFIG.tilopay.enabled && !ITBMO_COMMERCE_CONFIG.previewMode){
    $checkoutTilopay.classList.add('is-disabled');
  }
  if($checkoutPayPalFallback && !ITBMO_COMMERCE_CONFIG.paypal.enabled && !ITBMO_COMMERCE_CONFIG.previewMode){
    $checkoutPayPalFallback.classList.add('is-disabled');
  }
}

function openSupportModal(){
  if(!$supportModal || !ITBMO_COMMERCE_CONFIG.support.enabled) return;
  requestParentViewportFocus('support-modal', true);
  $supportModal.scrollTop=0;
  const card=$supportModal.querySelector('.support-card');
  if(card) card.scrollTop=0;
  $supportModal.classList.add('active');
  $supportModal.setAttribute('aria-hidden','false');
}

function closeSupportModal(){
  if(!$supportModal) return;
  $supportModal.classList.remove('active');
  $supportModal.setAttribute('aria-hidden','true');
}

function _supportMailto_(){
  const es = getLang()==='es';
  const userEmail = String(currentUser?.email || '').trim();
  const username = String(currentUser?.username || '').trim();
  const cities = (savedDestinations || []).map(x=>x?.city).filter(Boolean).join(', ');
  const trip = currentTripId || 'Not available';
  const subject = es
    ? `ITBMO Support · Trip ${trip}`
    : `ITBMO Support · Trip ${trip}`;

  const body = es ? [
    'Hola equipo de ITBMO,',
    '',
    'Necesito ayuda con mi viaje.',
    '',
    `Trip ID: ${trip}`,
    `Usuario: ${username || 'N/A'}`,
    `Email: ${userEmail || 'N/A'}`,
    `Destino(s): ${cities || 'N/A'}`,
    '',
    'Describe el problema:',
    '',
    ''
  ] : [
    'Hi ITBMO Support,',
    '',
    'I need help with my trip.',
    '',
    `Trip ID: ${trip}`,
    `Username: ${username || 'N/A'}`,
    `Email: ${userEmail || 'N/A'}`,
    `Destination(s): ${cities || 'N/A'}`,
    '',
    'Please describe the issue:',
    '',
    ''
  ];

  return `mailto:${encodeURIComponent(ITBMO_COMMERCE_CONFIG.support.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.join('\n'))}`;
}

function contactCustomerSupport(){
  window.location.href = _supportMailto_();
}

function setCheckoutStatus(message='', type=''){
  if(!$checkoutStatus) return;
  $checkoutStatus.textContent = message || '';
  $checkoutStatus.className = 'checkout-status' + (type ? ` ${type}` : '');
}

function openCheckoutModal(){
  if(!$checkoutModal) return;
  applyCommerceI18n();
  setCheckoutStatus('');
  $checkoutModal.classList.add('active');
  $checkoutModal.setAttribute('aria-hidden','false');

  /* QUIRÚRGICO · Checkout visibility inside the auto-height Webflow iframe.
     The parent page is moved to the Planner top, while the modal itself always
     opens from its own top. This avoids hiding checkout in a tall iframe. */
  requestParentViewportFocus('checkout-modal', true);
  $checkoutModal.scrollTop=0;
  const checkoutCard=$checkoutModal.querySelector('.checkout-card');
  if(checkoutCard) checkoutCard.scrollTop=0;

  Promise.resolve(renderPayPalButtonsIfAvailable()).finally(()=>{
    $checkoutModal.scrollTop=0;
    if(checkoutCard) checkoutCard.scrollTop=0;
    requestParentViewportFocus('checkout-modal', true);
  });
}

function closeCheckoutModal(){
  if(!$checkoutModal) return;
  $checkoutModal.classList.remove('active');
  $checkoutModal.setAttribute('aria-hidden','true');
}

async function paymentApi(payload){
  const response = await fetch(PAYMENT_API_URL,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload || {})
  });
  let data={};
  try{ data=await response.json(); }catch(_){}
  if(!response.ok || data?.ok===false){
    throw new Error(data?.error || `PAYMENT_HTTP_${response.status}`);
  }
  return data;
}

async function hasValidPaymentForCurrentTrip(){
  if(!ITBMO_COMMERCE_CONFIG.requirePayment) return true;
  if(!currentTripId) return false;
  if(paymentGateSatisfiedTripId === currentTripId) return true;

  try{
    const token = getStoredSessionToken();
    if(!token) return false;
    const data = await paymentApi({
      action:'status',
      session_token:token,
      trip_id:currentTripId
    });
    const paid = Boolean(data?.paid);
    if(paid) paymentGateSatisfiedTripId=currentTripId;
    applyInfoChatStatus(data);
    return paid;
  }catch(err){
    console.warn('[PAYMENT STATUS]',err);
    return false;
  }
}

async function completePaymentGate(){
  paymentGateSatisfiedTripId = currentTripId || paymentGateSatisfiedTripId;
  setCheckoutStatus(_commerceCopy_().paid,'success');

  /* Refresh authoritative entitlement + remaining Info Chat queries. */
  try{
    const token=getStoredSessionToken();
    if(token && currentTripId){
      const status=await paymentApi({
        action:'status',
        session_token:token,
        trip_id:currentTripId
      });
      applyInfoChatStatus(status);
    }
  }catch(err){
    console.warn('[INFO CHAT ENTITLEMENT AFTER PAYMENT]',err);
  }

  setTimeout(()=>{
    closeCheckoutModal();
    showPreferencesStage();
  },500);
}

async function requestPlanningStart(){
  if(!validateBaseDatesDMY()) return;

  if(!ITBMO_COMMERCE_CONFIG.commerceEnabled){
    showPreferencesStage();
    return;
  }

  const alreadyPaid = await hasValidPaymentForCurrentTrip();
  if(alreadyPaid){
    showPreferencesStage();
    return;
  }

  openCheckoutModal();
}

async function loadPayPalSdk(){
  if(window.paypal) return window.paypal;
  if(paypalSdkLoadingPromise) return paypalSdkLoadingPromise;
  if(!ITBMO_COMMERCE_CONFIG.paypal.enabled) return null;

  paypalSdkLoadingPromise = (async()=>{
    const token=getStoredSessionToken();
    const cfg=await paymentApi({action:'config',session_token:token});
    const clientId=String(cfg?.paypal_client_id || '').trim();
    if(!clientId) throw new Error('PAYPAL_CLIENT_ID_NOT_AVAILABLE');

    await new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src=`https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(ITBMO_COMMERCE_CONFIG.currency)}&intent=capture`;
      script.async=true;
      script.onload=resolve;
      script.onerror=()=>reject(new Error('PAYPAL_SDK_LOAD_FAILED'));
      document.head.appendChild(script);
    });
    return window.paypal;
  })();

  return paypalSdkLoadingPromise;
}

async function renderPayPalButtonsIfAvailable(){
  if(!$paypalButtonContainer) return;
  if(!ITBMO_COMMERCE_CONFIG.paypal.enabled){
    $paypalButtonContainer.innerHTML='';
    if($checkoutPayPalFallback) $checkoutPayPalFallback.style.display='flex';
    return;
  }

  try{
    const paypal = await loadPayPalSdk();
    if(!paypal?.Buttons) return;

    $paypalButtonContainer.innerHTML='';
    if($checkoutPayPalFallback) $checkoutPayPalFallback.style.display='none';

    await paypal.Buttons({
      style:{layout:'vertical',shape:'rect',height:45,label:'paypal'},
      createOrder: async()=>{
        const token=getStoredSessionToken();
        const data=await paymentApi({
          action:'paypal_create_order',
          session_token:token,
          trip_id:currentTripId,
          promotion:ITBMO_COMMERCE_CONFIG.promotionCode
        });
        if(!data?.order_id) throw new Error('PAYPAL_ORDER_ID_MISSING');
        return data.order_id;
      },
      onApprove: async(data)=>{
        setCheckoutStatus(_commerceCopy_().processing);
        const token=getStoredSessionToken();
        const result=await paymentApi({
          action:'paypal_capture_order',
          session_token:token,
          trip_id:currentTripId,
          order_id:data.orderID
        });
        if(!result?.paid) throw new Error('PAYPAL_CAPTURE_NOT_PAID');
        await completePaymentGate();
      },
      onCancel:()=>setCheckoutStatus(''),
      onError:(err)=>{
        console.error('[PAYPAL]',err);
        setCheckoutStatus(_commerceCopy_().error,'error');
      }
    }).render('#paypal-button-container');
  }catch(err){
    console.error('[PAYPAL SDK]',err);
    if($checkoutPayPalFallback) $checkoutPayPalFallback.style.display='flex';
    setCheckoutStatus(_commerceCopy_().error,'error');
  }
}

async function beginTilopayCheckout(){
  if(ITBMO_COMMERCE_CONFIG.previewMode && !ITBMO_COMMERCE_CONFIG.tilopay.enabled){
    setCheckoutStatus(_commerceCopy_().providerSoon);
    return;
  }
  if(!ITBMO_COMMERCE_CONFIG.tilopay.enabled){
    setCheckoutStatus(_commerceCopy_().providerSoon,'error');
    return;
  }

  try{
    setCheckoutStatus(_commerceCopy_().processing);
    const token=getStoredSessionToken();
    const data=await paymentApi({
      action:'tilopay_create_checkout',
      session_token:token,
      trip_id:currentTripId,
      promotion:ITBMO_COMMERCE_CONFIG.promotionCode,
      return_url:window.location.href
    });

    if(data?.paid){
      await completePaymentGate();
      return;
    }

    if(data?.redirect_url){
      window.open(data.redirect_url,'_blank','noopener,noreferrer');
      setCheckoutStatus(getLang()==='es'
        ? 'Completa el pago en la ventana segura de Tilopay y vuelve aquí.'
        : 'Complete the payment in the secure Tilopay window and return here.');
      return;
    }

    throw new Error('TILOPAY_CHECKOUT_NOT_AVAILABLE');
  }catch(err){
    console.error('[TILOPAY]',err);
    setCheckoutStatus(_commerceCopy_().error,'error');
  }
}

function initCommerceAndSupport(){
  applyCommerceI18n();

  $needHelp?.addEventListener('click',openSupportModal);
  $supportClose?.addEventListener('click',closeSupportModal);
  $supportEmailButton?.addEventListener('click',contactCustomerSupport);
  $checkoutSupportLink?.addEventListener('click',()=>{
    closeCheckoutModal();
    openSupportModal();
  });

  $checkoutClose?.addEventListener('click',closeCheckoutModal);
  $checkoutTilopay?.addEventListener('click',beginTilopayCheckout);
  $checkoutPayPalFallback?.addEventListener('click',()=>{
    if(ITBMO_COMMERCE_CONFIG.previewMode && !ITBMO_COMMERCE_CONFIG.paypal.enabled){
      setCheckoutStatus(_commerceCopy_().providerSoon);
      return;
    }
    renderPayPalButtonsIfAvailable();
  });
  /* Preview bypass removed from browser code.
     Administrative testing is authorized only server-side in Vercel Preview. */
  if($checkoutPreviewContinue) $checkoutPreviewContinue.style.display='none';

  [$supportModal,$checkoutModal].forEach(modal=>{
    modal?.addEventListener('click',(e)=>{
      if(e.target===modal){
        if(modal===$supportModal) closeSupportModal();
        if(modal===$checkoutModal) closeCheckoutModal();
      }
    });
  });

  document.addEventListener('keydown',(e)=>{
    if(e.key!=='Escape') return;
    closeSupportModal();
    closeCheckoutModal();
  });
}

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',initCommerceAndSupport,{once:true});
}else{
  initCommerceAndSupport();
}


$start?.addEventListener('click', requestPlanningStart);
$preferencesContinue?.addEventListener('click', confirmPreferencesAndContinue);
$send?.addEventListener('click', onSend);

// Chat: Enter envía (sin Shift)
$chatI?.addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    onSend();
  }
});

// CTA y upsell
$confirmCTA?.addEventListener('click', ()=>{
  isItineraryLocked = true;

  if($upsell) $upsell.style.display='flex';
});
$upsellClose?.addEventListener('click', ()=>{
  if($upsell) $upsell.style.display='none';
});

/* 🆕 Listener: Rebalanceo inteligente al agregar días */
document.addEventListener('itbmo:addDays', e=>{
  const { city, extraDays, dayTripTo } = e.detail || {};
  if(!city || !extraDays) return;
  // Usa la misma lógica de addMultipleDaysToCity
  addMultipleDaysToCity(city, extraDays);

  // 🧠 Determinar rango de rebalanceo dinámico
  const start = itineraries[city]?.originalDays || 1;
  const end = (itineraries[city]?.originalDays || 0) + extraDays;

  // ⚡ Ejecutar rebalanceo selectivo
  rebalanceWholeCity(city, { start, end, dayTripTo });
});

/* ====== Info Chat: IDs #info-chat-* + control de display ====== */
let infoChatWelcomeTripId = null;
let infoChatDragState = null;
let infoChatSuppressRestoreClick = false;

function _infoAllowedCities_(){
  return (savedDestinations || []).map(d=>String(d?.city || '').trim()).filter(Boolean);
}

function _infoCityListText_(){
  const cities=_infoAllowedCities_();
  const es=getLang()==='es';
  if(!cities.length) return es ? 'las ciudades de tu itinerario' : 'the cities in your itinerary';
  if(cities.length===1) return cities[0];
  if(cities.length===2) return `${cities[0]} ${es?'y':'and'} ${cities[1]}`;
  return `${cities.slice(0,-1).join(', ')} ${es?'y':'and'} ${cities.at(-1)}`;
}

function ensureInfoChatWelcome(){
  if(!currentTripId || infoChatWelcomeTripId===currentTripId) return;
  const container=qs('#info-chat-messages');
  if(!container) return;
  if(container.querySelector('.chat-message')){
    infoChatWelcomeTripId=currentTripId;
    return;
  }
  const es=getLang()==='es';
  const cities=_infoCityListText_();
  const html=es
    ? `<strong>¡Hola! Soy Astra, tu concierge para ${cities}. 🌍</strong><br><br>¿En qué te ayudo ahora? Puedo orientarte sobre zonas para hospedarte, transporte local, barrios, gastronomía, costumbres, seguridad general, fotografía, equipaje, presupuesto orientativo y cómo organizar mejor tus visitas dentro de estas ciudades.`
    : `<strong>Hi! I’m Astra, your concierge for ${cities}. 🌍</strong><br><br>How can I help? I can guide you on areas to stay, local transportation, neighborhoods, local food, customs, general safety, photography, packing, indicative budgets and how to organize your visits within these cities.`;
  infoChatMsg(html,'ai');
  infoChatWelcomeTripId=currentTripId;
}

function showInfoChatNotice(title,message){
  const layer=qs('#info-chat-inline-notice');
  if(!layer){
    showPlannerNotice(title,message);
    return;
  }
  const titleEl=qs('#info-chat-inline-notice-title');
  const messageEl=qs('#info-chat-inline-notice-message');
  const ok=qs('#info-chat-inline-notice-ok');
  if(titleEl) titleEl.textContent=String(title || '');
  if(messageEl) messageEl.textContent=String(message || '');
  if(ok) ok.textContent=getLang()==='es' ? 'Entendido' : 'Got it';
  layer.setAttribute('aria-hidden','false');
  layer.classList.add('is-visible');
}

function hideInfoChatNotice(){
  const layer=qs('#info-chat-inline-notice');
  if(!layer) return;
  layer.classList.remove('is-visible');
  layer.setAttribute('aria-hidden','true');
}

function normalizeInfoCityText(value){
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
}

/* Fast local guard for obvious out-of-itinerary city mentions.
   It is intentionally conservative; the server remains authoritative. */
function detectObviousOutsideCity(text){
  const allowed=_infoAllowedCities_();
  if(!allowed.length) return null;
  const allowedNorm=allowed.map(normalizeInfoCityText);
  const raw=String(text || '').trim();
  const norm=normalizeInfoCityText(raw);
  if(allowedNorm.some(c=>norm.includes(c))) return null;

  const commonCities=[
    'paris','london','rome','madrid','barcelona','lisbon','porto','amsterdam','berlin','munich','vienna','prague','budapest','venice','florence','milan','naples','reykjavik','dublin','edinburgh','athens','istanbul','zurich','geneva','lucerne','copenhagen','stockholm','oslo','helsinki','rovaniemi','tokyo','kyoto','osaka','seoul','bangkok','singapore','dubai','new york','boston','miami','los angeles','san francisco','chicago','toronto','vancouver','mexico city','cancun','lima','cusco','bogota','medellin','buenos aires','santiago','rio de janeiro','sao paulo','sydney','melbourne','auckland',
    'parís','londres','roma','madrid','barcelona','lisboa','oporto','amsterdam','berlín','munich','múnich','viena','praga','budapest','venecia','florencia','milán','napoles','nápoles','reikiavik','dublin','dublín','edimburgo','atenas','estambul','zúrich','ginebra','lucerna','copenhague','estocolmo','oslo','helsinki','rovaniemi','tokio','kioto','osaka','seúl','bangkok','singapur','dubái','nueva york','miami','los angeles','los ángeles','san francisco','chicago','toronto','vancouver','ciudad de mexico','ciudad de méxico','cancún','lima','cusco','bogotá','medellín','buenos aires','santiago','rio de janeiro','río de janeiro','sao paulo','são paulo','sidney','melbourne','auckland'
  ];
  const normalizedCommon=[...new Set(commonCities.map(normalizeInfoCityText))]
    .sort((a,b)=>b.length-a.length);
  const hit=normalizedCommon.find(city=>{
    if(allowedNorm.includes(city)) return false;
    const esc=city.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`,'i').test(norm);
  });
  if(!hit) return null;
  const display=commonCities.find(c=>normalizeInfoCityText(c)===hit) || hit;
  return display.replace(/\b\w/g,ch=>ch.toUpperCase());
}

function minimizeInfoModal(){
  const modal=qs('#info-chat-modal');
  if(!modal) return;
  hideInfoChatNotice();
  modal.classList.add('is-minimized');
  modal.classList.add('active');
  modal.style.display='flex';
}

function restoreInfoModal(){
  const modal=qs('#info-chat-modal');
  if(!modal) return;
  modal.classList.remove('is-minimized');
  modal.classList.add('active');
  modal.style.display='flex';
  ensureInfoChatWelcome();
}

function initInfoChatDrag(){
  const modal=qs('#info-chat-modal');
  const header=modal?.querySelector('.info-chat-header');
  if(!modal || !header || header.dataset.dragBound==='1') return;
  header.dataset.dragBound='1';

  header.addEventListener('pointerdown',(e)=>{
    if(window.matchMedia('(max-width: 760px)').matches) return;
    if(e.target.closest('button,a,input,textarea')) return;
    const rect=modal.getBoundingClientRect();
    infoChatDragState={
      pointerId:e.pointerId,
      dx:e.clientX-rect.left,
      dy:e.clientY-rect.top,
      startX:e.clientX,
      startY:e.clientY,
      moved:false
    };
    header.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });

  header.addEventListener('pointermove',(e)=>{
    if(!infoChatDragState || infoChatDragState.pointerId!==e.pointerId) return;

    const distance=Math.hypot(
      e.clientX-infoChatDragState.startX,
      e.clientY-infoChatDragState.startY
    );

    /* Small pointer jitter remains a click. */
    if(!infoChatDragState.moved && distance<7) return;

    if(!infoChatDragState.moved){
      infoChatDragState.moved=true;
      modal.classList.add('is-dragging');
    }

    const margin=10;
    const rect=modal.getBoundingClientRect();
    const maxLeft=Math.max(margin,window.innerWidth-rect.width-margin);
    const maxTop=Math.max(margin,window.innerHeight-rect.height-margin);
    const left=Math.min(Math.max(margin,e.clientX-infoChatDragState.dx),maxLeft);
    const top=Math.min(Math.max(margin,e.clientY-infoChatDragState.dy),maxTop);
    modal.style.left=`${left}px`;
    modal.style.top=`${top}px`;
    modal.style.right='auto';
    modal.style.bottom='auto';
  });

  const end=(e)=>{
    if(!infoChatDragState || infoChatDragState.pointerId!==e.pointerId) return;
    const moved=Boolean(infoChatDragState.moved);
    infoChatDragState=null;
    modal.classList.remove('is-dragging');
    try{ header.releasePointerCapture?.(e.pointerId); }catch(_){}

    /* A drag of the minimized window must not be interpreted as the click that restores it. */
    if(moved && modal.classList.contains('is-minimized')){
      infoChatSuppressRestoreClick=true;
      setTimeout(()=>{ infoChatSuppressRestoreClick=false; },120);
    }
  };
  header.addEventListener('pointerup',end);
  header.addEventListener('pointercancel',end);
}

function openInfoModal(){
  if(!currentTripId || infoChatAuthorizedTripId !== currentTripId || infoChatQueriesRemaining <= 0){
    return;
  }
  const modal = qs('#info-chat-modal');
  if(!modal) return;
  requestParentViewportFocus('info-chat-modal', true);
  modal.style.display = 'flex';
  modal.classList.add('active');
  modal.classList.remove('is-minimized');
  hideInfoChatNotice();
  initInfoChatDrag();
  ensureInfoChatWelcome();

  document.body.classList.add('itbmo-info-open');
}
function closeInfoModal(){
  const modal = qs('#info-chat-modal');
  if(!modal) return;
  modal.classList.remove('active','is-minimized');
  hideInfoChatNotice();
  modal.style.display = 'none';

  // 🆕 Hook para CSS tipo ChatGPT
  document.body.classList.remove('itbmo-info-open');
}
async function sendInfoMessage(){
  const input = qs('#info-chat-input');
  const btn   = qs('#info-chat-send');
  if(!input || !btn) return;
  if(!currentTripId || infoChatAuthorizedTripId !== currentTripId || infoChatQueriesRemaining <= 0){
    setInfoChatEntitlement({
      authorized: infoChatAuthorizedTripId === currentTripId,
      remaining: infoChatQueriesRemaining,
      used: infoChatQueriesUsed,
      tripId:currentTripId
    });
    return;
  }

  const txt = (input.value||'').trim();
  if(!txt) return;

  const obviousOutsideCity=detectObviousOutsideCity(txt);
  if(obviousOutsideCity){
    const es=getLang()==='es';
    showInfoChatNotice(
      es ? 'Esta ciudad no está en tu itinerario' : 'This city is not in your itinerary',
      es
        ? `Info Chat está disponible para ${_infoCityListText_()}. ${obviousOutsideCity} no forma parte de este itinerario. No se consumió ninguna consulta.`
        : `Info Chat is available for ${_infoCityListText_()}. ${obviousOutsideCity} is not part of this itinerary. No query was used.`
    );
    return;
  }

  infoChatMsg(txt,'user');
  input.value='';
  resizeInfoChatComposer(input);

  const result = await callInfoAgent(txt);

  if(result?.notice){
    showInfoChatNotice(result.notice.title,result.notice.message);
  }else if(result?.text){
    infoChatMsg(result.text);
  }

  if(Number.isFinite(Number(result?.remaining))){
    const remaining=Math.max(0,Number(result.remaining));
    setInfoChatEntitlement({
      authorized:true,
      remaining,
      used:INFO_CHAT_MAX_QUERIES-remaining,
      tripId:currentTripId
    });
  }

  if(result?.quotaExceeded){
    setInfoChatEntitlement({
      authorized:true,
      remaining:0,
      used:INFO_CHAT_MAX_QUERIES,
      tripId:currentTripId
    });
  }
}
function bindInfoChatListeners(){
  const toggleTop = qs('#info-chat-toggle');
  const toggleFloating = qs('#info-chat-floating'); // 🆕 soporte flotante
  const close  = qs('#info-chat-close');
  const minimize = qs('#info-chat-minimize');
  const noticeOk = qs('#info-chat-inline-notice-ok');
  const send   = qs('#info-chat-send');
  const input  = qs('#info-chat-input');

  // Limpieza previa por si se re-vincula
  toggleTop?.replaceWith(toggleTop.cloneNode(true));
  toggleFloating?.replaceWith(toggleFloating.cloneNode(true));
  close?.replaceWith(close.cloneNode(true));
  minimize?.replaceWith(minimize.cloneNode(true));
  noticeOk?.replaceWith(noticeOk.cloneNode(true));
  send?.replaceWith(send.cloneNode(true));

  const tTop = qs('#info-chat-toggle');
  const tFloat = qs('#info-chat-floating');
  const c2 = qs('#info-chat-close');
  const m2 = qs('#info-chat-minimize');
  const n2 = qs('#info-chat-inline-notice-ok');
  const s2 = qs('#info-chat-send');
  const i2 = qs('#info-chat-input');

  [tTop, tFloat].forEach(btn=>{
    btn?.addEventListener('click', (e)=>{ e.preventDefault(); openInfoModal(); });
  });
  c2?.addEventListener('click', (e)=>{ e.preventDefault(); closeInfoModal(); });
  m2?.addEventListener('click', (e)=>{ e.preventDefault(); minimizeInfoModal(); });
  n2?.addEventListener('click', (e)=>{ e.preventDefault(); hideInfoChatNotice(); });
  s2?.addEventListener('click', (e)=>{ e.preventDefault(); sendInfoMessage(); });

  qs('#info-chat-modal')?.addEventListener('click',(e)=>{
    const modal=qs('#info-chat-modal');
    if(!modal?.classList.contains('is-minimized')) return;
    if(e.target.closest('.info-chat-window-actions')) return;

    if(infoChatSuppressRestoreClick){
      e.preventDefault();
      e.stopPropagation();
      infoChatSuppressRestoreClick=false;
      return;
    }

    restoreInfoModal();
  });

  initInfoChatDrag();

  // Chat estilo GPT: Enter = enviar / Shift+Enter = salto de línea
  i2?.addEventListener('keydown', (e)=>{
    if(e.key==='Enter' && !e.shiftKey){
      e.preventDefault();
      sendInfoMessage();
    }
  });

  // Textarea auto-ajustable: considera saltos de línea y wrap automático
  if(i2){
    i2.setAttribute('rows','1');
    resizeInfoChatComposer(i2);
    i2.addEventListener('input', ()=>{
      resizeInfoChatComposer(i2);
    });
  }

  // Delegación de respaldo por si el toggle cambia internamente
  document.addEventListener('click', (e)=>{
    const el = e.target.closest('#info-chat-toggle, #info-chat-floating');
    if(el){
      e.preventDefault();
      openInfoModal();
    }
  });
}

function enhancePreferencesInfoChatCopy(){
  const field=qs('#special-conditions');
  if(!field || qs('#itbmo-preferences-help-row')) return;

  const lang = _plannerOutputLang_();
  const copy = {
    en:{
      guideTitle:'✨ Tell Astra exactly how you want to live your trip',
      guideSubtitle:'This will help create an itinerary that truly matches you.',
      guideItems:[
        '🏞️ Style & activities → “I prefer nature and landscapes. Avoid museums.” / “I want authentic tours, not massive ones.”',
        '🚗 Transportation → “I’ll rent a 4x4.” / “I’ll use public transport.” / “Uber or taxi when needed.”',
        '🏃 Pace & adventure level → “Relaxed trip.” / “Balanced.” / “Extreme adventure.”',
        '🧭 Must-dos → “Northern lights hunt.” / “Whale watching.” / “Golden Circle tour.”',
        '⚕️ Health & restrictions → “Asthma, reduced mobility, knee issues, food allergies.”',
        '👨‍👩‍👧‍👦 Other important details → “Traveling with small kids.” / “Need flexible hours.” / “Avoid long walks.”'
      ],
      guideFinal:'📝 The more details you share, the more precise, smooth and personalized your itinerary will be.',
      unsureTitle:'💡 Not sure what to write?',
      unsureIntro:'Info Chat 🌐 is now available with up to 10 trip-related queries for the cities in this itinerary. Use it before continuing if you want more context for your preferences.',
      unsureExamples:'For example:',
      unsureItems:['🏨 Best area or neighborhood to stay','🧳 Seasonal context and what to pack','🚇 Transportation and how to get around','🍽️ Local cuisine and dining areas','📸 Hidden gems and photography spots','🧭 Neighborhoods, customs and practical local context','🧳 What to pack and local customs','💰 Budget recommendations','❓ Anything else related to your trip'],
      placeholder:'Write your preferences, restrictions or special conditions here…',
      close:'Close'
    },
    es:{
      guideTitle:'✨ Cuéntale a ASTRA exactamente cómo quieres vivir tu viaje',
      guideSubtitle:'Esta información permitirá crear un itinerario realmente alineado contigo.',
      guideItems:[
        '🏞️ Estilo y actividades → “Prefiero naturaleza y paisajes. Evitar museos.” / “Quiero tours auténticos, no masivos.”',
        '🚗 Transporte → “Voy a rentar un 4x4.” / “Usaré transporte público.” / “Uber o taxi cuando sea necesario.”',
        '🏃 Ritmo y nivel de aventura → “Viaje relax.” / “Balanceado.” / “Aventura extrema.”',
        '🧭 Actividades imperdibles → “Caza de auroras.” / “Avistamiento de ballenas.” / “Tour al Círculo Dorado.”',
        '⚕️ Salud y restricciones → “Asma, movilidad reducida, problemas de rodillas, alergias alimentarias.”',
        '👨‍👩‍👧‍👦 Otros detalles importantes → “Viajo con niños pequeños.” / “Necesito horarios flexibles.” / “Evitar caminatas largas.”'
      ],
      guideFinal:'📝 Entre más detalles indiques, más preciso, fluido y personalizado será tu itinerario.',
      unsureTitle:'💡 ¿No sabes qué escribir?',
      unsureIntro:'Info Chat 🌐 ya está disponible con hasta 10 consultas relacionadas con las ciudades de este itinerario. Úsalo antes de continuar si necesitas más contexto para tus preferencias.',
      unsureExamples:'Por ejemplo:',
      unsureItems:['🏨 Mejor zona o barrio para hospedarte','🧳 Contexto estacional y qué llevar','🚇 Transporte y cómo desplazarte','🍽️ Gastronomía local y zonas para comer','📸 Lugares ocultos y puntos para fotografía','🧭 Barrios, costumbres y contexto práctico local','🧳 Qué llevar y costumbres locales','💰 Recomendaciones de presupuesto','❓ Cualquier otra consulta relacionada con tu viaje'],
      placeholder:'Escribe aquí tus preferencias, restricciones o condiciones especiales…',
      close:'Cerrar'
    }
  }[lang] || null;

  const c=copy || {
    guideTitle:'✨ Tell Astra exactly how you want to live your trip',
    guideSubtitle:'This will help create an itinerary that truly matches you.',
    guideItems:[
      '🏞️ Style & activities → nature, landscapes, museums, authentic tours.',
      '🚗 Transportation → rental car, public transport, taxi/Uber.',
      '🏃 Pace & adventure level → relaxed, balanced, adventurous.',
      '🧭 Must-dos → activities or experiences you do not want to miss.',
      '⚕️ Health & restrictions → mobility, allergies or other limitations.',
      '👨‍👩‍👧‍👦 Other important details → children, flexible hours, long walks.'
    ],
    guideFinal:'📝 The more details you share, the more personalized and optimized your itinerary becomes.',
    unsureTitle:'💡 Not sure what to write?',
    unsureIntro:'Use Info Chat 🌐 before continuing if you need more context about the cities in this itinerary.',
    unsureExamples:'For example:',
    unsureItems:['🏨 Best area to stay','🧳 Seasonal context and packing','🚇 Transportation','🍽️ Local cuisine','📸 Photography spots','🧭 Local context','💰 Budget recommendations'],
    placeholder:'Write your preferences, restrictions or special conditions here…',
    close:'Close'
  };

  const row=document.createElement('div');
  row.id='itbmo-preferences-help-row';
  row.className='preferences-help-row';

  const buildHelp=(type,title,subtitle,bodyHtml)=>{
    const item=document.createElement('div');
    item.className='preferences-help-item';

    const btn=document.createElement('button');
    btn.type='button';
    btn.className=`preferences-help-button preferences-help-button--${type}`;
    btn.setAttribute('aria-expanded','false');
    btn.innerHTML=subtitle
      ? `<span class="preferences-help-button__title">${title}</span><span class="preferences-help-button__subtitle">${subtitle}</span>`
      : `<span class="preferences-help-button__title">${title}</span>`;

    const pop=document.createElement('div');
    pop.className='preferences-help-popover';
    pop.setAttribute('aria-hidden','true');
    pop.innerHTML=`
      <button type="button" class="preferences-help-popover__close" aria-label="${c.close}">×</button>
      <div class="preferences-help-popover__body">${bodyHtml}</div>
    `;

    btn.addEventListener('click',(e)=>{
      e.preventDefault();
      e.stopPropagation();
      const wasOpen=pop.classList.contains('is-open');
      closePreferencesHelpPopovers();
      if(!wasOpen){
        pop.classList.add('is-open');
        pop.setAttribute('aria-hidden','false');
        btn.setAttribute('aria-expanded','true');
      }
    });

    pop.querySelector('.preferences-help-popover__close')?.addEventListener('click',(e)=>{
      e.preventDefault();
      e.stopPropagation();
      closePreferencesHelpPopovers();
    });

    pop.addEventListener('click',(e)=>e.stopPropagation());

    item.append(btn,pop);
    return item;
  };

  const guideBody=`
    <div class="preferences-help-list">
      ${c.guideItems.map(x=>`<p>${x}</p>`).join('')}
    </div>
    <div class="preferences-help-final">${c.guideFinal}</div>
  `;

  const unsureBody=`
    <p class="preferences-help-intro">${c.unsureIntro}</p>
    <strong class="preferences-help-examples">${c.unsureExamples}</strong>
    <div class="preferences-help-list preferences-help-list--compact">
      ${c.unsureItems.map(x=>`<p>${x}</p>`).join('')}
    </div>
  `;

  row.append(
    buildHelp('guide',c.guideTitle,c.guideSubtitle,guideBody),
    buildHelp('unsure',c.unsureTitle,'',unsureBody)
  );

  field.parentNode?.insertBefore(row,field);
  field.placeholder=c.placeholder;

  field.addEventListener('input',autoGrowPreferencesField);
  field.addEventListener('click',closePreferencesHelpPopovers);
  field.addEventListener('focus',closePreferencesHelpPopovers);

  document.addEventListener('click',(e)=>{
    if(!e.target.closest('#itbmo-preferences-help-row')) closePreferencesHelpPopovers();
  });

  autoGrowPreferencesField();
}

// Inicialización
document.addEventListener('DOMContentLoaded', ()=>{
  if(!document.querySelector('#city-list .city-row')) addCityRow();

  bindAccountListeners();
  restoreITBMOSession();

  setInfoChatEntitlement({authorized:false,remaining:0,used:0,tripId:null});
  bindInfoChatListeners();
  bindPlannerLanguageCapability();
  enhancePreferencesInfoChatCopy();
  hidePreferencesStage({reset:true});

  bindTravelersListeners();

  renumberTravelerProfiles();
  setTravelerButtonsState();

  bindExportListeners();
});
