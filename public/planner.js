/* =========================================================
   ITBMO PLANNER · Premium Journey Experience — Clean Baseline

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

/* ---------- Analytics bridge: Planner (Vercel) -> Webflow -> GTM/GA4 ----------
   Sends only allow-listed, non-personal operational data. */
const ITBMO_ANALYTICS_EVENT_NAMES = new Set([
  'planner_started','destinations_saved','checkout_opened','payment_approved',
  'payment_cancelled','payment_failed','itinerary_generated','export_pdf',
  'export_csv','export_receipt','info_chat_question','affiliate_click',
  'new_planning_started','start_chat','promo_code_applied','promo_code_consumed'
]);

function trackITBMOEvent(eventName, parameters={}){
  try{
    const name=String(eventName || '').trim();
    if(!ITBMO_ANALYTICS_EVENT_NAMES.has(name)) return;
    if(window.ITBMOFoundation?.track){
      window.ITBMOFoundation.track(name,parameters);
      return;
    }
    const allowedKeys=new Set([
      'language','city_count','days_total','payment_provider','currency',
      'generation_mode','partner','partner_name','placement','destination',
      'queries_used','queries_remaining','file_type','error_stage',
      'promotion_code','promo_type','discount_amount'
    ]);
    const clean={};
    Object.entries(parameters || {}).forEach(([key,value])=>{
      if(!allowedKeys.has(key) || value===undefined || value===null) return;
      if(typeof value==='number' && Number.isFinite(value)) clean[key]=value;
      else if(typeof value==='boolean') clean[key]=value;
      else clean[key]=String(value).slice(0,100);
    });
    if(!clean.language) clean.language=getLang?.() || document.documentElement.lang || 'en';
    const payload={type:'ITBMO_ANALYTICS_EVENT',event_name:name,parameters:clean};
    if(window.top && window.top!==window) window.top.postMessage(payload,'*');
    else{
      window.dataLayer=window.dataLayer || [];
      window.dataLayer.push({event:'itbmo_event',itbmo_event_name:name,...clean});
    }
  }catch(_){ }
}

let itbmoPlannerStartTracked=false;
let itbmoPlanningChatStarted=false;
document.addEventListener('input',(event)=>{
  if(itbmoPlannerStartTracked || !event.target?.closest?.('#planner-sidebar, .sidebar')) return;
  itbmoPlannerStartTracked=true;
  trackITBMOEvent('planner_started');
},{capture:true,passive:true});

/* ---------- Config API ---------- */
const API_URL = '/api/chat';
const USER_API_URL = '/api/user';
const TRIP_API_URL = '/api/trip';
const PAYMENT_API_URL = '/api/payment';
const MODEL   = 'gpt-4o-mini';

trackITBMOEvent('planner_open');

const ITBMO_SESSION_KEY = 'itbmo_session_token';
const ITBMO_GUEST_SESSION_KEY = 'itbmo_guest_session_token';
const ITBMO_ACTIVE_TRIP_KEY = 'itbmo_active_trip_id';
const ITBMO_USER_CACHE_KEY = 'itbmo_user_cache_v1';
const ITBMO_AUTH_SYNC_KEY = 'itbmo_auth_sync_v1';
const ITBMO_AUTH_OWNER_KEY = 'itbmo_auth_owner_v1';
const ITBMO_PLANNER_PRESENCE_KEY = 'itbmo_planner_presence_v1'; // legacy telemetry; retained for backward compatibility
const ITBMO_SURFACE_PRESENCE_KEY = 'itbmo_surface_presence_v2';
const ITBMO_PLANNER_TAB_ID_KEY = 'itbmo_planner_tab_id_v2';
const ITBMO_PLANNER_TAB_ESTABLISHED_KEY = 'itbmo_planner_tab_established_v2';
const ITBMO_SURFACE_PRESENCE_TTL_MS = 10000;
const ITBMO_PLANNER_HEARTBEAT_MS = 2000;
const ITBMO_WORKSPACE_GUEST_HANDOFF_KEY = 'itbmo_workspace_guest_handoff_v1';
const ITBMO_WORKSPACE_OPEN_HANDOFF_KEY = 'itbmo_workspace_open_handoff_v1';
const ITBMO_PLANNER_OPEN_HANDOFF_KEY = 'itbmo_planner_open_handoff_v1';
const ITBMO_TERMS_VERSION = '1.0';
const ITBMO_PRIVACY_VERSION = '1.0';
const ITBMO_MARKETING_VERSION = '1.0';

let currentUser = null;
let currentTripId = null;
let authReady = false;
let guestUpgradeFormOpen = false;
let pendingVerificationTimer = null;
let plannerPresenceTimer = null;
let plannerPresenceId = '';

let savedDestinations = [];      // [{ city, country, days, baseDate, perDay:[{day,start,end}] }]

let itineraries = {};            // { [city]: { byDay, currentDay, baseDate, originalDays, masterPlan, audit } }
let cityMeta = {};               // { [city]: { baseDate, start, end, hotel, transport, perDay:[] } }

let session = [];                // historial para el agente principal
let infoSession = [];            // historial separado para Info Chat
let activeCity = null;

const ITBMO_INFO_CHAT_STATE_KEY_PREFIX = 'itbmo_info_chat_state_v1_';
const ITBMO_POST_PAYMENT_STATE_KEY_PREFIX = 'itbmo_post_payment_state_v1_';

let planningStarted = false;
let metaProgressIndex = 0;
let collectingHotels = false;
let isItineraryLocked = false;

let pendingChange = null;
let hasSavedOnce = false;
let saveLockWarningAccepted = false;
let paymentWarningAcceptedTripId = null;

/* Paid-generation recovery. Normal successful generations add only small
   checkpoint writes; retries run only after a real technical failure. */
const ITBMO_CITY_GENERATION_MAX_ATTEMPTS = 2;
const ITBMO_CITY_RETRY_DELAYS_MS = [0,5000];
const ITBMO_STAY_GENERATION_MAX_ATTEMPTS = 3;
const ITBMO_STAY_LOCAL_REPAIR_MAX_ATTEMPTS = 4;
let paidGenerationRunning = false;
let generationRecoveryState = null;
let generationResetInProgress = false;
let generationResetRequestedFromRecovery = false;
let generationRunEpoch = 0;

function _generationCancelledError_(){
  const error=new Error('GENERATION_CANCELLED_BY_RESET');
  error.code='GENERATION_CANCELLED_BY_RESET';
  return error;
}
function _assertGenerationRunActive_(epoch){
  if(generationResetInProgress || Number(epoch)!==Number(generationRunEpoch)) throw _generationCancelledError_();
}

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
const MAX_ITINERARY_CITIES = 1; // V2.7 compatibility shell: one continuous Trip Story
const MAX_TRIP_STORY_DAYS = 30;
const MAX_DAYS_PER_DESTINATION = 30; // Trip Story compatibility shell may span the full continuous journey

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
  travelModelV2: null,
  preferencesV2: null,
  lang: 'en' // se setea abajo
};


function _travelV2(){ return window.ITBMOTravelV2 || null; }
function _currentTravelModelV2_(){
  const engine=_travelV2();
  if(!engine || !$cityList) return plannerState?.travelModelV2 || null;
  const rows=qsa('.city-row',$cityList);
  const model=engine.collect(rows);
  if(plannerState) plannerState.travelModelV2=model;
  return model;
}
function _renumberDestinationCards_(){
  if(!$cityList) return;
  qsa('.city-row',$cityList).forEach((row,index)=>{
    const n=qs('.city-card-kicker span',row); if(n) n.textContent=String(index+1).padStart(2,'0');
  });
}
function reorderDestinationRowsByDate({animate=true}={}){
  if(!$cityList) return;
  const rows=qsa('.city-row',$cityList);
  const ordered=[...rows].sort((a,b)=>{
    const da=parsePlannerDate(qs('.baseDate',a)?.value||'');
    const db=parsePlannerDate(qs('.baseDate',b)?.value||'');
    if(!da&&!db) return rows.indexOf(a)-rows.indexOf(b);
    if(!da) return 1; if(!db) return -1;
    return da-db || rows.indexOf(a)-rows.indexOf(b);
  });
  const changed=ordered.some((row,i)=>row!==rows[i]);
  if(!changed) return false;
  ordered.forEach(row=>$cityList.appendChild(row));
  _renumberDestinationCards_();
  if(animate){ ordered.forEach(row=>{row.classList.remove('route-v2-reordered');requestAnimationFrame(()=>row.classList.add('route-v2-reordered'));setTimeout(()=>row.classList.remove('route-v2-reordered'),650);}); }
  return true;
}
function _routeV2ContextForCity_(city){
  const engine=_travelV2();
  const dest=savedDestinations.find(x=>x.city===city);
  if(!engine||!dest) return null;
  const model=plannerState?.travelModelV2 || _currentTravelModelV2_();
  try{return engine.compileForDestination(dest,model);}catch(err){console.warn('[TRAVEL MODEL V2 COMPILE]',err);return null;}
}
function _routeV2PlacePreference_(place){
  const prefs=plannerState?.preferencesV2?.places || _travelV2()?.state?.preferences?.places || {};
  return prefs[String(place||'').trim().toLowerCase()] || null;
}

(function initPlannerLang(){
  const normalize = (v)=>{
    const s = String(v || '').trim().toLowerCase();
    if(!s) return '';
    const base = s.split(/[-_]/)[0];
    return (base === 'es' || base === 'en') ? base : '';
  };

  // 1) Explicit URL language is authoritative. This is especially important
  // after account recovery, where Supabase returns to planner.html?lang=es|en.
  let lang = '';
  try{ lang = normalize(new URLSearchParams(window.location.search).get('lang')); }catch(_){}

  // 2) Fall back to the document language when no explicit URL language exists.
  if(!lang) lang = normalize(document?.documentElement?.getAttribute('lang'));

  // 3) Localized route fallback.
  if(!lang){
    try{
      const p = String(window?.location?.pathname || '').toLowerCase();
      if(/^\/es(\/|$)/.test(p)) lang = 'es';
      else if(/^\/en(\/|$)/.test(p)) lang = 'en';
    }catch(_){}
  }

  // 4) Default MVP
  if(!lang) lang = 'en';

  plannerState.lang = lang;
})();

const I18N = {
  es: {
    hi: '¡Hola! Soy tu asistente de viaje de ITBMO ✨. Vamos a crear un itinerario inolvidable 🌍',
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
    thinking: 'ITBMO está preparando la respuesta…',

    // UI / Sidebar cities
    uiCity: 'Destino',
    uiCountry: 'País',
    uiDays: 'Días',
    uiStart: 'Primer día',
    uiDateFormatSmall: 'Selecciona una fecha válida',
    uiTimeHint: '⏰ Indica tu tiempo útil en el destino. Si aún no conoces los horarios, puedes omitirlos: ITBMO propondrá horas razonables de inicio y final.',
    uiStartTime: 'Hora Inicio',
    uiEndTime: 'Hora Final',
    uiSameSchedule: 'Copiar el horario del Día 1 en todos los días',
    uiTripRange: (start,end,days)=>`${start}–${end} · ${days} ${days===1?'día':'días'}`,
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
    overlayDefault: '✨ ITBMO está creando tu itinerario — ciudad por ciudad, día por día.\n⏳ TIEMPO ESTIMADO DE GENERACIÓN\n1 ciudad: 4–5 min  ·  2 ciudades: 8–10 min  ·  3 ciudades: 12–15 min\n🔎 ¿Por qué toma tiempo? ITBMO investiga y compara rutas, horarios, traslados, prioridades, tus preferencias y la coherencia del viaje completo para convertir horas de investigación en un plan listo para explorar.\n⚠️ MANTÉN ESTA PESTAÑA ABIERTA hasta que tu itinerario esté listo.',
    overlayGenerating: '✨ ITBMO está creando tu itinerario — ciudad por ciudad, día por día.\n⏳ TIEMPO ESTIMADO DE GENERACIÓN\n1 ciudad: 4–5 min  ·  2 ciudades: 8–10 min  ·  3 ciudades: 12–15 min\n🔎 ¿Por qué toma tiempo? ITBMO investiga y compara rutas, horarios, traslados, prioridades, tus preferencias y la coherencia del viaje completo para convertir horas de investigación en un plan listo para explorar.\n⚠️ MANTÉN ESTA PESTAÑA ABIERTA hasta que tu itinerario esté listo.',
    overlayRebalancingCity: 'ITBMO está reequilibrando la ciudad…',
    overlayRebalancing: 'Agregando días y reoptimizando…',

    // Tooltip fechas
    tooltipDateMissing: 'Selecciona una fecha futura válida para cada ciudad 🗓️',

    // Reset modal
    resetTitle: '¿Reiniciar planificación? 🧭',
    resetBody: 'Esto eliminará todos los destinos, preferencias, datos de planificación e itinerarios actuales.<br><br><strong>Antes de continuar, asegúrate de haber descargado tu itinerario, Excel y comprobante de pago.</strong><br><br>Si reinicias, tendrás que comenzar un nuevo viaje y <strong>realizar un nuevo pago para volver a generar un itinerario</strong>.<br><br><strong>Esta acción no se puede deshacer.</strong>',
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
    hi: 'Hi! I’m ITBMO’s travel assistant ✨. Let’s build an unforgettable itinerary 🌍',
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
    thinking: 'ITBMO is preparing the answer…',

    // UI / Sidebar cities
    uiCity: 'Destination',
    uiCountry: 'Country',
    uiDays: 'Days',
    uiStart: 'First day',
    uiDateFormatSmall: 'Choose a valid date',
    uiTimeHint: '⏰ Enter your usable time at the destination. If you do not know the times yet, you may leave them blank and ITBMO will suggest reasonable start and end times.',
    uiStartTime: 'Start time',
    uiEndTime: 'End time',
    uiSameSchedule: 'Copy the Day 1 schedule to every day',
    uiTripRange: (start,end,days)=>`${start}–${end} · ${days} ${days===1?'day':'days'}`,
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
    overlayDefault: '✨ ITBMO is creating your itinerary — city by city, day by day.\n⏳ ESTIMATED GENERATION TIME\n1 city: 4–5 min  ·  2 cities: 8–10 min  ·  3 cities: 12–15 min\n🔎 Why does it take time? ITBMO researches and compares routes, timing, transfers, priorities, your preferences and full-trip coherence to turn hours of research into a trip plan ready to explore.\n⚠️ KEEP THIS TAB OPEN until your itinerary is ready.',
    overlayGenerating: '✨ ITBMO is creating your itinerary — city by city, day by day.\n⏳ ESTIMATED GENERATION TIME\n1 city: 4–5 min  ·  2 cities: 8–10 min  ·  3 cities: 12–15 min\n🔎 Why does it take time? ITBMO researches and compares routes, timing, transfers, priorities, your preferences and full-trip coherence to turn hours of research into a trip plan ready to explore.\n⚠️ KEEP THIS TAB OPEN until your itinerary is ready.',
    overlayRebalancingCity: 'ITBMO is rebalancing the city…',
    overlayRebalancing: 'Adding days and re-optimizing…',

    // Tooltip fechas
    tooltipDateMissing: 'Choose a valid future date for every city 🗓️',

    // Reset modal
    resetTitle: 'Reset planning? 🧭',
    resetBody: 'This will delete all current destinations, preferences, planning data, and itineraries.<br><br><strong>Before continuing, make sure you have downloaded your itinerary, Excel file, and payment receipt.</strong><br><br>If you reset, you will need to start a new trip and <strong>make a new payment to generate another itinerary</strong>.<br><br><strong>This action cannot be undone.</strong>',
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
function plannerHomeUrl(lang=getLang()){
  return lang === 'en' ? './preview-home-en.html' : './preview-home.html';
}
function syncPlannerLanguageShell(){
  const lang=getLang();
  document.documentElement.lang=lang;
  try{ localStorage.setItem('itbmo_site_language',lang); }catch(_){ }
  const homeLink=qs('.planner-home-link');
  if(homeLink){
    homeLink.href=plannerHomeUrl(lang);
    homeLink.setAttribute('aria-label',lang==='es'?'Volver a I Travel By My Own':'Back to I Travel By My Own');
    const label=homeLink.querySelector('.planner-home-link__label');
    if(label) label.textContent=lang==='es'?'Inicio':'Home';
  }
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
const $preferencesGenerateV2 = qs('#generate-itineraries-v2');

/* ---------- ITBMO Account / Supabase ---------- */
const $accountGuest = qs('#account-guest');
const $accountAuthenticated = qs('#account-authenticated');
const $accountRegisterToggle = qs('#account-register-toggle');
const $accountLoginToggle = qs('#account-login-toggle');
const $accountGuestToggle = qs('#account-guest-toggle');
const $accountRegisterPanel = qs('#account-register-panel');
const $accountLoginPanel = qs('#account-login-panel');
const $accountGuestPanel = qs('#account-guest-panel');
const $accountForgotPanel = qs('#account-forgot-panel');
const $accountResetPanel = qs('#account-reset-panel');
const $accountRegisterSubmit = qs('#account-register-submit');
const $accountLoginSubmit = qs('#account-login-submit');
const $accountGuestSubmit = qs('#account-guest-submit');
const $accountForgotPassword = qs('#account-forgot-password');
const $accountForgotSubmit = qs('#account-forgot-submit');
const $accountForgotBack = qs('#account-forgot-back');
const $accountResetSubmit = qs('#account-reset-submit');
const $accountMessage = qs('#account-message');
const $accountSubtitle = qs('#account-subtitle');
const $accountUserBadge = qs('#account-user-badge');
const $accountWelcome = qs('#account-welcome');
const $accountReadyCopy = qs('#account-ready-copy');

const $accountFirstName = qs('#account-first-name');
const $accountEmail = qs('#account-email');
const $accountPassword = qs('#account-password');
const $accountPasswordConfirm = qs('#account-password-confirm');
const $accountLegalConsent = qs('#account-legal-consent');
const $accountMarketingConsent = qs('#account-marketing-consent');
const $accountLoginEmail = qs('#account-login-email');
const $accountLoginPassword = qs('#account-login-password');
const $accountGuestName = qs('#account-guest-name');
const $accountGuestEmail = qs('#account-guest-email');
const $accountGuestLegalConsent = qs('#account-guest-legal-consent');
const $accountModeActions = qs('#account-mode-actions');
const $accountUpgradeToggle = qs('#account-upgrade-toggle');
const $accountUpgradeCancel = qs('#account-upgrade-cancel');
const $accountGuestUpgrade = qs('#account-guest-upgrade');
const $accountGuestUpgradeCopy = qs('#account-guest-upgrade-copy');
const $accountGuestUpgradeTitle = qs('#account-guest-upgrade-title');
const $accountUpgradeEmailHint = qs('#account-upgrade-email-hint');
const $accountLogout = qs('#account-logout');
const $accountDialogClose = qs('#account-dialog-close');
const $accountModalBackdrop = qs('#account-modal-backdrop');
const $topbarAccountRegister = qs('#topbar-account-register');
const $topbarAccountLogin = qs('#topbar-account-login');
const $topbarAccountGuest = qs('#topbar-account-guest');
const $topbarAccountLogout = qs('#topbar-account-logout');
const $accountForgotEmail = qs('#account-forgot-email');
const $accountResetPassword = qs('#account-reset-password');
const $accountResetPasswordConfirm = qs('#account-reset-password-confirm');

const $travelerMode      = qs('#traveler-mode');
const $travelerSoloPanel = qs('#traveler-solo-panel');
const $travelerGroupPanel= qs('#traveler-group-panel');

const $soloGender   = qs('#solo-gender');
const $soloAgeRange = qs('#solo-age-range');

const $travelerProfiles = qs('#traveler-profiles');
const $travelerAdd      = qs('#traveler-add');
const $travelerRemove   = qs('#traveler-remove');

/* =========================================================
   ITBMO ACCOUNT — Supabase Auth + invitado + sesión ITBMO
   - Cuenta: nombre + email + contraseña.
   - Invitado: nombre + email.
   - Backend real: /api/user.
   - Trips/pagos siguen usando el session_token ITBMO existente.
========================================================= */
const AUTH_COPY = {
  es: {
    title:'Tu cuenta ITBMO', subtitle:'Crea una cuenta, inicia sesión o continúa como invitado.',
    subtitleGuest:'Estás usando ITBMO como invitado.', subtitlePending:'Confirma tu correo para activar tu cuenta.', subtitleRegistered:'Tu cuenta está activa.',
    register:'Crear cuenta', login:'Iniciar sesión', guest:'Continuar como invitado',
    name:'Nombre', email:'Email', password:'Contraseña', passwordConfirm:'Confirmar contraseña',
    create:'Crear cuenta', signIn:'Iniciar sesión', forgot:'¿Olvidaste tu contraseña?',
    guestContinue:'Continuar como invitado', forgotTitle:'Restablecer contraseña', sendReset:'Enviar enlace de recuperación',
    backToLogin:'Volver a iniciar sesión', newPassword:'Nueva contraseña', newPasswordConfirm:'Confirmar nueva contraseña', updatePassword:'Actualizar contraseña',
    legalPrefix:'Acepto los ', terms:'Términos de Uso', legalMiddle:' y reconozco la ', privacy:'Política de Privacidad', legalSuffix:'.',
    marketing:'Quiero recibir inspiración de viaje, recomendaciones y ofertas especiales de ITBMO.',
    welcome:(name)=>`Hola, ${name} 👋`,
    readyRegistered:'Tu cuenta está activa en este dispositivo. Continúa planificando normalmente.',
    readyGuest:'Estás usando ITBMO como invitado en este dispositivo. Puedes continuar planificando normalmente.',
    readyPending:'Tu cuenta está pendiente de confirmación. Revisa el correo que te enviamos. El Planner se desbloqueará automáticamente cuando confirmes tu correo.',
    upgradeTitle:'¿Quieres acceder desde otro dispositivo?', upgradeCopy:'Crea una cuenta para acceder a tu planificación desde otros dispositivos durante el período disponible.',
    upgradeAction:'Crear cuenta', upgradeCancel:'Cancelar', logout:'Cerrar sesión', upgradeEmailHint:'Puedes mantener el correo usado como invitado o usar otro correo para tu cuenta.', passwordHint:'Mínimo 8 caracteres, incluyendo mayúscula, minúscula y un número.',
    registering:'Creando tu cuenta…', signingIn:'Iniciando sesión…', guestStarting:'Preparando tu sesión…', sendingReset:'Enviando enlace…', resetting:'Actualizando contraseña…', confirming:'Confirmando tu cuenta…',
    required:'Completa todos los campos obligatorios.', legalRequired:'Debes aceptar los Términos de Uso y la Política de Privacidad.',
    emailInvalid:'Ingresa un email válido.', passwordRule:'La contraseña debe tener al menos 8 caracteres e incluir mayúscula, minúscula y número.', passwordMismatch:'Las contraseñas no coinciden.',
    duplicateEmail:'Ese email ya está registrado. Usa “Iniciar sesión”.', registerFail:'No pudimos crear tu cuenta. Intenta nuevamente.',
    confirmationSent:'Cuenta creada. Revisa tu email y confirma tu correo para iniciar sesión.', loginFail:'Email o contraseña incorrectos, o el correo aún no ha sido confirmado.',
    guestFail:'No pudimos iniciar la sesión de invitado. Intenta nuevamente.', guestMismatch:'El nombre y el correo no coinciden con el invitado registrado anteriormente.', guestHasAccount:'Ese correo ya tiene una cuenta. Usa “Iniciar sesión”.', connectionFail:'No se pudo conectar con ITBMO. Intenta nuevamente.',
    resetSent:'Si existe una cuenta con ese email, recibirás un enlace para restablecer tu contraseña.', resetFail:'No pudimos procesar la recuperación. Intenta nuevamente.',
    passwordUpdated:'Contraseña actualizada. Ya puedes iniciar sesión.', confirmationComplete:'Correo confirmado. Tu cuenta ya está activa.', confirmationFail:'No pudimos completar la confirmación. Intenta iniciar sesión.',
    loginRequired:'Crea una cuenta, inicia sesión o continúa como invitado antes de guardar destinos.', travelerRequired:'Indica con quién viajas antes de guardar destinos.', companionRequired:'Indica género y rango de edad de cada acompañante.',
    tripSaving:'Guardando tu viaje…', tripFail:'No pudimos guardar el viaje. Tus datos no se perdieron; intenta nuevamente.'
  },
  en: {
    title:'Your ITBMO account', subtitle:'Create an account, sign in, or continue as a guest.',
    subtitleGuest:'You are using ITBMO as a guest.', subtitlePending:'Confirm your email to activate your account.', subtitleRegistered:'Your account is active.',
    register:'Create account', login:'Sign in', guest:'Continue as guest',
    name:'Name', email:'Email', password:'Password', passwordConfirm:'Confirm password',
    create:'Create account', signIn:'Sign in', forgot:'Forgot your password?',
    guestContinue:'Continue as guest', forgotTitle:'Reset password', sendReset:'Send reset link',
    backToLogin:'Back to sign in', newPassword:'New password', newPasswordConfirm:'Confirm new password', updatePassword:'Update password',
    legalPrefix:'I agree to the ', terms:'Terms of Use', legalMiddle:' and acknowledge the ', privacy:'Privacy Policy', legalSuffix:'.',
    marketing:'Send me travel inspiration, recommendations and special offers from ITBMO.',
    welcome:(name)=>`Hi, ${name} 👋`,
    readyRegistered:'Your account is active on this device. Continue planning normally.',
    readyGuest:'You are using ITBMO as a guest on this device. You can continue planning normally.',
    readyPending:'Your account is awaiting confirmation. Check the email we sent you. The Planner will unlock automatically once your email is confirmed.',
    upgradeTitle:'Want access from another device?', upgradeCopy:'Create an account to access your planning from other devices during the available recovery period.',
    upgradeAction:'Create account', upgradeCancel:'Cancel', logout:'Sign out', upgradeEmailHint:'You may keep the email used as a guest or use a different email for your account.', passwordHint:'Minimum 8 characters, including uppercase, lowercase and a number.',
    registering:'Creating your account…', signingIn:'Signing in…', guestStarting:'Preparing your session…', sendingReset:'Sending reset link…', resetting:'Updating password…', confirming:'Confirming your account…',
    required:'Complete all required fields.', legalRequired:'You must accept the Terms of Use and Privacy Policy.',
    emailInvalid:'Enter a valid email.', passwordRule:'Password must be at least 8 characters and include an uppercase letter, lowercase letter and number.', passwordMismatch:'Passwords do not match.',
    duplicateEmail:'That email is already registered. Use “Sign in”.', registerFail:'We could not create your account. Please try again.',
    confirmationSent:'Account created. Check your email and confirm your address before signing in.', loginFail:'Incorrect email or password, or the email has not been confirmed yet.',
    guestFail:'We could not start the guest session. Please try again.', guestMismatch:'The name and email do not match the guest previously registered.', guestHasAccount:'That email already has an account. Use “Sign in”.', connectionFail:'Could not connect to ITBMO. Please try again.',
    resetSent:'If an account exists for that email, you will receive a password reset link.', resetFail:'We could not process password recovery. Please try again.',
    passwordUpdated:'Password updated. You can now sign in.', confirmationComplete:'Email confirmed. Your account is now active.', confirmationFail:'We could not complete confirmation. Please try signing in.',
    loginRequired:'Create an account, sign in, or continue as a guest before saving destinations.', travelerRequired:'Tell us who you are traveling with before saving destinations.', companionRequired:'Select gender and age range for every companion.',
    tripSaving:'Saving your trip…', tripFail:'We could not save the trip. Your entries are still here; please try again.'
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

/* ITBMO shared surface session lifecycle.
   A registered session remains valid while at least one Planner/Workspace surface
   from the same browser session is alive. Closing every ITBMO surface ends the
   browser session; refresh does not. Trip/checkpoint persistence is independent. */
function readSurfacePresence(){
  try{
    const raw=JSON.parse(localStorage.getItem(ITBMO_SURFACE_PRESENCE_KEY) || '{}');
    return raw && typeof raw==='object' && !Array.isArray(raw) ? raw : {};
  }catch(_){ return {}; }
}
function writeSurfacePresence(presence){
  try{ localStorage.setItem(ITBMO_SURFACE_PRESENCE_KEY,JSON.stringify(presence || {})); }catch(_){ }
}
function pruneSurfacePresence(presence=readSurfacePresence(),now=Date.now()){
  const next={};
  Object.entries(presence||{}).forEach(([id,entry])=>{
    const ts=Number(entry?.ts||entry||0);
    if(id && ts>0 && now-ts<=ITBMO_SURFACE_PRESENCE_TTL_MS){
      next[id]=typeof entry==='object' ? {...entry,ts} : {type:'unknown',ts};
    }
  });
  return next;
}
function hasLiveITBMOSurface(){ return Object.keys(pruneSurfacePresence()).length>0; }
function plannerTabId(){
  if(plannerPresenceId) return plannerPresenceId;
  try{ plannerPresenceId=String(sessionStorage.getItem(ITBMO_PLANNER_TAB_ID_KEY)||'').trim(); }catch(_){ }
  if(!plannerPresenceId){
    plannerPresenceId=(globalThis.crypto?.randomUUID?.() || `planner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try{ sessionStorage.setItem(ITBMO_PLANNER_TAB_ID_KEY,plannerPresenceId); }catch(_){ }
  }
  return plannerPresenceId;
}
function markPlannerPresence(){
  const presence=pruneSurfacePresence();
  presence[plannerTabId()]={type:'planner',ts:Date.now()};
  writeSurfacePresence(presence);
}
function removePlannerPresence(){
  const id=plannerPresenceId || (()=>{try{return String(sessionStorage.getItem(ITBMO_PLANNER_TAB_ID_KEY)||'').trim();}catch(_){return '';}})();
  if(!id) return;
  const presence=pruneSurfacePresence(); delete presence[id]; writeSurfacePresence(presence);
}
function startPlannerPresenceHeartbeat(){
  markPlannerPresence();
  if(plannerPresenceTimer) clearInterval(plannerPresenceTimer);
  plannerPresenceTimer=setInterval(markPlannerPresence,ITBMO_PLANNER_HEARTBEAT_MS);
}
function initializePlannerSessionLifecycle(){
  let established=false;
  try{ established=sessionStorage.getItem(ITBMO_PLANNER_TAB_ESTABLISHED_KEY)==='1'; }catch(_){ }

  /* A new surface with no other live ITBMO surface means the previous browser
     session ended when its last window closed. A reload keeps sessionStorage,
     so it never trips this rule. */
  let openedFromLiveWorkspace=false;
  try{
    const raw=localStorage.getItem(ITBMO_PLANNER_OPEN_HANDOFF_KEY);
    if(raw){
      localStorage.removeItem(ITBMO_PLANNER_OPEN_HANDOFF_KEY);
      const handoff=JSON.parse(raw);
      openedFromLiveWorkspace=Number(handoff?.expires_at||0)>Date.now();
    }
  }catch(_){}
  if(!established && !openedFromLiveWorkspace && !hasLiveITBMOSurface()){
    const hadRegisteredSession=(()=>{try{return Boolean(localStorage.getItem(ITBMO_SESSION_KEY));}catch(_){return false;}})();
    if(hadRegisteredSession) clearSessionToken({broadcast:true});
  }
  try{ sessionStorage.setItem(ITBMO_PLANNER_TAB_ESTABLISHED_KEY,'1'); }catch(_){ }
  startPlannerPresenceHeartbeat();

  window.addEventListener('pagehide',()=>{
    if(plannerPresenceTimer){ clearInterval(plannerPresenceTimer); plannerPresenceTimer=null; }
    removePlannerPresence();
  });
  window.addEventListener('pageshow',()=>startPlannerPresenceHeartbeat());
}

function getStoredSessionToken(){
  try{
    return String(sessionStorage.getItem(ITBMO_GUEST_SESSION_KEY) || localStorage.getItem(ITBMO_SESSION_KEY) || '').trim();
  }catch(_){ return ''; }
}
function getCachedUser(){
  try{
    const raw=sessionStorage.getItem(ITBMO_USER_CACHE_KEY) || localStorage.getItem(ITBMO_USER_CACHE_KEY) || '';
    const parsed=raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed==='object' && !Array.isArray(parsed) ? parsed : null;
  }catch(_){ return null; }
}
function storeCachedUser(user,persistent=true){
  if(!user || typeof user!=='object') return;
  try{
    const serialized=JSON.stringify(user);
    if(persistent){
      localStorage.setItem(ITBMO_USER_CACHE_KEY,serialized);
      sessionStorage.removeItem(ITBMO_USER_CACHE_KEY);
    }else{
      sessionStorage.setItem(ITBMO_USER_CACHE_KEY,serialized);
      localStorage.removeItem(ITBMO_USER_CACHE_KEY);
    }
  }catch(_){ }
}
function clearCachedUser(){
  try{ localStorage.removeItem(ITBMO_USER_CACHE_KEY); }catch(_){ }
  try{ sessionStorage.removeItem(ITBMO_USER_CACHE_KEY); }catch(_){ }
}
function broadcastAuthState(state){
  try{ localStorage.setItem(ITBMO_AUTH_SYNC_KEY,JSON.stringify({state:String(state||''),ts:Date.now()})); }catch(_){}
}
function storeSessionToken(token, persistent=true){
  try{
    if(!token) return;
    if(persistent){
      localStorage.setItem(ITBMO_SESSION_KEY, token);
      sessionStorage.removeItem(ITBMO_GUEST_SESSION_KEY);
    }else{
      sessionStorage.setItem(ITBMO_GUEST_SESSION_KEY, token);
      localStorage.removeItem(ITBMO_SESSION_KEY);
    }
    localStorage.setItem(ITBMO_AUTH_OWNER_KEY,'planner');
    broadcastAuthState('signed_in');
    setTimeout(()=>window.ITBMOFoundation?.syncAttribution?.(),0);
  }catch(_){}
}
function clearSessionToken({broadcast=true}={}){
  try{ localStorage.removeItem(ITBMO_SESSION_KEY); }catch(_){}
  try{ sessionStorage.removeItem(ITBMO_GUEST_SESSION_KEY); }catch(_){}
  try{ localStorage.removeItem(ITBMO_AUTH_OWNER_KEY); }catch(_){}
  clearCachedUser();
  if(broadcast) broadcastAuthState('signed_out');
}
function getStoredActiveTripId(){ try{ return String(localStorage.getItem(ITBMO_ACTIVE_TRIP_KEY) || '').trim(); }catch(_){ return ''; } }
function storeActiveTripId(tripId){ try{ if(tripId) localStorage.setItem(ITBMO_ACTIVE_TRIP_KEY,String(tripId)); else localStorage.removeItem(ITBMO_ACTIVE_TRIP_KEY); }catch(_){ } }

function validAccountEmail(email){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim()); }
function validAccountPassword(password){ return typeof password === 'string' && password.length >= 8 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password); }

function authTrackingPayload(){
  const params = new URLSearchParams(window.location.search);
  const attribution = window.ITBMOFoundation?.getAttribution?.() || {};
  const firstTouch = attribution.first_touch || {};
  const lastTouch = attribution.last_touch || firstTouch || {};
  return {
    preferred_language:getLang(), registration_source:'planner',
    utm_source:firstTouch.source || params.get('utm_source') || null,
    utm_medium:firstTouch.medium || params.get('utm_medium') || null,
    utm_campaign:firstTouch.campaign || params.get('utm_campaign') || null,
    utm_content:firstTouch.content || params.get('utm_content') || null,
    utm_term:firstTouch.term || params.get('utm_term') || null,
    referrer:firstTouch.referrer || document.referrer || null,
    attribution_id:attribution.attribution_id || null,
    first_touch:firstTouch,
    last_meaningful_touch:lastTouch,
    origin:window.location.origin
  };
}

function legalPayload(prefix='account'){
  const guest = prefix === 'guest';
  return {
    terms_accepted:true, privacy_accepted:true,
    marketing_consent:guest ? false : !!$accountMarketingConsent?.checked,
    terms_version:ITBMO_TERMS_VERSION, privacy_version:ITBMO_PRIVACY_VERSION, marketing_version:ITBMO_MARKETING_VERSION,
    terms_url:qs(guest ? '#account-guest-terms-link' : '#account-terms-link')?.href || null,
    privacy_url:qs(guest ? '#account-guest-privacy-link' : '#account-privacy-link')?.href || null
  };
}

function setAuthBusy(on){
  [$accountRegisterSubmit,$accountLoginSubmit,$accountGuestSubmit,$accountForgotSubmit,$accountResetSubmit,$accountRegisterToggle,$accountLoginToggle,$accountGuestToggle,$accountForgotPassword,$accountForgotBack,$accountUpgradeToggle,$accountUpgradeCancel,$accountLogout,$topbarAccountRegister,$topbarAccountLogin,$topbarAccountGuest,$topbarAccountLogout]
    .forEach(el=>{ if(el) el.disabled = !!on; });
}

function updateSaveAvailability(){
  if(!$save) return;
  const lockedForCurrentTrip = Boolean(hasSavedOnce || planningStarted);
  const authUsable = Boolean(currentUser && !currentUser.registration_pending);
  $save.disabled = !authUsable || lockedForCurrentTrip;
  $save.setAttribute('aria-disabled', String($save.disabled));
}

/* =========================================================
   AUTH GATE — additive safety layer only
   ---------------------------------------------------------
   The Planner must start locked until ITBMO has a valid user
   (registered account or guest session). This gate does NOT
   replace the Planner's existing saved-trip / generation locks.
   When auth is released, any existing setup lock remains intact.
   ========================================================= */
function ensureAuthPlannerGateStyles(){
  if(document.getElementById('itbmo-auth-gate-style')) return;
  const style=document.createElement('style');
  style.id='itbmo-auth-gate-style';
  style.textContent=`
    #travelers-box.itbmo-auth-locked,
    #destinations-box.itbmo-auth-locked,
    #preferences-stage.itbmo-auth-locked{
      opacity:.52;
      filter:saturate(.65);
      pointer-events:none;
      user-select:none;
    }
  `;
  document.head.appendChild(style);
}

function applyAuthPlannerGate(unlocked){
  ensureAuthPlannerGateStyles();
  const authLocked=!unlocked;

  ['#travelers-box','#destinations-box','#preferences-stage'].forEach(sel=>{
    const el=qs(sel);
    if(!el) return;
    el.classList.toggle('itbmo-auth-locked',authLocked);

    if(authLocked){
      try{ el.inert=true; }catch(_){}
      el.setAttribute('aria-disabled','true');
    }else{
      // Never undo the existing post-Save lock, but Destinations must stay
      // interactive because the Start CTA lives inside that section.
      const setupLocked=el.classList.contains('is-setup-locked');
      const keepContainerInteractive=(sel==='#destinations-box');
      try{ el.inert=keepContainerInteractive ? false : setupLocked; }catch(_){}
      el.setAttribute('aria-disabled',(setupLocked && !keepContainerInteractive)?'true':'false');
    }
  });

  // These controls already have their own Planner-state rules.
  // Auth can force them OFF, but never force them ON.
  if(authLocked){
    if($save){ $save.disabled=true; $save.setAttribute('aria-disabled','true'); }
    if($start){ $start.disabled=true; $start.setAttribute('aria-disabled','true'); }
    if($resetBtn){ $resetBtn.disabled=true; $resetBtn.setAttribute('aria-disabled','true'); }
  }else{
    updateSaveAvailability();
  }
}

function closeAccountDialog(){
  const box=qs('#account-box');
  if(box){ box.classList.remove('is-auth-dialog-open'); box.setAttribute('aria-hidden','true'); }
  if($accountModalBackdrop){ $accountModalBackdrop.hidden=true; $accountModalBackdrop.classList.remove('is-open'); }
  document.body.classList.remove('itbmo-auth-dialog-open');
}
function openAccountDialog(mode){
  const box=qs('#account-box');
  if(!box) return;
  if(mode) showAccountMode(mode);
  box.classList.add('is-auth-dialog-open');
  box.setAttribute('aria-hidden','false');
  if($accountModalBackdrop){ $accountModalBackdrop.hidden=false; requestAnimationFrame(()=>$accountModalBackdrop.classList.add('is-open')); }
  document.body.classList.add('itbmo-auth-dialog-open');
  const focusTarget=mode==='register'?$accountFirstName:mode==='login'?$accountLoginEmail:mode==='guest'?$accountGuestName:mode==='reset'?$accountResetPassword:null;
  setTimeout(()=>{ try{ focusTarget?.focus(); }catch(_){} },60);
}

function showAccountMode(mode){
  const logged=Boolean(currentUser && getStoredSessionToken());
  const guestCanUpgrade=logged && currentUser && !currentUser.is_registered;
  if(logged && !guestCanUpgrade) return;
  if(logged && guestCanUpgrade && mode !== 'register') return;

  const panels = { register:$accountRegisterPanel, login:$accountLoginPanel, guest:$accountGuestPanel, forgot:$accountForgotPanel, reset:$accountResetPanel };
  Object.entries(panels).forEach(([key,panel])=>{ if(panel) panel.style.display = key === mode ? 'block' : 'none'; });
  if(mode !== 'reset') setAccountMessage('');
}

function openGuestAccountUpgrade(){
  if(!currentUser || currentUser.is_registered) return;
  guestUpgradeFormOpen=true;
  if($accountFirstName) $accountFirstName.value=String(currentUser.first_name || '').trim();
  if($accountEmail){
    $accountEmail.value=String(currentUser.email || '').trim().toLowerCase();
    $accountEmail.readOnly=false;
  }
  if($accountUpgradeEmailHint) $accountUpgradeEmailHint.style.display='block';
  if($accountLegalConsent) $accountLegalConsent.checked=false;
  if($accountMarketingConsent) $accountMarketingConsent.checked=false;
  if($accountPassword) $accountPassword.value='';
  if($accountPasswordConfirm) $accountPasswordConfirm.value='';
  showAccountMode('register');
  renderAuthState();
  setTimeout(()=>{ try{$accountPassword?.focus();}catch(_){} },40);
}

function closeGuestAccountUpgrade(){
  guestUpgradeFormOpen=false;
  if($accountEmail) $accountEmail.readOnly=false;
  if($accountUpgradeEmailHint) $accountUpgradeEmailHint.style.display='none';
  if($accountPassword) $accountPassword.value='';
  if($accountPasswordConfirm) $accountPasswordConfirm.value='';
  setAccountMessage('');
  renderAuthState();
}

function stopPendingVerificationWatch(){
  if(pendingVerificationTimer){
    clearInterval(pendingVerificationTimer);
    pendingVerificationTimer=null;
  }
}

async function refreshPendingVerification(){
  if(!currentUser?.registration_pending) return;
  const token=getStoredSessionToken();
  if(!token) return;
  try{
    const {response,data}=await postUserAction({action:'session',session_token:token});
    if(response.ok && data?.ok && data?.user){
      currentUser=data.user;
      if(currentUser?.is_registered){
        storeSessionToken(token,true);
        stopPendingVerificationWatch();
        setAccountMessage(authCopy('confirmationComplete'),'success');
        renderAuthState();
        setTimeout(()=>restorePaidGenerationIfNeeded(),0);
      }
    }
  }catch(err){ console.warn('ITBMO confirmation watch unavailable:',err); }
}

function syncPendingVerificationWatch(pending){
  if(!pending){ stopPendingVerificationWatch(); return; }
  if(pendingVerificationTimer) return;
  pendingVerificationTimer=setInterval(refreshPendingVerification,6000);
}

function renderAuthState(){
  const sessionToken=getStoredSessionToken();
  const logged = Boolean(currentUser && sessionToken);
  if(logged){
    let persistent=false;
    try{ persistent=Boolean(localStorage.getItem(ITBMO_SESSION_KEY)); }catch(_){ }
    storeCachedUser(currentUser,persistent);
  }
  const registered = Boolean(logged && currentUser?.is_registered);
  const pending = Boolean(logged && currentUser?.registration_pending);
  const guest = Boolean(logged && !registered && !pending);

  if($accountGuest) $accountGuest.style.display = (!logged || (guest && guestUpgradeFormOpen)) ? 'block' : 'none';
  if($accountAuthenticated) $accountAuthenticated.style.display = logged ? 'flex' : 'none';
  if($accountModeActions) $accountModeActions.style.display = (guest && guestUpgradeFormOpen) ? 'none' : '';
  if($accountGuestToggle) $accountGuestToggle.style.display = (guest && guestUpgradeFormOpen) ? 'none' : '';
  if($accountUpgradeCancel) $accountUpgradeCancel.style.display = (guest && guestUpgradeFormOpen) ? 'block' : 'none';
  if($accountGuestUpgrade) $accountGuestUpgrade.style.display = (guest && !guestUpgradeFormOpen) ? 'flex' : 'none';
  if($accountLogout) $accountLogout.style.display = logged ? 'inline-flex' : 'none';
  const plannerMyTrips=qs('#planner-my-trips');
  if(plannerMyTrips) plannerMyTrips.hidden=!logged;
  if($topbarAccountRegister){
    $topbarAccountRegister.hidden=Boolean(logged && !guest);
    $topbarAccountRegister.textContent=authCopy('register');
  }
  if($topbarAccountLogin){ $topbarAccountLogin.hidden=logged; $topbarAccountLogin.textContent=authCopy('login'); }
  if($topbarAccountGuest){ $topbarAccountGuest.hidden=logged; $topbarAccountGuest.textContent=authCopy('guest'); }
  if($topbarAccountLogout){ $topbarAccountLogout.hidden=!logged; $topbarAccountLogout.textContent=getLang()==='es'?'Salir':'Sign out'; }

  if(!guestUpgradeFormOpen){
    if($accountEmail) $accountEmail.readOnly=false;
    if($accountUpgradeEmailHint) $accountUpgradeEmailHint.style.display='none';
  }

  if($accountUserBadge){
    $accountUserBadge.style.display = logged ? 'inline-flex' : 'none';
    let label='';
    if(logged && currentUser){
      label=currentUser.first_name || currentUser.username || (getLang()==='es'?'Cuenta activa':'Active account');
    }
    $accountUserBadge.textContent=label;
  }

  if($accountSubtitle){
    $accountSubtitle.textContent = !logged
      ? authCopy('subtitle')
      : authCopy(registered ? 'subtitleRegistered' : (pending ? 'subtitlePending' : 'subtitleGuest'));
  }

  if(logged && currentUser){
    if($accountWelcome) $accountWelcome.textContent = authCopy('welcome', currentUser.first_name || 'Traveler');
    if($accountReadyCopy) $accountReadyCopy.textContent = authCopy(registered ? 'readyRegistered' : (pending ? 'readyPending' : 'readyGuest'));
    if($accountGuestUpgradeTitle) $accountGuestUpgradeTitle.textContent = authCopy('upgradeTitle');
    if($accountGuestUpgradeCopy) $accountGuestUpgradeCopy.textContent = authCopy('upgradeCopy');
    if($accountUpgradeToggle) $accountUpgradeToggle.textContent = authCopy('upgradeAction');
    if($accountLogout) $accountLogout.textContent = authCopy('logout');
  }

  // Guest can plan normally. While the guest is actively creating an account,
  // or while email verification is pending, the Planner stays temporarily locked.
  applyAuthPlannerGate(Boolean(logged && !pending && !guestUpgradeFormOpen));
  syncPendingVerificationWatch(pending);
  updateSaveAvailability();
  if(logged && !pending) scheduleAstraCoach('travelers','#travelers-box',520);
}

function setLegalLanguage(containerSel, termsSel, privacySel){
  const legal=qs(containerSel), terms=qs(termsSel), privacy=qs(privacySel);
  if(!legal || !terms || !privacy) return;
  legal.innerHTML='';
  legal.appendChild(document.createTextNode(authCopy('legalPrefix'))); terms.textContent=authCopy('terms'); legal.appendChild(terms);
  legal.appendChild(document.createTextNode(authCopy('legalMiddle'))); privacy.textContent=authCopy('privacy'); legal.appendChild(privacy);
  legal.appendChild(document.createTextNode(authCopy('legalSuffix')));
}

function applyAuthLanguage(){
  const set=(sel,txt)=>{ const el=qs(sel); if(el) el.textContent=txt; };
  set('#account-title',authCopy('title')); set('#account-subtitle',authCopy('subtitle'));
  set('#account-register-toggle',authCopy('register')); set('#account-login-toggle',authCopy('login')); set('#account-guest-toggle',authCopy('guest'));
  set('#topbar-account-register',authCopy('register')); set('#topbar-account-login',authCopy('login')); set('#topbar-account-guest',authCopy('guest')); set('#topbar-account-logout',getLang()==='es'?'Salir':'Sign out');
  set('#label-first-name',authCopy('name')); set('#label-email',authCopy('email')); set('#label-password',authCopy('password')); set('#label-password-confirm',authCopy('passwordConfirm')); set('#password-hint',authCopy('passwordHint'));
  set('#label-login-email',authCopy('email')); set('#label-login-password',authCopy('password'));
  set('#label-guest-name',authCopy('name')); set('#label-guest-email',authCopy('email'));
  set('#label-forgot-email',authCopy('email')); set('#label-reset-password',authCopy('newPassword')); set('#label-reset-password-confirm',authCopy('newPasswordConfirm'));
  set('#account-register-submit',authCopy('create')); set('#account-login-submit',authCopy('signIn')); set('#account-guest-submit',authCopy('guestContinue'));
  set('#account-forgot-password',authCopy('forgot')); set('#account-forgot-submit',authCopy('sendReset')); set('#account-forgot-back',authCopy('backToLogin')); set('#account-reset-submit',authCopy('updatePassword'));
  set('#account-marketing-copy',authCopy('marketing')); set('#account-guest-upgrade-title',authCopy('upgradeTitle')); set('#account-guest-upgrade-copy',authCopy('upgradeCopy')); set('#account-upgrade-toggle',authCopy('upgradeAction')); set('#account-upgrade-cancel',authCopy('upgradeCancel')); set('#account-upgrade-email-hint',authCopy('upgradeEmailHint')); set('#account-logout',authCopy('logout'));
  setLegalLanguage('#account-legal-copy','#account-terms-link','#account-privacy-link');
  setLegalLanguage('#account-guest-legal-copy','#account-guest-terms-link','#account-guest-privacy-link');
  renderAuthState();
}

async function postUserAction(payload){
  const response = await fetch(USER_API_URL,{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  let data={}; try{ data=await response.json(); }catch(_){}
  return {response,data};
}

async function registerITBMOUser(){
  const name=String($accountFirstName?.value || '').trim();
  const email=String($accountEmail?.value || '').trim().toLowerCase();
  const password=String($accountPassword?.value || '');
  const passwordConfirmation=String($accountPasswordConfirm?.value || '');
  if(!name || !email || !password || !passwordConfirmation){ setAccountMessage(authCopy('required'),'error'); return; }
  if(!validAccountEmail(email)){ setAccountMessage(authCopy('emailInvalid'),'error'); return; }
  if(!validAccountPassword(password)){ setAccountMessage(authCopy('passwordRule'),'error'); return; }
  if(password !== passwordConfirmation){ setAccountMessage(authCopy('passwordMismatch'),'error'); return; }
  if(!$accountLegalConsent?.checked){ setAccountMessage(authCopy('legalRequired'),'error'); return; }
  setAuthBusy(true); setAccountMessage(authCopy('registering'));
  try{
    const {response,data}=await postUserAction({ action:'sign_up', name,email,password,password_confirmation:passwordConfirmation, session_token:getStoredSessionToken() || null, ...authTrackingPayload(), ...legalPayload('account') });
    if(response.ok && data?.ok){
      if(currentUser && getStoredSessionToken()){
        currentUser={...currentUser,...(data.user || {}),is_registered:false,registration_pending:true,email_verified:false};
        guestUpgradeFormOpen=false;
        if($accountEmail) $accountEmail.readOnly=false;
        if($accountPassword) $accountPassword.value=''; if($accountPasswordConfirm) $accountPasswordConfirm.value='';
        renderAuthState();
      }else{
        setAccountMessage(authCopy('confirmationSent'),'success');
        if($accountPassword) $accountPassword.value=''; if($accountPasswordConfirm) $accountPasswordConfirm.value='';
      }
      return;
    }
    if(response.status===409 || data?.email_taken) setAccountMessage(authCopy('duplicateEmail'),'error');
    else setAccountMessage(authCopy('registerFail'),'error');
  }catch(err){ console.error('ITBMO signup error:',err); setAccountMessage(authCopy('connectionFail'),'error'); }
  finally{ setAuthBusy(false); }
}

async function loginITBMOUser(){
  const email=String($accountLoginEmail?.value || '').trim().toLowerCase();
  const password=String($accountLoginPassword?.value || '');
  if(!email || !password){ setAccountMessage(authCopy('required'),'error'); return; }
  if(!validAccountEmail(email)){ setAccountMessage(authCopy('emailInvalid'),'error'); return; }
  setAuthBusy(true); setAccountMessage(authCopy('signingIn'));
  try{
    const {response,data}=await postUserAction({action:'sign_in',email,password});
    if(response.ok && data?.ok && data?.session_token){
      storeSessionToken(data.session_token,true); currentUser=data.user || null; authReady=true; if($accountLoginPassword) $accountLoginPassword.value=''; setAccountMessage(''); renderAuthState(); closeAccountDialog(); setTimeout(()=>restorePaidGenerationIfNeeded(),0); return;
    }
    setAccountMessage(authCopy('loginFail'),'error');
  }catch(err){ console.error('ITBMO sign in error:',err); setAccountMessage(authCopy('connectionFail'),'error'); }
  finally{ setAuthBusy(false); }
}

async function continueAsGuest(){
  const name=String($accountGuestName?.value || '').trim();
  const email=String($accountGuestEmail?.value || '').trim().toLowerCase();
  if(!name || !email){ setAccountMessage(authCopy('required'),'error'); return; }
  if(!validAccountEmail(email)){ setAccountMessage(authCopy('emailInvalid'),'error'); return; }
  if(!$accountGuestLegalConsent?.checked){ setAccountMessage(authCopy('legalRequired'),'error'); return; }
  setAuthBusy(true); setAccountMessage(authCopy('guestStarting'));
  try{
    const {response,data}=await postUserAction({action:'guest',name,email,...authTrackingPayload(),...legalPayload('guest')});
    if(response.ok && data?.ok && data?.session_token){
      storeSessionToken(data.session_token,false); currentUser=data.user || null; authReady=true; setAccountMessage(''); renderAuthState(); closeAccountDialog(); setTimeout(()=>restorePaidGenerationIfNeeded(),0); return;
    }
    if(response.status===409 && data?.account_exists) setAccountMessage(authCopy('guestHasAccount'),'error');
    else if(response.status===403 && data?.guest_mismatch) setAccountMessage(authCopy('guestMismatch'),'error');
    else setAccountMessage(authCopy('guestFail'),'error');
  }catch(err){ console.error('ITBMO guest error:',err); setAccountMessage(authCopy('connectionFail'),'error'); }
  finally{ setAuthBusy(false); }
}

async function sendForgotPassword(){
  const email=String($accountForgotEmail?.value || $accountLoginEmail?.value || '').trim().toLowerCase();
  if(!validAccountEmail(email)){ setAccountMessage(authCopy('emailInvalid'),'error'); return; }
  setAuthBusy(true); setAccountMessage(authCopy('sendingReset'));
  try{
    const recoveryLang=getLang();
    const recoveryRedirect=`${window.location.origin}/planner.html?lang=${encodeURIComponent(recoveryLang)}`;
    const {response,data}=await postUserAction({action:'forgot_password',email,preferred_language:recoveryLang,origin:window.location.origin,redirect_to:recoveryRedirect});
    if(response.ok && data?.ok){ setAccountMessage(authCopy('resetSent'),'success'); return; }
    setAccountMessage(authCopy('resetFail'),'error');
  }catch(err){ console.error('ITBMO forgot password error:',err); setAccountMessage(authCopy('connectionFail'),'error'); }
  finally{ setAuthBusy(false); }
}

function getSupabaseCallback(){
  const hash=new URLSearchParams(String(window.location.hash || '').replace(/^#/,''));
  return { accessToken:hash.get('access_token') || '', type:hash.get('type') || '', error:hash.get('error_description') || hash.get('error') || '' };
}
function clearAuthCallbackFromUrl(){
  try{ history.replaceState(null,'',window.location.pathname + window.location.search); }catch(_){}
}

async function completeEmailConfirmation(accessToken){
  if(!accessToken) return;
  setAuthBusy(true); setAccountMessage(authCopy('confirming'));
  try{
    const {response,data}=await postUserAction({action:'complete_auth',access_token:accessToken});
    if(response.ok && data?.ok && data?.session_token){
      storeSessionToken(data.session_token,true); currentUser=data.user || null; authReady=true; clearAuthCallbackFromUrl(); renderAuthState(); setAccountMessage(authCopy('confirmationComplete'),'success'); setTimeout(()=>restorePaidGenerationIfNeeded(),0); return;
    }
    setAccountMessage(authCopy('confirmationFail'),'error');
  }catch(err){ console.error('ITBMO confirmation error:',err); setAccountMessage(authCopy('connectionFail'),'error'); }
  finally{ setAuthBusy(false); }
}

async function resetITBMOPassword(){
  const {accessToken}=getSupabaseCallback();
  const password=String($accountResetPassword?.value || '');
  const confirmation=String($accountResetPasswordConfirm?.value || '');
  if(!accessToken || !password || !confirmation){ setAccountMessage(authCopy('required'),'error'); return; }
  if(!validAccountPassword(password)){ setAccountMessage(authCopy('passwordRule'),'error'); return; }
  if(password !== confirmation){ setAccountMessage(authCopy('passwordMismatch'),'error'); return; }
  setAuthBusy(true); setAccountMessage(authCopy('resetting'));
  try{
    const {response,data}=await postUserAction({action:'reset_password',access_token:accessToken,password,password_confirmation:confirmation});
    if(response.ok && data?.ok){
      clearAuthCallbackFromUrl(); clearSessionToken(); currentUser=null; authReady=true; showAccountMode('login'); setAccountMessage(authCopy('passwordUpdated'),'success'); renderAuthState(); return;
    }
    setAccountMessage(authCopy('resetFail'),'error');
  }catch(err){ console.error('ITBMO reset password error:',err); setAccountMessage(authCopy('connectionFail'),'error'); }
  finally{ setAuthBusy(false); }
}

function wantsMyTripsView(){
  return String(new URLSearchParams(window.location.search).get('view') || '').trim().toLowerCase()==='my-trips';
}
function openRequestedMyTripsView(){
  if(!wantsMyTripsView() || !currentUser || !getStoredSessionToken()) return false;
  try{
    const url=new URL(window.location.href);
    url.searchParams.delete('view');
    history.replaceState(null,'',url.pathname + (url.searchParams.toString()?`?${url.searchParams.toString()}`:'') + url.hash);
  }catch(_){ }
  setTimeout(()=>qs('#planner-my-trips')?.click(),80);
  return true;
}
function waitITBMO(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }

async function restoreITBMOSession(){
  const callback=getSupabaseCallback();
  if(callback.error){ authReady=true; currentUser=null; renderAuthState(); setAccountMessage(callback.error,'error'); clearAuthCallbackFromUrl(); return; }
  if(callback.accessToken && callback.type === 'recovery'){
    authReady=true; currentUser=null; renderAuthState(); openAccountDialog('reset'); return;
  }
  if(callback.accessToken){ await completeEmailConfirmation(callback.accessToken); return; }

  const token=getStoredSessionToken();
  if(!token){ authReady=true; currentUser=null; renderAuthState(); return; }

  // Keep authenticated UI stable while the server validates the token.
  // Transient API/Supabase failures must never behave like an explicit logout.
  const cachedUser=getCachedUser();
  if(cachedUser){
    currentUser=cachedUser;
    renderAuthState();
  }

  let lastError=null;
  for(let attempt=0; attempt<3; attempt++){
    try{
      const {response,data}=await postUserAction({action:'session',session_token:token});
      if(response.ok && data?.ok && data?.user){
        currentUser=data.user;
        storeSessionToken(token,Boolean(currentUser.is_registered));
        authReady=true;
        renderAuthState();
        if(!openRequestedMyTripsView()) setTimeout(()=>restorePaidGenerationIfNeeded(),0);
        return;
      }

      if(response.status===401 || response.status===403){
        clearSessionToken();
        currentUser=null;
        authReady=true;
        renderAuthState();
        return;
      }

      lastError=new Error(data?.error || `SESSION_HTTP_${response.status}`);
      lastError.status=response.status;
    }catch(err){
      lastError=err;
    }

    if(attempt<2) await waitITBMO(attempt===0 ? 350 : 900);
  }

  // Preserve token and cached identity after transient infrastructure failures.
  console.warn('ITBMO session validation temporarily unavailable:',lastError);
  currentUser=cachedUser || currentUser || null;
  authReady=true;
  renderAuthState();
  if(currentUser){
    if(!openRequestedMyTripsView()) setTimeout(()=>restorePaidGenerationIfNeeded(),0);
  }
}

function clearPlannerUIForLogout(){
  const tripIdToClear=currentTripId || getStoredActiveTripId();

  // Logout is NOT a trip reset: do not archive or modify the trip in Supabase.
  // We only remove private trip state from this browser so another person using
  // the same device cannot see the previous user's itinerary while signed out.
  clearInfoChatStateForTrip(tripIdToClear);
  _clearPostPaymentProgressLocal_(tripIdToClear);
  closeAstraCoach({remember:false});

  savedDestinations=[];
  itineraries={};
  cityMeta={};
  session=[];
  hasSavedOnce=false;
  pendingChange=null;
  saveLockWarningAccepted=false;
  paymentWarningAcceptedTripId=null;
  paymentGateSatisfiedTripId=null;
  generationRecoveryState=null;
  paidGenerationRunning=false;
  planningStarted=false;
  metaProgressIndex=0;
  collectingHotels=false;
  isItineraryLocked=false;
  activeCity=null;
  agentConversationLang=null;
  preferencesStageTripId=null;
  preferencesConfirmedTripId=null;
  currentTripId=null;
  storeActiveTripId(null);

  if($cityList){
    $cityList.innerHTML='';
    addCityRow();
  }
  if($tabs) $tabs.innerHTML='';
  if($itWrap) $itWrap.innerHTML='';
  closeImmersiveItinerary();
  syncImmersiveItineraryLauncher();

  if($chatBox) $chatBox.style.display='none';
  if($chatM) $chatM.innerHTML='';
  setPlanningChatLocked(true);

  hidePreferencesStage({reset:true});
  if($preferencesField){
    $preferencesField.value='';
    $preferencesField.style.height='';
    $preferencesField.style.overflowY='hidden';
  }

  resetTravelersUI();
  if(typeof plannerState !== 'undefined' && plannerState){
    plannerState.destinations=[];
    plannerState.specialConditions='';
    plannerState.travelers={adults:1,young:0,children:0,infants:0,seniors:0};
    plannerState.travelerProfiles=null;
    plannerState.budget='';
    plannerState.currency='USD';
    plannerState.travelModelV2=null;
    plannerState.preferencesV2=null;
    if(_travelV2()?.state){_travelV2().state.routes={};_travelV2().state.preferences={global:{},places:{}};_travelV2().state.itineraryLanguage='';}
    plannerState.collectingItineraryLang=false;
    plannerState.itineraryLang='';
    plannerState.forceReplan={};
  }

  if($start){
    delete $start.dataset.itbmoConsumed;
    $start.disabled=true;
    $start.setAttribute('aria-disabled','true');
  }
  setExportToolbarVisibility(false);
  setInfoChatEntitlement({authorized:false,remaining:0,used:0,tripId:null});
  try{ if($overlayWOW) $overlayWOW.style.display='none'; }catch(_){}
  qsa('.date-tooltip').forEach(node=>node.remove());

  if($sidebar) $sidebar.classList.remove('disabled');
  setSavedSetupLocked(false);

  // Logout must return the Planner to its neutral signed-out view.
  // My Trips remains hidden until the user signs in again and explicitly opens it.
  hideJourneyReturnGate();
  journeyHomeLatestTrip=null;
  journeyHistoryTrips=[];
  const journeyHistory=qs('#journey-history');
  const journeyHistoryGrid=qs('#journey-history-grid');
  if(journeyHistory) journeyHistory.hidden=true;
  if(journeyHistoryGrid) journeyHistoryGrid.innerHTML='';

  updateAddCityButtonState();
}

async function logoutITBMOUser(){
  const token=getStoredSessionToken();
  setAuthBusy(true);
  try{
    if(token) await postUserAction({action:'logout',session_token:token});
  }catch(err){ console.warn('ITBMO logout warning:',err); }
  finally{
    stopPendingVerificationWatch();
    clearSessionToken();
    clearPlannerUIForLogout();
    currentUser=null;
    authReady=true;
    guestUpgradeFormOpen=false;
    setAccountMessage('');

    // Signed-out state starts neutral: show the three account choices, but do
    // not leave Create account / Sign in / Guest fields expanded automatically.
    showAccountMode(null);
    closeAccountDialog();
    renderAuthState();
    setAuthBusy(false);
  }
}

async function syncPlannerAuthFromAnotherTab(event){
  if(!event) return;
  const relevant=event.key===ITBMO_SESSION_KEY || event.key===ITBMO_AUTH_SYNC_KEY;
  if(!relevant) return;

  let announcedState='';
  if(event.key===ITBMO_AUTH_SYNC_KEY && event.newValue){
    try{ announcedState=String(JSON.parse(event.newValue)?.state||''); }catch(_){}
  }

  const token=getStoredSessionToken();
  if(announcedState==='signed_out' || (event.key===ITBMO_SESSION_KEY && !event.newValue && !token)){
    stopPendingVerificationWatch();
    clearSessionToken({broadcast:false});
    clearPlannerUIForLogout();
    currentUser=null;
    authReady=true;
    guestUpgradeFormOpen=false;
    setAccountMessage('');
    showAccountMode(null);
    closeAccountDialog();
    renderAuthState();
    return;
  }

  if(token && (!currentUser || announcedState==='signed_in')){
    await restoreITBMOSession();
  }
}

function bindAccountListeners(){
  $accountRegisterToggle?.addEventListener('click',()=>showAccountMode('register'));
  $accountLoginToggle?.addEventListener('click',()=>showAccountMode('login'));
  $accountGuestToggle?.addEventListener('click',()=>showAccountMode('guest'));
  $accountForgotPassword?.addEventListener('click',()=>{ if($accountForgotEmail && $accountLoginEmail) $accountForgotEmail.value=$accountLoginEmail.value || ''; showAccountMode('forgot'); });
  $accountForgotBack?.addEventListener('click',()=>showAccountMode('login'));
  $accountRegisterSubmit?.addEventListener('click',registerITBMOUser);
  $accountLoginSubmit?.addEventListener('click',loginITBMOUser);
  $accountGuestSubmit?.addEventListener('click',continueAsGuest);
  $accountForgotSubmit?.addEventListener('click',sendForgotPassword);
  $accountResetSubmit?.addEventListener('click',resetITBMOPassword);
  $accountUpgradeToggle?.addEventListener('click',openGuestAccountUpgrade);
  $accountUpgradeCancel?.addEventListener('click',closeGuestAccountUpgrade);
  $accountLogout?.addEventListener('click',logoutITBMOUser);
  $topbarAccountRegister?.addEventListener('click',()=>{
    if(currentUser && !currentUser.is_registered){ openGuestAccountUpgrade(); openAccountDialog('register'); return; }
    openAccountDialog('register');
  });
  $topbarAccountLogin?.addEventListener('click',()=>openAccountDialog('login'));
  $topbarAccountGuest?.addEventListener('click',()=>openAccountDialog('guest'));
  $topbarAccountLogout?.addEventListener('click',logoutITBMOUser);
  $accountDialogClose?.addEventListener('click',closeAccountDialog);
  $accountModalBackdrop?.addEventListener('click',closeAccountDialog);
  document.addEventListener('keydown',event=>{ if(event.key==='Escape' && qs('#account-box')?.classList.contains('is-auth-dialog-open')) closeAccountDialog(); });
  applyAuthLanguage(); updateSaveAvailability();
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden && currentUser?.registration_pending) refreshPendingVerification(); });
  window.addEventListener('focus',()=>{ if(currentUser?.registration_pending) refreshPendingVerification(); });
  window.addEventListener('storage',syncPlannerAuthFromAnotherTab);
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
    country_code:d.countryCode || _countryMatch_(d.country)?.code || null,
    days:d.days,
    base_date:dmyToISO(d.baseDate),
    per_day:Array.isArray(d.perDay) ? d.perDay : []
  }));

  const travelModelV2=_currentTravelModelV2_();
  const replacingExistingPrePaymentTrip=Boolean(currentTripId && hasSavedOnce && paymentGateSatisfiedTripId!==currentTripId);
  const body = {
    action:replacingExistingPrePaymentTrip?'update':'create',
    ...(replacingExistingPrePaymentTrip?{trip_id:currentTripId}:{}),
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
      special_conditions:String(qs('#special-conditions')?.value || '').trim() || null,
      travel_model_v2:travelModelV2
    },
    planner_version:'v119-generation-v3',
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
  storeActiveTripId(currentTripId);
  return data.trip;
}

async function tripApi(payload){
  const response=await fetch(TRIP_API_URL,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload || {})
  });
  let data={};
  try{ data=await response.json(); }catch(_){ }
  if(!response.ok || data?.ok===false){
    const error=new Error(data?.error || `TRIP_HTTP_${response.status}`);
    error.code=data?.code || `TRIP_HTTP_${response.status}`;
    error.status=response.status;
    throw error;
  }
  return data;
}


function _postPaymentStateKey_(tripId=currentTripId){
  const safeTripId=String(tripId || '').trim();
  return safeTripId ? `${ITBMO_POST_PAYMENT_STATE_KEY_PREFIX}${safeTripId}` : '';
}

function _planningChatHistorySnapshot_(){
  if(!$chatM) return [];
  return qsa('.chat-message',$chatM).slice(-80).map(node=>({
    who:node.classList.contains('user') ? 'user' : 'ai',
    html:String(node.innerHTML || '').slice(0,12000)
  }));
}

function _postPaymentProgressSnapshot_(phase=''){
  const resolvedPhase=String(phase || '').trim() || (
    plannerState?.collectingItineraryLang ? 'collecting_language' :
    collectingHotels ? 'collecting_hotels' :
    (preferencesConfirmedTripId===currentTripId ? 'collecting_hotels' : 'preferences')
  );
  return {
    schema_version:1,
    phase:resolvedPhase,
    preferences_confirmed:preferencesConfirmedTripId===currentTripId,
    preferences_value:String($preferencesField?.value ?? plannerState?.specialConditions ?? '').trim(),
    meta_progress_index:Math.max(0,Number(metaProgressIndex || 0)),
    collecting_hotels:Boolean(collectingHotels),
    collecting_itinerary_lang:Boolean(plannerState?.collectingItineraryLang),
    itinerary_lang:String(plannerState?.itineraryLang || '').trim(),
    agent_conversation_lang:agentConversationLang || null,
    city_meta:cityMeta,
    travel_model_v2:plannerState?.travelModelV2 || _currentTravelModelV2_(),
    preferences_v2:plannerState?.preferencesV2 || _travelV2()?.preferencesPayload?.() || null,
    planning_chat_history:_planningChatHistorySnapshot_(),
    updated_at:new Date().toISOString()
  };
}

function _storePostPaymentProgressLocal_(checkpoint,tripId=currentTripId){
  const key=_postPaymentStateKey_(tripId);
  if(!key || !checkpoint) return;
  try{ localStorage.setItem(key,JSON.stringify(checkpoint)); }catch(_){ }
}

function _readPostPaymentProgressLocal_(tripId=currentTripId){
  const key=_postPaymentStateKey_(tripId);
  if(!key) return null;
  try{
    const parsed=JSON.parse(localStorage.getItem(key) || 'null');
    return parsed && typeof parsed==='object' && !Array.isArray(parsed) ? parsed : null;
  }catch(_){ return null; }
}

function _clearPostPaymentProgressLocal_(tripId){
  const key=_postPaymentStateKey_(tripId);
  try{ if(key) localStorage.removeItem(key); }catch(_){ }
}

async function _persistPostPaymentProgress_(phase=''){
  const token=getStoredSessionToken();
  if(!token || !currentTripId) return null;
  const checkpoint=_postPaymentProgressSnapshot_(phase);
  _storePostPaymentProgressLocal_(checkpoint,currentTripId);
  try{
    return await tripApi({
      action:'post_payment_checkpoint',
      session_token:token,
      trip_id:currentTripId,
      checkpoint
    });
  }catch(err){
    console.warn('[POST-PAYMENT CHECKPOINT]',err);
    return null;
  }
}

function _latestPostPaymentProgress_(trip){
  const server=(trip?.planner_input?.post_payment_progress && typeof trip.planner_input.post_payment_progress==='object')
    ? trip.planner_input.post_payment_progress
    : null;
  const local=_readPostPaymentProgressLocal_(trip?.id || currentTripId);
  if(!server) return local;
  if(!local) return server;
  const serverTime=Date.parse(server.updated_at || '') || 0;
  const localTime=Date.parse(local.updated_at || '') || 0;
  return localTime>serverTime ? local : server;
}

function _restorePlanningChatHistory_(history){
  if(!$chatM) return;
  $chatM.innerHTML='';
  (Array.isArray(history) ? history : []).forEach(message=>{
    if(!message || !message.html) return;
    chatMsg(message.html,message.who==='user'?'user':'ai');
  });
}

function _restorePostPaymentProgress_(trip){
  const checkpoint=_latestPostPaymentProgress_(trip);
  if(!checkpoint) return false;

  preferencesStageTripId=currentTripId;
  if(checkpoint.preferences_confirmed) preferencesConfirmedTripId=currentTripId;

  const special=String(checkpoint.preferences_value ?? plannerState?.specialConditions ?? '').trim();
  plannerState.specialConditions=special;
  if($preferencesField) $preferencesField.value=special;

  if(checkpoint.city_meta && typeof checkpoint.city_meta==='object' && !Array.isArray(checkpoint.city_meta)){
    cityMeta=checkpoint.city_meta;
  }
  if(checkpoint.travel_model_v2 && typeof checkpoint.travel_model_v2==='object'){
    plannerState.travelModelV2=checkpoint.travel_model_v2;
    _travelV2()?.restore?.(checkpoint.travel_model_v2,qsa('.city-row',$cityList));
  }
  if(checkpoint.preferences_v2 && typeof checkpoint.preferences_v2==='object'){
    plannerState.preferencesV2=checkpoint.preferences_v2;
    const engine=_travelV2();
    if(engine?.state){
      engine.state.preferences={global:{...(checkpoint.preferences_v2.global||{})},places:{...(checkpoint.preferences_v2.places||{})}};
      engine.state.itineraryLanguage=checkpoint.preferences_v2.itinerary_language||plannerState.itineraryLang||'';
    }
  }
  metaProgressIndex=Math.max(0,Number(checkpoint.meta_progress_index || 0));
  collectingHotels=Boolean(checkpoint.collecting_hotels);
  plannerState.collectingItineraryLang=Boolean(checkpoint.collecting_itinerary_lang);
  plannerState.itineraryLang=String(checkpoint.itinerary_lang || '').trim();
  agentConversationLang=checkpoint.agent_conversation_lang || null;
  planningStarted=true;

  _restorePlanningChatHistory_(checkpoint.planning_chat_history);

  const phase=String(checkpoint.phase || '').trim();
  if(phase==='preferences' || !checkpoint.preferences_confirmed){
    hidePreferencesStage({reset:true});
    showPreferencesStage();
    return true;
  }

  showPreferencesStage();
  preferencesConfirmedTripId=currentTripId;
  if($preferencesField){
    $preferencesField.readOnly=true;
    $preferencesField.setAttribute('aria-readonly','true');
  }
  $preferencesStage?.classList.add('is-confirmed');
  if($preferencesContinue){
    $preferencesContinue.disabled=true;
    $preferencesContinue.setAttribute('aria-disabled','true');
    $preferencesContinue.textContent=getLang()==='es' ? '✓ Preferencias guardadas' : '✓ Preferences saved';
  }
  if(phase==='preferences_confirmed' && $preferencesGenerateV2){
    $preferencesGenerateV2.hidden=false;$preferencesGenerateV2.disabled=false;$preferencesGenerateV2.removeAttribute('aria-disabled');
    $preferencesGenerateV2.textContent=getLang()==='es'?'Generar mi itinerario ✨':'Generate my itinerary ✨';
  }

  if(phase==='collecting_hotels' || phase==='collecting_language'){
    // Legacy checkpoint compatibility only. New V2 trips no longer use Planner Chat for structure.
    if($chatBox) $chatBox.style.display='flex';
    setPlanningChatLocked(false);
    if(collectingHotels) _setHotelTransportComposerTemplate_();
  }else{
    if($chatBox) $chatBox.style.display='none';
    setPlanningChatLocked(true);
  }

  if(phase==='generation_requested'){
    _travelV2()?.setLocked?.(true);
    collectingHotels=false;
    plannerState.collectingItineraryLang=false;
    setTimeout(()=>runPaidGeneration(),180);
  }
  return true;
}

/* 🆕 Export buttons (PDF / CSV / Email) */
const $btnPDF   = qs('#btn-pdf');
const $btnCSV   = qs('#btn-csv');
const $btnReceipt = qs('#btn-receipt');
const $btnEmail = qs('#btn-email');
const $exportToolbar = qs('.toolbar');
const $newPlanningCta = qs('#new-planning-cta');
const $newPlanningButton = qs('#new-planning-button');
const $newPlanningCopy = qs('#new-planning-copy');

function keepEmailExportComingSoon(){
  if(!$btnEmail) return;
  $btnEmail.disabled = false;
  $btnEmail.removeAttribute('aria-disabled');
  $btnEmail.setAttribute('title', getLang()==='es' ? 'Enviar PDF, Excel y comprobante por email' : 'Email PDF, Excel and receipt');
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
  if($newPlanningCta){
    $newPlanningCta.hidden=!show;
    $newPlanningCta.classList.toggle('is-ready',!!show);
    $newPlanningCta.setAttribute('aria-hidden',show ? 'false' : 'true');
  }
  if($newPlanningCopy) $newPlanningCopy.textContent=getLang()==='es'
    ? '¿Listo para planificar otro viaje?'
    : 'Ready to plan another trip?';
  if($newPlanningButton) $newPlanningButton.textContent=getLang()==='es'
    ? 'Planificar otro viaje →'
    : 'Plan another trip →';
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

function _infoChatStateKey_(tripId=currentTripId){
  const safeTripId=String(tripId || '').trim();
  return safeTripId ? `${ITBMO_INFO_CHAT_STATE_KEY_PREFIX}${safeTripId}` : '';
}

function _infoChatStateSnapshot_(){
  return {
    trip_id:currentTripId,
    authorized:infoChatAuthorizedTripId===currentTripId,
    remaining:infoChatQueriesRemaining,
    used:infoChatQueriesUsed,
    history:(Array.isArray(infoSession) ? infoSession : [])
      .filter(message=>message && (message.role==='user' || message.role==='assistant'))
      .slice(-40)
      .map(message=>({role:message.role,content:String(message.content || '').slice(0,12000)})),
    updated_at:new Date().toISOString()
  };
}

function persistInfoChatState({server=true}={}){
  const key=_infoChatStateKey_();
  if(!key || infoChatAuthorizedTripId!==currentTripId) return;
  const snapshot=_infoChatStateSnapshot_();
  try{ localStorage.setItem(key,JSON.stringify(snapshot)); }catch(_){ }

  /* Server copy protects the conversation if the page is refreshed after the
     local state is lost/overwritten, and also keeps the history tied to the
     paid trip instead of only to this browser. Fire-and-forget by design. */
  if(server && getStoredSessionToken() && currentTripId){
    tripApi({
      action:'info_chat_checkpoint',
      session_token:getStoredSessionToken(),
      trip_id:currentTripId,
      checkpoint:snapshot
    }).catch(err=>console.warn('[INFO CHAT CHECKPOINT]',err));
  }
}

function _latestInfoChatState_(tripId=currentTripId,serverState=null){
  const key=_infoChatStateKey_(tripId);
  let local=null;
  try{ local=key ? JSON.parse(localStorage.getItem(key) || 'null') : null; }catch(_){ local=null; }
  const server=(serverState && typeof serverState==='object' && !Array.isArray(serverState)) ? serverState : null;
  if(!server) return local;
  if(!local) return server;
  const serverTime=Date.parse(server.updated_at || '') || 0;
  const localTime=Date.parse(local.updated_at || '') || 0;
  return localTime>serverTime ? local : server;
}

function restoreInfoChatStateForTrip(tripId=currentTripId,serverState=null){
  if(!tripId || String(tripId)!==String(currentTripId)) return false;
  const cached=_latestInfoChatState_(tripId,serverState);
  if(!cached || String(cached.trip_id)!==String(currentTripId) || !cached.authorized) return false;

  infoSession=Array.isArray(cached.history)
    ? cached.history.filter(message=>message && (message.role==='user' || message.role==='assistant'))
      .map(message=>({role:message.role,content:String(message.content || '')}))
    : [];

  setInfoChatEntitlement({
    authorized:true,
    remaining:Number(cached.remaining),
    used:Number(cached.used),
    tripId:currentTripId
  });

  const container=$infoMessages || qs('#info-chat-messages');
  if(container) container.innerHTML='';
  infoChatWelcomeTripId=null;
  ensureInfoChatWelcome();
  infoSession.forEach(message=>infoChatMsg(message.content,message.role==='user'?'user':'ai'));
  return true;
}

function clearInfoChatStateForTrip(tripId){
  const key=_infoChatStateKey_(tripId);
  try{ if(key) localStorage.removeItem(key); }catch(_){ }
  infoSession=[];
  infoChatWelcomeTripId=null;
  const container=$infoMessages || qs('#info-chat-messages');
  if(container) container.innerHTML='';
}

let infoTypingTimer = null;
let infoChatRequestInFlight = false;
const $infoTyping = document.createElement('div');
$infoTyping.className = 'chat-message ai typing';
// ✅ Puntos más grandes y llamativos
$infoTyping.innerHTML = `<span class="dot">•</span><span class="dot">•</span><span class="dot">•</span>`;

function setInfoChatBusy(on){
  /* bindInfoChatListeners replaces the send button with a clone. Always
     resolve the live nodes so mobile keeps the real composer in sync. */
  const input = qs('#info-chat-input');
  const send  = qs('#info-chat-send');
  if(input) input.disabled = on;
  if(send)  send.disabled  = on;

  const container = $infoMessages || qs('#info-chat-messages');
  if(container){
    if(on){
      clearInterval(infoTypingTimer);
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
      const btn = qs('#info-chat-send');
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
function formatISODate(d){
  if(!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function parsePlannerDate(value){
  const raw=String(value||'').trim();
  const iso=/^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if(iso){
    const d=new Date(Number(iso[1]),Number(iso[2])-1,Number(iso[3]));
    if(d.getFullYear()===Number(iso[1]) && d.getMonth()===Number(iso[2])-1 && d.getDate()===Number(iso[3])) return d;
    return null;
  }
  return parseDMY(raw);
}
function plannerDateMin(){
  const d=new Date(); d.setHours(0,0,0,0); return formatISODate(d);
}
function plannerDateMax(){
  const d=new Date(); d.setFullYear(d.getFullYear()+5); d.setHours(0,0,0,0); return formatISODate(d);
}
function dateToPlannerStorage(value){
  const d=parsePlannerDate(value);
  return d ? formatDMY(d) : '';
}
function addMinutes(hhmm, min){
  const [H,M] = (hhmm||DEFAULT_START).split(':').map(n=>parseInt(n||'0',10));
  const d = new Date(2000,0,1,H||0,M||0,0);
  d.setMinutes(d.getMinutes()+min);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function timeSelectOptions(kind='hour'){
  if(kind==='minute'){
    return `<option value="">00</option>${['15','30','45'].map(v=>`<option value="${v}">${v}</option>`).join('')}`;
  }
  const values=Array.from({length:24},(_,i)=>String(i).padStart(2,'0'));
  return `<option value="">--</option>${values.map(v=>`<option value="${v}">${v}</option>`).join('')}`;
}

function timeSelectorMarkup(type,ariaLabel){
  const visibleLabel=type==='start' ? t('uiStartTime') : t('uiEndTime');
  return `<div class="time-selector" data-time-type="${type}" role="group" aria-label="${ariaLabel}">
    <span class="time-selector-label">${visibleLabel}</span>
    <div class="time-selector-inputs">
      <select class="time-hour" aria-label="${ariaLabel} · ${getLang()==='es'?'hora':'hour'}">${timeSelectOptions('hour')}</select>
      <span class="time-selector-colon" aria-hidden="true">:</span>
      <select class="time-minute" aria-label="${ariaLabel} · ${getLang()==='es'?'minutos':'minutes'}">${timeSelectOptions('minute')}</select>
    </div>
    <input class="${type}" type="hidden" value="">
  </div>`;
}

function syncTimeSelector(group){
  if(!group) return '';
  const hour=qs('.time-hour',group)?.value || '';
  const minute=qs('.time-minute',group)?.value || '00';
  const value=hour!=='' ? `${hour}:${minute}` : '';
  const hidden=qs('input[type="hidden"]',group);
  if(hidden) hidden.value=value;
  return value;
}

function setTimeSelectorValue(group,value=''){
  if(!group) return;
  const normalized=/^(\d{2}):(\d{2})$/.exec(String(value||''));
  const hour=qs('.time-hour',group);
  const minute=qs('.time-minute',group);
  if(hour) hour.value=normalized?.[1] || '';
  if(minute) minute.value=['15','30','45'].includes(normalized?.[2]) ? normalized[2] : '';
  syncTimeSelector(group);
}

function mirrorFirstDaySchedule(wrap){
  const rows=qsa('.hours-day',wrap);
  if(rows.length<2) return;
  const firstStart=qs('.start',rows[0])?.value || '';
  const firstEnd=qs('.end',rows[0])?.value || '';
  rows.slice(1).forEach(row=>{
    setTimeSelectorValue(qs('[data-time-type="start"]',row),firstStart);
    setTimeSelectorValue(qs('[data-time-type="end"]',row),firstEnd);
  });
}

function _plannerDayDateLabel_(baseDMY,dayNumber){
  const start=parsePlannerDate(baseDMY||'');
  if(!start) return '';
  const date=addDays(start,Math.max(0,Number(dayNumber||1)-1));
  try{
    return new Intl.DateTimeFormat(getLang()==='es'?'es-ES':'en-US',{day:'2-digit',month:'short'}).format(date).replace('.','');
  }catch(_){ return formatDMY(date); }
}
function updateHoursDayDates(wrap,baseDMY=''){
  if(!wrap) return;
  qsa('.hours-day',wrap).forEach((dayRow,index)=>{
    const label=qs('.hours-day-label',dayRow);
    if(!label) return;
    const date=_plannerDayDateLabel_(baseDMY,index+1);
    label.innerHTML=`<strong>${t('uiDay',index+1)}</strong>${date?`<small>${date}</small>`:''}`;
    dayRow.dataset.date=baseDMY?dateToPlannerStorage(formatISODate(addDays(parsePlannerDate(baseDMY),index))):'';
  });
}

function makeHoursBlock(days,baseDMY=''){
  days=Math.min(MAX_DAYS_PER_DESTINATION, Math.max(1, Number(days) || 1));
  const wrap = document.createElement('div');
  wrap.className = 'hours-block';

  // 🆕 Guía de horarios
  const guide = document.createElement('p');
  guide.className = 'time-hint';
  guide.textContent = t('uiTimeHint');
  wrap.appendChild(guide);

  const same=document.createElement('label');
  same.className='same-schedule-toggle';
  same.innerHTML=`<input class="same-schedule" type="checkbox"><span class="same-schedule-ui" aria-hidden="true"></span><span>${t('uiSameSchedule')}</span>`;
  const quickActions=document.createElement('div');
  quickActions.className='hours-quick-actions';
  quickActions.appendChild(same);
  const quickStop=document.createElement('button');
  quickStop.type='button';
  quickStop.className='hours-quick-add-stop';
  quickStop.innerHTML=`＋ ${getLang()==='es'?'Agregar lugar a mi recorrido':'Add a place to my route'}`;
  quickActions.appendChild(quickStop);
  wrap.appendChild(quickActions);
  const routeGuide=document.createElement('div');
  routeGuide.className='hours-route-guide';
  routeGuide.innerHTML=getLang()==='es'
    ? `<strong>¿Visitarás otros lugares durante tu estancia?</strong><span>Agrégalos a tu recorrido y dinos cuándo irás. Puedes regresar al destino base, quedarte varias noches o continuar hacia otro lugar. Si no agregas ninguno, ITBMO seguirá planificando este destino y podrá recomendar excursiones por ti.</span>`
    : `<strong>Will you visit other places during this stay?</strong><span>Add them to your route and tell us when. You can return to the base destination, stay several nights or continue elsewhere. If you add none, ITBMO will keep planning this destination and may recommend day trips.</span>`;
  quickActions.insertAdjacentElement('beforebegin',routeGuide);

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
      <span class="hours-day-label"><strong>${t('uiDay', d)}</strong>${_plannerDayDateLabel_(baseDMY,d)?`<small>${_plannerDayDateLabel_(baseDMY,d)}</small>`:''}</span>
      ${timeSelectorMarkup('start',t('uiAriaStart'))}
      ${timeSelectorMarkup('end',t('uiAriaEnd'))}
    `;
    wrap.appendChild(row);
  }

  const toggle=qs('.same-schedule',wrap);
  const dayRows=qsa('.hours-day',wrap);
  const refreshMirrorState=()=>{
    const sameForAll=Boolean(toggle?.checked);
    wrap.classList.toggle('is-same-schedule',sameForAll);
    wrap.dataset.scheduleCopied='0';
    wrap.dataset.scheduleManualOverrides='0';
    if(sameForAll && qs('.start',dayRows[0])?.value && qs('.end',dayRows[0])?.value){
      mirrorFirstDaySchedule(wrap);
      wrap.dataset.scheduleCopied='1';
    }
  };
  qsa('.time-selector',wrap).forEach(group=>{
    qsa('select',group).forEach(select=>select.addEventListener('change',()=>{
      syncTimeSelector(group);
      const firstComplete=Boolean(qs('.start',dayRows[0])?.value && qs('.end',dayRows[0])?.value);
      const isFirstDay=group.closest('.hours-day')===dayRows[0];
      if(toggle?.checked && !isFirstDay) wrap.dataset.scheduleManualOverrides='1';
      if(toggle?.checked && isFirstDay && firstComplete && wrap.dataset.scheduleManualOverrides!=='1'){
        mirrorFirstDaySchedule(wrap);
        wrap.dataset.scheduleCopied='1';
      }
    }));
  });
  toggle?.addEventListener('change',refreshMirrorState);
  refreshMirrorState();
  updateHoursDayDates(wrap,baseDMY);
  return wrap;
}

function updateCityDateSummary(row){
  if(!row) return;
  const summary=qs('.date-summary',row);
  const hidden=qs('.baseDate',row);
  const picker=qs('.baseDatePicker',row);
  qs('.date-wrapper',row)?.classList.toggle('has-value',Boolean(picker?.value));
  const days=Math.max(1,Number(qs('.days',row)?.value || 1));
  const start=parsePlannerDate(hidden?.value || '');
  if(!summary || !start){ if(summary) summary.textContent=''; return; }
  const end=addDays(start,days-1);
  summary.textContent=t('uiTripRange',formatDMY(start),formatDMY(end),days);
}

function suggestFollowingCityDates(sourceRow){
  const rows=qsa('.city-row',$cityList);
  const sourceIndex=rows.indexOf(sourceRow);
  if(sourceIndex<0) return;
  for(let i=sourceIndex+1;i<rows.length;i++){
    const previous=rows[i-1];
    const current=rows[i];
    const previousDate=parsePlannerDate(qs('.baseDate',previous)?.value || '');
    const previousDays=Math.max(1,Number(qs('.days',previous)?.value || 1));
    const picker=qs('.baseDatePicker',current);
    const hidden=qs('.baseDate',current);
    if(!previousDate || !picker || !hidden) break;
    if(picker.value && picker.dataset.autoSuggested!=='1') break;
    const suggested=addDays(previousDate,previousDays);
    picker.value=formatISODate(suggested);
    picker.dataset.autoSuggested='1';
    hidden.value=formatDMY(suggested);
    updateCityDateSummary(current);
  }
}

function updateAddCityButtonState(){
  if(!$addCity || !$cityList) return;
  const count=qsa('.city-row',$cityList).length;
  const atLimit=count>=MAX_ITINERARY_CITIES;
  $addCity.disabled=atLimit;
  $addCity.setAttribute('aria-disabled',atLimit?'true':'false');
  $addCity.title=atLimit
    ? (getLang()==='es' ? 'Máximo 3 destinos por generación.' : 'Maximum 3 destinations per generation.')
    : '';
}


const ITBMO_COUNTRY_CODES = `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW`.split(/\s+/);
const ITBMO_DESTINATION_SUGGESTIONS_URL='/api/destination-suggestions';
const destinationSuggestionCache=new Map();

function _countryDisplayNames_(locale=getLang()){
  try{ return new Intl.DisplayNames([locale==='es'?'es':'en'],{type:'region'}); }
  catch(_){ return new Intl.DisplayNames(['en'],{type:'region'}); }
}
function _countryEnglishNames_(){
  try{ return new Intl.DisplayNames(['en'],{type:'region'}); }
  catch(_){ return null; }
}
function _countryOptions_(){
  const display=_countryDisplayNames_();
  const english=_countryEnglishNames_();
  return ITBMO_COUNTRY_CODES.map(code=>({
    code,
    label:String(display?.of(code) || code),
    apiName:String(english?.of(code) || code)
  })).sort((a,b)=>a.label.localeCompare(b.label,getLang(),{sensitivity:'base'}));
}
function _countryMatch_(value=''){
  const needle=String(value||'').trim();
  if(!needle) return null;
  return _countryOptions_().find(item=>item.label.localeCompare(needle,getLang(),{sensitivity:'base'})===0 || item.apiName.localeCompare(needle,'en',{sensitivity:'base'})===0 || item.code===needle.toUpperCase()) || null;
}
function _escapeAttr_(value=''){
  return String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function _normalizeSearch_(value=''){
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
}
function _syncAutocompleteReserve_(menu){
  const row=menu?.closest?.('.city-row');
  if(!row) return;
  requestAnimationFrame(()=>{
    const openMenus=[...row.querySelectorAll('.itbmo-autocomplete-menu:not([hidden])')];
    const reserve=openMenus.length ? Math.max(...openMenus.map(x=>Math.min(x.scrollHeight||0,260))) + 10 : 0;
    row.style.setProperty('--itbmo-autocomplete-reserve',`${reserve}px`);
  });
}
function _closeAutocompleteMenu_(menu){
  if(!menu) return;
  menu.innerHTML='';
  menu.hidden=true;
  _syncAutocompleteReserve_(menu);
}
function _renderAutocompleteMenu_(menu,items,{emptyText='',onSelect=null}={}){
  if(!menu) return;
  menu.innerHTML='';
  if(!Array.isArray(items) || !items.length){
    if(emptyText){
      const empty=document.createElement('div');
      empty.className='itbmo-autocomplete-empty';
      empty.textContent=emptyText;
      menu.appendChild(empty);
      menu.hidden=false;
    }else{
      menu.hidden=true;
    }
    _syncAutocompleteReserve_(menu);
    return;
  }
  const frag=document.createDocumentFragment();
  items.forEach(item=>{
    const button=document.createElement('button');
    button.type='button';
    button.className='itbmo-autocomplete-option';
    button.setAttribute('role','option');
    button.textContent=typeof item==='string' ? item : item.label;
    button.addEventListener('pointerdown',event=>event.preventDefault());
    button.addEventListener('click',()=>onSelect?.(item));
    frag.appendChild(button);
  });
  menu.appendChild(frag);
  menu.hidden=false;
  _syncAutocompleteReserve_(menu);
}
function _countrySuggestions_(query=''){
  const needle=_normalizeSearch_(query);
  const options=_countryOptions_();
  if(!needle) return options;
  const starts=[];
  const contains=[];
  options.forEach(item=>{
    const label=_normalizeSearch_(item.label);
    const english=_normalizeSearch_(item.apiName);
    const haystack=`${label} ${english} ${item.code.toLowerCase()}`;
    if(!haystack.includes(needle)) return;
    if(label.startsWith(needle) || english.startsWith(needle) || item.code.toLowerCase().startsWith(needle)) starts.push(item);
    else contains.push(item);
  });
  return [...starts,...contains];
}
function _showCountrySuggestions_(row){
  const input=qs('.country',row);
  const menu=qs('.itbmo-country-menu',row);
  if(!input || !menu) return;
  const items=_countrySuggestions_(input.value).slice(0,40);
  _renderAutocompleteMenu_(menu,items,{
    emptyText:getLang()==='es'?'No encontramos ese país.':'We could not find that country.',
    onSelect:item=>{
      input.value=item.label;
      input.dataset.countryCode=item.code;
      input.dataset.countryApiName=item.apiName;
      input.classList.add('is-valid-country');
      _closeAutocompleteMenu_(menu);
      const destination=qs('.city',row);
      _syncCountrySelection_(row);
      if(destination){ destination.value=''; destination.focus(); }
    }
  });
}
function _syncCountrySelection_(row){
  const input=qs('.country',row);
  const destination=qs('.city',row);
  const match=_countryMatch_(input?.value || '');
  if(input){
    input.dataset.countryCode=match?.code || '';
    input.dataset.countryApiName=match?.apiName || '';
    input.classList.toggle('is-valid-country',Boolean(match));
  }
  if(destination){
    destination.disabled=!match;
    destination.setAttribute('aria-disabled',String(!match));
    destination.placeholder=match
      ? (getLang()==='es'?'Escribe un destino':'Type a destination')
      : (getLang()==='es'?'Selecciona primero el país':'Select the country first');
    if(!match){
      destination.value='';
      _closeAutocompleteMenu_(qs('.itbmo-destination-menu',row));
    }
  }
  return match;
}
async function _loadDestinationSuggestions_(row){
  const country=qs('.country',row);
  const input=qs('.city',row);
  const menu=qs('.itbmo-destination-menu',row);
  const match=_countryMatch_(country?.value || '');
  const query=String(input?.value || '').trim();
  if(!match || !input || !menu || !query){ _closeAutocompleteMenu_(menu); return; }
  if(query.length<3){
    _renderAutocompleteMenu_(menu,[],{
      emptyText:getLang()==='es'
        ? 'Escribe al menos 3 letras para ver sugerencias. También puedes escribir el destino completo.'
        : 'Type at least 3 letters to see suggestions. You can also type the full destination.'
    });
    return;
  }

  _renderAutocompleteMenu_(menu,[],{
    emptyText:getLang()==='es'?'Buscando destinos…':'Searching destinations…'
  });

  const key=`${match.code}|${_normalizeSearch_(query)}`;
  let suggestions=destinationSuggestionCache.get(key);
  if(!suggestions){
    try{
      const url=`${ITBMO_DESTINATION_SUGGESTIONS_URL}?country=${encodeURIComponent(match.apiName)}&countryCode=${encodeURIComponent(match.code)}&lang=${encodeURIComponent(getLang())}&q=${encodeURIComponent(query)}`;
      const response=await fetch(url,{headers:{Accept:'application/json'}});
      const data=await response.json().catch(()=>({}));
      suggestions=response.ok && Array.isArray(data?.suggestions) ? data.suggestions : [];
      destinationSuggestionCache.set(key,suggestions);
    }catch(_){ suggestions=[]; }
  }

  /* Ignore a stale async response if the user kept typing or changed country. */
  if(String(input.value||'').trim()!==query || _countryMatch_(country?.value||'')?.code!==match.code) return;

  _renderAutocompleteMenu_(menu,suggestions.slice(0,12),{
    emptyText:getLang()==='es'
      ? 'No hay sugerencias para este texto. Puedes escribir el destino de todas formas.'
      : 'No suggestions found for this text. You can type the destination anyway.',
    onSelect:name=>{
      input.value=name;
      _closeAutocompleteMenu_(menu);
      input.focus();
    }
  });
}
function _bindCountryDestinationAutocomplete_(row){
  const country=qs('.country',row);
  const destination=qs('.city',row);
  const countryMenu=qs('.itbmo-country-menu',row);
  const destinationMenu=qs('.itbmo-destination-menu',row);
  let timer=null;

  const sync=()=>{
    _syncCountrySelection_(row);
    _showCountrySuggestions_(row);
  };

  country?.addEventListener('focus',()=>_showCountrySuggestions_(row));
  country?.addEventListener('input',sync);
  country?.addEventListener('change',()=>_syncCountrySelection_(row));
  country?.addEventListener('keydown',event=>{
    if(event.key==='Escape') _closeAutocompleteMenu_(countryMenu);
  });
  country?.addEventListener('blur',()=>{
    const match=_countryMatch_(country.value);
    if(match) country.value=match.label;
    _syncCountrySelection_(row);
    setTimeout(()=>_closeAutocompleteMenu_(countryMenu),120);
  });

  destination?.addEventListener('input',()=>{
    clearTimeout(timer);
    if(!String(destination.value||'').trim()){ _closeAutocompleteMenu_(destinationMenu); return; }
    timer=setTimeout(()=>_loadDestinationSuggestions_(row),220);
  });
  destination?.addEventListener('focus',()=>{
    if(String(destination.value||'').trim()) _loadDestinationSuggestions_(row);
  });
  destination?.addEventListener('keydown',event=>{
    if(event.key==='Escape') _closeAutocompleteMenu_(destinationMenu);
  });
  destination?.addEventListener('blur',()=>setTimeout(()=>_closeAutocompleteMenu_(destinationMenu),120));

  _syncCountrySelection_(row);
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
        ? 'Puedes incluir un máximo de 3 destinos por generación.'
        : 'You can include a maximum of 3 destinations per generation.');
    }
    return;
  }

  const initialDate=parsePlannerDate(pref.baseDate||'');
  const row = document.createElement('div');
  row.className = 'city-row';
  const autocompleteId=`itbmo-destination-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const countryFieldName=`itbmo-country-${autocompleteId}`;
  const destinationFieldName=`itbmo-destination-${autocompleteId}`;
  const destinationNumber=currentCount+1;
  row.innerHTML = `
    <div class="city-card-main">
      <div class="city-card-kicker"><span>${String(destinationNumber).padStart(2,'0')}</span><b>${getLang()==='es'?'DESTINO':'DESTINATION'}</b></div>
      <div class="city-card-fields">
        <label class="itbmo-autocomplete-field">${t('uiCountry')}<input class="country" name="${countryFieldName}" autocomplete="new-password" autocapitalize="words" spellcheck="false" data-lpignore="true" data-1p-ignore="true" placeholder="${getLang()==='es'?'Escribe o selecciona un país':'Type or select a country'}" value="${_escapeAttr_(pref.country||'')}"><div class="itbmo-autocomplete-menu itbmo-country-menu" role="listbox" hidden></div></label>
        <label class="itbmo-autocomplete-field">${t('uiCity')}<input class="city" name="${destinationFieldName}" autocomplete="new-password" autocapitalize="words" spellcheck="false" data-lpignore="true" data-1p-ignore="true" placeholder="${getLang()==='es'?'Selecciona primero el país':'Select the country first'}" value="${_escapeAttr_(pref.city||'')}"><div class="itbmo-autocomplete-menu itbmo-destination-menu" role="listbox" hidden></div></label>
        <label>${t('uiDays')}<select class="days"><option value="" selected disabled></option>${Array.from({length:MAX_DAYS_PER_DESTINATION},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join('')}</select></label>
        <label class="date-label">
          ${t('uiStart')}
          <div class="date-wrapper${initialDate?' has-value':''}">
            <span class="date-picker-shell">
              <input class="baseDatePicker" type="date" min="${plannerDateMin()}" max="${plannerDateMax()}" value="${initialDate?formatISODate(initialDate):''}">
              <span class="date-picker-placeholder" aria-hidden="true">📅 ${getLang()==='es'?'Seleccionar fecha':'Select date'}</span>
            </span>
            <input class="baseDate" type="hidden" value="${initialDate?formatDMY(initialDate):''}">
            <small class="date-format">${t('uiDateFormatSmall')}</small>
            <small class="date-summary" aria-live="polite"></small>
          </div>
        </label>
      </div>
    </div>
    <div class="city-card-schedule">
      <div class="city-card-schedule__head">
        <span>${getLang()==='es'?'HORARIO DEL DÍA':'DAILY SCHEDULE'}</span>
        <small>${getLang()==='es'?'Ajusta solo lo que ya tengas claro.':'Adjust only what you already know.'}</small>
      </div>
      <div class="city-card-schedule__body"></div>
    </div>
    <button class="remove" type="button" aria-label="${getLang()==='es'?'Eliminar destino':'Remove destination'}">✕</button>
  `;

  _bindCountryDestinationAutocomplete_(row);

  const baseDateEl = qs('.baseDate', row);
  const baseDatePicker = qs('.baseDatePicker', row);
  baseDatePicker?.addEventListener('change',()=>{
    if(baseDateEl) baseDateEl.value=dateToPlannerStorage(baseDatePicker.value);
    baseDatePicker.dataset.autoSuggested='0';
    updateCityDateSummary(row);
    updateHoursDayDates(qs('.hours-block',row),baseDateEl?.value||'');
    reorderDestinationRowsByDate();
    _travelV2()?.renderRowSummary?.(row);
    scheduleAstraCoach('schedule',()=>qs('.hours-block',row),360);
  });

  let hoursWrap = pref.days ? makeHoursBlock(pref.days,pref.baseDate||'') : document.createElement('div');
  if(!pref.days) hoursWrap.className = 'hours-block';
  qs('.city-card-schedule__body',row)?.appendChild(hoursWrap);

  const daysSelect = qs('.days', row);
  if(pref.days){
    daysSelect.value = String(Math.min(MAX_DAYS_PER_DESTINATION, Math.max(1, Number(pref.days) || 1)));
  }

  daysSelect.addEventListener('change', ()=>{
    const n = Math.max(0, parseInt(daysSelect.value||0,10));
    const nextHoursWrap=n>0 ? makeHoursBlock(n,qs('.baseDate',row)?.value||'') : document.createElement('div');
    if(n<=0) nextHoursWrap.className='hours-block';
    hoursWrap.replaceWith(nextHoursWrap);
    hoursWrap=nextHoursWrap;
    updateCityDateSummary(row);
    reorderDestinationRowsByDate();
    _travelV2()?.renderRowSummary?.(row);
    scheduleAstraCoach('date',()=>qs('.baseDatePicker',row),320);
  });

  qs('.remove',row).addEventListener('click', ()=>{
    row.remove();
    updateAddCityButtonState();
  });
  $cityList.appendChild(row);
  updateCityDateSummary(row);
  _travelV2()?.attachCityRow?.(row,pref);

  const allRows=qsa('.city-row',$cityList);
  const previous=allRows[allRows.length-2];
  if(previous && !baseDatePicker?.value) suggestFollowingCityDates(previous);
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
    $plannerLanguagePopoverTitle.textContent=es ? 'Planifica en tu idioma' : 'Plan in your language';
  }
  if($plannerLanguagePopoverCopy){
    $plannerLanguagePopoverCopy.textContent=es
      ? 'Escribe naturalmente en cualquier idioma soportado por el chat. ITBMO continuará la conversación de planificación en el idioma que utilices.'
      : 'Write naturally in any language supported by the chat. ITBMO will continue the planning conversation in the language you use.';
  }
  if($plannerLanguagePopoverNote){
    $plannerLanguagePopoverNote.textContent=es
      ? 'Si un idioma no es soportado, ITBMO te lo indicará en el chat. El idioma final del itinerario se selecciona más adelante durante la planificación.'
      : 'If a language is not supported, ITBMO will let you know in the chat. The final itinerary language is selected later in the planning flow.';
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
  /* Phase 4.4
     Travelers are fully frozen after Save. Destinations keep their container alive
     because the primary Start CTA now lives inside that section. Only the route
     editing controls are disabled; the CTA remains interactive. */
  const travelers=qs('#travelers-box');
  if(travelers){
    travelers.classList.toggle('is-setup-locked',!!locked);
    try{ travelers.inert=!!locked; }catch(_){}
    travelers.setAttribute('aria-disabled',locked?'true':'false');
  }

  const destinations=qs('#destinations-box');
  if(destinations){
    destinations.classList.toggle('is-setup-locked',!!locked);
    destinations.classList.toggle('is-route-data-locked',!!locked);
    /* Never inert the whole section: #start-planning is intentionally inside it. */
    try{ destinations.inert=false; }catch(_){}
    destinations.setAttribute('aria-disabled','false');

    qsa('input, select, textarea, button',destinations).forEach(control=>{
      /* The route confirmation CTA and Start CTA manage their own state below. */
      if(control.id==='save-destinations' || control.id==='start-planning' || control.id==='build-trip-story' || control.closest?.('#trip-story-summary')) return;
      control.disabled=!!locked;
      control.setAttribute('aria-disabled',locked?'true':'false');
    });
  }

  if($save){
    $save.disabled=!!locked || !currentUser;
    $save.setAttribute('aria-disabled',String(!!locked || !currentUser));
  }

  if(!locked){
    updateAddCityButtonState();
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


function applyPreferencesStageLanguage(){
  if(!$preferencesStage) return;
  const es=getLang()==='es';
  const set=(sel,value)=>{ const el=qs(sel); if(el) el.textContent=value; };

  set('#preferences-stage-eyebrow', es ? 'Personalización de tu viaje' : 'Personalize your trip');
  set('#preferences-stage-title', es ? 'Personaliza tu viaje' : 'Personalize your trip');
  set(
    '#preferences-stage-intro',
    es
      ? 'Info Chat ya está disponible. Úsalo si necesitas investigar algo sobre tus destinos y, cuando estés listo, cuéntanos cómo quieres vivir el viaje.'
      : 'Info Chat is now available. Use it to research your destinations and, when you are ready, tell us how you want to experience the trip.'
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
      ? 'Completa la información obligatoria de cada destino o estancia para continuar.'
      : 'Complete the required information for each destination or stay to continue.'
  );

  if($preferencesContinue && !preferencesConfirmedTripId){
    $preferencesContinue.textContent=es ? 'Guardar preferencias' : 'Save preferences';
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
    if($preferencesGenerateV2){$preferencesGenerateV2.disabled=true;$preferencesGenerateV2.hidden=true;$preferencesGenerateV2.setAttribute('aria-disabled','true');}
  }
}

function setPostPaymentTripConfigurationLocked(locked=true){
  const isLocked=Boolean(locked);
  setSavedSetupLocked(isLocked);
  // Payment freezes the trip definition (travelers + Trip Story), not the
  // post-payment Preferences workspace. Preferences remain editable until the
  // user explicitly starts itinerary generation.
  const build=qs('#build-trip-story');
  if(build){build.disabled=isLocked;build.setAttribute('aria-disabled',String(isLocked));build.classList.toggle('is-payment-locked',isLocked);}
  const edit=qs('#edit-trip-story');
  if(edit){edit.disabled=isLocked;edit.setAttribute('aria-disabled',String(isLocked));edit.classList.toggle('is-payment-locked',isLocked);}
  qs('#trip-story-summary')?.classList.toggle('is-payment-locked',isLocked);
}

function showPreferencesStage(){
  if(!$preferencesStage || !currentTripId) return;

  // Do not lock here: this screen can be reached before payment in non-commerce/test flows.
  // Locking is applied only after a positive server payment/admin-bypass entitlement.
  const canonicalStory=plannerState?.travelModelV2?.trip_story || _travelV2()?.state?.tripStory || null;
  if(canonicalStory){
    _travelV2()?.setTripStory?.(canonicalStory);
    if(plannerState){plannerState.travelModelV2=_currentTravelModelV2_();plannerState.travelModelV2.trip_story=JSON.parse(JSON.stringify(canonicalStory));}
  }

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
    $start.classList.remove('is-ready');
    $start.dataset.itbmoConsumed='1';
  }

  const engine=_travelV2();
  const prefHost=qs('#preferences-v2-host');
  if(engine && prefHost){
    // Entering Preferences is an editable post-payment phase. A prior route
    // lock must never leak into this editor. Generation itself locks it later.
    engine.setLocked?.(false);
    if(plannerState?.travelModelV2) engine.restore?.(plannerState.travelModelV2,qsa('.city-row',$cityList));
    engine.renderPreferences(prefHost,savedDestinations,plannerState?.travelModelV2 || _currentTravelModelV2_(),()=>{
      plannerState.preferencesV2=engine.preferencesPayload();
      plannerState.itineraryLang=engine.state?.itineraryLanguage || plannerState.itineraryLang || '';
      if($preferencesField) $preferencesField.value=engine.specialConditionsText();
      const ready=engine.allRequiredPreferencesComplete(savedDestinations,plannerState?.travelModelV2 || _currentTravelModelV2_());
      if($preferencesContinue){
        $preferencesContinue.disabled=!ready;
        $preferencesContinue.setAttribute('aria-disabled',String(!ready));
      }
    });
    plannerState.preferencesV2=engine.preferencesPayload();
    const ready=engine.allRequiredPreferencesComplete(savedDestinations,plannerState?.travelModelV2 || _currentTravelModelV2_());
    if($preferencesContinue){$preferencesContinue.disabled=!ready;$preferencesContinue.setAttribute('aria-disabled',String(!ready));}
  }

  requestAnimationFrame(()=>{
    autoGrowPreferencesField();

    /* Preferences must always open at the beginning of the stage. */
    const target=$preferencesStage;
    if(target){
      const rect=target.getBoundingClientRect();
      const current=window.scrollY || document.documentElement.scrollTop || 0;
      window.scrollTo({top:Math.max(0,current + rect.top - 18),behavior:'smooth'});
    }
  });
  scheduleAstraCoach('preferences','#preferences-stage',520);
  requestAnimationFrame(()=>openGuidedPersonalizationJourney());
}

async function confirmPreferencesAndContinue(){
  if(!$preferencesStage || !currentTripId) return;
  if(preferencesStageTripId!==currentTripId) return;

  const engine=_travelV2();
  const model=plannerState?.travelModelV2 || _currentTravelModelV2_();
  if(engine && !engine.allRequiredPreferencesComplete(savedDestinations,model)){
    alert(getLang()==='es'
      ? 'Completa hospedaje y transporte para cada destino o estancia antes de generar.'
      : 'Complete lodging and transport for every destination or stay before generating.');
    return;
  }

  if(engine){
    plannerState.preferencesV2=engine.preferencesPayload();
    plannerState.itineraryLang=engine.state?.itineraryLanguage || (getLang()==='es'?'Español':'English');
    plannerState.specialConditions=engine.specialConditionsText();
    if($preferencesField) $preferencesField.value=plannerState.specialConditions;

    // Preserve the existing cityMeta contract for main destinations while the
    // richer V2 preferences remain available to route-aware generation.
    savedDestinations.forEach(dest=>{
      const pref=plannerState.preferencesV2?.places?.[String(dest.city||'').trim().toLowerCase()] || {};
      if(!cityMeta[dest.city]) cityMeta[dest.city]={baseDate:dest.baseDate||null,start:null,end:null,hotel:'',transport:'',perDay:dest.perDay||[]};
      cityMeta[dest.city].hotel=pref.lodgingChoice==='recommend' ? 'recommend me' : (pref.lodgingText || pref.lodgingChoice || 'recommend me');
      cityMeta[dest.city].transport=pref.localTransport || pref.arrivalTransport || 'recommend me';
    });
  }else{
    plannerState.specialConditions=String($preferencesField?.value || '').trim();
  }

  preferencesConfirmedTripId=currentTripId;
  if($preferencesField){$preferencesField.readOnly=true;$preferencesField.setAttribute('aria-readonly','true');}
  $preferencesStage.classList.add('is-confirmed');
  if($preferencesContinue){
    $preferencesContinue.disabled=true;
    $preferencesContinue.setAttribute('aria-disabled','true');
    $preferencesContinue.textContent=getLang()==='es' ? '✓ Preferencias guardadas' : '✓ Preferences saved';
  }

  // Planner Chat is no longer used as a structural data-entry step in V2.
  collectingHotels=false;
  plannerState.collectingItineraryLang=false;
  if($chatBox) $chatBox.style.display='none';
  setPlanningChatLocked(true);

  showPreferencesSaveOverlay();
  try{
    await _persistPostPaymentProgress_('preferences_confirmed');
  }catch(err){
    console.error('[ITBMO] preferences save failed',err);
    preferencesConfirmedTripId=null;
    $preferencesStage.classList.remove('is-confirmed');
    if($preferencesField){$preferencesField.readOnly=false;$preferencesField.removeAttribute('aria-readonly');}
    if($preferencesContinue){
      $preferencesContinue.disabled=false;
      $preferencesContinue.removeAttribute('aria-disabled');
      $preferencesContinue.textContent=getLang()==='es'?'Guardar preferencias':'Save preferences';
    }
    alert(getLang()==='es'?'No pudimos guardar tus preferencias. Inténtalo nuevamente.':'We could not save your preferences. Please try again.');
    return;
  }finally{
    hideSaveTransitionOverlay();
  }
  if($preferencesGenerateV2){
    $preferencesGenerateV2.hidden=false;
    $preferencesGenerateV2.disabled=false;
    $preferencesGenerateV2.removeAttribute('aria-disabled');
    $preferencesGenerateV2.textContent=getLang()==='es'?'Generar mi itinerario ✨':'Generate my itinerary ✨';
  }
  const guided=document.querySelector('#guided-personalization-overlay');
  if(guided && typeof window._itbmoGuidedPreferencesReady==='function'){
    window._itbmoGuidedPreferencesReady();
    return;
  }
  const generateNow=await showPreferencesReadyModal();
  if(generateNow){
    requestAnimationFrame(()=>{
      if($preferencesGenerateV2 && !$preferencesGenerateV2.disabled) $preferencesGenerateV2.click();
    });
  }else if($preferencesGenerateV2){
    requestAnimationFrame(()=>smoothAdvanceTo($preferencesGenerateV2,{gap:110,center:true}));
  }
}

async function startV2PaidGeneration(){
  if(!currentTripId || preferencesConfirmedTripId!==currentTripId) return;
  _travelV2()?.setLocked?.(true);
  const prefHost=qs('#preferences-v2-host');
  if(prefHost){
    prefHost.classList.add('is-readonly');
    _travelV2()?.renderPreferences?.(prefHost,savedDestinations,plannerState?.travelModelV2 || _currentTravelModelV2_(),()=>{});
  }
  if($preferencesGenerateV2){
    $preferencesGenerateV2.disabled=true;
    $preferencesGenerateV2.setAttribute('aria-disabled','true');
    $preferencesGenerateV2.textContent=getLang()==='es'?'Generando…':'Generating…';
  }
  await _persistPostPaymentProgress_('generation_requested');
  requestAnimationFrame(()=>smoothAdvanceTo('#planner-post-generation',{gap:104,center:false}));
  setTimeout(()=>runPaidGeneration(),120);
}


function openGuidedPersonalizationJourney(){
  if(!currentTripId || document.querySelector('#guided-personalization-overlay')) return;
  const engine=_travelV2(); if(!engine) return;
  const es=getLang()==='es', model=plannerState?.travelModelV2 || _currentTravelModelV2_();
  const places=engine.placesForPreferences?.(savedDestinations,model)||[];
  if(!engine.state.itineraryLanguage) engine.state.itineraryLanguage=es?'Español':'English';
  engine.state.preferences=engine.state.preferences||{global:{notes:''},places:{}};
  engine.state.preferences.global=engine.state.preferences.global||{notes:''};
  const defaults=()=>({saved:false,lodgingChoice:'recommend',lodgingText:'',arrivalTransport:'recommend',localTransport:'recommend',pace:'balanced',interests:[],mustDo:'',avoid:'',reservations:'',notes:''});
  places.forEach(p=>{engine.state.preferences.places[p.key]=Object.assign(defaults(),engine.state.preferences.places[p.key]||{});});
  let step='global', index=0;
  const overlay=document.createElement('div'); overlay.id='guided-personalization-overlay'; overlay.className='trip-story-overlay guided-journey-overlay guided-personalization-overlay';
  overlay.innerHTML=`<div class="guided-journey" role="dialog" aria-modal="true"><header class="guided-journey__top"><div><small>ITBMO</small><h2>${es?'Crea tu viaje':'Build your trip'}</h2><p>${es?'Tu recorrido ya está listo. Ahora hagámoslo realmente tuyo.':'Your route is ready. Now let’s make it truly yours.'}</p></div><button type="button" data-gp-close>×</button></header><nav class="guided-journey__progress"><button class="is-done">${es?'Viajeros':'Travelers'}</button><i>›</i><button class="is-done">${es?'Ruta':'Route'}</button><i>›</i><button class="is-active">${es?'Personalización':'Personalization'}</button><i>›</i><button disabled>${es?'Itinerario':'Itinerary'}</button></nav><div class="guided-journey__layout"><main class="guided-journey__active" data-gp-active></main><aside class="guided-journey__story"><div class="guided-journey__story-head"><div><small>${es?'TU RECORRIDO':'YOUR JOURNEY'}</small><b>${es?'Tu viaje sigue tomando forma':'Your trip keeps taking shape'}</b></div><button type="button" id="guided-info-chat-open">Info Chat · <span data-gp-chat-left>${Number(document.querySelector('#info-chat-remaining')?.textContent?.match(/\d+/)?.[0]||0)}</span></button></div><div data-gp-story></div></aside></div><button class="guided-journey__mobile-story" type="button" data-gp-mobile>${es?'Ver mi recorrido':'View my journey'}</button></div>`;
  document.body.appendChild(overlay); document.body.classList.add('guided-preferences-open');
  const active=overlay.querySelector('[data-gp-active]'), storyHost=overlay.querySelector('[data-gp-story]');
  const shell=(eyebrow,title,copy,content,actions='')=>`<section class="gj-focus"><small class="gj-focus__eyebrow">${eyebrow}</small><h3>${title}</h3>${copy?`<p>${copy}</p>`:''}<div class="gj-focus__content">${content}</div><div class="gj-focus__actions">${actions}</div></section>`;
  const next=(label)=>`<button type="button" class="gj-primary" data-gp-next>${label}<span>→</span></button>`;
  const persist=()=>{plannerState.preferencesV2=engine.preferencesPayload();plannerState.itineraryLang=engine.state.itineraryLanguage;plannerState.specialConditions=engine.specialConditionsText();if($preferencesField)$preferencesField.value=plannerState.specialConditions;};
  const renderStory=()=>{const story=engine.state.tripStory||model?.trip_story;const bits=[];(story?.stays||[]).forEach((st,i)=>{const key=String(st.place||'').trim().toLowerCase(),pref=engine.state.preferences.places[key],done=Boolean(pref?.saved);bits.push(`${i?'<div class="gj-story-line">↓</div>':''}<button type="button" class="gj-story-node gj-story-node--editable" data-gp-place="${i}"><span>${done?'✓':String(i+1).padStart(2,'0')}</span><div><b>${_tripStoryEsc_(st.place)}</b><small>${_tripStoryDMY_(st.startDate)} · ${st.days} ${es?'día(s)':'day(s)'}</small>${done?`<em>✦ ${es?'Personalizado':'Personalized'}</em>`:`<em>${es?'Pendiente de personalizar':'Personalization pending'}</em>`}</div></button>`);});storyHost.innerHTML=bits.join('');storyHost.querySelectorAll('[data-gp-place]').forEach(b=>b.onclick=()=>{index=Number(b.dataset.gpPlace);step='place';render();});};
  const render=()=>{renderStory();
    if(step==='global'){
      active.innerHTML=shell(es?'PERSONALIZACIÓN DE TU VIAJE':'PERSONALIZE YOUR TRIP',es?'¿Hay algo que debamos tener en cuenta durante todo tu viaje?':'Anything we should keep in mind throughout your trip?',es?'Es opcional. Puedes contarnos restricciones, necesidades, estilo de viaje o cualquier preferencia general.':'Optional. Tell us about restrictions, needs, travel style or any general preference.',`<textarea class="gj-premium-textarea" data-gp-global placeholder="${es?'Ej.: ritmo tranquilo, viajamos con niños, priorizar experiencias locales…':'E.g. relaxed pace, traveling with children, prioritize local experiences…'}">${_tripStoryEsc_(engine.state.preferences.global.notes||'')}</textarea>`,next(es?'Continuar':'Continue'));active.querySelector('[data-gp-next]').onclick=()=>{engine.state.preferences.global.notes=active.querySelector('[data-gp-global]').value;persist();step='place';index=0;render();};return;
    }
    if(step==='place'){
      const place=places[index]; if(!place){step='language';render();return;} const pref=engine.state.preferences.places[place.key];
      active.innerHTML=shell(es?'UNA PARADA A LA VEZ':'ONE STOP AT A TIME',es?`Personalicemos ${_tripStoryEsc_(place.name)}`:`Let’s personalize ${_tripStoryEsc_(place.name)}`,es?'Indica sólo lo que sepas. “Recomiéndame” es una respuesta válida: ITBMO resolverá el resto.':'Tell us only what you know. “Recommend” is a valid answer: ITBMO will resolve the rest.',`<div class="gj-form"><label>${es?'Hospedaje':'Lodging'}<select data-gpp="lodgingChoice"><option value="recommend">${es?'Aún no lo tengo · usa una zona base conveniente':'Not set yet · use a convenient base area'}</option><option value="hotel">${es?'Tengo hotel/alojamiento':'I have lodging'}</option><option value="area">${es?'Sé la zona aproximada':'I know the approximate area'}</option><option value="address">${es?'Tengo dirección / ubicación':'I have an address/location'}</option></select></label><label>${es?'Nombre, zona o dirección (opcional)':'Name, area or address (optional)'}<input data-gpp="lodgingText" value="${_tripStoryEsc_(pref.lodgingText||'')}"></label><label>${es?'Cómo llegarás':'How you will arrive'}<select data-gpp="arrivalTransport"><option value="recommend">${es?'Recomiéndame':'Recommend'}</option><option value="train">${es?'Tren':'Train'}</option><option value="bus">Bus</option><option value="plane">${es?'Avión':'Plane'}</option><option value="car">${es?'Automóvil':'Car'}</option><option value="transfer">Transfer</option><option value="ferry">Ferry</option><option value="other">${es?'Otro':'Other'}</option></select></label><label>${es?`Cómo te moverás en ${_tripStoryEsc_(place.name)}`:`How you will get around ${_tripStoryEsc_(place.name)}`}<select data-gpp="localTransport"><option value="recommend">${es?'Recomiéndame':'Recommend'}</option><option value="walk">${es?'A pie':'Walking'}</option><option value="public">${es?'Transporte público':'Public transport'}</option><option value="car">${es?'Automóvil':'Car'}</option><option value="taxi">Taxi / Uber</option><option value="mixed">${es?'Mixto':'Mixed'}</option></select></label><label>${es?'Ritmo':'Pace'}<select data-gpp="pace"><option value="relaxed">${es?'Relajado':'Relaxed'}</option><option value="balanced">${es?'Equilibrado':'Balanced'}</option><option value="intense">${es?'Intenso':'Intense'}</option></select></label></div><div class="gj-pref-optional"><b>${es?'Afinar esta parada · opcional':'Fine-tune this stop · optional'}</b><label>${es?'Imprescindibles':'Must-do'}<textarea data-gpp="mustDo">${_tripStoryEsc_(pref.mustDo||'')}</textarea></label><label>${es?'Reservas confirmadas':'Confirmed reservations'}<textarea data-gpp="reservations">${_tripStoryEsc_(pref.reservations||'')}</textarea></label><label>${es?'Quiero evitar':'I want to avoid'}<textarea data-gpp="avoid">${_tripStoryEsc_(pref.avoid||'')}</textarea></label><label>${es?'Algo más':'Anything else'}<textarea data-gpp="notes">${_tripStoryEsc_(pref.notes||'')}</textarea></label></div>`,next(index===places.length-1?(es?'Guardar y continuar':'Save and continue'):(es?'Guardar y siguiente destino':'Save and next stop')));
      active.querySelectorAll('[data-gpp]').forEach(el=>{if(el.tagName==='SELECT')el.value=pref[el.dataset.gpp]||'recommend';});active.querySelector('[data-gp-next]').onclick=()=>{active.querySelectorAll('[data-gpp]').forEach(el=>pref[el.dataset.gpp]=el.value);pref.saved=true;engine.state.preferences.places[place.key]=pref;persist();index+=1;step=index>=places.length?'language':'place';render();requestAnimationFrame(()=>active.scrollTo({top:0,behavior:'smooth'}));};return;
    }
    if(step==='language'){
      const langs=['Español','English','Français','Italiano','Deutsch','Português','Nederlands','Català','日本語','한국어','中文','Русский','العربية'];
      active.innerHTML=shell(es?'ÚLTIMO DETALLE':'ONE LAST DETAIL',es?'¿En qué idioma quieres tu itinerario?':'What language would you like your itinerary in?',es?'Puedes cambiarlo aquí sin modificar el idioma de la interfaz.':'You can change it here without changing the interface language.',`<div class="gj-form"><label class="gj-full">${es?'Idioma del itinerario':'Itinerary language'}<select data-gp-language>${langs.map(x=>`<option ${engine.state.itineraryLanguage===x?'selected':''}>${x}</option>`).join('')}</select></label></div>`,next(es?'Revisar personalización':'Review personalization'));active.querySelector('[data-gp-next]').onclick=()=>{engine.state.itineraryLanguage=active.querySelector('[data-gp-language]').value;persist();step='review';render();};return;
    }
    if(step==='review'){
      const done=places.filter(p=>engine.state.preferences.places[p.key]?.saved).length;
      active.innerHTML=shell(es?'TODO LISTO':'ALL SET',es?'Tu viaje está listo para ser creado':'Your trip is ready to be created',es?'Revisa el resumen. Puedes volver a cualquier destino desde “Tu recorrido” antes de generar.':'Review the summary. You can reopen any stop from “Your journey” before generating.',`<div class="gj-review-stats"><div><b>${places.length}</b><span>${es?'destinos':'destinations'}</span></div><div><b>${done}</b><span>${es?'personalizados':'personalized'}</span></div><div><b>${_tripStoryEsc_(engine.state.itineraryLanguage)}</b><span>${es?'idioma':'language'}</span></div></div>`,next(es?'Guardar personalización':'Save personalization'));active.querySelector('[data-gp-next]').onclick=()=>{persist();confirmPreferencesAndContinue();};return;
    }
    if(step==='ready'){
      active.innerHTML=shell(es?'TU VIAJE ESTÁ LISTO':'YOUR TRIP IS READY',es?'Todo está preparado para crear tu itinerario':'Everything is ready to create your itinerary',es?'ITBMO utilizará tu recorrido, movimientos, excursiones y preferencias.':'ITBMO will use your route, movements, day trips and preferences.',`<div class="gj-ready-card">✦ ${es?'La personalización quedó guardada.':'Your personalization has been saved.'}</div>`,next(es?'Crear mi itinerario':'Create my itinerary'));active.querySelector('[data-gp-next]').onclick=()=>{overlay.querySelector('[data-stage="itinerary"]')?.classList.add('is-active');startV2PaidGeneration();};return;
    }
  };
  window._itbmoGuidedPreferencesReady=()=>{step='ready';render();};
  overlay.querySelector('[data-gp-close]').onclick=()=>{overlay.remove();document.body.classList.remove('guided-preferences-open');delete window._itbmoGuidedPreferencesReady;};
  overlay.querySelector('[data-gp-mobile]').onclick=()=>overlay.querySelector('.guided-journey__story').classList.toggle('is-mobile-open');
  overlay.querySelector('#guided-info-chat-open').onclick=()=>document.querySelector('#info-chat-floating')?.click();
  render();
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
        ? `No pudimos confirmar con seguridad el destino “${item.city}”. Revísalo e indica también el país.`
        : `We could not safely confirm the destination “${item.city}”. Please review it and include the country.`;
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

function ensureSaveTransitionOverlay(){
  let overlay=qs('#itbmo-save-transition-overlay');
  if(overlay) return overlay;

  overlay=document.createElement('div');
  overlay.id='itbmo-save-transition-overlay';
  overlay.className='itbmo-save-transition-overlay';
  overlay.setAttribute('aria-hidden','true');
  overlay.innerHTML=`
    <div class="itbmo-save-transition-card" role="status" aria-live="polite" aria-atomic="true">
      <div class="itbmo-route-loader" aria-hidden="true">
        <span class="itbmo-route-loader__halo"></span>
        <span class="itbmo-route-loader__line"></span>
        <span class="itbmo-route-loader__node itbmo-route-loader__node--1"></span>
        <span class="itbmo-route-loader__node itbmo-route-loader__node--2"></span>
        <span class="itbmo-route-loader__node itbmo-route-loader__node--3"></span>
        <span class="itbmo-route-loader__star">✦</span>
      </div>
      <div class="itbmo-save-transition-eyebrow"></div>
      <div class="itbmo-save-transition-title"></div>
      <div class="itbmo-save-transition-subtitle"></div>
    </div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function showSaveTransitionOverlay(){
  const overlay=ensureSaveTransitionOverlay();
  const es=getLang()==='es';
  const eyebrow=qs('.itbmo-save-transition-eyebrow',overlay);
  const title=qs('.itbmo-save-transition-title',overlay);
  const subtitle=qs('.itbmo-save-transition-subtitle',overlay);
  if(eyebrow) eyebrow.textContent=es?'TU RUTA ESTÁ TOMANDO FORMA':'YOUR ROUTE IS TAKING SHAPE';
  if(title) title.textContent=es?'Organizando tus destinos':'Organizing your destinations';
  if(subtitle) subtitle.textContent=es?'Validamos ciudades, fechas y tiempos para dejar todo listo para el siguiente paso.':'We are validating cities, dates and timing so everything is ready for the next step.';
  overlay.classList.add('active');
  overlay.setAttribute('aria-hidden','false');
  document.documentElement.classList.add('itbmo-save-transition-open');
}

function hideSaveTransitionOverlay(){
  const overlay=qs('#itbmo-save-transition-overlay');
  if(!overlay) return;
  overlay.classList.remove('active');
  overlay.setAttribute('aria-hidden','true');
  document.documentElement.classList.remove('itbmo-save-transition-open');
}

function showPreferencesSaveOverlay(){
  const overlay=ensureSaveTransitionOverlay();
  const es=getLang()==='es';
  const eyebrow=qs('.itbmo-save-transition-eyebrow',overlay);
  const title=qs('.itbmo-save-transition-title',overlay);
  const subtitle=qs('.itbmo-save-transition-subtitle',overlay);
  if(eyebrow) eyebrow.textContent=es?'PERSONALIZANDO TU VIAJE':'PERSONALIZING YOUR TRIP';
  if(title) title.textContent=es?'Guardando tus preferencias…':'Saving your preferences…';
  if(subtitle) subtitle.textContent=es?'Estamos preparando todo para personalizar tu itinerario.':'We are preparing everything to personalize your itinerary.';
  overlay.classList.add('active');
  overlay.setAttribute('aria-hidden','false');
  document.documentElement.classList.add('itbmo-save-transition-open');
}

async function showPreferencesReadyModal(){
  const es=getLang()==='es';
  return showPlannerDecision({
    title:es?'Tus preferencias están listas':'Your preferences are ready',
    message:es
      ? 'Guardamos cómo quieres vivir este viaje. ITBMO ya puede organizar la ruta completa con tus tiempos, movimientos y preferencias.'
      : 'We saved how you want to experience this trip. ITBMO can now organize the complete route around your timing, movements and preferences.',
    cancelLabel:es?'Revisar preferencias':'Review preferences',
    confirmLabel:es?'Generar mi itinerario ✨':'Generate my itinerary ✨'
  });
}

async function showRouteReadyModal(){
  const es=getLang()==='es';
  return showPlannerDecision({
    title:es?'Tu ruta está lista para continuar':'Your route is ready to continue',
    message:es
      ? 'Tu historia, fechas, movimientos y excursiones quedaron guardados. Puedes volver a editar el recorrido antes de generar. El siguiente paso es completar la información que personalizará tu itinerario.'
      : 'Your trip story, dates, movements and day trips are saved. You can edit the journey again before generation. Next, complete the information that will personalize your itinerary.',
    cancelLabel:es?'Revisar mi ruta':'Review my route',
    confirmLabel:es?'Iniciar itinerario →':'Start itinerary →'
  });
}

async function saveDestinations({showReadyModal=true,fromTripStory=false}={}){
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

  if(!fromTripStory && !validateBaseDatesDMY()) return;

  const rows = qsa('.city-row', $cityList);
  if(rows.length>MAX_ITINERARY_CITIES){
    alert(getLang()==='es'
      ? 'Puedes incluir un máximo de 3 destinos por generación.'
      : 'You can include a maximum of 3 destinations per generation.');
    updateAddCityButtonState();
    return;
  }
  let list = [];
  let invalidCountryRow=null;
  let invalidDaysRow=null;

  rows.forEach(r=>{
    const city     = qs('.city',r).value.trim();
    const countryInput=qs('.country',r);
    const countryMatch=_countryMatch_(countryInput?.value || '');
    const country  = countryMatch?.label || String(countryInput?.value || '').trim();
    const daysVal  = qs('.days',r).value;
    const days     = Math.max(1, parseInt(daysVal||'0',10)||1);
    const baseDate = qs('.baseDate',r).value.trim();

    if(days > MAX_DAYS_PER_DESTINATION){
      invalidDaysRow=invalidDaysRow || r;
      return;
    }

    if(!city) return;
    if(!countryMatch){
      invalidCountryRow=invalidCountryRow || r;
      countryInput?.classList.add('itbmo-field-error');
      return;
    }
    countryInput?.classList.remove('itbmo-field-error');

    const perDay = [];
    qsa('.hours-day', r).forEach((hd, idx)=>{
      const start = qs('.start',hd).value || DEFAULT_START;
      const end   = qs('.end',hd).value   || DEFAULT_END;
      perDay.push({ day: idx+1, start, end });
    });
    if(perDay.length===0){
      for(let d=1; d<=days; d++) perDay.push({day:d,start:DEFAULT_START,end:DEFAULT_END});
    }

    list.push({ city, country, countryCode:countryMatch?.code || '', days, baseDate, perDay });
  });

  if(invalidCountryRow){
    alert(getLang()==='es'
      ? 'Selecciona un país válido de la lista antes de continuar.'
      : 'Select a valid country from the list before continuing.');
    try{ qs('.country',invalidCountryRow)?.focus(); }catch(_){ }
    return;
  }

  if(invalidDaysRow){
    alert(getLang()==='es'
      ? `Puedes seleccionar un máximo de ${MAX_DAYS_PER_DESTINATION} días por destino.`
      : `You can select a maximum of ${MAX_DAYS_PER_DESTINATION} days per destination.`);
    try{ qs('.days',invalidDaysRow)?.focus(); }catch(_){ }
    return;
  }

  if(list.length === 0) return;

  const routeValidation=fromTripStory ? {ok:true,errors:[]} : (_travelV2()?.validateAll?.(rows) || {ok:true,errors:[]});
  if(!routeValidation.ok){
    const first=routeValidation.errors[0];
    const targetRow=rows[Number(first?.rowIndex)||0];
    targetRow?.classList.add('shake-highlight');
    setTimeout(()=>targetRow?.classList.remove('shake-highlight'),850);
    alert((getLang()==='es'?'Revisa tu recorrido: ':'Review your route: ') + String(first?.message||''));
    try{targetRow?.scrollIntoView({behavior:'smooth',block:'center'});}catch(_){ }
    return;
  }

  if(!saveLockWarningAccepted){
    const es=getLang()==='es';
    const confirmed=await showPlannerDecision({
      title:es?'¿Todo listo para guardar?':'Ready to save?',
      message:es
        ? 'Guardaremos esta versión de tu historia. Podrás volver a editar el recorrido y ITBMO recalculará y validará los cambios antes de generar. Los viajeros confirmados permanecen protegidos para evitar cambios accidentales.'
        : 'We will save this version of your trip story. You can edit the journey again and ITBMO will recalculate and validate changes before generation. Confirmed travelers remain protected from accidental changes.',
      cancelLabel:es?'Revisar información':'Review information',
      confirmLabel:es?'Sí, guardar mi viaje':'Yes, save my trip'
    });
    if(!confirmed) return;
    saveLockWarningAccepted=true;
  }

  const previousSaveLabel = $save?.textContent || '';
  if($save){
    $save.disabled = true;
    $save.textContent = authCopy('tripSaving');
  }

  showSaveTransitionOverlay();

  try{
    list = await normalizeDestinationsBeforeSave(list, rows);
    await saveTripRecord(list, travelerState);
    hideSaveTransitionOverlay();
  }catch(err){
    hideSaveTransitionOverlay();
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
    return false;
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
  if(plannerState){
    if(fromTripStory){
      plannerState.preferencesV2=null;
      const engine=_travelV2();
      if(engine?.state){ engine.state.preferences={global:{},places:{}}; engine.state.itineraryLanguage=''; }
      preferencesStageTripId=null; preferencesConfirmedTripId=null;
    }
    plannerState.travelModelV2=_currentTravelModelV2_();
    plannerState.destinations=[...savedDestinations];
  }
  trackITBMOEvent('destinations_saved',{
    city_count:list.length,
    days_total:list.reduce((sum,item)=>sum+(Number(item?.days)||0),0)
  });
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
  $start.setAttribute('aria-disabled',String($start.disabled));
  $start.classList.toggle('is-ready',!$start.disabled);
  if(!$start.disabled){
    $start.textContent=getLang()==='es'
      ? '✦ Tu ruta está lista · Iniciar planificación →'
      : '✦ Your route is ready · Start planning →';
  }
  hasSavedOnce = true;

  if ($resetBtn) {
    if (savedDestinations.length > 0) {
      $resetBtn.removeAttribute('disabled');
    } else {
      $resetBtn.setAttribute('disabled', 'true');
    }
  }

  if(!planningStarted){
    // PRE-PAYMENT RULE: saved setup remains editable until payment/admin bypass is confirmed.
    // The payment gate is the single authority that freezes travelers + route configuration.
    setSavedSetupLocked(false);
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

  /* UX performance: warm up PayPal while the user reviews the next step. */
  if(ITBMO_COMMERCE_CONFIG?.commerceEnabled && ITBMO_COMMERCE_CONFIG?.paypal?.enabled){
    setTimeout(()=>{ loadPayPalSdk().catch(()=>{}); },0);
  }

  /* Premium handoff: confirm that the route was saved and offer the next step.
     The normal Continue CTA remains available if the user chooses to keep editing. */
  if($start && !$start.disabled){
    if(showReadyModal){
      const continueNow=await showRouteReadyModal();
      if(continueNow){
        requestAnimationFrame(()=>{ try{$start.click();}catch(_){ smoothAdvanceTo($start,{gap:132,center:true}); } });
      }else{
        requestAnimationFrame(()=>smoothAdvanceTo($start,{gap:132,center:true}));
      }
    }else{
      requestAnimationFrame(()=>smoothAdvanceTo($start,{gap:132,center:true}));
    }
  }
  return true;
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
        <td>${_v40VisibleTransportForRow_(r)}</td>
        <td>${_v39VisibleDuration_(r)}</td>
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

  // Immersive viewer launcher mirrors the already-generated state only.
  syncImmersiveItineraryLauncher();
}

/* =========================================================
   ITBMO · TRIP WORKSPACE · PHASE 2
   Presentation-only layer. Two levels:
   1) Trip overview / city gateway
   2) City Focus Mode: Itinerary | For your trip
   No API calls, no generated-row mutation, no export changes.
========================================================= */
let immersiveItineraryCity=null;
let immersiveItineraryDay=null;
let immersiveItineraryMode='itinerary';
let immersiveWorkspaceLevel='overview';
let immersiveTouchStartX=null;
let immersiveTouchStartY=null;
let immersiveRenderFrame=null;

function scheduleImmersiveItineraryRender(){
  if(immersiveRenderFrame!=null) cancelAnimationFrame(immersiveRenderFrame);
  immersiveRenderFrame=requestAnimationFrame(()=>{ immersiveRenderFrame=requestAnimationFrame(()=>{ immersiveRenderFrame=null; renderImmersiveItinerary(); }); });
}
function _immersiveViewerCopy_(){
  const es=getLang()==='es';
  return es?{
    ctaTitle:'Explora y prepara tu viaje', ctaSub:'Entra a tu viaje, elige una ciudad y descubre cada día con todo lo que necesitas para vivirlo.',
    citySingular:'ciudad',cityPlural:'ciudades',daySingular:'día',dayPlural:'días',ready:'listos para explorar',
    eyebrow:'TU VIAJE ITBMO',title:'Explora y prepara tu viaje.',subtitle:'Todo organizado por ciudad, sin perder de vista el viaje completo.',
    back:'Volver al Planner',close:'Cerrar viaje',overviewKicker:'TU RECORRIDO',overviewTitle:'¿Por dónde quieres empezar?',overviewIntro:'Abre una ciudad para recorrer su itinerario día a día y ver todo lo que conviene preparar.',
    exploreCity:'Explorar',allCities:'Todas las ciudades',cityFocus:'MODO FOCUS',itinerary:'Itinerario',prepare:'Para tu viaje',prev:'Día anterior',next:'Día siguiente',of:'de',
    details:'Ver detalles',hideDetails:'Ocultar detalles',route:'Trayecto',duration:'Duración',transport:'Transporte',notes:'Detalles',
    wholeTrip:'PARA TODO TU VIAJE',wholeTripTitle:'Lo esencial que viaja contigo.',wholeTripCopy:'Aquí aparecerán servicios de alcance general, únicamente cuando aporten valor real a tu viaje.',coming:'Próximamente',
    prepareTitle:'Para tu viaje',prepareIntro:'Este espacio convertirá tu itinerario en una guía práctica de lo que conviene resolver en esta ciudad.',prepareSafe:'Entradas y reservas · Tours y experiencias · Cómo moverte · Otros servicios relevantes',
    daysOrganized:'días organizados'
  }:{
    ctaTitle:'Explore and prepare your trip',ctaSub:'Enter your journey, choose a city and discover every day with what you need to make it happen.',
    citySingular:'city',cityPlural:'cities',daySingular:'day',dayPlural:'days',ready:'ready to explore',
    eyebrow:'YOUR ITBMO TRIP',title:'Explore and prepare your trip.',subtitle:'Everything organized by city, without losing sight of the whole journey.',
    back:'Back to Planner',close:'Close trip',overviewKicker:'YOUR JOURNEY',overviewTitle:'Where do you want to start?',overviewIntro:'Open a city to move through its itinerary day by day and see what is worth preparing.',
    exploreCity:'Explore',allCities:'All cities',cityFocus:'FOCUS MODE',itinerary:'Itinerary',prepare:'For your trip',prev:'Previous day',next:'Next day',of:'of',
    details:'View details',hideDetails:'Hide details',route:'Route',duration:'Duration',transport:'Transport',notes:'Details',
    wholeTrip:'FOR YOUR WHOLE TRIP',wholeTripTitle:'The essentials that travel with you.',wholeTripCopy:'Trip-level services will appear here only when they add real value to your journey.',coming:'Coming next',
    prepareTitle:'For your trip',prepareIntro:'This space will turn your itinerary into a practical guide to what is worth arranging in this city.',prepareSafe:'Tickets & reservations · Tours & experiences · Getting around · Other relevant services',
    daysOrganized:'days organized'
  };
}
function _immersiveAvailableCities_(){
  const workspace=_workspaceSnapshotViews_();
  const physical=(workspace?.destinations||[]).map(x=>x?.city).filter(Boolean);
  if(physical.length) return physical;
  const ordered=(savedDestinations||[]).map(x=>x.city).filter(Boolean);
  const extras=Object.keys(itineraries||{}).filter(c=>!ordered.includes(c));
  return [...ordered,...extras].filter(city=>Object.values(itineraries?.[city]?.byDay||{}).some(rows=>Array.isArray(rows)&&rows.length));
}
function _immersiveDaysForCity_(city){ return Object.keys(itineraries?.[city]?.byDay||{}).map(Number).filter(Number.isFinite).sort((a,b)=>a-b); }
function syncImmersiveItineraryLauncher(){
  const wrap=qs('#itinerary-focus-launch'),btn=qs('#open-itinerary-focus'); if(!wrap||!btn)return;
  const workspace=_workspaceSnapshotViews_();
  const cities=(workspace?.destinations||[]).map(d=>d.city).filter(Boolean);
  const uniqueDates=new Set();
  (workspace?.destinations||[]).forEach(d=>{const base=parseDMY(String(d?.baseDate||''));for(let i=0;i<Number(d?.days||0);i++){if(base)uniqueDates.add(formatDMY(addDays(base,i)));}});
  const fallbackCities=_immersiveAvailableCities_(),effectiveCities=cities.length?cities:fallbackCities,totalDays=uniqueDates.size||fallbackCities.reduce((sum,c)=>sum+_immersiveDaysForCity_(c).length,0),hasRows=effectiveCities.length>0&&totalDays>0,copy=_immersiveViewerCopy_();
  wrap.classList.toggle('is-ready',hasRows);wrap.setAttribute('aria-hidden',hasRows?'false':'true');btn.disabled=!hasRows;btn.setAttribute('aria-disabled',hasRows?'false':'true');
  qs('#planner-post-generation')?.classList.toggle('is-ready',hasRows);
  qs('#itinerary-focus-cta-title').textContent=copy.ctaTitle;qs('#itinerary-focus-cta-subtitle').textContent=copy.ctaSub;
  const meta=qs('#itinerary-focus-cta-meta'); if(meta)meta.textContent=hasRows?`${effectiveCities.length} ${effectiveCities.length===1?copy.citySingular:copy.cityPlural} · ${totalDays} ${totalDays===1?copy.daySingular:copy.dayPlural} · ${copy.ready}`:'';
}
function _immersiveEscapeHtml_(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
function _immersiveFormatDuration_(v,t=''){return v?_sanitizeDurationLines_(v,t):'';}
function _immersiveCityDateRange_(city){
  const data=itineraries?.[city],days=_immersiveDaysForCity_(city),base=parseDMY(data?.baseDate||cityMeta?.[city]?.baseDate||''); if(!base||!days.length)return '';
  const a=formatDMY(addDays(base,days[0]-1)),b=formatDMY(addDays(base,days[days.length-1]-1)); return a===b?a:`${a} – ${b}`;
}
function _immersiveRenderOverview_(){
  const copy=_immersiveViewerCopy_(),grid=qs('#itinerary-workspace-cities'),cities=_immersiveAvailableCities_(); if(!grid)return;
  qs('#itinerary-workspace-kicker').textContent=copy.overviewKicker;qs('#itinerary-workspace-title').textContent=copy.overviewTitle;qs('#itinerary-workspace-intro').textContent=copy.overviewIntro;
  qs('#itinerary-workspace-trip-tools-kicker').textContent=copy.wholeTrip;qs('#itinerary-workspace-trip-tools-title').textContent=copy.wholeTripTitle;qs('#itinerary-workspace-trip-tools-copy').textContent=copy.wholeTripCopy;qs('#itinerary-workspace-coming').textContent=copy.coming;
  const totalDays=cities.reduce((s,c)=>s+_immersiveDaysForCity_(c).length,0),summary=qs('#itinerary-workspace-summary'); if(summary)summary.textContent=`${effectiveCities.length} ${effectiveCities.length===1?copy.citySingular:copy.cityPlural} · ${totalDays} ${totalDays===1?copy.daySingular:copy.dayPlural}`;
  grid.innerHTML='';
  cities.forEach((city,index)=>{
    const days=_immersiveDaysForCity_(city),card=document.createElement('button');card.type='button';card.className='itinerary-workspace-city-card';
    card.innerHTML=`<span class="itinerary-workspace-city-card__number">${String(index+1).padStart(2,'0')}</span><span class="itinerary-workspace-city-card__body"><small>${_immersiveEscapeHtml_(_immersiveCityDateRange_(city))}</small><strong>${_immersiveEscapeHtml_(city)}</strong><span>${days.length} ${_immersiveEscapeHtml_(copy.daysOrganized)}</span></span><span class="itinerary-workspace-city-card__cta">${_immersiveEscapeHtml_(copy.exploreCity)} <i aria-hidden="true">→</i></span>`;
    card.addEventListener('click',()=>_immersiveEnterCity_(city));grid.appendChild(card);
  });
}
function _immersiveEnterCity_(city){
  const cities=_immersiveAvailableCities_();if(!cities.includes(city))return;immersiveItineraryCity=city;immersiveItineraryMode='itinerary';immersiveWorkspaceLevel='city';setActiveCity(city);
  const days=_immersiveDaysForCity_(city),preferred=Number(itineraries?.[city]?.currentDay);immersiveItineraryDay=days.includes(preferred)?preferred:days[0];scheduleImmersiveItineraryRender();
}
function _immersiveBackToOverview_(){immersiveWorkspaceLevel='overview';immersiveItineraryMode='itinerary';scheduleImmersiveItineraryRender();}
function _immersiveRenderDayTimeline_(city,dayNum){
  const target=qs('#itinerary-focus-day-content');if(!target)return;const rows=itineraries?.[city]?.byDay?.[dayNum]||[],copy=_immersiveViewerCopy_();target.innerHTML='';
  if(!rows.length){target.innerHTML='<p class="itinerary-focus-empty">—</p>';return;} const timeline=document.createElement('div');timeline.className='itinerary-focus-timeline';
  rows.forEach((r,index)=>{const item=document.createElement('article');item.className='itinerary-focus-activity';const duration=_v39VisibleDuration_(r);item.innerHTML=`<div class="itinerary-focus-activity__time"><strong>${_immersiveEscapeHtml_(r.start||'')}</strong><span>${_immersiveEscapeHtml_(r.end||'')}</span></div><div class="itinerary-focus-activity__rail"><i></i></div><div class="itinerary-focus-activity__card"><h4>${_immersiveEscapeHtml_(r.activity||'')}</h4><div class="itinerary-focus-activity__chips">${r.transport?`<span>${_immersiveEscapeHtml_(_v40VisibleTransportForRow_(r))}</span>`:''}${duration?`<span>${_immersiveEscapeHtml_(duration)}</span>`:''}</div><button class="itinerary-focus-detail-toggle" type="button" aria-expanded="false">${_immersiveEscapeHtml_(copy.details)} <i aria-hidden="true">＋</i></button><div class="itinerary-focus-activity__details" hidden>${r.from||r.to?`<p><b>${_immersiveEscapeHtml_(copy.route)}:</b> ${_immersiveEscapeHtml_(r.from||'')} ${r.from&&r.to?'→':''} ${_immersiveEscapeHtml_(r.to||'')}</p>`:''}${r.notes?`<p><b>${_immersiveEscapeHtml_(copy.notes)}:</b> ${_immersiveEscapeHtml_(r.notes)}</p>`:''}</div></div>`;
    const toggle=qs('.itinerary-focus-detail-toggle',item),details=qs('.itinerary-focus-activity__details',item);toggle?.addEventListener('click',()=>{const expanded=toggle.getAttribute('aria-expanded')==='true';toggle.setAttribute('aria-expanded',expanded?'false':'true');details.hidden=expanded;toggle.firstChild.textContent=(expanded?copy.details:copy.hideDetails)+' ';const icon=qs('i',toggle);if(icon)icon.textContent=expanded?'＋':'−';});timeline.appendChild(item);});target.appendChild(timeline);
}
function _immersiveRenderPrepareShell_(city){const target=qs('#itinerary-focus-day-content'),copy=_immersiveViewerCopy_();if(!target)return;target.innerHTML=`<section class="itinerary-focus-prepare-shell"><div class="itinerary-focus-prepare-mark" aria-hidden="true">✦</div><span class="itinerary-focus-prepare-city">${_immersiveEscapeHtml_(city)}</span><h4>${_immersiveEscapeHtml_(copy.prepareTitle)}</h4><p>${_immersiveEscapeHtml_(copy.prepareIntro)}</p><div class="itinerary-focus-prepare-categories"><span>🎟 <b>${getLang()==='es'?'Entradas':'Tickets'}</b></span><span>✦ <b>${getLang()==='es'?'Tours':'Tours'}</b></span><span>↗ <b>${getLang()==='es'?'Moverte':'Getting around'}</b></span><span>＋ <b>${getLang()==='es'?'Más':'More'}</b></span></div><small>${_immersiveEscapeHtml_(copy.prepareSafe)}</small></section>`;}
function _immersiveRenderDays_(){const nav=qs('#itinerary-focus-days');if(!nav)return;const days=_immersiveDaysForCity_(immersiveItineraryCity);nav.innerHTML='';nav.hidden=immersiveItineraryMode!=='itinerary';if(nav.hidden)return;days.forEach(day=>{const b=document.createElement('button');b.type='button';b.className='itinerary-focus-day-btn'+(day===immersiveItineraryDay?' active':'');b.textContent=t('uiDayTitle',day);b.addEventListener('click',()=>{immersiveItineraryDay=day;scheduleImmersiveItineraryRender();});nav.appendChild(b);});requestAnimationFrame(()=>nav.querySelector('.active')?.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'}));}
function renderImmersiveItinerary(){
  const modal=qs('#itinerary-focus-modal');if(!modal)return;const cities=_immersiveAvailableCities_();if(!cities.length){closeImmersiveItinerary();syncImmersiveItineraryLauncher();return;}const copy=_immersiveViewerCopy_();
  qs('#itinerary-focus-eyebrow').textContent=copy.eyebrow;qs('#itinerary-focus-title').textContent=copy.title;qs('#itinerary-focus-subtitle').textContent=copy.subtitle;qs('#itinerary-focus-back-label').textContent=copy.back;qs('#itinerary-focus-close').setAttribute('aria-label',copy.close);
  const overview=qs('#itinerary-workspace-overview'),cityFocus=qs('#itinerary-city-focus');overview.hidden=immersiveWorkspaceLevel!=='overview';cityFocus.hidden=immersiveWorkspaceLevel!=='city';
  if(immersiveWorkspaceLevel==='overview'){_immersiveRenderOverview_();return;}
  if(!immersiveItineraryCity||!cities.includes(immersiveItineraryCity))immersiveItineraryCity=cities[0];const days=_immersiveDaysForCity_(immersiveItineraryCity);if(!days.includes(Number(immersiveItineraryDay)))immersiveItineraryDay=days[0];
  itineraries[immersiveItineraryCity].currentDay=immersiveItineraryDay;setActiveCity(immersiveItineraryCity);const data=itineraries[immersiveItineraryCity],base=parseDMY(data?.baseDate||cityMeta?.[immersiveItineraryCity]?.baseDate||''),dateLabel=base?formatDMY(addDays(base,immersiveItineraryDay-1)):'',dayIndex=days.indexOf(immersiveItineraryDay),itineraryMode=immersiveItineraryMode==='itinerary';
  qs('#itinerary-city-focus-back-label').textContent=copy.allCities;qs('#itinerary-city-focus-kicker').textContent=copy.cityFocus;qs('#itinerary-city-focus-name').textContent=immersiveItineraryCity;qs('#itinerary-focus-mode-itinerary-label').textContent=copy.itinerary;qs('#itinerary-focus-mode-prepare-label').textContent=copy.prepare;
  const ib=qs('#itinerary-focus-mode-itinerary'),pb=qs('#itinerary-focus-mode-prepare');ib.classList.toggle('active',itineraryMode);ib.setAttribute('aria-selected',itineraryMode?'true':'false');pb.classList.toggle('active',!itineraryMode);pb.setAttribute('aria-selected',itineraryMode?'false':'true');
  qs('#itinerary-focus-city-label').textContent=immersiveItineraryCity;qs('#itinerary-focus-day-title').textContent=itineraryMode?`${t('uiDayTitle',immersiveItineraryDay)}${dateLabel?` · ${dateLabel}`:''}`:copy.prepareTitle;const count=qs('#itinerary-focus-day-count');count.hidden=!itineraryMode;count.textContent=`${dayIndex+1} ${copy.of} ${days.length}`;
  _immersiveRenderDays_();if(itineraryMode)_immersiveRenderDayTimeline_(immersiveItineraryCity,immersiveItineraryDay);else _immersiveRenderPrepareShell_(immersiveItineraryCity);
  const prev=qs('#itinerary-focus-prev'),next=qs('#itinerary-focus-next');prev.hidden=!itineraryMode;next.hidden=!itineraryMode;prev.disabled=dayIndex<=0;next.disabled=dayIndex>=days.length-1;prev.setAttribute('aria-label',copy.prev);next.setAttribute('aria-label',copy.next);
}
function _immersiveMoveDay_(delta){if(immersiveWorkspaceLevel!=='city'||immersiveItineraryMode!=='itinerary')return;const days=_immersiveDaysForCity_(immersiveItineraryCity),i=days.indexOf(Number(immersiveItineraryDay)),n=Math.max(0,Math.min(days.length-1,i+delta));if(n!==i){immersiveItineraryDay=days[n];scheduleImmersiveItineraryRender();}}
function _normalizePoiKey_(value=''){
  return String(value||'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[’'\"]/g,'').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}

function _canonicalPhysicalDestinationLabel_(value='',fallback=''){
  let label=String(value||'').trim();
  const wrapped=label.match(/^(?:alojamiento|hotel|hospedaje|accommodation|lodging)\s*[\(\[]\s*([^\)\]]+)\s*[\)\]]$/i);
  if(wrapped?.[1]) label=wrapped[1].trim();
  if(!label || /^(?:alojamiento|hotel|hospedaje|accommodation|lodging|check[- ]?in|check[- ]?out)$/i.test(label)) label=String(fallback||'').trim();
  return label;
}

function _authoritativePhysicalLocationForRow_(row,ctx={},fallback=''){
  const same=(a,b)=>_arePoiAliases_(String(a||''),String(b||''));
  const transfers=(ctx.fixed_transfers||[]).filter(t=>t?.origin&&t?.destination).slice().sort((a,b)=>String(a.departure||'99:99').localeCompare(String(b.departure||'99:99')));
  const exact=transfers.find(t=>String(t.departure||'')===String(row?.start||'')&&String(t.arrival||'')===String(row?.end||'')&&same(row?.from,t.origin)&&same(row?.to,t.destination));
  if(exact)return {place:_canonicalPhysicalDestinationLabel_(exact.origin,fallback),transfer:exact};
  const rs=_hhmmToMinutes_(row?.start),re=_hhmmToMinutes_(row?.end);
  const windows=(ctx.location_windows||[]).filter(w=>w?.type!=='fixed_transfer'&&w?.location);
  const matched=windows.find(w=>{
    const ws=_hhmmToMinutes_(w.start),we=_hhmmToMinutes_(w.end);
    return rs!=null && ws!=null && rs>=ws && (we==null || re==null || re<=we);
  });
  if(matched)return {place:_canonicalPhysicalDestinationLabel_(matched.location,fallback),window:matched};
  // Generated physical labels are advisory only. Accept one only when it is a
  // member of the deterministic route compiler's physical locations.
  const explicit=String(row?.physical_location||row?.commerce_context?.physical_destination||'').trim();
  if(explicit && windows.some(w=>same(w.location,explicit)))return {place:_canonicalPhysicalDestinationLabel_(explicit,fallback)};
  let place=_canonicalPhysicalDestinationLabel_(ctx.start_location,fallback);
  if(rs!=null)transfers.forEach(t=>{const arr=_hhmmToMinutes_(t.arrival);if(arr!=null&&rs>=arr)place=_canonicalPhysicalDestinationLabel_(t.destination,place||fallback);});
  return {place:_canonicalPhysicalDestinationLabel_(place||explicit,fallback)};
}

function _workspaceSnapshotViews_(){
  const views=new Map();
  const ensure=(name,country='')=>{
    const display=String(name||'').trim();
    if(!display)return null;
    // Workspace identity is accent/case insensitive. The route may contain
    // "Paris" and "París" in different generated rows; those are one
    // physical destination and must never become duplicate cards.
    const key=_normalizePoiKey_(display)||display.toLowerCase();
    if(!views.has(key))views.set(key,{city:display,country,dates:new Map(),source_units:new Set(),aliases:new Set([display])});
    const view=views.get(key);
    view.aliases?.add(display);
    if(!view.country&&country)view.country=country;
    return view;
  };
  const placeCountry=(place,sourceUnit)=>{
    const model=plannerState?.travelModelV2||_currentTravelModelV2_();
    const main=(savedDestinations||[]).find(d=>_arePoiAliases_(d?.city,place));
    if(main?.country)return main.country;
    for(const d of (model?.destinations||[])){
      for(const seg of (d?.route?.segments||[])){
        if(_arePoiAliases_(seg?.destination,place)&&seg?.destinationCountry)return seg.destinationCountry;
      }
    }
    return (savedDestinations||[]).find(d=>_arePoiAliases_(d?.city,sourceUnit))?.country||'';
  };
  const addRow=(place,date,row,sourceUnit)=>{
    const view=ensure(place,placeCountry(place,sourceUnit));
    if(!view||!date)return;
    if(!view.dates.has(date))view.dates.set(date,[]);
    view.dates.get(date).push({...row,workspace_source_unit:sourceUnit});
    view.source_units.add(sourceUnit);
  };
  (savedDestinations||[]).forEach(dest=>{
    const sourceUnit=dest?.city||'';
    const route=_routeV2ContextForCity_(sourceUnit)||{};
    const contexts=new Map((route.day_contexts||[]).map(ctx=>[Number(ctx.day),ctx]));
    const byDay=itineraries?.[sourceUnit]?.byDay||{};
    Object.keys(byDay).map(Number).filter(Number.isFinite).sort((a,b)=>a-b).forEach(dayNum=>{
      const date=getDayDateLabel(sourceUnit,dayNum);
      const ctx=contexts.get(dayNum)||{};
      const transfers=(ctx.fixed_transfers||[]).filter(t=>t?.origin&&t?.destination).slice().sort((a,b)=>String(a.departure||'99:99').localeCompare(String(b.departure||'99:99')));
      const finalDay=dayNum===Number(dest?.days||0);
      const terminal=transfers.find(t=>Boolean(t.terminal_arrival) || (finalDay && !_arePoiAliases_(t.destination,sourceUnit) && !transfers.some(later=>later!==t&&_arePoiAliases_(later.origin,t.destination)&&_arePoiAliases_(later.destination,sourceUnit))));
      const terminalArrival=_hhmmToMinutes_(terminal?.arrival);
      (Array.isArray(byDay[dayNum])?byDay[dayNum]:[]).forEach(row=>{
        const rs=_hhmmToMinutes_(row?.start),re=_hhmmToMinutes_(row?.end);
        if(terminalArrival!=null && rs!=null && rs>=terminalArrival) return;
        const resolved=_authoritativePhysicalLocationForRow_(row,ctx,sourceUnit);
        addRow(resolved.place,date,{...row,physical_location:resolved.place,commerce_context:{...(row?.commerce_context||{}),physical_destination:resolved.place}},sourceUnit);
      });
    });
  });
  const destinations=[];
  const workspaceItineraries={};
  const sourceMap={};
  [...views.values()].forEach(view=>{
    const dates=[...view.dates.keys()].sort((a,b)=>{
      const da=parseDMY(a),db=parseDMY(b);return (da?.getTime?.()||0)-(db?.getTime?.()||0);
    });
    if(!dates.length)return;
    const byDay={};
    dates.forEach((date,index)=>{byDay[index+1]=view.dates.get(date)||[];});
    destinations.push({city:view.city,country:view.country||'',days:dates.length,baseDate:dates[0]});
    workspaceItineraries[view.city]={baseDate:dates[0],currentDay:1,byDay};
    sourceMap[view.city]=[...view.source_units][0]||view.city;
  });
  return {destinations,itineraries:workspaceItineraries,source_map:sourceMap};
}

function openImmersiveItinerary(){
  const workspaceViews=_workspaceSnapshotViews_();
  let cities=(workspaceViews?.destinations||[]).map(d=>d?.city).filter(Boolean);
  if(!cities.length)cities=_immersiveAvailableCities_();
  if(!cities.length)return;

  /* Phase 3: the Trip Workspace is a true standalone Vercel page.
     We only hand off an immutable presentation snapshot through same-origin
     localStorage. No API call, payment state, generation state or itinerary
     row is changed here. */
  const snapshot={
    schema_version:3,
    created_at:new Date().toISOString(),
    lang:getLang()==='es'?'es':'en',
    trip_language:_plannerTripLanguage_(),
    trip_id:currentTripId || null,
    destinations:(workspaceViews.destinations||[]).map(d=>({
      city:d?.city||'',country:d?.country||'',countryCode:d?.countryCode||_countryMatch_(d?.country||'')?.code||'',days:Number(d?.days||0)||0,baseDate:d?.baseDate||null
    })).filter(d=>d.city),
    source_destinations:(savedDestinations||[]).map(d=>({city:d?.city||'',country:d?.country||'',days:Number(d?.days||0)||0,baseDate:d?.baseDate||null})).filter(d=>d.city),
    workspace_source_map:workspaceViews.source_map||{},
    city_meta:cityMeta||{},
    itineraries:workspaceViews.itineraries||{}
  };
  try{ localStorage.setItem('itbmo_trip_workspace_snapshot_v1',JSON.stringify(snapshot)); }
  catch(err){ console.warn('[ITBMO WORKSPACE SNAPSHOT]',err); }

  // Guest sessions intentionally live in sessionStorage so they do not persist
  // after the browsing session. A short-lived same-origin handoff lets a newly
  // opened Workspace receive that guest session without making it persistent.
  try{
    const guestToken=String(sessionStorage.getItem(ITBMO_GUEST_SESSION_KEY)||'').trim();
    if(guestToken){
      localStorage.setItem(ITBMO_WORKSPACE_GUEST_HANDOFF_KEY,JSON.stringify({token:guestToken,expires_at:Date.now()+60000}));
    }
  }catch(_){}

  // Explicit short-lived handoff proves that this Workspace was opened from a
  // currently authenticated Planner. It prevents a new Workspace tab from
  // mistaking its own startup for "last ITBMO surface closed".
  let workspaceHandoffId='';
  try{
    workspaceHandoffId=(globalThis.crypto?.randomUUID?.()||`handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem(`${ITBMO_WORKSPACE_OPEN_HANDOFF_KEY}:${workspaceHandoffId}`,JSON.stringify({trip_id:snapshot.trip_id||null,expires_at:Date.now()+120000}));
  }catch(_){}

  const params=new URLSearchParams();
  params.set('lang',snapshot.lang);
  if(workspaceHandoffId) params.set('handoff',workspaceHandoffId);
  if(snapshot.trip_id) params.set('trip_id',snapshot.trip_id);
  const url=`./trip-workspace.html?${params.toString()}`;
  // Post-generation CTA is a deterministic navigation, not a popup. Using the
  // current tab avoids browser popup policies and always lands on the Workspace
  // overview (all destinations) with the authenticated handoff intact.
  try{ localStorage.setItem(ITBMO_AUTH_OWNER_KEY,'workspace'); }catch(_){ }
  window.location.assign(url);
}
function closeImmersiveItinerary(){const modal=qs('#itinerary-focus-modal');if(!modal)return;if(immersiveRenderFrame!=null){cancelAnimationFrame(immersiveRenderFrame);immersiveRenderFrame=null;}modal.classList.remove('is-open');modal.setAttribute('aria-hidden','true');document.body.classList.remove('itinerary-focus-open');setTimeout(()=>qs('#open-itinerary-focus')?.focus(),40);}
function bindImmersiveItineraryViewer(){const launch=qs('#open-itinerary-focus'),modal=qs('#itinerary-focus-modal');if(!launch)return;launch.disabled=false;launch.removeAttribute('aria-disabled');if(launch.dataset.workspaceBound!=='1'){launch.dataset.workspaceBound='1';launch.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();try{openImmersiveItinerary();}catch(error){console.error('[ITBMO WORKSPACE OPEN]',error);const snapshot=localStorage.getItem('itbmo_trip_workspace_snapshot_v1');if(snapshot)window.location.assign(`./trip-workspace.html?lang=${encodeURIComponent(getLang()==='es'?'es':'en')}${currentTripId?`&trip_id=${encodeURIComponent(currentTripId)}`:''}`);}});}if(!modal){syncImmersiveItineraryLauncher();return;}qs('#itinerary-focus-back')?.addEventListener('click',closeImmersiveItinerary);qs('#itinerary-focus-close')?.addEventListener('click',closeImmersiveItinerary);qs('[data-itinerary-focus-close]')?.addEventListener('click',closeImmersiveItinerary);qs('#itinerary-city-focus-back')?.addEventListener('click',_immersiveBackToOverview_);qs('#itinerary-focus-prev')?.addEventListener('click',()=>_immersiveMoveDay_(-1));qs('#itinerary-focus-next')?.addEventListener('click',()=>_immersiveMoveDay_(1));qs('#itinerary-focus-mode-itinerary')?.addEventListener('click',()=>{immersiveItineraryMode='itinerary';scheduleImmersiveItineraryRender();});qs('#itinerary-focus-mode-prepare')?.addEventListener('click',()=>{immersiveItineraryMode='prepare';scheduleImmersiveItineraryRender();});
  modal.addEventListener('touchstart',e=>{if(immersiveWorkspaceLevel!=='city'||immersiveItineraryMode!=='itinerary')return;const p=e.touches?.[0];if(p){immersiveTouchStartX=p.clientX;immersiveTouchStartY=p.clientY;}},{passive:true});modal.addEventListener('touchend',e=>{if(immersiveTouchStartX==null)return;const p=e.changedTouches?.[0];if(!p)return;const dx=p.clientX-immersiveTouchStartX,dy=p.clientY-immersiveTouchStartY;immersiveTouchStartX=immersiveTouchStartY=null;if(Math.abs(dx)>58&&Math.abs(dx)>Math.abs(dy)*1.25)_immersiveMoveDay_(dx<0?1:-1);},{passive:true});
  document.addEventListener('keydown',e=>{if(!modal.classList.contains('is-open'))return;if(e.key==='Escape'){e.preventDefault();if(immersiveWorkspaceLevel==='city')_immersiveBackToOverview_();else closeImmersiveItinerary();}else if(e.key==='ArrowLeft')_immersiveMoveDay_(-1);else if(e.key==='ArrowRight')_immersiveMoveDay_(1);});syncImmersiveItineraryLauncher();}
bindImmersiveItineraryViewer();
// Delegated fallback: the launcher can be re-rendered/re-enabled after generation.
// A document-level handler guarantees the CTA remains functional even if its
// original node was replaced before the first bind completed.
document.addEventListener('click',event=>{
  const launch=event.target?.closest?.('#open-itinerary-focus');
  if(!launch) return;
  event.preventDefault();event.stopPropagation();
  if(launch.disabled || launch.getAttribute('aria-disabled')==='true'){ syncImmersiveItineraryLauncher(); if(launch.disabled)return; }
  try{openImmersiveItinerary();}catch(error){console.error('[ITBMO WORKSPACE OPEN FALLBACK]',error);}
});

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
  const routeModel=plannerState?.travelModelV2 || _currentTravelModelV2_();
  const routeSummary=(routeModel?.destinations||[]).flatMap(d=>(d?.route?.segments||[]).map(seg=>({
    parent:d.city,origin:seg.origin,destination:seg.destination,departure_date:seg.departureDate,departure_time:seg.departureTime||null,arrival_date:seg.arrivalDate,arrival_time:seg.arrivalTime||null,disposition:seg.disposition,nights:Number(seg.nights||0),return_date:seg.returnDepartureDate||null,return_departure:seg.returnDepartureTime||null,return_arrival:seg.returnArrivalTime||null
  })));

  return [
    `Destinations: ${list}`,
    `Route movements: ${routeSummary.length?JSON.stringify(routeSummary):'N/A'}`,
    `Travelers: ${pax}`,
    `Budget: ${budget}`,
    `Itinerary language: ${plannerState?.itineraryLang || 'N/A'}`,
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
- Validate every row mathematically: pure movement rows equal their transport time; visit rows equal transport plus activity time. Correct any significant unexplained difference.
- The activity described in a row MUST occur at that row's concrete "to" location. Never describe a visit at "from" while setting "to" to the following stop. Use a separate transfer/departure row only when operationally useful.
- Protect reservation-based and destination-anchor experiences as complete visit blocks. Ticketed attractions, spas, thermal complexes, cruises, substantial tours and similar anchors must include realistic check-in, changing/boarding, core experience and exit time where applicable. Never compress an anchor merely to insert more stops.
- Do not leave an unexplained gap immediately after an anchor experience. Either include the full experience in its activity duration, add an explicit meaningful buffer/free-time row when justified, or schedule the next row continuously.
- Apply intelligent minimum dwell time by experience type. As a global guide: major waterfalls 30–45 min, viewpoints 15–30 min, neighborhoods 45–120 min, museums 60–180 min, food markets 45–90 min, beaches 45–90 min, national parks 45–180 min and churches 20–40 min. Allow 5–10 min only for an explicitly identified photographic micro-stop.
- Major destination spas and thermal complexes normally require at least 3 hours of activity time, excluding the incoming road transfer. Small local baths may be shorter only when clearly identified as such. Large museums normally require at least 90 minutes unless the row explicitly states a selective highlights-only visit.
- Detect semantic duplicate experiences, not only matching names. Merge or remove aliases, sub-area labels and repeated experiences that deliver essentially the same visit.
- Apply the global time-window policy: day 1 must respect any provided start time; the final day must respect any provided end time; intermediate-day times are preferences that may be optimized when this materially improves the itinerary, while remaining realistic and coherent.
- TRAVEL MODEL V2: when KNOWN USER FACTS include travel_model_v2, every USER_FIXED transfer, location window and overnight base is a hard constraint. Never schedule an activity during a fixed transfer. A day may start in one place and continue in another on the same calendar date.
- A subdestination where the traveler stays one or more nights receives the SAME complete planning quality rules as a main destination: core highlights, geographic optimization, realistic meals, evening value, preferences, restrictions, day-trip reasoning, validation and repair.
- User-declared subdestinations do NOT disable the existing intelligent day-trip policy on unconstrained days. Continue recommending valuable round-trip day excursions when appropriate and when they do not conflict with the user's fixed route.
- If travel_model_v2 says the traveler sleeps in a different place, the next day starts from that real overnight base. Never teleport the traveler back to the parent city.
- place_preferences are authoritative for the named location and override generic parent-city lodging/transport assumptions for time spent there.
- If an end time is blank, choose the natural end dynamically from the destination, season, opening hours, reservations, route, meal/rest needs, traveler pace and the actual value of remaining experiences. Never extend or cut a day merely to hit a clock target. A day must still be meaningfully used: do not finish conspicuously early while strong, feasible, on-theme experiences remain. Continue later only when high-value evening content materially improves the itinerary. Any explicit user end time remains a hard boundary.
- The Day 1 start is the approximate time the traveler is ready AT the lodging after inbound travel, baggage and transfer. Complete check-in or luggage drop before sightseeing; never invent an airport, flight or inbound transfer.
- When a time or other detail is missing, infer a reasonable option without creating overlaps or inventing unsupported fixed logistics. When input is partial, complete it conservatively. When input is detailed, prioritize it and optimize around it.
- Treat the lodging, address, coordinates or area as the primary geographic base whenever provided. Minimize unnecessary transfers and begin/end at that base whenever operationally sensible.
- Treat preferences and restrictions as binding planning constraints, not merely note content. Translate them into concrete scheduling, routing, meal and activity decisions.
- Validate geography, season, useful daylight, route continuity, operational logistics and traveler fit.
- Never invent flights, airports, stations, transport modes, reservations, check-out, rental companies or vehicle-return logistics. A user-fixed movement supplies only the facts explicitly present in KNOWN USER FACTS; unknown mode/terminal/provider details must remain unknown.
- Respect every deterministic location window in KNOWN USER FACTS. A substantial 3.5+ hour window before departure or after a non-terminal arrival must contain a coherent useful sequence, not a single token activity. A terminal_arrival ends this destination at arrival and must never be expanded into tourism in the next city.
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
- Pure movement rows use kind "transport" and exactly one line: "Transport: <realistic estimate or range>".
- Visit rows use kind "activity" and exactly two lines separated by \\n:
  "Transport: <realistic estimate or range>"
  "Activity: <realistic estimate or range>"
- Never invent an activity duration for a transfer or return.
- Use localized labels in the selected itinerary language.
- Never use zero-minute values.
- The interval contains transport only for pure movement rows, or transport plus activity for visit rows.

Meals:
- Respect realistic local meal timing. On a full day that spans the local lunch period, include a real lunch/meal break unless the user explicitly prefers otherwise or a long fixed experience makes a different arrangement necessary.
- As a fallback when local customs are uncertain, place lunch roughly within 12:00–15:00; adapt to the destination's normal dining culture.
- When included, choose a concrete place or a clearly defined food district and give enough time to eat comfortably.
- Do not repeat the same named restaurant on another day.
- Dinner is optional; include it when it genuinely improves the itinerary and fits the natural rhythm of the destination and day.

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
You are the international travel-planning assistant for ITBMO.

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
- Validate every row mathematically: a pure movement row equals its transport time; a visit row equals transport plus activity. Correct any significant unexplained mismatch before output.
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
- Use kind:"transport" for a pure movement whose purpose is only getting from one place to another. Its duration has exactly one line: "Transport: ..." and its interval equals that transport time.
- Use kind:"activity" for a real visit, meal or experience. Its duration has exactly two lines separated by \\n: "Transport: ...\\nActivity: ...". The interval equals both times combined.
- Never invent check-in, settling, parking or an activity merely to force a second duration line. Never use 0m or commas to separate duration lines.
- Meals: use realistic local meal timing. A full day spanning lunch should normally include a concrete lunch/meal break; if local customs are uncertain, use roughly 12:00–15:00 as a fallback. Dinner is optional; include it when the itinerary naturally extends into the evening and it adds real value.
- Intelligent day trips: evaluate the entire stay and decide whether a nearby excursion has greater tourism value than remaining secondary city activities. Consider total trip length, core-city coverage, relative quality, transfer time, season, traveler fit and logistical coherence. Substitute only lower-priority filler, never core unmet highlights. This rule is global and destination-agnostic.
- Lodging base: when hotel, Airbnb, address, coordinates or area are provided, use them as the primary geographic anchor; minimize transfers and start/end there whenever sensible.
- Preferences/restrictions: enforce them through actual choices and timing (for example photography → golden-hour opportunities; avoid crowds → earlier slots; no driving after sunset → return before darkness; walking limits → shorter walking segments; dietary needs → suitable concrete venues; celebrations → fitting experiences). Never leave them only in notes.
- Time policy: the Day 1 start already represents the approximate time the traveler is ready AT the lodging after inbound travel, baggage and transfer. Complete check-in or luggage drop before sightseeing, but never invent an airport, flight, station or inbound transfer. The final day respects any provided end, and intermediate windows are preferences that may be optimized when beneficial. If an end time is blank, determine the natural end from real tourism value, logistics, opening hours, season, meals/rest and traveler pace. Do not stop conspicuously early while worthwhile feasible content remains, and do not add filler merely to extend the clock.
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
  const timeoutMs = 180000; // 130s (ajustable)
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
      body: JSON.stringify({ model: MODEL, messages, mode, ...(extraPayload||{}) })
    });

    if(!res.ok){
      const raw = await res.text().catch(()=> '');
      console.error(`API error (${mode}):`, res.status, res.statusText, raw);
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
You are the expert travel information assistant for ITBMO, with a natural conversational style.

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
  infoChatRequestInFlight = true;

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
        remaining:0,
        notAuthorized:true
      };
    }

    if(!res.ok || data?.ok===false){
      console.error('API error (info):', res.status, res.statusText, data);
      return {text:tone.fail,remaining:infoChatQueriesRemaining};
    }

    const answer = (data?.text || '').trim();

    infoSession.push({ role:'user',      content: text });
    infoSession.push({ role:'assistant', content: answer });
    persistInfoChatState();

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
    infoChatRequestInFlight = false;
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
function _plannerTripLanguage_(){
  const original = String(plannerState?.itineraryLang || '').trim().slice(0,80);
  if(!original) return String(plannerState?.lang || getLang() || 'en').trim().slice(0,80) || 'en';

  const raw = original.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if(/\b(es|spa|spanish|espanol|castellano)\b/.test(raw)) return 'es';
  if(/\b(en|eng|english|ingles)\b/.test(raw)) return 'en';
  if(/\b(pt|por|portuguese|portugues)\b/.test(raw)) return 'pt';
  if(/\b(fr|fre|french|francais)\b/.test(raw)) return 'fr';
  if(/\b(de|ger|german|deutsch|aleman)\b/.test(raw)) return 'de';
  if(/\b(it|ita|italian|italiano)\b/.test(raw)) return 'it';

  // Preserve any other language exactly as selected by the traveler. This
  // metadata is for generation/context understanding, not for ITBMO UI locale.
  return original;
}

function _plannerOutputLang_(){
  const selected = _plannerTripLanguage_();
  const raw = String(selected||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if(/\b(es|spa|spanish|espanol|castellano)\b/.test(raw)) return 'es';
  if(/\b(pt|por|portuguese|portugues)\b/.test(raw)) return 'pt';
  if(/\b(fr|fre|french|francais)\b/.test(raw)) return 'fr';
  if(/\b(de|ger|german|deutsch|aleman)\b/.test(raw)) return 'de';
  if(/\b(it|ita|italian|italiano)\b/.test(raw)) return 'it';
  if(/\b(en|eng|english|ingles)\b/.test(raw)) return 'en';

  // Static helper/export labels are currently localized for the six validated
  // output packs. For any other itinerary language, keep ITBMO's own labels in
  // the selected site UI language instead of falsely classifying the trip as EN.
  return getLang()==='es' ? 'es' : 'en';
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

  if(activity){
    return `${activityLabel}: ${_formatDurationBounds_(activity)}`;
  }
  if(transportFromField && !activity){
    return '';
  }

  if(s){
    return s
      .replace(/^\s*(Transport|Transporte|Trasporto)\s*:/im, `${transportLabel}:`)
      .replace(/^\s*(Activity|Actividad|Atividade|Activité|Aktivität|Attività)\s*:/im, `${activityLabel}:`)
      .replace(/\s*\|\s*(Activity|Actividad|Atividade|Activité|Aktivität|Attività)\s*:/i, `\n${activityLabel}:`)
      .replace(/\s*,\s*(Activity|Actividad|Atividade|Activité|Aktivität|Attività)\s*:/i, `\n${activityLabel}:`);
  }

  return '';
}

function _isPureTransportRow_(row={}){
  const kind=_canonicalText_(row?.kind||'');
  if(/^(transport|transfer|transit|traslado|transporte|retorno|return)$/.test(kind)) return true;
  const duration=String(row?.duration||'');
  return Boolean(_extractDurationPart_(duration,'transport')) && !_extractDurationPart_(duration,'activity');
}

function _durationTotalBounds_(duration,row={}){
  const t=_durationBoundsMinutes_(_extractDurationPart_(duration,'transport')) || _transportBoundsFromField_(row?.transport||'');
  const a=_durationBoundsMinutes_(_extractDurationPart_(duration,'activity'));
  // Activity-only rows are a valid canonical shape. The deterministic repair
  // function itself emits `Actividad/Activity: ...` when no transport time is
  // needed, so requiring BOTH transport and activity here created a self-defeating
  // QA loop: valid repaired rows were immediately reclassified as
  // DURATION_UNPARSEABLE. Pure transport rows remain transport-only; mixed rows
  // still sum both components. A non-transport row that declares only transport
  // remains invalid so QA can repair the missing activity dwell explicitly.
  if(t && _isPureTransportRow_({...row,duration})) return {min:t.min,max:t.max};
  if(a && !t) return {min:a.min,max:a.max};
  if(t && a) return {min:t.min+a.min,max:t.max+a.max};
  return null;
}

function _reconcileRowTimeline_(row={}){
  const startMin=_hhmmToMinutes_(row.start);
  let endMin=_hhmmToMinutes_(row.end);
  const total=_durationTotalBounds_(row.duration,row);
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
  const kindRaw  = r.kind ?? r.type ?? r.tipo ?? '';
  const commerceContext = (r.commerce_context && typeof r.commerce_context==='object') ? r.commerce_context : null;
  const d = Math.max(1, parseInt(r.day ?? r.dia ?? fallbackDay, 10) || 1);

  let start = String(startRaw||'').trim();
  let end = String(endRaw||'').trim();
  let startMin=_hhmmToMinutes_(start), endMin=_hhmmToMinutes_(end);
  let duration=_sanitizeDurationLines_(durRaw, trans);
  const kind=String(kindRaw||'').trim() || (_extractDurationPart_(duration,'activity') ? 'activity' : 'transport');
  let safeTransport = String(trans||'').trim();
  const declaredTransport=_durationBoundsMinutes_(_extractDurationPart_(String(durRaw||''),'transport'));
  if(declaredTransport && !_transportBoundsFromField_(safeTransport)){
    safeTransport = [safeTransport, `~${_formatDurationBounds_(declaredTransport)}`].filter(Boolean).join(' · ');
  }
  const total=_durationTotalBounds_(duration,{kind,transport:safeTransport});

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
  const safeNotes = String(notes||'').trim();
  // Cosmetic/semantic cleanup: when a row starts and ends at the same attraction,
  // a synthetic "Transport: 1 min" is not a real movement. Keep the activity
  // dwell time and transport description, but do not expose a fake transport leg.
  if(safeFrom&&safeTo&&_arePoiAliases_(safeFrom,safeTo)){
    const transportPart=_transportBoundsFromField_(safeTransport) || _durationBoundsMinutes_(_extractDurationPart_(duration,'transport'));
    if(transportPart&&transportPart.max<=1) safeTransport='';
  }
  const activityBounds=_durationBoundsMinutes_(_extractDurationPart_(duration,'activity'));
  if(kind==='transport' && activityBounds && activityBounds.max<=1) duration='';
  let safeCommerce=commerceContext ? {...commerceContext} : null;
  if(safeCommerce){
    const semanticText=_canonicalText_(`${safeActivity} ${safeTo}`);
    if(/\b(desayuno|almuerzo|comida|cena|breakfast|lunch|dinner|brunch|restaurante|restaurant|brasserie|trattoria|osteria|cafe|cafeteria)\b/i.test(semanticText)){
      safeCommerce.semantic_type='RESTAURANT';safeCommerce.ticket_need='none';safeCommerce.guided_tour_value='none';safeCommerce.commercial_eligible=false;
    }else if(/^(traslado|transfer|regreso|retorno|llegada|salida|check in|check out)\b/i.test(semanticText)){
      safeCommerce.semantic_type='LOGISTICS';safeCommerce.ticket_need='none';safeCommerce.guided_tour_value='none';safeCommerce.commercial_eligible=false;
    }else if(String(safeCommerce.semantic_type||'').toUpperCase()==='TRANSPORT' && kind==='activity'){
      // Local mobility alternatives belong to the activity and must never
      // convert that attraction into a pure-transport row.
      safeCommerce.semantic_type='NONE';
    }
  }

  return _reconcileRowTimeline_(_enforceMinimumDwell_({
    day:d,
    start,
    end,
    activity:safeActivity,
    from:safeFrom,
    to:safeTo,
    transport:safeTransport,
    duration,
    notes:safeNotes,
    kind,
    physical_location:String(r.physical_location ?? r.physicalLocation ?? commerceContext?.physical_destination ?? '').trim() || null,
    stay_unit_id:String(r.stay_unit_id ?? r.stayUnitId ?? '').trim() || null,
    planning_window_id:String(r.planning_window_id ?? r.planningWindowId ?? '').trim() || null,
    commerce_context:safeCommerce
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
  showWOW(true, 'ITBMO está reequilibrando la ciudad…');
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
    ? `<span class="astra-overlay-hero"><strong>✨ ITBMO está investigando, organizando y optimizando tu itinerario</strong><span>Ciudad por ciudad. Día por día.</span></span><span class="astra-overlay-time"><span class="astra-overlay-time-label">⏳ <strong>Tiempo estimado de generación</strong></span><strong class="astra-overlay-time-ranges">Normalmente toma unos minutos · puede variar según la duración y complejidad del viaje</strong></span><span class="astra-overlay-value">ITBMO compara rutas, horarios, traslados, prioridades y tus preferencias para ahorrarte horas de investigación.<br><strong>Mantén esta pestaña abierta.</strong></span>`
    : `<span class="astra-overlay-hero"><strong>✨ ITBMO is researching, organizing and optimizing your itinerary</strong><span>City by city. Day by day.</span></span><span class="astra-overlay-time"><span class="astra-overlay-time-label">⏳ <strong>Estimated generation time</strong></span><strong class="astra-overlay-time-ranges">Usually takes a few minutes · timing may vary with trip length and complexity</strong></span><span class="astra-overlay-value">ITBMO compares routes, timing, transfers, priorities and your preferences to save you hours of research.<br><strong>Keep this tab open.</strong></span>`;
}

function showWOW(on, msg){
  if(!$overlayWOW) return;
  if(msg) setOverlayMessage(msg);

  const infoModal=qs('#info-chat-modal');

  if(on){
    /* Generation owns the viewport.
       If Info Chat was open or minimized, preserve its exact state but remove
       it completely from the generation layer until the overlay finishes. */
    if(infoModal && infoModal.dataset.generationSuspended!=='1'){
      infoModal.dataset.generationSuspended='1';
      infoModal.dataset.generationWasActive=infoModal.classList.contains('active') ? '1' : '0';
      infoModal.dataset.generationWasMinimized=infoModal.classList.contains('is-minimized') ? '1' : '0';
      infoModal.style.display='none';
      infoModal.style.pointerEvents='none';
      document.body.classList.remove('itbmo-info-open');
    }
  }

  $overlayWOW.style.display = on ? 'flex' : 'none';
  if(on) requestParentViewportFocus('loading-overlay', true);

  // Affiliate cards are anchors, not planner controls: they remain clickable
  // in a new tab while the generation request continues untouched.

  const all = qsa('button, input, select, textarea');
  all.forEach(el=>{
    // ✅ Keep only the reset button enabled
    if (el.id === 'reset-planner') return;

    // Info Chat cannot be opened while generation owns the viewport.
    if (el.id === 'info-chat-floating') {
      el.disabled = on;
      return;
    }

    if(on){
      // Generation may refresh/reassert its overlay more than once. Preserve the
      // ORIGINAL interactive state only once; otherwise a second showWOW(true)
      // would overwrite false with true and leave the whole Planner disabled
      // after generation completes.
      if(typeof el._prevDisabled === 'undefined') el._prevDisabled = el.disabled;
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

  if(!on){
    // The launcher can have been disabled before generation. Its authoritative
    // state is generated itinerary data, not the pre-generation disabled flag.
    requestAnimationFrame(()=>syncImmersiveItineraryLauncher());
  }

  if(!on && infoModal?.dataset.generationSuspended==='1'){
    const wasActive=infoModal.dataset.generationWasActive==='1';
    const wasMinimized=infoModal.dataset.generationWasMinimized==='1';

    delete infoModal.dataset.generationSuspended;
    delete infoModal.dataset.generationWasActive;
    delete infoModal.dataset.generationWasMinimized;
    infoModal.style.pointerEvents='';

    if(wasActive){
      infoModal.style.display='flex';
      infoModal.classList.add('active');
      infoModal.classList.toggle('is-minimized',wasMinimized);
      if(!wasMinimized) document.body.classList.add('itbmo-info-open');
    }else{
      infoModal.style.display='none';
      infoModal.classList.remove('active','is-minimized');
    }
  }

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

  const modelCalls=Number(usage.model_calls ?? usage.modelCalls ?? 1) || 1;
  if(input<=0 && output<=0 && total<=0) return null;
  return {input,output,total,modelCalls};
}

function _captureExactUsage_(data){
  if(!_astraGenerationMetrics_.active) return;
  const usage=_extractExactUsage_(data);
  if(!usage){
    _astraGenerationMetrics_.calls++;
    return;
  }

  _astraGenerationMetrics_.calls+=usage.modelCalls;
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

  console.log(`%c[ITBMO TIMER] FULL TRIP TOTAL: ${snapshot.total}`, 'font-weight:900;color:#087f9f;');
  console.log(`[ITBMO TIMER] Model/API calls during generation: ${snapshot.modelCalls}`);
  if(snapshot.cities.length) console.table(snapshot.cities);

  if(tokenUsageAvailable){
    console.log(
      `[ITBMO TOKENS] Input: ${snapshot.inputTokens.toLocaleString()} · Output: ${snapshot.outputTokens.toLocaleString()} · Total: ${snapshot.totalTokens.toLocaleString()}`
    );
  }else{
    console.info(
      '[ITBMO TOKENS] Exact token counts are not available because /api/chat did not expose usage metadata to the browser. No estimate was invented.'
    );
  }

  console.info(
    '[ITBMO METRICS] Type __ITBMO_LAST_GENERATION_METRICS__ in the console to inspect the last complete generation.'
  );

  return snapshot;
}

async function _callPlannerSystemPrompt_(systemPrompt, useHistory=true, mode='planner', extraPayload={}){
  const history = useHistory ? session : [];

  // V3 can legitimately perform a primary model call plus one server-side JSON
  // recovery call inside the SAME /api/chat request. The server budget is capped
  // below Vercel Hobby's Fluid Compute ceiling, so the browser must not abort the
  // request halfway through that recovery cycle. Keep this below the 300 s host cap.
  const controller = new AbortController();
  const timeoutMs = 285000;
  const timer = setTimeout(()=>{
    try{ controller.abort(new DOMException(`ITBMO planner request exceeded ${Math.round(timeoutMs/1000)}s`, 'TimeoutError')); }
    catch(_){ controller.abort(); }
  }, timeoutMs);

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

    if(mode === 'planner_v3') console.log('[ITBMO V3] API mode: planner_v3');

    const res = await fetch(API_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      signal: controller.signal,
      body: JSON.stringify({ model: MODEL, messages, mode, ...(extraPayload||{}) })
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
    const isAbort = (e && (e.name === 'AbortError' || e.name === 'TimeoutError' || String(e).toLowerCase().includes('abort') || String(e).toLowerCase().includes('timeout')));
    console.error("Failed to contact the API:", e, {name:e?.name||null,reason:controller.signal?.reason||null,timeoutMs});
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
        return _canonicalText_(blockCity) === _canonicalText_(city);
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
    first_day:'Any provided start time is a hard boundary and represents the approximate time the traveler is ready AT the lodging after inbound travel, baggage and transfer. Complete check-in or luggage drop before sightseeing.',
    final_day:'Any provided end time is a hard boundary.',
    intermediate_days:'Provided start/end times are preferences. They may be optimized only when this materially improves quality or logistics, without creating impractical hours.',
    default_end_when_missing:'No fixed end-time target. When the user leaves the end blank, choose a natural end dynamically from destination, season, opening hours, reservations, route efficiency, meals/rest, traveler pace and the value of remaining experiences. Do not finish conspicuously early while strong feasible content remains, but never add filler or overload the day merely to extend the clock. Any explicit user end time remains a hard boundary.',
    arrival_day_lodging_first:'Day 1 starts AT the lodging at the provided time. Complete check-in or luggage drop before sightseeing. Never invent an airport, flight, station or inbound transfer origin.',
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

function _calendarDatesForStay_(baseDate='',totalDays=0){
  const base=_parseBaseDate_(baseDate);
  if(!base) return [];
  return Array.from({length:Math.max(0,Number(totalDays||0))},(_,index)=>{
    const date=addDays(base,index);
    return {day:index+1,date:formatISODate(date)};
  });
}

function _specialCalendarEventPolicy_(){
  return {
    rule:'Actively inspect the real calendar date of every itinerary day for destination-relevant special dates, major public celebrations, culturally important observances or exceptional events that can materially change the best plan for that day.',
    anchor_behavior:'When such a date creates a genuinely destination-defining experience, treat the relevant celebration/event as a day anchor and organize earlier activities, routing, meals and arrival timing around it instead of allowing a generic sightseeing plan to crowd it out.',
    midnight_behavior:'For events whose defining moment occurs at or after midnight, such as New Year celebrations, keep the itinerary active through the meaningful countdown/celebration window and a reasonable immediate post-event margin when compatible with the user hard boundaries. A normal default evening target must never cause the defining moment to be missed.',
    user_precedence:'If the user specifies where or how to experience the celebration, that explicit preference is authoritative whenever safe and feasible.',
    verification:'The planning model has no live web access. Never invent an annual program, exact fireworks location, temporary closure, ticket requirement or event timetable that has not been provided. Use stable calendar knowledge conservatively, clearly mark year-specific operational details for verification when needed, and still protect the special-date experience in the schedule.',
    examples:['New Year’s Eve / New Year countdown','Christmas or major local holiday celebrations','major destination-defining festivals or public observances that coincide with the stay'],
    prohibition:'Do not hardcode destination-specific event lists. Evaluate special dates from the supplied calendar dates and destination context.'
  };
}

function _knownUserFactsForCity_(city, totalDays, perDay, baseDate, hotel, transport){
  const lodging=_normalizeLodgingInput_(hotel);
  const routeContext=_routeV2ContextForCity_(city);
  const routePlaces={};
  (routeContext?.day_contexts||[]).forEach(day=>{
    const places=[day.start_location,day.end_location,day.overnight_base];
    (day.fixed_transfers||[]).forEach(t=>places.push(t.origin,t.destination));
    places.filter(Boolean).forEach(place=>{
      const pref=_routeV2PlacePreference_(place);
      if(pref) routePlaces[place]=pref;
    });
  });
  return {
    city,
    total_days:totalDays,
    base_date:baseDate||null,
    daily_windows:perDay,
    lodging_base:lodging.normalized||null,
    lodging_original:lodging.original||null,
    lodging_normalization_applied:!!(lodging.original && lodging.normalized!==lodging.original),
    lodging_policy:'Use lodging_base as the principal geographic anchor. On Day 1, the supplied start time is when the traveler is ready at that lodging; complete check-in or luggage drop before sightseeing. Minimize unnecessary transfers and start/end there whenever sensible. Never invent airport/flight arrival details when they were not provided.',
    transport:transport||null,
    travel_model_v2:routeContext,
    place_preferences:routePlaces,
    route_policy:{
      declared_movements_are_hard_constraints:true,
      apply_full_itinerary_quality_rules_to_every_overnight_subdestination:true,
      preserve_automatic_day_trip_recommendations_when_no_user_fixed_movement_conflicts:true,
      same_day_location_changes_are_allowed:true,
      fixed_transfer_intervals_must_remain_activity_free:true,
      each_day_must_start_from_the_real_previous_overnight_base:true,
      location_windows_are_hard_physical_availability:true,
      after_arrival_use_remaining_time_productively:true,
      open_end_window_policy:'When a route arrival has no user end time, continue useful planning in that actual location for as long as worthwhile, feasible content naturally supports it. Do not stop merely because the parent city changed, and do not extend the day with filler to hit a fixed hour.',
      transfer_buffer_policy:'Before rail/bus/ferry departures, include realistic station/terminal access plus a prudent boarding buffer. Airports require materially larger buffers. Never treat the user fixed departure interval as if station access starts at that same minute.'
    },
    global_day_trip_policy:_globalDayTripPolicy_(),
    time_window_policy:_globalTimeWindowPolicy_(totalDays,perDay),
    calendar_dates:_calendarDatesForStay_(baseDate,totalDays),
    special_calendar_event_policy:_specialCalendarEventPolicy_(),
    preference_constraint_policy:_preferenceConstraintPolicy_(),
    special_conditions:(plannerState?.preferencesV2
      ? String(plannerState.preferencesV2?.global?.notes || '').trim() || null
      : String(plannerState?.specialConditions || qs('#special-conditions')?.value || '').trim() || null),
    special_conditions_instruction:'Use global special_conditions plus the structured place_preferences as authoritative user input throughout strategic distribution, activity selection, sequencing, logistics and validation. Do not duplicate them as decorative notes.',
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
ROLE: Travel-planning engine for ITBMO. Produce STRATEGIC DISTRIBUTION METADATA ONLY for "${city}".

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
- Inspect calendar_dates and apply special_calendar_event_policy before finalizing each day identity. A meaningful special-date anchor must not be displaced by generic sightseeing.
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
ROLE: Travel-planning engine for ITBMO. Generate FINAL itinerary rows ONLY for days ${dayNums.join(', ')} of "${city}".

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
- Validate every row mathematically before returning it: a pure movement interval equals transport time; a visit interval equals transport plus activity. Correct or regenerate only the inconsistent row.
- Apply intelligent minimum dwell times by experience category. Never create 5–10 minute activities except clearly labeled photographic micro-stops.
- Detect semantic duplicate experiences, including aliases and overlapping district/sub-area descriptions, and keep only the strongest representation.
- Use lodging_base as the geographic origin/end anchor whenever sensible and minimize unnecessary transfers.
- Enforce every preference/restriction through actual activity, timing, route, transport and meal choices; do not merely repeat it in notes.
- On a full day spanning lunch, reserve a realistic meal break using local dining customs (fallback roughly 12:00–15:00). On a day trip, integrate lunch along the route without breaking geographic continuity.
- Respect all user-provided hard time boundaries; optimize open windows only when beneficial. If a day has no user-provided end, choose its natural end dynamically. Require meaningful use of the available day, but never force a fixed finishing hour or add filler; continue later only when a high-value evening experience materially improves the itinerary.
- TRAVEL MODEL V2 LOCATION WINDOWS ARE HARD PHYSICAL AVAILABILITY. Generate activities in EVERY planable location window. On transfer days, treat a substantial pre-departure or post-arrival window as a real sightseeing block: do not satisfy a 3.5+ hour window with one token stop. Preserve the same destination quality and density whenever time realistically allows.
- Exception: a fixed transfer marked terminal_arrival closes the current main-destination block. Plan the origin before departure when viable, preserve access/buffer, include the fixed movement, and STOP at arrival. Do not invent sightseeing, dinner, lodging or local transport in the terminal city; the traveler must add that city as a new main destination to continue planning there.
- For a fixed transfer, finish sightseeing early enough to reach the real station/terminal/airport with a prudent operational buffer BEFORE the declared departure. For rail/bus/ferry, normally protect at least 20–30 minutes at the departure point plus realistic access time; airports require substantially more. Do not double-count the fixed transfer itself.
- Apply special_calendar_event_policy using the exact calendar_dates in KNOWN USER FACTS. When a meaningful celebration defines that date, protect it as an anchor, schedule sufficient arrival time, and continue through its defining moment (including after midnight when appropriate) unless a user hard boundary prevents it. Never fabricate year-specific event details.
- On Day 1, the supplied start time means the traveler is ready AT the lodging. Complete check-in or luggage drop before sightseeing; do not invent an airport, flight, station or inbound transfer.
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
- Use one concrete To per row. Local mobility may show one recommended/default option plus up to two genuinely useful alternatives in Transport. Estimate the door-to-door time of every option and state the deciding context concisely (effort, accessibility, weather, luggage, cost or reliability). The row's Transport duration range must use an upper bound that safely covers all listed alternatives. Do not offer ornamental options. User-fixed intercity movements remain immutable.
- Pure movement rows use kind:"transport", contain only one "Transport: ..." duration line and their interval equals that time. Visit rows use kind:"activity", contain "Transport: ...\\nActivity: ..." and their interval equals both. No overlaps and no unexplained gap over about 20 minutes.
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
- Notes are a traveler-facing intelligence layer, not filler. For every meaningful activity include concise, specific execution guidance when relevant: advance booking/timed-entry need, what to prioritize inside a large attraction, realistic seasonal/daylight or opening-hours caveats, access/logistics, practical timing, and a useful fallback or alternative only when it adds real value. Never expose engine language, internal labels, contract/window terminology or fake certainty.
- Notes must sound natural and expert. Do not repeat fixed labels such as "Emotion:" and "Tip:" on every row. Avoid generic filler such as "great for photos" unless paired with a concrete reason or operational recommendation.
- commerce_context is operational data for the contextual recommendation engine and must be precise. For every non-transport row classify semantic_type as exactly one of ATTRACTION_TICKET, TOUR_EXPERIENCE, RESTAURANT, FREE_SIGHT, LOGISTICS, NONE; set ticket_need to required/recommended/optional/none/unknown; set guided_tour_value to high/medium/low/none; and set canonical_place to the single concrete attraction/experience represented by the row. Paid interior attractions, museums, monuments, towers and access-controlled sites must not be mislabeled as FREE_SIGHT. Streets, plazas, exterior walks, viewpoints without controlled access and logistics must not be mislabeled as ticket needs.
- For pure transport rows, commerce_context must identify origin, destination, known mode, departure and arrival. For an activity's local access, commerce_context keeps the activity semantic_type and may add transport_options=[{mode, estimated_minutes, recommended, condition}]. Never relabel an attraction/activity as TRANSPORT merely because several local mobility options are shown. Never invent an operator, terminal, reservation, schedule or availability.
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
    'MISSING_AURORA_FINAL_NOTE','MISSING_USER_FIXED_TRANSFER','ACTIVITY_OVERLAPS_USER_FIXED_TRANSFER','ACTIVITY_OUTSIDE_ROUTE_LOCATION_WINDOW','ROUTE_WINDOW_UNDERUSED','ROUTE_WINDOW_TOO_THIN','UNJUSTIFIED_EXTREME_START','IMPLAUSIBLE_EARLY_INTERIOR','TRUNCATED_PLACE_TEXT'
  ]);
  const major=new Set([
    'ROW_INTERVAL_UNEXPLAINED','DURATION_UNPARSEABLE',
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

function _v40DistinctPoiExperience_(a={},b={}){
  const text=row=>_canonicalText_(`${row?.activity||''} ${row?.notes||''}`);
  const exterior=txt=>/\b(exterior|outside|facade|fachada|panoramic|panoramica|panoramica|viewpoint|mirador|photo|fotograf|paseo nocturno|night walk)\b/i.test(txt);
  const interior=txt=>/\b(interior|inside|visit|visita|museum|museo|gallery|galeria|entrada|ticket|collection|coleccion)\b/i.test(txt);
  const at=text(a),bt=text(b);
  return (exterior(at)&&interior(bt))||(interior(at)&&exterior(bt));
}

function _localGlobalAudit_(city,rows,totalDays,masterDays,perDay,baseDate='',routeContextOverride=undefined,expectedDaysOverride=undefined){
  const errors=[];
  const byDay=_rowsByDayObject_(rows);
  const seenPois=[];
  const routeContext=routeContextOverride===false ? null : (routeContextOverride || _routeV2ContextForCity_(city));
  // Local Stay QA may cover non-contiguous GLOBAL trip-day numbers. Never infer
  // missing days from the legacy parent planning-unit span when an explicit stay
  // day set is supplied. Global/full-trip callers keep the historical 1..N rule.
  const expectedAuditDays=Array.isArray(expectedDaysOverride) && expectedDaysOverride.length
    ? [...new Set(expectedDaysOverride.map(Number).filter(day=>Number.isInteger(day)&&day>=1&&day<=Number(totalDays)))].sort((a,b)=>a-b)
    : Array.from({length:Number(totalDays)||0},(_,i)=>i+1);

  for(const day of expectedAuditDays){
    const dayRows=byDay[day]||[];
    if(!dayRows.length) errors.push({code:'MISSING_DAY',day});

    const dayWindow=(perDay||[]).find(x=>Number(x?.day)===day) || {};
    const firstTourism=dayRows.find(r=>!_isUtilityRow_(r));
    const firstTourismStart=_hhmmToMinutes_(firstTourism?.start);
    if(firstTourismStart!=null && firstTourismStart<6*60 && !dayWindow?.start_provided){
      errors.push({
        code:'UNJUSTIFIED_EXTREME_START',day,start:firstTourism.start,
        instruction:'Do not begin ordinary sightseeing before 06:00 unless the user supplied that boundary or the activity is genuinely time-critical. Rebuild with a traveler-friendly start appropriate to the destination, season and local opening patterns.'
      });
    }

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

        const total=_durationTotalBounds_(r.duration,r);
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
          errors.push({code:'OVERLAP',day,row,previous_row:Math.max(1,row-1),previous_activity:dayRows[i-1]?.activity||null,previous_start:dayRows[i-1]?.start||null,previous_end:dayRows[i-1]?.end||null,activity:r.activity||null,start:r.start||null,end:r.end||null});
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
        const previousRow=dayRows[i-1]||{};
        // A pure intercity transfer is a boundary between POI-level continuity
        // and city-level route identity. Requiring the previous landmark to equal
        // the city name (or the next city name to equal the next landmark) creates
        // false CONTINUITY failures even when the physical route is valid.
        if(!_isPureTransportRow_(previousRow) && !_isPureTransportRow_(r)){
          errors.push({
            code:'CONTINUITY',
            day,row,
            previous_to:priorTo,
            current_from:r.from
          });
        }
      }
      priorTo=r.to;

      if(!_isUtilityRow_(r)){
        const poi=_poiKeyFromRow_(r);
        for(const prior of seenPois){
          if(prior.day!==day && _arePoiAliases_(poi,prior.poi) && !_v40DistinctPoiExperience_(prior.row,r)){
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
          seenPois.push({day,poi,label:r.to||r.activity,row:r});
        }
      }

      const rowText=`${r.activity||''} ${r.to||''}`;
      const looksMajorInterior=/\b(museum|museo|palace|palacio|cathedral|catedral|basilica|basílica|gallery|galeria|galería|interior|castle|castillo|archaeological|arqueolog)\b/i.test(rowText);
      if(start!=null && start<8*60 && looksMajorInterior && !dayWindow?.start_provided){
        errors.push({code:'IMPLAUSIBLE_EARLY_INTERIOR',day,row,start:r.start,activity:r.activity||null,to:r.to||null,instruction:'Do not schedule a major indoor attraction at an unusually early hour unless the user supplied that time or the contract explicitly confirms access. Use a plausible exterior/meal/walk first and place the interior visit in a realistic opening window.'});
      }
      const placeText=String(r.to||'').trim();
      const unbalancedParens=(placeText.match(/\(/g)||[]).length!==(placeText.match(/\)/g)||[]).length;
      if(unbalancedParens || /(?:\(|\/|\bor\b|\bo\b)\s*$/i.test(placeText)){
        errors.push({code:'TRUNCATED_PLACE_TEXT',day,row,to:r.to||null,instruction:'Return one complete concrete destination/place name; remove dangling alternatives or unfinished parenthetical text.'});
      }

      const genericReason=_genericPlaceReason_(r.to);
      if(genericReason){
        errors.push({code:'GENERIC_TO',day,row,to:r.to,reason:genericReason});
      }

      if(/\s\/\s|(?:^|\s)or(?=\s|$)|(?:^|\s)o(?=\s|$)|\balternative\b|\balternativa\b|\bif full\b|\bsi est[aá] lleno\b/i.test(String(r.to||''))){
        errors.push({code:'AMBIGUOUS_TO',day,row,to:r.to});
      }

      // Multiple local mobility recommendations are valid traveler guidance.
      // Timeline arithmetic already validates the declared duration range.

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

    // Open-ended days intentionally have no fixed finishing-hour QA.
    // Robustness is protected below by route-window utilization and thinness checks,
    // while the generation prompt chooses a natural end from real tourism value.

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

  // Travel Model V2 deterministic route audit. The LLM is not trusted to infer
  // fixed movements: exact user transfers must be represented and remain activity-free.
  (routeContext?.day_contexts||[]).forEach(ctx=>{
    const dayRows=byDay[Number(ctx.day)]||[];
    (ctx.fixed_transfers||[]).forEach(transfer=>{
      if(!transfer.departure || !transfer.arrival) return; // unknown times stay soft until resolved
      const fixedStart=_hhmmToMinutes_(transfer.departure);
      const fixedEnd=_hhmmToMinutes_(transfer.arrival);
      if(fixedStart==null || fixedEnd==null) return;
      const exactTransfer=dayRows.find(r=>{
        const rs=_hhmmToMinutes_(r.start), re=_hhmmToMinutes_(r.end);
        return rs===fixedStart && re===fixedEnd &&
          _arePoiAliases_(r.from,transfer.origin) && _arePoiAliases_(r.to,transfer.destination);
      });
      if(!exactTransfer){
        errors.push({
          code:'MISSING_USER_FIXED_TRANSFER',day:ctx.day,
          origin:transfer.origin,destination:transfer.destination,
          required_window:`${transfer.departure}-${transfer.arrival}`,
          instruction:'Insert one pure transport row for this exact user-fixed movement. Do not merge sightseeing or an activity into this interval.'
        });
      }
      dayRows.forEach((r,index)=>{
        const rs=_hhmmToMinutes_(r.start), re=_hhmmToMinutes_(r.end);
        if(rs==null||re==null) return;
        const overlap=Math.max(rs,fixedStart)<Math.min(re,fixedEnd);
        const isExact=rs===fixedStart&&re===fixedEnd&&_arePoiAliases_(r.from,transfer.origin)&&_arePoiAliases_(r.to,transfer.destination);
        if(overlap&&!isExact){
          errors.push({
            code:'ACTIVITY_OVERLAPS_USER_FIXED_TRANSFER',day:ctx.day,row:index+1,
            required_window:`${transfer.departure}-${transfer.arrival}`,
            instruction:'Move or remove this row. No activity may overlap a user-fixed transfer.'
          });
        }
      });
    });
    // Every deterministic location window must be used in the correct physical place.
    (ctx.location_windows||[]).forEach(window=>{
      if(window.type==='fixed_transfer' || !window.start) return;
      const ws=_hhmmToMinutes_(window.start), we=window.end?_hhmmToMinutes_(window.end):null;
      if(ws==null) return;
      const rowsInWindow=dayRows.filter(r=>{
        const rs=_hhmmToMinutes_(r.start), re=_hhmmToMinutes_(r.end);
        if(rs==null||re==null) return false;
        const insideStart=rs>=ws;
        const insideEnd=we==null ? true : re<=we;
        return insideStart&&insideEnd;
      });
      const useful=rowsInWindow.filter(r=>String(r.kind||'activity').toLowerCase()!=='transport');
      if((window.open_end||we==null) && useful.length===0 && ws < 18*60){
        errors.push({
          code:'ROUTE_WINDOW_UNDERUSED',day:ctx.day,location:window.location,available_from:window.start,
          instruction:`After arriving in ${window.location} at ${window.start}, continue useful itinerary planning there while worthwhile, feasible content naturally supports it. A missing end time is not a reason to stop early, but never add filler merely to reach a clock target.`
        });
      }
      // A transfer day can technically contain one post-arrival row and still be
      // badly under-planned. For any long deterministic location window, require
      // meaningful tourism coverage rather than accepting a token orientation stop.
      // For open-ended windows, quality is measured by meaningful tourism coverage,
      // not by forcing an arbitrary finishing hour. Closed windows use their real span.
      const availableMinutes=we==null?null:Math.max(0,we-ws);
      const usefulMinutes=useful.reduce((sum,r)=>{
        const rs=_hhmmToMinutes_(r.start),re=_hhmmToMinutes_(r.end);
        return sum+(rs!=null&&re!=null?Math.max(0,re-rs):0);
      },0);
      const chronological=useful.slice().sort((a,b)=>(_hhmmToMinutes_(a.start)??9999)-(_hhmmToMinutes_(b.start)??9999));
      if(availableMinutes!=null && availableMinutes>=240 && chronological.length){
        const firstStart=_hhmmToMinutes_(chronological[0]?.start);
        const lastEnd=_hhmmToMinutes_(chronological[chronological.length-1]?.end);
        const leadingGap=firstStart==null?0:Math.max(0,firstStart-ws);
        const trailingGap=(we==null||lastEnd==null)?0:Math.max(0,we-lastEnd);
        let largestInternalGap=0,unexplainedMealGap=0;
        for(let i=1;i<chronological.length;i++){
          const prevEnd=_hhmmToMinutes_(chronological[i-1]?.end),nextStart=_hhmmToMinutes_(chronological[i]?.start);
          if(prevEnd!=null&&nextStart!=null){
            const gap=Math.max(0,nextStart-prevEnd);largestInternalGap=Math.max(largestInternalGap,gap);
            // A substantial midday hole is usually a real meal/rest opportunity.
            // Represent it explicitly instead of making 60–90 minutes disappear,
            // but do not tighten ordinary short transitions elsewhere in the day.
            if(gap>=60 && prevEnd<14*60+30 && nextStart>12*60) unexplainedMealGap=Math.max(unexplainedMealGap,gap);
          }
        }
        if(leadingGap>=150 || trailingGap>=150 || largestInternalGap>=120 || unexplainedMealGap>=60){
          errors.push({
            code:'ROUTE_WINDOW_UNDERUSED',day:ctx.day,location:window.location,
            leading_gap_minutes:leadingGap,trailing_gap_minutes:trailingGap,largest_internal_gap_minutes:largestInternalGap,unexplained_meal_gap_minutes:unexplainedMealGap,
            instruction:`Use the substantial available time in ${window.location} coherently. Do not leave multi-hour or substantial midday gaps unexplained; represent a natural meal/rest when that is what the chronology requires, preserve a realistic non-overloaded pace, and never add filler merely to occupy time.`
          });
        }
      }
      // Open-ended evening windows are residual opportunities, not quotas. After 18:00
      // a useful dinner/walk may be appropriate, but QA must never reject an otherwise
      // coherent Stay merely to manufacture filler or hit an arbitrary minute target.
      const openWindowMinimum = we==null
        ? (ws < 12*60 ? {rows:3,minutes:240} : ws < 15*60 ? {rows:2,minutes:150} : ws < 18*60 ? {rows:1,minutes:45} : null)
        : null;
      const closedWindowTooThin=availableMinutes!=null && availableMinutes>=210 &&
        (useful.length<2 || usefulMinutes<Math.min(150,Math.round(availableMinutes*0.45)));
      const openWindowTooThin=openWindowMinimum &&
        (useful.length<openWindowMinimum.rows || usefulMinutes<openWindowMinimum.minutes);
      if(closedWindowTooThin || openWindowTooThin){
        errors.push({
          code:'ROUTE_WINDOW_TOO_THIN',day:ctx.day,location:window.location,window_start:window.start,window_end:window.end||'open',available_minutes:availableMinutes,useful_rows:useful.length,useful_minutes:usefulMinutes,minimum_useful_rows:openWindowMinimum?.rows||null,minimum_useful_minutes:openWindowMinimum?.minutes||null,
          instruction:`This usable window in ${window.location} is materially under-planned. Rebuild it with a coherent, high-value sequence sized to the real tourism opportunity, logistics and traveler pace. Include meal/rest only when appropriate; do not touch fixed transfers, force a finishing hour, or add filler.`
        });
      }
      rowsInWindow.forEach((r,index)=>{
        const text=`${r.activity||''} ${r.from||''} ${r.to||''}`;
        const knownPlaces=[city,ctx.start_location,ctx.end_location,ctx.overnight_base,...(ctx.fixed_transfers||[]).flatMap(t=>[t.origin,t.destination])].filter(Boolean);
        const stampedLocation=String(r.physical_location||r?.commerce_context?.physical_destination||'').trim();
        const stampedWindow=String(r.planning_window_id||r?.commerce_context?.planning_window_id||'').trim();
        const authoritativeMatch=(stampedWindow && String(window.window_id||'')===stampedWindow) || (stampedLocation && _arePoiAliases_(stampedLocation,window.location));
        const clearlyOther=!authoritativeMatch && knownPlaces.some(place=>!_arePoiAliases_(place,window.location)&&_arePoiAliases_(text,place));
        if(clearlyOther){
          errors.push({
            code:'ACTIVITY_OUTSIDE_ROUTE_LOCATION_WINDOW',day:ctx.day,row:index+1,
            expected_location:window.location,window_start:window.start,window_end:window.end||null,
            activity:r.activity||null,from:r.from||null,to:r.to||null,start:r.start||null,end:r.end||null,
            physical_location:r.physical_location||null,planning_window_id:r.planning_window_id||r?.commerce_context?.planning_window_id||null,
            instruction:'Move this activity into the correct physical location window or replace it with a valid activity there.'
          });
        }
      });
    });

    if(ctx.overnight_base && dayRows.length && ((ctx.fixed_transfers||[]).length || String(ctx.overnight_base||'').toLowerCase()!==String(city||'').toLowerCase())){
      const last=dayRows[dayRows.length-1];
      // Only flag a wrong overnight base when the final To clearly resolves to a
      // *different known route place*. A hotel name may not contain the city name,
      // so treating every non-alias as an error would create false repair loops.
      const knownRoutePlaces=[city,ctx.start_location,ctx.end_location,
        ...(ctx.fixed_transfers||[]).flatMap(t=>[t.origin,t.destination])
      ].filter(Boolean);
      const resolvesToDifferentKnownPlace=last?.to && knownRoutePlaces.some(place=>
        !_arePoiAliases_(place,ctx.overnight_base) && _arePoiAliases_(last.to,place)
      );
      // Overnight validation is authoritative only when the route contract itself
      // anchors the end of this day at that base. This prevents a day-trip label
      // or an intermediate station from turning into a false overnight-base loop.
      const finalWindow=[...(ctx.location_windows||[])]
        .filter(w=>w?.type!=='fixed_transfer')
        .sort((a,b)=>String(a?.start||'').localeCompare(String(b?.start||''))).at(-1);
      const fixedEndsAtBase=(ctx.fixed_transfers||[]).some(t=>_arePoiAliases_(t?.destination,ctx.overnight_base));
      const routeEndsAtBase=Boolean(finalWindow?.location && _arePoiAliases_(finalWindow.location,ctx.overnight_base));
      if(resolvesToDifferentKnownPlace && (fixedEndsAtBase || routeEndsAtBase)){
        errors.push({
          code:'WRONG_OVERNIGHT_BASE',day:ctx.day,expected:ctx.overnight_base,actual:last.to,
          instruction:'End this day at the real overnight base or include an explicit final movement to it.'
        });
      }
    }
  });

  // Departure logistics are only invented when neither the user's free-text
  // conditions nor Travel Model V2 supports them. Fixed route modes are hard facts.
  const routeFacts=JSON.stringify((routeContext?.day_contexts||[]).flatMap(ctx=>ctx.fixed_transfers||[]));
  const known=`${String(plannerState?.specialConditions||'')} ${routeFacts}`;
  const inventedDeparture=
    !/\b(flight|vuelo|plane|avion|avión|airport|aeropuerto|departure|salida|check[- ]?out|devolver|return car|rental company|europcar|hertz|avis)\b/i.test(known) &&
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
ROLE: Expert final itinerary auditor for ITBMO.

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
- When an end time is blank, there is NO fixed finishing-hour target. Choose the natural end from destination context, season, opening hours, logistics, meals/rest, traveler pace and remaining high-value experiences. Do not finish conspicuously early while worthwhile feasible content remains; do not add filler or overload the day merely to extend it. Respect any explicit user end time as a hard boundary.
- Preserve every meaningful special-date anchor required by special_calendar_event_policy. A repair must not remove or shorten the defining celebration/countdown moment merely to simplify the day, and it must not invent year-specific event details.
- The Day 1 start is when the traveler is ready AT the lodging. Complete check-in or luggage drop before sightseeing; do not invent arrival transport details.
- A full day spanning lunch should contain a realistic meal break using local dining customs; for day trips, place lunch on-route without creating backtracking.
- Re-sequence each day when needed to minimize travel time, cluster nearby areas, preserve natural route direction and avoid revisiting a completed district.
- Use one concrete To per row. Local mobility may contain one recommended/default option plus up to two contextual alternatives, each with its own time estimate; schedule against the slowest listed option. Fixed intercity movements remain single and immutable.
- Reject generic destinations such as "nearby village", "local restaurant", "services" or "similar option".
- A pure movement row contains only transport time; a visit row contains transport plus activity. Keep no more than about 20 minutes unexplained.
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

  // V3 latency rule: a clean deterministic audit must never trigger a model repair.
  // The previous flow always made at least one full-city repair call, even when the
  // generated city was already valid. That added a large token/latency tax with no
  // quality benefit. Repair only material findings; minor advisory warnings remain
  // visible to diagnostics but do not cause another large generation call.
  const initialScore=_auditScore_(currentReport);
  if(initialScore===0){
    return {rows:currentRows,report:currentReport,repaired:false};
  }

  const hasMaterialIssue=(currentReport?.errors||[]).some(error=>_auditSeverity_(error)>=4);
  if(hasMaterialIssue){
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
async function _generateCityItineraryLegacy_(city,{silentFailure=false}={}){
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
    console.log(`[ITBMO TIMER] ${city}: ${_formatGenerationDuration_(elapsed)}`);
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
    const blockingCodes=new Set(['MISSING_USER_FIXED_TRANSFER','ACTIVITY_OVERLAPS_USER_FIXED_TRANSFER','ACTIVITY_OUTSIDE_ROUTE_LOCATION_WINDOW']);
    if((finalResult.report?.errors||[]).some(error=>blockingCodes.has(error?.code))){
      throw new Error(`ROUTE_QUALITY_BLOCK:${city}`);
    }

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
    return true;
  }catch(err){
    console.error(`[CITY ${city}] v63 staged flow failed; using coherent one-shot recovery`,err);
  }

  // Coherent one-shot recovery still receives all user facts and must return the complete city.
  try{
    const facts=_knownUserFactsForCity_(city,dest.days,perDay,baseDate,hotel,transport);
    const prompt=`
${FORMAT}
ROLE: Travel-planning engine for ITBMO. Generate the COMPLETE final itinerary for "${city}" covering days 1–${dest.days}.
Return {"destination":"${city}","rows":[...],"replace":true} and JSON only.

KNOWN USER FACTS:
${JSON.stringify(facts)}

HARD RULES:
- Respect the global time policy: user-provided boundaries are hard constraints and open windows may be optimized when useful. If end is blank, choose a natural end dynamically from tourism value and real-world feasibility; do not stop conspicuously early while worthwhile content remains, and do not add filler to reach a fixed hour.
- TRAVEL MODEL V2 LOCATION WINDOWS ARE HARD. Use every meaningful pre-departure and post-arrival window in the actual physical location. After arriving in a subdestination, continue useful planning there rather than ending the day because the parent destination changed.
- Before fixed rail/bus/ferry departures, reserve realistic access to the departure point and normally at least 20–30 minutes of boarding margin; airports need materially more.
- Inspect calendar_dates and enforce special_calendar_event_policy. Protect a destination-defining special-date celebration as an anchor and continue through its defining moment, including after midnight when appropriate, unless a user hard boundary prevents it. Never fabricate year-specific event details.
- Day 1 starts AT the lodging at the user-provided time; complete check-in or luggage drop before sightseeing and do not invent airport/flight/arrival transport details.
- Use the lodging/address/coordinates/area as the primary geographic base, minimizing unnecessary transfers and returning there when sensible.
- Enforce every preference and restriction through actual planning choices, not merely notes.
- Intelligently evaluate nearby day trips against remaining secondary city content using trip length, core coverage, relative tourism value, transfer time and logistics.
- Infer sensible defaults for missing information, complete partial input conservatively and prioritize detailed instructions.
- Do not invent airport, flight, check-out, rental company or return logistics.
- Build globally distinct day identities before generating rows.
- No major POI, district, restaurant, museum, viewpoint, thermal experience or macro-route may repeat.
- Arrival and final days must be different.
- To is the place visited in the same row; the next From continues from it.
- A pure movement interval contains only transport; a visit interval contains transport plus activity. Use realistic category dwell and conservative regional transfers.
- Scenic outdoor stops must fit plausible useful daylight.
- Regional days require logical micro-stops, a realistic on-route lunch/meal break when the day spans lunch, and explicit return to the lodging/base near the applicable end time.
- Aurora, when plausible, belongs as an ADDITIONAL note in the NOTES of the FINAL row of EVERY day in that city rather than a standalone activity. This applies even when explicitly requested in Preferences.
- One concrete To per row. Local mobility may contain up to three intelligently ranked options, each with an estimated time and a useful condition; the duration upper bound must keep every option feasible.
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
    const blockingCodes=new Set(['MISSING_USER_FIXED_TRANSFER','ACTIVITY_OVERLAPS_USER_FIXED_TRANSFER','ACTIVITY_OUTSIDE_ROUTE_LOCATION_WINDOW']);
    if((finalResult.report?.errors||[]).some(error=>blockingCodes.has(error?.code))) throw new Error(`ROUTE_QUALITY_BLOCK:${city}`);
    pushRows(city,rows,true);
    itineraries[city].audit=finalResult.report;

    renderCityTabs();
    setActiveCity(city);
    renderCityItinerary(city);
    $resetBtn?.removeAttribute('disabled');
    if(plannerState?.forceReplan) delete plannerState.forceReplan[city];
    showWOW(false);
    _recordCityGenerationTime_();
    return true;
  }catch(err2){
    console.error(`[CITY ${city}] v61 recovery failed`,err2);
  }finally{
    showWOW(false);
  }

  _recordCityGenerationTime_();

  const msg=getLang()==='es'
    ? 'I could not complete a coherent itinerary. Please retry or temporarily reduce the number of days.'
    : 'I could not complete a coherent itinerary. Please retry or temporarily reduce the number of days.';
  if(!silentFailure) chatMsg(msg,'ai');
  return false;
}

/* =========================================================
   ITBMO · GENERATION ENGINE V3
   Deterministic contract -> one planning-unit model call -> deterministic
   audit -> at most one scoped repair. Legacy V2 remains above as a fallback.
========================================================= */
const ITBMO_GENERATION_ENGINE='v3';

function _v3CanonicalUserFixedTransfers_(baseDate){
  const story=_currentTravelModelV2_()?.trip_story;
  const stays=Array.isArray(story?.stays)?story.stays:[];
  const base=parseDMY(String(baseDate||''));
  if(!stays.length||!base)return [];
  const dayForDate=(iso)=>{const d=parsePlannerDate(String(iso||''));return d?Math.round((d-base)/86400000)+1:null;};
  const ledger=[];
  const push=(x)=>{
    if(!x?.origin||!x?.destination||!x?.departure||!x?.arrival||!Number.isFinite(Number(x.day)))return;
    const key=[x.day,x.origin,x.destination,x.departure,x.arrival].map(v=>String(v).trim().toLowerCase()).join('|');
    if(ledger.some(y=>y._key===key))return;
    ledger.push({...x,_key:key,user_fixed:x.source!=='ROUTE_ESTIMATED',route_estimated:x.source==='ROUTE_ESTIMATED',source:x.source||'USER_FIXED'});
  };
  for(let i=1;i<stays.length;i++){
    const st=stays[i],prev=stays[i-1];
    const date=st.departureDate||st.startDate;
    push({transfer_id:`story-main-${st.id||i}`,day:dayForDate(date),date,origin:prev.place,destination:st.place,departure:st.departureTime||'',arrival:st.arrivalTime||'',mode:st.transportMode||'other',direction:'main',source:st.transportStatus==='route_estimated'?'ROUTE_ESTIMATED':'USER_FIXED',route_resolution:st.routeResolution||null});
  }
  stays.forEach((st,si)=>(st.dayTrips||[]).forEach((dt,di)=>{
    const date=_tripStoryAddDays_(st.startDate,Math.max(0,Number(dt.day||1)-1));
    push({transfer_id:`story-daytrip-${dt.id||`${si}-${di}`}-out`,day:dayForDate(date),date,origin:st.place,destination:dt.place,departure:dt.outbound?.departureTime||'',arrival:dt.outbound?.arrivalTime||'',mode:dt.outbound?.transportMode||'other',direction:'daytrip_out',source:dt.outbound?.timeStatus==='estimated'?'ROUTE_ESTIMATED':'USER_FIXED',route_resolution:dt.routeResolution||null});
    push({transfer_id:`story-daytrip-${dt.id||`${si}-${di}`}-return`,day:dayForDate(date),date,origin:dt.place,destination:st.place,departure:dt.return?.departureTime||'',arrival:dt.return?.arrivalTime||'',mode:dt.return?.transportMode||dt.outbound?.transportMode||'other',direction:'daytrip_return',source:dt.return?.timeStatus==='estimated'?'ROUTE_ESTIMATED':'USER_FIXED',route_resolution:dt.routeResolution||null});
  }));
  // A Day Trip is a round trip by definition. Both directions are first-class
  // canonical movements, even when ITBMO (Route Resolver) estimated the times.
  // Never allow generation/recovery to continue with only the outbound half.
  stays.forEach((st,si)=>(st.dayTrips||[]).forEach((dt,di)=>{
    const stem=`story-daytrip-${dt.id||`${si}-${di}`}`;
    const out=ledger.find(x=>x.transfer_id===`${stem}-out`);
    const ret=ledger.find(x=>x.transfer_id===`${stem}-return`);
    if(!out||!ret){
      const err=new Error(`V3_DAYTRIP_LEDGER_INCOMPLETE:${st.place}:${dt.place}`);
      err.code='V3_DAYTRIP_LEDGER_INCOMPLETE';
      err.dayTrip={base:st.place,destination:dt.place,outbound:Boolean(out),return:Boolean(ret)};
      throw err;
    }
  }));
  return ledger.map(({_key,...x})=>x).sort((a,b)=>Number(a.day)-Number(b.day)||String(a.departure).localeCompare(String(b.departure)));
}

function _v3CompactContract_(city,dest,perDay,baseDate,hotel,transport){
  const route=_routeV2ContextForCity_(city) || {};
  const canonicalLedger=_v3CanonicalUserFixedTransfers_(baseDate);
  const placePreferences={};
  (route.day_contexts||[]).forEach(day=>{
    [day.start_location,day.end_location,day.overnight_base,
      ...(day.fixed_transfers||[]).flatMap(t=>[t.origin,t.destination])]
      .filter(Boolean).forEach(place=>{
        const pref=_routeV2PlacePreference_(place);
        if(pref) placePreferences[place]=pref;
      });
  });
  const lodging=_normalizeLodgingInput_(hotel);
  return {
    version:'ITBMO_GENERATION_CONTRACT_V3',
    planning_unit:city,
    total_days:Number(dest?.days||0),
    base_date:baseDate||null,
    itinerary_language:String(plannerState?.itineraryLang||getLang()||'es'),
    daily_user_windows:perDay,
    lodging_base:lodging.normalized||null,
    transport_preference:transport||null,
    route_days:(route.day_contexts||[]).map(day=>{
      const dayNum=Number(day.day);
      const isFinalDay=dayNum===Number(dest?.days||0);
      const routeTransfers=(day.fixed_transfers||[]);
      const ledgerTransfers=canonicalLedger.filter(t=>Number(t.day)===dayNum);
      const fixedTransfers=[...routeTransfers];
      ledgerTransfers.forEach(t=>{
        const exists=fixedTransfers.some(x=>String(x.origin||'').trim().toLowerCase()===String(t.origin||'').trim().toLowerCase()&&String(x.destination||'').trim().toLowerCase()===String(t.destination||'').trim().toLowerCase()&&String(x.departure||'')===String(t.departure||'')&&String(x.arrival||'')===String(t.arrival||''));
        if(!exists)fixedTransfers.push(t);
      });
      const inferredTerminalTransfer=isFinalDay
        ? fixedTransfers.find(t=>t?.destination && !_arePoiAliases_(t.destination,city) && !fixedTransfers.some(later=>later!==t && later?.origin && later?.destination && _arePoiAliases_(later.origin,t.destination) && _arePoiAliases_(later.destination,city)))
        : null;
      const terminalDestination=day.terminal_destination||inferredTerminalTransfer?.destination||null;
      const terminalOnly=Boolean(day.terminal_arrival_only||day.end_destination_block||day.terminal_transfer||inferredTerminalTransfer);
      return {
        day:dayNum,
        date:day.date||null,
        start_location:day.start_location||city,
        end_location:terminalOnly?(terminalDestination||day.end_location||day.start_location||city):(day.end_location||day.start_location||city),
        overnight_base:terminalOnly?city:(day.overnight_base||day.end_location||city),
        terminal_arrival_only:terminalOnly,
        terminal_destination:terminalDestination,
        location_windows:(day.location_windows||[]).map((w,windowIndex)=>({
          window_id:w.window_id||`day-${dayNum}-window-${windowIndex+1}`,
          location:w.location||null,
          start:w.start||null,
          end:w.end||null,
          type:w.type||'plannable',
          open_end:Boolean(w.open_end),
          terminal_arrival:Boolean(w.terminal_arrival||Boolean(inferredTerminalTransfer && w.type==='fixed_transfer' && _arePoiAliases_(w.location,`${inferredTerminalTransfer.origin} → ${inferredTerminalTransfer.destination}`)))
        })),
        fixed_transfers:fixedTransfers.map(t=>({
          origin:t.origin||null,
          destination:t.destination||null,
          departure:t.departure||null,
          arrival:t.arrival||null,
          transfer_id:t.transfer_id||null,
          direction:t.direction||null,
          user_fixed:t.source!=='ROUTE_ESTIMATED',
          route_estimated:t.source==='ROUTE_ESTIMATED',
          source:t.source||'USER_FIXED',
          route_resolution:t.route_resolution||null,
          mode:t.mode||null,
          terminal_arrival:Boolean(t.terminal_arrival||t===inferredTerminalTransfer)
        }))
      };
    }),
    movement_ledger:canonicalLedger,
    place_preferences:placePreferences,
    global_preferences:plannerState?.preferencesV2?.global||null,
    special_conditions:String(plannerState?.preferencesV2?.global?.notes || plannerState?.specialConditions || qs('#special-conditions')?.value || '').trim()||null,
    travelers:plannerState?.travelers||null,
    traveler_profiles:plannerState?.travelerProfiles||null,
    calendar_dates:_calendarDatesForStay_(baseDate,Number(dest?.days||0)),
    // Canonical Trip Story stay cards define generation units. Day Trips belong
    // to their parent stay and must never become independent generation units.
    trip_story_stays:((_currentTravelModelV2_()?.trip_story?.stays)||[]).map((st,index)=>({
      id:st.id||`story-stay-${index+1}`,
      sequence:index+1,
      place:st.place||'',
      country:st.country||'',
      startDate:st.startDate||'',
      days:Math.max(1,Number(st.days||1)),
      dayTrips:(st.dayTrips||[]).map(dt=>({
        id:dt.id||'',day:Math.max(1,Number(dt.day||1)),place:dt.place||'',country:dt.country||st.country||'',
        outbound:{...(dt.outbound||{})},return:{...(dt.return||{})}
      }))
    })),
    hard_policies:{
      fixed_movements_are_immutable:true,
      location_windows_are_physical_bounds:true,
      use_substantial_windows_productively:true,
      preserve_real_overnight_base:true,
      terminal_large_transfer_ends_block:true,
      never_invent_transport_booking_details:true,
      no_activity_during_fixed_transfer:true,
      full_itbmo_quality_applies_to_subdestinations:true
    }
  };
}

function _minutesToHuman_(minutes){
  const m=Math.max(0,Number(minutes)||0),h=Math.floor(m/60),r=m%60;
  if(h&&r) return `${h} h ${r} min`;
  if(h) return `${h} h`;
  return `${r} min`;
}

function _v3TransportLabel_(mode){
  const es=getLang()==='es';
  const labels={recommend:es?'Recomiéndame':'Recommend',train:es?'Tren':'Train',plane:es?'Avión':'Plane',bus:'Bus',car:es?'Automóvil':'Car',ferry:'Ferry',transfer:'Transfer',other:es?'Otro':'Other'};
  return labels[String(mode||'').toLowerCase()] || (es?'Por definir':'To be defined');
}

function _v3EnforceHardRouteFacts_(rows=[],contract={}){
  const es=getLang()==='es';
  let out=[...(rows||[])];
  (contract.route_days||[]).forEach(day=>{
    const dayNum=Number(day.day);
    const transfers=(day.fixed_transfers||[]).filter(t=>t.departure&&t.arrival);
    transfers.forEach(t=>{
      const dep=_hhmmToMinutes_(t.departure),arr=_hhmmToMinutes_(t.arrival);
      if(dep==null||arr==null)return;
      const duration=Math.max(0,arr-dep);
      // USER_FIXED movements are deterministic facts. Never spend a model repair
      // call trying to recreate them, and never allow generated sightseeing to
      // occupy their interval.
      out=out.filter(r=>{
        if(Number(r.day)!==dayNum) return true;
        const rs=_hhmmToMinutes_(r.start),re=_hhmmToMinutes_(r.end);
        if(rs==null||re==null) return true;
        const exact=rs===dep&&re===arr&&_arePoiAliases_(r.from,t.origin)&&_arePoiAliases_(r.to,t.destination);
        const overlaps=Math.max(rs,dep)<Math.min(re,arr);
        return exact || !overlaps;
      });
      let idx=out.findIndex(r=>Number(r.day)===dayNum&&_hhmmToMinutes_(r.start)===dep&&_hhmmToMinutes_(r.end)===arr&&_arePoiAliases_(r.from,t.origin)&&_arePoiAliases_(r.to,t.destination));
      const fixedRow={
        day:dayNum,start:t.departure,end:t.arrival,
        activity:es?`Traslado de ${t.origin} a ${t.destination}`:`Transfer from ${t.origin} to ${t.destination}`,
        from:t.origin,to:t.destination,
        transport:[_v3TransportLabel_(t.mode),`~${_minutesToHuman_(duration)}`].filter(Boolean).join(' · '),
        duration:'',
        notes:t.route_resolution?.summary
          ? `${t.route_resolution.summary}${es?' · Horario estimado para planificación; confirma las opciones reales antes de reservar.':' · Planning estimate; confirm real options before booking.'}`
          : (t.terminal_arrival
            ? (es?`Llegada prevista a ${t.destination} a las ${t.arrival}. Este traslado cierra esta etapa del viaje; para planificar ${t.destination}, agrégalo como un destino principal.`:`Expected arrival in ${t.destination} at ${t.arrival}. This transfer closes this trip stage; add ${t.destination} as a main destination to plan it.`)
            : (es?`Llegada prevista a ${t.destination} a las ${t.arrival}. La planificación continúa desde ${t.destination} según el tiempo disponible.`:`Expected arrival in ${t.destination} at ${t.arrival}. Planning continues from ${t.destination} according to the available time.`)),
        kind:'transport',
        commerce_context:{semantic_type:'TRANSPORT',origin:t.origin,destination:t.destination,mode:t.mode||null,departure:t.departure,arrival:t.arrival,transfer_id:t.transfer_id||null,user_fixed:t.source!=='ROUTE_ESTIMATED',route_estimated:t.source==='ROUTE_ESTIMATED',route_resolution:t.route_resolution||null,source:t.source||'USER_FIXED',booking_need:'compare_options'}
      };
      if(idx>=0) out[idx]={...out[idx],...fixedRow};
      else out.push(fixedRow);
      if(t.terminal_arrival||day.terminal_arrival_only){
        out=out.filter(r=>Number(r.day)!==dayNum || _hhmmToMinutes_(r.start)==null || _hhmmToMinutes_(r.start)<arr || (_hhmmToMinutes_(r.start)===dep&&_hhmmToMinutes_(r.end)===arr));
      }
    });
  });
  out=_dedupeRows_(out).sort((a,b)=>Number(a.day)-Number(b.day)||String(a.start||'').localeCompare(String(b.start||'')));
  // A canonical movement resets physical continuity. The first activity after
  // a protected transfer starts from the transfer destination, never from a POI
  // that belonged to the location before that movement. This changes only the
  // traveler-facing origin label; it does not change row kind, window identity,
  // Stay membership, timing, or QA coverage.
  (contract.route_days||[]).forEach(day=>{
    const dayNum=Number(day.day);
    const transfers=(day.fixed_transfers||[]).filter(t=>t.departure&&t.arrival)
      .slice().sort((a,b)=>String(a.arrival).localeCompare(String(b.arrival)));
    transfers.forEach((t,index)=>{
      const arr=_hhmmToMinutes_(t.arrival); if(arr==null)return;
      const nextTransferDep=index+1<transfers.length?_hhmmToMinutes_(transfers[index+1].departure):null;
      const next=out.find(r=>Number(r.day)===dayNum && String(r.kind||'activity').toLowerCase()!=='transport' && (_hhmmToMinutes_(r.start)??-1)>=arr && (nextTransferDep==null || (_hhmmToMinutes_(r.start)??99999)<nextTransferDep));
      if(next) next.from=t.destination;
    });
  });
  return out;
}

function _v3SyntheticMaster_(totalDays){
  return Array.from({length:Number(totalDays)||0},(_,i)=>({
    day:i+1,
    theme:`Unique high-value day ${i+1} | Anchors: distinct geographically coherent experiences`
  }));
}

function _v3AuditSummary_(report={}){
  const counts={};
  (report?.errors||[]).forEach(e=>{ const code=String(e?.code||'UNKNOWN'); counts[code]=(counts[code]||0)+1; });
  return Object.fromEntries(Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])));
}

function _v3HardBlockingCodes_(){
  return new Set([
    'MISSING_DAY','MISSING_PHYSICAL_WINDOW','INVALID_TIME','MISSING_USER_FIXED_TRANSFER',
    'ACTIVITY_OVERLAPS_USER_FIXED_TRANSFER','ACTIVITY_OUTSIDE_ROUTE_LOCATION_WINDOW',
    'OVERLAP','CONTINUITY','WRONG_OVERNIGHT_BASE',
    'INVENTED_DEPARTURE_LOGISTICS',
    'ROUTE_WINDOW_UNDERUSED','ROUTE_WINDOW_TOO_THIN','REGIONAL_DAY_TOO_THIN',
    'GLOBAL_DUPLICATE_POI','CATEGORY_DWELL_TOO_SHORT','ANCHOR_TIME_HIDDEN_AS_GAP',
    'GENERIC_TO','AMBIGUOUS_TO','UNJUSTIFIED_EXTREME_START','IMPLAUSIBLE_EARLY_INTERIOR','TRUNCATED_PLACE_TEXT','DURATION_UNPARSEABLE','ROW_TOO_SHORT','ROW_INTERVAL_UNEXPLAINED'
  ]);
}

function _v3RepairableCodes_(){
  return new Set([
    ..._v3HardBlockingCodes_(),
    'GLOBAL_DUPLICATE_POI','GENERIC_TO','AMBIGUOUS_TO',
    'CATEGORY_DWELL_TOO_SHORT','ANCHOR_TIME_HIDDEN_AS_GAP','REGIONAL_DAY_TOO_THIN',
    'ROUTE_WINDOW_TOO_THIN',
    'OUTDOOR_OUTSIDE_USEFUL_DAYLIGHT','RIGID_AURORA_ROW',
    'MISSING_AURORA_FINAL_NOTE','ROW_TOO_SHORT','ROW_INTERVAL_UNEXPLAINED',
    'DURATION_UNPARSEABLE','REPETITIVE_NOTE_TEMPLATE','UNJUSTIFIED_EXTREME_START'
  ]);
}

function _v3MaterialAuditErrors_(report){
  const repairable=_v3RepairableCodes_();
  return (report?.errors||[]).filter(e=>repairable.has(String(e?.code||'')));
}

function _v3BlockingAuditErrors_(report){
  const blocking=_v3HardBlockingCodes_();
  return (report?.errors||[]).filter(e=>blocking.has(String(e?.code||'')));
}


// Detailed diagnostics: keep the compact summary, but also print every QA finding
// as readable JSON so Chrome console screenshots/copies expose the exact day/row/data.
function _v3LogAuditDetails_(label,city,unitId,errors=[]){
  const list=Array.isArray(errors)?errors:[];
  if(!list.length) return;
  list.forEach((error,index)=>{
    try{
      console.warn(`[ITBMO V3 QA DETAIL] ${label} · ${city} · ${unitId} · ${index+1}/${list.length} · ${error?.code||'UNKNOWN'}\n${JSON.stringify(error,null,2)}`);
    }catch(_){
      console.warn(`[ITBMO V3 QA DETAIL] ${label} · ${city} · ${unitId}`,error);
    }
  });
}

// Choose the smallest safe repair scope. The complete Stay is ALWAYS audited again
// after the candidate is merged, so localized repair never weakens final QA.
function _v3RepairScope_(material=[]){
  const list=Array.isArray(material)?material:[];
  const crossDayCodes=new Set(['GLOBAL_DUPLICATE_POI','MISSING_DAY','WRONG_OVERNIGHT_BASE','MISSING_USER_FIXED_TRANSFER','ACTIVITY_OVERLAPS_USER_FIXED_TRANSFER']);
  if(!list.length || list.some(e=>crossDayCodes.has(String(e?.code||'')))) return {type:'stay',days:[]};
  const days=[...new Set(list.flatMap(e=>[e?.day,...(Array.isArray(e?.days)?e.days:[])]).map(Number).filter(Boolean))].sort((a,b)=>a-b);
  if(days.length===1) return {type:'day',days};
  if(days.length===2 && Math.abs(days[0]-days[1])<=1) return {type:'days',days};
  return {type:'stay',days:[]};
}


function _v3UsefulPlanningWindow_(w={}){
  const start=_hhmmToMinutes_(w?.start),end=_hhmmToMinutes_(w?.end);
  // Coverage is a hard gate only for substantial usable windows. Very short or
  // late-arrival fragments remain physically valid without forcing filler.
  if(w?.minimum_useful_target) return true;
  if(w?.open_end) return start==null||start<21*60;
  return start!=null&&end!=null&&end>start&&(end-start)>=90;
}

function _v3PhysicalWindowCoverage_(rows=[],units=[]){
  const expected=[];
  (units||[]).forEach(unit=>(unit.windows||[]).forEach(w=>{
    if(!_v3UsefulPlanningWindow_(w)) return;
    expected.push({window_id:w.window_id,stay_unit_id:unit.id,day:Number(w.day),location:w.location,start:w.start,end:w.end,open_end:Boolean(w.open_end)});
  }));
  const received=new Set();
  (rows||[]).forEach(row=>{
    if(_isPureTransportRow_(row)) return;
    const id=String(row?.planning_window_id||row?.commerce_context?.planning_window_id||'').trim();
    if(id) received.add(`${row.stay_unit_id||''}|${id}`);
  });
  const missing=expected.filter(w=>!received.has(`${w.stay_unit_id||''}|${w.window_id||''}`));
  return {expected,received:[...received],missing,expectedCount:expected.length,receivedCount:expected.length-missing.length};
}

// Final trip gate for the independent-Stay architecture. Local Stay QA already
// owns semantic continuity and within-stay itinerary quality. The merge gate must
// validate only deterministic physical integrity against the Route Compiler facts.
function _v3MergedHardPhysicalAudit_(rows=[],contract={},totalDays=1){
  const errors=[];
  const maxDay=Math.max(1,Number(totalDays)||1);
  const byDay=_rowsByDayObject_(rows);
  const coverage=_v3Coverage_(rows,maxDay);
  coverage.missing.forEach(day=>errors.push({code:'MISSING_DAY',day}));

  const routeDays=new Map((contract?.route_days||[]).map(d=>[Number(d.day),d]));
  const units=_v3BuildPhysicalStayUnits_(contract);
  const unitById=new Map(units.map(u=>[String(u.id),u]));
  const windowCoverage=_v3PhysicalWindowCoverage_(rows,units);
  windowCoverage.missing.forEach(w=>errors.push({code:'MISSING_PHYSICAL_WINDOW',day:w.day,stay_unit_id:w.stay_unit_id,window_id:w.window_id,location:w.location,window:`${w.start||''}-${w.end||'open'}`}));

  for(let day=1;day<=maxDay;day++){
    const dayRows=[...(byDay[day]||[])].sort((a,b)=>(_hhmmToMinutes_(a.start)??99999)-(_hhmmToMinutes_(b.start)??99999));
    const routeDay=routeDays.get(day)||{};
    const transfers=(routeDay.fixed_transfers||[]).filter(t=>t?.departure&&t?.arrival);

    dayRows.forEach((row,index)=>{
      const start=_hhmmToMinutes_(row.start),end=_hhmmToMinutes_(row.end);
      if(start==null||end==null||end<=start){
        errors.push({code:'INVALID_TIME',day,row:index+1,start:row.start,end:row.end});
        return;
      }
      const isTransport=_isPureTransportRow_(row);
      if(isTransport) return;

      // A generated activity must fit one authoritative physical window belonging
      // to its own Stay Unit. This is stronger and less ambiguous than comparing
      // POI names across independently generated stays.
      const unit=unitById.get(String(row?.stay_unit_id||''));
      const candidateWindows=(unit?.windows||[]).filter(w=>Number(w.day)===day);
      const inside=candidateWindows.some(w=>{
        const ws=_hhmmToMinutes_(w.start),we=w.open_end?null:_hhmmToMinutes_(w.end);
        return (ws==null||start>=ws)&&(we==null||end<=we);
      });
      if(unit && candidateWindows.length && !inside){
        errors.push({code:'ACTIVITY_OUTSIDE_ROUTE_LOCATION_WINDOW',day,row:index+1,stay_unit_id:unit.id});
      }
    });

    // Fixed user movements are the single source of truth at Stay boundaries.
    // They must exist exactly once and no generated activity may occupy them.
    transfers.forEach(t=>{
      const dep=_hhmmToMinutes_(t.departure),arr=_hhmmToMinutes_(t.arrival);
      if(dep==null||arr==null||arr<=dep) return;
      const exact=dayRows.filter(r=>_hhmmToMinutes_(r.start)===dep&&_hhmmToMinutes_(r.end)===arr&&_arePoiAliases_(r.from,t.origin)&&_arePoiAliases_(r.to,t.destination));
      if(exact.length!==1){
        errors.push({code:'MISSING_USER_FIXED_TRANSFER',day,origin:t.origin,destination:t.destination,required_window:`${t.departure}-${t.arrival}`,count:exact.length});
      }
      dayRows.forEach((r,index)=>{
        const rs=_hhmmToMinutes_(r.start),re=_hhmmToMinutes_(r.end);
        if(rs==null||re==null||re<=rs) return;
        const isExact=rs===dep&&re===arr&&_arePoiAliases_(r.from,t.origin)&&_arePoiAliases_(r.to,t.destination);
        if(!isExact && Math.max(rs,dep)<Math.min(re,arr)){
          errors.push({code:'ACTIVITY_OVERLAPS_USER_FIXED_TRANSFER',day,row:index+1,required_window:`${t.departure}-${t.arrival}`});
        }
      });
    });

    // Overlap remains a hard blocker inside the same Stay Unit. Across two
    // adjacent Stay Units on the same calendar day, authoritative Route Compiler
    // windows/boundary movements decide validity; POI-level continuity does not.
    for(let i=0;i<dayRows.length;i++){
      const a=dayRows[i],as=_hhmmToMinutes_(a.start),ae=_hhmmToMinutes_(a.end);
      if(as==null||ae==null||ae<=as) continue;
      for(let j=i+1;j<dayRows.length;j++){
        const b=dayRows[j],bs=_hhmmToMinutes_(b.start),be=_hhmmToMinutes_(b.end);
        if(bs==null||be==null||be<=bs||bs>=ae) break;
        if(Math.max(as,bs)>=Math.min(ae,be)) continue;
        const aTransport=_isPureTransportRow_(a);
        const bTransport=_isPureTransportRow_(b);
        const sameStay=a?.stay_unit_id&&b?.stay_unit_id&&String(a.stay_unit_id)===String(b.stay_unit_id);
        if(aTransport||bTransport||sameStay){
          errors.push({code:'OVERLAP',day,rows:[i+1,j+1],stay_unit_id:sameStay?a.stay_unit_id:null});
        }
      }
    }
  }

  return {errors};
}

function _v3IssueFingerprint_(report={}){
  return JSON.stringify((report?.errors||[]).map(e=>({code:e?.code,day:e?.day,row:e?.row,days:e?.days,to:e?.to,transport:e?.transport})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

function _v3AdaptiveRepairBudget_(contract={},totalDays=1){
  const transfers=(contract?.route_days||[]).reduce((n,d)=>n+(d?.fixed_transfers||[]).length,0);
  const windows=(contract?.route_days||[]).reduce((n,d)=>n+(d?.location_windows||[]).length,0);
  const complexity=Math.max(1,Number(totalDays)||1)+transfers+Math.max(0,windows-(Number(totalDays)||1));
  // Repairs remain surgical. Complex trips get more opportunities to converge,
  // but never an unbounded loop or whole-trip regeneration.
  return Math.max(2,Math.min(5,2+Math.floor(complexity/8)));
}

function _v3ConcretePlace_(row={}){
  const activity=String(row?.activity||'').trim();
  const activityTail=activity.split(/\s+[–—-]\s+/).slice(1).join(' - ').trim();
  const ambiguous=/\s\/\s|(?:^|\s)or(?=\s|$)|(?:^|\s)o(?=\s|$)|\balternative\b|\balternativa\b|\bif full\b|\bsi est[aá] lleno\b/i;
  if(activityTail && !ambiguous.test(activityTail)) return activityTail;
  const raw=String(row?.to||'').trim();
  return raw.split(/\s+\/\s+|\s+or\s+|\s+o\s+|\s+alternative\s+|\s+alternativa\s+|\s+if full\b|\s+si est[aá] lleno\b/i)[0].trim() || raw;
}

function _v3FitDurationToInterval_(row={}){
  const start=_hhmmToMinutes_(row.start), end=_hhmmToMinutes_(row.end);
  if(start==null||end==null) return row;
  let span=end-start; if(span<=0) span+=1440;
  if(span<=0) return row;
  const [transportLabel,activityLabel]=_durationLabels_();
  if(_isPureTransportRow_(row)){
    const existing=_transportBoundsFromField_(row.transport||'');
    const transport=existing?String(row.transport||'').trim():[String(row.transport||'').trim(),`~${_minutesToHuman_(span)}`].filter(Boolean).join(' · ');
    return {...row,transport,duration:''};
  }
  const transport=_transportBoundsFromField_(row.transport||'') || _durationBoundsMinutes_(_extractDurationPart_(row.duration,'transport'));
  const transportMinutes=Math.max(0,Math.min(span-1,Number(transport?.max||0)));
  const activityMinutes=Math.max(1,span-transportMinutes);
  const transportField=transportMinutes>0 && !_transportBoundsFromField_(row.transport||'')
    ? [String(row.transport||'').trim(),`~${_minutesToHuman_(transportMinutes)}`].filter(Boolean).join(' · ')
    : String(row.transport||'').trim();
  return {...row,transport:transportField,duration:`${activityLabel}: ${_minutesToHuman_(activityMinutes)}`};
}

function _v3DeterministicQualityCleanup_(city,rows,contract,totalDays,perDay,baseDate,routeContextOverride=undefined,expectedDaysOverride=undefined){
  let out=_v3EnforceHardRouteFacts_(rows,contract);
  const master=_v3SyntheticMaster_(totalDays);
  const removed=[];
  for(let pass=0;pass<5;pass++){
    const report=_localGlobalAudit_(city,out,totalDays,master,perDay,baseDate,routeContextOverride,expectedDaysOverride);
    const errors=report?.errors||[];
    let changed=false;
    const byDay=_rowsByDayObject_(out);

    // Timeline/duration defects are arithmetic, not creative-writing problems.
    for(const error of errors){
      const day=Number(error?.day||0), rowNum=Number(error?.row||0);
      const row=day&&rowNum ? (byDay[day]||[])[rowNum-1] : null;
      if(!row) continue;
      if(['ROW_TOO_SHORT','ROW_INTERVAL_UNEXPLAINED','DURATION_UNPARSEABLE'].includes(error.code)){
        Object.assign(row,_v3FitDurationToInterval_(row)); changed=true;
      }else if(error.code==='CONTINUITY'){
        const arr=byDay[day]||[], prev=arr[rowNum-2];
        if(prev && !_isPureTransportRow_(prev) && !_isPureTransportRow_(row) && prev.to){
          row.from=prev.to; changed=true;
        }
      }else if(error.code==='AMBIGUOUS_TO'){
        const concrete=_v3ConcretePlace_(row);
        if(concrete && concrete!==row.to){ row.to=concrete; changed=true; }
      }
    }

    // Duplicate POIs are deterministic trip-wide conflicts. Remove only the later
    // row identified by the auditor; a subsequent scoped repair may fill the gap.
    for(const error of errors.filter(e=>e.code==='GLOBAL_DUPLICATE_POI')){
      const laterDay=Math.max(...(error.days||[]).map(Number).filter(Boolean));
      const arr=byDay[laterDay]||[];
      const victim=arr.find(r=>!_isUtilityRow_(r) && _arePoiAliases_(r.to||r.activity,error.second||''));
      if(victim && !_isPureTransportRow_(victim)){
        const idx=out.indexOf(victim);
        if(idx>=0){ removed.push({day:laterDay,poi:victim.to||victim.activity}); out.splice(idx,1); changed=true; }
      }
    }

    // Global, city-agnostic duplicate sweep. The auditor can report aliases with
    // different surface text; compare every concrete POI against all earlier rows
    // and deterministically keep the first chronological occurrence.
    const chronological=[...out].sort((a,b)=>Number(a?.day||0)-Number(b?.day||0)||String(a?.start||'').localeCompare(String(b?.start||'')));
    const kept=[];
    for(const candidate of chronological){
      if(_isUtilityRow_(candidate)||_isPureTransportRow_(candidate)){ kept.push(candidate); continue; }
      const candidatePoi=_poiKeyFromRow_(candidate);
      const duplicate=kept.find(previous=>{
        if(_isUtilityRow_(previous)||_isPureTransportRow_(previous)) return false;
        const previousPoi=_poiKeyFromRow_(previous);
        const samePoi=candidatePoi&&previousPoi&&_arePoiAliases_(candidatePoi,previousPoi);
        const sameActivity=_canonicalText_(candidate.activity||'')===_canonicalText_(previous.activity||'');
        const sameSemantic=String(candidate?.commerce_context?.semantic_type||'')===String(previous?.commerce_context?.semantic_type||'');
        const cs=_hhmmToMinutes_(candidate.start),ps=_hhmmToMinutes_(previous.start);
        return samePoi&&sameActivity&&sameSemantic&&Number(candidate.day)===Number(previous.day)&&cs!=null&&ps!=null&&Math.abs(cs-ps)<=20;
      });
      if(duplicate){
        const idx=out.indexOf(candidate);
        if(idx>=0){ removed.push({day:Number(candidate.day||0),poi:candidate.to||candidate.activity,reason:'global_alias'}); out.splice(idx,1); changed=true; }
      }else kept.push(candidate);
    }

    out=_v3EnforceHardRouteFacts_(out,contract);
    if(!changed) break;
  }
  const report=_localGlobalAudit_(city,out,totalDays,master,perDay,baseDate,routeContextOverride,expectedDaysOverride);
  if(removed.length) console.info(`[ITBMO V3 NORMALIZE] ${city}: deterministic duplicate cleanup`,removed);
  console.info(`[ITBMO V3 NORMALIZE] ${city}`,_v3AuditSummary_(report));
  return {rows:out,report};
}

const _v3LastFailureByCity_={};
const _v3AcceptedStayCache_=new Map();
const ITBMO_V3_STAY_CACHE_SCHEMA='canonical-daytrip-roundtrip-v4-experience-semantics';

function _v3StableHash_(value=''){
  let h1=0x811c9dc5,h2=0x9e3779b9;
  for(let i=0;i<value.length;i++){
    const c=value.charCodeAt(i);
    h1=Math.imul(h1^c,0x01000193);
    h2=Math.imul(h2^c,0x85ebca6b);
  }
  return `${(h1>>>0).toString(36)}${(h2>>>0).toString(36)}`;
}
function _v3AcceptedStayCacheKey_(contract={},unit={}){
  const signature=JSON.stringify(_v3StayContract_(contract,unit));
  return `itbmo_v3_stay_${ITBMO_V3_STAY_CACHE_SCHEMA}_${String(currentTripId||contract?.trip_context_id||'trip')}_${String(unit?.id||'stay')}_${_v3StableHash_(signature)}`;
}
function _v3AcceptedStayGet_(contract,unit){
  const key=_v3AcceptedStayCacheKey_(contract,unit);
  let value=_v3AcceptedStayCache_.get(key)||null;
  if(!value){
    try{value=JSON.parse(sessionStorage.getItem(key)||'null');}catch(_){value=null;}
  }
  if(!value||!Array.isArray(value.rows)||!value.rows.length)return null;
  _v3AcceptedStayCache_.set(key,value);
  return JSON.parse(JSON.stringify(value));
}
function _v3AcceptedStaySet_(contract,unit,value){
  const key=_v3AcceptedStayCacheKey_(contract,unit);
  const safe=JSON.parse(JSON.stringify(value));
  _v3AcceptedStayCache_.set(key,safe);
  try{sessionStorage.setItem(key,JSON.stringify(safe));}catch(_){}
}
function _v3AcceptedStayClear_(contract,units=[]){
  (units||[]).forEach(unit=>{
    const key=_v3AcceptedStayCacheKey_(contract,unit);
    _v3AcceptedStayCache_.delete(key);
    try{sessionStorage.removeItem(key);}catch(_){}
  });
}

async function _v3Call_(prompt,task='repair'){
  return _callPlannerSystemPrompt_(prompt,false,'planner_v3',{v3_task:task});
}

function _v3ExtractPlanningUnitRows_(parsed,planningUnit,totalDays,expectedDaysOverride=undefined){
  if(!parsed) return [];
  const maxDay=Math.max(1,Number(totalDays)||1);
  let rows=[];

  // V3 identity rule: city_day.city is the PHYSICAL location for that day/block.
  // Membership in the response is established by planning_unit + day index, never
  // by comparing the physical city with the MAIN destination name.
  if(Array.isArray(parsed.city_day)){
    rows=parsed.city_day.flatMap((block,index)=>{
      const dayNum=Number(block?.day)||index+1;
      if(dayNum<1||dayNum>maxDay) return [];
      return (Array.isArray(block?.rows)?block.rows:[]).map(r=>normalizeRow({...r,day:r?.day??dayNum},dayNum));
    });
  }else if(Array.isArray(parsed.rows)){
    rows=parsed.rows.map(r=>normalizeRow(r));
  }else if(Array.isArray(parsed.destinations)){
    // Compatibility only: a V3 planning unit may contain multiple physical places.
    // Flatten all day blocks instead of selecting only the MAIN destination.
    rows=parsed.destinations.flatMap(item=>
      Array.isArray(item?.city_day)
        ? item.city_day.flatMap((block,index)=>{
            const dayNum=Number(block?.day)||index+1;
            return dayNum>=1&&dayNum<=maxDay
              ? (Array.isArray(block?.rows)?block.rows:[]).map(r=>normalizeRow({...r,day:r?.day??dayNum},dayNum))
              : [];
          })
        : (Array.isArray(item?.rows)?item.rows.map(r=>normalizeRow(r)):[])
    );
  }

  const valid=rows.filter(r=>Number(r?.day)>=1&&Number(r?.day)<=maxDay);
  const identityCoverage=Array.isArray(expectedDaysOverride)&&expectedDaysOverride.length
    ? _v3CoverageForDays_(valid,expectedDaysOverride,maxDay)
    : _v3Coverage_(valid,maxDay);
  console.info(`[ITBMO V3 IDENTITY] ${planningUnit}: accepted rows by authoritative global day; physical city labels are not membership filters`,identityCoverage);
  return valid;
}

function _v3PhysicalKey_(value){
  return String(value||'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}

function _v3IsFullTransitDay_(routeDay={}){
  const allTransfers=(routeDay.fixed_transfers||[]).filter(t=>_hhmmToMinutes_(t?.departure)!=null&&_hhmmToMinutes_(t?.arrival)!=null);
  // A round-trip excursion is a TOURISM DAY WITH FIXED MOVEMENTS, never a
  // transit day. Counting its outbound + return legs as two generic transfers
  // suppresses the very tourism window the day trip exists to protect.
  const hasDayTripMovement=allTransfers.some(t=>/^daytrip_(?:out|return)$/i.test(String(t?.direction||'')));
  if(hasDayTripMovement)return false;
  const transfers=allTransfers.filter(t=>!/^daytrip_/i.test(String(t?.direction||'')));
  if(transfers.length<2)return false;
  const movementMinutes=transfers.reduce((sum,t)=>{
    const dep=_hhmmToMinutes_(t.departure),arr=_hhmmToMinutes_(t.arrival);
    return sum+Math.max(0,(arr>=dep?arr:arr+1440)-dep);
  },0);
  const operationalMinutes=transfers.reduce((sum,t)=>{
    const mode=_v3PhysicalKey_(`${t?.mode||''} ${t?.transport||''}`);
    return sum+(/plane|flight|avion|airport|aeropuerto/.test(mode)?150:60);
  },0);
  // Multiple movements with at least six hours of travel/operational burden are
  // a travel day. Apparent gaps are reserved for luggage, access, check-in,
  // delays, meals and recovery instead of being forced into sightseeing rows.
  return movementMinutes+operationalMinutes>=360;
}

function _v3BuildPhysicalStayUnits_(contract={}){
  const routeDays=[...(contract.route_days||[])].sort((a,b)=>Number(a.day)-Number(b.day));
  const storyStays=(contract.trip_story_stays||[]).filter(st=>st?.place&&st?.startDate);
  const transfers=routeDays.flatMap(d=>(d.fixed_transfers||[]).map((t,transferIndex)=>({...t,transfer_id:t.transfer_id||`day-${Number(d.day)}-transfer-${transferIndex+1}`,day:Number(d.day),date:d.date||null})));
  const findBoundaryTransfer=(origin,destination,targetDate)=>{
    const candidates=transfers.filter(t=>_arePoiAliases_(t.origin,origin)&&_arePoiAliases_(t.destination,destination));
    candidates.sort((a,b)=>{
      const as=String(a.date||'')===String(targetDate||'')?1:0,bs=String(b.date||'')===String(targetDate||'')?1:0;
      return bs-as||String(b.date||'').localeCompare(String(a.date||''))||String(b.departure||'').localeCompare(String(a.departure||''));
    });
    return candidates[0]||null;
  };

  // PHYSICAL WINDOW OWNERSHIP MODEL
  // A calendar day is NOT owned by one destination. The same global day may
  // legitimately contain windows for two Stay Units (Paris -> Bruges), while a
  // Day Trip window (Versailles) remains owned by its parent Paris Stay Unit.
  // Therefore Stay membership is derived from physical windows, not merely from
  // the Stay Card's date range.
  if(storyStays.length){
    const descriptors=storyStays.map((st,index)=>{
      const startISO=String(st.startDate||'');
      const dates=new Set(Array.from({length:Math.max(1,Number(st.days||1))},(_,i)=>_tripStoryAddDays_(startISO,i)));
      const dayTrips=(st.dayTrips||[]).map(dt=>({
        ...dt,
        expected_date:startISO?_tripStoryAddDays_(startISO,Math.max(0,Number(dt.day||1)-1)):null
      }));
      const previous=storyStays[index-1]||null,next=storyStays[index+1]||null;
      // Prefer the shared transition date. This prevents an earlier Day Trip to
      // the next city from being mistaken for the actual inter-stay boundary.
      const inbound=previous?findBoundaryTransfer(previous.place,st.place,startISO):null;
      const outbound=next?findBoundaryTransfer(st.place,next.place,String(next.startDate||'')):null;
      return {st,index,dates,dayTrips,inbound,outbound};
    });

    // Every non-transfer physical window gets exactly one Stay owner. Ownership
    // is based on physical location + calendar eligibility. This allows two Stay
    // Units to share Day N without either stealing the other's window.
    const ownedWindows=new Map(descriptors.map(d=>[d.index,[]]));
    routeDays.forEach(day=>{
      const fullTransitDay=_v3IsFullTransitDay_(day);
      if(fullTransitDay) console.info(`[ITBMO V3 TRANSIT DAY] Day ${Number(day.day)}: tourism windows suppressed; fixed movements remain authoritative`);
      (day.location_windows||[]).forEach((w,windowIndex)=>{
        if(w?.type==='fixed_transfer') return;
        if(fullTransitDay) return;
        const location=String(w?.location||'').trim();
        if(!location||/\s[→>]\s/.test(location)) return;
        const date=String(day.date||'');
        const candidates=[];
        descriptors.forEach(d=>{
          if(!d.dates.has(date)) return;
          const ws=_hhmmToMinutes_(w.start),we=w.open_end?null:_hhmmToMinutes_(w.end);
          const inboundMinute=d.inbound&&String(d.inbound.date||'')===date?_hhmmToMinutes_(d.inbound.arrival):null;
          const outboundMinute=d.outbound&&String(d.outbound.date||'')===date?_hhmmToMinutes_(d.outbound.departure):null;
          // Same-day Stay transitions can make two cards share the same date and
          // even the same city name. Boundary times disambiguate ownership.
          if(inboundMinute!=null&&ws!=null&&ws<inboundMinute) return;
          if(outboundMinute!=null&&we!=null&&we>outboundMinute) return;
          let score=0,role=null;
          if(_arePoiAliases_(location,d.st.place)){score=100;role='BASE';}
          d.dayTrips.forEach(dt=>{
            if(dt?.place&&_arePoiAliases_(location,dt.place)){
              const dateScore=!dt.expected_date||dt.expected_date===date?130:105;
              if(dateScore>score){score=dateScore;role='DAY_TRIP';}
            }
          });
          if(score) candidates.push({descriptor:d,score,role});
        });
        candidates.sort((a,b)=>b.score-a.score||a.descriptor.index-b.descriptor.index);
        let owner=candidates[0];
        if(!owner){
          // A physical window must not disappear merely because its surface label
          // differs from the Stay/Day-Trip label. When date + boundary times leave
          // exactly one eligible Stay, ownership is deterministic and safe.
          const ws=_hhmmToMinutes_(w.start),we=w.open_end?null:_hhmmToMinutes_(w.end);
          const eligible=descriptors.filter(d=>{
            if(!d.dates.has(date)) return false;
            const inboundMinute=d.inbound&&String(d.inbound.date||'')===date?_hhmmToMinutes_(d.inbound.arrival):null;
            const outboundMinute=d.outbound&&String(d.outbound.date||'')===date?_hhmmToMinutes_(d.outbound.departure):null;
            if(inboundMinute!=null&&ws!=null&&ws<inboundMinute) return false;
            if(outboundMinute!=null&&we!=null&&we>outboundMinute) return false;
            return true;
          });
          if(eligible.length===1) owner={descriptor:eligible[0],score:1,role:'BASE'};
        }
        if(!owner){
          console.warn('[ITBMO V3 WINDOW OWNERSHIP] Unassigned physical window', {day:Number(day.day),date,location,start:w.start||null,end:w.end||null});
          return;
        }
        const windowId=w.window_id||`day-${Number(day.day)}-window-${windowIndex+1}`;
        ownedWindows.get(owner.descriptor.index).push({
          window_id:windowId,
          day:Number(day.day),date:day.date||null,location,
          start:w.start||null,end:w.end||null,open_end:Boolean(w.open_end),
          minimum_useful_target:w.minimum_useful_target||null,
          day_trip:owner.role==='DAY_TRIP',role:owner.role||'BASE'
        });
      });
    });

    return descriptors.map(d=>{
      const {st,index,dayTrips}=d;
      const windows=(ownedWindows.get(index)||[]).sort((a,b)=>Number(a.day)-Number(b.day)||String(a.start||'').localeCompare(String(b.start||'')));
      const days=[...new Set(windows.map(w=>Number(w.day)).filter(Boolean))].sort((a,b)=>a-b);
      const previous=storyStays[index-1]||null,next=storyStays[index+1]||null;
      // Boundary movements are authoritative and may live on a day shared by both
      // adjacent stays. They were resolved before window ownership so repeated
      // same-city stays on one date remain distinguishable.
      const inbound=d.inbound||null;
      const outbound=d.outbound||null;
      const allowed=[...new Set([st.place,...dayTrips.map(x=>x.place),...windows.map(w=>w.location)].filter(Boolean))];
      return {
        id:st.id||`${_v3PhysicalKey_(contract.planning_unit)||'trip'}-stay-${String(index+1).padStart(2,'0')}`,
        sequence:index+1,
        physical_destination:st.place,
        base_destination:st.place,
        physical_key:_v3PhysicalKey_(st.place),
        allowed_physical_locations:allowed,
        day_trips:dayTrips.map(({expected_date,...x})=>x),
        windows,days,
        previous_destination:previous?.place||null,next_destination:next?.place||null,
        inbound_boundary:inbound,outbound_boundary:outbound
      };
    }).filter(u=>u.windows.length||u.days.length);
  }

  // Legacy fallback: preserve the pre-Trip-Story physical-window behavior.
  const units=[];
  let current=null, sequence=0;
  for(const day of routeDays){
    const fullTransitDay=_v3IsFullTransitDay_(day);
    const timeline=[...(day.location_windows||[])].sort((a,b)=>String(a.start||'99:99').localeCompare(String(b.start||'99:99')));
    for(let windowIndex=0;windowIndex<timeline.length;windowIndex++){
      const window=timeline[windowIndex];
      if(window?.type==='fixed_transfer'){current=null;continue;}
      if(fullTransitDay) continue;
      const location=String(window?.location||day?.start_location||contract.planning_unit||'').trim();
      if(!location || /\s[→>]\s/.test(location)) continue;
      const key=_v3PhysicalKey_(location); if(!key) continue;
      if(!current||current.physical_key!==key){sequence+=1;current={id:`${_v3PhysicalKey_(contract.planning_unit)||'trip'}-stay-${String(sequence).padStart(2,'0')}`,sequence,physical_destination:location,base_destination:location,physical_key:key,allowed_physical_locations:[location],day_trips:[],windows:[],days:new Set()};units.push(current);}
      current.windows.push({window_id:window.window_id||`day-${Number(day.day)}-window-${windowIndex+1}`,day:Number(day.day),date:day.date||null,location,start:window.start||null,end:window.end||null,open_end:Boolean(window.open_end),minimum_useful_target:window.minimum_useful_target||null,role:'BASE'});
      current.days.add(Number(day.day));
    }
  }
  return units.map((unit,index)=>{const previous=units[index-1]||null,next=units[index+1]||null;const first=unit.windows[0],last=unit.windows.at(-1);const inbound=transfers.find(t=>t.day===first?.day&&_v3PhysicalKey_(t.destination)===unit.physical_key&&(!first?.start||t.arrival===first.start))||null;const outbound=transfers.find(t=>t.day===last?.day&&_v3PhysicalKey_(t.origin)===unit.physical_key&&(!last?.end||t.departure===last.end))||null;return {...unit,days:[...unit.days].sort((a,b)=>a-b),previous_destination:previous?.physical_destination||null,next_destination:next?.physical_destination||null,inbound_boundary:inbound,outbound_boundary:outbound};});
}

function _v3StayContract_(contract,unit){
  const days=new Set(unit.days||[]);
  const placePreference=Object.entries(contract.place_preferences||{}).find(([place])=>_v3PhysicalKey_(place)===unit.physical_key)?.[1]||null;
  const unitLodging=placePreference
    ? (placePreference.lodgingChoice==='recommend' ? 'recommend me' : (placePreference.lodgingText||placePreference.lodgingChoice||null))
    : (_arePoiAliases_(unit.base_destination||unit.physical_destination,contract.planning_unit)?contract.lodging_base:null);
  return {
    version:'ITBMO_PHYSICAL_STAY_CONTRACT_V2',
    trip_context_id:contract.trip_context_id||'continuous-trip',
    stay_unit_id:unit.id,
    sequence:unit.sequence,
    physical_destination:unit.physical_destination,
    base_destination:unit.base_destination||unit.physical_destination,
    allowed_physical_locations:unit.allowed_physical_locations||[unit.physical_destination],
    day_trips:unit.day_trips||[],
    itinerary_language:contract.itinerary_language,
    planning_windows:unit.windows,
    boundary_context:{previous_destination:unit.previous_destination,next_destination:unit.next_destination,inbound:unit.inbound_boundary,outbound:unit.outbound_boundary},
    lodging_base:unitLodging,
    place_preference:placePreference,
    global_preferences:contract.global_preferences,
    special_conditions:contract.special_conditions,
    travelers:contract.travelers,
    traveler_profiles:contract.traveler_profiles,
    calendar_dates:(contract.calendar_dates||[]).filter(x=>days.has(Number(x.day))),
    hard_policies:{
      plan_only_inside_supplied_physical_windows:true,
      stay_card_is_immutable:true,
      day_trips_belong_to_parent_stay:true,
      plan_only_in_allowed_physical_locations:true,
      boundary_movements_are_immutable_and_must_not_be_generated:true,
      use_substantial_windows_productively:true,
      never_invent_transport_booking_details:true,
      no_duplicate_major_poi_within_this_stay:true
    }
  };
}

function _v3StampStayRows_(rows=[],unit={}){
  const windows=unit.windows||[];
  return (rows||[]).flatMap(row=>{
    const day=Number(row?.day),start=_hhmmToMinutes_(row?.start),end=_hhmmToMinutes_(row?.end);
    const candidates=windows.filter(w=>{
      if(Number(w.day)!==day) return false;
      const ws=_hhmmToMinutes_(w.start),we=w.open_end?null:_hhmmToMinutes_(w.end);
      if(start==null||end==null||end<=start) return false;
      // Half-open interval semantics: [start,end). Touching a boundary is valid.
      if(ws!=null&&start<ws) return false;
      return we==null||end<=we;
    }).sort((a,b)=>{
      const as=_hhmmToMinutes_(a.start)??-1,bs=_hhmmToMinutes_(b.start)??-1;
      return Math.abs(start-bs)-Math.abs(start-as);
    });
    const window=candidates[0];
    if(!window) return [];
    const physical=window.location||unit.base_destination||unit.physical_destination;
    return [{...row,physical_location:physical,stay_unit_id:unit.id,planning_window_id:window.window_id||null,commerce_context:{...(row.commerce_context||{}),physical_destination:physical,stay_unit_id:unit.id,planning_window_id:window.window_id||null}}];
  });
}

function _v3AnnotatePhysicalRows_(rows=[],contract={},units=[]){
  return (rows||[]).map(row=>{
    const cc={...(row.commerce_context||{})};
    if(String(cc.semantic_type||'').toUpperCase()==='TRANSPORT'){
      const physical=cc.origin||row.from||row.physical_location||null;
      return {...row,physical_location:physical,commerce_context:{...cc,physical_destination:physical}};
    }
    const day=Number(row.day),rs=_hhmmToMinutes_(row.start),re=_hhmmToMinutes_(row.end);
    let matchedWindow=null;
    const unit=(units||[]).find(u=>(u.windows||[]).some(w=>{
      if(Number(w.day)!==day) return false;
      const ws=_hhmmToMinutes_(w.start),we=w.open_end?null:_hhmmToMinutes_(w.end);
      const ok=rs!=null&&(ws==null||rs>=ws)&&(we==null||re==null||re<=we);
      if(ok) matchedWindow=w;
      return ok;
    }));
    if(!unit) return row;
    const physical=matchedWindow?.location||unit.base_destination||unit.physical_destination;
    return {...row,physical_location:physical,stay_unit_id:unit.id,planning_window_id:matchedWindow?.window_id||row.planning_window_id||null,commerce_context:{...cc,physical_destination:physical,stay_unit_id:unit.id,planning_window_id:matchedWindow?.window_id||row.planning_window_id||null}};
  });
}

async function _v3GeneratePhysicalStay_(contract,unit,totalDays){
  const stayContract=_v3StayContract_(contract,unit);
  const prompt=`
PHYSICAL STAY GENERATION CONTRACT — authoritative JSON:
${JSON.stringify(stayContract)}

Plan ONLY the useful time supplied for this Trip Story stay card, whose overnight/base destination is ${unit.base_destination||unit.physical_destination}. This is one chronological fragment of a continuous trip.
- Generate tourism/activity rows only. DO NOT generate fixed movements; ITBMO inserts every supplied transfer deterministically.
- Every row must remain inside one supplied planning_window, at that window's physical location, and must use that window's original global day number.
- A Day Trip listed in day_trips belongs to THIS SAME STAY. Plan its destination inside its supplied excursion window and return to the base as defined by the deterministic route. NEVER split a Day Trip into another stay/generation unit.
- Treat the entire stay card—including its Day Trips—as one coherent mini-itinerary: first identify and protect the destination's true must-sees using universal tourism judgment, then choose strong high-fit anchors, group geographically, use realistic dwell times and meals, avoid filler and duplicates, and use partial arrival/departure windows intelligently.
- When a planning window has no explicit start, choose a traveler-friendly start time appropriate to the destination (normally around 08:00–09:00). Do not invent extreme starts such as 05:30 unless a supplied fixed boundary, reservation, special condition or genuinely time-critical experience requires it.
- Do not assume that Day 1 of the parent destination is Day 1 here. Preserve the supplied global day numbers exactly.
- allowed_physical_locations are authoritative for this call; do not plan outside them.
- commerce_context is required on substantive rows: semantic_type, ticket_need, guided_tour_value, canonical_place, destination_priority (essential, high, standard, supporting), commercial_eligible. Mark true flagship must-sees essential/high so the contextual layer can offer both independent access and distinct guided alternatives. Keep traveler notes separate from commerce metadata.
- Never invent operators, reservations, exact station/airport details, opening hours or availability not supplied by the contract.
- Notes must never contradict the row's own start/end time. Do not write a different finishing time inside Notes.
- When from and to are the same place, do not invent a 1-minute transport leg; treat movement inside the attraction as part of the activity.
Return valid city_day JSON only. Do not ask questions.
`.trim();
  const raw=await _v3Call_(prompt,'generate');
  const parsed=parseJSON(raw);
  const rows=_dedupeRows_(_v3ExtractPlanningUnitRows_(parsed,unit.base_destination||unit.physical_destination,totalDays,unit.days));
  return _v3StampStayRows_(rows,unit);
}

async function _v3AuditAndRepairPhysicalStay_(contract,unit,initialRows,totalDays,perDay,baseDate){
  const unitDays=[...new Set((unit.days||[]).map(Number).filter(Boolean))].sort((a,b)=>a-b);
  const unitDaySet=new Set(unitDays);
  const unitCity=unit.base_destination||unit.physical_destination||contract.planning_unit;
  const unitStartDate=unit.windows?.find(w=>w?.date)?.date||baseDate||'';
  // Audit rows keep GLOBAL trip-day numbers, so daylight/date-sensitive QA must
  // retain the trip base date. Using the stay start date with a global day index
  // would double-offset later stays (for example Paris on global day 7).
  const unitAuditBaseDate=baseDate||unitStartDate;
  const scopedRouteDays=(contract.route_days||[]).filter(d=>unitDaySet.has(Number(d.day))).map(day=>({
    ...day,
    // The model never owns inter-stay movements. Local Stay QA therefore audits
    // only the physical windows that belong to this card; fixed boundaries are
    // inserted once, after all independent Stay Units have passed their own QA.
    fixed_transfers:[],
    location_windows:(unit.windows||[]).filter(w=>Number(w.day)===Number(day.day)).map(w=>({
      window_id:w.window_id||null,location:w.location||unitCity,start:w.start||null,end:w.end||null,
      type:'plannable',open_end:Boolean(w.open_end),terminal_arrival:false
    }))
  }));
  const scopedContract={...contract,planning_unit:unitCity,route_days:scopedRouteDays,total_days:totalDays};
  const scopedPerDay=(perDay||[]).filter(x=>unitDaySet.has(Number(x?.day)));
  const filterReport=(report={})=>{
    const errors=(report.errors||[]).filter(error=>{
      const days=[error?.day,...(Array.isArray(error?.days)?error.days:[])].map(Number).filter(Boolean);
      if(days.length && !days.some(day=>unitDaySet.has(day))) return false;
      if(error?.code==='MISSING_DAY'){
        // Every unit day exists because the ownership model assigned at least one
        // physical planning window to this Stay. Therefore an empty unit day is
        // never silently downgraded: it must be generated/repaired before the Stay
        // can be checkpointed. Full transit days are suppressed before unit creation.
        return true;
      }
      // Open-ended days have no fixed clock target. Stay QA relies on meaningful
      // route-window utilization instead of a universal finishing hour.
      return true;
    });
    return {...report,errors};
  };
  // Local Stay QA must audit this Stay's own physical windows. Passing `false`
  // disabled ROUTE_WINDOW_UNDERUSED / ROUTE_WINDOW_TOO_THIN entirely and allowed
  // a nominal row to approve an otherwise empty full day.
  const audit=(rows)=>{
    const base=filterReport(_localGlobalAudit_(unitCity,rows,totalDays,_v3SyntheticMaster_(totalDays),scopedPerDay,unitAuditBaseDate,{day_contexts:scopedRouteDays},unitDays));
    // A Stay cannot checkpoint while one of its own substantial physical windows
    // is absent. Catch this locally so repair can fill post-arrival/post-day-trip
    // windows instead of discovering them only after the deterministic trip merge.
    const physical=_v3PhysicalWindowCoverage_(rows,[unit]);
    const missing=physical.missing.map(w=>({code:'MISSING_PHYSICAL_WINDOW',day:w.day,stay_unit_id:w.stay_unit_id,window_id:w.window_id,location:w.location,window:`${w.start||''}-${w.end||'open'}`,instruction:'Plan useful, coherent content inside this authoritative physical window; do not alter fixed transfers.'}));
    return {...base,errors:[...(base.errors||[]),...missing]};
  };

  let rows=_v3StampStayRows_(_dedupeRows_(initialRows||[]),unit);
  // Reuse deterministic arithmetic/duplicate cleanup, but only against this Stay
  // Unit's own physical windows. No other destination can create QA findings here.
  let normalized=_v3DeterministicQualityCleanup_(unitCity,rows,scopedContract,totalDays,scopedPerDay,unitAuditBaseDate,false,unitDays);
  rows=_v3StampStayRows_(normalized.rows,unit);
  let report=audit(rows);
  let material=_v3MaterialAuditErrors_(report);
  const repairBudget=Math.max(2,Math.min(ITBMO_STAY_LOCAL_REPAIR_MAX_ATTEMPTS,_v3AdaptiveRepairBudget_(scopedContract,Math.max(1,unitDays.length))+1));
  let attempt=0,previousFingerprint='',stagnant=0;

  while(material.length && attempt<repairBudget){
    const fingerprint=_v3IssueFingerprint_(report);
    if(fingerprint===previousFingerprint && stagnant>=2) break;
    previousFingerprint=fingerprint;
    attempt+=1;
    console.warn(`[ITBMO V3 STAY AUDIT] ${unitCity} · ${unit.id}: ${material.length} repairable issue(s); local repair ${attempt}/${repairBudget}`,_v3AuditSummary_(report),material);
    _v3LogAuditDetails_(`LOCAL REPAIR ${attempt}/${repairBudget}`,unitCity,unit.id,material);
    const stayContract=_v3StayContract_(contract,unit);
    const naturalScope=_v3RepairScope_(material);
    // Escalation guardrail: use the smallest safe scope first. If the same Stay
    // still needs its final local attempt, allow a full-Stay repair before failing.
    const repairScope=(attempt>=repairBudget && naturalScope.type!=='stay')?{type:'stay',days:[]}:naturalScope;
    const scopeDays=repairScope.type==='stay'?unitDays:repairScope.days;
    const scopeDaySet=new Set(scopeDays.map(Number));
    const repairRows=repairScope.type==='stay'?rows:rows.filter(r=>scopeDaySet.has(Number(r.day)));
    const repairWindows=repairScope.type==='stay'?(stayContract.windows||[]):(stayContract.windows||[]).filter(w=>scopeDaySet.has(Number(w.day)));
    const repairFindings=repairScope.type==='stay'?material:material.filter(e=>{
      const days=[e?.day,...(Array.isArray(e?.days)?e.days:[])].map(Number).filter(Boolean);
      return !days.length||days.some(d=>scopeDaySet.has(d));
    });
    console.info(`[ITBMO V3 REPAIR SCOPE] ${unitCity} · ${unit.id} · ${repairScope.type}${scopeDays.length?` · day(s) ${scopeDays.join(',')}`:''} · full Stay QA after merge`);
    const prompt=`
PHYSICAL STAY LOCAL QA REPAIR CONTRACT — authoritative JSON:
${JSON.stringify({...stayContract,windows:repairWindows})}

REPAIR SCOPE:
${JSON.stringify({type:repairScope.type,days:scopeDays})}

CURRENT ROWS INSIDE THE REPAIR SCOPE ONLY:
${JSON.stringify(repairRows)}

LOCAL VALIDATOR FINDINGS TO CORRECT:
${JSON.stringify(repairFindings)}

Repair ONLY the supplied scope. Preserve all valid content you can. Keep every returned row inside its supplied planning_window and preserve the supplied global day numbers. Do not output rows for days outside the repair scope and do not output any inter-stay fixed movement. ITBMO will merge this repair into the untouched Stay and then re-audit the COMPLETE Stay before accepting it. Return city_day JSON only.
`.trim();
    const raw=await _v3Call_(prompt);
    const parsed=parseJSON(raw);
    const candidateDays=repairScope.type==='stay'?unitDays:scopeDays;
    const candidate=_v3StampStayRows_(_dedupeRows_(_v3ExtractPlanningUnitRows_(parsed,unitCity,totalDays,candidateDays)),unit);
    if(!candidate.length){stagnant+=1;continue;}
    // Repairs are patches, never replacements. Even a final Stay-scope repair may
    // return only a subset of days; merge only the days actually returned and keep
    // every healthy day/window outside that response frozen.
    const returnedDaySet=new Set(candidate.map(r=>Number(r.day)).filter(Boolean));
    // A repair response is a patch, not permission to erase healthy parts of a
    // returned day. Preserve existing non-overlapping rows that the model omitted,
    // except rows explicitly implicated by the validator finding being repaired.
    // This prevents a one-day duplicate-POI repair from silently deleting a whole
    // morning/afternoon while still allowing the offending POI to disappear.
    const implicatedPoiKeys=new Set(repairFindings.flatMap(f=>[f?.first,f?.second,f?.poi,f?.entity_name]).map(_canonicalText_).filter(Boolean));
    const candidateByDay=new Map();
    candidate.forEach(r=>{const d=Number(r.day);if(!candidateByDay.has(d))candidateByDay.set(d,[]);candidateByDay.get(d).push(r);});
    const preservedReturnedDayRows=rows.filter(r=>{
      const day=Number(r.day);if(!returnedDaySet.has(day))return false;
      const rowPoiKeys=[r?.activity,r?.from,r?.to].map(_canonicalText_).filter(Boolean);
      if(rowPoiKeys.some(k=>[...implicatedPoiKeys].some(p=>p&&(k===p||k.includes(p)||p.includes(k)))))return false;
      const rs=_hhmmToMinutes_(r.start),re=_hhmmToMinutes_(r.end);
      if(rs==null||re==null)return false;
      return !(candidateByDay.get(day)||[]).some(c=>{
        const cs=_hhmmToMinutes_(c.start),ce=_hhmmToMinutes_(c.end);
        return cs!=null&&ce!=null&&Math.max(rs,cs)<Math.min(re,ce);
      });
    });
    const mergedCandidate=[...rows.filter(r=>!returnedDaySet.has(Number(r.day))),...preservedReturnedDayRows,...candidate]
      .sort((a,b)=>Number(a.day)-Number(b.day)||String(a.start||'').localeCompare(String(b.start||'')));
    normalized=_v3DeterministicQualityCleanup_(unitCity,mergedCandidate,scopedContract,totalDays,scopedPerDay,unitAuditBaseDate,false,unitDays);
    const nextRows=_v3StampStayRows_(normalized.rows,unit);
    const nextReport=audit(nextRows);
    const before=_auditScore_(report),after=_auditScore_(nextReport);
    const beforeBlocking=_v3BlockingAuditErrors_(report).length;
    const afterBlocking=_v3BlockingAuditErrors_(nextReport).length;
    const improved=afterBlocking<beforeBlocking || (afterBlocking===beforeBlocking && (after<before || (after===before && (nextReport.errors||[]).length<(report.errors||[]).length)));
    if(improved){rows=nextRows;report=nextReport;material=_v3MaterialAuditErrors_(report);stagnant=0;}
    else{stagnant+=1;}
  }

  // A Stay may never be accepted with a missing global day when that day owns a
  // meaningful planning window. Previously MISSING_DAY could be filtered away,
  // allowing an empty Toledo/Bruges checkpoint that later broke the trip merge.
  // unitDays are already derived from owned physical windows. Requiring every
  // one of them closes the exact failure mode where an all-day/open window with
  // no explicit clock start (e.g. a one-day Stay) was allowed to checkpoint with
  // zero rows and only failed much later at the trip merge.
  const requiredStayDays=[...unitDays];
  const stayCoverage=_v3CoverageForDays_(rows,requiredStayDays,totalDays);
  if(stayCoverage.missing.length){
    const coverageErrors=stayCoverage.missing.map(day=>({code:'MISSING_DAY',day,instruction:'Generate this Stay day inside its authoritative physical planning window.'}));
    report={...report,errors:[...(report.errors||[]),...coverageErrors]};
    material=_v3MaterialAuditErrors_(report);
    console.warn(`[ITBMO V3 STAY COVERAGE BLOCK] ${unitCity} · ${unit.id}`,stayCoverage);
  }

  const blocking=_v3BlockingAuditErrors_(report);
  const warnings=(report.errors||[]).filter(e=>!_v3HardBlockingCodes_().has(String(e?.code||'')));
  console.info(`[ITBMO V3 STAY AUDIT FINAL] ${unitCity} · ${unit.id}`,_v3AuditSummary_(report),report.errors||[]);
  _v3LogAuditDetails_('STAY AUDIT FINAL',unitCity,unit.id,report.errors||[]);
  if(warnings.length) console.warn(`[ITBMO V3 STAY QUALITY WARNINGS] ${unitCity} · ${unit.id}: publishing locally valid stay with non-blocking warnings`,_v3AuditSummary_({errors:warnings}),warnings);
  if(blocking.length){
    const error=new Error(`V3_STAY_QUALITY_BLOCK:${unit.id}:${unitCity}`);
    error.v3BlockingErrors=blocking;
    error.stayUnitId=unit.id;
    throw error;
  }
  return {rows,report,warnings};
}

async function _v3GeneratePhysicalStaySequence_(city,dest,perDay,baseDate,hotel,transport){
  const contract=_v3CompactContract_(city,dest,perDay,baseDate,hotel,transport);
  const units=_v3BuildPhysicalStayUnits_(contract);
  if(!units.length) throw new Error(`V3_NO_PHYSICAL_STAYS:${city}`);
  console.info(`[ITBMO V3 STAYS] trip: ${units.length} independent chronological stay card(s)`,units.map(u=>({id:u.id,place:u.physical_destination,days:u.days,windows:u.windows.length,dayTrips:(u.day_trips||[]).length})));

  // Each Trip Story stay is an independent recoverable transaction. A stay that
  // passes QA is cached immediately and never enters another correction cycle
  // because a different stay failed. Only failed stays consume more model calls.
  const results=new Array(units.length);
  const failures=[];
  let cursor=0;
  const concurrency=Math.min(3,units.length);
  await Promise.all(Array.from({length:concurrency},async()=>{
    while(true){
      const index=cursor++;
      if(index>=units.length) return;
      const unit=units[index];
      const label=unit.base_destination||unit.physical_destination;
      const cached=_v3AcceptedStayGet_(contract,unit);
      if(cached){
        // A checkpoint is reusable only if every cached activity still belongs to
        // one of the CURRENT canonical physical windows. This prevents a cache
        // created under older route semantics from resurrecting Paris-before-arrival
        // or a Day Trip without its current round-trip boundaries.
        const restamped=_v3StampStayRows_(cached.rows,unit);
        if(restamped.length===cached.rows.length){
          results[index]={...cached,rows:restamped,unit,reused:true};
          console.info(`[ITBMO V3 STAY] ${unit.sequence}/${units.length} · ${label} · accepted checkpoint reused`);
          continue;
        }
        console.warn(`[ITBMO V3 STAY CACHE] ${label} · stale physical-window checkpoint rejected`,{cached_rows:cached.rows.length,valid_rows:restamped.length});
        const staleKey=_v3AcceptedStayCacheKey_(contract,unit);
        _v3AcceptedStayCache_.delete(staleKey);
        try{sessionStorage.removeItem(staleKey);}catch(_){}
      }

      let accepted=null,lastError=null;
      for(let stayAttempt=1;stayAttempt<=ITBMO_STAY_GENERATION_MAX_ATTEMPTS&&!accepted;stayAttempt++){
        try{
          console.log(`[ITBMO V3 STAY] ${unit.sequence}/${units.length} · ${label} · isolated attempt ${stayAttempt}/${ITBMO_STAY_GENERATION_MAX_ATTEMPTS}`);
          const generated=await _v3GeneratePhysicalStay_(contract,unit,dest.days);
          const audited=await _v3AuditAndRepairPhysicalStay_(contract,unit,generated,dest.days,perDay,baseDate);
          accepted={unit,rows:audited.rows,audit:audited.report,warnings:audited.warnings,accepted_attempt:stayAttempt};
          _v3AcceptedStaySet_(contract,unit,{rows:accepted.rows,audit:accepted.audit,warnings:accepted.warnings,accepted_attempt:stayAttempt});
        }catch(error){
          lastError=error;
          const qualityBlock=/V3_STAY_QUALITY_BLOCK/.test(String(error?.message||''));
          console.warn(`[ITBMO V3 STAY RETRY] ${label} · isolated attempt ${stayAttempt} failed`,error?.v3BlockingErrors||error);
          if(!qualityBlock)break;
        }
      }
      if(accepted)results[index]=accepted;
      else failures.push({index,unit,error:lastError});
    }
  }));

  if(failures.length){
    const error=new Error(`V3_STAY_RECOVERY_EXHAUSTED:${failures.map(x=>x.unit?.base_destination||x.unit?.physical_destination||x.unit?.id).join(',')}`);
    error.v3FailedStays=failures.map(x=>({stay_unit_id:x.unit?.id,destination:x.unit?.base_destination||x.unit?.physical_destination,blocking_errors:x.error?.v3BlockingErrors||[],message:String(x.error?.message||'V3_STAY_FAILED')}));
    throw error;
  }

  // Deterministic merger: model outputs never decide trip order or inter-stay
  // movements. Flatten in Trip Story sequence, then insert the authoritative
  // boundaries exactly once and sort by global day/time.
  let rows=_v3DedupeMergedStayRows_(results.flatMap(result=>result?.rows||[]));
  rows=_v3EnforceHardRouteFacts_(rows,contract);
  rows=_v3AnnotatePhysicalRows_(rows,contract,units)
    .sort((a,b)=>Number(a.day)-Number(b.day)||String(a.start||'').localeCompare(String(b.start||'')));
  return {rows,contract,units,stayResults:results};
}

async function _v3GeneratePlanningUnit_(city,dest,perDay,baseDate,hotel,transport){
  const contract=_v3CompactContract_(city,dest,perDay,baseDate,hotel,transport);
  const prompt=`
GENERATION CONTRACT — authoritative JSON:
${JSON.stringify(contract)}

Generate the complete planning unit in one pass.
TRANSPORT DECISION RULE: A mode explicitly selected by the user is authoritative for a fixed movement and must be preserved. For local mobility, intelligently recommend one default plus up to two useful alternatives when traveler context can change the best choice. In Transport give every option its own door-to-door estimate and relevant condition, for example “Recomendado: a pie (12–15 min) · Metro (8–12 min, si quieren reducir esfuerzo)”. The duration Transport range must safely cover every listed choice. Do not invent operators, stops, schedules or availability, and do not list alternatives that add no decision value.
IMPORTANT IDENTITY RULE: planning_unit is the MAIN destination block, not the physical city for every day. A day remains part of this planning unit even when its physical location is another city/place from route_days. Use route_days[].day as the authoritative day identity. city_day[].city may name that day's actual physical location; it does NOT need to equal planning_unit. Include every planning-unit day 1..total_days exactly once or in multiple blocks sharing that same day when the day has multiple physical windows. Internally choose distinct day identities and anchors before writing rows, but output only the final itinerary JSON. Use every physically available window correctly. Do not ask questions.
`.trim();
  const raw=await _v3Call_(prompt,'generate');
  const parsed=parseJSON(raw);
  const rows=_dedupeRows_(_v3ExtractPlanningUnitRows_(parsed,city,dest.days));
  return {rows,contract};
}

function _v3DedupeMergedStayRows_(rows=[]){
  const seen=new Set(),out=[];
  for(const row of (rows||[])){
    const r=normalizeRow(row,Number(row?.day||1));
    const exact=[Number(r.day),r.start,r.end,_canonicalText_(r.activity),_canonicalText_(r.from),_canonicalText_(r.to),String(r.stay_unit_id||''),String(r.planning_window_id||'')].join('|');
    if(seen.has(exact)) continue;
    seen.add(exact);out.push(r);
  }
  return out.sort((a,b)=>Number(a.day)-Number(b.day)||String(a.start||'').localeCompare(String(b.start||'')));
}

function _v3CoverageForDays_(rows=[],expectedDays=[],totalDays=1){
  const maxDay=Math.max(1,Number(totalDays)||1);
  const expected=[...new Set((expectedDays||[]).map(Number).filter(d=>Number.isInteger(d)&&d>=1&&d<=maxDay))].sort((a,b)=>a-b);
  const expectedSet=new Set(expected);
  const received=[...new Set((rows||[]).map(r=>Number(r?.day)).filter(d=>expectedSet.has(d)))].sort((a,b)=>a-b);
  const missing=expected.filter(d=>!received.includes(d));
  const counts=Object.fromEntries(expected.map(d=>[d,(rows||[]).filter(r=>Number(r?.day)===d).length]));
  return {expected,received,missing,counts,rowCount:(rows||[]).length};
}

function _v3Coverage_(rows=[],totalDays=1){
  const expected=Array.from({length:Number(totalDays)||0},(_,i)=>i+1);
  const received=[...new Set((rows||[]).map(r=>Number(r?.day)).filter(d=>Number.isInteger(d)&&d>=1&&d<=Number(totalDays)))].sort((a,b)=>a-b);
  const missing=expected.filter(d=>!received.includes(d));
  const counts=Object.fromEntries(expected.map(d=>[d,(rows||[]).filter(r=>Number(r?.day)===d).length]));
  return {expected,received,missing,counts,rowCount:(rows||[]).length};
}

async function _v3RepairMissingDays_(city,rows,contract,totalDays){
  const coverage=_v3Coverage_(rows,totalDays);
  if(!coverage.missing.length) return {rows,coverage,repaired:false};
  console.warn(`[ITBMO V3 COVERAGE] ${city}: repairing missing day(s) ${coverage.missing.join(', ')}`,coverage);
  const scopedContract={
    ...contract,
    repair_scope_days:coverage.missing,
    route_days:(contract.route_days||[]).filter(d=>coverage.missing.includes(Number(d.day)))
  };
  const prompt=`
MISSING-DAY REPAIR CONTRACT — authoritative JSON:
${JSON.stringify(scopedContract)}

ALREADY VALID DAYS — DO NOT REGENERATE THEM:
${JSON.stringify(_rowsByDayObject_(rows))}

The previous response omitted day(s) ${coverage.missing.join(', ')}. Generate ONLY those missing days. Preserve every hard physical window and USER_FIXED movement exactly. Return city_day JSON containing every requested missing day and no other days.
`.trim();
  const raw=await _v3Call_(prompt);
  const parsed=parseJSON(raw);
  const repaired=_dedupeRows_(_v3ExtractPlanningUnitRows_(parsed,city,totalDays)).filter(r=>coverage.missing.includes(Number(r?.day)));
  const merged=_dedupeRows_([...rows,...repaired]).sort((a,b)=>Number(a.day)-Number(b.day)||String(a.start||'').localeCompare(String(b.start||'')));
  const next=_v3Coverage_(merged,totalDays);
  console.info(`[ITBMO V3 COVERAGE] ${city}: after scoped missing-day repair`,next);
  return {rows:merged,coverage:next,repaired:next.missing.length<coverage.missing.length};
}

async function _v3RepairAffectedStayUnits_(city,rows,contract,units,report,totalDays,perDay,baseDate){
  const errors=_v3MaterialAuditErrors_(report);
  const affectedDays=new Set(errors.flatMap(e=>[e?.day,...(Array.isArray(e?.days)?e.days:[])]).map(Number).filter(Boolean));
  const affectedUnits=(units||[]).filter(u=>(u.days||[]).some(day=>affectedDays.has(Number(day))));
  if(!affectedUnits.length) return {rows,report,repaired:false};

  let candidateRows=[...(rows||[])],changed=false;
  for(const unit of affectedUnits){
    const stayContract=_v3StayContract_(contract,unit);
    const current=candidateRows.filter(r=>r?.stay_unit_id===unit.id && String(r?.commerce_context?.semantic_type||'').toUpperCase()!=='TRANSPORT');
    const unitErrors=errors.filter(e=>affectedDays.has(Number(e?.day)) && (unit.days||[]).includes(Number(e?.day)));
    const prompt=`
PHYSICAL STAY SURGICAL REPAIR CONTRACT — authoritative JSON:
${JSON.stringify(stayContract)}

CURRENT ROWS FOR THIS PHYSICAL STAY:
${JSON.stringify(current)}

VALIDATOR FINDINGS RELEVANT TO THIS STAY:
${JSON.stringify(unitErrors)}

Rebuild ONLY this Trip Story stay card, including any Day Trips listed in its contract. Keep every row inside its supplied planning_window at that window's physical location and preserve the original global day numbers. Do not output fixed movements; ITBMO owns them deterministically. Correct the findings while preserving strong valid choices. Return city_day JSON only.
`.trim();
    const raw=await _v3Call_(prompt);
    const parsed=parseJSON(raw);
    const repaired=_v3StampStayRows_(_dedupeRows_(_v3ExtractPlanningUnitRows_(parsed,city,totalDays)),unit);
    if(!repaired.length) continue;
    candidateRows=candidateRows.filter(r=>r?.stay_unit_id!==unit.id || String(r?.commerce_context?.semantic_type||'').toUpperCase()==='TRANSPORT');
    candidateRows.push(...repaired);
    changed=true;
  }
  if(!changed) return {rows,report,repaired:false};
  candidateRows=_v3AnnotatePhysicalRows_(_v3EnforceHardRouteFacts_(_dedupeRows_(candidateRows),contract),contract,units)
    .sort((a,b)=>Number(a.day)-Number(b.day)||String(a.start||'').localeCompare(String(b.start||'')));
  const nextReport=_localGlobalAudit_(city,candidateRows,totalDays,_v3SyntheticMaster_(totalDays),perDay,baseDate);
  return _auditScore_(nextReport)<_auditScore_(report)
    ? {rows:candidateRows,report:nextReport,repaired:true}
    : {rows,report,repaired:false};
}

async function _v3RepairAffectedDays_(city,rows,contract,report,totalDays,perDay,baseDate){
  const errors=_v3MaterialAuditErrors_(report);
  const affected=[...new Set(errors.flatMap(e=>[e?.day,...(Array.isArray(e?.days)?e.days:[])]).map(Number).filter(d=>d>=1&&d<=totalDays))].sort((a,b)=>a-b);
  if(!affected.length) return {rows,report,repaired:false};

  const current=rows.filter(r=>affected.includes(Number(r?.day)));
  const scopedContract={
    ...contract,
    repair_scope_days:affected,
    route_days:(contract.route_days||[]).filter(d=>affected.includes(Number(d.day)))
  };
  const prompt=`
SURGICAL REPAIR CONTRACT — authoritative JSON:
${JSON.stringify(scopedContract)}

CURRENT ROWS FOR THE AFFECTED DAYS:
${JSON.stringify(current)}

DETERMINISTIC VALIDATOR ERRORS:
${JSON.stringify(errors)}

Rebuild ONLY days ${affected.join(', ')}. Correct every validator error while preserving all hard route windows, fixed movements, preferences and strong valid tourism choices. Return city_day JSON containing ONLY those repaired days. Do not regenerate unaffected days.
`.trim();

  const raw=await _v3Call_(prompt);
  const parsed=parseJSON(raw);
  const repaired=_dedupeRows_(_v3ExtractPlanningUnitRows_(parsed,city,totalDays)).filter(r=>affected.includes(Number(r?.day)));
  if(!repaired.length || !affected.every(day=>repaired.some(r=>Number(r?.day)===day))){
    return {rows,report,repaired:false};
  }
  const merged=_dedupeRows_([
    ...rows.filter(r=>!affected.includes(Number(r?.day))),
    ...repaired
  ]).sort((a,b)=>Number(a.day)-Number(b.day)||String(a.start||'').localeCompare(String(b.start||'')));
  const nextReport=_localGlobalAudit_(city,merged,totalDays,_v3SyntheticMaster_(totalDays),perDay,baseDate);
  return _auditScore_(nextReport)<_auditScore_(report)
    ? {rows:merged,report:nextReport,repaired:true}
    : {rows,report,repaired:false};
}

async function generateCityItinerary(city,{silentFailure=false}={}){
  if(ITBMO_GENERATION_ENGINE!=='v3') return _generateCityItineraryLegacy_(city,{silentFailure});
  delete _v3LastFailureByCity_[city];
  const started=performance.now();
  const record=()=>{
    if(!_astraGenerationMetrics_.active) return;
    const elapsed=performance.now()-started;
    const existing=_astraGenerationMetrics_.cities.find(x=>x.city===city);
    const value={city,ms:Math.round(elapsed),duration:_formatGenerationDuration_(elapsed),engine:'v3'};
    if(existing) Object.assign(existing,value); else _astraGenerationMetrics_.cities.push(value);
    console.log(`[ITBMO V3 TIMER] ${city}: ${value.duration}`);
  };
  const dest=savedDestinations.find(x=>x.city===city);
  if(!dest) return false;
  const perDay=_normalizePerDayForPrompt_(city,dest.days,dest.perDay||[]);
  const baseDate=cityMeta[city]?.baseDate||dest.baseDate||'';
  const hotel=cityMeta[city]?.hotel||'';
  const transport=cityMeta[city]?.transport||'recommend me';
  showWOW(true,t('overlayGenerating'));

  try{
    console.log(`[ITBMO V3] Continuous Trip Story: independent Stay Units in parallel; deterministic merge`);
    const generated=await _v3GeneratePhysicalStaySequence_(city,dest,perDay,baseDate,hotel,transport);
    let rows=generated.rows||[];
    if(!rows.length) throw new Error(`V3_EMPTY:${city}`);

    // At this point every Stay Unit has already passed its own semantic/local QA.
    // The merged trip receives only a final HARD physical-integrity gate. We do
    // not re-run trip-wide semantic repair, which would couple independent stays
    // and recreate the historical "everything belongs to Madrid" behavior.
    const coverage=_v3Coverage_(rows,dest.days);
    const physicalWindowCoverage=_v3PhysicalWindowCoverage_(rows,generated.units||[]);
    console.info(`[ITBMO V3 MERGE COVERAGE] trip`,coverage);
    console.info(`[ITBMO V3 MERGE WINDOW COVERAGE] trip`,physicalWindowCoverage);
    if(coverage.missing.length){
      const error=new Error(`V3_INCOMPLETE_AFTER_STAY_MERGE:missing_days=${coverage.missing.join(',')}:rows=${coverage.rowCount}`);
      error.v3Coverage=coverage;
      throw error;
    }

    const master=_v3SyntheticMaster_(dest.days);
    const finalReport=_v3MergedHardPhysicalAudit_(rows,generated.contract,dest.days);
    const blockingErrors=finalReport.errors||[];
    console.info(`[ITBMO V3 MERGE HARD AUDIT FINAL] trip`,_v3AuditSummary_({errors:blockingErrors}),blockingErrors);
    _v3LogAuditDetails_('MERGED TRIP HARD AUDIT','trip','all-stays',blockingErrors);
    if(blockingErrors.length){
      const error=new Error(`V3_ROUTE_PHYSICAL_BLOCK_AFTER_MERGE:trip`);
      error.v3BlockingErrors=blockingErrors;
      throw error;
    }
    // Preserve local Stay QA reports for diagnostics/recovery without allowing a
    // later destination to invalidate an already accepted independent stay.
    const report={errors:[],stay_units:(generated.stayResults||[]).map(result=>({
      stay_unit_id:result.unit?.id,
      destination:result.unit?.base_destination||result.unit?.physical_destination,
      errors:result.audit?.errors||[]
    }))};

    if(!itineraries[city]) itineraries[city]={byDay:{},currentDay:1,baseDate:baseDate||null,masterPlan:[],audit:null};
    itineraries[city].masterPlan=master;
    itineraries[city].audit=report;

    // V2.10.25 · CANONICAL COMMIT. The rows that passed MERGE HARD AUDIT are the
    // authoritative export shape. Do not send them through pushRows(): that legacy
    // helper normalizes, semantic-dedupes and reconciles timelines and therefore can
    // mutate an already-approved physical trip. Group exact audited rows by day and
    // make every downstream consumer (PDF/Excel/Workspace/checkpoint) read that same
    // sealed shape.
    const canonicalRows=(rows||[]).map(row=>({
      ...row,
      commerce_context:(row?.commerce_context&&typeof row.commerce_context==='object')?{...row.commerce_context}:row?.commerce_context
    }));
    const canonicalByDay={};
    canonicalRows.forEach(row=>{
      const d=Math.max(1,Number(row?.day)||1);
      if(!canonicalByDay[d]) canonicalByDay[d]=[];
      canonicalByDay[d].push(row);
    });
    for(let d=1;d<=Math.max(1,Number(dest.days)||1);d++){
      if(!canonicalByDay[d]) canonicalByDay[d]=[];
      canonicalByDay[d].sort((a,b)=>(_hhmmToMinutes_(a?.start)??99999)-(_hhmmToMinutes_(b?.start)??99999));
    }
    itineraries[city].byDay=canonicalByDay;

    // The only FINAL hard audit now runs on exactly the canonical rows consumed by
    // exports and persistence. No transformation is allowed between PASS and publish.
    let storedRows=Object.values(canonicalByDay).flatMap(dayRows=>Array.isArray(dayRows)?dayRows:[]);
    let postStoreReport=_v3MergedHardPhysicalAudit_(storedRows,generated.contract,dest.days);
    let postStoreErrors=postStoreReport.errors||[];
    console.info(`[ITBMO V3 CANONICAL HARD AUDIT FINAL] trip`,_v3AuditSummary_({errors:postStoreErrors}),postStoreErrors);

    // Emergency belt-and-suspenders only: canonical commit should make this path
    // exceptional. If immutable route facts are ever missing/overlapped, restore
    // them deterministically from the Movement Ledger and re-audit without Luna.
    const selfHealCodes=new Set(['MISSING_USER_FIXED_TRANSFER','ACTIVITY_OVERLAPS_USER_FIXED_TRANSFER']);
    if(postStoreErrors.length && postStoreErrors.every(e=>selfHealCodes.has(String(e?.code||'')))){
      console.warn('[ITBMO V3 CANONICAL SELF-HEAL] restoring immutable route facts',postStoreErrors);
      storedRows=_v3EnforceHardRouteFacts_(storedRows,generated.contract);
      const healedByDay={};
      storedRows.forEach(row=>{
        const d=Math.max(1,Number(row?.day)||1);
        if(!healedByDay[d]) healedByDay[d]=[];
        healedByDay[d].push(row);
      });
      for(let d=1;d<=Math.max(1,Number(dest.days)||1);d++){
        if(!healedByDay[d]) healedByDay[d]=[];
        healedByDay[d].sort((a,b)=>(_hhmmToMinutes_(a?.start)??99999)-(_hhmmToMinutes_(b?.start)??99999));
      }
      itineraries[city].byDay=healedByDay;
      storedRows=Object.values(healedByDay).flatMap(dayRows=>Array.isArray(dayRows)?dayRows:[]);
      postStoreReport=_v3MergedHardPhysicalAudit_(storedRows,generated.contract,dest.days);
      postStoreErrors=postStoreReport.errors||[];
      console.info(`[ITBMO V3 CANONICAL SELF-HEAL AUDIT] trip`,_v3AuditSummary_({errors:postStoreErrors}),postStoreErrors);
    }

    if(postStoreErrors.length){
      const error=new Error(`V3_EXPORT_SHAPE_BLOCK:trip`);
      error.code='V3_EXPORT_SHAPE_BLOCK';
      error.v3BlockingErrors=postStoreErrors;
      throw error;
    }
    renderCityTabs();
    if(!activeCity) setActiveCity(city);
    if(activeCity===city) renderCityItinerary(city);
    $resetBtn?.removeAttribute('disabled');
    if(plannerState?.forceReplan) delete plannerState.forceReplan[city];
    _v3AcceptedStayClear_(generated.contract,generated.units||[]);
    record();
    return true;
  }catch(error){
    _v3LastFailureByCity_[city]=String(error?.message||error?.code||'V3_FAILED');
    console.error(`[ITBMO V3] ${city} failed`,error);
    /* V3 is authoritative. Never fall back automatically to the historical
       Master Plan/Block pipeline: that path can multiply latency and tokens and
       makes a V3 benchmark impossible to interpret. The orchestrator may retry
       V3 once after a real failure. */
    record();
    if(!silentFailure) chatMsg(getLang()==='es'?'No pude completar el itinerario. Intenta nuevamente.':'I could not complete the itinerary. Please retry.','ai');
    return false;
  }finally{
    // V3 generation is orchestrated as one atomic visible transaction.
    // runPaidGeneration owns the overlay so internal city retries/repairs never
    // expose an idle Planner state between attempts.
  }
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
      hotel:(city)=>`Para <strong>${city}</strong>, completa estos dos datos. Si todavía no tienes alguno claro, escribe <strong>“recomiéndame”</strong>.`,
      itinerary:'Antes de generar: ¿en qué <strong>idioma</strong> quieres tu itinerario? (Ej: Español, English, Português, Français, Deutsch…)'
    },
    en:{
      hotel:(city)=>`For <strong>${city}</strong>, complete these two details. If you are not sure about either one yet, type <strong>“recommend”</strong>.`,
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

function _hotelTransportComposerLabels_(){
  const lang=agentConversationLang || (getLang()==='es' ? 'es' : 'en');
  const labels={
    es:{lodging:'Hospedaje',transport:'Medio de transporte'},
    en:{lodging:'Lodging',transport:'Transport'},
    pt:{lodging:'Hospedagem',transport:'Meio de transporte'},
    fr:{lodging:'Hébergement',transport:'Moyen de transport'},
    de:{lodging:'Unterkunft',transport:'Verkehrsmittel'},
    it:{lodging:'Alloggio',transport:'Mezzo di trasporto'},
    ja:{lodging:'宿泊先',transport:'移動手段'},
    ko:{lodging:'숙소',transport:'교통수단'},
    zh:{lodging:'住宿',transport:'交通方式'},
    ru:{lodging:'Проживание',transport:'Транспорт'},
    ar:{lodging:'الإقامة',transport:'وسيلة النقل'}
  };
  return labels[lang] || labels.en;
}

function _autoGrowPlanningChatInput_(){
  if(!$chatI || $chatI.tagName!=='TEXTAREA') return;
  $chatI.style.height='auto';
  const computed=getComputedStyle($chatI);
  const maxHeight=parseFloat(computed.maxHeight) || 168;
  const target=Math.min($chatI.scrollHeight,maxHeight);
  $chatI.style.height=`${target}px`;
  $chatI.classList.toggle('is-scrollable',$chatI.scrollHeight>maxHeight+1);
}

function _setHotelTransportComposerTemplate_(){
  if(!$chatI || !collectingHotels || metaProgressIndex>=savedDestinations.length) return;
  const labels=_hotelTransportComposerLabels_();
  $chatI.value=`${labels.lodging}:\n\n${labels.transport}:`;
  _autoGrowPlanningChatInput_();
  const cursor=labels.lodging.length+1;
  requestAnimationFrame(()=>{
    try{
      $chatI.focus({preventScroll:true});
      $chatI.setSelectionRange(cursor,cursor);
    }catch(_){
      try{ $chatI.focus(); }catch(__){}
    }
  });
}

function _parseStructuredHotelTransport_(text){
  const raw=String(text||'');
  const labels=[
    ['Hospedaje','Medio de transporte'],
    ['Lodging','Transport'],
    ['Hospedagem','Meio de transporte'],
    ['Hébergement','Moyen de transport'],
    ['Unterkunft','Verkehrsmittel'],
    ['Alloggio','Mezzo di trasporto'],
    ['宿泊先','移動手段'],
    ['숙소','교통수단'],
    ['住宿','交通方式'],
    ['Проживание','Транспорт'],
    ['الإقامة','وسيلة النقل']
  ];
  const escapeRegExp=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

  for(const [lodgingLabel,transportLabel] of labels){
    const re=new RegExp(`^\\s*${escapeRegExp(lodgingLabel)}\\s*:\\s*([\\s\\S]*?)\\s*${escapeRegExp(transportLabel)}\\s*:\\s*([\\s\\S]*)$`,'i');
    const match=raw.match(re);
    if(!match) continue;
    return {
      structured:true,
      hotel:String(match[1]||'').trim(),
      transport:String(match[2]||'').trim() || 'recomiéndame'
    };
  }
  return {structured:false,hotel:'',transport:''};
}

function _generationISOToDMY_(value){
  const match=String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value || '');
}

function _generationCityComplete_(city){
  const destination=savedDestinations.find(x=>x.city===city);
  const totalDays=Math.max(0,Number(destination?.days || 0));
  const byDay=itineraries?.[city]?.byDay || {};
  if(!totalDays) return false;
  for(let day=1;day<=totalDays;day++){
    if(!Array.isArray(byDay[day]) || byDay[day].length===0) return false;
  }
  return true;
}

function _generationCheckpointSnapshot_(extra={}){
  const completed=[...new Set(
    (generationRecoveryState?.completed_cities || [])
      .filter(city=>_generationCityComplete_(city))
  )];
  return {
    schema_version:2,
    generation_engine:'v3',
    completed_cities:completed,
    pending_cities:savedDestinations.map(x=>x.city).filter(city=>!completed.includes(city)),
    city_attempts:{...(generationRecoveryState?.city_attempts || {})},
    itineraries,
    city_meta:cityMeta,
    planner_state:{
      specialConditions:plannerState?.specialConditions || '',
      travelers:plannerState?.travelers || {},
      travelerProfiles:plannerState?.travelerProfiles || null,
      itineraryLang:plannerState?.itineraryLang || '',
      travelModelV2:plannerState?.travelModelV2 || null,
      preferencesV2:plannerState?.preferencesV2 || null
    },
    last_error:generationRecoveryState?.last_error || null,
    ...extra
  };
}

async function _persistGenerationCheckpoint_(status='generating',extra={}){
  if(generationResetInProgress) throw _generationCancelledError_();
  const token=getStoredSessionToken();
  if(!token || !currentTripId) throw new Error('GENERATION_SESSION_REQUIRED');
  const checkpoint=_generationCheckpointSnapshot_(extra);
  generationRecoveryState=checkpoint;

  let lastError=null;
  for(let attempt=0;attempt<3;attempt++){
    if(generationResetInProgress) throw _generationCancelledError_();
    if(!navigator.onLine) await _waitForGenerationConnection_();
    if(generationResetInProgress) throw _generationCancelledError_();
    try{
      return await tripApi({
        action:'generation_checkpoint',
        session_token:token,
        trip_id:currentTripId,
        status,
        checkpoint
      });
    }catch(err){
      lastError=err;
      if(attempt<2) await new Promise(resolve=>setTimeout(resolve,1500*(attempt+1)));
    }
  }
  throw lastError || new Error('GENERATION_CHECKPOINT_FAILED');
}

async function _waitForGenerationConnection_(){
  if(navigator.onLine) return;
  showWOW(true,getLang()==='es'
    ? 'Conexión interrumpida. ITBMO continuará automáticamente cuando vuelva internet…'
    : 'Connection interrupted. ITBMO will continue automatically when internet returns…');
  await new Promise(resolve=>window.addEventListener('online',resolve,{once:true}));
}

function _hydrateGenerationTrip_(trip){
  if(!trip?.id) return false;
  currentTripId=trip.id;
  storeActiveTripId(currentTripId);

  const rawDestinations=Array.isArray(trip.destinations) ? trip.destinations : [];
  savedDestinations=rawDestinations.map(destination=>({
    city:String(destination?.city || '').trim(),
    country:String(destination?.country || '').trim(),
    days:Math.max(1,Number(destination?.days || 1)),
    baseDate:_generationISOToDMY_(destination?.base_date || destination?.baseDate || ''),
    perDay:Array.isArray(destination?.per_day)
      ? destination.per_day
      : (Array.isArray(destination?.perDay) ? destination.perDay : [])
  })).filter(destination=>destination.city);
  if(!savedDestinations.length) return false;

  const checkpoint=(trip.itinerary_data && typeof trip.itinerary_data==='object')
    ? trip.itinerary_data
    : {};
  generationRecoveryState={
    ...checkpoint,
    completed_cities:Array.isArray(checkpoint.completed_cities) ? checkpoint.completed_cities : [],
    city_attempts:(checkpoint.city_attempts && typeof checkpoint.city_attempts==='object')
      ? checkpoint.city_attempts
      : {},
    generation_count:Number(trip.generation_count || 0)
  };

  itineraries=(checkpoint.itineraries && typeof checkpoint.itineraries==='object')
    ? checkpoint.itineraries
    : {};
  cityMeta=(checkpoint.city_meta && typeof checkpoint.city_meta==='object')
    ? checkpoint.city_meta
    : {};

  const persistedPlanner=(trip.planner_input && typeof trip.planner_input==='object')
    ? trip.planner_input
    : {};
  const checkpointPlanner=(checkpoint.planner_state && typeof checkpoint.planner_state==='object')
    ? checkpoint.planner_state
    : {};
  plannerState={...plannerState,...persistedPlanner,...checkpointPlanner,destinations:[...savedDestinations]};
  plannerState.travelModelV2=checkpointPlanner.travelModelV2 || persistedPlanner.travel_model_v2 || persistedPlanner.travelModelV2 || plannerState.travelModelV2 || null;
  plannerState.preferencesV2=checkpointPlanner.preferencesV2 || persistedPlanner.preferences_v2 || persistedPlanner.preferencesV2 || plannerState.preferencesV2 || null;
  if(_travelV2()?.state && plannerState.preferencesV2){
    _travelV2().state.preferences={global:{...(plannerState.preferencesV2.global||{})},places:{...(plannerState.preferencesV2.places||{})}};
    _travelV2().state.itineraryLanguage=plannerState.preferencesV2.itinerary_language || plannerState.itineraryLang || '';
  }

  savedDestinations.forEach(destination=>{
    if(!itineraries[destination.city]){
      itineraries[destination.city]={byDay:{},currentDay:1,baseDate:destination.baseDate||null,masterPlan:[],audit:null};
    }
    if(!cityMeta[destination.city]){
      cityMeta[destination.city]={baseDate:destination.baseDate||null,start:null,end:null,hotel:'',transport:'',perDay:destination.perDay||[]};
    }
  });

  if($cityList){
    $cityList.innerHTML='';
    savedDestinations.forEach(destination=>{
      addCityRow(destination);
      const row=qsa('.city-row',$cityList).at(-1);
      const windows=destination.perDay || [];
      qsa('.hours-day',row).forEach((dayRow,index)=>{
        const windowData=windows[index] || {};
        setTimeSelectorValue(qs('[data-time-type="start"]',dayRow),windowData.start || '');
        setTimeSelectorValue(qs('[data-time-type="end"]',dayRow),windowData.end || '');
      });
    });
    updateAddCityButtonState();
    if(plannerState.travelModelV2) _travelV2()?.restore?.(plannerState.travelModelV2,qsa('.city-row',$cityList));
  }

  hasSavedOnce=true;
  planningStarted=true;
  collectingHotels=false;
  // Hydration alone is NOT proof of payment. Entitlement is checked by the caller
  // against /api/payment status before the post-payment lock is applied.
  hidePreferencesStage({reset:false});
  if($preferencesField){
    $preferencesField.value=plannerState.specialConditions || trip.special_conditions || '';
    $preferencesField.readOnly=true;
  }
  if($start){
    $start.disabled=true;
    $start.setAttribute('aria-disabled','true');
    $start.dataset.itbmoConsumed='1';
  }
  $resetBtn?.removeAttribute('disabled');
  if($chatBox) $chatBox.style.display='flex';
  renderCityTabs();
  setExportToolbarVisibility(trip.status==='generated');
  restoreInfoChatStateForTrip(currentTripId,persistedPlanner.info_chat_state);
  return true;
}

function _showGenerationRetry_(reason=''){
  showWOW(false);
  setPlanningChatLocked(true);
  qs('#itbmo-generation-retry')?.remove();
  document.querySelector('.itbmo-generation-recovery-overlay')?.remove();

  const exhausted=Number(generationRecoveryState?.generation_count || 0)>=2;
  const es=getLang()==='es';
  const integrityFailure=/V3_EXPORT_SHAPE_BLOCK|V3_STAY_RECOVERY_EXHAUSTED|V3_ROUTE_QUALITY_BLOCK|V3_ROUTE_PHYSICAL_BLOCK_AFTER_MERGE|MISSING_PHYSICAL_WINDOW|MISSING_USER_FIXED_TRANSFER|POST_STORAGE/i.test(String(reason||''));
  const overlay=document.createElement('div');
  overlay.className='itbmo-postpay-overlay itbmo-generation-recovery-overlay';
  overlay.innerHTML=`<div class="itbmo-postpay-card" role="dialog" aria-modal="true" aria-labelledby="itbmo-recovery-title" style="position:relative">
    ${integrityFailure?'':`<button id="itbmo-generation-recovery-close" type="button" aria-label="${es?'Cerrar':'Close'}" title="${es?'Cerrar':'Close'}" style="position:absolute;right:18px;top:14px;border:0;background:transparent;font-size:30px;line-height:1;color:#667085;cursor:pointer;padding:6px 10px">×</button>`}
    <div class="itbmo-postpay-icon">↻</div>
    <h3 id="itbmo-recovery-title">${integrityFailure
      ? (es?'Estamos terminando de validar tu itinerario':'We are finishing validation of your itinerary')
      : (exhausted ? (es?'Necesitamos ayudarte a recuperar tu viaje':'We need to help recover your trip') : (es?'Tu generación quedó pendiente':'Your generation was interrupted'))}</h3>
    <p>${integrityFailure
      ? (es?'Tu recorrido y tus destinos se generaron correctamente. Detectamos un detalle de conexión que debemos verificar antes de entregarte los archivos. Lo ya generado se conserva y no necesitas pagar de nuevo.':'Your route and destinations were generated correctly. We detected a connection detail that must be verified before delivering your files. Everything already generated is preserved and you do not need to pay again.')
      : (exhausted
        ? (es?'La generación no pudo completarse, pero tu pago permanece registrado. Puedes volver a intentarlo o contactar a Soporte si necesitas ayuda.':'Generation could not be completed, but your payment remains recorded. You can try again or contact Support if you need help.')
        : (es?'Detectamos un proceso de generación interrumpido. Tu pago continúa activo y puedes volver a intentarlo sin pagar de nuevo.':'We detected an interrupted generation. Your payment remains active and you can try again without paying again.'))}</p>
    <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:22px">
      <button id="itbmo-generation-retry" type="button">${integrityFailure?(es?'Reintentar verificación':'Retry verification'):(es?'Reintentar generación':'Retry generation')}</button>
      ${exhausted&&!integrityFailure?`<button id="itbmo-generation-reset" type="button" class="btn warn">${es?'Reiniciar itinerario':'Reset itinerary'}</button><button id="itbmo-generation-support" type="button" style="background:#fff;color:#24345f;border:1px solid #d6dbea">${es?'Contactar Soporte':'Contact Support'}</button>`:''}
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const closeRecovery=()=>{
    overlay.remove();
    setPlanningChatLocked(false);
    $resetBtn?.removeAttribute('disabled');
  };
  overlay.querySelector('#itbmo-generation-recovery-close')?.addEventListener('click',closeRecovery);
  overlay.addEventListener('click',(event)=>{ if(!integrityFailure && event.target===overlay) closeRecovery(); });
  overlay.querySelector('#itbmo-generation-reset')?.addEventListener('click',()=>{
    // Keep the recovery overlay/state intact until the traveler CONFIRMS reset.
    // The canonical reset flow is allowed to cancel an in-flight/exhausted generation
    // only when it was explicitly requested from this recovery escape hatch.
    generationResetRequestedFromRecovery=true;
    $resetBtn?.removeAttribute('disabled');
    if($resetBtn){
      $resetBtn.click();
      return;
    }
    generationResetRequestedFromRecovery=false;
    console.error('[GENERATION RECOVERY] Reset control unavailable after recovery exhaustion.');
  });
  overlay.querySelector('#itbmo-generation-support')?.addEventListener('click',()=>{
    closeRecovery();
    openSupportModal();
  });
  const button=overlay.querySelector('#itbmo-generation-retry');
  button?.addEventListener('click',()=>{
    button.disabled=true;
    overlay.remove();
    // Immediate UX acknowledgement: generation_begin/checkpoint recovery can take
    // several seconds, so never leave the user looking at an apparently idle UI.
    showWOW(true,integrityFailure
      ? (es?'Verificando los últimos detalles de tu itinerario…':'Verifying the final details of your itinerary…')
      : (es?'Preparando tu itinerario… Estamos recuperando tu viaje y preparando la generación.':'Preparing your itinerary… We are recovering your trip and preparing generation.'));
    requestAnimationFrame(()=>{
      runPaidGeneration({manualRetry:true});
    });
  });
  if(reason) console.warn('[GENERATION RECOVERY]',reason);
}

async function _prewarmGeneratedTripContext_(){
  const token=getStoredSessionToken();
  const tripId=String(currentTripId||'').trim();
  const cityList=(savedDestinations||[]).map(item=>String(item?.city||'').trim()).filter(Boolean);
  if(!token || !tripId || !cityList.length) return;

  const markerKey=`itbmo_context_prewarm_${tripId}`;
  try{
    localStorage.setItem(markerKey,JSON.stringify({status:'running',started_at:new Date().toISOString(),cities:cityList}));
  }catch(_){}

  for(const cityName of cityList){
    try{
      const response=await fetch('/api/context',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          session_token:token,
          trip_id:tripId,
          city:cityName
        })
      });
      let payload={};
      try{payload=await response.json();}catch(_){}
      if(!response.ok || !payload?.ok){
        console.warn('[CONTEXT PREWARM]',cityName,payload?.code||response.status);
      }
    }catch(error){
      console.warn('[CONTEXT PREWARM]',cityName,error);
    }
  }

  try{
    localStorage.setItem(markerKey,JSON.stringify({status:'done',finished_at:new Date().toISOString(),cities:cityList}));
  }catch(_){}
}

function _applyGeneratedUIState({showModal=false}={}){
  if(!showModal) showWOW(false);
  setExportToolbarVisibility(true);
  setPlanningChatLocked(true);
  if($preferencesGenerateV2){
    $preferencesGenerateV2.disabled=true;
    $preferencesGenerateV2.setAttribute('aria-disabled','true');
    $preferencesGenerateV2.textContent=getLang()==='es'?'✓ Itinerario generado':'✓ Itinerary generated';
    $preferencesGenerateV2.classList.add('is-generated');
  }
  if(showModal){
    // Generation is complete: retire the Guided Personalization shell before
    // revealing completion so Continue can never expose the old create screen.
    document.querySelector('#guided-personalization-overlay')?.remove();
    document.body.classList.remove('guided-preferences-open');
    showFinalDownloadModal();
    // Keep the generation overlay in place until the completion modal exists;
    // then reveal the modal atomically with no intermediate Planner state.
    requestAnimationFrame(()=>showWOW(false));
  }
}

// V3 generation orchestrator: Travel Model V2 first compiles one continuous physical
// timeline. Each main destination is then decomposed into chronological Physical Stay
// Units (Madrid A → Segovia → Toledo → Madrid B, etc.). Independent Stay Units can be
// generated concurrently because route boundaries are deterministic. Every Stay that
// passes QA is checkpointed immediately and is never regenerated because another Stay
// fails; retries remain isolated to failed/incomplete Stays. Final chronology and
// USER_FIXED movements are merged by ITBMO, never by the model.
const ITBMO_GENERATION_CONCURRENCY=3;
let _generationCheckpointQueue_=Promise.resolve();
function _queueGenerationCheckpoint_(status='generating',extra={}){
  // Bind every queued write to the generation epoch + trip that created it. This
  // prevents a late checkpoint from an abandoned run from writing into a reset or
  // newly-created trip after the traveler starts over.
  const queuedEpoch=generationRunEpoch;
  const queuedTripId=String(currentTripId||'');
  const task=()=>{
    if(generationResetInProgress || Number(queuedEpoch)!==Number(generationRunEpoch) || String(currentTripId||'')!==queuedTripId){
      throw _generationCancelledError_();
    }
    return _persistGenerationCheckpoint_(status,extra);
  };
  _generationCheckpointQueue_=_generationCheckpointQueue_.then(task,task);
  return _generationCheckpointQueue_;
}
async function _runGenerationPool_(items,worker,limit=ITBMO_GENERATION_CONCURRENCY){
  const queue=[...(items||[])];
  const workers=Array.from({length:Math.max(1,Math.min(Number(limit)||1,queue.length||1))},async()=>{
    while(queue.length){
      const item=queue.shift();
      if(item) await worker(item);
    }
  });
  await Promise.all(workers);
}

async function runPaidGeneration({manualRetry=false}={}){
  if(generationResetInProgress || paidGenerationRunning || !currentTripId || !savedDestinations.length) return;
  const runEpoch=++generationRunEpoch;
  paidGenerationRunning=true;
  let completionPublished=false;
  setPlanningChatLocked(true);
  qs('#itbmo-generation-retry')?.remove();
  _resetAstraGenerationMetrics_();

  try{
    showWOW(true,getLang()==='es'?'✨ ITBMO está resolviendo la logística de tu recorrido…':'✨ ITBMO is resolving your trip logistics…');
    await _resolveTripStoryRoutesBeforeGeneration_();
    _assertGenerationRunActive_(runEpoch);
    const token=getStoredSessionToken();
    const begin=await tripApi({
      action:'generation_begin',
      session_token:token,
      trip_id:currentTripId
    });
    _assertGenerationRunActive_(runEpoch);

    if(begin?.already_completed){
      _hydrateGenerationTrip_(begin.trip);
      _applyGeneratedUIState({showModal:true});
      completionPublished=true;
      return;
    }

    const serverCheckpoint=begin?.trip?.itinerary_data || generationRecoveryState || {};
    generationRecoveryState={
      ...serverCheckpoint,
      completed_cities:Array.isArray(serverCheckpoint.completed_cities) ? serverCheckpoint.completed_cities : [],
      city_attempts:(serverCheckpoint.city_attempts && typeof serverCheckpoint.city_attempts==='object')
        ? serverCheckpoint.city_attempts
        : {},
      generation_count:Number(begin?.trip?.generation_count || generationRecoveryState?.generation_count || 1)
    };

    if(begin?.new_run && manualRetry){
      savedDestinations.forEach(({city})=>{
        if(!_generationCityComplete_(city)) generationRecoveryState.city_attempts[city]=0;
      });
    }

    await _persistGenerationCheckpoint_('generating');

    const pendingDestinations=savedDestinations.filter(({city})=>!_generationCityComplete_(city));
    for(const {city} of savedDestinations){
      if(_generationCityComplete_(city) && !generationRecoveryState.completed_cities.includes(city)){
        generationRecoveryState.completed_cities.push(city);
      }
    }
    if(pendingDestinations.length!==savedDestinations.length){
      await _queueGenerationCheckpoint_('generating');
    }

    await _runGenerationPool_(pendingDestinations,async({city})=>{
      let attempts=Math.max(0,Number(generationRecoveryState.city_attempts[city] || 0));
      let completed=false;

      while(attempts<ITBMO_CITY_GENERATION_MAX_ATTEMPTS && !completed){
        await _waitForGenerationConnection_();
        const delay=ITBMO_CITY_RETRY_DELAYS_MS[Math.min(attempts,ITBMO_CITY_RETRY_DELAYS_MS.length-1)] || 0;
        if(delay) await new Promise(resolve=>setTimeout(resolve,delay));

        attempts+=1;
        generationRecoveryState.city_attempts[city]=attempts;
        generationRecoveryState.last_error=null;
        await _queueGenerationCheckpoint_('generating',{active_city:city});

        showWOW(true,t('overlayGenerating'));
        const success=await generateCityItinerary(city,{silentFailure:true});
        _assertGenerationRunActive_(runEpoch);
        completed=Boolean(success && _generationCityComplete_(city));
        // A route-quality block already went through deterministic cleanup and
        // bounded scoped repairs. Do not regenerate the whole planning unit again.
        // Genuine transient/network failures keep the normal retry policy.
        if(!completed && ITBMO_GENERATION_ENGINE==='v3' && /V3_(?:ROUTE_QUALITY_BLOCK|STAY_RECOVERY_EXHAUSTED)/.test(_v3LastFailureByCity_[city]||'')){
          // The V3 Stay engine already exhausted its own bounded, isolated retries.
          // Do not restart the whole destination/planning unit and reset failed Stays
          // to attempt 1/3 again. Accepted Stay checkpoints remain preserved.
          attempts=ITBMO_CITY_GENERATION_MAX_ATTEMPTS;
        }

        if(completed){
          if(!generationRecoveryState.completed_cities.includes(city)){
            generationRecoveryState.completed_cities.push(city);
          }
          generationRecoveryState.last_error=null;
          await _queueGenerationCheckpoint_('generating',{active_city:null});
        }else{
          generationRecoveryState.last_error={
            city,
            attempt:attempts,
            code:'CITY_GENERATION_FAILED',
            at:new Date().toISOString()
          };
          await _queueGenerationCheckpoint_('generating',{active_city:city});
        }
      }
    },ITBMO_GENERATION_CONCURRENCY);

    const allComplete=savedDestinations.every(({city})=>_generationCityComplete_(city));
    if(!allComplete){
      await _persistGenerationCheckpoint_('failed',{active_city:null});
      showWOW(false);
      const integrityFailure=Object.values(_v3LastFailureByCity_||{}).some(message=>/V3_EXPORT_SHAPE_BLOCK|V3_ROUTE_PHYSICAL_BLOCK_AFTER_MERGE|MISSING_PHYSICAL_WINDOW|V3_STAY_QUALITY_BLOCK/.test(String(message||'')));
      if($preferencesGenerateV2){
        // Do not expose the old Personalization CTA after generation started.
        // Recovery owns the next action and reuses accepted Stay checkpoints.
        $preferencesGenerateV2.disabled=true;
        $preferencesGenerateV2.setAttribute('aria-disabled','true');
        $preferencesGenerateV2.textContent=getLang()==='es'?'Verificando itinerario…':'Verifying itinerary…';
        $preferencesGenerateV2.classList.remove('is-generated');
      }
      _showGenerationRetry_(integrityFailure?'V3_EXPORT_SHAPE_BLOCK':'One or more cities remained incomplete.');
      return;
    }

    await _queueGenerationCheckpoint_('generated',{active_city:null,last_error:null});
    // Publication is the critical transaction boundary. Show downloads first;
    // analytics/context warming must never be able to suppress the completion UI.
    _applyGeneratedUIState({showModal:true});
    completionPublished=true;
    _prewarmGeneratedTripContext_().catch(error=>console.warn('[CONTEXT PREWARM]',error));
    trackITBMOEvent('itinerary_generated',{
      city_count:savedDestinations.length,
      days_total:savedDestinations.reduce((sum,item)=>sum+(Number(item?.days)||0),0),
      generation_mode:manualRetry?'recovery':'standard'
    });
    _finishAstraGenerationMetrics_();
    chatMsg(getPlannerCompletionMessage(),'ai');
  }catch(err){
    if(generationResetInProgress || err?.code==='GENERATION_CANCELLED_BY_RESET' || Number(runEpoch)!==Number(generationRunEpoch)){
      console.info('[PAID GENERATION ORCHESTRATOR] cancelled by itinerary reset');
      return;
    }
    console.error('[PAID GENERATION ORCHESTRATOR]',err);
    if(err?.code==='GENERATION_RECOVERY_EXHAUSTED'){
      generationRecoveryState={...(generationRecoveryState || {}),generation_count:2};
    }
    try{
      if(err?.code!=='GENERATION_PAYMENT_REQUIRED'){
        await _persistGenerationCheckpoint_('failed',{
          active_city:null,
          last_error:{code:err?.code || 'GENERATION_ORCHESTRATOR_FAILED',at:new Date().toISOString()}
        });
      }
    }catch(_){ }
    if($preferencesGenerateV2){
      $preferencesGenerateV2.disabled=false;
      $preferencesGenerateV2.removeAttribute('aria-disabled');
      $preferencesGenerateV2.textContent=getLang()==='es'?'Reintentar generación':'Retry generation';
      $preferencesGenerateV2.classList.remove('is-generated');
    }
    _showGenerationRetry_(err?.code || err?.message || 'Generation failed');
  }finally{
    if(Number(runEpoch)===Number(generationRunEpoch)) paidGenerationRunning=false;
    if(!generationResetInProgress && !completionPublished) showWOW(false);
  }
}


/* =========================================================
   ITBMO · JOURNEY HOME · PHASE 4
   Returning generated trips are presented as choices instead of being
   silently restored. Interrupted paid generations retain legacy recovery.
========================================================= */
let journeyHomeLatestTrip = null;
let journeyHistoryTrips = [];
let journeyHomeBusy = false;

function _journeyEsc_(value){
  return String(value ?? '').replace(/[&<>"']/g,ch=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[ch]));
}
function _journeyDestinations_(trip){
  const mains=(Array.isArray(trip?.destinations)?trip.destinations:[]).map(d=>String(d?.city||'').trim()).filter(Boolean);
  const checkpoint=(trip?.itinerary_data&&typeof trip.itinerary_data==='object')?trip.itinerary_data:{};
  const model=checkpoint?.planner_state?.travelModelV2 || trip?.planner_input?.travel_model_v2 || trip?.planner_input?.travelModelV2 || null;
  const story=model?.trip_story || model?.tripStory || checkpoint?.planner_state?.travelModelV2?.trip_story || null;
  const ordered=[];
  const add=value=>{const city=String(value||'').trim();if(city&&!ordered.some(x=>_arePoiAliases_(x,city)))ordered.push(city);};
  if(Array.isArray(story?.stays)&&story.stays.length){
    story.stays.forEach(stay=>{
      add(stay?.place);
      (Array.isArray(stay?.dayTrips)?stay.dayTrips:[]).slice().sort((a,b)=>Number(a?.day||0)-Number(b?.day||0)).forEach(dt=>add(dt?.place));
    });
    return ordered;
  }
  // Backward-compatible fallback for trips persisted before Trip Story existed.
  (Array.isArray(model?.destinations)?model.destinations:[]).forEach((dest,index)=>{add(dest?.city||mains[index]);(Array.isArray(dest?.route?.segments)?dest.route.segments:[]).forEach(seg=>add(seg?.destination));});
  mains.forEach(add);
  return ordered.length?ordered:mains;
}

function _journeyDateLabel_(trip){
  const ds=Array.isArray(trip?.destinations)?trip.destinations:[];
  const dates=ds.map(d=>d?.base_date||d?.baseDate||'').filter(Boolean);
  const fmt=(raw)=>{
    const value=String(raw||'').trim();
    let date=null;
    if(/^\d{4}-\d{2}-\d{2}$/.test(value)) date=new Date(value+'T12:00:00');
    else if(/^\d{2}\/\d{2}\/\d{4}$/.test(value)){
      const [dd,mm,yyyy]=value.split('/'); date=new Date(`${yyyy}-${mm}-${dd}T12:00:00`);
    }
    if(!date || Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(getLang()==='es'?'es-CR':'en-US',{day:'numeric',month:'short',year:'numeric'}).format(date);
  };
  return dates.length ? fmt(dates[0]) : '';
}
function _journeyTripLabel_(trip){
  const cities=_journeyDestinations_(trip);
  return cities.join(' · ') || (getLang()==='es'?'Viaje ITBMO':'ITBMO trip');
}
function _journeyTripMeta_(trip){
  const cities=_journeyDestinations_(trip);
  const days=(Array.isArray(trip?.destinations)?trip.destinations:[])
    .reduce((sum,d)=>sum+(Number(d?.days)||0),0);
  const date=_journeyDateLabel_(trip);
  const parts=[];
  if(date) parts.push(date);
  if(cities.length) parts.push(`${cities.length} ${getLang()==='es'?(cities.length===1?'ciudad':'ciudades'):(cities.length===1?'city':'cities')}`);
  if(days) parts.push(`${days} ${getLang()==='es'?(days===1?'día':'días'):(days===1?'day':'days')}`);
  return parts.join(' · ');
}
function _journeyCopy_(){
  const es=getLang()==='es';
  return es ? {
    eyebrow:'TU VIAJE SIGUE AQUÍ',
    title:'¿Qué quieres hacer hoy?',
    copy:'Continúa donde lo dejaste o empieza una nueva aventura. Tus viajes anteriores permanecen disponibles para que vuelvas a ellos cuando los necesites.',
    resumeKicker:'ÚLTIMO VIAJE',
    resumeTitle:'Continuar con mi último viaje',
    resumeAction:'Abrir Trip Workspace',
    newKicker:'NUEVA AVENTURA',
    newTitle:'Planificar un nuevo viaje',
    newCopy:'Empieza desde cero sin borrar los viajes que ya creaste.',
    newAction:'Crear nuevo itinerario',
    historyEyebrow:'TU HISTORIAL',
    historyTitle:'Mis viajes',
    tripCount:n=>`${n} ${n===1?'viaje guardado':'viajes guardados'}`,
    open:'Abrir viaje',
    myTrips:'Mis viajes',
    myTripsHint:'Tu espacio de viaje'
  } : {
    eyebrow:'YOUR TRIP IS STILL HERE',
    title:'What would you like to do today?',
    copy:'Continue where you left off or start a new adventure. Your previous trips stay available whenever you need them.',
    resumeKicker:'LATEST TRIP',
    resumeTitle:'Continue my latest trip',
    resumeAction:'Open Trip Workspace',
    newKicker:'NEW ADVENTURE',
    newTitle:'Plan a new trip',
    newCopy:'Start from scratch without deleting the trips you already created.',
    newAction:'Create new itinerary',
    historyEyebrow:'YOUR HISTORY',
    historyTitle:'My trips',
    tripCount:n=>`${n} saved ${n===1?'trip':'trips'}`,
    open:'Open trip',
    myTrips:'My trips',
    myTripsHint:'Your trip space'
  };
}
function _journeyApplyCopy_(){
  const c=_journeyCopy_();
  const set=(id,value)=>{const el=qs('#'+id);if(el)el.textContent=value;};
  set('journey-home-eyebrow',c.eyebrow);set('journey-home-title',c.title);set('journey-home-copy',c.copy);
  set('journey-home-resume-kicker',c.resumeKicker);set('journey-home-resume-title',c.resumeTitle);
  set('journey-home-new-kicker',c.newKicker);set('journey-home-new-title',c.newTitle);set('journey-home-new-copy',c.newCopy);
  set('journey-history-eyebrow',c.historyEyebrow);set('journey-history-title',c.historyTitle);set('planner-my-trips-label',c.myTrips);set('planner-my-trips-hint',c.myTripsHint);
  const resumeAction=qs('#journey-home-resume-action');if(resumeAction)resumeAction.innerHTML=`${_journeyEsc_(c.resumeAction)} <i aria-hidden="true">→</i>`;
  const newAction=qs('#journey-home-new-action');if(newAction)newAction.innerHTML=`${_journeyEsc_(c.newAction)} <i aria-hidden="true">→</i>`;
}
async function _journeyLoadHistory_(){
  const token=getStoredSessionToken();
  if(!token) return [];
  try{
    const data=await tripApi({action:'list',session_token:token,limit:12});
    journeyHistoryTrips=Array.isArray(data?.trips)?data.trips.filter(t=>t?.status==='generated'):[];
  }catch(err){
    console.warn('[JOURNEY HISTORY]',err);
    journeyHistoryTrips=journeyHomeLatestTrip?[journeyHomeLatestTrip]:[];
  }
  return journeyHistoryTrips;
}
function _journeyRenderHistory_(){
  const c=_journeyCopy_(),section=qs('#journey-history'),grid=qs('#journey-history-grid'),count=qs('#journey-history-count');
  if(!section||!grid)return;
  const trips=journeyHistoryTrips.filter(t=>t?.id);
  section.hidden=trips.length===0;
  if(count)count.textContent=c.tripCount(trips.length);
  grid.innerHTML='';
  trips.slice(0,9).forEach((trip,index)=>{
    const card=document.createElement('button');
    card.type='button';card.className='journey-trip-card';card.dataset.tripId=trip.id;
    card.innerHTML=`<span class="journey-trip-card__number">${String(index+1).padStart(2,'0')}</span><strong>${_journeyEsc_(_journeyTripLabel_(trip))}</strong><small>${_journeyEsc_(_journeyTripMeta_(trip))}</small><span class="journey-trip-card__open">${_journeyEsc_(c.open)} →</span>`;
    card.addEventListener('click',()=>_journeyOpenTrip_(trip.id));
    grid.appendChild(card);
  });
}
async function showJourneyReturnGate(trip){
  if(!trip?.id)return;
  journeyHomeLatestTrip=trip;
  _journeyApplyCopy_();
  const gate=qs('#journey-home');
  if(!gate)return;
  const meta=qs('#journey-home-resume-meta');if(meta)meta.textContent=`${_journeyTripLabel_(trip)}${_journeyTripMeta_(trip)?' · '+_journeyTripMeta_(trip):''}`;
  gate.hidden=false;gate.setAttribute('aria-hidden','false');document.body.classList.add('journey-home-open');
  const myTrips=qs('#planner-my-trips');if(myTrips)myTrips.hidden=false;
  await _journeyLoadHistory_();_journeyRenderHistory_();
}
function hideJourneyReturnGate(){
  const gate=qs('#journey-home');if(gate){gate.hidden=true;gate.setAttribute('aria-hidden','true');}
  document.body.classList.remove('journey-home-open');
}
async function _journeyOpenTrip_(tripId){
  if(journeyHomeBusy||!tripId)return;
  journeyHomeBusy=true;
  try{
    const token=getStoredSessionToken();
    const data=await tripApi({action:'get',session_token:token,trip_id:tripId});
    const trip=data?.trip;
    if(!trip||!_hydrateGenerationTrip_(trip))throw new Error('TRIP_NOT_AVAILABLE');
    let paymentStatus=null;
    try{paymentStatus=await paymentApi({action:'status',session_token:token,trip_id:currentTripId});applyInfoChatStatus(paymentStatus);}catch(_){}
    setExportToolbarVisibility(true);setPlanningChatLocked(true);hideJourneyReturnGate();
    openImmersiveItinerary();
  }catch(err){console.warn('[JOURNEY OPEN]',err);}
  finally{journeyHomeBusy=false;}
}
function _journeyStartNew_(){
  /* This is intentionally NOT Reset: no trip is archived or deleted.
     We only detach the old active-trip pointer and reload a clean Planner. */
  storeActiveTripId(null);
  try{localStorage.removeItem('itbmo_trip_workspace_snapshot_v1');}catch(_){}
  const url=new URL(window.location.href);
  url.searchParams.set('mode','new');
  window.location.href=url.toString();
}
function bindJourneyHome(){
  qs('#journey-home-resume')?.addEventListener('click',()=>_journeyOpenTrip_(journeyHomeLatestTrip?.id));
  qs('#journey-home-new')?.addEventListener('click',_journeyStartNew_);
  qs('#planner-my-trips')?.addEventListener('click',async()=>{
    const button=qs('#planner-my-trips');
    if(button?.dataset.busy==='1') return;
    if(button) button.dataset.busy='1';

    try{
      let trip=journeyHomeLatestTrip;

      if(!trip){
        const trips=await _journeyLoadHistory_();
        trip=trips[0] || null;
        if(trip) journeyHomeLatestTrip=trip;
      }

      if(!trip) return;

      await showJourneyReturnGate(trip);

      /* The global topbar action is specifically "My trips", so take the
         traveler to the history section instead of only revealing the gate. */
      requestAnimationFrame(()=>{
        const history=qs('#journey-history');
        const gate=qs('#journey-home');
        const target=(history && !history.hidden) ? history : gate;
        if(!target) return;

        const rect=target.getBoundingClientRect();
        const current=window.scrollY || document.documentElement.scrollTop || 0;
        const desired=Math.max(0,current + rect.top - 112);
        window.scrollTo({top:desired,behavior:'smooth'});
      });
    }finally{
      if(button) delete button.dataset.busy;
    }
  });
}

async function restorePaidGenerationIfNeeded(){
  if(generationResetInProgress || paidGenerationRunning || !currentUser || !getStoredSessionToken()) return;
  try{
    const token=getStoredSessionToken();
    const requestedTripId=String(new URLSearchParams(window.location.search).get('trip_id') || '').trim();
    let tripId=requestedTripId || getStoredActiveTripId();
    let trip=null;

    if(requestedTripId) storeActiveTripId(requestedTripId);

    if(tripId){
      try{
        const data=await tripApi({action:'get',session_token:token,trip_id:tripId});
        trip=data?.trip || null;
      }catch(err){
        if(err?.status===404) storeActiveTripId(null);
        else throw err;
      }
    }

    if(!trip){
      const data=await tripApi({action:'recoverable',session_token:token});
      trip=data?.trip || null;
    }
    if(generationResetInProgress) return;
    if(!trip || !['saved','generating','failed','generated'].includes(trip.status)) return;

    const plannerMode=new URLSearchParams(window.location.search).get('mode');
    if(trip.status==='generated'){
      if(plannerMode==='new'){
        storeActiveTripId(null);
        const myTrips=qs('#planner-my-trips'); if(myTrips) myTrips.hidden=false;
        _journeyLoadHistory_().then(()=>_journeyRenderHistory_()).catch(()=>{});
        return;
      }
      await showJourneyReturnGate(trip);
      return;
    }

    if(!_hydrateGenerationTrip_(trip)) return;

    let paymentStatus=null;
    try{
      paymentStatus=await paymentApi({action:'status',session_token:token,trip_id:currentTripId});
      applyInfoChatStatus(paymentStatus);
    }catch(_){ }

    if(!paymentStatus?.paid && !paymentStatus?.admin_bypass && !paymentStatus?.info_chat_authorized){
      paymentGateSatisfiedTripId=null;
      setPostPaymentTripConfigurationLocked(false);
      return;
    }

    // Positive server entitlement is the only restore-time authority for the lock.
    paymentGateSatisfiedTripId=currentTripId;
    setPostPaymentTripConfigurationLocked(true);

    if(trip.status==='saved'){
      if(!_restorePostPaymentProgress_(trip)) showPreferencesStage();
    }else if(trip.status==='generating'){
      chatMsg(getLang()==='es'
        ? 'ITBMO detectó una generación interrumpida y continuará desde la última ciudad guardada.'
        : 'ITBMO detected an interrupted generation and will continue from the last saved city.','ai');
      setTimeout(()=>runPaidGeneration(),180);
    }else if(trip.status==='failed'){
      _showGenerationRetry_();
    }else{
      _applyGeneratedUIState({showModal:false});
    }
  }catch(err){
    console.warn('[GENERATION RESTORE]',err);
  }
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
  _setHotelTransportComposerTemplate_();
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
- Si el usuario no indicó hora final, no existe una hora fija objetivo. Determina el final natural según destino, temporada, horarios reales, logística, comidas/descanso, ritmo y valor turístico. No cierres el día de forma claramente prematura si aún quedan experiencias valiosas y viables, pero tampoco agregues relleno ni sobrecargues el itinerario solo para extender el horario.
- En el Día 1, la hora indicada significa que el viajero ya está en el alojamiento; completa el check-in o depósito de equipaje antes de cualquier visita y no inventes el traslado de llegada.
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
  if(!itbmoPlanningChatStarted){
    itbmoPlanningChatStarted=true;
    trackITBMOEvent('start_chat');
  }
  chatMsg(text,'user');
  $chatI.value='';
  _autoGrowPlanningChatInput_();

  const structuredHotelTransport = collectingHotels
    ? _parseStructuredHotelTransport_(text)
    : null;

  if(!agentConversationLang){
    const languageSource = structuredHotelTransport?.structured
      ? `${structuredHotelTransport.hotel}
${structuredHotelTransport.transport==='recomiéndame' ? '' : structuredHotelTransport.transport}`.trim()
      : text;
    agentConversationLang=detectAgentConversationLanguage(languageSource || text);
  }

  // Colecta hotel/transporte
  if(collectingHotels){
    const city = savedDestinations[metaProgressIndex].city;
    const structured = structuredHotelTransport || _parseStructuredHotelTransport_(text);
    const transport = structured.structured
      ? structured.transport
      : detectTransportFromUserText(text);
    const lodgingText = structured.structured
      ? structured.hotel
      : stripRecognizedTransportTail(text);
    upsertCityMeta({ city, hotel: lodgingText, transport });
    metaProgressIndex++;
    askNextHotelTransport();
    await _persistPostPaymentProgress_(collectingHotels ? 'collecting_hotels' : 'collecting_language');
    return;
  }

  if (typeof plannerState !== 'undefined' && plannerState && plannerState.collectingItineraryLang) {
    plannerState.collectingItineraryLang = false;
    plannerState.itineraryLang = String(text || '').trim();

    await _persistPostPaymentProgress_('generation_requested');
    runPaidGeneration();

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
    saveDestinations({showReadyModal:false});
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
  // Travel Model V2: order is derived from dates, never from entry order.
  reorderDestinationRowsByDate({animate:false});
  // Valida el calendario visual sin alterar el DD/MM/AAAA que consume el contrato existente.
  const rows = qsa('.city-row', $cityList);
  let firstInvalid = null;
  let message=t('tooltipDateMissing');
  let previousEnd=null;
  const today=parsePlannerDate(plannerDateMin());
  const maximum=parsePlannerDate(plannerDateMax());
  for(const r of rows){
    const hidden = qs('.baseDate', r);
    const picker = qs('.baseDatePicker', r);
    const date=parsePlannerDate(hidden?.value || '');
    const days=Math.max(1,Number(qs('.days',r)?.value || 1));
    if(!date || date<today || date>maximum){
      firstInvalid = picker || hidden;
      // microanimación
      firstInvalid?.classList.add('shake-highlight');
      setTimeout(()=>firstInvalid?.classList.remove('shake-highlight'), 800);
      break;
    }
    if(previousEnd && date<previousEnd){
      firstInvalid=picker || hidden;
      message=getLang()==='es'
        ? 'Esta ciudad se superpone realmente con la anterior. El mismo día sí está permitido cuando el traslado ocurre durante esa fecha; revisa las fechas o agrega el traslado correspondiente.'
        : 'This city truly overlaps the previous one. Sharing the same day is allowed when the transfer happens during that date; review the dates or add the corresponding transfer.';
      firstInvalid?.classList.add('shake-highlight');
      setTimeout(()=>firstInvalid?.classList.remove('shake-highlight'),800);
      break;
    }
    previousEnd=addDays(date,days-1);
  }
  if(firstInvalid){
    const tooltip = document.createElement('div');
    tooltip.className = 'date-tooltip';
    tooltip.textContent = message;
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
  requestAnimationFrame(()=>{
    try{ qs('.traveler-profile-actions')?.scrollIntoView({behavior:'smooth',block:'nearest'}); }catch(_){}
  });
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
      if(v) scheduleAstraCoach('destinations','#destinations-box',420);
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

function _v39VisibleDuration_(row={}){
  const raw=String(row?.duration||'').trim();
  if(!raw)return '';
  const activity=_durationBoundsMinutes_(_extractDurationPart_(raw,'activity'));
  const movement=_transportBoundsFromField_(row?.transport||'');
  const from=String(row?.from||'').trim(),to=String(row?.to||'').trim();
  // Presentation/export only. Never mutate the canonical V34 itinerary row.
  if(activity && activity.max<=1 && movement)return '';
  return _sanitizeDurationLines_(raw,row?.transport||'');
}

function _v3VisibleTransportLabel_(value){
  const raw=String(value||'').trim();
  if(!raw)return '';
  if(/^recomi[eé]ndame$/i.test(raw)||/^recommend$/i.test(raw)||/^recommend me$/i.test(raw)) return getLang()==='es'?'Por definir · ITBMO te ayudará a elegir':'To be decided · ITBMO will help you choose';
  return raw.replace(/\/(recomendado|recommended)/ig,'').replace(/\s{2,}/g,' ').trim();
}

function _v40VisibleTransportForRow_(row={}){
  const raw=_v3VisibleTransportLabel_(row?.transport||'');
  if(!/^por definir\b|^to be decided\b/i.test(raw)) return raw;
  const text=`${row?.notes||''} ${row?.activity||''}`;
  if(/\bRER\b/i.test(text)) return raw.replace(/^Por definir|^To be decided/i,'RER');
  if(/\b(tren|train|rail|ferrocarril)\b/i.test(text)) return raw.replace(/^Por definir|^To be decided/i,getLang()==='es'?'Tren':'Train');
  if(/\b(autob[uú]s|autocar|bus|coach)\b/i.test(text)) return raw.replace(/^Por definir|^To be decided/i,getLang()==='es'?'Bus':'Bus');
  return raw;
}

function _chronologicalExportDays_(){
  const out=[];
  const story=_currentTravelModelV2_()?.trip_story;
  (savedDestinations||[]).forEach(dest=>{
    const sourceUnit=dest?.city||'';
    const byDay=itineraries?.[sourceUnit]?.byDay||{};
    const route=_routeV2ContextForCity_(sourceUnit)||{};
    const contexts=new Map((route.day_contexts||[]).map(ctx=>[Number(ctx.day),ctx]));
    Object.keys(byDay).map(Number).filter(Number.isFinite).sort((a,b)=>a-b).forEach(dayNum=>{
      const date=getDayDateLabel(sourceUnit,dayNum);
      const iso=date?(()=>{const d=parseDMY(date);return d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:'';})():'';
      const stay=(story?.stays||[]).find(st=>{
        if(!st?.startDate||!iso)return false;
        const end=_tripStoryAddDays_(st.startDate,Math.max(0,Number(st.days||1)-1));
        return iso>=st.startDate&&iso<=end;
      });
      out.push({sourceUnit,dayNum,date,stayBase:stay?.place||sourceUnit,rows:[...(byDay[dayNum]||[])].sort((a,b)=>String(a.start||'').localeCompare(String(b.start||''))),context:contexts.get(dayNum)||{}});
    });
  });
  return out.sort((a,b)=>{const da=parseDMY(a.date||''),db=parseDMY(b.date||'');return (da?.getTime?.()||0)-(db?.getTime?.()||0)||a.dayNum-b.dayNum;});
}

function _exportPhysicalDestinationBlocks_(){
  const blocks=[];
  const same=(a,b)=>_arePoiAliases_(String(a||''),String(b||''));
  const push=(place,day,row,date,sourceUnit)=>{
    const name=String(place||'').trim();
    if(!name)return;
    let block=blocks.at(-1);
    // Keep repeated visits as separate UX destinations whenever the traveler
    // physically leaves and later returns (Madrid -> Segovia -> Madrid).
    if(!block || !same(block.destination,name)){
      block={destination:name,sequence:blocks.length+1,days:[],source_units:new Set()};
      blocks.push(block);
    }
    let daySlice=block.days.at(-1);
    if(!daySlice || daySlice.globalDay!==day.dayNum || daySlice.date!==date){
      daySlice={globalDay:day.dayNum,date:date||'',rows:[]};
      block.days.push(daySlice);
    }
    daySlice.rows.push(row);
    if(sourceUnit)block.source_units.add(sourceUnit);
  };
  _chronologicalExportDays_().forEach(day=>{
    const ctx=day.context||{};
    const transfers=(ctx.fixed_transfers||[]).filter(t=>t?.origin&&t?.destination).slice().sort((a,b)=>String(a.departure||'99:99').localeCompare(String(b.departure||'99:99')));
    (day.rows||[]).forEach(row=>{
      const resolved=_authoritativePhysicalLocationForRow_(row,ctx,day.stayBase||day.sourceUnit);
      const normalizedRow={...row,physical_location:resolved.place,commerce_context:{...(row?.commerce_context||{}),physical_destination:resolved.place}};
      push(resolved.place,day,normalizedRow,day.date,day.sourceUnit);
    });
  });
  return blocks.map(b=>({...b,source_units:[...b.source_units]}));
}

function exportItineraryToCSV(){
  const blocks=_exportPhysicalDestinationBlocks_();
  if(!blocks.length){alert(getLang()==='es'?'No hay itinerarios generados todavía para exportar.':'There are no generated itineraries to export yet.');return;}
  const delim=detectCsvDelimiter(),lines=[],outLang=_plannerOutputLang_();
  const labels={
    es:{headers:['Etapa','Destino físico','Día','Fecha','Hora inicio','Hora final','Actividad','Desde','Hacia','Transporte','Duración','Notas']},
    en:{headers:['Stage','Physical destination','Day','Date','Start time','End time','Activity','From','To','Transport','Duration','Notes']}
  };
  const l=labels[outLang]||labels.en,push=row=>lines.push(row.map(x=>csvEscape(normalizeCellText(x),delim)).join(delim));
  push(l.headers);
  blocks.forEach((block,index)=>block.days.forEach(d=>d.rows.forEach(r=>push([
    String(index+1).padStart(2,'0'),block.destination,d.globalDay,d.date||'',r.start,r.end,r.activity,r.from,r.to,_v40VisibleTransportForRow_(r),_v39VisibleDuration_(r),r.notes
  ]))));
  const csv='\uFEFF'+lines.join('\r\n'),blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),d=new Date(),yyyy=d.getFullYear(),mm=String(d.getMonth()+1).padStart(2,'0'),dd=String(d.getDate()).padStart(2,'0');
  trackITBMOEvent('export_csv',{file_type:'csv',layout:'continuous_physical_timeline_v6',destinations:blocks.length});
  return deliverGeneratedFile(blob,`ITBMO-Itinerary-${yyyy}-${mm}-${dd}.csv`);
}

function _exportBlockType_(row={},outLang='es'){
  const activity=_normalizeSearch_(row.activity||''),text=_normalizeSearch_(`${row.activity||''} ${row.notes||''}`);
  const es=outLang==='es';
  if(/^(traslado|transfer|vuelo|flight|tren |train |ferry|barco|bus interurbano|viaje |travel )/.test(activity))return es?'Traslado':'Transfer';
  if(/desayuno|almuerzo|comida|cena|tapas|tapeo|restaurant|restaurante|caf[eé]|bistr[oó]|brasserie/.test(text))return es?'Comida':'Meal';
  if(/check-in|check in|acomodaci[oó]n|equipaje|preparaci[oó]n|embarque|estaci[oó]n|aeropuerto/.test(text))return es?'Logística':'Logistics';
  if(/opcional|optional|tiempo libre|free time/.test(text))return es?'Opcional':'Optional';
  return es?'Actividad':'Activity';
}

function _exportScheduleStatus_(row={},date='',outLang='es'){
  const es=outLang==='es',type=_exportBlockType_(row,outLang);
  if(type!==(es?'Traslado':'Transfer'))return es?'Planificado':'Planned';
  const story=_currentTravelModelV2_()?.trip_story||{};
  const statusLabel=value=>String(value||'').toLowerCase()==='confirmed'?(es?'Confirmado':'Confirmed'):(es?'Estimado':'Estimated');
  for(let i=1;i<(story.stays||[]).length;i++){
    const st=story.stays[i],depDate=_tripStoryDMY_(st.departureDate||st.startDate),arrDate=_tripStoryDMY_(st.arrivalDate||st.startDate);
    if((date===depDate||date===arrDate)&&row.start===st.departureTime&&row.end===st.arrivalTime)return statusLabel(st.timeStatus);
  }
  for(const st of (story.stays||[]))for(const dt of (st.dayTrips||[])){
    const dayDate=_tripStoryDMY_(_tripStoryAddDays_(st.startDate,Number(dt.day||1)-1));
    if(date!==dayDate)continue;
    if(row.start===dt.outbound?.departureTime&&row.end===dt.outbound?.arrivalTime)return statusLabel(dt.outbound?.timeStatus);
    if(row.start===dt.return?.departureTime&&row.end===dt.return?.arrivalTime)return statusLabel(dt.return?.timeStatus);
  }
  return es?'Estimado':'Estimated';
}

function _excelColorForType_(type='',outLang='es'){
  const t=_normalizeSearch_(type);
  if(/traslado|transfer/.test(t))return 'DDF7FA';
  if(/comida|meal/.test(t))return 'FFF1E8';
  if(/logistica|logistics/.test(t))return 'EEF2FF';
  if(/opcional|optional/.test(t))return 'F5F5FA';
  return 'F4F8FF';
}

async function exportItineraryToXLSX(options={}){
  const blocks=_exportPhysicalDestinationBlocks_();
  const es=_plannerOutputLang_()==='es';
  if(!blocks.length){alert(es?'No hay itinerarios generados todavía para exportar.':'There are no generated itineraries to export yet.');throw new Error('NO_ITINERARY_FOR_XLSX');}
  if(!window.ExcelJS?.Workbook){
    alert(es?'No se pudo cargar el generador de Excel. Revisa tu conexión e inténtalo nuevamente.':'The Excel generator could not be loaded. Check your connection and try again.');
    throw new Error('EXCELJS_UNAVAILABLE');
  }

  const outLang=es?'es':'en',workbook=new window.ExcelJS.Workbook();
  workbook.creator='I Travel By My Own';
  workbook.company='ITBMO';
  workbook.subject=es?'Itinerario de viaje editable':'Editable travel itinerary';
  workbook.title=es?'Mi itinerario ITBMO':'My ITBMO itinerary';
  workbook.created=new Date();

  const allSlices=blocks.flatMap(block=>block.days.flatMap(day=>day.rows.map(row=>({block,day,row}))));
  const uniqueDates=[...new Set(allSlices.map(x=>x.day.date).filter(Boolean))];
  const route=blocks.map(x=>x.destination).filter((x,i,a)=>i===0||x!==a[i-1]).join('  →  ');
  const firstDate=uniqueDates[0]||'',lastDate=uniqueDates.at(-1)||'';
  const navy='092C4C',blue='0877F9',teal='0AA6B7',coral='F17C4A',pale='EDF7FF',white='FFFFFF',muted='5F7488',line='C9DCEB';

  const summary=workbook.addWorksheet(es?'Resumen':'Summary',{views:[{showGridLines:false}]});
  summary.columns=[{width:4},{width:18},{width:18},{width:18},{width:18},{width:18},{width:18},{width:4}];
  summary.mergeCells('B2:G3');
  summary.getCell('B2').value=es?'I TRAVEL BY MY OWN  |  MI ITINERARIO':'I TRAVEL BY MY OWN  |  MY ITINERARY';
  summary.getCell('B2').font={name:'Aptos Display',size:22,bold:true,color:{argb:white}};
  summary.getCell('B2').alignment={vertical:'middle',horizontal:'left'};
  summary.getCell('B2').fill={type:'gradient',gradient:'angle',degree:0,stops:[{position:0,color:{argb:blue}},{position:1,color:{argb:teal}}]};
  summary.mergeCells('B5:G6');
  summary.getCell('B5').value=route;
  summary.getCell('B5').font={name:'Aptos Display',size:18,bold:true,color:{argb:navy}};
  summary.getCell('B5').alignment={vertical:'middle',horizontal:'center',wrapText:true};
  summary.getCell('B5').fill={type:'pattern',pattern:'solid',fgColor:{argb:pale}};
  summary.getCell('B5').border={bottom:{style:'medium',color:{argb:teal}}};
  const cards=[
    ['B8','C10',es?'FECHAS':'DATES',firstDate&&lastDate?`${firstDate} – ${lastDate}`:'—'],
    ['D8','E10',es?'DÍAS DEL VIAJE':'TRIP DAYS',uniqueDates.length],
    ['F8','G10',es?'DESTINOS FÍSICOS':'PHYSICAL DESTINATIONS',blocks.length]
  ];
  cards.forEach(([from,to,label,value],idx)=>{summary.mergeCells(`${from}:${to}`);const c=summary.getCell(from);c.value={richText:[{text:`${label}\n`,font:{size:9,bold:true,color:{argb:idx===2?coral:teal}}},{text:String(value),font:{size:16,bold:true,color:{argb:navy}}}]};c.alignment={vertical:'middle',horizontal:'center',wrapText:true};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:idx===2?'FFF4EE':'F5FAFF'}};c.border={top:{style:'thin',color:{argb:line}},left:{style:'thin',color:{argb:line}},bottom:{style:'thin',color:{argb:line}},right:{style:'thin',color:{argb:line}}};});
  summary.mergeCells('B12:G12');summary.getCell('B12').value=es?'CÓMO USAR ESTE ARCHIVO':'HOW TO USE THIS FILE';
  summary.getCell('B12').font={bold:true,size:12,color:{argb:navy}};
  summary.mergeCells('B13:G16');summary.getCell('B13').value=es?'Edita las horas directamente en la hoja Itinerario. Los campos en amarillo son los más importantes para ajustar. Mantén como Confirmado el horario de una reserva y usa Estimado cuando todavía no tengas el dato definitivo. Revisa siempre los tiempos de preparación, acceso y embarque antes de viajar.':'Edit times directly in the Itinerary sheet. Yellow fields are the most important to adjust. Keep a booked time as Confirmed and use Estimated until you have the final information. Always review preparation, access and boarding time before travelling.';
  summary.getCell('B13').alignment={vertical:'top',wrapText:true};summary.getCell('B13').font={size:11,color:{argb:muted}};
  summary.mergeCells('B18:G18');summary.getCell('B18').value=es?'Leyenda:  Actividad     Traslado     Comida     Logística     Opcional':'Legend:  Activity     Transfer     Meal     Logistics     Optional';
  summary.getCell('B18').font={bold:true,color:{argb:navy}};summary.getCell('B18').alignment={horizontal:'center'};
  summary.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:1,paperSize:9,margins:{left:.25,right:.25,top:.35,bottom:.35,header:.1,footer:.1}};

  const sheet=workbook.addWorksheet(es?'Itinerario':'Itinerary',{views:[{state:'frozen',xSplit:4,ySplit:7,showGridLines:false}]});
  sheet.mergeCells('A1:O2');
  sheet.getCell('A1').value=es?'MI ITINERARIO ITBMO':'MY ITBMO ITINERARY';
  sheet.getCell('A1').font={name:'Aptos Display',size:22,bold:true,color:{argb:white}};
  sheet.getCell('A1').alignment={vertical:'middle',horizontal:'left'};
  sheet.getCell('A1').fill={type:'gradient',gradient:'angle',degree:0,stops:[{position:0,color:{argb:blue}},{position:1,color:{argb:teal}}]};
  sheet.mergeCells('A3:O3');sheet.getCell('A3').value=route;sheet.getCell('A3').font={size:12,bold:true,color:{argb:navy}};sheet.getCell('A3').alignment={horizontal:'center'};
  sheet.mergeCells('A4:O4');sheet.getCell('A4').value=es?`Fechas: ${firstDate||'—'} – ${lastDate||'—'}   |   ${uniqueDates.length} días   |   Horas y estados editables`:`Dates: ${firstDate||'—'} – ${lastDate||'—'}   |   ${uniqueDates.length} days   |   Editable times and statuses`;
  sheet.getCell('A4').font={size:10,color:{argb:muted}};sheet.getCell('A4').alignment={horizontal:'center'};
  sheet.mergeCells('A5:O5');sheet.getCell('A5').value=es?'⚠ Los horarios estimados deben confirmarse cuando tengas la reserva. Los cambios en este archivo no reoptimizan automáticamente el itinerario.':'⚠ Estimated times should be confirmed once booked. Changes in this file do not automatically re-optimise the itinerary.';
  sheet.getCell('A5').font={size:10,bold:true,color:{argb:'8A5A00'}};sheet.getCell('A5').fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF6DA'}};sheet.getCell('A5').alignment={horizontal:'center'};
  const headers=es?['Etapa','Día','Fecha','Destino','Hora inicio','Hora final','Actividad','Transporte','Estado horario','Notas','Tipo','Duración bloque','Desde','Hacia','Detalle de duración']:['Stage','Day','Date','Destination','Start time','End time','Activity','Transport','Time status','Notes','Type','Block duration','From','To','Duration detail'];
  const headerRow=sheet.getRow(7);headerRow.values=headers;headerRow.height=34;
  headerRow.eachCell(cell=>{cell.font={bold:true,color:{argb:white},size:10};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:navy}};cell.alignment={vertical:'middle',horizontal:'center',wrapText:true};cell.border={bottom:{style:'medium',color:{argb:teal}}};});
  const widths=[9,8,13,20,12,12,42,24,17,58,14,16,24,24,22];widths.forEach((width,i)=>sheet.getColumn(i+1).width=width);

  let excelRow=8,lastDayKey='';
  blocks.forEach((block,index)=>block.days.forEach(day=>day.rows.forEach(r=>{
    const type=_exportBlockType_(r,outLang),status=_exportScheduleStatus_(r,day.date,outLang),dayKey=`${day.globalDay}|${day.date}`;
    const dateValue=day.date?parseDMY(day.date):null;
    const values=[String(index+1).padStart(2,'0'),day.globalDay,dateValue||day.date||'',block.destination,r.start||'',r.end||'',normalizeCellText(r.activity),normalizeCellText(_v40VisibleTransportForRow_(r)),status,normalizeCellText(r.notes),type,null,normalizeCellText(r.from),normalizeCellText(r.to),normalizeCellText(_v39VisibleDuration_(r))];
    const row=sheet.addRow(values);row.height=48;
    row.getCell(12).value={formula:`IF(OR(E${excelRow}="",F${excelRow}=""),"",MOD(TIMEVALUE(F${excelRow})-TIMEVALUE(E${excelRow}),1))`};
    row.getCell(12).numFmt='[h]" h "mm" min"';
    if(dateValue)row.getCell(3).numFmt='dd/mm/yyyy';
    row.eachCell((cell,col)=>{cell.font={size:10,color:{argb:navy}};cell.alignment={vertical:'top',wrapText:col>=7};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:_excelColorForType_(type,outLang)}};cell.border={bottom:{style:'hair',color:{argb:line}}};});
    [5,6,9].forEach(col=>{row.getCell(col).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF6DA'}};row.getCell(col).font={bold:true,color:{argb:navy}};row.getCell(col).alignment={vertical:'middle',horizontal:'center',wrapText:true};});
    row.getCell(9).dataValidation={type:'list',allowBlank:false,formulae:[es?'"Confirmado,Estimado,Planificado"':'"Confirmed,Estimated,Planned"'],showErrorMessage:true,errorTitle:es?'Selecciona un estado':'Select a status',error:es?'Usa Confirmado, Estimado o Planificado.':'Use Confirmed, Estimated or Planned.'};
    if(dayKey!==lastDayKey){for(let col=1;col<=15;col++)row.getCell(col).border={top:{style:'medium',color:{argb:teal}},bottom:{style:'hair',color:{argb:line}}};lastDayKey=dayKey;}
    excelRow++;
  })));
  sheet.autoFilter={from:{row:7,column:1},to:{row:Math.max(7,excelRow-1),column:15}};
  sheet.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,paperSize:9,printTitlesRow:'1:7',margins:{left:.2,right:.2,top:.35,bottom:.35,header:.1,footer:.2}};
  sheet.headerFooter.oddFooter=es?'&LITBMO&C&P de &N&RItinerario editable':'&LITBMO&CPage &P of &N&REditable itinerary';
  sheet.properties.defaultRowHeight=20;

  const buffer=await workbook.xlsx.writeBuffer();
  const blob=new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const d=new Date(),yyyy=d.getFullYear(),mm=String(d.getMonth()+1).padStart(2,'0'),dd=String(d.getDate()).padStart(2,'0');
  trackITBMOEvent('export_csv',{file_type:'xlsx',layout:'premium_editable_workbook_v2',destinations:blocks.length,days:uniqueDates.length});
  const filename=`ITBMO-Itinerary-${yyyy}-${mm}-${dd}.xlsx`;
  if(options.download!==false) await deliverGeneratedFile(blob,filename);
  return {blob,filename,kind:'itinerary_xlsx'};
}

async function _itbmoPdfLogoDataUrl_(){
  if(window.ITBMO_PDF_LOGO_DATAURL)return window.ITBMO_PDF_LOGO_DATAURL;
  try{const r=await fetch('./assets/img/itbmo-logo-premium.jpg',{cache:'force-cache'});if(!r.ok)throw new Error('logo');const b=await r.blob();return await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=reject;fr.readAsDataURL(b);});}catch(_){return null;}
}
function _itbmoPdfBlockStyle_(row={}){const t=_normalizeSearch_(_exportBlockType_(row,_plannerOutputLang_()));if(/traslado|transfer/.test(t))return {fill:[232,248,250],accent:[32,181,194]};if(/comida|meal/.test(t))return {fill:[255,244,237],accent:[241,124,74]};if(/logistica|logistics/.test(t))return {fill:[241,244,255],accent:[109,120,238]};return {fill:[246,250,255],accent:[8,123,250]};}

async function exportItineraryToPDF(options={}){
  if(!window.jspdf?.jsPDF){alert('jsPDF no está disponible. Verifica que los scripts (jsPDF + AutoTable) estén cargando en Webflow.');return;}
  const physicalBlocks=_exportPhysicalDestinationBlocks_();
  if(!physicalBlocks.length){alert(getLang()==='es'?'No hay itinerarios generados todavía para exportar.':'There are no generated itineraries to export yet.');return;}
  const {jsPDF}=window.jspdf,doc=new jsPDF({orientation:'portrait',unit:'pt',format:'a4'}),es=_plannerOutputLang_()==='es';
  const logo=await _itbmoPdfLogoDataUrl_();
  const now=new Date(),yyyy=now.getFullYear(),mm=String(now.getMonth()+1).padStart(2,'0'),dd=String(now.getDate()).padStart(2,'0');
  const calendarDays=[],dayIndex=new Map();
  physicalBlocks.forEach(block=>block.days.forEach(day=>{const key=day.date||`day-${day.globalDay}`;let page=dayIndex.get(key);if(!page){page={globalDay:day.globalDay,date:day.date||'',destinations:[],rows:[]};dayIndex.set(key,page);calendarDays.push(page);}if(!page.destinations.some(x=>_arePoiAliases_(x,block.destination)))page.destinations.push(block.destination);(day.rows||[]).forEach(row=>page.rows.push({...row,_pdfDestination:block.destination}));}));
  calendarDays.sort((a,b)=>{const da=parseDMY(a.date||''),db=parseDMY(b.date||'');return(da?.getTime?.()||0)-(db?.getTime?.()||0)||Number(a.globalDay)-Number(b.globalDay);});
  const W=doc.internal.pageSize.getWidth(),H=doc.internal.pageSize.getHeight();
  for(let index=0;index<calendarDays.length;index++){
    if(index)doc.addPage('a4','portrait');const day=calendarDays[index],rows=day.rows.slice().sort((a,b)=>String(a.start||'').localeCompare(String(b.start||''))),routeLabel=day.destinations.join('  →  ');
    // Premium light header: preserve the Home brand hierarchy and keep the logo legible.
    doc.setFillColor(249,252,255);doc.rect(0,0,W,112,'F');
    doc.setFillColor(8,123,250);doc.rect(0,108,W*.42,4,'F');doc.setFillColor(28,183,194);doc.rect(W*.42,108,W*.33,4,'F');doc.setFillColor(109,120,238);doc.rect(W*.75,108,W*.25,4,'F');
    if(logo){try{doc.addImage(logo,'JPEG',34,18,104,32,undefined,'FAST');}catch(_){doc.setTextColor(8,35,65);doc.setFont('helvetica','bold');doc.setFontSize(18);doc.text('ITBMO',34,42);}}
    else{doc.setTextColor(8,35,65);doc.setFont('helvetica','bold');doc.setFontSize(18);doc.text('ITBMO',34,42);}
    doc.setFont('helvetica','bold');doc.setFontSize(10.5);doc.setTextColor(8,35,65);doc.text(es?'Tu viaje.':'Your trip.',34,68);
    doc.setTextColor(19,157,190);doc.text(es?'Tu estilo.':'Your style.',78,68);
    doc.setTextColor(8,35,65);doc.text(es?'Una ruta diseñada para ti.':'A route designed for you.',124,68);
    doc.setFont('helvetica','normal');doc.setFontSize(7.7);doc.setTextColor(91,112,132);doc.text(es?'Tu viaje, pensado por ti. Organizado por ITBMO.':'Your trip, shaped by you. Organized by ITBMO.',34,84);
    doc.setFillColor(239,246,255);doc.roundedRect(W-116,20,82,48,12,12,'F');doc.setTextColor(8,35,65);doc.setFont('helvetica','bold');doc.setFontSize(11);doc.text(normalizeCellText(`${es?'Día':'Day'} ${day.globalDay}`),W-75,39,{align:'center'});doc.setFontSize(8);doc.setFont('helvetica','normal');doc.setTextColor(73,94,115);doc.text(normalizeCellText(day.date||''),W-75,55,{align:'center'});
    doc.setTextColor(11,35,65);doc.setFont('helvetica','bold');doc.setFontSize(20);doc.text(normalizeCellText(routeLabel||`${es?'Día':'Day'} ${day.globalDay}`),34,142,{maxWidth:W-68});
    doc.setFont('helvetica','normal');doc.setFontSize(8.5);doc.setTextColor(100,119,138);doc.text(es?'Itinerario optimizado · horarios, traslados y recomendaciones prácticas':'Optimized itinerary · timing, transfers and practical guidance',34,160);
    let y=182;
    for(const row of rows){
      const style=_itbmoPdfBlockStyle_(row),activity=normalizeCellText(row.activity||''),fromTo=normalizeCellText(`${row.from||''}${row.to?` → ${row.to}`:''}`),transport=normalizeCellText(_v40VisibleTransportForRow_(row)||''),duration=normalizeCellText(_v39VisibleDuration_(row)),notes=normalizeCellText(row.notes||'');
      const activityLines=doc.splitTextToSize(activity,310),routeLines=doc.splitTextToSize(fromTo,310),notesLines=doc.splitTextToSize(notes,465),transportLines=doc.splitTextToSize([transport,duration].filter(Boolean).join(' · '),365);
      const blockH=Math.max(82,38+activityLines.length*11+routeLines.length*9+transportLines.length*9+notesLines.length*8.5);
      if(y+blockH>H-42){
        doc.addPage('a4','portrait');
        doc.setFillColor(249,252,255);doc.rect(0,0,W,48,'F');doc.setFillColor(8,123,250);doc.rect(0,46,W,2,'F');
        doc.setFont('helvetica','bold');doc.setFontSize(9.5);doc.setTextColor(8,35,65);doc.text(normalizeCellText(`${es?'Día':'Day'} ${day.globalDay} · ${routeLabel||''}`),34,24,{maxWidth:W-150});
        doc.setFont('helvetica','normal');doc.setFontSize(8);doc.setTextColor(100,119,138);doc.text(es?'continuación':'continued',W-34,24,{align:'right'});
        y=64;
      }
      doc.setFillColor(...style.fill);doc.roundedRect(34,y,W-68,blockH,12,12,'F');doc.setFillColor(...style.accent);doc.roundedRect(34,y,5,blockH,3,3,'F');
      doc.setTextColor(8,123,250);doc.setFont('helvetica','bold');doc.setFontSize(10);doc.text(normalizeCellText(`${row.start||''} - ${row.end||''}`),50,y+20);
      doc.setTextColor(11,35,65);doc.setFontSize(11);doc.text(activityLines,50,y+37);
      let ty=y+37+activityLines.length*11+4;doc.setFont('helvetica','normal');doc.setFontSize(8.2);doc.setTextColor(73,94,115);doc.text(routeLines,50,ty);ty+=routeLines.length*9+5;
      if(transportLines.length){doc.setTextColor(32,122,145);doc.setFont('helvetica','bold');doc.text(transportLines,50,ty);ty+=transportLines.length*9+5;}
      if(notesLines.length){doc.setFont('helvetica','normal');doc.setTextColor(82,99,116);doc.setFontSize(7.8);doc.text(notesLines,50,ty);}
      y+=blockH+9;
    }
  }
  const total=doc.getNumberOfPages();for(let p=1;p<=total;p++){doc.setPage(p);doc.setDrawColor(225,232,240);doc.line(34,H-28,W-34,H-28);doc.setFontSize(7.5);doc.setTextColor(113,128,143);doc.text(`ITBMO · ${p} / ${total}`,W-34,H-14,{align:'right'});doc.text(es?'I Travel By My Own · Itinerario personal':'I Travel By My Own · Personal itinerary',34,H-14);}
  const filename=`ITBMO-Itinerary-${yyyy}-${mm}-${dd}.pdf`,blob=doc.output('blob');if(options.download!==false)await deliverGeneratedFile(blob,filename);trackITBMOEvent('export_pdf',{file_type:'pdf',layout:'premium_cards_one_calendar_day_v8',destinations:physicalBlocks.length,days:calendarDays.length});return{blob,filename,kind:'itinerary_pdf'};
}

async function emailApi(payload){
  const response=await fetch('/api/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(data?.code||'EMAIL_SEND_FAILED');error.code=data?.code||'EMAIL_SEND_FAILED';throw error;}
  return data;
}

async function blobToBase64(blob){
  const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
  for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
  return btoa(binary);
}

const emailSendCopy=()=>getLang()==='es'?{
  preparing:'Preparando tus tres archivos…',sending:'Enviando de forma segura…',sent:'✓ Correo enviado. Revisa también spam o promociones.',invalid:'Escribe un correo válido.',receipt:'No encontramos un comprobante disponible para este viaje.',large:'Los archivos superan el tamaño permitido para un solo correo. Descárgalos por separado.',config:'Brevo todavía no está configurado en el servidor.',error:'No se pudo enviar el correo. Inténtalo de nuevo.'
}:{preparing:'Preparing your three files…',sending:'Sending securely…',sent:'✓ Email sent. Please also check spam or promotions.',invalid:'Enter a valid email address.',receipt:'No receipt is available for this trip.',large:'The files are too large for one email. Download them separately.',config:'Brevo is not configured on the server yet.',error:'The email could not be sent. Please try again.'};

function setEmailDeliveryStatus(message='',type=''){
  if(!$itineraryEmailStatus)return;$itineraryEmailStatus.textContent=message;$itineraryEmailStatus.className='form-send-status'+(type?` is-${type}`:'');
}
function openItineraryEmailModal(){
  if(!$itineraryEmailModal||!hasGeneratedItineraryRows())return;
  $itineraryEmailRecipient.value=String(currentUser?.email||'');setEmailDeliveryStatus('');
  $itineraryEmailModal.classList.add('active');$itineraryEmailModal.setAttribute('aria-hidden','false');setTimeout(()=>$itineraryEmailRecipient.focus(),60);
}
function closeItineraryEmailModal({restoreDownloads=true}={}){if(!$itineraryEmailModal)return;$itineraryEmailModal.classList.remove('active');$itineraryEmailModal.setAttribute('aria-hidden','true');if(restoreDownloads && hasGeneratedItineraryRows())setTimeout(()=>showFinalDownloadModal(),80);}
async function sendItineraryByEmail(event){
  event?.preventDefault();const copy=emailSendCopy(),recipient=String($itineraryEmailRecipient?.value||'').trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)){setEmailDeliveryStatus(copy.invalid,'error');return;}
  const token=getStoredSessionToken();if(!token){setEmailDeliveryStatus(copy.error,'error');return;}
  $itineraryEmailSubmit.disabled=true;
  try{
    setEmailDeliveryStatus(copy.preparing);const payment=await getPaymentReceiptData();
    if(!payment)throw Object.assign(new Error('RECEIPT_REQUIRED'),{code:'RECEIPT_REQUIRED'});
    const generated=await Promise.all([exportItineraryToPDF({download:false}),exportItineraryToXLSX({download:false}),exportPaymentReceiptToPDF(payment,{download:false})]);
    if(generated.reduce((sum,item)=>sum+(item?.blob?.size||0),0)>3*1024*1024)throw Object.assign(new Error('ATTACHMENTS_TOO_LARGE'),{code:'ATTACHMENTS_TOO_LARGE'});
    setEmailDeliveryStatus(copy.sending);const attachments=[];
    for(const item of generated)attachments.push({kind:item.kind,name:item.filename,type:item.blob.type,content:await blobToBase64(item.blob)});
    await emailApi({action:'send_itinerary',session_token:token,trip_id:currentTripId,recipient_email:recipient,lang:getLang(),attachments});
    setEmailDeliveryStatus(copy.sent,'success');trackITBMOEvent('trip_shared',{channel:'email',file_type:'pdf_xlsx_receipt'});setTimeout(()=>closeItineraryEmailModal({restoreDownloads:true}),900);
  }catch(error){const key=error?.code==='RECEIPT_REQUIRED'?'receipt':error?.code==='ATTACHMENTS_TOO_LARGE'?'large':error?.code==='EMAIL_NOT_CONFIGURED'?'config':'error';setEmailDeliveryStatus(copy[key],'error');}
  finally{$itineraryEmailSubmit.disabled=false;}
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

async function exportPaymentReceiptToPDF(preloadedPayment=null,options={}){
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
  if(options.download!==false) await deliverGeneratedFile(blob,filename);
  trackITBMOEvent('export_receipt',{file_type:'payment_receipt_pdf'});
  return {blob,filename,kind:'receipt_pdf'};
}

function showPostDownloadWorkspaceGuide(){
  document.querySelector('.itbmo-next-overlay')?.remove();
  const es=getLang()==='es';
  const overlay=document.createElement('div');overlay.className='itbmo-next-overlay';
  overlay.innerHTML=`<div class="itbmo-next-card" role="dialog" aria-modal="true">
    <div class="itbmo-next-icon">✦</div>
    <h3>${es?'Tu viaje ya está listo para explorarlo.':'Your trip is ready to explore.'}</h3>
    <p>${es?'Tu itinerario es solo el comienzo. Ahora tienes un espacio para preparar todo el viaje y otro para explorar cada destino día por día.':'Your itinerary is only the beginning. You now have one space to prepare the whole trip and another to explore each destination day by day.'}</p>
    <div class="itbmo-next-grid">
      <div><strong>${es?'Prepara todo tu viaje':'Prepare your whole trip'}</strong><span>${es?'Usa el botón “Explora y prepara tu viaje” para entrar a las ciudades y abrir “Para todo tu viaje”: conectividad, seguros y servicios útiles para toda la ruta.':'Use “Explore and prepare your trip” to enter your cities and open “For your whole trip”: connectivity, insurance and useful services for the full route.'}</span><em>${es?'Explora y prepara tu viaje →  ·  Para todo tu viaje':'Explore and prepare your trip →  ·  For your whole trip'}</em></div>
      <div><strong>${es?'Explora cada destino':'Explore each destination'}</strong><span>${es?'Al entrar a una ciudad verás el itinerario detallado día por día. En “Para tu viaje” encontrarás entradas, tours, experiencias y transporte seleccionados según ese itinerario.':'Inside each city you will see the detailed day-by-day itinerary. “For your trip” brings together tickets, tours, experiences and transport selected from that itinerary.'}</span><em>${es?'Itinerario  |  ✦ Para tu viaje · EXPLORA':'Itinerary  |  ✦ For your trip · EXPLORE'}</em></div>
    </div>
    <button type="button">${es?'Explorar mi viaje →':'Explore my trip →'}</button>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('button')?.addEventListener('click',()=>{
    showWOW(false);
    document.querySelector('#guided-personalization-overlay')?.remove();
    document.body.classList.remove('guided-preferences-open');
    overlay.remove();
    requestAnimationFrame(()=>{const doc=document.documentElement;const bottom=Math.max(document.body?.scrollHeight||0,doc?.scrollHeight||0);window.scrollTo({top:bottom,behavior:'smooth'});});
  });
}

function showFinalDownloadModal(){
  if(document.querySelector('.itbmo-download-overlay')) return;
  const es=getLang()==='es';
  const overlay=document.createElement('div'); overlay.className='itbmo-download-overlay';
  overlay.innerHTML=`<div class="itbmo-download-card" role="dialog" aria-modal="true" aria-labelledby="itbmo-download-title">
    <div class="itbmo-download-spark">✓</div><div class="itbmo-download-eyebrow">${es?'ITBMO TERMINÓ':'ITBMO IS DONE'}</div>
    <h3 id="itbmo-download-title">${es?'Tu itinerario está listo.':'Your itinerary is ready.'}</h3>
    <p>${es?'Descarga cada documento por separado. Así tu navegador no bloqueará ninguno y podrás guardarlos con seguridad.':'Download each document separately. This prevents your browser from blocking any file and lets you save them safely.'}</p>
    <div class="itbmo-download-files"><span>PDF · ${es?'Itinerario':'Itinerary'}</span><span>XLSX · Excel</span><span>PDF · ${es?'Comprobante':'Receipt'}</span></div>
    <div class="itbmo-download-actions">
      <button class="btn primary itbmo-open-pdf" type="button"><span>01</span>${es?'Descargar itinerario PDF':'Download itinerary PDF'}</button>
      <button class="btn primary itbmo-open-csv" type="button"><span>02</span>${es?'Descargar Excel editable':'Download editable Excel'}</button>
      <button class="btn primary itbmo-open-receipt" type="button" disabled><span>03</span>${es?'Preparando comprobante…':'Preparing receipt…'}</button>
      <button class="btn itbmo-email-package" type="button"><span>✉</span>${es?'Enviar los 3 archivos por email':'Email all 3 files'}</button>
    </div>
    <div class="itbmo-download-status" aria-live="polite"></div>
    <label class="itbmo-download-ack"><input type="checkbox"> <span>${es?'He leído esta información y entiendo que debo conservar mis documentos.':'I have read this information and understand that I must keep my documents.'}</span></label>
    <button class="btn itbmo-download-close" type="button" disabled>${es?'Continuar':'Continue'}</button>
    <small>${es?'En móvil podrás abrir, compartir o guardar cada archivo mediante las opciones del dispositivo.':'On mobile, you can open, share or save each file using your device options.'}</small>
  </div>`;
  document.body.appendChild(overlay); requestAnimationFrame(()=>overlay.classList.add('active'));
  const ack=overlay.querySelector('input'); const close=overlay.querySelector('.itbmo-download-close'); const status=overlay.querySelector('.itbmo-download-status');
  ack.addEventListener('change',()=>{close.disabled=!ack.checked;});
  close.addEventListener('click',()=>{
    if(!ack.checked) return;
    overlay.classList.remove('active');

    overlay.remove();
    showPostDownloadWorkspaceGuide();
  });
  const pdfButton=overlay.querySelector('.itbmo-open-pdf');
  const csvButton=overlay.querySelector('.itbmo-open-csv');
  const receiptButton=overlay.querySelector('.itbmo-open-receipt');
  const emailButton=overlay.querySelector('.itbmo-email-package');
  let preparedReceipt=null;

  getPaymentReceiptData().then(payment=>{
    preparedReceipt=payment;
    if(!receiptButton) return;
    receiptButton.disabled=!payment;
    receiptButton.innerHTML=payment
      ? `<span>03</span>${es?'Descargar comprobante PDF':'Download payment receipt PDF'}`
      : `<span>03</span>${es?'Comprobante no disponible':'Receipt unavailable'}`;
  }).catch(()=>{
    if(receiptButton){
      receiptButton.disabled=true;
      receiptButton.innerHTML=`<span>03</span>${es?'Comprobante no disponible':'Receipt unavailable'}`;
    }
  });

  const completeButton=(button,label)=>{
    button?.classList.add('is-complete');
    if(button) button.dataset.completeLabel=label;
  };
  pdfButton?.addEventListener('click',async()=>{
    try{
      await exportItineraryToPDF();
      completeButton(pdfButton,es?'PDF listo':'PDF ready');
      status.textContent=es ? '✓ Itinerario PDF preparado.' : '✓ Itinerary PDF prepared.';
    }catch(_){status.textContent=es?'No se pudo preparar el PDF. Inténtalo de nuevo.':'The PDF could not be prepared. Please try again.';}
  });
  csvButton?.addEventListener('click',async()=>{
    try{
      await exportItineraryToXLSX();
      completeButton(csvButton,es?'Excel listo':'Excel ready');
      status.textContent=es ? '✓ Excel editable preparado.' : '✓ Editable Excel prepared.';
    }catch(_){status.textContent=es?'No se pudo preparar el Excel. Inténtalo de nuevo.':'The Excel file could not be prepared. Please try again.';}
  });
  receiptButton?.addEventListener('click',async()=>{
    if(!preparedReceipt) return;
    try{
      await exportPaymentReceiptToPDF(preparedReceipt);
      completeButton(receiptButton,es?'Comprobante listo':'Receipt ready');
      status.textContent=es ? '✓ Comprobante PDF preparado.' : '✓ Receipt PDF prepared.';
    }catch(_){status.textContent=es?'No se pudo preparar el comprobante. Inténtalo de nuevo.':'The receipt could not be prepared. Please try again.';}
  });
  emailButton?.addEventListener('click',()=>{overlay.classList.remove('active');overlay.remove();openItineraryEmailModal();});
}

function bindExportListeners(){
  if(isMobileFileExperience()){
    if($btnPDF) $btnPDF.textContent=getLang()==='es' ? 'Abrir / compartir PDF' : 'Open / share PDF';
    if($btnCSV) $btnCSV.textContent=getLang()==='es' ? 'Abrir / compartir Excel' : 'Open / share Excel';
    if($btnReceipt) $btnReceipt.textContent=getLang()==='es' ? 'Abrir / compartir comprobante' : 'Open / share receipt';
  }

  $btnPDF?.addEventListener('click', (e)=>{
    e.preventDefault();
    exportItineraryToPDF();
  });

  $btnCSV?.addEventListener('click', (e)=>{
    e.preventDefault();
    exportItineraryToXLSX().catch(()=>{});
  });

  $btnReceipt?.addEventListener('click', async (e)=>{
    e.preventDefault();
    await exportPaymentReceiptToPDF();
  });

  $btnEmail?.addEventListener('click',(e)=>{e.preventDefault();openItineraryEmailModal();});
}

/* =========================================================
   MODAL VISIBILITY · planner iframe -> parent page
   Critical windows request that the parent page brings the top of the
   Planner into view. Standalone Vercel use falls back to window.scrollTo.
   ========================================================= */

function smoothAdvanceTo(target,{gap=118,center=false}={}){
  const el=typeof target==='string' ? qs(target) : target;
  if(!el) return;
  const rect=el.getBoundingClientRect();
  const current=window.scrollY || document.documentElement.scrollTop || 0;
  const viewportBottom=window.innerHeight || document.documentElement.clientHeight || 0;
  const targetTop=current + rect.top - gap;

  /* Never pull the traveler backward. Advance only when the next stage is below
     the comfortable reading zone. */
  const needsAdvance = center
    ? rect.top > viewportBottom * .58
    : rect.top > viewportBottom * .72;

  if(needsAdvance && targetTop > current + 24){
    window.scrollTo({top:targetTop,behavior:'smooth'});
  }
}

function installPlannerInlineInfoChat(){
  /* Phase 4.9 · Restore the original floating Info Chat contract.
     Keep the modal as a direct child of <body>. Do not reparent it into the
     Planner flow and do not reset user-resized/user-moved geometry on reopen. */
  const modal=qs('#info-chat-modal');
  if(!modal) return;

  if(modal.parentElement !== document.body){
    document.body.appendChild(modal);
  }

  modal.classList.remove('is-inline-planner-chat');
  delete modal.dataset.mobileViewportLayout;
}

function installPlannerAgentFlow(){
  const host=qs('#planner-agent-flow');
  const chat=qs('#chat-container');
  if(host && chat && chat.parentElement!==host) host.appendChild(chat);
}

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

function showPlannerDecision({title,message,confirmLabel,cancelLabel,variant='primary'}={}){
  qsa('.itbmo-decision-overlay').forEach(el=>el.remove());
  return new Promise(resolve=>{
    const overlay=document.createElement('div');
    overlay.className='itbmo-decision-overlay';
    const card=document.createElement('div');
    card.className='itbmo-decision-card';
    card.setAttribute('role','dialog');
    card.setAttribute('aria-modal','true');
    card.innerHTML=`
      <div class="itbmo-decision-symbol">✦</div>
      <div class="itbmo-decision-eyebrow">ITBMO · ${getLang()==='es'?'CONFIRMACIÓN':'CONFIRMATION'}</div>
      <h3></h3><p></p>
      <div class="itbmo-decision-actions">
        <button class="btn ghost itbmo-decision-cancel" type="button"></button>
        <button class="btn ${variant==='payment'?'itbmo-decision-pay':'primary'} itbmo-decision-confirm" type="button"></button>
      </div>`;
    card.querySelector('h3').textContent=String(title||'');
    card.querySelector('p').textContent=String(message||'');
    card.querySelector('.itbmo-decision-cancel').textContent=String(cancelLabel||'Cancel');
    card.querySelector('.itbmo-decision-confirm').textContent=String(confirmLabel||'Continue');
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    let settled=false;
    const finish=(value)=>{
      if(settled) return;
      settled=true;
      document.removeEventListener('keydown',onKey);
      overlay.classList.remove('active');
      setTimeout(()=>overlay.remove(),220);
      resolve(Boolean(value));
    };
    const onKey=(e)=>{if(e.key==='Escape') finish(false);};
    card.querySelector('.itbmo-decision-cancel')?.addEventListener('click',()=>finish(false));
    card.querySelector('.itbmo-decision-confirm')?.addEventListener('click',()=>finish(true));
    overlay.addEventListener('click',(e)=>{if(e.target===overlay) finish(false);});
    document.addEventListener('keydown',onKey);
      requestAnimationFrame(()=>overlay.classList.add('active'));
  });
}

// ⛔ Reset con confirmación modal (corregido: visible → active)
qs('#reset-planner')?.addEventListener('click', ()=>{
  const recoveryReset=Boolean(generationResetRequestedFromRecovery);
  generationResetRequestedFromRecovery=false;
  if(paidGenerationRunning && !recoveryReset) return;
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
  setTimeout(()=>overlay.classList.add('active'), 10);

  const confirmReset = overlay.querySelector('#confirm-reset');
  const cancelReset  = overlay.querySelector('#cancel-reset');

  confirmReset.addEventListener('click', async ()=>{
    if(paidGenerationRunning && !recoveryReset) return;

    // Atomically invalidate the active generation BEFORE archival/cleanup. Any late
    // async response from the old run is ignored and can no longer checkpoint or
    // reopen recovery after the reset completes.
    generationResetInProgress = true;
    generationRunEpoch += 1;
    paidGenerationRunning = false;
    confirmReset.disabled = true;

    const tripIdToArchive = currentTripId || getStoredActiveTripId();
    const sessionToken = getStoredSessionToken();
    if(sessionToken){
      try{
        await tripApi({
          action:'archive',
          session_token:sessionToken,
          trip_id:tripIdToArchive || null,
          prevent_auto_recovery:true
        });
      }catch(err){
        console.warn('[RESET ARCHIVE]',err);
        generationResetInProgress = false;
        confirmReset.disabled = false;
        let errorMessage = overlay.querySelector('.reset-error');
        if(!errorMessage){
          errorMessage = document.createElement('p');
          errorMessage.className = 'reset-error';
          modal.insertBefore(errorMessage, modal.querySelector('.reset-actions'));
        }
        errorMessage.textContent = getLang()==='es'
          ? 'No pudimos cerrar este viaje. Verifica tu conexión e inténtalo nuevamente.'
          : 'We could not close this trip. Check your connection and try again.';
        return;
      }
    }

    document.querySelector('.itbmo-generation-recovery-overlay')?.remove();
    clearInfoChatStateForTrip(tripIdToArchive);
    _clearPostPaymentProgressLocal_(tripIdToArchive);
    try{ localStorage.removeItem(ASTRA_COACH_STORAGE_KEY); }catch(_){ }
    try{ localStorage.removeItem('itbmo_trip_workspace_snapshot_v1'); }catch(_){ }
    try{ _tripStoryClearDraft_(); }catch(_){ }
    try{ _travelV2()?.setTripStory?.(null); }catch(_){ }
    // Clear accepted-stay caches/drafts from the just-archived planning run while
    // preserving account/session identity and unrelated generated-trip history.
    try{ Object.keys(sessionStorage).filter(k=>k.startsWith('itbmo_v3_stay_')||k.startsWith('itbmo_trip_story_draft_v1_')).forEach(k=>sessionStorage.removeItem(k)); }catch(_){ }
    closeAstraCoach({remember:false});

    $cityList.innerHTML=''; savedDestinations=[]; itineraries={}; cityMeta={};
    addCityRow();
    $start.disabled = true;
    $tabs.innerHTML=''; $itWrap.innerHTML='';
    closeImmersiveItinerary();
    syncImmersiveItineraryLauncher();
    $chatBox.style.display='none'; $chatM.innerHTML='';
    session = []; hasSavedOnce=false; pendingChange=null;
    saveLockWarningAccepted=false;
    paymentWarningAcceptedTripId=null;
    currentTripId = null;
    storeActiveTripId(null);
    generationRecoveryState = null;
    paidGenerationRunning = false;
    itbmoPlannerStartTracked = false;
    itbmoPlanningChatStarted = false;

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
      plannerState.travelModelV2 = null;
      plannerState.preferencesV2 = null;
      if(_travelV2()?.state){_travelV2().state.routes={};_travelV2().state.preferences={global:{},places:{}};_travelV2().state.itineraryLanguage='';}
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
    // A completed reset returns the product to the true pre-payment state.
    // Do not leave Trip Story controls carrying the previous paid-trip lock.
    setPostPaymentTripConfigurationLocked(false);
    const buildTripStory=qs('#build-trip-story');
    if(buildTripStory){buildTripStory.disabled=false;buildTripStory.removeAttribute('aria-disabled');buildTripStory.classList.remove('is-payment-locked');}
    updateSaveAvailability();

    // UX: enfocar primer input de ciudad
    const firstCity = qs('.city-row .city');
    if (firstCity) firstCity.focus();
    scheduleAstraCoach(
      currentUser ? 'travelers' : 'account',
      currentUser ? '#travelers-box' : '#account-box',
      360,
      {force:true}
    );
    generationResetInProgress = false;
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
  regularPrice: 7.99,
  basePrice: 2.99,

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
const $checkoutPromoInput = qs('#checkout-promo-input');
const $checkoutPromoApply = qs('#checkout-promo-apply');
const $checkoutPromoMessage = qs('#checkout-promo-message');
const $checkoutPromoSummary = qs('#checkout-promo-summary');
const $checkoutPromoLabel = qs('#checkout-promo-label');

const $needHelp = qs('#need-help-floating');
const $supportModal = qs('#support-modal');
const $supportClose = qs('#support-close');
const $supportEmailButton = qs('#support-email-button');
const $supportForm = qs('#support-form');
const $supportCategory = qs('#support-category');
const $supportContactEmail = qs('#support-contact-email');
const $supportMessage = qs('#support-message');
const $supportFormStatus = qs('#support-form-status');
const $itineraryEmailModal = qs('#itinerary-email-modal');
const $itineraryEmailClose = qs('#itinerary-email-close');
const $itineraryEmailForm = qs('#itinerary-email-form');
const $itineraryEmailRecipient = qs('#itinerary-email-recipient');
const $itineraryEmailSubmit = qs('#itinerary-email-submit');
const $itineraryEmailStatus = qs('#itinerary-email-status');

let paymentGateSatisfiedTripId = null;
let paypalSdkLoadingPromise = null;
let activePromoReservation = null;
let commerceServerConfig = null;

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
    checkoutSub:'Desbloquea tu itinerario completo y personalizado con ITBMO.',
    offer:'OFERTA DE LANZAMIENTO · TIEMPO LIMITADO',
    priceNote:'Pago único · Viaje completo · Todas las ciudades configuradas',
    inc1:'Itinerario personalizado completo',
    inc2:'Inteligencia de viaje de ITBMO',
    inc3:'Exportación PDF y Excel',
    cardTitle:'Tarjeta de crédito o débito',
    cardCopy:'Visa · Mastercard · American Express',
    secureTitle:'Procesamiento de pago seguro',
    secureCopy:'Los pagos son procesados de forma segura por nuestros proveedores. ITBMO nunca almacena los datos de tu tarjeta.',
    trust1:'Pago seguro',
    trust2:'Política de reembolso clara',
    trust3:'Atención humana',
    supportLink:'¿Necesitas ayuda? Contacta Atención al Cliente',
    preview:'Modo de prueba · Continuar con ITBMO',
    providerSoon:'Este método todavía no está activado.',
    promoLabel:'¿Tienes un código promocional?',
    promoPlaceholder:'Ingresa tu código',
    promoApply:'Aplicar',
    promoApplied:(code)=>`✓ Código ${code} aplicado`,
    promoFree:'Tu itinerario queda cubierto al 100% con este código.',
    promoDiscount:(amount,final)=>`Descuento US$${amount} · Total US$${final}`,
    promoErrors:{PROMO_CODE_REQUIRED:'Ingresa un código.',PROMO_NOT_FOUND:'Ese código no existe.',PROMO_INACTIVE:'Ese código no está activo.',PROMO_NOT_STARTED:'Este código todavía no está vigente.',PROMO_EXPIRED:'Este código ya venció.',PROMO_EXHAUSTED:'Este código alcanzó su límite de usos.',PROMO_USER_LIMIT:'Ya utilizaste el máximo permitido para este código.',PROMO_REGISTERED_REQUIRED:'Este código requiere una cuenta registrada.',PROMO_VERIFIED_REQUIRED:'Este código requiere una cuenta verificada.',PROMO_RESERVATION_EXPIRED:'La reserva del código venció. Aplícalo nuevamente.',PROMO_UNAVAILABLE:'No pudimos aplicar este código.'},
    processing:'Procesando pago…',
    paid:'✓ Pago confirmado. Todo está listo.',
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
    checkoutSub:'Unlock your complete personalized itinerary with ITBMO.',
    offer:'LIMITED-TIME LAUNCH OFFER',
    priceNote:'One-time payment · Complete trip · All configured cities',
    inc1:'Complete personalized itinerary',
    inc2:'ITBMO travel intelligence',
    inc3:'PDF & Excel exports',
    cardTitle:'Credit or Debit Card',
    cardCopy:'Visa · Mastercard · American Express',
    secureTitle:'Secure payment processing',
    secureCopy:'Payments are securely handled by our payment providers. ITBMO never stores your card details.',
    trust1:'Secure payment',
    trust2:'Clear refund policy',
    trust3:'Human customer support',
    supportLink:'Need help? Contact Customer Support',
    preview:'Preview mode · Continue to ITBMO',
    providerSoon:'This payment method is not active yet.',
    promoLabel:'Have a promo code?',
    promoPlaceholder:'Enter your code',
    promoApply:'Apply',
    promoApplied:(code)=>`✓ Code ${code} applied`,
    promoFree:'This code covers 100% of your itinerary.',
    promoDiscount:(amount,final)=>`Discount US$${amount} · Total US$${final}`,
    promoErrors:{PROMO_CODE_REQUIRED:'Enter a code.',PROMO_NOT_FOUND:'That code does not exist.',PROMO_INACTIVE:'That code is not active.',PROMO_NOT_STARTED:'This code is not active yet.',PROMO_EXPIRED:'This code has expired.',PROMO_EXHAUSTED:'This code has reached its usage limit.',PROMO_USER_LIMIT:'You already used the maximum allowed for this code.',PROMO_REGISTERED_REQUIRED:'This code requires a registered account.',PROMO_VERIFIED_REQUIRED:'This code requires a verified account.',PROMO_RESERVATION_EXPIRED:'The code reservation expired. Apply it again.',PROMO_UNAVAILABLE:'We could not apply this code.'},
    processing:'Processing payment…',
    paid:'✓ Payment confirmed. Everything is ready.',
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
  const es=getLang()==='es';
  const direct={
    '#support-category-label':es?'Tipo de ayuda':'Help topic','#support-contact-label':es?'Tu correo de contacto':'Your contact email','#support-message-label':es?'Cuéntanos qué ocurrió':'Tell us what happened',
    '#itinerary-email-title':es?'Enviar mi viaje por email':'Email my trip','#itinerary-email-copy':es?'Recibirás en un solo correo el itinerario PDF, el Excel editable y el comprobante.':'One email will include your itinerary PDF, editable Excel and receipt.','#itinerary-email-label':es?'Correo del destinatario':'Recipient email','#itinerary-email-submit':es?'Preparar y enviar los 3 archivos':'Prepare and email all 3 files'
  };
  Object.entries(direct).forEach(([selector,value])=>{const element=qs(selector);if(element)element.textContent=value;});
  const options=$supportCategory?.options||[];
  const optionLabels=es?['Problemas al generar el itinerario','Pagos y reembolsos','Ayuda con mi cuenta','Otro']:['Itinerary generation issues','Payments and refunds','Account assistance','Other'];
  Array.from(options).forEach((option,index)=>{if(optionLabels[index])option.textContent=optionLabels[index];});

  const oldP = qs('#checkout-price-old');
  const newP = qs('#checkout-price-new');
  const regularPrice=Number(commerceServerConfig?.regular_price || ITBMO_COMMERCE_CONFIG.regularPrice);
  const basePrice=Number(commerceServerConfig?.base_price || ITBMO_COMMERCE_CONFIG.basePrice);
  const finalPrice=Number(activePromoReservation?.final_amount ?? basePrice);
  if(oldP) oldP.textContent = `US$${regularPrice.toFixed(2)}`;
  if(newP) newP.textContent = `US$${finalPrice.toFixed(2)}`;
  if($checkoutPromoLabel) $checkoutPromoLabel.textContent=c.promoLabel;
  if($checkoutPromoInput) $checkoutPromoInput.placeholder=c.promoPlaceholder;
  if($checkoutPromoApply) $checkoutPromoApply.textContent=c.promoApply;
  if($checkoutPromoSummary){
    if(activePromoReservation){
      $checkoutPromoSummary.hidden=false;
      $checkoutPromoSummary.textContent=activePromoReservation.is_free
        ? c.promoFree
        : c.promoDiscount(Number(activePromoReservation.discount_amount||0).toFixed(2),Number(activePromoReservation.final_amount||0).toFixed(2));
    }else{
      $checkoutPromoSummary.hidden=true;
      $checkoutPromoSummary.textContent='';
    }
  }

  if($needHelp) $needHelp.style.display = ITBMO_COMMERCE_CONFIG.support.enabled ? 'flex' : 'none';

  if($checkoutPreviewContinue){
    $checkoutPreviewContinue.style.display = ITBMO_COMMERCE_CONFIG.previewMode ? 'block' : 'none';
  }

  /* PayPal-only launch: hide the inactive card/Tilopay bar completely. */
  if($checkoutTilopay && !ITBMO_COMMERCE_CONFIG.tilopay.enabled){
    $checkoutTilopay.style.display='none';
    $checkoutTilopay.setAttribute('aria-hidden','true');
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
  if($supportContactEmail && !$supportContactEmail.value) $supportContactEmail.value=String(currentUser?.email||'');
  if($supportFormStatus){$supportFormStatus.textContent='';$supportFormStatus.className='form-send-status';}
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

async function contactCustomerSupport(event){
  event?.preventDefault();const es=getLang()==='es';
  const contactEmail=String($supportContactEmail?.value||'').trim(),message=String($supportMessage?.value||'').trim();
  const setStatus=(value,type='')=>{if(!$supportFormStatus)return;$supportFormStatus.textContent=value;$supportFormStatus.className='form-send-status'+(type?` is-${type}`:'');};
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)||message.length<10){setStatus(es?'Escribe un correo válido y un mensaje de al menos 10 caracteres.':'Enter a valid email and a message of at least 10 characters.','error');return;}
  const token=getStoredSessionToken();if(!token){setStatus(es?'No pudimos validar tu sesión. Recarga la página e inténtalo nuevamente.':'We could not validate your session. Reload and try again.','error');return;}
  $supportEmailButton.disabled=true;setStatus(es?'Enviando tu solicitud…':'Sending your request…');
  try{
    await emailApi({action:'support_request',session_token:token,trip_id:currentTripId,lang:getLang(),category:$supportCategory?.value,contact_email:contactEmail,message,cities:(savedDestinations||[]).map(x=>x?.city).filter(Boolean).join(', ')});
    setStatus(es?'✓ Solicitud enviada. Nuestro equipo responderá a tu correo.':'✓ Request sent. Our team will reply by email.','success');$supportMessage.value='';
  }catch(error){setStatus(error?.code==='EMAIL_NOT_CONFIGURED'?(es?'Brevo todavía no está configurado en el servidor.':'Brevo is not configured on the server yet.'):(es?'No pudimos enviar la solicitud. Inténtalo de nuevo.':'We could not send the request. Please try again.'),'error');}
  finally{$supportEmailButton.disabled=false;}
}

function setCheckoutStatus(message='', type=''){
  if(!$checkoutStatus) return;
  $checkoutStatus.textContent = message || '';
  $checkoutStatus.className = 'checkout-status' + (type ? ` ${type}` : '');
}

async function loadCommerceServerConfig(){
  try{
    const token=getStoredSessionToken();
    if(!token) return null;
    commerceServerConfig=await paymentApi({action:'config',session_token:token});
    if(commerceServerConfig?.currency) ITBMO_COMMERCE_CONFIG.currency=commerceServerConfig.currency;
    return commerceServerConfig;
  }catch(err){
    console.warn('[COMMERCE CONFIG]',err);
    return null;
  }
}

function setPromoMessage(message='',type=''){
  if(!$checkoutPromoMessage) return;
  $checkoutPromoMessage.textContent=message||'';
  $checkoutPromoMessage.className='checkout-promo-message'+(type?` ${type}`:'');
}

async function promotionApi(payload){
  const response=await fetch('/api/promotions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload||{})});
  const body=await response.json().catch(()=>({}));
  if(!response.ok || body?.ok===false){
    const err=new Error(body?.code||`PROMO_HTTP_${response.status}`);
    err.code=body?.code||'PROMO_UNAVAILABLE';
    throw err;
  }
  return body;
}

async function applyPromotionCode(){
  const c=_commerceCopy_();
  const code=String($checkoutPromoInput?.value||'').trim().toUpperCase();
  if(!code){ setPromoMessage(c.promoErrors.PROMO_CODE_REQUIRED,'error'); return; }
  if(!$checkoutPromoApply || !currentTripId) return;
  $checkoutPromoApply.disabled=true;
  setPromoMessage('');
  try{
    const token=getStoredSessionToken();
    const result=await promotionApi({action:'reserve',session_token:token,trip_id:currentTripId,code});
    activePromoReservation=result?.reservation||null;
    if(!activePromoReservation) throw Object.assign(new Error('PROMO_UNAVAILABLE'),{code:'PROMO_UNAVAILABLE'});
    setPromoMessage(c.promoApplied(activePromoReservation.code||code),'success');
    applyCommerceI18n();
    trackITBMOEvent('promo_code_applied',{promotion_code:activePromoReservation.code||code,promo_type:activePromoReservation.promo_type||'',discount_amount:Number(activePromoReservation.discount_amount||0)});

    if(activePromoReservation.is_free){
      const consumed=await promotionApi({action:'consume_free',session_token:token,trip_id:currentTripId,redemption_id:activePromoReservation.redemption_id});
      if(!consumed?.ok) throw Object.assign(new Error('PROMO_UNAVAILABLE'),{code:'PROMO_UNAVAILABLE'});
      trackITBMOEvent('promo_code_consumed',{promotion_code:activePromoReservation.code||code,promo_type:activePromoReservation.promo_type||'',discount_amount:Number(activePromoReservation.discount_amount||0)});
      await completePaymentGate(c.promoFree);
    }
  }catch(err){
    const key=err?.code||'PROMO_UNAVAILABLE';
    activePromoReservation=null;
    applyCommerceI18n();
    setPromoMessage(c.promoErrors[key]||c.promoErrors.PROMO_UNAVAILABLE,'error');
  }finally{
    if($checkoutPromoApply) $checkoutPromoApply.disabled=false;
  }
}

function openCheckoutModal(){
  if(!$checkoutModal) return;
  applyCommerceI18n();
  const loadingMessage=getLang()==='es'?'Cargando opciones seguras de pago…':'Loading secure payment options…';
  setCheckoutStatus(loadingMessage);
  $checkoutModal.classList.add('active');
  $checkoutModal.setAttribute('aria-hidden','false');

  /* QUIRÚRGICO · Checkout visibility inside the auto-height Webflow iframe.
     The parent page is moved to the Planner top, while the modal itself always
     opens from its own top. This avoids hiding checkout in a tall iframe. */
  $checkoutModal.scrollTop=0;
  const checkoutCard=$checkoutModal.querySelector('.checkout-card');
  if(checkoutCard) checkoutCard.scrollTop=0;

  Promise.resolve(loadCommerceServerConfig())
    .then(()=>{ applyCommerceI18n(); return renderPayPalButtonsIfAvailable(); })
    .finally(()=>{
      if($checkoutStatus?.textContent===loadingMessage) setCheckoutStatus('');
      $checkoutModal.scrollTop=0;
      if(checkoutCard) checkoutCard.scrollTop=0;
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
    const authorized = Boolean(data?.paid || data?.admin_bypass);
    if(authorized){
      paymentGateSatisfiedTripId=currentTripId;
      setPostPaymentTripConfigurationLocked(true);
    }else{
      paymentGateSatisfiedTripId=null;
      setPostPaymentTripConfigurationLocked(false);
    }
    applyInfoChatStatus(data);
    return authorized;
  }catch(err){
    console.warn('[PAYMENT STATUS]',err);
    return false;
  }
}

function showPostPaymentWelcome(){
  document.querySelector('.itbmo-postpay-overlay')?.remove();
  const es=getLang()==='es';
  const overlay=document.createElement('div');overlay.className='itbmo-postpay-overlay';
  overlay.innerHTML=`<div class="itbmo-postpay-card" role="dialog" aria-modal="true">
    <div class="itbmo-postpay-icon">✓</div>
    <h3>${es?'¡Gracias por tu pago!':'Thank you for your payment!'}</h3>
    <p>${es
      ? 'Info Chat ya está habilitado para ayudarte a investigar y resolver dudas sobre tu viaje. Antes de generar el itinerario, te pediremos algunos datos de hospedaje, transporte, preferencias y restricciones para personalizar cada destino y estancia.'
      : 'Info Chat is now enabled to help you research and answer questions about your trip. Before generating the itinerary, we will ask for a few lodging, transport, preference and restriction details to personalize each destination and stay.'}</p>
    <button type="button">${es?'Personalizar mi viaje →':'Personalize my trip →'}</button>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('button')?.addEventListener('click',()=>{
    overlay.remove();showPreferencesStage();
    requestAnimationFrame(()=>smoothAdvanceTo('#preferences-stage',{gap:92,center:false}));
  });
}

async function completePaymentGate(successMessage=''){
  paymentGateSatisfiedTripId = currentTripId || paymentGateSatisfiedTripId;
  setPostPaymentTripConfigurationLocked(true);
  setCheckoutStatus(successMessage || _commerceCopy_().paid,'success');
  try{
    const token=getStoredSessionToken();
    if(token && currentTripId){
      const status=await paymentApi({action:'status',session_token:token,trip_id:currentTripId});
      applyInfoChatStatus(status);
    }
  }catch(err){console.warn('[INFO CHAT ENTITLEMENT AFTER PAYMENT]',err);}
  await _persistPostPaymentProgress_('preferences');
  setTimeout(()=>{closeCheckoutModal();showPostPaymentWelcome();},420);
}

async function requestPlanningStart(){
  if(!validateBaseDatesDMY()) return;

  if(!ITBMO_COMMERCE_CONFIG.commerceEnabled){
    showPreferencesStage();
    return;
  }

  if(paymentGateSatisfiedTripId !== currentTripId && paymentWarningAcceptedTripId !== currentTripId){
    const es=getLang()==='es';
    const confirmed=await showPlannerDecision({
      title:es?'Última revisión antes del pago':'Final review before payment',
      message:es
        ? 'Después de completar el pago, ITBMO generará el itinerario con los viajeros, ciudades, fechas y horarios que acabas de guardar. Esa información no podrá modificarse para este viaje. Si después deseas cambiarla, tendrás que reiniciar y generar un nuevo viaje con un nuevo pago.'
        : 'After payment, ITBMO will generate the itinerary using the travelers, cities, dates and schedules you saved. That information cannot be changed for this trip. To change it later, you will need to reset and generate a new trip with a new payment.',
      cancelLabel:es?'Cancelar y revisar':'Cancel and review',
      confirmLabel:es?'Continuar al pago':'Continue to payment',
      variant:'payment'
    });
    if(!confirmed) return;
    paymentWarningAcceptedTripId=currentTripId;
  }

  const previousLabel=$start?.textContent || '';
  if($start){
    $start.disabled=true;
    $start.textContent=getLang()==='es'?'Preparando pago seguro…':'Preparing secure payment…';
    $start.classList.add('is-busy');
  }

  try{
    const alreadyPaid = await hasValidPaymentForCurrentTrip();
    if(alreadyPaid){
      await _persistPostPaymentProgress_('preferences');
      showPostPaymentWelcome();
      return;
    }
    trackITBMOEvent('checkout_opened',{
      city_count:savedDestinations.length,
      days_total:savedDestinations.reduce((sum,item)=>sum+(Number(item?.days)||0),0),
      payment_provider:'paypal',
      currency:ITBMO_COMMERCE_CONFIG.currency
    });
    openCheckoutModal();
  }finally{
    if($start){
      $start.textContent=previousLabel;
      $start.classList.remove('is-busy');
      if(!$start.dataset.itbmoConsumed) $start.disabled=false;
    }
  }
}

async function loadPayPalSdk(){
  if(window.paypal) return window.paypal;
  if(paypalSdkLoadingPromise) return paypalSdkLoadingPromise;
  if(!ITBMO_COMMERCE_CONFIG.paypal.enabled) return null;

  paypalSdkLoadingPromise = (async()=>{
    const token=getStoredSessionToken();
    const cfg=commerceServerConfig || await paymentApi({action:'config',session_token:token});
    commerceServerConfig=cfg||commerceServerConfig;
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
          promo_redemption_id:activePromoReservation?.redemption_id || null
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
        trackITBMOEvent('payment_approved',{
          payment_provider:'paypal',
          currency:ITBMO_COMMERCE_CONFIG.currency,
          city_count:savedDestinations.length
        });
        await completePaymentGate();
      },
      onCancel:()=>{
        trackITBMOEvent('payment_cancelled',{payment_provider:'paypal'});
        setCheckoutStatus('');
      },
      onError:(err)=>{
        console.error('[PAYPAL]',err);
        trackITBMOEvent('payment_failed',{payment_provider:'paypal',error_stage:'paypal_buttons'});
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
      promo_redemption_id:activePromoReservation?.redemption_id || null,
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
  $supportForm?.addEventListener('submit',contactCustomerSupport);
  $itineraryEmailClose?.addEventListener('click',closeItineraryEmailModal);
  $itineraryEmailForm?.addEventListener('submit',sendItineraryByEmail);
  $checkoutSupportLink?.addEventListener('click',()=>{
    closeCheckoutModal();
    openSupportModal();
  });

  $checkoutClose?.addEventListener('click',closeCheckoutModal);
  $checkoutPromoApply?.addEventListener('click',applyPromotionCode);
  $checkoutPromoInput?.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();applyPromotionCode();}});
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
$preferencesGenerateV2?.addEventListener('click', startV2PaidGeneration);
$send?.addEventListener('click', onSend);

// Chat: textarea crece hasta su máximo; después usa scroll interno.
$chatI?.addEventListener('input', _autoGrowPlanningChatInput_);

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
let infoChatViewportLayoutBound = false;

function applyInfoChatViewportLayout(){
  const modal=qs('#info-chat-modal');
  const messages=qs('#info-chat-messages');
  const input=qs('#info-chat-input');
  const send=qs('#info-chat-send');
  if(!modal || !messages || !input) return;

  const mobile=window.matchMedia('(max-width: 760px)').matches;
  const viewport=window.visualViewport;

  modal.style.display=modal.classList.contains('active') ? 'flex' : modal.style.display;
  modal.style.flexDirection='column';
  modal.style.overflow='hidden';

  messages.style.flex='1 1 auto';
  messages.style.minHeight='0';
  messages.style.overflowY='auto';
  messages.style.overscrollBehavior='contain';
  messages.style.webkitOverflowScrolling='touch';

  input.style.maxHeight=mobile ? '132px' : '220px';
  resizeInfoChatComposer(input);

  /* Keep the input/send row outside the scrolling history. */
  let composer=input.parentElement;
  while(composer && composer!==modal && send && !composer.contains(send)) composer=composer.parentElement;
  if(composer && composer!==modal){
    composer.style.flex='0 0 auto';
    composer.style.position='relative';
    composer.style.zIndex='3';
  }

  if(!mobile){
    if(modal.dataset.mobileViewportLayout==='1'){
      ['left','top','right','bottom','width','height','maxWidth','maxHeight','transform'].forEach(prop=>{
        modal.style[prop]='';
      });
      delete modal.dataset.mobileViewportLayout;
    }
    modal.style.maxHeight='';
    return;
  }

  const width=Math.max(280,Math.floor(viewport?.width || window.innerWidth));
  const height=Math.floor(viewport?.height || window.innerHeight);
  const offsetLeft=Math.floor(viewport?.offsetLeft || 0);
  const offsetTop=Math.floor(viewport?.offsetTop || 0);
  const margin=8;

  modal.dataset.mobileViewportLayout='1';
  modal.style.position='fixed';
  modal.style.left=`${offsetLeft+margin}px`;
  modal.style.top=`${offsetTop+margin}px`;
  modal.style.right='auto';
  modal.style.bottom='auto';
  modal.style.width=`${Math.max(264,width-(margin*2))}px`;
  modal.style.height=`${Math.max(180,height-(margin*2))}px`;
  modal.style.maxWidth=`${Math.max(264,width-(margin*2))}px`;
  modal.style.maxHeight=`${Math.max(180,height-(margin*2))}px`;
  modal.style.transform='none';
}

function bindInfoChatViewportLayout(){
  if(infoChatViewportLayoutBound) return;
  infoChatViewportLayoutBound=true;
  const refresh=()=>{
    const modal=qs('#info-chat-modal');
    if(modal?.classList.contains('active') && !modal.classList.contains('is-minimized')){
      applyInfoChatViewportLayout();
    }
  };
  window.addEventListener('resize',refresh,{passive:true});
  window.addEventListener('orientationchange',refresh,{passive:true});
  window.visualViewport?.addEventListener('resize',refresh,{passive:true});
  window.visualViewport?.addEventListener('scroll',refresh,{passive:true});
  qs('#info-chat-input')?.addEventListener('focus',()=>{
    requestAnimationFrame(()=>{
      applyInfoChatViewportLayout();
      const messages=qs('#info-chat-messages');
      if(messages) messages.scrollTop=messages.scrollHeight;
    });
  },{passive:true});
}

function _infoAllowedCities_(){
  const main=(savedDestinations || []).map(d=>String(d?.city || '').trim()).filter(Boolean);
  const model=plannerState?.travelModelV2 || _currentTravelModelV2_();
  const route=(model?.destinations||[]).flatMap(d=>{
    const out=[String(d?.city||'').trim()];
    (d?.route?.segments||[]).forEach(seg=>{out.push(String(seg?.origin||'').trim(),String(seg?.destination||'').trim());});
    return out;
  }).filter(Boolean);
  return [...new Set([...main,...route])];
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
    ? `<strong>¡Hola! Soy tu asistente de viaje de ITBMO para ${cities}. 🌍</strong><br><br>¿En qué te ayudo ahora? Puedo orientarte sobre zonas para hospedarte, transporte local, barrios, gastronomía, costumbres, seguridad general, fotografía, equipaje, presupuesto orientativo y cómo organizar mejor tus visitas dentro de estas ciudades.`
    : `<strong>Hi! I’m ITBMO’s travel assistant for ${cities}. 🌍</strong><br><br>How can I help? I can guide you on areas to stay, local transportation, neighborhoods, local food, customs, general safety, photography, packing, indicative budgets and how to organize your visits within these cities.`;
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
  if(modal.dataset.mobileViewportLayout==='1'){
    ['left','top','right','bottom','width','height','maxWidth','maxHeight','transform'].forEach(prop=>{
      modal.style[prop]='';
    });
    delete modal.dataset.mobileViewportLayout;
  }
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
  applyInfoChatViewportLayout();
  ensureInfoChatWelcome();
}

function initInfoChatDrag(){
  if(qs('#info-chat-modal')?.classList.contains('is-inline-planner-chat')) return;
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

async function openInfoModal(){
  const modal=qs('#info-chat-modal');
  const trigger=qs('#info-chat-floating');
  if(!modal || !currentTripId) return;

  /* Never bypass entitlement. If the visible control says Info Chat is
     available but the in-memory trip binding became stale after restore,
     revalidate against the existing payment/status API first. */
  const triggerUsable=trigger && !trigger.disabled && trigger.getAttribute('aria-disabled')!=='true';
  if(!triggerUsable || infoChatQueriesRemaining<=0) return;

  if(infoChatAuthorizedTripId !== currentTripId){
    try{
      const token=getStoredSessionToken();
      const status=await paymentApi({action:'status',session_token:token,trip_id:currentTripId});
      applyInfoChatStatus(status);
    }catch(err){
      console.warn('[INFO CHAT OPEN STATUS]',err);
    }
  }

  if(infoChatAuthorizedTripId !== currentTripId || infoChatQueriesRemaining<=0) return;

  installPlannerInlineInfoChat();

  modal.style.display='flex';
  modal.classList.add('active');
  modal.classList.remove('is-minimized');
  document.body.classList.add('itbmo-info-open');

  hideInfoChatNotice();
  ensureInfoChatWelcome();
  bindInfoChatViewportLayout();
  initInfoChatDrag();
  applyInfoChatViewportLayout();

  /* Keep the page where the traveler is; only the floating window opens. */
  requestAnimationFrame(()=>{
    const input=qs('#info-chat-input');
    if(input && !window.matchMedia('(max-width:760px)').matches){
      try{ input.focus({preventScroll:true}); }catch(_){}
    }
  });
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
  if(infoChatRequestInFlight) return;
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
  trackITBMOEvent('info_chat_question',{
    queries_used:infoChatQueriesUsed+1,
    queries_remaining:Math.max(0,infoChatQueriesRemaining-1)
  });
  input.value='';
  resizeInfoChatComposer(input);

  const result = await callInfoAgent(txt);

  if(result?.notice){
    showInfoChatNotice(result.notice.title,result.notice.message);
  }else if(result?.text){
    infoChatMsg(result.text);
  }

  if(result?.notAuthorized){
    setInfoChatEntitlement({
      authorized:false,
      remaining:0,
      used:0,
      tripId:null
    });
    persistInfoChatState();
  }else if(Number.isFinite(Number(result?.remaining))){
    const remaining=Math.max(0,Number(result.remaining));
    setInfoChatEntitlement({
      authorized:true,
      remaining,
      used:INFO_CHAT_MAX_QUERIES-remaining,
      tripId:currentTripId
    });
    persistInfoChatState();
  }

  if(result?.quotaExceeded){
    setInfoChatEntitlement({
      authorized:true,
      remaining:0,
      used:INFO_CHAT_MAX_QUERIES,
      tripId:currentTripId
    });
    persistInfoChatState();
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

function bindNewPlanningListener(){
  $newPlanningButton?.addEventListener('click',(event)=>{
    event.preventDefault();
    trackITBMOEvent('new_planning_started');
    $resetBtn?.click();
  });
}

function enhancePreferencesInfoChatCopy(){
  // V2.4.13: the contextual guidance already lives in the upper Preferences flow.
  // Keep only the useful placeholder here; never render a duplicate footer banner.
  const field=qs('#special-conditions');
  if(!field) return;
  const lang=_plannerOutputLang_();
  field.placeholder=lang==='es'
    ? 'Escribe aquí tus preferencias, restricciones o condiciones especiales…'
    : 'Write your preferences, restrictions or special conditions here…';
  field.addEventListener('input',autoGrowPreferencesField);
  autoGrowPreferencesField();
}

/* =========================================================
   ITBMO CONTEXTUAL GUIDE
   One calm, contextual coach mark at a time. It never advances on a timer.
   The guide disappears as soon as the traveler starts interacting.
========================================================= */
const ASTRA_COACH_STORAGE_KEY='itbmo_astra_coach_v1';
let activeAstraCoach=null;
let astraCoachTimer=null;

function astraCoachCopy(key){
  const es=getLang()==='es';
  const copy={
    account:es
      ? ['Tu punto de partida','Elige cómo continuar: crea una cuenta, inicia sesión o usa ITBMO como invitado. Con cuenta podrás recuperar tu planificación desde otros dispositivos durante el período disponible; como invitado, la recuperación queda vinculada a este dispositivo.']
      : ['Your starting point','Choose how to continue: create an account, sign in, or use ITBMO as a guest. With an account you can recover your planning from other devices during the available period; as a guest, recovery stays linked to this device.'],
    travelers:es
      ? ['¿Quiénes vivirán este viaje?','Indica si viajas solo o acompañado. Las edades y necesidades del grupo ayudan a ITBMO a ajustar ritmos, actividades y desplazamientos.']
      : ['Who will experience this trip?','Tell us whether you are traveling solo or with others. Ages and group needs help ITBMO adjust pacing, activities and transportation.'],
    destinations:es
      ? ['Construye la ruta','Selecciona primero el país y luego escribe tu destino. Puedes elegir una sugerencia de la lista o, si tu destino no aparece, escribirlo igualmente. Agrega hasta tres destinos; el orden en que los ingreses será el orden del viaje.']
      : ['Build your route','Select the country first, then enter your destination. Choose a suggestion from the list or, if your destination does not appear, simply type it anyway. Add up to three destinations; the order you enter them will be the trip order.'],
    date:es
      ? ['Primer día en el destino','Selecciona la fecha en que llegarás al hotel o apartamento y tendrás tiempo disponible. Las siguientes ciudades se sugerirán automáticamente sin permitir fechas imposibles o superpuestas.']
      : ['First day at the destination','Choose the date when you will reach your hotel or apartment and have usable time. Following cities will be suggested automatically without impossible or overlapping dates.'],
    schedule:es
      ? ['Tu tiempo útil, no la hora del vuelo','En el Día 1 indica la hora aproximada en que estarás listo en el alojamiento, después del traslado y el equipaje. En el último día indica hasta cuándo puedes hacer actividades antes de salir al aeropuerto o estación.']
      : ['Usable time, not flight time','For Day 1, enter when you expect to be ready at your lodging after transfer and luggage. For the final day, enter how late you can explore before leaving for the airport or station.'],
    preferences:es
      ? ['Ahora, hazlo verdaderamente tuyo','Añade intereses, ritmo, actividades imperdibles, restricciones o necesidades especiales. Es opcional: puedes continuar sin escribir nada.']
      : ['Now make it truly yours','Add interests, pace, must-do activities, restrictions or special needs. This is optional: you can continue without entering anything.']
  };
  return copy[key] || ['', ''];
}

function astraCoachSeen(){
  try{return JSON.parse(localStorage.getItem(ASTRA_COACH_STORAGE_KEY)||'{}')||{};}catch(_){return {};}
}
function markAstraCoachSeen(key){
  try{
    const seen=astraCoachSeen(); seen[key]=true;
    localStorage.setItem(ASTRA_COACH_STORAGE_KEY,JSON.stringify(seen));
  }catch(_){}
}
function closeAstraCoach({remember=true}={}){
  if(!activeAstraCoach) return;
  const {bubble,key,target,position,interaction}=activeAstraCoach;
  window.removeEventListener('resize',position);
  window.removeEventListener('scroll',position,true);
  target?.removeEventListener('pointerdown',interaction,true);
  target?.removeEventListener('focusin',interaction,true);
  bubble?.classList.remove('is-visible');
  setTimeout(()=>bubble?.remove(),180);
  if(remember) markAstraCoachSeen(key);
  activeAstraCoach=null;
}
function resolveCoachTarget(target){
  try{return typeof target==='function'?target():qs(target);}catch(_){return null;}
}
function showAstraCoach(key,targetRef,{force=false}={}){
  if(!force && astraCoachSeen()[key]) return;
  const target=resolveCoachTarget(targetRef);
  if(!target || target.offsetParent===null) return;
  closeAstraCoach();
  const [title,message]=astraCoachCopy(key);
  const bubble=document.createElement('aside');
  bubble.className='astra-coach';
  bubble.setAttribute('role','status');
  bubble.innerHTML=`
    <div class="astra-coach__avatar">✦</div>
    <div class="astra-coach__content"><small>ITBMO · ${getLang()==='es'?'GUÍA':'GUIDE'}</small><strong></strong><p></p></div>
    <button class="astra-coach__close" type="button" aria-label="${getLang()==='es'?'Ocultar ayuda':'Hide help'}">×</button>`;
  bubble.querySelector('strong').textContent=title;
  bubble.querySelector('p').textContent=message;
  document.body.appendChild(bubble);
  const position=()=>{
    if(!document.body.contains(target)) return closeAstraCoach();
    const rect=target.getBoundingClientRect();
    const b=bubble.getBoundingClientRect();
    const margin=12;
    const below=rect.bottom+b.height+margin<window.innerHeight;
    const top=below?rect.bottom+10:Math.max(margin,rect.top-b.height-10);
    const left=Math.min(Math.max(margin,rect.left),Math.max(margin,window.innerWidth-b.width-margin));
    bubble.style.left=`${left}px`; bubble.style.top=`${top}px`;
    bubble.classList.toggle('is-above',!below);
  };
  const interaction=()=>closeAstraCoach({remember:true});
  activeAstraCoach={bubble,key,target,position,interaction};
  target.addEventListener('pointerdown',interaction,true);
  target.addEventListener('focusin',interaction,true);
  bubble.querySelector('.astra-coach__close')?.addEventListener('click',interaction);
  window.addEventListener('resize',position);
  window.addEventListener('scroll',position,true);
  position();
  requestAnimationFrame(()=>bubble.classList.add('is-visible'));
}
function scheduleAstraCoach(key,target,delay=260,options={}){
  /* Phase 4.2: contextual guidance is permanently embedded in the workspace.
     Bubble coaching is intentionally disabled to reduce interruption and visual noise. */
  return;
}
function initAstraCoach(){
  /* Phase 4.2: inline guidance replaces floating coach bubbles. */
  closeAstraCoach({remember:false});
}


function applyTravelBuilderWorkspaceCopy(){
  const es=getLang()==='es';
  const values=es ? {
    'planner-stage-travelers-label':'Viajeros',
    'planner-stage-route-label':'Ruta',
    'planner-stage-personalize-label':'Personaliza',
    'planner-stage-create-label':'Crear',
    'planner-account-guide-title':'Tu acceso a ITBMO',
    'planner-account-guide-copy':'Inicia sesión, crea una cuenta o continúa como invitado. Con una cuenta podrás volver a tus viajes desde otros dispositivos.',
    'planner-route-eyebrow':'CONSTRUYE TU RUTA',
    'planner-route-guide':'Agrega hasta 3 destinos principales. No importa el orden en que los ingreses: ITBMO organizará la ruta según las fechas. Dentro de cada destino puedes añadir traslados, paradas o estancias si ya los tienes definidos.',
    'planner-route-tip-copy':'Empieza simple y añade detalle solo cuando lo necesites. Si no agregas traslados o paradas, ITBMO seguirá recomendando excursiones de un día como lo hace hoy. Si ya tienes movimientos definidos, agrégalos para que respetemos esas horas y lugares.',
    'planner-travelers-eyebrow':'QUIÉN VIAJA',
    'planner-travelers-guide':'Indica si viajas solo o acompañado. Las edades del grupo ayudan a ajustar ritmos, actividades y desplazamientos.',
    'planner-save-eyebrow':'CUANDO TU RUTA ESTÉ LISTA',
    'planner-save-title':'Confirma la ruta para personalizar el viaje.',
    'planner-create-eyebrow':'LISTO PARA CREAR',
    'planner-create-title':'Tu viaje toma forma aquí.',
    'planner-create-copy':'Cuando completes la ruta y la personalización, ITBMO organizará el itinerario ciudad por ciudad y día por día.',
    'planner-create-status-copy':'Completa los pasos anteriores para comenzar.',
    'planner-info-chat-kicker':'INVESTIGA ANTES DE DECIDIR',
    'planner-info-chat-title':'¿Te falta contexto sobre tu destino?',
    'planner-info-chat-copy':'Usa Info Chat para consultar zonas, transporte, barrios, gastronomía y otros datos útiles antes de definir tus preferencias.'
  } : {
    'planner-stage-travelers-label':'Travelers',
    'planner-stage-route-label':'Route',
    'planner-stage-personalize-label':'Personalize',
    'planner-stage-create-label':'Create',
    'planner-account-guide-title':'Your ITBMO access',
    'planner-account-guide-copy':'Sign in, create an account, or continue as a guest. With an account you can return to your trips from other devices.',
    'planner-route-eyebrow':'BUILD YOUR ROUTE',
    'planner-route-guide':'Add up to 3 main destinations. The entry order does not matter: ITBMO will organize the route by date. Within each destination you can add transfers, stops or overnight stays when you already know them.',
    'planner-route-tip-copy':'Start simple and add detail only when you need it. If you add no transfers or stops, ITBMO will keep recommending round-trip day excursions as it does today. If you already have fixed movements, add them so we can respect those times and places.',
    'planner-travelers-eyebrow':'WHO IS TRAVELING',
    'planner-travelers-guide':'Tell us whether you are traveling solo or with others. Group ages help adjust pace, activities, and transportation.',
    'planner-save-eyebrow':'WHEN YOUR ROUTE IS READY',
    'planner-save-title':'Confirm the route to personalize your trip.',
    'planner-create-eyebrow':'READY TO CREATE',
    'planner-create-title':'Your trip takes shape here.',
    'planner-create-copy':'Once the route and personalization are complete, ITBMO will organize your itinerary city by city and day by day.',
    'planner-create-status-copy':'Complete the previous steps to begin.',
    'planner-info-chat-kicker':'RESEARCH BEFORE YOU DECIDE',
    'planner-info-chat-title':'Need more context about your destination?',
    'planner-info-chat-copy':'Use Info Chat to ask about areas, transportation, neighborhoods, food and other useful details before defining your preferences.'
  };
  Object.entries(values).forEach(([id,value])=>{
    const el=qs('#'+id);
    if(!el) return;
    if(id==='planner-route-tip-copy'){
      el.innerHTML=es
        ? '<strong>Usa tu tiempo útil, no la hora del vuelo.</strong> En el primer día indica cuándo estarás listo después de llegar al alojamiento; en el último, hasta qué hora puedes hacer actividades antes de salir.'
        : '<strong>Use your useful travel time, not your flight time.</strong> On day one, enter when you expect to be ready after reaching your lodging; on the last day, enter how late you can explore before leaving.';
    }else el.textContent=value;
  });
}

function updateTravelBuilderProgress(){
  const items=qsa('.planner-stage-nav__item');
  if(!items.length) return;
  const hasRoute=qsa('#city-list .city-row').some(row=>{
    return Boolean(qs('.country',row)?.value?.trim() && qs('.city',row)?.value?.trim() && qs('.days',row)?.value && qs('.baseDate',row)?.value);
  });
  const hasTravelers=Boolean(qs('#traveler-mode')?.value);
  const preferencesVisible=qs('#preferences-stage')?.getAttribute('aria-hidden')==='false' || !qs('#preferences-stage')?.classList.contains('is-stage-hidden');
  const canCreate=!qs('#start-planning')?.disabled;

  items.forEach((item,index)=>{
    const active =
      index===0 ? true :
      index===1 ? hasTravelers :
      index===2 ? preferencesVisible :
      canCreate;
    item.classList.toggle('is-active',active);
  });

  const status=qs('#planner-create-status-copy');
  const dot=qs('.planner-create-status__dot');
  if(status){
    if(canCreate) status.textContent=getLang()==='es'?'Todo listo. Puedes iniciar la planificación.':'Everything is ready. You can start planning.';
    else if(preferencesVisible) status.textContent=getLang()==='es'?'Personaliza tu viaje o continúa sin agregar información.':'Personalize your trip or continue without adding information.';
    else if(hasRoute && hasTravelers) status.textContent=getLang()==='es'?'Guarda tu ruta para continuar.':'Save your route to continue.';
    else status.textContent=getLang()==='es'?'Completa ruta y viajeros para continuar.':'Complete route and travelers to continue.';
  }
  if(dot){
    dot.style.background=canCreate?'#0ea47a':'#d0d5dd';
    dot.style.boxShadow=canCreate?'0 0 0 5px rgba(14,164,122,.16)':'0 0 0 5px rgba(208,213,221,.22)';
  }
}

function bindTravelBuilderProgress(){
  const root=qs('#planner-grid');
  if(!root) return;
  root.addEventListener('input',()=>requestAnimationFrame(updateTravelBuilderProgress),true);
  root.addEventListener('change',()=>requestAnimationFrame(updateTravelBuilderProgress),true);
  root.addEventListener('click',()=>setTimeout(updateTravelBuilderProgress,0),true);
  const observer=new MutationObserver(()=>requestAnimationFrame(updateTravelBuilderProgress));
  observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','class','aria-hidden']});
  applyTravelBuilderWorkspaceCopy();
  updateTravelBuilderProgress();
}



/* =========================================================
   ITBMO V2.8.1 · TRIP STORY EDITOR / CONTINUOUS JOURNEY
   Canonical narrative capture with stable IDs, editable dates, deterministic
   downstream recalculation, reordering, validation and Physical Timeline bridge.
========================================================= */
function _tripStoryEsc_(v=''){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
function _tripStoryId_(prefix='node'){try{return `${prefix}_${crypto.randomUUID()}`;}catch(_){return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;}}
function _tripStoryAddDays_(iso,n){const d=new Date(`${iso}T12:00:00`);if(Number.isNaN(d.getTime()))return'';d.setDate(d.getDate()+Number(n||0));return d.toISOString().slice(0,10);}
function _tripStoryDiffDays_(a,b){const x=new Date(`${a}T12:00:00`),y=new Date(`${b}T12:00:00`);if(Number.isNaN(x.getTime())||Number.isNaN(y.getTime()))return 0;return Math.round((y-x)/86400000);}
function _tripStoryDMY_(iso=''){const m=String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${m[3]}/${m[2]}/${m[1]}`:'';}
function _tripStoryTimeMinutes_(v=''){const m=String(v).match(/^(\d{2}):(\d{2})$/);return m?Number(m[1])*60+Number(m[2]):null;}
function _tripStoryClampArrivalStart_(st){if(!st?.arrivalTime||!st?.perDay?.[0])return;const a=_tripStoryTimeMinutes_(st.arrivalTime),cur=_tripStoryTimeMinutes_(st.perDay[0].start);if(a!=null&&(cur==null||cur<a))st.perDay[0].start=st.arrivalTime;}
function _tripStoryTransportOptions_(selected=''){const es=getLang()==='es';return [['',es?'Que ITBMO lo resuelva':'Let ITBMO resolve it'],['plane',es?'Avión':'Plane'],['train',es?'Tren':'Train'],['bus','Bus'],['car',es?'Automóvil':'Car'],['ferry','Ferry'],['transfer','Transfer'],['other',es?'Otro':'Other']].map(([v,l])=>`<option value="${v}" ${v===selected?'selected':''}>${l}</option>`).join('');}
function _tripStoryTimeOptions_(selected='',allowBlank=true){const es=getLang()==='es';let out=allowBlank?`<option value="">${es?'Aún no lo sé':'Not sure yet'}</option>`:'';for(let h=0;h<24;h++)for(const m of [0,30]){const v=`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;out+=`<option value="${v}" ${v===selected?'selected':''}>${v}</option>`;}return out;}
function _tripStoryRequiredTimeOptions_(selected=''){const es=getLang()==='es';return _tripStoryTimeOptions_(selected,true).replace(es?'Aún no lo sé':'Not sure yet',es?'Selecciona una hora':'Select a time');}
function _tripStoryTimeStatusOptions_(selected='estimated'){const es=getLang()==='es';return [['confirmed',es?'Confirmado · ya tengo el horario':'Confirmed · I have the schedule'],['estimated',es?'Estimado · podré ajustarlo después':'Estimated · I can update it later']].map(([v,l])=>`<option value="${v}" ${v===selected?'selected':''}>${l}</option>`).join('');}
function _tripStoryDaysOptions_(selected=1){return Array.from({length:30},(_,i)=>`<option value="${i+1}" ${Number(selected)===i+1?'selected':''}>${i+1}</option>`).join('');}
function _tripStoryCurrent_(){return _travelV2()?.state?.tripStory || {schema_version:6,start:{date:'',transportMode:'plane',origin:{label:'',type:'city'},arrival:{label:'',type:'city'},departureTime:'',arrivalDate:'',arrivalTime:'',timeStatus:'estimated'},stays:[],returnTrip:{enabled:false,transportMode:'plane',origin:{label:'',type:'city'},arrival:{label:'',type:'city'},departureDate:'',departureTime:'',arrivalDate:'',arrivalTime:'',timeStatus:'estimated'},ended:false};}
function _tripStoryDraftKey_(){const who=String(currentUser?.id||currentUser?.email||'guest').replace(/[^a-z0-9_.@-]/gi,'_');return `itbmo_trip_story_draft_v1_${who}`;}
function _tripStoryLoadDraft_(){try{const raw=sessionStorage.getItem(_tripStoryDraftKey_());return raw?JSON.parse(raw):null;}catch(_){return null;}}
function _tripStorySaveDraft_(story){try{sessionStorage.setItem(_tripStoryDraftKey_(),JSON.stringify(story));}catch(_){}}
function _tripStoryClearDraft_(){try{sessionStorage.removeItem(_tripStoryDraftKey_());}catch(_){}}
function _tripStoryClampDepartureEnd_(prev,departureTime){if(!prev?.perDay?.length||!departureTime)return;const last=prev.perDay[prev.perDay.length-1],dep=_tripStoryTimeMinutes_(departureTime),cur=_tripStoryTimeMinutes_(last.end);if(dep!=null&&(cur==null||cur>dep))last.end=departureTime;}
function _tripStoryApplyBoundaryHours_(story){const stays=story?.stays||[];if(!stays.length)return story;const first=stays[0],last=stays.at(-1);if(story.start?.arrivalTime&&(!story.start.arrivalDate||story.start.arrivalDate===first.startDate)){_tripStoryClampArrivalStart_(Object.assign(first,{arrivalTime:story.start.arrivalTime}));}for(let i=1;i<stays.length;i++){const st=stays[i],prev=stays[i-1],prevEnd=_tripStoryStayEnd_(prev);if(st.arrivalTime&&(!st.arrivalDate||st.arrivalDate===st.startDate))_tripStoryClampArrivalStart_(st);if(st.departureTime&&st.departureDate===prevEnd)_tripStoryClampDepartureEnd_(prev,st.departureTime);}if(story.returnTrip?.enabled&&story.returnTrip?.departureTime&&(!story.returnTrip.departureDate||story.returnTrip.departureDate===_tripStoryStayEnd_(last)))_tripStoryClampDepartureEnd_(last,story.returnTrip.departureTime);return story;}
function _tripStoryDefaultHours_(dayIndex,st){return {day:dayIndex+1,start:(st?.perDay?.[dayIndex]?.start||DEFAULT_START||''),end:(st?.perDay?.[dayIndex]?.end||DEFAULT_END||'')};}
function _tripStoryEnsureDayTrip_(dt={}){dt.id=dt.id||_tripStoryId_('daytrip');dt.day=Math.max(1,Number(dt.day||1));dt.countryCode=dt.countryCode||'';dt.country=dt.country||'';dt.place=dt.place||'';dt.outbound=dt.outbound||{};dt.return=dt.return||{};dt.outbound.transportMode=dt.outbound.transportMode||dt.transportMode||'';dt.outbound.routeResolution=dt.outbound.routeResolution||null;dt.outbound.departureTime=dt.outbound.departureTime||dt.departureTime||'';dt.outbound.arrivalTime=dt.outbound.arrivalTime||dt.arrivalTime||'';dt.outbound.timeStatus=dt.outbound.timeStatus||dt.timeStatus||'estimated';dt.return.transportMode=dt.return.transportMode||dt.returnTransportMode||dt.outbound.transportMode||'';dt.return.routeResolution=dt.return.routeResolution||null;dt.return.departureTime=dt.return.departureTime||dt.returnDepartureTime||'';dt.return.arrivalTime=dt.return.arrivalTime||dt.returnArrivalTime||'';dt.return.timeStatus=dt.return.timeStatus||dt.timeStatus||'estimated';return dt;}
function _tripStoryEnsureStay_(st={}){st.id=st.id||_tripStoryId_('stay');st.countryCode=st.countryCode||'';st.country=st.country||'';st.place=st.place||'';st.days=Math.max(1,Number(st.days||1));st.startDate=st.startDate||'';st.transportMode=st.transportMode||'';st.transportStatus=st.transportStatus||((st.transportMode||st.arrivalTime)?'user_defined':'route_to_resolve');st.routeResolution=st.routeResolution||null;st.departureDate=st.departureDate||'';st.departureTime=st.departureTime||'';st.arrivalDate=st.arrivalDate||st.startDate||'';st.arrivalTime=st.arrivalTime||'';st.timeStatus=st.timeStatus||'estimated';st.dayTrips=(Array.isArray(st.dayTrips)?st.dayTrips:[]).map(_tripStoryEnsureDayTrip_);const old=Array.isArray(st.perDay)?st.perDay:[];st.perDay=Array.from({length:st.days},(_,i)=>({day:i+1,start:old[i]?.start||DEFAULT_START||'',end:old[i]?.end||DEFAULT_END||''}));return st;}
function _tripStoryCountryFromCode_(code=''){return _countryOptions_().find(x=>x.code===code)||null;}
function _tripStoryCountryMatchLabel_(label=''){const n=_normalizeSearch_(label);return _countryOptions_().find(x=>_normalizeSearch_(x.label)===n||_normalizeSearch_(x.apiName||'')===n)||null;}
function _tripStoryDayDate_(st,index){return st?.startDate?_tripStoryAddDays_(st.startDate,index):'';}
function _tripStoryCountrySuggestions_(q=''){const n=_normalizeSearch_(q);if(n.length<2)return[];return _countryOptions_().filter(x=>_normalizeSearch_(x.label).includes(n)||_normalizeSearch_(x.apiName||'').includes(n)).slice(0,10);}
function _tripStoryStayEnd_(st){return st?.startDate?_tripStoryAddDays_(st.startDate,Math.max(0,Number(st.days||1)-1)):'';}
function _tripStoryRecalculateFrom_(story,index=0,{preserveAnchor=true}={}){story.stays=(story.stays||[]).map(_tripStoryEnsureStay_);for(let i=Math.max(0,index);i<story.stays.length;i++){const st=story.stays[i],prev=story.stays[i-1];if(i>0){const suggested=prev?.startDate?_tripStoryAddDays_(prev.startDate,Number(prev.days||1)):'';if(!preserveAnchor||i>index||!st.startDate)st.startDate=suggested;if(!st.arrivalDate&&st.arrivalTime)st.arrivalDate=st.startDate||'';if(!st.departureDate&&prev?.startDate)st.departureDate=st.startDate||_tripStoryStayEnd_(prev);}st.sequence=i+1;st.dayTrips.forEach(dt=>{dt.day=Math.min(st.days,Math.max(1,Number(dt.day||1)));});}return story;}
function _tripStoryCopyText_(story){const es=getLang()==='es',lines=[es?'Mi recorrido ITBMO':'My ITBMO journey'];if(story.start?.origin?.label||story.start?.arrival?.label){lines.push('',`${story.start.origin?.label||'—'} → ${story.start.arrival?.label||'—'}${story.start.date?` · ${_tripStoryDMY_(story.start.date)}`:''}`);}story.stays.forEach((st,i)=>{if(i>0)lines.push(`${story.stays[i-1].place} → ${st.place}${st.departureDate?` · ${_tripStoryDMY_(st.departureDate)}`:''}${st.departureTime?` · ${st.departureTime}`:''}${st.arrivalTime?`–${st.arrivalTime}`:''}`);lines.push(`${st.place} · ${_tripStoryDMY_(st.startDate)}${_tripStoryStayEnd_(st)!==st.startDate?`–${_tripStoryDMY_(_tripStoryStayEnd_(st))}`:''} · ${st.days} ${st.days===1?(es?'día':'day'):(es?'días':'days')}`);st.dayTrips.forEach(dt=>lines.push(`  ↳ ${dt.place} · ${es?'excursión Día':'day trip Day'} ${dt.day}${dt.outbound.departureTime?` · ${dt.outbound.departureTime}`:''}${dt.return.arrivalTime?`–${dt.return.arrivalTime}`:''}`));});if(story.returnTrip?.enabled)lines.push('',`${es?'Regreso':'Return'}: ${story.returnTrip.origin?.label||story.stays.at(-1)?.place||'—'} → ${story.returnTrip.arrival?.label||'—'}${story.returnTrip.departureDate?` · ${_tripStoryDMY_(story.returnTrip.departureDate)}`:''}`);return lines.join('\n');}
function renderTripStorySummary(){const host=qs('#trip-story-summary');if(!host)return;const story=_tripStoryCurrent_(),stays=story.stays||[];if(!stays.length){host.hidden=true;return;}host.hidden=false;const es=getLang()==='es',nodes=stays.map((x,i)=>`<div class="trip-story-summary-stop"><span>${String(i+1).padStart(2,'0')}</span><div><b>${_tripStoryEsc_(x.place)}</b><small>${_tripStoryDMY_(x.startDate)}${_tripStoryStayEnd_(x)!==x.startDate?` → ${_tripStoryDMY_(_tripStoryStayEnd_(x))}`:''} · ${x.days} ${x.days===1?(es?'día':'day'):(es?'días':'days')}</small>${x.dayTrips?.length?`<em>✦ ${x.dayTrips.map(d=>_tripStoryEsc_(d.place)).join(' · ')}</em>`:''}</div></div>`).join('<div class="trip-story-summary-arrow">→</div>');host.innerHTML=`<div class="trip-story-summary__head"><div><small>✦ ${es?'TU RECORRIDO':'YOUR JOURNEY'}</small><strong>${es?'Tu historia está guardada y puedes cambiarla cuando quieras':'Your story is saved and can be changed anytime'}</strong></div><div class="trip-story-summary-actions"><button type="button" id="copy-trip-story">${es?'Copiar recorrido':'Copy journey'}</button><button type="button" id="edit-trip-story" class="is-primary">${es?'Editar mi viaje':'Edit my trip'}</button></div></div><div class="trip-story-summary-flow">${nodes}</div>`;const postPaymentLocked=Boolean(currentTripId&&paymentGateSatisfiedTripId===currentTripId);const editBtn=qs('#edit-trip-story');if(editBtn){editBtn.disabled=postPaymentLocked;editBtn.setAttribute('aria-disabled',String(postPaymentLocked));if(!postPaymentLocked)editBtn.addEventListener('click',openTripStoryBuilder);}host.classList.toggle('is-payment-locked',postPaymentLocked);qs('#copy-trip-story')?.addEventListener('click',async()=>{const txt=_tripStoryCopyText_(story);try{await navigator.clipboard.writeText(txt);const b=qs('#copy-trip-story');if(b){const old=b.textContent;b.textContent=es?'✓ Copiado':'✓ Copied';setTimeout(()=>b.textContent=old,1600);}}catch(_){prompt(es?'Copia tu recorrido:':'Copy your journey:',txt);}});}
async function _tripStorySuggestions_(countryCode,query){const match=_tripStoryCountryFromCode_(countryCode),q=String(query||'').trim();if(!match||q.length<3)return[];const key=`story|${match.code}|${_normalizeSearch_(q)}`;if(destinationSuggestionCache.has(key))return destinationSuggestionCache.get(key);try{const url=`${ITBMO_DESTINATION_SUGGESTIONS_URL}?country=${encodeURIComponent(match.apiName)}&countryCode=${encodeURIComponent(match.code)}&lang=${encodeURIComponent(getLang())}&q=${encodeURIComponent(q)}`;const r=await fetch(url,{headers:{Accept:'application/json'}}),d=await r.json().catch(()=>({}));const a=r.ok&&Array.isArray(d?.suggestions)?d.suggestions:[];destinationSuggestionCache.set(key,a);return a;}catch(_){return[];}}
function _tripStoryValidate_(story){const es=getLang()==='es',issues=[],add=(code,title,message,stayIndex=null)=>issues.push({code,title,message,stayIndex});if(!story.stays.length){add('NO_STAYS',es?'Falta tu primer destino':'Your first destination is missing',es?'Agrega al menos una estancia para construir el recorrido.':'Add at least one stay.');return issues;}story.stays.forEach((st,i)=>{if(!st.countryCode)add('COUNTRY',st.place||`${es?'Destino':'Destination'} ${i+1}`,es?'Selecciona un país válido de la lista.':'Select a valid country from the list.',i);if(!String(st.place||'').trim())add('PLACE',`${es?'Destino':'Destination'} ${i+1}`,es?'Escribe el destino de esta estancia.':'Enter this stay destination.',i);if(!st.startDate)add('DATE',st.place||`${es?'Destino':'Destination'} ${i+1}`,es?'Selecciona el primer día que quieres planificar.':'Select the first day to plan.',i);st.perDay.forEach((d,j)=>{if(d.start&&d.end&&d.start>=d.end)add('DAY_HOURS',`${st.place} · ${es?'Día':'Day'} ${j+1}`,es?`La hora de inicio (${d.start}) debe ser anterior a la hora final (${d.end}).`:`Start time (${d.start}) must be before end time (${d.end}).`,i);});st.dayTrips.forEach(dt=>{if(!String(dt.place||'').trim())add('DAYTRIP_PLACE',`${st.place} · ${es?'Día':'Day'} ${dt.day}`,es?'Completa el destino de la excursión.':'Complete the day-trip destination.',i);const o=dt.outbound,r=dt.return;if(o.departureTime&&o.arrivalTime&&o.departureTime>=o.arrivalTime)add('DAYTRIP_OUT',dt.place,es?'En la ida, la llegada debe ser posterior a la salida.':'Outbound arrival must be after departure.',i);if(r.departureTime&&r.arrivalTime&&r.departureTime>=r.arrivalTime)add('DAYTRIP_RETURN',dt.place,es?'En el regreso, la llegada debe ser posterior a la salida.':'Return arrival must be after departure.',i);if(o.arrivalTime&&r.departureTime&&o.arrivalTime>=r.departureTime)add('DAYTRIP_WINDOW',dt.place,es?'La hora de regreso debe ser posterior a la llegada de ida.':'Return departure must be after outbound arrival.',i);});if(i>0){const prev=story.stays[i-1],prevEnd=_tripStoryStayEnd_(prev),dep=st.departureDate||st.startDate,arr=st.arrivalDate||st.startDate;if(dep&&prevEnd&&dep<prevEnd)add('MOVE_CUTS_STAY',`${prev.place} → ${st.place}`,es?`El traslado sale el ${_tripStoryDMY_(dep)}, pero ${prev.place} todavía tiene días declarados hasta ${_tripStoryDMY_(prevEnd)}. Reduce la estancia o mueve el traslado al último día.`:`The transfer leaves on ${_tripStoryDMY_(dep)}, but ${prev.place} is declared through ${_tripStoryDMY_(prevEnd)}. Shorten the stay or move the transfer to its last day.`,i);const sameDayTrips=(prev.dayTrips||[]).filter(dt=>_tripStoryAddDays_(prev.startDate,dt.day-1)===dep);sameDayTrips.forEach(dt=>{if(st.departureTime&&dt.return?.arrivalTime&&dt.return.arrivalTime>st.departureTime)add('DAYTRIP_TRANSFER_OVERLAP',`${dt.place} / ${prev.place} → ${st.place}`,es?`La excursión regresa a las ${dt.return.arrivalTime}, pero el traslado al siguiente destino sale a las ${st.departureTime}.`:`The day trip returns at ${dt.return.arrivalTime}, but the next transfer leaves at ${st.departureTime}.`,i-1);});if(dep&&prev.startDate&&dep<prev.startDate)add('MOVE_BEFORE',`${prev.place} → ${st.place}`,es?'El traslado sale antes de que comience la estancia anterior.':'The transfer leaves before the previous stay begins.',i);if(arr&&dep&&arr<dep)add('MOVE_DATE',`${prev.place} → ${st.place}`,es?'La fecha de llegada es anterior a la fecha de salida.':'Arrival date is before departure date.',i);if(dep===arr&&st.departureTime&&st.arrivalTime&&st.departureTime>=st.arrivalTime)add('MOVE_TIME',`${prev.place} → ${st.place}`,es?'La hora de llegada debe ser posterior a la hora de salida.':'Arrival time must be after departure time.',i);if(st.startDate&&arr&&st.startDate<arr)add('STAY_BEFORE_ARRIVAL',st.place,es?'La estancia comienza antes de que llegues físicamente al destino.':'The stay starts before you physically arrive.',i);if(prevEnd&&dep&&dep>_tripStoryAddDays_(prevEnd,1))add('GAP',`${prev.place} → ${st.place}`,es?'Hay días sin ubicación definida entre ambas estancias. Ajusta las fechas o agrega el destino intermedio.':'There are undefined days between these stays. Adjust dates or add the intermediate destination.',i);}});if(!story.ended)add('NOT_ENDED',es?'Confirma el final de tu recorrido':'Confirm where your journey ends',es?'Marca “Sí, aquí termina mi recorrido” o agrega el siguiente destino.':'Choose “Yes, my journey ends here” or add the next destination.');return issues;}
function _tripStoryRequiredTimeIssues_(story){
  const es=getLang()==='es',issues=[];
  const add=(title,message,stayIndex=null)=>issues.push({code:'REQUIRED_MOVEMENT_CORE',title,message,stayIndex});
  (story?.stays||[]).forEach((st,i)=>{
    if(i>0){
      if(!st.departureDate) add(`${story.stays[i-1]?.place||''} → ${st.place||''}`,es?'Indica qué día iniciarás este traslado. Puede ser el último día del destino anterior, el primer día del siguiente o una fecha posterior si el recorrido lo requiere.':'Choose the date when this transfer starts. It may be the previous destination’s last day, the next destination’s first day, or later when the route requires it.',i);
      if(!st.departureTime) add(`${story.stays[i-1]?.place||''} → ${st.place||''}`,es?'Indica a partir de qué hora puedes salir. El medio de transporte y la llegada pueden quedar en blanco para que ITBMO los resuelva.':'Tell us from what time you can leave. Transport and arrival may stay blank so ITBMO can resolve them.',i);
    }
    (st.dayTrips||[]).forEach(dt=>{if(!String(dt.place||'').trim())return; /* destination + day are essential; times may be resolved */});
  });
  return issues;
}
const _tripStoryValidateCore_=_tripStoryValidate_;
_tripStoryValidate_=function(story){return [..._tripStoryRequiredTimeIssues_(story),..._tripStoryValidateCore_(story)];};
function _tripStoryShowIssues_(issues,onFix){const es=getLang()==='es',ov=document.createElement('div');ov.className='trip-story-validation-overlay';ov.innerHTML=`<div class="trip-story-validation"><div class="trip-story-validation-icon">!</div><h3>${es?`Hay ${issues.length} ${issues.length===1?'detalle':'detalles'} por ajustar`:`${issues.length} ${issues.length===1?'detail needs':'details need'} attention`}</h3><p>${es?'Tu historia no se perderá. Corrige estos puntos y vuelve a guardar.':'Your story is safe. Fix these points and save again.'}</p><div class="trip-story-validation-list">${issues.map((x,i)=>`<button type="button" data-issue="${i}"><span>${i+1}</span><div><b>${_tripStoryEsc_(x.title)}</b><small>${_tripStoryEsc_(x.message)}</small></div><em>${es?'Corregir':'Fix'} →</em></button>`).join('')}</div><button type="button" class="trip-story-validation-close">${es?'Seguir editando':'Keep editing'}</button></div>`;document.body.appendChild(ov);ov.querySelector('.trip-story-validation-close').onclick=()=>ov.remove();ov.querySelectorAll('[data-issue]').forEach(b=>b.onclick=()=>{const issue=issues[Number(b.dataset.issue)];ov.remove();onFix?.(issue);});}
function _tripStoryResetInboundMovement_(st){
  if(!st)return;
  st.transportMode='';
  st.transportStatus='route_to_resolve';
  st.routeResolution=null;
  st.departureDate=st.startDate||'';
  st.departureTime='';
  st.arrivalDate=st.startDate||'';
  st.arrivalTime='';
  st.timeStatus='estimated';
}
function _tripStoryInvalidateStayDerived_(st){
  if(!st)return;
  st.routeResolution=null;
  (st.dayTrips||[]).forEach(dt=>{
    _tripStoryEnsureDayTrip_(dt);
    dt.outbound.routeResolution=null;
    dt.return.routeResolution=null;
    dt.routeResolution=null;
    // Times that ITBMO resolved are derived. If the traveler supplied a complete
    // schedule, preserve it; otherwise force a clean round-trip resolution.
    const userDefined=Boolean(!dt.routeResolution&&dt.outbound.transportMode&&dt.outbound.departureTime&&dt.return.departureTime);
    if(!userDefined){
      dt.outbound.transportMode='';dt.outbound.departureTime='';dt.outbound.arrivalTime='';
      dt.return.transportMode='';dt.return.departureTime='';dt.return.arrivalTime='';
    }
  });
}
function _tripStoryRemoveStay_(story,index){
  if(!story||!Array.isArray(story.stays)||index<0||index>=story.stays.length)return false;
  const oldLastId=story.stays.at(-1)?.id||'';
  story.stays.splice(index,1);
  if(!story.stays.length){
    story.stays=[_tripStoryEnsureStay_({days:1})];
    story.returnTrip={enabled:false,transportMode:'',origin:{label:'',type:'city'},arrival:{label:'',type:'city'},departureDate:'',departureTime:'',arrivalDate:'',arrivalTime:'',timeStatus:'estimated'};
    story.ended=false;
    return true;
  }
  story.stays.forEach((st,i)=>{st.sequence=i+1;});
  // Only the connection whose predecessor changed becomes invalid. Downstream
  // connections retain their traveler-entered facts because their endpoints did not change.
  if(index>0 && story.stays[index]) _tripStoryResetInboundMovement_(story.stays[index]);
  if(index===0 && story.start?.enabled){
    story.start.arrival={label:story.stays[0].place||'',type:'city'};
    story.start.arrivalDate=story.stays[0].startDate||'';
    story.start.arrivalTime='';
  }
  if(story.returnTrip?.enabled){
    if(oldLastId!==(story.stays.at(-1)?.id||''))_tripStoryResetReturnMovement_(story);
    else{story.returnTrip.origin={label:story.stays.at(-1)?.place||'',type:'city'};story.returnTrip.routeResolution=null;}
  }
  return true;
}
function _tripStoryMovementEdgeKey_(fromStay,toStay){return `${fromStay?.id||''}>${toStay?.id||''}`;}
function _tripStoryResetReturnMovement_(story){
  if(!story?.returnTrip)return;
  story.returnTrip.origin={label:story.stays?.at(-1)?.place||'',type:'city'};
  story.returnTrip.transportMode='';story.returnTrip.departureDate='';story.returnTrip.departureTime='';
  story.returnTrip.arrivalDate='';story.returnTrip.arrivalTime='';story.returnTrip.timeStatus='estimated';story.returnTrip.routeResolution=null;
}
function _tripStorySyncBoundaryAfterStayEdit_(story,index,{identityChanged=false,dateChanged=false}={}){
  const st=story?.stays?.[index];if(!st)return;
  if(index===0&&story.start?.enabled){
    story.start.arrival={label:st.place||'',type:'city'};story.start.arrivalDate=st.startDate||'';
    if(identityChanged||dateChanged){story.start.arrivalTime='';story.start.routeResolution=null;}
  }
  if(index===story.stays.length-1&&story.returnTrip?.enabled){
    if(identityChanged||dateChanged)_tripStoryResetReturnMovement_(story);
    else{story.returnTrip.origin={label:st.place||'',type:'city'};story.returnTrip.routeResolution=null;}
  }
}
function _tripStoryMoveStay_(story,from,to){
  if(!story||!Array.isArray(story.stays)||from<0||to<0||from>=story.stays.length||to>=story.stays.length||from===to)return false;
  const oldFirst=story.stays[0]?.id||'',oldLast=story.stays.at(-1)?.id||'';
  const oldEdges=new Map();for(let i=1;i<story.stays.length;i++)oldEdges.set(_tripStoryMovementEdgeKey_(story.stays[i-1],story.stays[i]),JSON.parse(JSON.stringify(story.stays[i])));
  const [moved]=story.stays.splice(from,1);story.stays.splice(to,0,moved);
  story.stays.forEach((st,i)=>{
    st.sequence=i+1;if(i===0)return;
    const prior=oldEdges.get(_tripStoryMovementEdgeKey_(story.stays[i-1],st));
    if(prior){st.transportMode=prior.transportMode||'';st.transportStatus=prior.transportStatus||'route_to_resolve';st.routeResolution=prior.routeResolution||null;st.departureDate=prior.departureDate||'';st.departureTime=prior.departureTime||'';st.arrivalDate=prior.arrivalDate||st.startDate||'';st.arrivalTime=prior.arrivalTime||'';st.timeStatus=prior.timeStatus||'estimated';}
    else _tripStoryResetInboundMovement_(st);
  });
  const newFirst=story.stays[0]?.id||'',newLast=story.stays.at(-1)?.id||'';
  if(story.start?.enabled){story.start.arrival={label:story.stays[0]?.place||'',type:'city'};story.start.arrivalDate=story.stays[0]?.startDate||'';if(oldFirst!==newFirst){story.start.arrivalTime='';story.start.routeResolution=null;}}
  if(story.returnTrip?.enabled){if(oldLast!==newLast)_tripStoryResetReturnMovement_(story);else{story.returnTrip.origin={label:story.stays.at(-1)?.place||'',type:'city'};story.returnTrip.routeResolution=null;}}
  return true;
}
function _tripStoryResetRoute_(story){
  const clean=_tripStoryCurrent_();
  story.start={...clean.start,enabled:false,origin:{label:'',type:'city'},arrival:{label:'',type:'city'}};
  story.stays=[_tripStoryEnsureStay_({days:1})];
  story.returnTrip={...clean.returnTrip,enabled:false,origin:{label:'',type:'city'},arrival:{label:'',type:'city'}};
  story.ended=false;
  return story;
}
function openTripStoryBuilder(){
  if(currentTripId && paymentGateSatisfiedTripId===currentTripId) return;
  const es=getLang()==='es';
  const engine=_travelV2();
  let story=JSON.parse(JSON.stringify(_tripStoryLoadDraft_() || _tripStoryCurrent_()));
  story.start=story.start||{date:'',transportMode:'',origin:{label:'',type:'city'},arrival:{label:'',type:'city'},departureTime:'',arrivalDate:'',arrivalTime:''};
  story.returnTrip=story.returnTrip||{enabled:false,transportMode:'',origin:{label:'',type:'city'},arrival:{label:'',type:'city'},departureDate:'',departureTime:'',arrivalDate:'',arrivalTime:''};
  story.stays=(story.stays||[]).map(_tripStoryEnsureStay_);
  if(!story.stays.length) story.stays=[_tripStoryEnsureStay_({days:1})];
  let phase='travelers', activeStay=0, pendingNextStay=null, editReturnPhase=null, editReturnStay=null;
  const overlay=document.createElement('div'); overlay.className='trip-story-overlay guided-journey-overlay';
  overlay.innerHTML=`<div class="guided-journey" role="dialog" aria-modal="true" aria-label="${es?'Crea tu viaje':'Build your trip'}">
    <header class="guided-journey__top"><div><small>ITBMO</small><h2>${es?'Crea tu viaje':'Build your trip'}</h2><p>${es?'No estás llenando un formulario. Estás viendo cómo tu viaje toma forma.':'You are not filling out a form. You are watching your trip take shape.'}</p></div><button type="button" data-gj-close aria-label="${es?'Cerrar':'Close'}">×</button></header>
    <nav class="guided-journey__progress" aria-label="${es?'Progreso':'Progress'}"><button type="button" data-stage="travelers">${es?'Viajeros':'Travelers'}</button><i>›</i><button type="button" data-stage="route">${es?'Ruta':'Route'}</button><i>›</i><button type="button" data-stage="personalize" disabled>${es?'Personalización':'Personalization'}</button><i>›</i><button type="button" data-stage="itinerary" disabled>${es?'Itinerario':'Itinerary'}</button></nav>
    <div class="guided-journey__layout"><main class="guided-journey__active" data-gj-active></main><aside class="guided-journey__story"><div class="guided-journey__story-head"><div><small>${es?'TU RECORRIDO':'YOUR JOURNEY'}</small><b>${es?'Tu viaje toma forma aquí':'Your trip takes shape here'}</b></div><div class="gj-story-head-actions"><button type="button" data-gj-copy>${es?'Copiar recorrido':'Copy journey'}</button><button type="button" class="gj-route-reset" data-gj-reset>${es?'Reiniciar recorrido':'Reset route'}</button></div></div><div data-gj-story></div></aside></div>
    <button class="guided-journey__mobile-story" type="button" data-gj-mobile-story>${es?'Ver mi recorrido':'View my journey'}</button>
  </div>`;
  document.body.appendChild(overlay); document.body.classList.add('trip-story-open');
  const active=overlay.querySelector('[data-gj-active]'), storyHost=overlay.querySelector('[data-gj-story]');
  const persist=()=>_tripStorySaveDraft_(story);
  const close=()=>{persist();overlay.remove();document.body.classList.remove('trip-story-open');};
  overlay.querySelector('[data-gj-close]').onclick=close;
  const countryField=(value,code,attr)=>`<div class="trip-story-location-field"><input autocomplete="off" ${attr} value="${_tripStoryEsc_(value||'')}" data-country-code="${_tripStoryEsc_(code||'')}" placeholder="${es?'Escribe el país…':'Type country…'}"><div class="trip-story-suggestions" hidden></div></div>`;
  const destinationField=(value,attr)=>`<div class="trip-story-location-field"><input autocomplete="off" ${attr} value="${_tripStoryEsc_(value||'')}" placeholder="${es?'Escribe el destino…':'Type destination…'}"><div class="trip-story-suggestions" hidden></div></div>`;
  const bindLocation=(input,onPick,kind='country',countryCode=()=>'' )=>{if(!input)return;let timer;input.oninput=()=>{onPick({label:input.value,code:'',typing:true});clearTimeout(timer);const menu=input.parentElement.querySelector('.trip-story-suggestions'),q=input.value.trim();if(q.length<(kind==='country'?2:3)){menu.hidden=true;return;}if(kind==='country'){const items=_tripStoryCountrySuggestions_(q);menu.innerHTML=items.length?items.map(x=>`<button type="button">${_tripStoryEsc_(x.label)}</button>`).join(''):`<div>${es?'Puedes conservar lo escrito.':'You can keep what you typed.'}</div>`;menu.hidden=false;menu.querySelectorAll('button').forEach((b,n)=>b.onclick=()=>{onPick({label:items[n].label,code:items[n].code});render();});}else{timer=setTimeout(async()=>{const items=await _tripStorySuggestions_(countryCode(),q);if(input.value.trim()!==q)return;menu.innerHTML=items.length?items.slice(0,10).map(x=>`<button type="button">${_tripStoryEsc_(typeof x==='string'?x:x.label)}</button>`).join(''):`<div>${es?'No aparece en la lista. Puedes conservar lo escrito.':'Not listed. You can keep what you typed.'}</div>`;menu.hidden=false;menu.querySelectorAll('button').forEach((b,n)=>b.onclick=()=>{onPick({label:typeof items[n]==='string'?items[n]:items[n].label});render();});},180);}};};
  const travelerSnapshot=()=>{const cur=collectTravelerStateFromUI();return cur.ok?cur:{mode:String($travelerMode?.value||''),companions:[]};};
  let travelerDraft=travelerSnapshot();
  const syncTravelers=()=>{if(!$travelerMode)return false;$travelerMode.value=travelerDraft.mode||'';$travelerMode.dispatchEvent(new Event('change',{bubbles:true}));if(travelerDraft.mode==='group'){$travelerProfiles.innerHTML='';(travelerDraft.companions||[]).forEach((x,i)=>{const card=createTravelerProfileCard(i+1);$travelerProfiles.appendChild(card);qs('.traveler-gender',card).value=x.gender||'';qs('.traveler-age-range',card).value=x.age_range||'';});renumberTravelerProfiles();setTravelerButtonsState();}writeLegacyTravelerCounts(collectTravelerStateFromUI().counts||{adults:1,young:0,children:0,infants:0,seniors:0});return collectTravelerStateFromUI().ok;};
  const travelerSummary=()=>{const t=collectTravelerStateFromUI();if(!t.ok)return es?'Pendiente':'Pending';if(t.mode==='solo')return es?'1 viajero':'1 traveler';return es?`${t.total} viajeros`:`${t.total} travelers`;};
  const renderStory=()=>{syncTravelers();const pieces=[];const t=collectTravelerStateFromUI();if(t.ok)pieces.push(`<div class="gj-story-node gj-story-node--meta"><span>✓</span><div><b>${es?'Viajeros':'Travelers'}</b><small>${travelerSummary()}</small></div></div>`);if(story.start?.enabled)pieces.push(`<div class="gj-story-node gj-story-node--meta"><span>✓</span><div><b>${es?'Inicio del viaje':'Trip start'}</b><small>${_tripStoryEsc_(story.start.origin?.label||'')} ${story.start.arrival?.label?`→ ${_tripStoryEsc_(story.start.arrival.label)}`:''}</small></div></div>`);story.stays.forEach((st,i)=>{if(!st.place)return;pieces.push(`${i?'<div class="gj-story-line">↓</div>':''}<div class="gj-story-node gj-story-node--editable gj-story-node--managed"><button type="button" class="gj-story-main" data-story-edit="${i}"><span>${String(i+1).padStart(2,'0')}</span><div><b>${_tripStoryEsc_(st.place)}</b><small>${_tripStoryDMY_(st.startDate)}${_tripStoryStayEnd_(st)!==st.startDate?` → ${_tripStoryDMY_(_tripStoryStayEnd_(st))}`:''} · ${st.days} ${st.days===1?(es?'día':'day'):(es?'días':'days')}</small>${(st.dayTrips||[]).map(dt=>dt.place?`<em>↗ ${_tripStoryEsc_(dt.place)} · ${es?'Día':'Day'} ${dt.day}</em>`:'').join('')}</div></button><div class="gj-story-node-actions">${i?`<button type="button" data-story-move="${i}:-1" title="${es?'Mover arriba':'Move up'}">↑</button>`:''}${i<story.stays.length-1?`<button type="button" data-story-move="${i}:1" title="${es?'Mover abajo':'Move down'}">↓</button>`:''}<button type="button" data-story-edit="${i}">${es?'Editar':'Edit'}</button><button type="button" class="gj-danger-inline" data-story-delete="${i}">${es?'Eliminar':'Delete'}</button></div></div>`);if(i<story.stays.length-1){const nx=story.stays[i+1];pieces.push(`<div class="gj-story-move"><span>↓</span><div><b>${_tripStoryEsc_(st.place)} → ${_tripStoryEsc_(nx.place||'…')}</b><small>${nx.departureDate?_tripStoryDMY_(nx.departureDate):''}${nx.departureTime?` · ${es?'desde':'from'} ${nx.departureTime}`:''}</small><em>${nx.transportStatus==='user_defined'?(es?'✓ Transporte definido':'✓ Transport defined'):(es?'✦ ITBMO resolverá cómo llegar':'✦ ITBMO will resolve how to get there')}</em></div></div>`);}});if(story.returnTrip?.enabled)pieces.push(`<div class="gj-story-line">↓</div><div class="gj-story-node gj-story-node--meta"><span>✓</span><div><b>${es?'Regreso':'Return'}</b><small>${_tripStoryEsc_(story.returnTrip.origin?.label||story.stays.at(-1)?.place||'')} → ${_tripStoryEsc_(story.returnTrip.arrival?.label||'')}</small></div></div>`);storyHost.innerHTML=pieces.join('')||`<div class="gj-story-empty">${es?'Tu recorrido aparecerá aquí mientras lo construyes.':'Your journey will appear here as you build it.'}</div>`;
    storyHost.querySelectorAll('[data-story-edit]').forEach(btn=>btn.onclick=()=>{editReturnPhase=phase;editReturnStay=activeStay;activeStay=Number(btn.dataset.storyEdit);phase='stay';render();});
    storyHost.querySelectorAll('[data-story-delete]').forEach(btn=>btn.onclick=()=>{const i=Number(btn.dataset.storyDelete),name=story.stays[i]?.place||'';if(!confirm(es?`¿Eliminar ${name||'este destino'} por completo? Se eliminarán también sus excursiones y se recalcularán las conexiones afectadas.`:`Delete ${name||'this destination'} completely? Its day trips will also be deleted and affected connections recalculated.`))return;_tripStoryRemoveStay_(story,i);editReturnPhase=null;editReturnStay=null;pendingNextStay=null;activeStay=Math.min(i,story.stays.length-1);phase=story.stays[activeStay]?.place?'decision':'stay';persist();render();});
    storyHost.querySelectorAll('[data-story-move]').forEach(btn=>btn.onclick=()=>{const [from,dir]=btn.dataset.storyMove.split(':').map(Number),to=from+dir;if(!_tripStoryMoveStay_(story,from,to))return;activeStay=to;editReturnPhase=null;editReturnStay=null;pendingNextStay=null;persist();render();});
  };
  const stage=()=>{overlay.querySelectorAll('[data-stage]').forEach(x=>x.classList.remove('is-active','is-done'));const tr=overlay.querySelector('[data-stage="travelers"]'),rt=overlay.querySelector('[data-stage="route"]');if(phase==='travelers'){tr.classList.add('is-active');rt.disabled=true;}else{tr.classList.add('is-done');rt.classList.add('is-active');rt.disabled=false;}};
  const shell=(eyebrow,title,copy,content,actions='')=>`<section class="gj-focus"><small class="gj-focus__eyebrow">${eyebrow}</small><h3>${title}</h3>${copy?`<p>${copy}</p>`:''}<div class="gj-focus__content">${content}</div><div class="gj-focus__actions">${actions}</div></section>`;
  const nextButton=(label=es?'Continuar':'Continue',attr='data-gj-next')=>`<button type="button" class="gj-primary" ${attr}>${label}<span>→</span></button>`;
  const render=()=>{stage();renderStory();
    if(phase==='travelers'){
      const comps=travelerDraft.mode==='group'?(travelerDraft.companions||[]):[];
      active.innerHTML=shell(es?'QUIÉNES VIAJAN':'WHO IS TRAVELING',es?'¿Quiénes viajan?':'Who is traveling?',es?'Esto nos ayuda a ajustar ritmos, actividades y desplazamientos.':'This helps us adapt pace, activities and travel.',`<div class="gj-choice-grid"><button type="button" data-tr-mode="solo" class="gj-choice ${travelerDraft.mode==='solo'?'is-selected':''}"><b>${es?'Viajo solamente yo':'Just me'}</b></button><button type="button" data-tr-mode="group" class="gj-choice ${travelerDraft.mode==='group'?'is-selected':''}"><b>${es?'Viajo acompañado':'I am traveling with others'}</b></button></div>${travelerDraft.mode==='group'?`<div class="gj-companions">${comps.map((c,i)=>`<div class="gj-companion"><b>${es?'Acompañante':'Companion'} ${i+1}</b><select data-comp-gender="${i}"><option value="">${es?'Género':'Gender'}</option><option value="female" ${c.gender==='female'?'selected':''}>${es?'Femenino':'Female'}</option><option value="male" ${c.gender==='male'?'selected':''}>${es?'Masculino':'Male'}</option><option value="non_binary" ${c.gender==='non_binary'?'selected':''}>${es?'No binario':'Non-binary'}</option><option value="another_identity" ${c.gender==='another_identity'?'selected':''}>${es?'Otra identidad':'Another identity'}</option><option value="na" ${c.gender==='na'?'selected':''}>${es?'Prefiero no decirlo':'Prefer not to say'}</option></select><select data-comp-age="${i}"><option value="">${es?'Rango de edad':'Age range'}</option>${['0-2','3-5','6-12','13-17','18-24','25-34','35-44','45-54','55-64','65+'].map(v=>`<option value="${v}" ${c.age_range===v?'selected':''}>${v}</option>`).join('')}</select></div>`).join('')}<div class="gj-inline-actions"><button type="button" data-comp-remove>− ${es?'Quitar':'Remove'}</button><button type="button" data-comp-add>+ ${es?'Agregar':'Add'}</button></div></div>`:''}`,nextButton());
      active.querySelectorAll('[data-tr-mode]').forEach(b=>b.onclick=()=>{travelerDraft.mode=b.dataset.trMode;if(travelerDraft.mode==='group'&&!(travelerDraft.companions||[]).length)travelerDraft.companions=[{gender:'',age_range:''}];render();});active.querySelector('[data-comp-add]')?.addEventListener('click',()=>{if(travelerDraft.companions.length<8)travelerDraft.companions.push({gender:'',age_range:''});render();});active.querySelector('[data-comp-remove]')?.addEventListener('click',()=>{if(travelerDraft.companions.length>1)travelerDraft.companions.pop();render();});active.querySelectorAll('[data-comp-gender]').forEach(x=>x.onchange=()=>travelerDraft.companions[Number(x.dataset.compGender)].gender=x.value);active.querySelectorAll('[data-comp-age]').forEach(x=>x.onchange=()=>travelerDraft.companions[Number(x.dataset.compAge)].age_range=x.value);active.querySelector('[data-gj-next]').onclick=()=>{if(!travelerDraft.mode)return;if(travelerDraft.mode==='group'&&travelerDraft.companions.some(x=>!x.gender||!x.age_range))return;syncTravelers();phase='start';render();};return;
    }
    if(phase==='start'){
      active.innerHTML=shell(es?'INICIO DEL VIAJE · OPCIONAL':'TRIP START · OPTIONAL',es?'¿Quieres agregar cómo llegarás a tu primer destino?':'Would you like to add how you will reach your first destination?',es?'Este paso es el desplazamiento desde el lugar donde comienza físicamente tu viaje hasta tu primer destino ITBMO. Puede ser tu ciudad de residencia u otro punto de partida. Ejemplo: San José, Costa Rica → Madrid. Si tu itinerario comienza directamente en el primer destino, omítelo.':'If you already know how you start toward your first destination, add it. Otherwise skip it.',`<div class="gj-choice-grid"><button type="button" data-start-add class="gj-choice"><b>${es?'Agregar información':'Add information'}</b></button><button type="button" data-start-skip class="gj-choice"><b>${es?'Omitir':'Skip'}</b></button></div>${story.start.enabled?`<div class="gj-form"><label>${es?'Origen':'Origin'}<input data-start="origin" value="${_tripStoryEsc_(story.start.origin?.label||'')}"></label><label>${es?'Fecha de salida':'Departure date'}<input type="date" data-start="date" value="${story.start.date||''}"></label><label>${es?'Hora (opcional)':'Time (optional)'}<select data-start="departureTime">${_tripStoryTimeOptions_(story.start.departureTime)}</select></label><label>${es?'Transporte (opcional)':'Transport (optional)'}<select data-start="transportMode">${_tripStoryTransportOptions_(story.start.transportMode||'')}</select></label></div>`:''}`,story.start.enabled?nextButton():``);
      active.querySelector('[data-start-add]').onclick=()=>{story.start.enabled=true;render();};active.querySelector('[data-start-skip]').onclick=()=>{story.start.enabled=false;phase='stay';activeStay=0;render();};active.querySelectorAll('[data-start]').forEach(el=>el.onchange=()=>{const k=el.dataset.start;if(k==='origin')story.start.origin={label:el.value,type:'city'};else story.start[k]=el.value;persist();});active.querySelector('[data-gj-next]')?.addEventListener('click',()=>{phase='stay';render();});return;
    }
    if(phase==='stay'){
      const st=story.stays[activeStay];
      active.innerHTML=shell(activeStay===0?(es?'PRIMER DESTINO':'FIRST DESTINATION'):(es?'SIGUIENTE DESTINO':'NEXT DESTINATION'),activeStay===0?(es?'¿Dónde comienza tu recorrido?':'Where does your journey begin?'):(es?'¿Cuál es tu siguiente destino?':'What is your next destination?'),es?'Sólo necesitamos el lugar y las fechas de esta estancia.':'We only need the place and dates for this stay.',`<div class="gj-form"><label>${es?'País':'Country'}${countryField(st.country,st.countryCode,'data-stay-country')}</label><label>${es?'Destino':'Destination'}${destinationField(st.place,'data-stay-place')}</label><label>${es?'Fecha de llegada':'Arrival date'}<input type="date" data-stay-start value="${st.startDate||''}"></label><label>${es?'Días en este destino':'Days in this destination'}<select data-stay-days>${_tripStoryDaysOptions_(st.days)}</select></label></div>`,nextButton(es?'Agregar esta parada':'Add this stop'));
      bindLocation(active.querySelector('[data-stay-country]'),x=>{const changed=st.country!==x.label||Boolean(x.code&&st.countryCode!==x.code);st.country=x.label;if(x.code)st.countryCode=x.code;if(changed){_tripStoryInvalidateStayDerived_(st);if(activeStay>0)_tripStoryResetInboundMovement_(st);if(story.stays[activeStay+1])_tripStoryResetInboundMovement_(story.stays[activeStay+1]);_tripStorySyncBoundaryAfterStayEdit_(story,activeStay,{identityChanged:true});}persist();},'country');bindLocation(active.querySelector('[data-stay-place]'),x=>{const changed=st.place!==x.label;st.place=x.label;if(changed){_tripStoryInvalidateStayDerived_(st);if(activeStay>0)_tripStoryResetInboundMovement_(st);if(story.stays[activeStay+1])_tripStoryResetInboundMovement_(story.stays[activeStay+1]);_tripStorySyncBoundaryAfterStayEdit_(story,activeStay,{identityChanged:true});}persist();},'city',()=>st.countryCode);active.querySelector('[data-stay-start]').onchange=e=>{const changed=st.startDate!==e.target.value;st.startDate=e.target.value;if(changed){st.arrivalDate=st.startDate;if(activeStay>0)_tripStoryResetInboundMovement_(st);if(story.stays[activeStay+1])_tripStoryResetInboundMovement_(story.stays[activeStay+1]);_tripStoryInvalidateStayDerived_(st);_tripStorySyncBoundaryAfterStayEdit_(story,activeStay,{dateChanged:true});}else st.arrivalDate=st.arrivalDate||st.startDate;_tripStoryEnsureStay_(st);persist();renderStory();};active.querySelector('[data-stay-days]').onchange=e=>{const changed=Number(st.days)!==Number(e.target.value);st.days=Number(e.target.value);_tripStoryEnsureStay_(st);if(changed){_tripStoryInvalidateStayDerived_(st);if(story.stays[activeStay+1])_tripStoryResetInboundMovement_(story.stays[activeStay+1]);}persist();renderStory();};active.querySelector('[data-gj-next]').onclick=()=>{if(!st.place||!st.startDate)return;phase=editReturnPhase?'decision':(activeStay>0?'movement':'decision');render();};return;
    }
    if(phase==='decision'){
      const st=story.stays[activeStay];
      active.innerHTML=shell(es?'TU VIAJE SIGUE TOMANDO FORMA':'YOUR TRIP KEEPS TAKING SHAPE',_tripStoryEsc_(st.place),editReturnPhase?(es?'Edita esta parada. Al guardar volverás exactamente donde estabas.':'Edit this stop. When saved, you will return exactly where you were.'):(es?'¿Qué quieres hacer ahora?':'What would you like to do now?'),`<div class="gj-choice-stack"><button type="button" data-add-daytrip class="gj-choice"><span>↗</span><div><b>${es?'Agregar excursión':'Add a day trip'}</b><small>${es?'Sales y regresas a este destino el mismo día.':'Leave and return to this destination the same day.'}</small></div></button>${editReturnPhase&&activeStay>0?`<button type="button" data-edit-inbound class="gj-choice"><span>⇢</span><div><b>${es?'Editar traslado de llegada':'Edit arrival transfer'}</b><small>${es?'Revisa fecha, hora y transporte desde el destino anterior.':'Review date, time and transport from the previous destination.'}</small></div></button>`:''}${!editReturnPhase?`<button type="button" data-add-next class="gj-choice"><span>＋</span><div><b>${es?'Agregar siguiente destino':'Add next destination'}</b><small>${es?'Continuaremos construyendo tu recorrido.':'Keep building your route.'}</small></div></button><button type="button" data-finish class="gj-choice"><span>✓</span><div><b>${es?'Mi recorrido termina aquí':'My journey ends here'}</b><small>${es?'Después podrás agregar el regreso, si lo conoces.':'You can add your return afterward if you know it.'}</small></div></button>`:''}</div>${(st.dayTrips||[]).length?`<div class="gj-existing"><b>${es?'Excursiones':'Day trips'}</b>${st.dayTrips.map((d,i)=>`<div><span>↗ ${_tripStoryEsc_(d.place||'—')} · ${es?'Día':'Day'} </span><select data-move-daytrip="${i}">${Array.from({length:st.days},(_,n)=>`<option value="${n+1}" ${d.day===n+1?'selected':''}>${n+1}</option>`).join('')}</select><button data-edit-daytrip="${i}">${es?'Editar':'Edit'}</button><button class="gj-danger-inline" data-remove-daytrip="${i}">${es?'Eliminar':'Delete'}</button></div>`).join('')}</div>`:''}${editReturnPhase?`<button type="button" class="gj-primary gj-primary--warm" data-finish-edit>${es?'Guardar cambios y volver':'Save changes and return'}<span>→</span></button>`:''}`);
      active.querySelector('[data-add-daytrip]').onclick=()=>{st.dayTrips.push(_tripStoryEnsureDayTrip_({day:1,countryCode:st.countryCode,country:st.country,place:'',outbound:{},return:{}}));phase='daytrip';render();};active.querySelectorAll('[data-edit-daytrip]').forEach(b=>b.onclick=()=>{st._editingDayTrip=Number(b.dataset.editDaytrip);phase='daytrip';render();});active.querySelectorAll('[data-remove-daytrip]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.removeDaytrip),name=st.dayTrips[i]?.place||'';if(!confirm(es?`¿Eliminar la excursión${name?` a ${name}`:''}?`:`Delete the day trip${name?` to ${name}`:''}?`))return;st.dayTrips.splice(i,1);persist();render();});active.querySelectorAll('[data-move-daytrip]').forEach(x=>x.onchange=()=>{st.dayTrips[Number(x.dataset.moveDaytrip)].day=Number(x.value);persist();renderStory();});active.querySelector('[data-edit-inbound]')?.addEventListener('click',()=>{phase='movement';render();});active.querySelector('[data-add-next]')?.addEventListener('click',()=>{pendingNextStay=_tripStoryEnsureStay_({days:1});story.stays.push(pendingNextStay);activeStay=story.stays.length-1;phase='stay';render();});active.querySelector('[data-finish]')?.addEventListener('click',()=>{story.ended=true;phase='return';render();});active.querySelector('[data-finish-edit]')?.addEventListener('click',()=>{const back=editReturnPhase||'review',backStay=editReturnStay;editReturnPhase=null;editReturnStay=null;persist();if(Number.isInteger(backStay))activeStay=backStay;phase=back;render();});return;
    }
    if(phase==='daytrip'){
      const st=story.stays[activeStay], idx=Number.isInteger(st._editingDayTrip)?st._editingDayTrip:st.dayTrips.length-1,dt=st.dayTrips[idx];delete st._editingDayTrip;
      active.innerHTML=shell(es?'EXCURSIÓN DE UN DÍA':'DAY TRIP',es?`Una excursión desde ${_tripStoryEsc_(st.place)}`:`A day trip from ${_tripStoryEsc_(st.place)}`,es?'Dinos dónde y qué día. Los horarios y el transporte sólo son necesarios si ya los conoces.':'Tell us where and which day. Times and transport are only needed if you already know them.',`<div class="gj-form"><label>${es?'Destino':'Destination'}${destinationField(dt.place,'data-dt-place')}</label><label>${es?'¿Qué día?':'Which day?'}<select data-dt-day>${Array.from({length:st.days},(_,n)=>`<option value="${n+1}" ${dt.day===n+1?'selected':''}>${es?'Día':'Day'} ${n+1} · ${_tripStoryDMY_(_tripStoryDayDate_(st,n))}</option>`).join('')}</select></label><div class="gj-full gj-disclosure"><b>${es?'¿Ya conoces el transporte o los horarios de esta excursión?':'Do you already know the transport or times for this day trip?'}</b><div class="gj-segmented"><button type="button" data-dt-knowledge="resolve" class="${(dt.outbound.transportMode||dt.outbound.departureTime||dt.return.departureTime)?'':'is-selected'}">${es?'No, que ITBMO lo resuelva':'No, let ITBMO resolve it'}</button><button type="button" data-dt-knowledge="known" class="${(dt.outbound.transportMode||dt.outbound.departureTime||dt.return.departureTime)?'is-selected':''}">${es?'Sí, ya los conozco':'Yes, I already know them'}</button></div></div><div data-dt-details class="gj-form gj-full" ${(dt.outbound.transportMode||dt.outbound.departureTime||dt.return.departureTime)?'':'hidden'}><label>${es?'Transporte':'Transport'}<select data-dt-out-mode>${_tripStoryTransportOptions_(dt.outbound.transportMode)}</select></label><label>${es?'Hora de salida':'Departure time'}<select data-dt-out-time>${_tripStoryTimeOptions_(dt.outbound.departureTime)}</select></label><label>${es?'Hora de regreso':'Return time'}<select data-dt-return-time>${_tripStoryTimeOptions_(dt.return.departureTime)}</select></label></div></div>`,nextButton(es?'Guardar excursión':'Save day trip'));
      bindLocation(active.querySelector('[data-dt-place]'),x=>{const changed=dt.place!==x.label;dt.place=x.label;if(changed){dt.outbound.routeResolution=null;dt.return.routeResolution=null;dt.routeResolution=null;}persist();},'city',()=>dt.countryCode||st.countryCode);active.querySelector('[data-dt-day]').onchange=e=>{const next=Number(e.target.value),changed=dt.day!==next;dt.day=next;if(changed){dt.outbound.routeResolution=null;dt.return.routeResolution=null;dt.routeResolution=null;}persist();};active.querySelectorAll('[data-dt-knowledge]').forEach(b=>b.onclick=()=>{const known=b.dataset.dtKnowledge==='known';active.querySelectorAll('[data-dt-knowledge]').forEach(x=>x.classList.toggle('is-selected',x===b));active.querySelector('[data-dt-details]').hidden=!known;if(!known){dt.outbound.transportMode='';dt.outbound.departureTime='';dt.return.departureTime='';dt.outbound.routeResolution=null;dt.return.routeResolution=null;persist();}});active.querySelector('[data-dt-out-mode]').onchange=e=>dt.outbound.transportMode=e.target.value;active.querySelector('[data-dt-out-time]').onchange=e=>dt.outbound.departureTime=e.target.value;active.querySelector('[data-dt-return-time]').onchange=e=>dt.return.departureTime=e.target.value;active.querySelector('[data-gj-next]').onclick=()=>{if(!dt.place)return;persist();phase='decision';render();};return;
    }
    if(phase==='movement'){
      const st=story.stays[activeStay],prev=story.stays[activeStay-1];
      active.innerHTML=shell(es?'TRASLADO ENTRE DESTINOS':'BETWEEN-DESTINATION TRANSFER',`${_tripStoryEsc_(prev?.place||'')} → ${_tripStoryEsc_(st.place)}`,es?'Sólo dinos cuándo puedes comenzar. Si ya tienes el transporte, agrégalo; si no, ITBMO resolverá la logística.':'Just tell us when you can start. Add transport if you already have it; otherwise ITBMO will resolve the logistics.',`<div class="gj-form"><label>${es?'Fecha del traslado':'Transfer date'}<input type="date" data-move="departureDate" value="${st.departureDate||st.startDate||''}"></label><label>${es?'¿A partir de qué hora puedes salir?':'From what time can you leave?'}<select data-move="departureTime">${_tripStoryRequiredTimeOptions_(st.departureTime)}</select></label><div class="gj-full gj-disclosure"><b>${es?'¿Ya tienes este traslado definido?':'Do you already have this transfer defined?'}</b><div class="gj-segmented"><button type="button" data-move-knowledge="resolve" class="${st.transportStatus==='user_defined'?'':'is-selected'}">${es?'No, que ITBMO lo resuelva':'No, let ITBMO resolve it'}</button><button type="button" data-move-knowledge="known" class="${st.transportStatus==='user_defined'?'is-selected':''}">${es?'Sí, ya tengo mi transporte':'Yes, I already have my transport'}</button></div></div><div class="gj-form gj-full" data-move-details ${st.transportStatus==='user_defined'?'':'hidden'}><label>${es?'Medio de transporte':'Transport'}<select data-move="transportMode">${_tripStoryTransportOptions_(st.transportMode)}</select></label><label>${es?'Fecha de llegada (opcional)':'Arrival date (optional)'}<input type="date" data-move="arrivalDate" value="${st.arrivalDate||''}"></label><label>${es?'Hora de llegada (opcional)':'Arrival time (optional)'}<select data-move="arrivalTime">${_tripStoryTimeOptions_(st.arrivalTime)}</select></label></div></div>`,nextButton(es?'Guardar traslado':'Save transfer','data-save-movement'));
      active.querySelectorAll('[data-move-knowledge]').forEach(b=>b.onclick=()=>{const known=b.dataset.moveKnowledge==='known';st.transportStatus=known?'user_defined':'route_to_resolve';active.querySelectorAll('[data-move-knowledge]').forEach(x=>x.classList.toggle('is-selected',x===b));active.querySelector('[data-move-details]').hidden=!known;if(!known){st.transportMode='';st.arrivalDate='';st.arrivalTime='';st.routeResolution=null;}persist();});active.querySelectorAll('[data-move]').forEach(x=>x.onchange=()=>{st[x.dataset.move]=x.value;persist();});active.querySelector('[data-save-movement]').onclick=()=>{const depDate=active.querySelector('[data-move="departureDate"]')?.value||'';const depTime=active.querySelector('[data-move="departureTime"]')?.value||'';st.departureDate=depDate;st.departureTime=depTime;if(!depDate||!depTime){active.querySelector('[data-move="departureDate"]')?.classList.toggle('is-invalid',!depDate);active.querySelector('[data-move="departureTime"]')?.classList.toggle('is-invalid',!depTime);return;}const prevEnd=_tripStoryStayEnd_(prev);if(prevEnd&&depDate<prevEnd){alert(es?`La salida de ${prev.place} hacia ${st.place} no puede ser el ${_tripStoryDMY_(depDate)} porque ${prev.place} está planificado hasta el ${_tripStoryDMY_(prevEnd)}. Usa ${_tripStoryDMY_(prevEnd)} o una fecha posterior.`:`The departure from ${prev.place} to ${st.place} cannot be ${_tripStoryDMY_(depDate)} because ${prev.place} is planned through ${_tripStoryDMY_(prevEnd)}. Use ${_tripStoryDMY_(prevEnd)} or a later date.`);active.querySelector('[data-move="departureDate"]')?.classList.add('is-invalid');return;}if(st.transportStatus!=='user_defined'){st.transportMode='';st.arrivalDate='';st.arrivalTime='';st.routeResolution=null;}else{active.querySelectorAll('[data-move]').forEach(x=>st[x.dataset.move]=x.value);}persist();phase='decision';render();};return;
    }
    if(phase==='return'){
      const last=story.stays.at(-1);
      active.innerHTML=shell(es?'REGRESO · OPCIONAL':'RETURN · OPTIONAL',es?'¿Quieres agregar cómo finalizarás tu viaje?':'Would you like to add how your trip ends?',es?`Este paso es el desplazamiento desde ${_tripStoryEsc_(last?.place||'tu último destino')} hasta el lugar donde terminarás tu viaje. Puede ser tu ciudad de origen u otro destino. Ejemplo: Roma → San José, Costa Rica. Si tu recorrido termina aquí o todavía no conoces el regreso, omítelo.`:'You can add your return to your point of origin. If you do not know yet, skip it.',`<div class="gj-choice-grid"><button type="button" data-return-add class="gj-choice"><b>${es?'Agregar regreso':'Add return'}</b></button><button type="button" data-return-skip class="gj-choice"><b>${es?'Omitir':'Skip'}</b></button></div>${story.returnTrip.enabled?`<div class="gj-form"><label>${es?'Desde':'From'}<input data-ret="origin" value="${_tripStoryEsc_(story.returnTrip.origin?.label||last?.place||'')}"></label><label>${es?'Regreso a':'Return to'}<input data-ret="arrival" value="${_tripStoryEsc_(story.returnTrip.arrival?.label||story.start?.origin?.label||'')}"></label><label>${es?'Fecha':'Date'}<input type="date" data-ret="departureDate" value="${story.returnTrip.departureDate||''}"></label><label>${es?'Puedo salir desde':'I can leave from'}<select data-ret="departureTime">${_tripStoryTimeOptions_(story.returnTrip.departureTime)}</select></label><label>${es?'Transporte (opcional)':'Transport (optional)'}<select data-ret="transportMode">${_tripStoryTransportOptions_(story.returnTrip.transportMode||'')}</select></label></div>`:''}`,story.returnTrip.enabled?nextButton(es?'Continuar a revisión':'Continue to review'):``);
      active.querySelector('[data-return-add]').onclick=()=>{story.returnTrip.enabled=true;story.returnTrip.origin={label:last?.place||'',type:'city'};render();};active.querySelector('[data-return-skip]').onclick=()=>{story.returnTrip.enabled=false;phase='review';render();};active.querySelectorAll('[data-ret]').forEach(el=>el.onchange=()=>{const k=el.dataset.ret;if(k==='origin'||k==='arrival')story.returnTrip[k]={label:el.value,type:'city'};else story.returnTrip[k]=el.value;persist();});active.querySelector('[data-gj-next]')?.addEventListener('click',()=>{phase='review';render();});return;
    }
    if(phase==='review'){
      const effectiveDates=new Set();story.stays.forEach(st=>{for(let d=0;d<Number(st.days||1);d++){const date=_tripStoryAddDays_(st.startDate,d);if(date)effectiveDates.add(date);}});const tooLong=effectiveDates.size>MAX_TRIP_STORY_DAYS;
      active.innerHTML=shell(es?'REVISA TU RECORRIDO':'REVIEW YOUR JOURNEY',es?'Tu viaje está tomando forma':'Your trip is taking shape',es?'Revisa la historia completa. Puedes volver a editar cualquier estancia antes de continuar al pago.':'Review the complete story. You can edit any stay before continuing to payment.',`<div class="gj-review-stats"><div><b>${story.stays.length}</b><span>${es?'destinos':'destinations'}</span></div><div><b>${effectiveDates.size}</b><span>${es?'días efectivos':'effective days'}</span></div><div><b>${story.stays.reduce((n,s)=>n+(s.dayTrips||[]).length,0)}</b><span>${es?'excursiones':'day trips'}</span></div></div>${tooLong?`<div class="gj-warning">${es?`El recorrido supera el máximo de ${MAX_TRIP_STORY_DAYS} días efectivos.`:`The route exceeds the ${MAX_TRIP_STORY_DAYS}-effective-day maximum.`}</div>`:''}<div class="gj-review-list">${story.stays.map((st,i)=>`<div class="gj-review-row"><div><b>${i+1}. ${_tripStoryEsc_(st.place||'—')}</b><small>${_tripStoryDMY_(st.startDate)} · ${st.days} ${st.days===1?(es?'día':'day'):(es?'días':'days')}</small></div><div>${i?`<button type="button" data-review-move="${i}:-1">↑</button>`:''}${i<story.stays.length-1?`<button type="button" data-review-move="${i}:1">↓</button>`:''}<button type="button" data-review-edit="${i}">${es?'Editar':'Edit'}</button><button type="button" class="gj-review-delete" data-review-delete="${i}">${es?'Eliminar':'Delete'}</button></div></div>`).join('')}</div><div class="gj-review-actions"><button type="button" data-edit-route>${es?'Volver a la última parada':'Back to last stop'}</button></div>`,tooLong?'':nextButton(es?'Guardar recorrido y continuar':'Save journey and continue','data-gj-save'));
      active.querySelector('[data-edit-route]').onclick=()=>{activeStay=Math.max(0,story.stays.length-1);phase='decision';render();};active.querySelectorAll('[data-review-edit]').forEach(b=>b.onclick=()=>{editReturnPhase='review';editReturnStay=activeStay;activeStay=Number(b.dataset.reviewEdit);phase='stay';render();});active.querySelectorAll('[data-review-delete]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.reviewDelete),name=story.stays[i]?.place||'';if(!confirm(es?`¿Eliminar ${name||'este destino'} del recorrido? Se recalculará la conexión entre los destinos restantes.`:`Delete ${name||'this destination'} from the route? The connection between the remaining destinations will be recalculated.`))return;_tripStoryRemoveStay_(story,i);editReturnPhase=null;editReturnStay=null;activeStay=Math.min(i,story.stays.length-1);persist();render();});active.querySelectorAll('[data-review-move]').forEach(b=>b.onclick=()=>{const [from,dir]=b.dataset.reviewMove.split(':').map(Number),to=from+dir;if(to<0||to>=story.stays.length)return;_tripStoryMoveStay_(story,from,to);activeStay=to;persist();render();});active.querySelector('[data-gj-save]')?.addEventListener('click',async()=>{syncTravelers();_tripStoryApplyBoundaryHours_(story);const issues=_tripStoryValidate_(story);if(issues.length){_tripStoryShowIssues_(issues,()=>{});return;}engine?.setTripStory?.(JSON.parse(JSON.stringify(story)));applyTripStoryToCompatibility(story);renderTripStorySummary();persist();overlay.remove();document.body.classList.remove('trip-story-open');const saved=await saveDestinations({showReadyModal:true,fromTripStory:true});if(saved===true)_tripStoryClearDraft_();});return;
    }
  };
  overlay.querySelector('[data-gj-reset]').onclick=()=>{if(!confirm(es?'¿Quieres reiniciar el recorrido? Se eliminarán los destinos, excursiones y traslados que has configurado. Los viajeros se conservarán.':'Reset the route? Destinations, day trips and transfers will be deleted. Travelers will be kept.'))return;_tripStoryResetRoute_(story);editReturnPhase=null;editReturnStay=null;pendingNextStay=null;activeStay=0;phase='start';persist();try{engine?.setTripStory?.(JSON.parse(JSON.stringify(story)));}catch(_){};render();};
  overlay.querySelector('[data-gj-copy]').onclick=async()=>{syncTravelers();const txt=_tripStoryCopyText_(story);try{await navigator.clipboard.writeText(txt);const b=overlay.querySelector('[data-gj-copy]'),old=b.textContent;b.textContent=es?'✓ Copiado':'✓ Copied';setTimeout(()=>b.textContent=old,1400);}catch(_){prompt(es?'Copia tu recorrido:':'Copy your journey:',txt);}};
  overlay.querySelector('[data-gj-mobile-story]').onclick=()=>overlay.querySelector('.guided-journey__story').classList.toggle('is-mobile-open');
  overlay.querySelector('[data-stage="travelers"]').onclick=()=>{travelerDraft=travelerSnapshot();phase='travelers';render();};
  overlay.querySelector('[data-stage="route"]').onclick=()=>{if(overlay.querySelector('[data-stage="route"]').disabled)return;activeStay=Math.min(Math.max(0,activeStay),story.stays.length-1);phase=story.stays[activeStay]?.place?'decision':'stay';render();};
  render();
}
function _routeResolvedPrincipalMode_(legs=[],direction='',fallback='other'){
  const dir=String(direction||'').toLowerCase();
  const pool=(Array.isArray(legs)?legs:[]).filter(leg=>!dir||String(leg?.direction||'').toLowerCase()===dir);
  const normalize=(value)=>{
    const key=String(value||'').toLowerCase();
    if(/train|rail|tren|ferrocarril|rer/.test(key))return 'train';
    if(/bus|coach|autobus|autocar/.test(key))return 'bus';
    if(/plane|flight|air|avion|vuelo/.test(key))return 'plane';
    if(/ferry|ferri|barco/.test(key))return 'ferry';
    if(/car|coche|auto|drive/.test(key))return 'car';
    if(/transfer|taxi|metro|walk|pie/.test(key))return 'transfer';
    return '';
  };
  // The card must describe the principal intercity leg, never a local access leg.
  // Prefer a commerce-eligible leg and, for multimodal chains, the longest one.
  const ranked=pool.map((leg,index)=>({leg,index,mode:normalize(leg?.mode),minutes:Number(leg?.estimated_minutes||0)||0}))
    .filter(x=>x.mode)
    .sort((a,b)=>Number(Boolean(b.leg?.commerce_eligible))-Number(Boolean(a.leg?.commerce_eligible)) || b.minutes-a.minutes || a.index-b.index);
  return ranked[0]?.mode || normalize(fallback) || 'other';
}

async function _resolveTripStoryRoutesBeforeGeneration_(){
  const engine=_travelV2(),story=engine?.state?.tripStory;
  if(!story?.stays?.length)return {ok:true,resolved:0};
  const movements=[];
  for(let i=1;i<story.stays.length;i++){
    const st=story.stays[i],prev=story.stays[i-1];
    if(!st.departureDate||!st.departureTime)continue;
    const needs=!st.arrivalDate||!st.arrivalTime||!st.transportMode||st.transportMode==='recommend';
    if(needs)movements.push({movement_id:`main:${st.id}`,kind:'main',origin:prev.place,destination:st.place,departure_date:st.departureDate,earliest_departure:st.departureTime,user_mode:st.transportMode||null,user_arrival_date:st.arrivalDate||null,user_arrival_time:st.arrivalTime||null});
  }
  for(const st of story.stays)for(const dt of (st.dayTrips||[])){
    if(!dt.place)continue;
    const date=_tripStoryAddDays_(st.startDate,Math.max(0,Number(dt.day||1)-1));
    const needs=![dt.outbound?.departureTime,dt.outbound?.arrivalTime,dt.return?.departureTime,dt.return?.arrivalTime].every(Boolean)||!dt.outbound?.transportMode||!dt.return?.transportMode;
    if(needs)movements.push({movement_id:`daytrip:${dt.id}`,kind:'daytrip',origin:st.place,destination:dt.place,departure_date:date,earliest_departure:dt.outbound?.departureTime||'08:00',must_return_same_day:true,user_return_by:dt.return?.arrivalTime||null,user_mode:dt.outbound?.transportMode||null});
  }
  if(!movements.length)return {ok:true,resolved:0};
  console.info('[ITBMO ROUTE RESOLVER] resolving',movements);
  const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'route_resolver',lang:getLang(),movements})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!Array.isArray(data?.routes))throw new Error(data?.code||'ROUTE_RESOLVER_FAILED');
  const byId=new Map(data.routes.map(x=>[String(x.movement_id),x]));let resolved=0;
  for(let i=1;i<story.stays.length;i++){
    const st=story.stays[i],r=byId.get(`main:${st.id}`);if(!r)continue;
    if(!st.transportMode)st.transportMode=_routeResolvedPrincipalMode_(Array.isArray(r.legs)?r.legs:[],'main',r.primary_mode||'other');
    if(!st.arrivalDate)st.arrivalDate=r.arrival_date||st.departureDate;
    if(!st.arrivalTime)st.arrivalTime=r.arrival_time||'';
    st.timeStatus=(st.arrivalTime&&r.arrival_time)?'estimated':(st.timeStatus||'estimated');
    st.transportStatus='route_estimated';st.routeResolution={summary:r.summary||'',legs:Array.isArray(r.legs)?r.legs:[],alternatives:Array.isArray(r.alternatives)?r.alternatives:[],confidence:r.confidence||'planning_estimate'};resolved++;
  }
  for(const st of story.stays)for(const dt of (st.dayTrips||[])){
    const r=byId.get(`daytrip:${dt.id}`);if(!r)continue;
    const legs=Array.isArray(r.legs)?r.legs:[];
    const outboundLegs=legs.filter(x=>x.direction==='outbound');
    const returnLegs=legs.filter(x=>x.direction==='return');
    const out=outboundLegs[0]||legs[0]||{};
    const outLast=outboundLegs.at(-1)||out;
    const ret=returnLegs[0]||legs.find(x=>_arePoiAliases_(x?.origin,dt.place)&&_arePoiAliases_(x?.destination,st.place))||{};
    const retLast=returnLegs.at(-1)||ret;
    // Day Trips are structurally ROUND TRIPS. Route Resolver must return an
    // explicit outbound chain and an explicit return chain; prose mentioning a
    // reverse connection is not sufficient and can never substitute the row.
    if(!outboundLegs.length||!returnLegs.length){
      console.error('[ITBMO ROUTE RESOLVER] incomplete day-trip round trip',dt.place,r);
      throw new Error(`ROUTE_RESOLVER_DAYTRIP_ROUNDTRIP_INCOMPLETE:${dt.place}`);
    }
    if(!dt.outbound.transportMode)dt.outbound.transportMode=_routeResolvedPrincipalMode_(legs,'outbound',out.mode||r.primary_mode||'other');
    if(!dt.outbound.departureTime)dt.outbound.departureTime=out.departure_time||r.departure_time||'08:00';
    if(!dt.outbound.arrivalTime)dt.outbound.arrivalTime=outLast.arrival_time||out.arrival_time||'';
    if(!dt.return.transportMode)dt.return.transportMode=_routeResolvedPrincipalMode_(legs,'return',ret.mode||dt.outbound.transportMode||r.primary_mode||'other');
    if(!dt.return.departureTime)dt.return.departureTime=ret.departure_time||r.return_departure_time||'';
    if(!dt.return.arrivalTime)dt.return.arrivalTime=retLast.arrival_time||ret.arrival_time||r.return_arrival_time||'';
    if(!dt.return.departureTime||!dt.return.arrivalTime){
      console.error('[ITBMO ROUTE RESOLVER] day-trip return unresolved',dt.place,r);
      throw new Error(`ROUTE_RESOLVER_DAYTRIP_RETURN_MISSING:${dt.place}`);
    }
    const outArrival=_hhmmToMinutes_(dt.outbound.arrivalTime),retDeparture=_hhmmToMinutes_(dt.return.departureTime),retArrival=_hhmmToMinutes_(dt.return.arrivalTime);
    if(outArrival==null||retDeparture==null||retArrival==null||retDeparture<=outArrival||retArrival<=retDeparture){
      console.error('[ITBMO ROUTE RESOLVER] invalid day-trip chronology',dt.place,{outbound:dt.outbound,return:dt.return,route:r});
      throw new Error(`ROUTE_RESOLVER_DAYTRIP_CHRONOLOGY_INVALID:${dt.place}`);
    }
    dt.outbound.timeStatus=dt.return.timeStatus='estimated';dt.routeResolution={summary:r.summary||'',legs,alternatives:Array.isArray(r.alternatives)?r.alternatives:[],confidence:r.confidence||'planning_estimate'};resolved++;
  }
  engine.setTripStory?.(JSON.parse(JSON.stringify(story)));applyTripStoryToCompatibility(story);renderTripStorySummary();
  if(plannerState)plannerState.travelModelV2=_currentTravelModelV2_();
  console.info('[ITBMO ROUTE RESOLVER] resolved',resolved,story);
  return {ok:true,resolved};
}

function applyTripStoryToCompatibility(story){const stays=(story?.stays||[]).map(_tripStoryEnsureStay_);if(!stays.length)return;const first=stays[0],last=stays.at(-1),firstCountry=_tripStoryCountryFromCode_(first.countryCode),totalDays=Math.max(1,_tripStoryDiffDays_(first.startDate,_tripStoryStayEnd_(last))+1);$cityList.innerHTML='';addCityRow({city:first.place,country:firstCountry?.label||first.country||'',days:totalDays,baseDate:_tripStoryDMY_(first.startDate)});const row=qs('.city-row',$cityList);if(!row)return;const segments=[];for(let i=1;i<stays.length;i++){const prev=stays[i-1],st=stays[i];segments.push({id:`story_move_${st.id}`,origin:prev.place,destination:st.place,departureDate:st.departureDate||st.startDate,arrivalDate:st.arrivalDate||st.startDate,departureTime:st.departureTime||'',arrivalTime:st.arrivalTime||'',transportMode:st.transportMode||'recommend',timePrecision:(st.departureTime&&st.arrivalTime)?'exact':'unknown',disposition:'continue',nights:Number(st.days||1),source:'TRIP_STORY'});}stays.forEach(st=>(st.dayTrips||[]).forEach(dt=>{if(!dt.place)return;const date=_tripStoryAddDays_(st.startDate,dt.day-1);segments.push({id:`story_daytrip_${dt.id}`,origin:st.place,destination:dt.place,departureDate:date,arrivalDate:date,departureTime:dt.outbound.departureTime||'',arrivalTime:dt.outbound.arrivalTime||'',returnDepartureDate:date,returnDepartureTime:dt.return.departureTime||'',returnArrivalDate:date,returnArrivalTime:dt.return.arrivalTime||'',returnDestination:st.place,transportMode:dt.outbound.transportMode||'recommend',returnTransportMode:dt.return.transportMode||dt.outbound.transportMode||'recommend',timePrecision:(dt.outbound.departureTime&&dt.outbound.arrivalTime&&dt.return.departureTime&&dt.return.arrivalTime)?'exact':'unknown',disposition:'roundtrip',source:'TRIP_STORY_DAYTRIP'});}));_travelV2()?.setRouteSegments?.(row,segments);const days=qs('.days',row);if(days){days.innerHTML=Array.from({length:MAX_TRIP_STORY_DAYS},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join('');days.value=String(totalDays);days.dispatchEvent(new Event('change',{bubbles:true}));}const base=qs('.baseDate',row);if(base)base.value=_tripStoryDMY_(first.startDate);const dates=Array.from({length:totalDays},(_,i)=>_tripStoryAddDays_(first.startDate,i));const perDay=dates.map((date,idx)=>{const st=stays.find(x=>date>=x.startDate&&date<=_tripStoryStayEnd_(x))||stays[Math.max(0,stays.findIndex(x=>x.startDate>date)-1)]||first;const di=Math.max(0,_tripStoryDiffDays_(st.startDate,date));return {day:idx+1,date,start:st.perDay?.[di]?.start||'',end:st.perDay?.[di]?.end||'',physicalDestination:st.place};});qsa('.hours-day',row).forEach((hd,idx)=>{if(!perDay[idx])return;const a=qs('.start',hd),b=qs('.end',hd);if(a)a.value=perDay[idx].start;if(b)b.value=perDay[idx].end;});_travelV2()?.renderRowSummary?.(row);updateAddCityButtonState();updateTravelBuilderProgress();}


// Inicialización
document.addEventListener('DOMContentLoaded', ()=>{
  syncPlannerLanguageShell();
  if(!document.querySelector('#city-list .city-row')) addCityRow();
  qs('#build-trip-story')?.addEventListener('click',openTripStoryBuilder);
  qs('#build-guided-journey')?.addEventListener('click',openTripStoryBuilder);
  renderTripStorySummary();

  // Security/UX default: Planner is locked before any async session restore.
  applyAuthPlannerGate(false);

  initializePlannerSessionLifecycle();
  bindAccountListeners();
  bindJourneyHome();
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
  bindNewPlanningListener();
  initAstraCoach();
});
