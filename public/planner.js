/* =========================================================
   ✅ v59 (quirúrgico) — Idioma (Opción B)
   - Fuente primaria: <html lang="en|es">
   - Fallback: ruta URL (/es o /en) si el lang no está definido o es raro
   - Guarda idioma normalizado en plannerState.lang
========================================================= */

/* ==============================
   SECCIÓN 1 · Helpers / Estado
================================= */

/* ---------- Helpers DOM ---------- */
const qs  = (s, ctx=document)=>ctx.querySelector(s);
const qsa = (s, ctx=document)=>Array.from(ctx.querySelectorAll(s));

/* ---------- Config API ---------- */
const API_URL = 'https://itravelbymyown-api.vercel.app/api/chat';
const MODEL   = 'gpt-4o-mini';

/* ---------- Estado principal ---------- */
let savedDestinations = [];      // [{ city, country, days, baseDate, perDay:[{day,start,end}] }]

// 🧠 itineraries soporta originalDays para rebalanceos selectivos
let itineraries = {};            // { [city]: { byDay:{[n]:Row[]}, currentDay, baseDate, originalDays } }
let cityMeta = {};               // { [city]: { baseDate, start, end, hotel, transport, perDay:[] } }

let session = [];                // historial para el agente principal
let infoSession = [];            // historial separado para Info Chat
let activeCity = null;

/* ---------- Flags de flujo ---------- */
let planningStarted = false;
let metaProgressIndex = 0;
let collectingHotels = false;
let isItineraryLocked = false;

let pendingChange = null;
let hasSavedOnce = false;

/* ---------- Defaults técnicos (NO rígidos) ---------- */
// Fallback solo si el agente no trae horas
const DEFAULT_START = '';
const DEFAULT_END   = '';

/* ---------- Estado persistente del planner ---------- */
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
  budget: '',
  currency: 'USD',
  lang: 'en' // se setea abajo
};

/* =========================================================
   🌐 Idioma del planner — Opción B (MVP)
   - Fuente primaria: <html lang="en|es">
   - Fallback: pathname (/en /es)
   - Default seguro: en
========================================================= */
(function initPlannerLang(){
  const normalize = (v)=>{
    const s = String(v || '').trim().toLowerCase();
    if(!s) return '';
    const base = s.split(/[-_]/)[0];
    return (base === 'es' || base === 'en') ? base : '';
  };

  // 1) <html lang="">
  let lang = normalize(document?.documentElement?.getAttribute('lang'));

  // 2) URL fallback (/es o /en)
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

/* =========================================================
   🌐 i18n (EN/ES) — QUIRÚRGICO
   - Usa plannerState.lang como fuente
   - t(key) con fallback a EN
========================================================= */
const I18N = {
  es: {
    hi: '¡Hola! Soy Astra ✨, tu concierge de viajes. Vamos a crear itinerarios inolvidables 🌍',
    askHotelTransport: (city)=>`Para <strong>${city}</strong>, dime tu <strong>hotel/zona</strong> y el <strong>medio de transporte</strong> (alquiler, público, taxi/uber, combinado o “recomiéndame”).`,
    confirmAll: '✨ Listo. Empiezo a generar tus itinerarios…',
    doneAll: '🎉 Itinerarios generados. Si deseas cambiar algo, solo escríbelo y yo lo ajustaré por ti ✨ Para cualquier detalle específico —clima, transporte, ropa, seguridad y más— abre el Info Chat 🌐 y te daré toda la información que necesites.',
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
    overlayDefault: '✨ Astra está creando tu itinerario completo… Esto puede tardar varios minutos. No cierres esta pestaña: estás ahorrando horas de planificación.',
    overlayGenerating: 'Astra está generando itinerarios…',
    overlayRebalancingCity: 'Astra está reequilibrando la ciudad…',
    overlayRebalancing: 'Agregando días y reoptimizando…',

    // Tooltip fechas
    tooltipDateMissing: 'Por favor ingresa la fecha de inicio (DD/MM/AAAA) para cada ciudad 🗓️',

    // Reset modal
    resetTitle: '¿Reiniciar planificación? 🧭',
    resetBody: 'Esto eliminará todos los destinos, itinerarios y datos actuales.<br><strong>No se podrá deshacer.</strong>',
    resetConfirm: 'Sí, reiniciar',
    resetCancel: 'Cancelar',

    // Travelers UI
    travelerLabel: (n)=>`Viajero ${n}`,
    travelerCompanion: 'Acompañante',
    travelerGender: 'Género',
    travelerAgeRange: 'Rango de edad',
    genderFemale: 'Femenino',
    genderMale: 'Masculino',
    genderOther: 'Otro',
    genderNA: 'Prefiero no decirlo',
    ageBaby: 'Bebé (0–2)',
    agePreschool: 'Preescolar (3–5)',
    ageChild: 'Niño (6–12)',
    ageTeen: 'Adolescente (13–17)',
    ageYoungAdult: 'Joven adulto (18–24)',
    ageAdult2539: 'Adulto (25–39)',
    ageAdult4054: 'Adulto (40–54)',
    ageAdult5564: 'Adulto (55–64)',
    ageSenior: 'Mayor (65+)',

    // Fallback local
    fallbackLocal: '⚠️ Fallback local: revisa configuración de Vercel o API Key.'
  },

  en: {
    hi: 'Hi! I’m Astra ✨, your travel concierge. Let’s build unforgettable itineraries 🌍',
    askHotelTransport: (city)=>`For <strong>${city}</strong>, tell me your <strong>hotel/area</strong> and your <strong>transport</strong> (rental, public transit, taxi/uber, mixed, or “recommend”).`,
    confirmAll: '✨ Great. I’m starting to generate your itineraries…',
    doneAll: '🎉 Itineraries generated. If you want to change anything, just tell me and I’ll adjust it ✨ For any specific details—weather, transport, clothing, safety and more—open the Info Chat 🌐 and I’ll help you with everything you need.',
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
    overlayDefault: '✨ Astra is creating your full itinerary… This may take a few minutes. Don’t close this tab: you’re saving hours of planning.',
    overlayGenerating: 'Astra is generating itineraries…',
    overlayRebalancingCity: 'Astra is rebalancing the city…',
    overlayRebalancing: 'Adding days and re-optimizing…',

    // Tooltip fechas
    tooltipDateMissing: 'Please enter the start date (DD/MM/YYYY) for each city 🗓️',

    // Reset modal
    resetTitle: 'Reset planning? 🧭',
    resetBody: 'This will delete all destinations, itineraries, and current data.<br><strong>This cannot be undone.</strong>',
    resetConfirm: 'Yes, reset',
    resetCancel: 'Cancel',

    // Travelers UI
    travelerLabel: (n)=>`Traveler ${n}`,
    travelerCompanion: 'Companion',
    travelerGender: 'Gender',
    travelerAgeRange: 'Age range',
    genderFemale: 'Female',
    genderMale: 'Male',
    genderOther: 'Other',
    genderNA: 'Prefer not to say',
    ageBaby: 'Baby (0–2)',
    agePreschool: 'Preschool (3–5)',
    ageChild: 'Child (6–12)',
    ageTeen: 'Teen (13–17)',
    ageYoungAdult: 'Young adult (18–24)',
    ageAdult2539: 'Adult (25–39)',
    ageAdult4054: 'Adult (40–54)',
    ageAdult5564: 'Adult (55–64)',
    ageSenior: 'Senior (65+)',

    // Fallback local
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

/* ==============================
   SECCIÓN 2 · Tono / Mensajería
================================= */
// ✅ QUIRÚRGICO: evita que el planner reviente si el JS se carga más de una vez en Webflow
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

/* ==============================
   SECCIÓN 3 · Referencias DOM
   (v55.1 añade soporte al botón flotante del Info Chat)
================================= */
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
// Nota: en el MVP quitamos el botón #info-chat-toggle del HTML (queda null y NO rompe).
const $infoToggle   = qs('#info-chat-toggle');
const $infoModal    = qs('#info-chat-modal');
const $infoInput    = qs('#info-chat-input');
const $infoSend     = qs('#info-chat-send');
const $infoClose    = qs('#info-chat-close');
const $infoMessages = qs('#info-chat-messages');
// 🆕 Botón flotante (se mantiene como ÚNICO botón en el MVP)
const $infoFloating = qs('#info-chat-floating');

// 🆕 Sidebar y botón reset
const $sidebar = qs('.sidebar');
const $resetBtn = qs('#reset-planner');

/* 🆕 Viajeros (nuevo UI compacto MVP) */
const $travelerMode      = qs('#traveler-mode');
const $travelerSoloPanel = qs('#traveler-solo-panel');
const $travelerGroupPanel= qs('#traveler-group-panel');

const $soloGender   = qs('#solo-gender');
const $soloAgeRange = qs('#solo-age-range');

const $travelerProfiles = qs('#traveler-profiles');
const $travelerAdd      = qs('#traveler-add');
const $travelerRemove   = qs('#traveler-remove');

/* 🆕 Export buttons (PDF / CSV / Email) */
const $btnPDF   = qs('#btn-pdf');
const $btnCSV   = qs('#btn-csv');
const $btnEmail = qs('#btn-email');

/* ==============================
   SECCIÓN 4 · Chat UI + “Pensando…”
================================= */
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

/* ==============================
   SECCIÓN 4B · Info Chat UI (mejorada estilo ChatGPT)
================================= */
function infoChatMsg(html, who='ai'){
  if(!html) return;
  const div = document.createElement('div');
  div.className = `chat-message ${who==='user'?'user':'ai'}`;
  // ✅ Soporte visual para saltos de línea en el mensaje
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

// ✅ Mejora UX del textarea
if($infoInput){
  $infoInput.setAttribute('rows','1');
  $infoInput.style.overflowY = 'hidden';
  const maxRows = 10;

  // Autoajuste de altura dinámico
  $infoInput.addEventListener('input', ()=>{
    $infoInput.style.height = 'auto';
    const lineHeight = parseFloat(window.getComputedStyle($infoInput).lineHeight) || 20;
    const lines = Math.min($infoInput.value.split('\n').length, maxRows);
    $infoInput.style.height = `${lineHeight * lines + 8}px`;
    $infoInput.scrollTop = $infoInput.scrollHeight;
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

/* ==============================
   SECCIÓN 5 · Fechas / horas
================================= */
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

// ✅ Parser flexible (quirúrgico): acepta DD/MM/YYYY y MM/DD/YYYY sin romper el flujo.
// - Se prefiere DD/MM cuando ambos son válidos.
function parseDMY(str){
  if(!str) return null;
  const m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(str.trim());
  if(!m) return null;

  const a = parseInt(m[1],10);
  const b = parseInt(m[2],10);
  const y = parseInt(m[3],10);

  // Intento 1: DD/MM
  const d1 = new Date(y, (b-1), a);
  const ok1 = (d1.getFullYear()===y && d1.getMonth()===(b-1) && d1.getDate()===a);

  // Intento 2: MM/DD
  const d2 = new Date(y, (a-1), b);
  const ok2 = (d2.getFullYear()===y && d2.getMonth()===(a-1) && d2.getDate()===b);

  if(ok1 && ok2){
    // Ambos válidos (ej. 02/03/2026). Preferimos DD/MM por UI (LatAm).
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

/* ==============================
   SECCIÓN 6 · UI ciudades (sidebar)
================================= */
function makeHoursBlock(days){
  const wrap = document.createElement('div');
  wrap.className = 'hours-block';

  // 🆕 Guía de horarios
  const guide = document.createElement('p');
  guide.className = 'time-hint';
  guide.textContent = t('uiTimeHint');
  wrap.appendChild(guide);

  // Encabezado único de horas
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

function addCityRow(pref={city:'',country:'',days:'',baseDate:''}){
  // ✅ QUIRÚRGICO: evita que el planner “reviente” si #city-list no existe
  if(!$cityList){
    console.error('[ITBMO] #city-list no encontrado. No se puede insertar city-row.');
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

  // ✅ QUIRÚRGICO: si .baseDate no existe (HTML cambió), NO romper addCityRow()
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

  qs('.remove',row).addEventListener('click', ()=> row.remove());
  $cityList.appendChild(row);
}

/* =========================================================
   ITRAVELBYMYOWN · PLANNER v56 (parte 2/3)
   Base: v55.1
   Cambios mínimos:
   - Bloqueo sidebar y botón reset al guardar destinos.
   - Bloqueo del botón flotante Info Chat.
========================================================= */

/* ==============================
   SECCIÓN 7 · Guardar destinos
================================= */
function saveDestinations(){
  const rows = qsa('.city-row', $cityList);
  const list = [];

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

  // 🧠 Detección de aumento de días y limpieza itinerario
  list.forEach(({city, days})=>{
    const prevDays = itineraries[city] ? Object.keys(itineraries[city].byDay).length : 0;
    if(prevDays && days > prevDays){
      // Limpiar estructura existente para evitar duplicados
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
    if(!itineraries[city]) itineraries[city] = { byDay:{}, currentDay:1, baseDate: baseDate||null };
    if(!cityMeta[city]) cityMeta[city] = { baseDate: baseDate||null, start:null, end:null, hotel:'', transport:'', perDay: perDay||[] };
    else {
      cityMeta[city].baseDate = baseDate||null;
      cityMeta[city].perDay   = perDay||[];
    }
    for(let d=1; d<=days; d++){
      if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[];
    }
  });

  // Limpia ciudades eliminadas
  Object.keys(itineraries).forEach(c=>{ 
    if(!savedDestinations.find(x=>x.city===c)) delete itineraries[c]; 
  });
  Object.keys(cityMeta).forEach(c=>{ 
    if(!savedDestinations.find(x=>x.city===c)) delete cityMeta[c]; 
  });

  renderCityTabs();

  // ✅ Activar/desactivar botón de iniciar planificación
  $start.disabled = savedDestinations.length === 0;
  hasSavedOnce = true;

  // ✅ Habilitar botón "Reiniciar" solo si hay destinos guardados
  if ($resetBtn) {
    if (savedDestinations.length > 0) {
      $resetBtn.removeAttribute('disabled');
    } else {
      $resetBtn.setAttribute('disabled', 'true');
    }
  }

  // ✅ Bloquear sidebar
  if ($sidebar) $sidebar.classList.add('disabled');

  // ✅ Bloquear botón flotante Info Chat
  if ($infoFloating) {
    $infoFloating.style.pointerEvents = 'none';
    $infoFloating.style.opacity = '0.6';
  }

  // 🧠 ACTUALIZAR PLANNERSTATE — Bloque ya existente
  if (typeof plannerState !== 'undefined') {
    plannerState.destinations = [...savedDestinations];
    plannerState.specialConditions = (qs('#special-conditions')?.value || '').trim();
    plannerState.travelers = {
      adults: Number(qs('#p-adults')?.value || 0),
      young: Number(qs('#p-young')?.value || 0),
      children: Number(qs('#p-children')?.value || 0),
      infants: Number(qs('#p-infants')?.value || 0),
      seniors: Number(qs('#p-seniors')?.value || 0),
    };
    plannerState.budget = qs('#budget')?.value || '';
    plannerState.currency = qs('#currency')?.value || 'USD';
  }
}

/* ==============================
   SECCIÓN 8 · Tabs + Render
================================= */
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

/* ==============================
   SECCIÓN 9 · Render Itinerario
================================= */
function renderCityItinerary(city){
  if(!city || !itineraries[city]) return;
  const data = itineraries[city];
  const days = Object.keys(data.byDay||{}).map(n=>+n).sort((a,b)=>a-b);

  $itWrap.innerHTML = '';
  if(!days.length){
    $itWrap.innerHTML = `<p>${t('uiNoActivities')}</p>`;
    return;
  }

  const base = parseDMY(data.baseDate || cityMeta[city]?.baseDate || '');
  const sections = [];

  function formatDurationForDisplay(val){
    if(!val) return '';
    const s = String(val).trim();
    const m = s.match(/^(\d+(?:\.\d+)?)\s*m$/i);
    if(m){
      const minutes = parseFloat(m[1]);
      const hours = minutes / 60;
      return (Number.isInteger(hours) ? `${hours}h` : `${hours}h`);
    }
    return s;
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
        <td>${formatDurationForDisplay(r.duration||'')}</td>
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
}

/* ==============================
   SECCIÓN 10 · Snapshot + Intake
================================= */
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

/* ==============================
   SECCIÓN 11 · Contrato JSON / LLM (reforzado v49) — v58 robustecido (reglas API v52.5)
================================= */
const FORMAT = `
Devuelve SOLO JSON válido (sin markdown) en uno de estos:

A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}]}], "followup":"Pregunta breve"}

B) {"destination":"City","rows":[{...}],"replace":false,"followup":"Pregunta breve"}

C) {"rows":[{...}],"replace":false,"followup":"Pregunta breve"}

D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" | ["HH:MM",...],"end":"HH:MM" | ["HH:MM",...],"hotel":"Texto","transport":"Texto"},"followup":"Pregunta breve"}

Reglas (obligatorias, alineadas con API v52.5):

- Responde SIEMPRE en el MISMO idioma del texto real del usuario (lo que el usuario escribió), independientemente del idioma del sitio (EN/ES).
- Devuelve SIEMPRE al menos 1 fila renderizable en "rows". Nada de texto fuera del JSON.
- Máximo 20 filas por día.
- Optimiza el/los día(s) afectado(s) (min traslados, agrupa por zonas, respeta ventanas).
- Usa horas por día del usuario; si faltan, sugiere horas realistas (apertura/cierre). No solapes.
- Valida PLAUSIBILIDAD GLOBAL (geografía, temporada, clima aproximado, logística).
- Seguridad y restricciones:
  • No incluyas actividades en zonas con riesgos relevantes o restricciones evidentes; prefiera alternativas seguras.
  • Si detectas un posible riesgo/aviso, indica en "notes" un aviso breve (sin alarmismo) o sustituye por alternativa segura.

Campos obligatorios por fila (NO vacíos):
- "activity","from","to","transport","duration","notes" deben tener texto útil. Prohibido "seed" y notes vacías.

Formato de activity (obligatorio cuando aplique a itinerario):
- "Destino – SUB-parada" (– o - con espacios). Evita genéricos tipo "museo", "parque", "restaurante local", "paseo por la ciudad".

Formato de duration (obligatorio, tabla-ready):
- 2 líneas EXACTAS con salto \\n:
  "Transporte: <estimación realista o ~rango>"
  "Actividad: <estimación realista o ~rango>"
- PROHIBIDO: "Transporte: 0m" o "Actividad: 0m"
- NO usar comas para separar Transporte/Actividad.

Comidas (regla flexible):
- NO son obligatorias. Si se incluyen, NO genéricas ("restaurante local" prohibido). Deben aportar valor.

Auroras (solo si plausibles por latitud/temporada):
- Evitar días consecutivos si hay opciones. Evitar el último día; si SOLO cabe ahí, marcar condicional.
- Debe ser nocturno típico local.
- En notes incluir: "valid: <justificación breve>" + referencia a clima/nubosidad + alternativa low-cost cercana.

Day trips / Macro-tours:
- Si propones excursión/day trip, desglosa en 5–8 sub-paradas (filas).
- Cierra con fila propia: "Regreso a {Ciudad base}".
- Evitar macro-tours en el último día si hay opciones.

Conserva lo existente por defecto (fusión); NO borres lo actual salvo instrucción explícita (replace=true).

`;

/* ==============================
   SECCIÓN 12 · Llamada a Astra (estilo global)
================================= */
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
- If the user doesn't specify a specific day, review and adjust the entire city's itinerary, avoiding duplicates and absurd plans.

Itinerary rules (aligned with API v52.5):
- Max 20 rows per day.
- Non-empty fields: activity/from/to/transport/duration/notes (no "seed").
- Prefer activity format: "DESTINATION – Specific sub-stop" (avoid generic).
- duration must be 2 lines with \\n:
  "Transport: ...\\nActivity: ..."
  (no 0m, and do not use commas to separate).
- Meals: not mandatory; if included, not generic.
- Day trips: if adding days, consider 1-day excursions to nearby must-sees (≤2h each way guideline) and include them if they fit, with return to base city.
- Macro-tours/day trips: 5–8 sub-stops + final row "Return to {Base city}". Avoid last day if there are options.

Auroras (only if plausible by latitude/season):
- Avoid consecutive nights if possible. Avoid last day; if only possible there, mark conditional.
- Must be nighttime local.
- Notes include: "valid:" + clouds/weather + low-cost nearby alternative.

Safety:
- Don't propose activities in areas with relevant risks, impossible hours, or obvious restrictions.
- Prefer safe, reasonable routes and experiences.
- If there's a reasonable warning, substitute with a safer alternative or note it briefly.

Edits:
- For edits: return the JSON per contract and merge by default (replace=false).
`.trim();

  // ✅ QUIRÚRGICO: timeout para evitar que "se pegue y no genere" en producción
  const controller = new AbortController();
  const timeoutMs = 130000; // 130s (ajustable)
  const timer = setTimeout(()=>controller.abort(), timeoutMs);

  try{
    showThinking(true);

    // ✅ QUIRÚRGICO (CRÍTICO): no mezclar globalStyle dentro del "user input"
    // para no forzar idioma. globalStyle va como "system".
    const messages = [
      { role:'system', content: globalStyle },
      ...(Array.isArray(history) ? history : []),
      { role:'user', content: String(text || '') }
    ];

    const res = await fetch(API_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      signal: controller.signal,
      // ✅ QUIRÚRGICO: fuerza modo planner (API v58 default planner, pero lo fijamos para robustez)
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
    console.error("Fallo al contactar la API:", e);
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
You are "Astra", a general-purpose assistant (like ChatGPT) for travel-related questions.

GOAL:
- Answer informational questions (weather, visas, mobility, safety, budget, plugs, best season, etc.) clearly and actionably.
- Consider basic safety factors: mention relevant risks or obvious restrictions when applicable.
- Do NOT output JSON. Output plain text.

LANGUAGE (CRITICAL):
- Reply in the same language as the user's message (any language). Ignore system/template labels.
`.trim();

  // ✅ QUIRÚRGICO: timeout también para Info Chat (evita cuelgues)
  const controller = new AbortController();
  const timeoutMs = 45000; // 45s (ajustable)
  const timer = setTimeout(()=>controller.abort(), timeoutMs);

  try{
    setInfoChatBusy(true);

    // ✅ QUIRÚRGICO (CRÍTICO): system separado para no forzar idioma
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
        mode: 'info'
      })
    });

    if(!res.ok){
      const raw = await res.text().catch(()=> '');
      console.error('API error (info):', res.status, res.statusText, raw);
      return tone.fail;
    }

    const data = await res.json().catch(()=>({text:''}));
    const answer = (data?.text || '').trim();

    infoSession.push({ role:'user',      content: text });
    infoSession.push({ role:'assistant', content: answer });

    if (/^\s*\{/.test(answer)) {
      try {
        const j = JSON.parse(answer);
        if (j?.destination || j?.rows || j?.followup) {
          return 'No pude traer la respuesta del Info Chat correctamente. Verifica tu API Key/URL en Vercel o vuelve a intentarlo.';
        }
      } catch { /* no-op */ }
    }

    return answer || '¿Algo más que quieras saber?';
  }catch(e){
    const isAbort = (e && (e.name === 'AbortError' || String(e).toLowerCase().includes('abort')));
    console.error("Fallo Info Chat:", e);
    if(isAbort) return '⚠️ El Info Chat tardó demasiado (timeout). Intenta de nuevo.';
    return tone.fail;
  }finally{
    clearTimeout(timer);
    setInfoChatBusy(false);
  }
}

/* ==============================
   SECCIÓN 13 · Merge / utilidades
================================= */
function dedupeInto(arr, row){
  const key = o => [o.day,o.start||'',o.end||'',(o.activity||'').toLowerCase().trim()].join('|');
  const has = arr.find(x=>key(x)===key(row));
  if(!has) arr.push(row);
}
function ensureDays(city){
  if(!itineraries[city]) itineraries[city]={byDay:{},currentDay:1,baseDate:null};
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

// ✅ QUIRÚRGICO: helpers locales para evitar filas paraguas y duraciones inválidas
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
function _sumApproxMinutesFromDuration_(txt){
  const s = String(txt||'');
  if(!s.trim()) return null;

  const matches = [...s.matchAll(/~?\s*(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins)\b/ig)];
  if(!matches.length) return null;

  let total = 0;
  for(const mm of matches){
    const val = parseFloat(mm[1]);
    const unit = String(mm[2]||'').toLowerCase();
    if(!Number.isFinite(val)) continue;
    if(unit.startsWith('h')) total += Math.round(val * 60);
    else total += Math.round(val);
  }
  return total > 0 ? total : null;
}
function _sanitizeDurationLines_(raw){
  let s = (typeof raw === 'number') ? `${raw}m` : String(raw||'').trim();

  if (s && /Transporte\s*:/i.test(s) && /Actividad\s*:/i.test(s) && s.includes(',')) {
    s = s.replace(/\s*,\s*Actividad\s*:/i, '\nActividad:');
  }
  if (s && /Transport\s*:/i.test(s) && /Activity\s*:/i.test(s) && s.includes(',')) {
    s = s.replace(/\s*,\s*Activity\s*:/i, '\nActivity:');
  }

  if(!s){
    return 'Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat';
  }

  // ✅ Evita 0m / ~0m
  s = s.replace(/(Transporte|Transport)\s*:\s*~?0m\b/gi, '$1: ~10m');
  s = s.replace(/(Actividad|Activity)\s*:\s*~?0m\b/gi, '$1: ~10m');

  return s;
}

function normalizeRow(r = {}, fallbackDay = 1){
  let start   = r.start ?? r.start_time ?? r.startTime ?? r.hora_inicio ?? '';
  let end     = r.end   ?? r.end_time   ?? r.endTime   ?? r.hora_fin    ?? '';
  const act   = r.activity ?? r.title ?? r.name ?? r.descripcion ?? r.descripcion_actividad ?? '';
  const from  = r.from ?? r.origin ?? r.origen ?? '';
  const to    = r.to   ?? r.destination ?? r.destino ?? '';
  const trans = r.transport ?? r.transportMode ?? r.modo_transporte ?? '';
  const durRaw= r.duration ?? r.durationMinutes ?? r.duracion ?? '';
  const notes = r.notes ?? r.nota ?? r.comentarios ?? '';

  let duration = _sanitizeDurationLines_(durRaw);
  const d = Math.max(1, parseInt(r.day ?? r.dia ?? fallbackDay, 10) || 1);

  const startStr = String(start||'').trim();
  const endStr   = String(end||'').trim();

  let startMin = _hhmmToMinutes_(startStr);
  let endMin   = _hhmmToMinutes_(endStr);

  // ✅ Si falta una hora, intenta inferirla desde duration (en vez de forzar defaults)
  const approxDur = _sumApproxMinutesFromDuration_(duration);
  if(startMin != null && endMin == null && approxDur){
    endMin = startMin + Math.max(approxDur, 30);
  }else if(startMin == null && endMin != null && approxDur){
    startMin = Math.max(0, endMin - Math.max(approxDur, 30));
  }

  // ✅ Anti-umbrella: si la fila ocupa muchísimo más que su duración real, comprímela
  if(startMin != null && endMin != null && approxDur){
    let span = endMin - startMin;
    if(span <= 0) span += 24*60;

    // si el bloque es exageradamente mayor que la duración real, corrige el end
    if(span >= Math.max(240, approxDur * 2.2)){
      const compressed = Math.min(Math.max(approxDur + 15, 30), 210); // buffer ligero, sin exagerar
      endMin = startMin + compressed;
    }
  }

  // ✅ Fallback final: solo si sigue faltando algo, entonces sí usa defaults
  if(startMin == null && endMin == null){
    startMin = _hhmmToMinutes_(DEFAULT_START);
    endMin   = _hhmmToMinutes_(DEFAULT_END);
  }else if(startMin != null && endMin == null){
    endMin = startMin + 90;
  }else if(startMin == null && endMin != null){
    startMin = Math.max(0, endMin - 90);
  }

  // ✅ Garantiza consistencia mínima
  let finalSpan = endMin - startMin;
  if(finalSpan <= 0) finalSpan += 24*60;
  if(finalSpan < 15){
    endMin = startMin + 30;
  }

  const finalStart = _minutesToHHMM_(startMin);
  const finalEnd   = _minutesToHHMM_(endMin);

  // ✅ QUIRÚRGICO: guard-rails locales anti-campos-vacíos (fail-open)
  const safeActivity  = (String(act||'').trim() || 'Actividad por definir');
  const safeFrom      = (String(from||'').trim() || 'Hotel');
  const safeTo        = (String(to||'').trim() || 'Centro');
  const safeTransport = (String(trans||'').trim() || 'A pie o Transporte local');
  const n0 = String(notes||'').trim();
  const safeNotes = (n0 && n0.toLowerCase()!=='seed') ? n0 : 'Sugerencia: verifica horarios, seguridad básica y reserva con antelación.';

  return {
    day:d,
    start: finalStart || DEFAULT_START,
    end: finalEnd || DEFAULT_END,
    activity:safeActivity,
    from:safeFrom,
    to:safeTo,
    transport:safeTransport,
    duration:duration,
    notes:safeNotes
  };
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
  if(!itineraries[city]) itineraries[city] = {byDay:{},currentDay:1,baseDate:cityMeta[city]?.baseDate||null};

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
  if(typeof meta.hotel==='string') cityMeta[name].hotel = meta.hotel;
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

  // 🧠 Detectar forceReplan si aplica y ajustar replace
  let forceReplanCity = null;
  if (typeof plannerState !== 'undefined' && plannerState.forceReplan) {
    const candidate = parsed.destination || parsed.city || parsed.meta?.city;
    if (candidate && plannerState.forceReplan[candidate]) {
      forceReplanCity = candidate;
    }
  }

  // ✅ soporte quirúrgico para formato preferido city_day
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

      // ✅ limpiar flag una vez utilizado
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

/* ==============================
   SECCIÓN 13B · Add Multiple Days (mejorada con rebalanceo inteligente por rango)
================================= */
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

  // 📝 Actualizar cantidad total de días en destino
  const dest = savedDestinations.find(x=>x.city===city);
  let newLastDay = currentMax + extraDays;
  if(dest){
    dest.days = newLastDay;
  }

  // 🧭 Definir rango de rebalanceo: incluye último día original
  const rebalanceStart = Math.max(1, lastOriginalDay);
  const rebalanceEnd = newLastDay;

  // 🧭 Marcar replanificación para el agente
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

/* ==============================
   SECCIÓN 14 · Validación GLOBAL (2º paso con IA) — reforzado
   (ajuste quirúrgico: menos reglas duras, más criterio experto)
================================= */
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
- Máx. 20 filas por día; prioriza icónicas y evita redundancias.
- Activity (guía suave):
  • Prefiere el formato "Destino – Sub-parada específica" si aplica.
    - "Destino" NO es siempre la ciudad: si una fila pertenece a un day trip/macro-tour, "Destino" debe ser el nombre del macro-tour (ej. "Círculo Dorado", "Costa Sur", "Toledo").
    - Si NO es day trip, "Destino" puede ser la ciudad.
  • Evita genéricos tipo "tour" o "museo" sin especificar, cuando sea fácil concretar.
- From/To (muy importante):
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
/* ==============================
   SECTION 15A · UI + idioma + normalización base + extracción
================================= */
function setOverlayMessage(msg=t('overlayDefault')){
  const p = $overlayWOW?.querySelector('p');
  if(p) p.textContent = msg;
}

function showWOW(on, msg){
  if(!$overlayWOW) return;
  if(msg) setOverlayMessage(msg);
  $overlayWOW.style.display = on ? 'flex' : 'none';

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
}

/* =========================================================
   ✅ SURGICAL (CRITICAL): preserve user's language
========================================================= */
function _lastUserFromSession_(){
  try{
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

  const sc = (typeof plannerState !== 'undefined' && plannerState)
    ? String(plannerState?.specialConditions || '').trim()
    : '';
  if(sc) return sc;

  const sc2 = (typeof qs !== 'undefined')
    ? String(qs('#special-conditions')?.value || '').trim()
    : '';
  if(sc2) return sc2;

  const last = _lastUserFromSession_();
  if(last) return last;

  return (getLang()==='es') ? 'Please generate the itinerary.' : 'Please generate the itinerary.';
}

async function _callPlannerSystemPrompt_(systemPrompt, useHistory=true){
  const history = useHistory ? session : [];

  const controller = new AbortController();
  const timeoutMs = 130000;
  const timer = setTimeout(()=>controller.abort(), timeoutMs);

  try{
    showThinking(true);

    const anchor = _userLanguageAnchor_();

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

// ✅ SURGICAL: keep blank day hours blank
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
   SECTION 15B · STAGED GENERATION HELPERS (master + blocks)
========================================================= */
function _extractMasterPlanDays_(parsed, city, totalDays){
  if(!parsed) return [];

  const rows = _extractPlannerRows_(parsed, city);
  if(!Array.isArray(rows) || !rows.length) return [];

  const out = [];
  const used = new Set();

  for(const r of rows){
    const day = parseInt(r?.day, 10);
    if(!(day >= 1 && day <= totalDays)) continue;
    if(used.has(day)) continue;

    const activity = String(r?.activity || '').trim();
    let theme = '';

    const match = activity.match(/^[^-–]+[–-]\s*(.+)$/);
    if(match && match[1]) theme = String(match[1]).trim();

    if(!theme) theme = activity;
    if(!theme) theme = String(r?.to || '').trim();
    if(!theme) theme = String(r?.notes || '').trim();
    if(!theme) continue;

    used.add(day);
    out.push({ day, theme });
  }

  if(out.length !== totalDays) return [];
  const unique = new Set(out.map(x=>x.day));
  if(unique.size !== totalDays) return [];

  return out.sort((a,b)=>a.day-b.day);
}

async function _buildCityMasterPlan_(city, totalDays, perDay, baseDate='', hotel='', transport='recommend me'){
  const prompt = `
${FORMAT}
**ROLE:** Planner “Astra”. Create a STRATEGIC DISTRIBUTION PLAN ONLY for "${city}" (${totalDays} day/s).
- Return Format B JSON: {"destination":"${city}","rows":[...]}.

MANDATORY:
- Create EXACTLY ${totalDays} rows total.
- Create EXACTLY ONE row per day (day 1 to day ${totalDays}).
- This is NOT the final itinerary. This is ONLY a strategic day-by-day plan.
- Each row represents the theme/purpose of that day.
- Use "activity" exactly like: "PLAN – <short strategic theme>".
- Keep themes realistic and well distributed across all days.
- Avoid empty/light/generic placeholder days unless the user's time window genuinely makes that necessary.
- If some day has a shorter window, make it lighter accordingly.
- If some day is a good candidate for a nearby excursion/day trip, assign that strategically.
- Keep the logic GLOBAL; do not depend on hardcoded destinations.
- Since this is only planning metadata:
  • "from" can be "Hotel"
  • "to" can be "City area"
  • "transport" can be "Planning"
  • "duration" can be "Transport: planning\\nActivity: planning"
  • "notes" should briefly justify the day theme
- Do NOT generate detailed sub-stops yet.
- Do NOT repeat the same main highlight/theme on different days unless the user explicitly requested repetition.
- Do NOT over-reuse the same urban area / neighborhood / cluster in multiple city days.

GLOBAL BALANCE RULE:
- First identify iconic highlights and strong regional day-trip rings around the base city.
- Then distribute them in the BEST balanced order for the trip.
- Do NOT force a rigid nearest-to-farthest sequence.
- For longer stays, prefer covering additional worthwhile rings before repeating previously used ones.
- If a special stop (spa, geothermal baths, marine life, scenic detour, etc.) fits naturally inside a regional ring, you may bundle it there when that improves coherence.
  Examples only: Blue Lagoon in a Reykjanes-style ring, Secret Lagoon in a Golden-Circle-style ring.

- Daily reference windows: ${JSON.stringify(perDay)}
- Base date: ${JSON.stringify(baseDate || '')}
- Hotel/base: ${JSON.stringify(hotel || '')}
- Preferred transport: ${JSON.stringify(transport || 'recommend me')}
- No text outside JSON.
`.trim();

  console.log(`[MASTER PLAN] Requesting strategic plan for ${city} (${totalDays} days)...`);
  const ans = await _callPlannerSystemPrompt_(prompt, false);
  const parsed = parseJSON(ans);
  const out = _extractMasterPlanDays_(parsed, city, totalDays);
  console.log(`[MASTER PLAN] ${out.length === totalDays ? 'OK' : 'FAIL'}`, out, parsed);
  return out;
}

function _chunkMasterDays_(days=[]){
  const arr = Array.isArray(days) ? days.slice().sort((a,b)=>a.day-b.day) : [];
  if(!arr.length) return [];

  const chunks = [];
  for(let i=0; i<arr.length; i+=2){
    chunks.push(arr.slice(i, i+2));
  }
  return chunks;
}

function _forceRowsIntoValidDayRange_(rows=[], allowedDays=[]){
  const allowed = new Set((allowedDays || []).map(d => Number(d)));
  return (rows || [])
    .map(r=>{
      let d = parseInt(r?.day, 10);
      if(!allowed.has(d)) d = Number(allowedDays?.[0] || 1);
      return normalizeRow({ ...r, day: d }, d);
    })
    .filter(r => allowed.has(Number(r?.day)));
}

function _hasUsableRowsForAllBlockDays_(rows=[], blockDays=[]){
  const set = new Set((rows||[]).map(r => Number(r?.day)));
  return (blockDays || []).every(d => set.has(Number(d)));
}

// 🆕 CRITICAL: only replace repaired days if ALL requested days were returned
function _rowsCoverRequestedDays_(rows=[], requestedDays=[]){
  const set = new Set((rows || []).map(r => Number(r?.day)));
  return (requestedDays || []).every(d => set.has(Number(d)));
}

/* =========================================================
   SECTION 15C · DUPLICATED HIGHLIGHTS BETWEEN DAYS — HELPERS
========================================================= */
function _normalizeHighlightKey_(value=''){
  return String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[þ]/g, 'th')
    .replace(/[ð]/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* =========================================================
   INTERNAL · semantic cluster normalization (GLOBAL)
   (Use ONLY for macro-zone logic, not for highlight de-dupe)
========================================================= */
function _normalizeSemanticClusterKey_(value=''){
  const s = _normalizeHighlightKey_(value);
  if(!s) return '';

  // Generic non-geographic placeholders / non-clusters
  if(
    /^(hotel|downtown|city area|restaurant|restaurante|almuerzo|cena|lunch|dinner|planning|return to|regreso a|departure from|salida desde)$/.test(s)
  ){
    return '';
  }

  // Typical macro-zone / regional-route patterns (GLOBAL)
  if(
    /\b(peninsula|península|coast|costa|route|ruta|loop|circuit|circuito|circle|circulo|círculo|island|isla|archipelago|archipielago|archipiélago|fjord|fiordo|lake|lago|lagoon|laguna|valley|valle|mountain|montana|montaña|volcano|volcan|volcán|park|parque|national park|parque nacional|district|distrito|region|región|canyon|cañon|cañón|wine area|wine region|harbor district|old town|historic center|centro historico|centro histórico|waterfront)\b/.test(s)
  ){
    return s;
  }

  // Generic excursion/tour/day-trip labels are too generic by themselves
  if(/^(day trip|excursion|excursión|tour|nature excursion|excursion a la naturaleza)$/.test(s)){
    return '';
  }

  return s;
}

/* =========================================================
   INTERNAL · specific place normalization
   (Use for highlight de-dupe; keep this SPECIFIC, not macro)
========================================================= */
function _normalizeSpecificPlaceKey_(value=''){
  let s = _normalizeHighlightKey_(value);
  if(!s) return '';

  s = s
    .replace(/\bdeparture from .*$/g, '')
    .replace(/\breturn to .*$/g, '')
    .replace(/\bregreso a .*$/g, '')
    .replace(/\bsalida desde .*$/g, '')
    .trim();

  return s;
}

function _extractHighlightKey_(row={}, city=''){
  const activity = String(row?.activity || '').trim();
  const to = String(row?.to || '').trim();
  const from = String(row?.from || '').trim();
  const cityKey = _normalizeHighlightKey_(city);

  const parts = activity.split(/\s+[–-]\s+/);
  const suffix = parts.length > 1 ? _normalizeHighlightKey_(parts[1]) : '';

  let candidate = '';

  // For exact highlight de-dupe, prefer the SPECIFIC sub-stop, not the macro label
  if(to){
    candidate = to;
  }else if(suffix && suffix !== cityKey){
    candidate = suffix;
  }else if(from && _normalizeHighlightKey_(from) !== cityKey){
    candidate = from;
  }else{
    candidate = activity;
  }

  const normalized = _normalizeSpecificPlaceKey_(candidate);
  if(!normalized) return '';

  if(/^(hotel|downtown|city area|return to|regreso a|departure from|salida desde|lunch|dinner|restaurant|restaurante|almuerzo|cena|planning|dark area|zona de observacion de auroras|aurora viewing area)$/.test(normalized)){
    return '';
  }

  return normalized;
}

function _extractUrbanClusterKey_(row={}, city=''){
  const activity = String(row?.activity || '').trim();
  const to = String(row?.to || '').trim();
  const cityKey = _normalizeHighlightKey_(city);

  const parts = activity.split(/\s+[–-]\s+/);
  const prefix = parts.length > 1 ? _normalizeHighlightKey_(parts[0]) : '';
  const suffix = parts.length > 1 ? _normalizeHighlightKey_(parts[1]) : '';

  // If clearly a macro-region outside the base city, do not treat as urban cluster
  const semanticPrefix = _normalizeSemanticClusterKey_(prefix);
  if(prefix && prefix !== cityKey && semanticPrefix) return '';

  let candidate = _normalizeHighlightKey_(to || suffix);
  if(!candidate) return '';

  if(/^(hotel|downtown|city area|restaurant|restaurante|almuerzo|cena|lunch|dinner|return to|regreso a)$/.test(candidate)) return '';

  // Global filter: do not treat obvious regional labels as urban clusters
  if(
    /\b(peninsula|península|coast|costa|route|ruta|loop|circuit|circuito|circle|circulo|círculo|island|isla|fjord|fiordo|lake|lago|lagoon|laguna|valley|valle|mountain|montana|montaña|volcano|volcan|volcán|park|parque|district|distrito|region|región|canyon|cañon|cañón)\b/.test(candidate)
  ){
    return '';
  }

  return candidate;
}

function _collectUsedHighlightKeys_(rows=[], city=''){
  const out = new Set();
  for(const r of (rows || [])){
    const key = _extractHighlightKey_(r, city);
    if(key) out.add(key);
  }
  return Array.from(out);
}

function _collectUsedUrbanClusterKeys_(rows=[], city=''){
  const out = new Set();
  for(const r of (rows || [])){
    const key = _extractUrbanClusterKey_(r, city);
    if(key) out.add(key);
  }
  return Array.from(out);
}

function _removeDuplicateHighlightsAcrossDays_(rows=[], city=''){
  const firstDayByKey = new Map();
  const out = [];

  for(const r of (rows || [])){
    const key = _extractHighlightKey_(r, city);
    const day = Number(r?.day || 1);

    if(!key){
      out.push(r);
      continue;
    }

    if(!firstDayByKey.has(key)){
      firstDayByKey.set(key, day);
      out.push(r);
      continue;
    }

    const firstDay = firstDayByKey.get(key);

    // Keep only exact place duplicates on the first day they appeared.
    // Do NOT use this to collapse whole macro-zones; that is handled below.
    if(firstDay === day){
      out.push(r);
    }
  }

  return out;
}

function _removeDuplicateUrbanClustersAcrossDays_(rows=[], city=''){
  const firstDayByKey = new Map();
  const out = [];

  for(const r of (rows || [])){
    const key = _extractUrbanClusterKey_(r, city);
    const day = Number(r?.day || 1);

    if(!key){
      out.push(r);
      continue;
    }

    if(!firstDayByKey.has(key)){
      firstDayByKey.set(key, day);
      out.push(r);
      continue;
    }

    const firstDay = firstDayByKey.get(key);

    if(firstDay === day){
      out.push(r);
    }
  }

  return out;
}

/* =========================================================
   SECTION 15C.2 · MACRO-ZONE DETECTION (GLOBAL)
========================================================= */
function _extractMacroZoneKey_(row={}, city=''){
  const activity = String(row?.activity || '').trim();
  const to = String(row?.to || '').trim();
  const from = String(row?.from || '').trim();
  const notes = String(row?.notes || '').trim();
  const cityKey = _normalizeHighlightKey_(city);

  const parts = activity.split(/\s+[–-]\s+/);
  const prefix = parts.length > 1 ? _normalizeHighlightKey_(parts[0]) : '';
  const suffix = parts.length > 1 ? _normalizeHighlightKey_(parts[1]) : '';

  // Direct semantic read from prefix when present
  let semantic = _normalizeSemanticClusterKey_(prefix);

  // If prefix is generic or city-like, infer from concrete stops / notes
  const genericPrefixes = new Set([
    _normalizeSemanticClusterKey_(cityKey),
    'day trip',
    'excursion',
    'excursión',
    'tour',
    'nature excursion',
    'excursion a la naturaleza',
    'planning'
  ]);

  if(!semantic || genericPrefixes.has(semantic) || semantic === cityKey){
    semantic = _normalizeSemanticClusterKey_(`${to} ${from} ${suffix} ${notes}`);
  }

  if(!semantic) return '';
  if(semantic === cityKey) return '';
  if(/^(return to|regreso a|departure from|salida desde)$/.test(semantic)) return '';

  // Only keep real macro-zones / regional circuits
  if(
    /\b(peninsula|península|coast|costa|route|ruta|loop|circuit|circuito|circle|circulo|círculo|island|isla|archipelago|archipielago|archipiélago|fjord|fiordo|lake|lago|lagoon|laguna|valley|valle|mountain|montana|montaña|volcano|volcan|volcán|park|parque|national park|parque nacional|district|distrito|region|región|canyon|cañon|cañón|wine area|wine region)\b/.test(semantic)
  ){
    return semantic;
  }

  return '';
}

function _findRepeatedMacroZoneDays_(rows=[], city=''){
  const firstDayByZone = new Map();
  const repeatedDays = new Set();

  for(const r of (rows || [])){
    const zone = _extractMacroZoneKey_(r, city);
    const day = Number(r?.day || 1);

    if(!zone) continue;

    if(!firstDayByZone.has(zone)){
      firstDayByZone.set(zone, day);
      continue;
    }

    const firstDay = firstDayByZone.get(zone);

    if(firstDay !== day){
      repeatedDays.add(day);
    }
  }

  return Array.from(repeatedDays).sort((a,b)=>a-b);
}

function _collectUsedMacroZoneKeys_(rows=[], city=''){
  const out = new Set();

  for(const r of (rows || [])){
    const k = _extractMacroZoneKey_(r, city);
    if(k) out.add(k);
  }

  return Array.from(out);
}

/* =========================================================
   SECTION 15D · LIGHT STRUCTURE HELPERS
========================================================= */
function _hhmmToMin_(v=''){
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if(hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function _minToHHMM_(mins){
  const n = Math.max(0, Math.min(23*60+59, Number(mins||0)));
  const hh = Math.floor(n/60);
  const mm = n % 60;
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

function _extractApproxMinutesFromLine_(line=''){
  const s = String(line || '').toLowerCase();
  if(!s) return 0;

  let total = 0;
  const hours = s.match(/(\d+)\s*h/);
  const mins = s.match(/(\d+)\s*m/);
  const range = s.match(/(\d+)\s*-\s*(\d+)\s*m/);

  if(hours) total += parseInt(hours[1], 10) * 60;
  if(mins) total += parseInt(mins[1], 10);
  if(!total && range){
    total = Math.round((parseInt(range[1],10) + parseInt(range[2],10))/2);
  }

  return total;
}

function _extractDurationParts_(duration=''){
  const lines = String(duration || '').split('\n').map(x => x.trim()).filter(Boolean);
  const transportLine = lines.find(x => /^(transport|transporte):/i.test(x)) || '';
  const activityLine = lines.find(x => /^(activity|actividad):/i.test(x)) || '';
  return {
    transportMin: _extractApproxMinutesFromLine_(transportLine),
    activityMin: _extractApproxMinutesFromLine_(activityLine)
  };
}

function _groupRowsByDay_(rows=[]){
  const out = {};
  for(const r of (rows || [])){
    const d = Number(r?.day || 1);
    if(!out[d]) out[d] = [];
    out[d].push(r);
  }
  Object.keys(out).forEach(d=>{
    out[d].sort((a,b)=> String(a?.start||'').localeCompare(String(b?.start||'')));
  });
  return out;
}

function _isAuroraRow_(row={}){
  const txt = `${row?.activity || ''} ${row?.to || ''} ${row?.notes || ''}`.toLowerCase();
  return /aurora|auroras|northern lights|boreal/.test(txt);
}

function _isReturnRow_(row={}){
  return /return to|regreso a/i.test(String(row?.activity || ''));
}

function _getDayWindowRef_(perDay=[], dayNum){
  return (perDay || []).find(x => Number(x?.day) === Number(dayNum)) || null;
}

function _hasNormalDayWindow_(perDayRef){
  if(!perDayRef) return true;
  const start = _hhmmToMin_(perDayRef?.start);
  const end = _hhmmToMin_(perDayRef?.end);
  if(start === null || end === null) return true;
  return (end - start) >= 360;
}

function _isNightOnlyWindow_(perDayRef){
  if(!perDayRef) return false;
  const start = _hhmmToMin_(perDayRef?.start);
  const end = _hhmmToMin_(perDayRef?.end);
  if(start === null || end === null) return false;
  return start >= 18*60 && (end - start) <= 360;
}

function _getWindowLengthMin_(perDayRef){
  if(!perDayRef) return null;
  const start = _hhmmToMin_(perDayRef?.start);
  const end = _hhmmToMin_(perDayRef?.end);
  if(start === null || end === null || end <= start) return null;
  return end - start;
}

function _isShortDayWindow_(perDayRef){
  const len = _getWindowLengthMin_(perDayRef);
  if(len === null) return false;
  return len < 300;
}

function _isMediumDayWindow_(perDayRef){
  const len = _getWindowLengthMin_(perDayRef);
  if(len === null) return false;
  return len >= 300 && len < 420;
}

function _isSpaRelaxRow_(row={}){
  const txt = `${row?.activity || ''} ${row?.to || ''} ${row?.notes || ''}`.toLowerCase();
  return /spa|thermal|termal|hot spring|hot springs|relax|wellness|lagoon|onsen|hammam|bath|baths|baños|balneario|pool|piscina/.test(txt);
}

function _isNightFriendlyClosureRow_(row={}){
  const txt = `${row?.activity || ''} ${row?.to || ''} ${row?.notes || ''}`.toLowerCase();
  return /aurora|auroras|northern lights|boreal|dinner|cena|restaurant|restaurante|show|concert|concierto|night|nocturno|nightlife|bar|cocktail|sunset|atardecer|illuminated|iluminado|evening/.test(txt) || _isSpaRelaxRow_(row);
}

function _isRegionalMacroDay_(dayRows=[], city=''){
  const macroRows = (dayRows || []).filter(r => !!_extractMacroZoneKey_(r, city));
  if(!macroRows.length) return false;

  const uniqueZones = new Set(macroRows.map(r => _extractMacroZoneKey_(r, city)).filter(Boolean));
  if(uniqueZones.size) return true;

  return false;
}

function _minimumUsefulRowsForWindow_(perDayRef){
  if(_isNightOnlyWindow_(perDayRef)) return 1;
  if(_isShortDayWindow_(perDayRef)) return 2;
  if(_isMediumDayWindow_(perDayRef)) return 3;
  return 4;
}

function _getWeakDayNums_(rows=[], perDay=[], city=''){
  const byDay = _groupRowsByDay_(rows);
  const weak = [];

  Object.keys(byDay).forEach(dayKey=>{
    const day = Number(dayKey);
    const dayRows = byDay[day] || [];
    const ref = _getDayWindowRef_(perDay, day);
    const auroraRows = dayRows.filter(r => _isAuroraRow_(r));
    const returnRows = dayRows.filter(r => _isReturnRow_(r));
    const nonReturnRows = dayRows.filter(r => !_isReturnRow_(r));
    const nonReturnNonAuroraRows = nonReturnRows.filter(r => !_isAuroraRow_(r));
    const minUsefulRows = _minimumUsefulRowsForWindow_(ref);
    const isRegionalDay = _isRegionalMacroDay_(dayRows, city);

    // 1) Aurora day is weak only if it steals a normal daytime window
    if(auroraRows.length && !_isNightOnlyWindow_(ref)){
      const daytimeRows = dayRows.filter(r=>{
        const start = _hhmmToMin_(r?.start);
        return start !== null && start < 18*60 && !_isAuroraRow_(r);
      });

      if(_hasNormalDayWindow_(ref) && daytimeRows.length < 2){
        weak.push(day);
        return;
      }
    }

    // 2) Weak count by window size (less aggressive, more realistic)
    if(nonReturnRows.length < minUsefulRows){
      weak.push(day);
      return;
    }

    // 3) Structural coherence: time order + duration plausibility
    for(let i=0; i<dayRows.length; i++){
      const r = dayRows[i];
      const start = _hhmmToMin_(r?.start);
      const end = _hhmmToMin_(r?.end);
      if(start === null || end === null || end <= start){
        weak.push(day);
        return;
      }

      if(i > 0){
        const prevEnd = _hhmmToMin_(dayRows[i-1]?.end);
        if(prevEnd !== null && start < prevEnd){
          weak.push(day);
          return;
        }
      }

      const dur = _extractDurationParts_(r?.duration || '');
      const span = end - start;
      const approxNeed = (dur.transportMin || 0) + (dur.activityMin || 0);

      // less aggressive tolerance so valid days don't get over-repaired
      if(approxNeed > 0 && Math.abs(span - approxNeed) > 180){
        weak.push(day);
        return;
      }
    }

    // 4) Return row must close the day if it exists
    if(returnRows.length && !_isReturnRow_(dayRows[dayRows.length-1])){
      weak.push(day);
      return;
    }

    // 5) Regional / macro day should not feel underdeveloped
    if(isRegionalDay){
      if(_hasNormalDayWindow_(ref) && nonReturnNonAuroraRows.length < 4){
        weak.push(day);
        return;
      }
      if(_isMediumDayWindow_(ref) && nonReturnNonAuroraRows.length < 3){
        weak.push(day);
        return;
      }
    }

    // 6) Avoid clearly premature closure on normal days, but do not punish
    // short windows, spa-anchor closures, or valid evening closure rows
    const lastRow = dayRows[dayRows.length-1];
    const lastEnd = _hhmmToMin_(lastRow?.end);
    const windowEnd = _hhmmToMin_(ref?.end);

    if(
      lastEnd !== null &&
      _hasNormalDayWindow_(ref) &&
      !_isShortDayWindow_(ref) &&
      !_isNightFriendlyClosureRow_(lastRow)
    ){
      const closesTooEarlyVsWindow =
        windowEnd !== null
          ? (windowEnd - lastEnd) > 150
          : lastEnd < 18*60 + 30;

      if(closesTooEarlyVsWindow){
        weak.push(day);
        return;
      }
    }

    // 7) Spa/relax anchor should not be treated as weakness if it meaningfully anchors the day
    const spaRows = dayRows.filter(r => _isSpaRelaxRow_(r));
    if(spaRows.length){
      const hasLongSpa = spaRows.some(r=>{
        const start = _hhmmToMin_(r?.start);
        const end = _hhmmToMin_(r?.end);
        return start !== null && end !== null && (end - start) >= 150;
      });

      if(!hasLongSpa && _hasNormalDayWindow_(ref) && nonReturnRows.length < 4){
        weak.push(day);
        return;
      }
    }
  });

  return Array.from(new Set(weak)).sort((a,b)=>a-b);
}

function _replaceDaysInRows_(baseRows=[], replacementRows=[], daysToReplace=[]){
  const set = new Set((daysToReplace || []).map(Number));
  const kept = (baseRows || []).filter(r => !set.has(Number(r?.day || 1)));
  return _dedupeRows_([...(kept || []), ...(replacementRows || [])]);
}

async function _repairWeakDays_(city, totalDays, rows, weakDays, perDay, forceReplan=false, hotel='', transport='recommend me'){
  const dayNums = (weakDays || []).map(Number).filter(Boolean);
  if(!dayNums.length) return [];

  const perDayForRepair = (perDay || []).filter(x => dayNums.includes(Number(x?.day)));

  const prompt = `
${FORMAT}
**ROLE:** Planner “Astra”. Repair ONLY these weak days for "${city}" (${totalDays} total day/s):
${JSON.stringify(dayNums)}

CURRENT ITINERARY CONTEXT:
${JSON.stringify(rows)}

Return Format B JSON only.

MANDATORY REPAIR RULES:
- Generate rows ONLY for days: ${dayNums.join(', ')}.
- Respect these windows: ${JSON.stringify(perDayForRepair)}.
- Keep chronological order with NO overlaps.
- Each row time block must broadly match the stated duration.
- If there is a return row, it must be the FINAL row of that day.
- If a day includes auroras, auroras are ONLY the night part; the day must still include useful daytime content unless the day window is explicitly night-only.
- Normal daytime windows should not be weak or almost empty.
- "activity" MUST ALWAYS be: "Destination – <Specific sub-stop>".
- "from", "to", "transport", "notes" can NEVER be empty.
- "from" and "to" must be REAL places, never a macro-tour label.
- Keep the rest of the trip logic coherent.
- For short windows, do NOT overfill artificially.
- For normal or long windows, avoid weak sparse days.
- If a spa / thermal / relax activity is used, it should anchor the beginning or end of the day and have meaningful time on site.
- Hotel/base: ${JSON.stringify(hotel || '')}
- Preferred transport: ${JSON.stringify(transport || 'recommend me')}
- No text outside JSON.
`.trim();

  const ans = await _callPlannerSystemPrompt_(prompt, false);
  const parsed = parseJSON(ans);

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries || parsed.city_day)){
    const extracted = _extractPlannerRows_(parsed, city);
    const forced = _forceRowsIntoValidDayRange_(extracted, dayNums);
    return forced;
  }

  return [];
}

async function _repairRepeatedMacroZoneDays_(city, totalDays, rows, repeatedDays, perDay, forceReplan=false, hotel='', transport='recommend me'){
  const dayNums = (repeatedDays || []).map(Number).filter(Boolean);
  if(!dayNums.length) return [];

  const perDayForRepair = (perDay || []).filter(x => dayNums.includes(Number(x?.day)));
  const otherRows = (rows || []).filter(r => !dayNums.includes(Number(r?.day || 1)));
  const forbiddenMacroZones = _collectUsedMacroZoneKeys_(otherRows, city).join(', ');

  const prompt = `
${FORMAT}
**ROLE:** Planner “Astra”. Rebuild ONLY these repeated days for "${city}" (${totalDays} total day/s):
${JSON.stringify(dayNums)}

CURRENT ITINERARY CONTEXT:
${JSON.stringify(rows)}

Return Format B JSON only.

MANDATORY REPAIR RULES:
- Generate rows ONLY for days: ${dayNums.join(', ')}.
- Respect these windows: ${JSON.stringify(perDayForRepair)}.
- Keep chronological order with NO overlaps.
- Each row time block must broadly match the stated duration.
- If there is a return row, it must be the FINAL row of that day.
- "activity" MUST ALWAYS be: "Destination – <Specific sub-stop>".
- "from", "to", "transport", "notes" can NEVER be empty.
- "from" and "to" must be REAL places, never a macro-tour label.
- These macro-regions / circuits / rings are already used on other days and must NOT be reused here unless the user explicitly requested repetition: ${forbiddenMacroZones || 'none'}
- Identify alternative iconic unused rings / regional day tours / nearby coherent circuits before repeating previous ones.
- Balance the trip naturally. Do NOT force a rigid nearest-to-farthest sequence.
- If a special stop (spa, geothermal baths, marine life, scenic detour, etc.) fits naturally into an unused regional ring, you may bundle it there.
- If no strong unused regional ring remains, build a high-quality local / urban / scenic / cultural day instead of leaving the day weak.
- Hotel/base: ${JSON.stringify(hotel || '')}
- Preferred transport: ${JSON.stringify(transport || 'recommend me')}
- No text outside JSON.
`.trim();

  const ans = await _callPlannerSystemPrompt_(prompt, false);
  const parsed = parseJSON(ans);

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries || parsed.city_day)){
    const extracted = _extractPlannerRows_(parsed, city);
    const forced = _forceRowsIntoValidDayRange_(extracted, dayNums);
    return forced;
  }

  return [];
}

/* =========================================================
   SECTION 15E · AURORA OPTION + RETURN DURATION FIX
========================================================= */
function _plannerLangCode_(){
  const raw = String(
    (typeof plannerState !== 'undefined' && plannerState?.itineraryLang) ||
    (typeof getLang === 'function' ? getLang() : '') ||
    'en'
  ).toLowerCase().trim();

  if(raw.startsWith('es')) return 'es';
  if(raw.startsWith('pt')) return 'pt';
  if(raw.startsWith('fr')) return 'fr';
  return 'en';
}

function _plannerLocalePack_(){
  const lang = _plannerLangCode_();

  if(lang === 'es'){
    return {
      transportLabel: 'Transporte',
      activityLabel: 'Actividad',
      auroraActivityBase: 'Opción para ver auroras',
      auroraTo: 'Zona de observación de auroras',
      auroraTransport: 'Por cuenta propia o tour guiado',
      auroraNotes: 'Opcional: esta noche puedes intentar ver auroras por tu cuenta o reservando un tour. Revisa nubosidad y pronóstico geomagnético antes de salir.',
      hotelFallback: 'Hotel'
    };
  }

  if(lang === 'pt'){
    return {
      transportLabel: 'Transporte',
      activityLabel: 'Atividade',
      auroraActivityBase: 'Opção para ver auroras',
      auroraTo: 'Área de observação de auroras',
      auroraTransport: 'Por conta própria ou tour guiado',
      auroraNotes: 'Opcional: esta noite você pode tentar ver auroras por conta própria ou reservando um tour. Verifique nuvens e previsão geomagnética antes de sair.',
      hotelFallback: 'Hotel'
    };
  }

  if(lang === 'fr'){
    return {
      transportLabel: 'Transport',
      activityLabel: 'Activité',
      auroraActivityBase: 'Option pour voir les aurores',
      auroraTo: "Zone d'observation des aurores",
      auroraTransport: 'Par vous-même ou en excursion guidée',
      auroraNotes: 'Optionnel : ce soir vous pouvez tenter de voir des aurores par vous-même ou avec une excursion guidée. Vérifiez la couverture nuageuse et la prévision géomagnétique avant de partir.',
      hotelFallback: 'Hotel'
    };
  }

  return {
    transportLabel: 'Transport',
    activityLabel: 'Activity',
    auroraActivityBase: 'Optional aurora viewing',
    auroraTo: 'Aurora viewing area',
    auroraTransport: 'Self-drive or Guided Tour',
    auroraNotes: 'Optional: tonight you may try aurora viewing on your own or by booking a tour. Check cloud cover and geomagnetic forecast before heading out.',
    hotelFallback: 'Hotel'
  };
}

function _normalizeTransportPreferenceForPrompt_(transport=''){
  const raw = String(transport || '').trim().toLowerCase();
  if(!raw) return 'decide intelligently based on the route';
  if(raw === 'recommend me' || raw === 'recomiendame' || raw === 'recomiéndame'){
    return 'decide intelligently based on the route';
  }
  return String(transport || '').trim();
}

function _sanitizeTransportValue_(value=''){
  const raw = String(value || '').trim();
  const low = raw.toLowerCase();

  if(
    !raw ||
    low === 'recommend me' ||
    low === 'recomiendame' ||
    low === 'recomiéndame' ||
    low === 'recommended by planner' ||
    low === 'as appropriate'
  ){
    return '';
  }

  return raw;
}

function _cleanTransportField_(rows=[]){
  return (rows || []).map(r=>{
    const cleaned = _sanitizeTransportValue_(r?.transport);
    if(cleaned) return r;

    const from = String(r?.from || '').toLowerCase();
    const to   = String(r?.to || '').toLowerCase();
    const activity = String(r?.activity || '').toLowerCase();

    const sameArea =
      from && to &&
      (
        from === to ||
        from.includes(to) ||
        to.includes(from)
      );

    const looksReturn = /return to|regreso a|retour a|retour à|regresso a/.test(activity);

    const looksRegional =
      /\b(peninsula|península|coast|costa|route|ruta|loop|circuit|circuito|circle|circulo|círculo|island|isla|archipelago|archipielago|archipiélago|fjord|fiordo|lake|lago|lagoon|laguna|valley|valle|mountain|montana|montaña|volcano|volcan|volcán|park|parque|national park|parque nacional|district|distrito|region|región|canyon|cañon|cañón|wine area|wine region)\b/.test(activity);

    const looksUrban = !looksReturn && !looksRegional;

    let fallback = 'Walking / Metro / Taxi (as appropriate)';
    if(sameArea) fallback = 'Walking';
    else if(looksUrban) fallback = 'Walking / Metro';
    else fallback = 'Rental car or Guided tour';

    return normalizeRow({
      ...r,
      transport: fallback
    }, Number(r?.day || 1));
  });
}

function _isAuroraPlausibleForCityAndDate_(city='', baseDate=''){
  const key = _normalizeHighlightKey_(city);

  const plausibleCityHints = [
    'reykjavik','iceland','islandia',
    'tromso','tromsø',
    'akureyri',
    'rovaniemi',
    'kiruna',
    'abisko',
    'fairbanks',
    'yellowknife'
  ];

  const cityOk = plausibleCityHints.some(h => key.includes(_normalizeHighlightKey_(h)));
  if(!cityOk) return false;

  const m = String(baseDate || '').match(/^\d{4}-(\d{2})-\d{2}$/);
  if(!m) return true;
  const month = parseInt(m[1], 10);

  return [9,10,11,12,1,2,3,4].includes(month);
}

function _pickAuroraNightCount_(totalDays){
  const n = Number(totalDays || 0);
  if(n >= 7) return 3;
  if(n >= 4) return 2;
  if(n >= 2) return 1;
  return 0;
}

function _pickAuroraCandidateDays_(rows=[], totalDays=1, perDay=[]){
  const byDay = _groupRowsByDay_(rows);
  const candidates = [];

  for(let day=1; day<Number(totalDays || 1); day++){
    const dayRows = byDay[day] || [];
    const ref = _getDayWindowRef_(perDay, day);

    if(!dayRows.length) continue;
    if(_isNightOnlyWindow_(ref)) continue;
    if(dayRows.some(r => _isAuroraRow_(r))) continue;

    const lastRow = dayRows[dayRows.length - 1];
    const lastEnd = _hhmmToMin_(lastRow?.end);
    if(lastEnd === null) continue;

    if(lastEnd <= 20 * 60){
      candidates.push({ day, score: lastEnd });
    }
  }

  candidates.sort((a,b)=>{
    if(a.score !== b.score) return a.score - b.score;
    return a.day - b.day;
  });

  const wanted = _pickAuroraNightCount_(totalDays);
  if(!wanted) return [];

  const picked = [];
  for(const c of candidates){
    if(picked.length >= wanted) break;
    if(!picked.length){
      picked.push(c.day);
      continue;
    }
    const prev = picked[picked.length - 1];
    if(Math.abs(c.day - prev) >= 2 || candidates.length <= wanted){
      picked.push(c.day);
    }
  }

  if(picked.length < wanted){
    for(const c of candidates){
      if(picked.length >= wanted) break;
      if(!picked.includes(c.day)) picked.push(c.day);
    }
  }

  return picked.sort((a,b)=>a-b);
}

function _buildAuroraOptionRow_(city, day, dayRows=[]){
  const loc = _plannerLocalePack_();
  const hotel = String(cityMeta?.[city]?.hotel || loc.hotelFallback).trim() || loc.hotelFallback;

  const lastRow = (dayRows || []).slice().sort((a,b)=> String(a?.end || '').localeCompare(String(b?.end || ''))).pop() || null;
  const lastEnd = _hhmmToMin_(lastRow?.end);
  const baseStart = lastEnd !== null ? Math.max(lastEnd + 90, 21 * 60) : (21 * 60);
  const end = Math.min(baseStart + 120, 23 * 60 + 30);
  const start = Math.min(baseStart, end - 60);

  const transportMin = 30;
  const activityMin = Math.max(60, (end - start) - transportMin);

  return normalizeRow({
    day,
    start: _minToHHMM_(start),
    end: _minToHHMM_(end),
    activity: `${city} – ${loc.auroraActivityBase}`,
    from: hotel,
    to: loc.auroraTo,
    transport: loc.auroraTransport,
    duration: `${loc.transportLabel}: ~${transportMin}m\n${loc.activityLabel}: ~${Math.round(activityMin / 30) * 30}m`,
    notes: loc.auroraNotes
  }, day);
}

function _injectAuroraOptionRows_(city, rows=[], totalDays=1, perDay=[], baseDate=''){
  if(!_isAuroraPlausibleForCityAndDate_(city, baseDate)) return rows;

  const byDay = _groupRowsByDay_(rows);

  const hasAuroraReference = (dayRows=[])=>{
    return dayRows.some(r=>{
      const txt = `${r?.activity || ''} ${r?.to || ''} ${r?.notes || ''}`.toLowerCase();
      return /aurora|auroras|northern lights|boreal/.test(txt);
    });
  };

  const candidates = _pickAuroraCandidateDays_(rows, totalDays, perDay);
  const injected = [];

  for(const day of candidates){
    if(!hasAuroraReference(byDay[day] || [])){
      injected.push(_buildAuroraOptionRow_(city, day, byDay[day] || []));
    }
  }

  const loc = _plannerLocalePack_();

  Object.keys(byDay).forEach(dayKey=>{
    const day = Number(dayKey);
    if(day >= Number(totalDays || 1)) return;

    const dayRows = byDay[day] || [];
    if(!dayRows.length) return;
    if(hasAuroraReference(dayRows)) return;

    const eveningRows = dayRows.filter(r=>{
      const start = _hhmmToMin_(r?.start);
      return start !== null && start >= 17 * 60;
    });

    const target = eveningRows.length ? eveningRows[eveningRows.length - 1] : dayRows[dayRows.length - 1];
    if(!target) return;

    const extraNote = (loc.auroraNotes || '').trim();
    if(!extraNote) return;

    target.notes = String(target.notes || '').trim()
      ? `${String(target.notes).trim()} ${extraNote}`
      : extraNote;
  });

  return _dedupeRows_([...(rows || []), ...injected]);
}

function _fixReturnRowDurationConsistency_(rows=[]){
  const loc = _plannerLocalePack_();

  return (rows || []).map(r=>{
    if(!_isReturnRow_(r)) return r;

    const start = _hhmmToMin_(r?.start);
    const end = _hhmmToMin_(r?.end);
    if(start === null || end === null || end <= start) return r;

    const span = end - start;
    const activityMin = span >= 30 ? 10 : 5;
    const transportMin = Math.max(5, span - activityMin);

    return normalizeRow({
      ...r,
      duration: `${loc.transportLabel}: ~${transportMin}m\n${loc.activityLabel}: ~${activityMin}m`
    }, Number(r?.day || 1));
  });
}

async function _generateBlockFromThemes_(city, totalDays, blockDaysObjs, perDay, forceReplan=false, hotel='', transport='recommend me', forbiddenHighlights=[], forbiddenUrbanClusters=[]){
  const dayNums = blockDaysObjs.map(x => Number(x.day));
  const perDayForBlock = perDay.filter(x => dayNums.includes(Number(x?.day)));
  const forbiddenText = Array.isArray(forbiddenHighlights) && forbiddenHighlights.length
    ? forbiddenHighlights.join(', ')
    : '';
  const forbiddenUrbanText = Array.isArray(forbiddenUrbanClusters) && forbiddenUrbanClusters.length
    ? forbiddenUrbanClusters.join(', ')
    : '';
  const promptTransport = _normalizeTransportPreferenceForPrompt_(transport);

  const buildPrimaryPrompt = () => `
${FORMAT}
**ROLE:** Planner “Astra”. Create itinerary rows ONLY for these days of "${city}" (${totalDays} total day/s):
${JSON.stringify(blockDaysObjs)}

Return Format B JSON: {"destination":"${city}","rows":[...],"replace": ${forceReplan ? 'true' : 'false'}}.

MANDATORY:
- Generate rows ONLY for these days: ${dayNums.join(', ')}.
- Every row MUST have day equal to one of these days only.
- You MUST return useful rows for EVERY requested day in this block.
- Respect these reference windows intelligently: ${JSON.stringify(perDayForBlock)}.
- The end time provided by the planner is a HARD MAXIMUM boundary, not a target.

- HARD RULES:
  • chronological order with NO overlaps
  • all fields must be filled
  • "activity" format: "Destination – <Specific sub-stop>"
  • "from" and "to" must be REAL places
  • "transport" must be a REAL final value (no placeholders)

- SOFT RULES (HIGH PRIORITY BUT FLEXIBLE):
  • target 4–8 rows for normal days
  • allow 8–12 only when naturally dense
  • avoid weak days whenever possible
  • prefer variety across days

- CRITICAL FALLBACK:
  If no strong regional cluster is available for a day:
  → you MUST create a high-quality local / urban / waterfront / cultural / food / scenic day instead.
  → NEVER leave a day weak or empty.
  → a normal usable day should still feel complete, intentional, and valuable.

- Hotel/base: ${JSON.stringify(hotel || '')}
- Preferred transport: ${JSON.stringify(promptTransport)}
${forbiddenText ? `- Do NOT repeat these main highlights already used on other days unless the user explicitly requested repetition: ${forbiddenText}` : ''}
${forbiddenUrbanText ? `- For base-city days, avoid reusing these already-used urban areas / neighborhoods / clusters unless strictly necessary: ${forbiddenUrbanText}` : ''}

GLOBAL CANDIDATE DISCOVERY (CRITICAL):
- Starting from the base city, first identify the broadest plausible universe of iconic places, routes, scenic areas, day trips, near-city experiences, waterfront/harbor experiences, wellness options, food/cultural options, viewpoint options, and local half-day combinations that are realistically visitable from the base.
- Explore this universe outward in radial tiers before selecting:
  • Tier A: city / near-base / urban / waterfront / museums / food / local viewpoints
  • Tier B: short regional escapes and near-base nature
  • Tier C: medium day trips / coherent regional loops
  • Tier D: long but still plausible day trips
  • Tier E: outer exploration boundary up to about 5 hours one-way by car ONLY as a maximum candidate horizon
- This outer boundary is NOT an automatic inclusion rule. It is only the outer exploration universe.
- Build a rich candidate pool first. Only after that, select what best fits the trip length.
- Leave farther or lower-value candidates OUT if they do not add enough value for this trip length.
- Prefer routes and combinations that create a WOW result: iconic, coherent, memorable, visually strong, and better than a generic tourist plan.
- The candidate discovery must come from the destination itself, not from pre-existing template routes.
- Before reusing an urban cluster or a second-tier city pack, you MUST explicitly evaluate whether there are still unused worthwhile regional day trips / rings / nearby towns / scenic routes reachable from the base.
- For trips of 5 or more days, if the destination genuinely supports strong day trips, you MUST include 1–3 of them before recycling urban content.
- Failing to include obvious strong day trips in a long stay should be treated as a low-quality itinerary.

MICRO-STOPS / DENSITY (CRITICAL):
- For each chosen cluster / region / route, identify a richer internal pool of REAL sub-stops before building the final day.
- Think in 2 levels:
  • Macro-stops = major anchor places / major sights / towns / regions
  • Micro-stops = small but valuable enrichers inside the same cluster:
    - viewpoints
    - short boardwalks
    - cliffs
    - lava fields
    - bridges
    - rock formations
    - small craters
    - beaches
    - harbors
    - cafes with scenic value
    - short detours
    - photo points
    - pools / spas / geothermal pockets
    - local museums / cultural spots
    - scenic plazas / alleys / architectural landmarks
    - local markets / food halls / waterfront details
- For each chosen cluster, mentally generate between 5 and 15 REAL possible sub-stops if the destination genuinely offers them.
- Then SELECT ONLY the sub-stops that actually fit the day coherently.
- Do NOT force all 15 into the itinerary.
- Use more sub-stops and more final rows when the cluster is dense and compact.
- Use fewer, higher-value sub-stops when the cluster is large and spread out.
- The purpose is to avoid weak sparse days and enrich the route naturally, not to overload the day.
- When the destination is exceptionally rich, prefer a denser but still readable and realistic day over a weak sparse day.
- A normal usable day should usually have at least 4 meaningful rows unless the time window is clearly short.
- A short day should still usually have at least 3 meaningful rows unless the user window is extremely limited.
- For iconic regional day trips / scenic routes / peninsulas / coastlines / heritage towns, the micro-stops must NOT remain only conceptual: the final itinerary should usually include 5–8 REAL sub-stops / rows when the geography genuinely supports them.
- The optional micro-guide in notes can enrich the route, but it does NOT replace the need for enough real rows in the itinerary itself.

MICRO-GUIDE ENRICHMENT (CRITICAL):
- For regional days / day trips, the FIRST row of that cluster/day should include in "notes" a structured, ordered micro-guide of additional sub-stops along the same route when the cluster supports them.
- This micro-guide must be:
  • ordered in the same optimal geographic flow of the route
  • made of REAL places only
  • specific and useful to the user
  • clearly presented as an optional enriched route, not random notes
- If the day already includes many real rows, the micro-guide can be shorter.
- If the day cannot include all valuable micro-stops as rows, use the first row notes to preserve that expert-level detail.
- This is especially valuable for dense scenic routes, rich urban walks, peninsulas, coastlines, regional loops, and layered city days.

RADIAL / BALANCE LOGIC (IMPROVED):
- Build a pool of candidate experiences around the base city:
  • urban clusters
  • nearby escapes
  • regional day trips
  • scenic routes
  • cultural + food combinations

- Assign them across requested days ensuring:
  • NO day is left empty
  • NO day feels weak

- PRIORITY ORDER:
  1. Unused strong regional clusters
  2. Secondary regional clusters
  3. High-quality urban + cultural + scenic combinations

- CRITICAL:
  If strong regional clusters are exhausted:
  → build PREMIUM local days (not filler)

- Avoid:
  • front-loading all strong content
  • leaving last days weak

- The LAST day must feel intentional and memorable.

ANTI-DUPLICATION (BALANCED):
- Avoid repeating the same macro-region, circuit, or regional ring across days.
- STRONG RULE:
  Do NOT repeat the SAME major regional circuit when clear alternatives exist.
- FLEXIBLE RULE:
  If the destination has limited variety and no strong unused alternatives remain:
  → you MAY reuse a region ONLY IF:
    • the internal route is meaningfully different
    • it focuses on different sub-stops
    • it creates a clearly distinct experience for the user
- NEVER:
  • duplicate the exact same route
  • reuse identical highlight combinations
- Always prefer UNUSED clusters first.

DAY TRIP LOGIC (GLOBAL):
- If an activity belongs to a region (peninsula, coast, geothermal area, mountain route, lake district, wine area, canyon route, heritage route, island route, etc.), group nearby highlights into ONE coherent day when it improves the trip.
- Avoid single-activity regional days when multiple nearby worthwhile stops exist.
- Prefer complete regional loops over fragmented visits.
- If a special activity fits naturally inside a regional day, you may integrate it there.
- A proper day trip should normally include 4–8 useful rows, but for dense and highly visitable clusters it may expand to around 8–12 rows when that clearly improves the guide and still remains realistic.
- For powerful regional days, make the route feel like a true expertly designed circuit, not just a list of stops.
- In medium and long trips, clearly viable day trips should be considered a major source of value, not a last resort.
- In trips of 5 or more days, actively prioritize worthwhile day trips / regional circuits when the destination genuinely offers them.
- Do NOT leave a long trip mostly urban if the destination is widely known for strong day trips reachable from the base.
- A day trip should feel fully developed, not like a thin placeholder with only 2–3 stops.
- A real day trip should end with an explicit return row in the format "<Macro-tour> – Return to <base city>".

SPA / THERMAL / RELAX LOGIC (CRITICAL):
- Activities centered on thermal baths, hot springs, spas, wellness complexes, hammams, onsen, relaxation pools, or similar immersive relaxation experiences must be treated as ANCHOR blocks.
- Such activities must either:
  • start the day as a major anchor
  • or end the day as a major anchor
- Do NOT place an immersive relaxation activity as a short middle stop between multiple unrelated visits.
- Reserve at least about 3 effective hours on site for a true spa / thermal / relaxation anchor unless the user explicitly asked for a brief stop.
- If there is nearby coherent content, place it BEFORE the spa or AFTER it in a way that still feels natural.
- The result should feel realistic to a human traveler.

DAYLIGHT / NIGHT LOGIC (CRITICAL):
- Daylight-sensitive activities must be scheduled during daylight or strong natural-light hours when possible:
  • scenic viewpoints
  • waterfalls
  • beaches
  • coastal cliffs
  • panoramic drives
  • villages / old towns best enjoyed outdoors
  • parks / gardens
  • hiking / walking routes
  • outdoor architecture appreciation
  • natural landmarks
- Evening/night should be used primarily for:
  • dinners
  • nightlife
  • illuminated urban strolls
  • shows / performances
  • auroras
  • clearly indoor late-compatible experiences
- Do NOT schedule strongly daylight-dependent outdoor sightseeing into clearly night-like windows just because there is still time available.
- If the user provided an end time, treat it as the latest acceptable finish, not a target to fill aggressively.

QUALITY / RHYTHM:
- Avoid giant dead gaps in the middle of a normal full day unless they are justified by a genuinely long transfer or a long immersive activity.
- If the day is spa/relax/boat/marine-based, enrich the rest of the day with coherent nearby content instead of leaving the day almost empty.
- Aurora viewing should NOT be the main daytime anchor of a normal full day.
- On days with normal daytime availability, auroras should appear only as evening/night content or as notes, not as the core daytime activity.
- Keep rows in chronological order with NO overlaps.
- If there is a return row, place it as the FINAL row.
- Final days should feel like a strong closure, not leftover filler.
- Prioritize iconic endings, emotional endings, scenic endings, or premium cultural/food/waterfront closures when appropriate.
- The overall result should feel WOW: premium, specific, memorable, realistic, and smarter than a standard travel planner.
- When the final day is still urban, it must feel materially different from earlier urban days and avoid obvious recycling of the same cluster.

FAIL-SAFE GENERATION (CRITICAL):
- Under NO circumstances should a requested day return:
  • zero rows
  • only 1–2 weak rows
- If constraints conflict:
  → PRIORITIZE generating a strong, coherent day over strictly respecting all soft rules.
- The planner MUST always return a complete and usable itinerary.
- Before finalizing, verify that each requested day in this block has enough useful content for its time window.
- If a day is still too thin, rebuild it internally before returning JSON.
- No text outside JSON.
`.trim();

  const buildMissingDaysPrompt = (missingDays=[]) => `
${FORMAT}
**ROLE:** Planner “Astra”. Generate rows ONLY for the missing day numbers of "${city}":
${JSON.stringify(missingDays)}

Return Format B JSON only.

MANDATORY:
- Generate rows ONLY for these days: ${missingDays.join(', ')}.
- You MUST return useful rows for EVERY requested missing day.
- Respect these windows intelligently: ${JSON.stringify(perDay.filter(x => missingDays.includes(Number(x?.day))))}.
- The end time provided by the planner is a HARD MAXIMUM boundary, not a target.
- HARD RULES:
  • chronological order
  • no overlaps
  • all fields required
  • "activity" MUST be "Destination – <Specific sub-stop>"
  • real places in "from" and "to"
  • transport must be a real final value
- SOFT RULES:
  • target 4–8 rows
  • allow around 8–12 when the remaining cluster is truly dense and compact
- If the missing day is the final day of the trip, it must still be meaningful, polished, and memorable; do NOT make it feel like leftover filler.
- Use the remaining UNUSED candidate universe first, thinking radially from the base city:
  • local / urban / waterfront / museum / food / scenic / cultural combinations
  • then unused near-base nature / marine / spa-adjacent / viewpoint / old-town / architecture combinations
  • then unused regional clusters only if they are genuinely new
- For trips of 5 or more days, before choosing another urban day, explicitly evaluate whether there are still strong unused day trips / nearby towns / regional scenic circuits available from the base.
- The replacement day must be built from what the destination still offers, not from a template route.
- For the chosen remaining cluster or local pack, also think in micro-stops:
  • generate mentally 5–15 possible micro-stops if the destination genuinely offers them
  • then choose only the ones that fit coherently in the missing day
- If the chosen remaining cluster is rich and compact, include more real rows.
- Also enrich the FIRST row notes with an ordered micro-guide when useful.
- Do NOT solve a long missing-day problem by repeating the exact same route or identical highlight combinations.
- Prefer UNUSED clusters first, but if the destination has truly limited variety, a meaningfully distinct internal route is acceptable over leaving the day weak.
- If the destination genuinely offers strong day trips / regional circuits and this is a long trip, prefer using one of those before falling back to a thin urban day.
- A valid missing-day rebuild should usually produce at least 3 meaningful rows for a short day and at least 4 meaningful rows for a normal day.
- For iconic regional missing-day rebuilds, prefer 5–8 real sub-stops / rows when the geography genuinely supports them.
- The micro-guide in notes can enrich the route but must not replace real rows in the itinerary.
- If the chosen missing day is spa/thermal/relax-based, place that anchor at the start or end of the day and leave at least about 3 effective hours on site.
- Keep daylight-sensitive activities in daylight-friendly hours.
- If excursion/day trip exists, end with "<Region> – Return to ${city}".
- Hotel/base: ${JSON.stringify(hotel || '')}
- Transport preference: ${JSON.stringify(promptTransport)}
- The result should feel globally premium and destination-aware, not generic.
- No text outside JSON.
`.trim();

  async function _requestBlockRows_(promptText, allowedDays){
    const ans = await _callPlannerSystemPrompt_(promptText, false);
    const parsed = parseJSON(ans);

    if(!(parsed && (parsed.rows || parsed.destinations || parsed.itineraries || parsed.city_day))){
      return [];
    }

    const extracted = _extractPlannerRows_(parsed, city);
    const forced = _forceRowsIntoValidDayRange_(extracted, allowedDays);
    const cleanedTransport = _cleanTransportField_(forced);
    return Array.isArray(cleanedTransport) ? cleanedTransport : [];
  }

  function _missingDaysFromRows_(rows=[], requestedDays=[]){
    const set = new Set((rows || []).map(r => Number(r?.day)));
    return (requestedDays || []).filter(d => !set.has(Number(d)));
  }

  const label = `${dayNums[0]}${dayNums.length > 1 ? '-' + dayNums[dayNums.length - 1] : ''}`;
  console.log(`[BLOCK ${label}] Requesting rows...`);

  let primaryRows = [];
  try{
    primaryRows = await _requestBlockRows_(buildPrimaryPrompt(), dayNums);
  }catch(err){
    console.warn(`[BLOCK ${label}] Primary request failed:`, err);
    primaryRows = [];
  }

  if(_hasUsableRowsForAllBlockDays_(primaryRows, dayNums)){
    console.log(`[BLOCK ${label}] OK`);
    return primaryRows;
  }

  const missingDays = _missingDaysFromRows_(primaryRows, dayNums);
  if(!missingDays.length){
    if(primaryRows.length){
      console.warn(`[BLOCK ${label}] Partial but non-empty rows returned; passing downstream.`);
      return primaryRows;
    }
    console.warn(`[BLOCK ${label}] FAIL — empty primary result.`);
    return [];
  }

  console.warn(`[BLOCK ${label}] Missing requested days after primary pass, retrying only missing days:`, missingDays);

  let retryRows = [];
  try{
    retryRows = await _requestBlockRows_(buildMissingDaysPrompt(missingDays), missingDays);
  }catch(err2){
    console.warn(`[BLOCK ${label}] Missing-day retry failed:`, err2);
    retryRows = [];
  }

  const merged = _dedupeRows_([...(primaryRows || []), ...(retryRows || [])]);

  if(_hasUsableRowsForAllBlockDays_(merged, dayNums)){
    console.log(`[BLOCK ${label}] OK after retry`);
    return merged;
  }

  const stillMissing = _missingDaysFromRows_(merged, dayNums);
  if(stillMissing.length){
    console.warn(`[BLOCK ${label}] Still missing days after retry:`, stillMissing);
  }

  if(merged.length){
    console.warn(`[BLOCK ${label}] Returning partial rows for downstream repair.`);
    return merged;
  }

  console.warn(`[BLOCK ${label}] FAIL — invalid JSON or empty parse.`);
  return [];
}

function _dedupeRows_(rows=[]){
  const seen = new Set();
  const out = [];

  for(const r of (rows || [])){
    const key = JSON.stringify([
      Number(r?.day || 1),
      String(r?.start || '').trim(),
      String(r?.end || '').trim(),
      String(r?.activity || '').trim(),
      String(r?.from || '').trim(),
      String(r?.to || '').trim()
    ]);

    if(seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }

  return out.sort((a,b)=>{
    const da = Number(a?.day || 1), db = Number(b?.day || 1);
    if(da !== db) return da - db;
    return String(a?.start || '').localeCompare(String(b?.start || ''));
  });
}

function _rowsCoverAllDays_(rows=[], totalDays=1){
  const set = new Set((rows || []).map(r => Number(r?.day)));
  for(let d=1; d<=totalDays; d++){
    if(!set.has(d)) return false;
  }
  return true;
}

/* =========================================================
   SECTION 15F · generateCityItinerary (BLOCK-SAFE + FINAL GUARANTEE)
========================================================= */
async function generateCityItinerary(city){
  const dest  = savedDestinations.find(x=>x.city===city);
  if(!dest) return;

  const perDay = _normalizePerDayForPrompt_(city, dest.days, dest.perDay || []);

  const baseDate = cityMeta[city]?.baseDate || dest.baseDate || '';
  const hotel    = cityMeta[city]?.hotel || '';
  const transport= cityMeta[city]?.transport || 'recommend me';

  const forceReplan = (typeof plannerState !== 'undefined' && plannerState.forceReplan && plannerState.forceReplan[city]) ? true : false;

  let repairState = {
    weakDone: false,
    missingDone: false,
    postAuroraDone: false,
    repeatedMacroDone: false
  };

  function _getMissingDayNums_(rows=[], totalDays=1){
    const set = new Set((rows || []).map(r => Number(r?.day)));
    const missing = [];
    for(let d=1; d<=Number(totalDays || 1); d++){
      if(!set.has(d)) missing.push(d);
    }
    return missing;
  }

  // 🔥 NUEVO: thin detection SOLO para días del bloque
  function _getThinDaysInRequestedSet_(rows=[], requestedDays=[], minRows=3){
    const byDay = _groupRowsByDay_(rows);
    const thin = [];

    (requestedDays || []).forEach(d=>{
      const count = (byDay[d] || []).length;
      if(count < minRows){
        thin.push(Number(d));
      }
    });

    return thin;
  }

  function _buildFallbackMasterDays_(totalDays=1){
    const out = [];
    for(let d=1; d<=Number(totalDays || 1); d++){
      out.push({
        day: d,
        theme: d === Number(totalDays || 1)
          ? 'Memorable final day'
          : 'High-value local discovery'
      });
    }
    return out;
  }

  async function _safeValidateRows_(rows=[]){
    try{
      const result = await validateRowsWithAgent(city, rows, baseDate);
      const allowed = Array.isArray(result?.allowed) ? result.allowed : [];
      if(allowed.length){
        return { allowed };
      }
      return { allowed: rows };
    }catch(err){
      return { allowed: rows };
    }
  }

  async function _repairRequestedDaysIndividually_(rows=[], dayNums=[]){
    const targets = Array.from(new Set((dayNums || []).map(Number).filter(Boolean))).slice(0,4);
    let out = rows.slice();

    for(const day of targets){
      try{
        const repairedRows = await _repairWeakDays_(
          city,
          dest.days,
          out,
          [day],
          perDay,
          forceReplan,
          hotel,
          transport
        );

        if(repairedRows.length){
          out = _replaceDaysInRows_(out, repairedRows, [day]);
          out = _dedupeRows_(out);
        }
      }catch(err){}
    }

    return out;
  }

  async function _rescueMissingDays_(rows=[]){
    let missing = _getMissingDayNums_(rows, dest.days);
    if(!missing.length) return rows;

    let repaired = await _repairRequestedDaysIndividually_(rows, missing);

    missing = _getMissingDayNums_(repaired, dest.days);
    if(missing.length){
      repaired = await _repairRequestedDaysIndividually_(repaired, missing);
    }

    return _dedupeRows_(repaired);
  }

  async function _postProcessCityRows_(rows=[]){
    let out = _dedupeRows_(rows);

    out = _removeDuplicateHighlightsAcrossDays_(out, city);
    out = _removeDuplicateUrbanClustersAcrossDays_(out, city);

    let weakDays = _getWeakDayNums_(out, perDay);

    const byDay = _groupRowsByDay_(out);
    Object.keys(byDay).forEach(d=>{
      if(byDay[d].length < 3){
        if(!weakDays.includes(Number(d))){
          weakDays.push(Number(d));
        }
      }
    });

    if(weakDays.length && !repairState.weakDone){
      repairState.weakDone = true;

      const repairedRows = await _repairWeakDays_(
        city,
        dest.days,
        out,
        weakDays.slice(0,3),
        perDay,
        forceReplan,
        hotel,
        transport
      );

      if(repairedRows.length){
        out = _replaceDaysInRows_(out, repairedRows, weakDays);
        out = _dedupeRows_(out);
      }
    }

    out = await _rescueMissingDays_(out);

    out = _injectAuroraOptionRows_(city, out, dest.days, perDay, baseDate);
    out = _fixReturnRowDurationConsistency_(out);

    return _dedupeRows_(out);
  }

  showWOW(true, t('overlayDefault'));

  try{
    let masterDays = await _buildCityMasterPlan_(city, dest.days, perDay, baseDate, hotel, transport);

    if(!Array.isArray(masterDays) || masterDays.length !== Number(dest.days || 1)){
      masterDays = _buildFallbackMasterDays_(dest.days);
    }

    const blocks = _chunkMasterDays_(masterDays);

    let stitchedRows = [];
    let usedHighlightKeys = [];
    let usedUrbanClusterKeys = [];

    for(let i=0; i<blocks.length; i++){
      const block = blocks[i];
      const blockDays = block.map(x=>Number(x.day));

      let blockRows = await _generateBlockFromThemes_(
        city,
        dest.days,
        block,
        perDay,
        forceReplan,
        hotel,
        transport,
        usedHighlightKeys,
        usedUrbanClusterKeys
      );

      // 🔥 FIX REAL: evaluar solo días del bloque
      let thinDays = _getThinDaysInRequestedSet_(blockRows, blockDays);

      if(thinDays.length){
        console.warn(`[CITY ${city}] Block thin (REAL):`, thinDays);

        const repaired = await _repairRequestedDaysIndividually_(blockRows, thinDays);
        if(repaired.length){
          blockRows = repaired;
        }
      }

      if(Array.isArray(blockRows) && blockRows.length){
        stitchedRows.push(...blockRows);
      }

      const interimRows = _dedupeRows_(stitchedRows);
      usedHighlightKeys = _collectUsedHighlightKeys_(interimRows, city);
      usedUrbanClusterKeys = _collectUsedUrbanClusterKeys_(interimRows, city);
    }

    stitchedRows = await _postProcessCityRows_(stitchedRows);

    // 🔥 GARANTÍA FINAL TOTAL
    let finalMissing = _getMissingDayNums_(stitchedRows, dest.days);
    if(finalMissing.length){
      stitchedRows = await _repairRequestedDaysIndividually_(stitchedRows, finalMissing);
      stitchedRows = _dedupeRows_(stitchedRows);
    }

    // 🔥 GARANTÍA DE DENSIDAD FINAL
    const byDayFinal = _groupRowsByDay_(stitchedRows);
    let finalWeak = [];
    Object.keys(byDayFinal).forEach(d=>{
      if(byDayFinal[d].length < 3){
        finalWeak.push(Number(d));
      }
    });

    if(finalWeak.length){
      stitchedRows = await _repairRequestedDaysIndividually_(stitchedRows, finalWeak);
      stitchedRows = _dedupeRows_(stitchedRows);
    }

    const val = await _safeValidateRows_(stitchedRows);
    const finalRows = _dedupeRows_(Array.isArray(val?.allowed) && val.allowed.length ? val.allowed : stitchedRows);

    pushRows(city, finalRows, forceReplan);

    renderCityTabs();
    setActiveCity(city);
    renderCityItinerary(city);
    showWOW(false);

    console.log(`[CITY ${city}] SUCCESS — PRO generation stabilized.`);
    return;

  }catch(err){
    console.error(`[CITY ${city}] staged generation failed, fallback triggered:`, err);
  }

  showWOW(false);
}

/* =========================================================
   SECTION 15G · Bulk rebalance after changes (add days / requested day trip)
========================================================= */
async function rebalanceWholeCity(city, opts={}){
  const data = itineraries[city];
  const totalDays = Object.keys(data.byDay||{}).length;
  const perDay = _normalizePerDayForPrompt_(city, totalDays);
  const baseDate = data.baseDate || cityMeta[city]?.baseDate || '';
  const wantedTrip = (opts.dayTripTo||'').trim();

  const startDay = opts.start || 1;
  const endDay = opts.end || totalDays;
  const lockedDaysText = startDay > 1 
    ? `Keep days 1 to ${startDay - 1} intact.`
    : '';

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
- Include at least 1 aurora night in a realistic night window (20:00–02:00 approx.).
- Avoid consecutive days if there is margin; avoid leaving it only at the end (if it only fits there, mark conditional).
- Notes must include "valid:" + a nearby low-cost alternative.
- Auroras are a NIGHT activity only; the same day must still include useful daytime content unless the day window is explicitly night-only.

DAY TRIPS / MACRO-TOURS (no hard limits, with judgment):
- You may include day trips if they add value (no fixed rule). Decide intelligently.
- Guideline: ideally ≤ ~5h per one-way drive ONLY when the stay is long enough to justify it. Otherwise prefer stronger nearer / medium rings first.
- If you include a day trip:
  • 5–8 sub-stops (rows) with realistic sequence.
  • The FIRST macro-tour row must be: "<Macro-tour> – Departure from ${city}" (and "to" = first real sub-stop).
  • Must end with a final dedicated row using the macro-tour Destination: "<Macro-tour> – Return to ${city}".
  • If it's a classic route, reach the logical end highlight before returning.
  • Avoid optimistic returns: use conservative estimates in winter or at night.
- Do NOT repeat the same main highlight on different days unless the user explicitly requested repetition.
- Do NOT over-reuse the same urban area / neighborhood / cluster across different city days.
- Do NOT repeat the same macro-region / ring across different days unless the user explicitly requested it.

GLOBAL BALANCE RULE:
- First identify iconic highlights and strong regional day-trip rings around the base city.
- Then distribute them in the BEST balanced order for the trip.
- Do NOT force a rigid nearest-to-farthest sequence.
- Prefer covering additional worthwhile rings before repeating previously used ones.
- If a special stop (spa, geothermal baths, marine life, scenic detour, etc.) fits naturally inside a regional ring, you may bundle it there.
  Examples only: Blue Lagoon in a Reykjanes-style ring, Secret Lagoon in a Golden-Circle-style ring.

QUALITY:
- Respect time windows as reference: ${JSON.stringify(perDay.filter(x => x.day >= startDay && x.day <= endDay))}.
- Consider key highlights and distribute without duplication.
${wantedTrip ? `- User preference: day trip to "${wantedTrip}". If reasonable, integrate it (complete macro-tour) and close with return.` : ''}
- The last day can be lighter, but don’t leave it “empty” if key highlights remain.
- Validate plausibility and safety; replace with safe alternatives when needed.
- Notes must ALWAYS be useful (never empty or "seed").
- Keep rows in chronological order, avoid overlaps, and keep return rows as the last row when they exist.

Current context (to merge without deleting): 
${buildIntake()}
`.trim();

  showWOW(true, t('overlayDefault'));

  const ans = await _callPlannerSystemPrompt_(prompt, true);
  const parsed = parseJSON(ans);
  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries || parsed.city_day)){
    let rows = _extractPlannerRows_(parsed, city);
    rows = _dedupeRows_(rows);
    rows = _removeDuplicateHighlightsAcrossDays_(rows, city);
    rows = _removeDuplicateUrbanClustersAcrossDays_(rows, city);

    const repeatedMacroZoneDays = _findRepeatedMacroZoneDays_(rows, city);
    if(repeatedMacroZoneDays.length){
      const repairedRows = await _repairRepeatedMacroZoneDays_(
        city,
        totalDays,
        rows,
        repeatedMacroZoneDays,
        perDay,
        forceReplan,
        cityMeta[city]?.hotel || '',
        cityMeta[city]?.transport || 'recommend me'
      );

      if(repairedRows.length && _rowsCoverRequestedDays_(repairedRows, repeatedMacroZoneDays)){
        rows = _replaceDaysInRows_(rows, repairedRows, repeatedMacroZoneDays);
        rows = _dedupeRows_(rows);
        rows = _removeDuplicateHighlightsAcrossDays_(rows, city);
        rows = _removeDuplicateUrbanClustersAcrossDays_(rows, city);
      }else{
        console.warn(`[CITY ${city}] rebalance macro-zone repair skipped because returned rows did not cover all requested days.`);
      }
    }

    const weakDays = _getWeakDayNums_(rows, perDay);
    if(weakDays.length){
      const repairedRows = await _repairWeakDays_(
        city,
        totalDays,
        rows,
        weakDays,
        perDay,
        forceReplan,
        cityMeta[city]?.hotel || '',
        cityMeta[city]?.transport || 'recommend me'
      );

      if(repairedRows.length && _rowsCoverRequestedDays_(repairedRows, weakDays)){
        rows = _replaceDaysInRows_(rows, repairedRows, weakDays);
        rows = _dedupeRows_(rows);
        rows = _removeDuplicateHighlightsAcrossDays_(rows, city);
        rows = _removeDuplicateUrbanClustersAcrossDays_(rows, city);
      }else{
        console.warn(`[CITY ${city}] rebalance weak-day repair skipped because returned rows did not cover all requested days.`);
      }
    }

    rows = _injectAuroraOptionRows_(city, rows, totalDays, perDay, baseDate);
    rows = _fixReturnRowDurationConsistency_(rows);

    const val = await validateRowsWithAgent(city, rows, baseDate);
    pushRows(city, val.allowed, forceReplan);

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


/* ==============================
   SECCIÓN 16 · Inicio (hotel/transport)
================================= */
async function startPlanning(){
  if(savedDestinations.length===0) return;
  $chatBox.style.display='flex';
  planningStarted = true;
  collectingHotels = true;
  session = [];
  metaProgressIndex = 0;

  chatMsg(`${tone.hi}`);
  askNextHotelTransport();
}
function askNextHotelTransport(){
  if(metaProgressIndex >= savedDestinations.length){
    collectingHotels = false;

    // ✅ NUEVO (quirúrgico): preguntar idioma global antes de generar
    if (typeof plannerState !== 'undefined' && plannerState) {
      plannerState.collectingItineraryLang = true;
    }

    chatMsg(
      (getLang()==='es')
        ? 'Antes de generar: ¿en qué <strong>idioma</strong> quieres tu itinerario? (Ej: Español, English, Português, Français, Deutsch…)'
        : 'Before I generate: what <strong>language</strong> do you want your itinerary in? (e.g., English, Español, Português, Français, Deutsch…)'
    , 'ai');

    return;
  }

  const city = savedDestinations[metaProgressIndex].city;
  setActiveCity(city); renderCityItinerary(city);
  chatMsg(tone.askHotelTransport(city),'ai');
}

/* ==============================
   SECCIÓN 17 · NLU robusta + Intents (v55.1)
   (amplía vocabulario y regex de v55 pero mantiene intents v54)
================================= */
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

// Detectar ciudad base a partir de país
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

/* ==============================
   SECCIÓN 18 · Edición/Manipulación + Optimización + Validación
================================= */
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

  // ✅ AJUSTE QUIRÚRGICO (multi-idioma real): fuerza que la salida use el idioma que indique el usuario (no labels del sistema)
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
- Si el día fue largo, AÚN puedes proponer actividades nocturnas si son icónicas y realistas.
- Day trips: decide libremente si aportan valor; si los propones, hazlos completos y realistas.
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

/* ==============================
   SECCIÓN 19 · Chat handler (global)
================================= */
async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  // Colecta hotel/transporte
  if(collectingHotels){
    const city = savedDestinations[metaProgressIndex].city;
    const transport = (/recom/i.test(text)) ? 'recomiéndame'
      : (/alquilad|rent|veh[ií]culo|coche|auto|carro/i.test(text)) ? 'vehículo alquilado'
      : (/metro|tren|bus|autob[uú]s|p[uú]blico/i.test(text)) ? 'transporte público'
      : (/uber|taxi|cabify|lyft/i.test(text)) ? 'otros (Uber/Taxi)'
      : '';
    upsertCityMeta({ city, hotel: text, transport });
    metaProgressIndex++;
    askNextHotelTransport();
    return;
  }

  // ✅ NUEVO (quirúrgico): capturar idioma global antes de generar itinerarios
  if (typeof plannerState !== 'undefined' && plannerState && plannerState.collectingItineraryLang) {
    plannerState.collectingItineraryLang = false;
    plannerState.itineraryLang = String(text || '').trim();

    chatMsg(tone.confirmAll, 'ai');

    (async ()=>{
      showWOW(true, t('overlayGenerating'));
      for(const {city} of savedDestinations){
        await generateCityItinerary(city);
      }
      showWOW(false);
      chatMsg(tone.doneAll, 'ai');
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

  // 6) Cambiar horas
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

      // ✅ AJUSTE QUIRÚRGICO (multi-idioma real): NO forzar ES/EN por getLang(); responder en el idioma real del mensaje del usuario
      const ans = await callAgent(
`Reply in the SAME language as the user's message (no JSON):\n"${text}"`,
        true
      );

      chatMsg(ans || (getLang()==='es' ? '¿Algo más que quieras saber?' : 'Anything else you want to know?'));
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

    // ✅ AJUSTE QUIRÚRGICO (multi-idioma real): instrucción explícita para usar el idioma del texto del usuario
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
- Para auroras: propone al menos una noche plausible si aplica.
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

/* ==============================
   SECCIÓN 20 · Orden de ciudades + Eventos
================================= */
function addRowReorderControls(row){
  const ctrlWrap = document.createElement('div');
  ctrlWrap.style.display='flex';
  ctrlWrap.style.gap='.35rem';
  ctrlWrap.style.alignItems='center';
  const up = document.createElement('button'); up.textContent='↑'; up.className='btn ghost';
  const down = document.createElement('button'); down.textContent='↓'; down.className='btn ghost';
  ctrlWrap.appendChild(up); ctrlWrap.appendChild(down);
  row.appendChild(ctrlWrap);

  up.addEventListener('click', ()=>{
    if(row.previousElementSibling) $cityList.insertBefore(row, row.previousElementSibling);
  });
  down.addEventListener('click', ()=>{
    if(row.nextElementSibling) $cityList.insertBefore(row.nextElementSibling, row);
  });
}
const origAddCityRow = addCityRow;
addCityRow = function(pref){
  origAddCityRow(pref);
  const row = $cityList.lastElementChild;
  if(row) addRowReorderControls(row);
};

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

/* ==============================
   SECCIÓN 21 · INIT y listeners
   (v55.1 añade: validación previa de fechas, botón flotante Info Chat
    y reset con modal; mantiene startPlanning de v54)
================================= */
$addCity?.addEventListener('click', ()=>addCityRow());

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
   - Máximo: 10 perfiles (acompañado)
   - Permitir 0 (cero) perfiles
   - No integra aún con intake; solo UI
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
          <option value="other">${t('genderOther')}</option>
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
          <option value="25-39">${t('ageAdult2539')}</option>
          <option value="40-54">${t('ageAdult4054')}</option>
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

  // ✅ NUEVO (quirúrgico): "Tu información" en modo acompañado
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
        if($travelerSoloPanel) $travelerSoloPanel.style.display = 'block';
        if($travelerGroupPanel) $travelerGroupPanel.style.display = 'none';
      }else if(v === 'group'){
        if($travelerSoloPanel) $travelerSoloPanel.style.display = 'none';
        if($travelerGroupPanel) $travelerGroupPanel.style.display = 'block';
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

  // Estado inicial
  setTravelerButtonsState();
}

/* =========================================================
   🧾 MVP — Export (PDF / CSV / Email)
   ✅ Exporta desde el ESTADO real:
   - savedDestinations (orden de ciudades)
   - itineraries[city].byDay (filas por día)
========================================================= */

function safeFilePart(s){
  return String(s || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function downloadBlob(blob, filename){
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

/* ✅ NUEVO (quirúrgico): detecta delimitador para Excel según locale
   - Muchos Excel en ES usan ";" cuando el separador decimal es ","
*/
function detectCsvDelimiter(){
  try{
    const dec = (new Intl.NumberFormat().format(1.1) || '');
    return dec.includes(',') ? ';' : ',';
  }catch(_){
    return ',';
  }
}

/* ✅ AJUSTE (quirúrgico): escape depende del delimitador */
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
  // fallback suave
  if(!days.length){
    const savedN = savedDestinations?.find(x=>x.city===city)?.days;
    if(savedN && Number.isFinite(+savedN) && +savedN>0){
      return Array.from({length:+savedN}, (_,i)=>i+1);
    }
  }
  return days;
}

/* ✅ AJUSTE (quirúrgico): normaliza para Excel y PDF
   - Quita emojis/surrogates (causan PDFs corruptos en Acrobat)
   - Reemplaza comillas/dashes unicode problemáticos
   - Evita saltos de línea reales dentro de celdas (CSV) y reduce riesgo PDF
*/
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

  // Header fijo (Excel-friendly)
  lines.push([
    'City','Day','Date','Start time','End time','Activity','From','To','Transport','Duration','Notes'
  ].map(x=>csvEscape(x, delim)).join(delim));

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

  // ✅ BOM + CRLF para Excel (quirúrgico)
  const csv = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });

  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  const filename = `ITBMO-Itinerary-${yyyy}-${mm}-${dd}.csv`;

  downloadBlob(blob, filename);
}

function exportItineraryToPDF(){
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
  doc.save(filename);
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

function bindExportListeners(){
  $btnPDF?.addEventListener('click', (e)=>{
    e.preventDefault();
    exportItineraryToPDF();
  });

  $btnCSV?.addEventListener('click', (e)=>{
    e.preventDefault();
    exportItineraryToCSV();
  });

  $btnEmail?.addEventListener('click', (e)=>{
    e.preventDefault();
    sendItineraryByEmail();
  });
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
  setTimeout(()=>overlay.classList.add('active'), 10);

  const confirmReset = overlay.querySelector('#confirm-reset');
  const cancelReset  = overlay.querySelector('#cancel-reset');

  confirmReset.addEventListener('click', ()=>{
    // 🔄 Estado principal
    $cityList.innerHTML=''; savedDestinations=[]; itineraries={}; cityMeta={};
    addCityRow();
    $start.disabled = true;
    $tabs.innerHTML=''; $itWrap.innerHTML='';
    $chatBox.style.display='none'; $chatM.innerHTML='';
    session = []; hasSavedOnce=false; pendingChange=null;

    // 🔄 Flags de planificación
    planningStarted = false;
    metaProgressIndex = 0;
    collectingHotels = false;
    isItineraryLocked = false;
    activeCity = null;

    // 🔄 Limpiar overlays/tooltips si están activos
    try { $overlayWOW && ($overlayWOW.style.display = 'none'); } catch(_) {}
    qsa('.date-tooltip').forEach(t0 => t0.remove());

    // 🔄 Restaurar formulario lateral a valores por defecto
    const $sc = qs('#special-conditions'); if($sc) $sc.value = '';
    const $ad = qs('#p-adults');   if($ad) $ad.value = '1';
    const $yo = qs('#p-young');    if($yo) $yo.value = '0';
    const $ch = qs('#p-children'); if($ch) $ch.value = '0';
    const $in = qs('#p-infants');  if($in) $in.value = '0';
    const $se = qs('#p-seniors');  if($se) $se.value = '0';
    const $bu = qs('#budget');     if($bu) $bu.value = '';
    const $cu = qs('#currency');   if($cu) $cu.value = 'USD';

    // ✅ NUEVO: reset UI de viajeros (modo/paneles/selects/perfiles)
    resetTravelersUI();

    // 🔄 Sincronizar plannerState (definido en Sección 1)
    if (typeof plannerState !== 'undefined') {
      plannerState.destinations = [];
      plannerState.specialConditions = '';
      plannerState.travelers = { adults:1, young:0, children:0, infants:0, seniors:0 };
      plannerState.budget = '';
      plannerState.currency = 'USD';
      plannerState.forceReplan = {}; // 🧼 limpiar banderas de replanificación
    }

    overlay.classList.remove('active');
    setTimeout(()=>overlay.remove(), 300);

    // 🧹 Desbloquear sidebar tras reinicio
    if ($sidebar) $sidebar.classList.remove('disabled');

    // 🧹 Restaurar Info Floating si aplica
    if ($infoFloating){
      $infoFloating.style.pointerEvents = 'auto';
      $infoFloating.style.opacity = '1';
      $infoFloating.disabled = false;
    }

    // 🧹 Desactivar botón de reinicio
    if ($resetBtn) $resetBtn.setAttribute('disabled','true');

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

// ▶️ Start: valida fechas (formato v54) y luego ejecuta startPlanning()
$start?.addEventListener('click', ()=>{
  if(!validateBaseDatesDMY()) return;
  startPlanning();
});
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

  // ✅ QUIRÚRGICO: evitar crash si no existe el upsell en el DOM
  if($upsell) $upsell.style.display='flex';
});
$upsellClose?.addEventListener('click', ()=>{
  // ✅ QUIRÚRGICO: evitar crash si no existe el upsell en el DOM
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
function openInfoModal(){
  const modal = qs('#info-chat-modal');
  if(!modal) return;
  modal.style.display = 'flex';
  modal.classList.add('active');

  // 🆕 Hook para CSS tipo ChatGPT (sin forzar estilos globales)
  document.body.classList.add('itbmo-info-open');
}
function closeInfoModal(){
  const modal = qs('#info-chat-modal');
  if(!modal) return;
  modal.classList.remove('active');
  modal.style.display = 'none';

  // 🆕 Hook para CSS tipo ChatGPT
  document.body.classList.remove('itbmo-info-open');
}
async function sendInfoMessage(){
  const input = qs('#info-chat-input');
  const btn   = qs('#info-chat-send');
  if(!input || !btn) return;
  const txt = (input.value||'').trim();
  if(!txt) return;
  infoChatMsg(txt,'user');
  input.value='';
  input.style.height = 'auto'; // reset altura tras envío
  const ans = await callInfoAgent(txt);
  infoChatMsg(ans||'');
}
function bindInfoChatListeners(){
  const toggleTop = qs('#info-chat-toggle');
  const toggleFloating = qs('#info-chat-floating'); // 🆕 soporte flotante
  const close  = qs('#info-chat-close');
  const send   = qs('#info-chat-send');
  const input  = qs('#info-chat-input');

  // Limpieza previa por si se re-vincula
  toggleTop?.replaceWith(toggleTop.cloneNode(true));
  toggleFloating?.replaceWith(toggleFloating.cloneNode(true));
  close?.replaceWith(close.cloneNode(true));
  send?.replaceWith(send.cloneNode(true));

  const tTop = qs('#info-chat-toggle');
  const tFloat = qs('#info-chat-floating');
  const c2 = qs('#info-chat-close');
  const s2 = qs('#info-chat-send');
  const i2 = qs('#info-chat-input');

  [tTop, tFloat].forEach(btn=>{
    btn?.addEventListener('click', (e)=>{ e.preventDefault(); openInfoModal(); });
  });
  c2?.addEventListener('click', (e)=>{ e.preventDefault(); closeInfoModal(); });
  s2?.addEventListener('click', (e)=>{ e.preventDefault(); sendInfoMessage(); });

  // Chat estilo GPT: Enter = enviar / Shift+Enter = salto de línea
  i2?.addEventListener('keydown', (e)=>{
    if(e.key==='Enter' && !e.shiftKey){
      e.preventDefault();
      sendInfoMessage();
    }
  });

  // Textarea auto-ajustable
  if(i2){
    i2.setAttribute('rows','1');
    i2.style.overflowY = 'hidden';
    const maxRows = 10;
    i2.addEventListener('input', ()=>{
      i2.style.height = 'auto';
      const lineHeight = parseFloat(window.getComputedStyle(i2).lineHeight) || 20;
      const lines = Math.min(i2.value.split('\n').length, maxRows);
      i2.style.height = `${lineHeight * lines + 8}px`;
      i2.scrollTop = i2.scrollHeight;
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

// Inicialización
document.addEventListener('DOMContentLoaded', ()=>{
  if(!document.querySelector('#city-list .city-row')) addCityRow();
  bindInfoChatListeners();

  // ✅ NUEVO: bind de viajeros (UI compacto MVP)
  bindTravelersListeners();

  // ✅ NUEVO (quirúrgico): sincroniza el perfil inicial que viene en el HTML
  renumberTravelerProfiles();
  setTravelerButtonsState();

  // ✅ NUEVO (quirúrgico): activar botones PDF/CSV/Email
  bindExportListeners();
});
