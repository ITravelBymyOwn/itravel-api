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
    /recommend me|recomiendame|recomiéndame/.test(low) ||
    low === 'recommended by planner' ||
    low === 'as appropriate'
  ){
    return '';
  }

  return raw;
}

function _sanitizeBaseLikeValue_(value='', fallback=''){
  let raw = String(value || '').trim();
  raw = raw
    .replace(/\b(recommend me|recomiendame|recomiéndame|recommended by planner|as appropriate)\b/ig, '')
    .replace(/\b(self[-\s]?drive|guided tour|rental car|walking|metro|taxi|bus|train|uber|private transfer)\b\s*$/ig, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,+/g, ',')
    .replace(/^[,\-\s]+|[,\-\s]+$/g, '')
    .trim();

  if(!raw) return String(fallback || '').trim();

  if(/^(in|en|à|a|de|desde)\s*$/i.test(raw)) return String(fallback || '').trim();

  return raw;
}

/* =========================================================
   PATCH HELPERS · ANTI-REPEAT / NORMALIZATION
========================================================= */
function _normalizeRepeatKey_(txt=''){
  return String(txt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _canonicalRouteAliasKey_(txt=''){
  let key = _normalizeRepeatKey_(txt);

  if(!key) return '';

  const replacements = [
    [/^(golden cycle|golden circle|circulo dorado|círculo dorado|cercle d or|cercle dor|circolo d oro|goldener kreis)$/i, 'golden circle'],
    [/\b(golden cycle|golden circle|circulo dorado|círculo dorado|cercle d or|cercle dor|circolo d oro|goldener kreis)\b/ig, 'golden circle'],

    [/^(south coast|costa sur|cote sud|côte sud|costa sul|sudurland|suourland|sudur coast|southern coast)$/i, 'south coast'],
    [/\b(south coast|costa sur|cote sud|côte sud|costa sul|sudurland|suourland|southern coast)\b/ig, 'south coast'],

    [/^(snaefellsnes|snaefellsnes peninsula|snaefellsnes península|peninsula de snaefellsnes|península de snaefellsnes|snaefellsnes route)$/i, 'snaefellsnes peninsula'],
    [/\b(snaefellsnes|snaefellsnes peninsula|peninsula de snaefellsnes|península de snaefellsnes)\b/ig, 'snaefellsnes peninsula'],

    [/^(reykjanes|reykjanes peninsula|peninsula de reykjanes|península de reykjanes|reykjanes route)$/i, 'reykjanes peninsula'],
    [/\b(reykjanes peninsula|peninsula de reykjanes|península de reykjanes|reykjanes)\b/ig, 'reykjanes peninsula'],

    [/^(blue lagoon|laguna azul|lagoa azul|lagon bleu)$/i, 'blue lagoon'],
    [/\b(blue lagoon|laguna azul|lagoa azul|lagon bleu)\b/ig, 'blue lagoon'],

    [/^(sky lagoon|laguna sky|lagon sky)$/i, 'sky lagoon'],
    [/\b(sky lagoon|laguna sky|lagon sky)\b/ig, 'sky lagoon'],

    [/^(silver circle|circulo plateado|círculo plateado|silver route|borgarfjordur|borgarfjörður)$/i, 'silver circle borgarfjordur'],
    [/\b(silver circle|circulo plateado|círculo plateado|borgarfjordur|borgarfjörður)\b/ig, 'silver circle borgarfjordur'],

    [/^(old town|historic center|historical center|centro historico|centro histórico|vieille ville|casco antiguo|ciudad vieja)$/i, 'historic center'],
    [/\b(old town|historic center|historical center|centro historico|centro histórico|vieille ville|casco antiguo|ciudad vieja)\b/ig, 'historic center'],

    [/^(waterfront|riverside|riverfront|harbor|harbour|puerto|malecon|malecón|promenade|paseo maritimo|paseo marítimo)$/i, 'waterfront harbor'],
    [/\b(waterfront|riverside|riverfront|harbor|harbour|puerto|malecon|malecón|promenade|paseo maritimo|paseo marítimo)\b/ig, 'waterfront harbor'],

    [/^(whale watching|whales|avistamiento de ballenas|observacion de ballenas|observación de ballenas|baleines|walbeobachtung)$/i, 'whale watching'],
    [/\b(whale watching|avistamiento de ballenas|observacion de ballenas|observación de ballenas|baleines|walbeobachtung)\b/ig, 'whale watching'],

    [/^(lava tunnel|lava tube|tunel de lava|túnel de lava|tube de lave)$/i, 'lava tunnel'],
    [/\b(lava tunnel|lava tube|tunel de lava|túnel de lava|tube de lave)\b/ig, 'lava tunnel']
  ];

  replacements.forEach(([pattern, replacement])=>{
    key = key.replace(pattern, replacement);
  });

  return key.replace(/\s+/g, ' ').trim();
}

function _macroAliasKey_(value=''){
  return _canonicalRouteAliasKey_(value || '');
}

function _isReturnLikeRow_(row={}){
  if(typeof _isReturnRow_ === 'function' && _isReturnRow_(row)) return true;

  const txt = _normalizeRepeatKey_(`${row?.activity || ''} ${row?.to || ''} ${row?.notes || ''}`);
  return /\b(return to|regreso a|retorno a|volver a|retour a|retour vers|regresso a|back to|back in|return)\b/.test(txt);
}

function _isDaylightSensitiveRow_(row={}){
  if(_isAuroraRow_(row) || _isReturnLikeRow_(row)) return false;

  const txt = _normalizeRepeatKey_(`${row?.activity || ''} ${row?.to || ''} ${row?.notes || ''}`);
  return /\b(waterfall|cascada|beach|playa|black sand|arena negra|cliff|acantilado|viewpoint|mirador|volcano|volcan|volcán|glacier|glaciar|lagoon|laguna|lake|lago|park|parque|national park|parque nacional|canyon|cañon|cañón|coast|costa|peninsula|península|fjord|fiordo|mountain|montana|montaña|valley|valle|lava field|campo de lava|crater|crater|cráter|geyser|geysir|geothermal|geotermal|harbor walk|scenic drive|panoramic|panoramica|panorámica|village|pueblo|fishing village|boardwalk|sendero|trail)\b/.test(txt);
}

function _latestDaylightEndMin_(city='', totalDays=1){
  const cityKey = _normalizeRepeatKey_(city);

  if(/\b(reykjavik|iceland|islandia|tromso|tromsø|rovaniemi|kiruna|akureyri|abisko|fairbanks|yellowknife)\b/.test(cityKey)){
    return 17 * 60 + 30;
  }

  return 19 * 60;
}

function _hasDaylightTimingIssue_(dayRows=[], city='', totalDays=1){
  const latest = _latestDaylightEndMin_(city, totalDays);

  return (dayRows || []).some(r=>{
    if(!_isDaylightSensitiveRow_(r)) return false;

    const start = _hhmmToMin_(r?.start);
    const end = _hhmmToMin_(r?.end);

    if(start !== null && start >= latest) return true;
    if(end !== null && end > latest + 45) return true;

    return false;
  });
}

function _regionalDayMissingReturn_(dayRows=[], city=''){
  const rows = (dayRows || []).filter(r => !_isAuroraRow_(r));
  if(!_isRegionalDay_(rows, city)) return false;

  const hasReturn = rows.some(r => _isReturnLikeRow_(r));
  if(hasReturn) return false;

  const macros = _dayMacroSet_(rows, city).filter(m => m && m !== 'urban-base');
  const hasRegionalMacro = macros.some(m => _isRegionalMacroKey_(m));
  const endsOutsideBase = rows.length ? _activityMacroKey_(rows[rows.length - 1]?.activity || '', city) !== 'urban-base' : false;

  return hasRegionalMacro || endsOutsideBase;
}

function _dayExperienceBucket_(dayRows=[], city=''){
  const rows = (dayRows || []).filter(r => !_isAuroraRow_(r));
  const txt = _normalizeRepeatKey_(rows.map(r => `${r?.activity || ''} ${r?.to || ''} ${r?.notes || ''}`).join(' '));
  const macroSig = _regionalMacroSignature_(rows, city);

  if(/\b(whale watching|ballenas|baleines|wildlife|boat|barco|cruise|ferry|sailing|harbor tour)\b/.test(txt)) return 'wildlife_boat';
  if(/\b(spa|thermal|hot spring|termas|lagoon|laguna|onsen|hammam|wellness)\b/.test(txt)) return 'thermal_wellness';
  if(/\b(lava tunnel|lava tube|ice cave|cave|caverna|tunel|túnel|snowmobile|glacier hike|horseback|horse riding|adventure)\b/.test(txt)) return 'adventure_special';
  if(/\b(food|market|mercado|restaurant|restaurante|cafe|café|culinary|gastronomy|gastronomia|gastronomía|fish market)\b/.test(txt) && !_isRegionalDay_(rows, city)) return 'food_local';
  if(/\b(museum|museo|gallery|galeria|galería|church|cathedral|iglesia|catedral|architecture|arquitectura|design)\b/.test(txt) && !_isRegionalDay_(rows, city)) return 'urban_culture';
  if(_isRegionalDay_(rows, city)) return `regional_${macroSig || 'route'}`;
  if(/\b(waterfront|harbor|harbour|puerto|promenade|malecon|malecón|riverside)\b/.test(txt)) return 'waterfront_local';

  return _dayDominantKind_(rows, city) || 'general';
}

function _areDaysExperienceDuplicates_(rowsA=[], rowsB=[], city=''){
  const bucketA = _dayExperienceBucket_(rowsA, city);
  const bucketB = _dayExperienceBucket_(rowsB, city);

  if(bucketA && bucketB && bucketA === bucketB){
    if(bucketA.startsWith('regional_')) return true;

    const poiOverlap = _poiOverlapRatio_(rowsA, rowsB, city);
    const shape = _areDaysStructurallyTooSimilar_(rowsA, rowsB, city);
    return poiOverlap >= 0.25 || shape;
  }

  return false;
}

function _canonicalActivityKey_(activity='', city=''){
  let key = _normalizeRepeatKey_(activity);

  const cityKey = _normalizeRepeatKey_(city);
  if(cityKey){
    const prefix = `${cityKey} `;
    if(key.startsWith(prefix)){
      key = key.slice(prefix.length).trim();
    }
  }

  key = key
    .replace(/^(golden circle|south coast|snaefellsnes peninsula|snaefellsnes|reykjanes peninsula|reykjanes|reykjavik)\s+/i, '')
    .trim();

  return _canonicalRouteAliasKey_(key);
}

function _rowSemanticKey_(row={}, city=''){
  const activityKey = _canonicalActivityKey_(row?.activity || '', city);
  const toKey = _normalizeRepeatKey_(row?.to || '');
  return [activityKey, toKey].filter(Boolean).join(' | ');
}

function _activityMacroKey_(activity='', city=''){
  const txt = String(activity || '');
  const left = txt.split(/\s+[–-]\s+/)[0] || txt;
  let key = _normalizeRepeatKey_(left);
  const cityKey = _normalizeRepeatKey_(city);

  if(cityKey && key === cityKey) return 'urban-base';
  if(cityKey && key.startsWith(cityKey + ' ')) key = key.slice(cityKey.length).trim();

  return _macroAliasKey_(key || 'unknown') || 'unknown';
}

function _rowShapeToken_(row={}, city=''){
  const activity = String(row?.activity || '');
  const macro = _activityMacroKey_(activity, city);
  const txt = _normalizeRepeatKey_(`${row?.activity || ''} ${row?.to || ''} ${row?.notes || ''}`);

  let kind = 'generic';
  if(_isReturnRow_(row)) kind = 'return';
  else if(/\b(museum|museo|gallery|galeria|galería|exhibition|exposicion|exposición)\b/.test(txt)) kind = 'museum';
  else if(/\b(church|cathedral|temple|monastery|iglesia|catedral|templo|monasterio|basilica|basílica)\b/.test(txt)) kind = 'heritage';
  else if(/\b(waterfall|cascada|beach|playa|cliff|acantilado|viewpoint|mirador|volcano|volcan|volcán|glacier|glaciar|lagoon|laguna|lake|lago|park|parque|canyon|cañon|cañón)\b/.test(txt)) kind = 'nature';
  else if(/\b(food|market|mercado|restaurant|restaurante|lunch|almuerzo|dinner|cena|cafe|café|coffee)\b/.test(txt)) kind = 'food';
  else if(/\b(walk|stroll|paseo|caminar|promenade|waterfront|harbor|harbour|puerto|malecon|malecón)\b/.test(txt)) kind = 'walk';
  else if(/\b(spa|thermal|termas|hot spring|hotspring|geothermal|lagoon|hammam|onsen)\b/.test(txt)) kind = 'relax';
  else if(/\b(tour|route|ruta|circle|circulo|círculo|coast|costa|peninsula|península|island|isla|valley|valle)\b/.test(txt)) kind = 'regional';

  return `${macro}:${kind}`;
}

function _dayStructuralSignature_(dayRows=[], city=''){
  const rows = (dayRows || []).slice().sort((a,b)=> String(a?.start || '').localeCompare(String(b?.start || '')));
  const tokens = rows
    .filter(r => !_isAuroraRow_(r))
    .map(r => _rowShapeToken_(r, city))
    .filter(Boolean);

  const macroSeq = tokens.map(t => t.split(':')[0]).join('>');
  const kindSeq = tokens.map(t => t.split(':')[1]).join('>');
  const macroSet = [...new Set(tokens.map(t => t.split(':')[0]))].join('|');
  const kindSet = [...new Set(tokens.map(t => t.split(':')[1]))].join('|');

  return {
    macroSeq,
    kindSeq,
    macroSet,
    kindSet,
    rowCount: tokens.length,
    raw: `${macroSeq}::${kindSeq}`
  };
}

function _similarityRatio_(a='', b=''){
  const aa = String(a || '').split(/>|\|/).filter(Boolean);
  const bb = String(b || '').split(/>|\|/).filter(Boolean);
  if(!aa.length || !bb.length) return 0;

  const setA = new Set(aa);
  const setB = new Set(bb);
  let inter = 0;
  setA.forEach(x=>{ if(setB.has(x)) inter++; });

  return inter / Math.max(setA.size, setB.size, 1);
}

function _areDaysStructurallyTooSimilar_(rowsA=[], rowsB=[], city=''){
  const a = _dayStructuralSignature_(rowsA, city);
  const b = _dayStructuralSignature_(rowsB, city);

  if(a.rowCount < 3 || b.rowCount < 3) return false;

  const macroSim = _similarityRatio_(a.macroSet, b.macroSet);
  const kindSim = _similarityRatio_(a.kindSeq, b.kindSeq);

  if(a.macroSeq && b.macroSeq && a.macroSeq === b.macroSeq && kindSim >= 0.6) return true;
  if(macroSim >= 0.8 && kindSim >= 0.75) return true;
  if(a.kindSeq === b.kindSeq && macroSim >= 0.6) return true;

  return false;
}

function _isForbiddenHighlight_(row={}, forbiddenList=[], city=''){
  const rowKey = _rowSemanticKey_(row, city);
  if(!rowKey) return false;

  return (forbiddenList || []).some(f=>{
    const fk = _canonicalActivityKey_(String(f || ''), city);
    if(!fk) return false;
    return rowKey.includes(fk) || fk.includes(rowKey);
  });
}

function _isRegionalMacroKey_(macro=''){
  const key = _normalizeRepeatKey_(macro);
  if(!key || key === 'urban-base') return false;

  return /\b(circle|circulo|círculo|coast|costa|peninsula|península|snaefellsnes|reykjanes|fjord|fiordo|route|ruta|loop|circuit|circuito|valley|valle|mountain|montana|montaña|volcano|volcan|volcán|glacier|glaciar|lagoon|laguna|lake|lago|canyon|cañon|cañón|island|isla|national park|parque nacional|region|región|silver|golden|south|north|east|west|heritage route|wine region|wine area|monastery route|thermal route|whale watching|ballenas|lava tunnel|ice cave|glacier route|boat route|wildlife route)\b/.test(key);
}

function _isRegionalDay_(dayRows=[], city=''){
  const rows = (dayRows || []).filter(r => !_isAuroraRow_(r));
  if(!rows.length) return false;

  const macros = rows.map(r => _activityMacroKey_(r?.activity || '', city));
  const regionalMacroCount = macros.filter(m => _isRegionalMacroKey_(m)).length;
  const returnCount = rows.filter(r => _isReturnLikeRow_(r)).length;

  return regionalMacroCount >= Math.max(2, Math.ceil(rows.length * 0.45)) || returnCount > 0;
}

function _isUrbanBaseDay_(dayRows=[], city=''){
  const rows = (dayRows || []).filter(r => !_isAuroraRow_(r));
  if(!rows.length) return false;
  if(_isRegionalDay_(rows, city)) return false;

  const urbanCount = rows.filter(r => _activityMacroKey_(r?.activity || '', city) === 'urban-base').length;
  return urbanCount >= Math.max(2, Math.ceil(rows.length * 0.5));
}

function _dayDominantKind_(dayRows=[], city=''){
  const counts = {};
  (dayRows || []).forEach(r=>{
    if(_isAuroraRow_(r) || _isReturnLikeRow_(r)) return;
    const kind = String(_rowShapeToken_(r, city).split(':')[1] || 'generic');
    counts[kind] = (counts[kind] || 0) + 1;
  });

  return Object.keys(counts).sort((a,b)=> counts[b] - counts[a])[0] || 'generic';
}

function _dayMacroSet_(dayRows=[], city=''){
  return [...new Set((dayRows || [])
    .filter(r => !_isAuroraRow_(r))
    .map(r => _activityMacroKey_(r?.activity || '', city))
    .filter(Boolean)
  )];
}

function _countUrbanBaseDays_(rows=[], city=''){
  const byDay = _groupRowsByDay_(rows);
  return Object.keys(byDay).filter(d => _isUrbanBaseDay_(byDay[d] || [], city)).length;
}

function _findStrategicRepairDays_(rows=[], requestedDays=[], totalDays=1, city=''){
  const n = Number(totalDays || 0);
  if(n < 4) return [];

  const byDay = _groupRowsByDay_(rows);
  const days = (requestedDays || []).map(Number).sort((a,b)=>a-b);
  const repair = new Set();
  const urbanDays = [];

  days.forEach(day=>{
    const dayRows = byDay[day] || [];
    if(!dayRows.length) return;
    if(_isUrbanBaseDay_(dayRows, city)) urbanDays.push(day);
  });

  for(let i=0; i<urbanDays.length; i++){
    const d = urbanDays[i];
    const rowsD = byDay[d] || [];

    for(let j=0; j<i; j++){
      const prev = urbanDays[j];
      const rowsPrev = byDay[prev] || [];
      const sameShape = _areDaysStructurallyTooSimilar_(rowsPrev, rowsD, city);
      const sameKind = _dayDominantKind_(rowsPrev, city) === _dayDominantKind_(rowsD, city);
      const macroOverlap = _similarityRatio_(_dayMacroSet_(rowsPrev, city).join('|'), _dayMacroSet_(rowsD, city).join('|'));
      const sameBucket = _areDaysExperienceDuplicates_(rowsPrev, rowsD, city);

      if(sameShape || sameBucket || (sameKind && macroOverlap >= 0.5)){
        repair.add(d);
        break;
      }
    }
  }

  const regionalDays = days.filter(day => _isRegionalDay_(byDay[day] || [], city)).length;
  const urbanCount = urbanDays.length;

  if(n >= 7 && urbanCount >= 3 && regionalDays < 4){
    urbanDays.slice(2).forEach(d => repair.add(d));
  }

  _findMicroStopRepairDays_(rows, days, totalDays, city).forEach(d => repair.add(d));
  _findRepeatedItineraryRepairDays_(rows, days, totalDays, city).forEach(d => repair.add(d));
  _findDaylightRepairDays_(rows, days, totalDays, city).forEach(d => repair.add(d));
  _findMissingReturnRepairDays_(rows, days, totalDays, city).forEach(d => repair.add(d));
  _findExperienceBucketRepairDays_(rows, days, totalDays, city).forEach(d => repair.add(d));

  return [...repair].filter(d => days.includes(Number(d))).sort((a,b)=>a-b);
}

function _replaceRowsForDays_(baseRows=[], replacementRows=[], days=[]){
  const daySet = new Set((days || []).map(Number));
  const kept = (baseRows || []).filter(r => !daySet.has(Number(r?.day)));
  const repl = (replacementRows || []).filter(r => daySet.has(Number(r?.day)));
  return [...kept, ...repl];
}

function _hasMinimumRowsForDays_(rows=[], days=[]){
  const byDay = _groupRowsByDay_(rows);
  return (days || []).every(day=>{
    const clean = (byDay[day] || []).filter(r => !_isAuroraRow_(r));
    return clean.length >= 3;
  });
}

function _maxMeaningfulGapMinutes_(dayRows=[]){
  const rows = (dayRows || [])
    .filter(r => !_isAuroraRow_(r))
    .slice()
    .sort((a,b)=> String(a?.start || '').localeCompare(String(b?.start || '')));

  let maxGap = 0;

  for(let i=1; i<rows.length; i++){
    const prevEnd = _hhmmToMin_(rows[i-1]?.end);
    const nextStart = _hhmmToMin_(rows[i]?.start);

    if(prevEnd === null || nextStart === null) continue;

    const gap = nextStart - prevEnd;
    if(gap > maxGap) maxGap = gap;
  }

  return maxGap;
}

function _hasCriticalDayGap_(dayRows=[], city=''){
  const rows = (dayRows || []).filter(r => !_isAuroraRow_(r));
  if(rows.length < 3) return false;

  const maxGap = _maxMeaningfulGapMinutes_(rows);
  if(maxGap < 150) return false;

  if(_isRegionalDay_(rows, city)) return true;

  const dominant = _dayDominantKind_(rows, city);
  return ['nature','regional','walk'].includes(dominant) && maxGap >= 180;
}

function _hasThinRegionalDay_(dayRows=[], city=''){
  const rows = (dayRows || []).filter(r => !_isAuroraRow_(r));
  if(!_isRegionalDay_(rows, city)) return false;

  const meaningfulRows = rows.filter(r => !_isReturnLikeRow_(r));
  const maxGap = _maxMeaningfulGapMinutes_(rows);

  return meaningfulRows.length < 5 || maxGap >= 150;
}

function _regionalMacroSignature_(dayRows=[], city=''){
  const macros = _dayMacroSet_(dayRows, city)
    .filter(m => m && m !== 'urban-base')
    .map(m => _canonicalRouteAliasKey_(m))
    .filter(Boolean);

  const regional = macros.filter(m => _isRegionalMacroKey_(m));

  return [...new Set(regional.length ? regional : macros)].sort().join('|');
}

function _dayPOISet_(dayRows=[], city=''){
  return [...new Set((dayRows || [])
    .filter(r => !_isAuroraRow_(r) && !_isReturnLikeRow_(r))
    .map(r => _rowSemanticKey_(r, city))
    .filter(Boolean)
  )];
}

function _poiOverlapRatio_(rowsA=[], rowsB=[], city=''){
  const a = _dayPOISet_(rowsA, city);
  const b = _dayPOISet_(rowsB, city);
  if(!a.length || !b.length) return 0;

  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;

  setA.forEach(x=>{
    if(setB.has(x)) inter++;
  });

  return inter / Math.max(Math.min(setA.size, setB.size), 1);
}

function _areRegionalDaysTooSimilar_(rowsA=[], rowsB=[], city=''){
  if(!_isRegionalDay_(rowsA, city) || !_isRegionalDay_(rowsB, city)) return false;

  const sigA = _regionalMacroSignature_(rowsA, city);
  const sigB = _regionalMacroSignature_(rowsB, city);

  if(sigA && sigB && sigA === sigB) return true;

  const macroOverlap = _similarityRatio_(sigA, sigB);
  const poiOverlap = _poiOverlapRatio_(rowsA, rowsB, city);

  if(macroOverlap >= 0.75 && poiOverlap >= 0.35) return true;
  if(poiOverlap >= 0.5) return true;

  return false;
}

function _findMicroStopRepairDays_(rows=[], requestedDays=[], totalDays=1, city=''){
  const n = Number(totalDays || 0);
  if(n < 3) return [];

  const byDay = _groupRowsByDay_(rows);
  const days = (requestedDays || []).map(Number).sort((a,b)=>a-b);
  const repair = new Set();

  days.forEach(day=>{
    const dayRows = byDay[day] || [];
    if(!dayRows.length) return;

    if(_hasThinRegionalDay_(dayRows, city) || _hasCriticalDayGap_(dayRows, city)){
      repair.add(day);
    }
  });

  return [...repair].sort((a,b)=>a-b);
}

function _findRepeatedItineraryRepairDays_(rows=[], requestedDays=[], totalDays=1, city=''){
  const n = Number(totalDays || 0);
  if(n < 4) return [];

  const byDay = _groupRowsByDay_(rows);
  const days = (requestedDays || []).map(Number).sort((a,b)=>a-b);
  const repair = new Set();

  for(let i=0; i<days.length; i++){
    const day = days[i];
    const rowsD = byDay[day] || [];
    if(!rowsD.length) continue;

    for(let j=0; j<i; j++){
      const prev = days[j];
      const rowsPrev = byDay[prev] || [];
      if(!rowsPrev.length) continue;

      if(_areRegionalDaysTooSimilar_(rowsPrev, rowsD, city)){
        repair.add(day);
        break;
      }

      if(_areDaysStructurallyTooSimilar_(rowsPrev, rowsD, city)){
        repair.add(day);
        break;
      }

      if(_areDaysExperienceDuplicates_(rowsPrev, rowsD, city)){
        repair.add(day);
        break;
      }
    }
  }

  return [...repair].sort((a,b)=>a-b);
}

function _findDaylightRepairDays_(rows=[], requestedDays=[], totalDays=1, city=''){
  const byDay = _groupRowsByDay_(rows);
  const repair = [];

  (requestedDays || []).map(Number).forEach(day=>{
    const dayRows = byDay[day] || [];
    if(!dayRows.length) return;

    if(_hasDaylightTimingIssue_(dayRows, city, totalDays)){
      repair.push(day);
    }
  });

  return [...new Set(repair)].sort((a,b)=>a-b);
}

function _findMissingReturnRepairDays_(rows=[], requestedDays=[], totalDays=1, city=''){
  const byDay = _groupRowsByDay_(rows);
  const repair = [];

  (requestedDays || []).map(Number).forEach(day=>{
    const dayRows = byDay[day] || [];
    if(!dayRows.length) return;

    if(_regionalDayMissingReturn_(dayRows, city)){
      repair.push(day);
    }
  });

  return [...new Set(repair)].sort((a,b)=>a-b);
}

function _findExperienceBucketRepairDays_(rows=[], requestedDays=[], totalDays=1, city=''){
  const n = Number(totalDays || 0);
  if(n < 5) return [];

  const byDay = _groupRowsByDay_(rows);
  const days = (requestedDays || []).map(Number).sort((a,b)=>a-b);
  const buckets = {};
  const repair = new Set();

  days.forEach(day=>{
    const bucket = _dayExperienceBucket_(byDay[day] || [], city);
    if(!bucket) return;

    if(!buckets[bucket]) buckets[bucket] = [];
    buckets[bucket].push(day);
  });

  Object.keys(buckets).forEach(bucket=>{
    const bucketDays = buckets[bucket] || [];

    if(bucket.startsWith('regional_') && bucketDays.length > 1){
      bucketDays.slice(1).forEach(d => repair.add(d));
      return;
    }

    if(['urban_culture','food_local','waterfront_local'].includes(bucket) && bucketDays.length > 1){
      bucketDays.slice(1).forEach(d => repair.add(d));
    }
  });

  return [...repair].sort((a,b)=>a-b);
}

function _hasCriticalQualityIssueForDays_(rows=[], days=[], city=''){
  const byDay = _groupRowsByDay_(rows);

  return (days || []).some(day=>{
    const dayRows = byDay[day] || [];
    if(!dayRows.length) return true;
    if(_hasThinRegionalDay_(dayRows, city)) return true;
    if(_hasCriticalDayGap_(dayRows, city)) return true;
    if(_hasDaylightTimingIssue_(dayRows, city)) return true;
    if(_regionalDayMissingReturn_(dayRows, city)) return true;
    return false;
  });
}

/* =========================================================
   NEW HELPERS · DESTINATION-WIDE SELECTION BIAS
========================================================= */
function _buildExplorationModeBiasBlock_(city='', totalDays=1){
  const n = Number(totalDays || 0);

  if(n >= 7){
    return `
DESTINATION-WIDE SELECTION BIAS (CRITICAL):
- First determine whether "${city}" behaves more like:
  • a dense major city with many true urban imperdibles
  • a gateway base whose strongest value comes from outward day trips / nature / regional experiences
  • or a balanced hybrid between both
- This decision must be made dynamically from the destination's real candidate universe, not from hardcoded examples or a template.
- Build the itinerary according to the detected destination behavior:
  • Gateway/outward base: outward flagship clusters and iconic experience buckets must dominate.
  • Dense city: urban imperdibles must be covered deeply, but strong excursions still matter.
  • Hybrid: balance core city imperdibles with the strongest outward clusters and special experiences.

IF "${city}" behaves like a dense major city:
- You MUST still cover the core urban imperdibles first.
- But for a 7-day stay, you should normally still include around 2 strong day trips or near-city escapes if they are genuinely worthwhile and feasible.
- Do NOT spend all 7 days inside the city if strong outward options clearly exist.
- Urban days must use different district logic, not repeated museum + lunch + walk formulas.

IF "${city}" behaves like a gateway / outward base:
- The strongest external clusters should dominate.
- Keep pure city allocation tighter unless the city itself clearly deserves more.
- In a 7-day stay, pure base-city days should usually be limited to roughly 1–2.5 days unless the user asked otherwise.
- Prioritize flagship regional clusters before any secondary urban filler.
- After the core flagship clusters, use alternative experience buckets before repeating city filler:
  • wildlife / boat / marine experiences
  • thermal / spa / wellness experiences
  • light adventure / cave / glacier / mountain / valley experiences
  • food / local culture
  • indoor iconic backups
  • short scenic escapes

IF "${city}" behaves like a hybrid:
- Cover the city's major imperdibles properly.
- Then actively add the strongest outward experiences before building secondary urban filler days.

PRIORITY RULE FOR LONG STAYS:
- Never let secondary or tertiary urban content displace:
  • the main city imperdibles
  • the strongest feasible outward day trips
  • iconic special experiences that make the destination unique
- For 7-day stays, prefer:
  1. core city imperdibles
  2. strongest day trips / outward escapes
  3. distinctive special experience buckets
  4. only then secondary urban content
`.trim();
  }

  if(n >= 5){
    return `
DESTINATION-WIDE SELECTION BIAS:
- Determine whether "${city}" is mainly:
  • city-heavy
  • outward/gateway
  • or hybrid
- Make this decision dynamically from the destination's real candidate universe.
- Cover the main city imperdibles if the destination is city-heavy.
- But if strong outward options clearly exist, include at least 1 meaningful excursion before falling into weaker secondary city content.
- Use distinctive experience buckets before repeating the same urban day shape with different names.
`.trim();
  }

  return `
DESTINATION-WIDE SELECTION BIAS:
- Determine naturally whether "${city}" is better explored mainly through city content, outward content, special experiences, or a hybrid.
- Keep the itinerary focused on the strongest experiences only.
- Avoid repeated day shapes even in short trips.
`.trim();
}
function _buildCoverageGuardBlock_(city='', totalDays=1){
  const n = Number(totalDays || 0);

  if(n >= 7){
    return `
COVERAGE GUARD (CRITICAL):
- Before finalizing this block, mentally verify:
  • are the core city imperdibles already being covered somewhere in the trip?
  • are the strongest outward day trips / escapes already being covered somewhere in the trip?
  • are the destination's iconic special experiences already being covered somewhere in the trip?
  • are the days materially different in macro-cluster, geography, rhythm, and sequence?
- If the answer is NO and the destination clearly supports them, do NOT spend this block on weaker secondary urban content.
- For 7-day trips, the itinerary should feel like the user truly saw both:
  • the essential city
  • the essential surroundings
  • the destination's most iconic experiences
- If the destination clearly supports 2 or more strong day trips, the planner should normally include them before creating a third weak urban day.
- A day that merely changes POI names but repeats the same museum + food + walk + return structure is NOT sufficiently different.
- If the destination has iconic experience buckets (wildlife, boat, thermal, scenic rail, cave systems, glacier activities, food culture, etc.), use them before repeating generic urban filler.
`.trim();
  }

  return `
COVERAGE GUARD:
- Before finalizing, make sure this block is not using weaker city filler while stronger essential city content, stronger outward content, or stronger iconic experiences still remain unused.
- Avoid repeated day structures, not only repeated POI names.
`.trim();
}

function _buildUrbanDayQualityBlock_(city='', totalDays=1){
  const n = Number(totalDays || 0);

  if(n >= 6){
    return `
URBAN DAY QUALITY RULE:
- A secondary urban day must justify its existence by being materially different and strong.
- Do NOT generate a weaker urban day if:
  • a better outward option exists
  • OR a better special experience bucket exists
- Do NOT generate a generic "museum + lunch + walk + dinner" day unless that is truly the best remaining option.
- If the city still needs core imperdibles, prioritize those.
- If the core imperdibles are already covered, outward options and iconic experiences should usually outrank weak extra urban days.
- If an urban day is necessary, it must have a distinct identity:
  • different district / zone
  • different sequence
  • different experience type
  • different emotional arc
  • specific micro-stops
- Avoid repeated waterfront/harbor/promenade days unless the destination truly revolves around them.
`.trim();
  }

  return `
URBAN DAY QUALITY RULE:
- Urban days must stay meaningful and distinct, not generic.
- Do not repeat the same structure with different POI names.
`.trim();
}

function _buildMustSeeCoverageBlock_(city='', totalDays=1){
  const n = Number(totalDays || 0);

  return `
DESTINATION MUST-SEE COVERAGE (CRITICAL):
- Before building the itinerary, internally identify:
  • the destination's essential city imperdibles
  • the destination's essential regional/day-trip imperdibles (if applicable)
  • the destination's iconic special experiences
- Cover the strongest must-see highlights FIRST unless user constraints make them infeasible.
- Do NOT replace essential must-sees with secondary filler.
- If a destination behaves as a gateway/outward base, some regional day trips are considered MUST-SEE core experiences.
- For longer stays, the itinerary should progressively expand from:
  • core city imperdibles
  • to flagship regional routes
  • to iconic special experiences
  • to secondary content only afterward.
- If an essential must-see is intentionally skipped due to distance, closure, season, safety, weather, time, or user preference, briefly explain it in notes or followup.
- Each must-see cluster should appear only once unless the destination genuinely requires revisiting it.
`.trim();
}

function _cleanTransportField_(rows=[]){
  return (rows || []).map(r=>{
    const cleaned = _sanitizeTransportValue_(r?.transport);

    const cleanFrom = _sanitizeBaseLikeValue_(r?.from, '');
    const cleanTo   = _sanitizeBaseLikeValue_(r?.to, '');

    if(cleaned){
      return normalizeRow({
        ...r,
        from: cleanFrom || String(r?.from || '').trim(),
        to: cleanTo || String(r?.to || '').trim(),
        transport: cleaned
      }, Number(r?.day || 1));
    }

    const from = String(cleanFrom || r?.from || '').toLowerCase();
    const to   = String(cleanTo || r?.to || '').toLowerCase();
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
      /\b(peninsula|península|coast|costa|route|ruta|loop|circuit|circuito|circle|circulo|círculo|island|isla|archipelago|archipielago|archipiélago|fjord|fiordo|lake|lago|lagoon|laguna|valley|valle|mountain|montana|montaña|volcano|volcan|volcán|park|parque|national park|parque nacional|district|distrito|region|región|canyon|cañon|cañón|wine area|wine region|whale watching|ballenas|boat|harbor cruise|glacier|lava tunnel|ice cave)\b/.test(activity);

    const looksUrban = !looksReturn && !looksRegional;

    let fallback = 'Walking / Metro / Taxi (as appropriate)';

    if(
      /\breykjavik\b/.test(activity) ||
      /\breykjavik\b/.test(from) ||
      /\breykjavik\b/.test(to)
    ){
      if(sameArea) fallback = 'Walking';
      else fallback = 'Walking / Taxi / Public Bus';
    }else{
      if(sameArea) fallback = 'Walking';
      else if(looksUrban) fallback = 'Walking / Metro';
      else fallback = 'Rental car or Guided tour';
    }

    return normalizeRow({
      ...r,
      from: cleanFrom || String(r?.from || '').trim(),
      to: cleanTo || String(r?.to || '').trim(),
      transport: fallback
    }, Number(r?.day || 1));
  });
}

function _isAuroraPlausibleForCityAndDate_(city='', baseDate=''){
  const key = _normalizeRepeatKey_(city);

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

  const cityOk = plausibleCityHints.some(h => key.includes(_normalizeRepeatKey_(h)));
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
  const hotel = _sanitizeBaseLikeValue_(cityMeta?.[city]?.hotel || loc.hotelFallback, loc.hotelFallback) || loc.hotelFallback;

  const lastRow = (dayRows || [])
    .slice()
    .sort((a,b)=> String(a?.end || '').localeCompare(String(b?.end || '')))
    .pop() || null;

  const lastEnd = _hhmmToMin_(lastRow?.end);

  const baseStart = lastEnd !== null
    ? Math.max(lastEnd + 90, 21 * 60)
    : (21 * 60);

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

    const target = eveningRows.length
      ? eveningRows[eveningRows.length - 1]
      : dayRows[dayRows.length - 1];

    if(!target) return;

    const extraNote = (loc.auroraNotes || '').trim();
    if(!extraNote) return;

    const current = String(target.notes || '').trim();

    if(/aurora|northern lights|boreal/i.test(current)) return;

    target.notes = current
      ? `${current} ${extraNote}`
      : extraNote;
  });

  return _dedupeRows_([...(rows || []), ...injected], city);
}
function _fixReturnRowDurationConsistency_(rows=[]){
  const loc = _plannerLocalePack_();

  return (rows || []).map(r=>{
    if(!_isReturnLikeRow_(r)) return r;

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
  const promptBase = _sanitizeBaseLikeValue_(hotel || '', '');

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
  • NEVER output placeholders or leaked planner values such as "recommend me", "recomiéndame", "recommended by planner", etc. in ANY field
  • NEVER contaminate hotel/base/from/to strings with transport preference text
  • For a regional / radial / day-trip day, the LEFT side of "activity" MUST be the MACRO destination or route name, never the base city name
  • If a stop belongs to a known regional circuit chosen for that day, do NOT label it as "${city} – <Sub-stop>"
  • The base city name on the LEFT side is allowed only for true urban/local days

- DESTINATION MUST-SEE + BUCKET LOGIC:
  • First identify the destination's essential must-see universe:
    - core city imperdibles
    - flagship regional/day-trip imperdibles
    - special iconic experiences
    - seasonal experiences
    - family/adventure/food/wildlife/wellness buckets when relevant
  • If "${city}" behaves like a gateway base, regional tours and iconic experiences may be core must-sees.
  • For a 7-day gateway itinerary, do NOT fill weak urban days while unused must-see buckets remain.
  • Use different experience buckets before repeating any route:
    - flagship regional route
    - secondary regional route
    - wildlife / boat / marine
    - thermal / spa / wellness
    - cave / glacier / mountain / adventure light
    - food / local culture
    - indoor iconic backup
    - short scenic escape
  • Each selected day must have a distinct purpose and identity.

- CRITICAL MICRO-STOPS ENFORCEMENT:
  • regional / outward / scenic days MUST NOT contain giant dead gaps
  • if a regional day has gaps bigger than ~2h–2h30, you MUST enrich the same route with REAL intermediate micro-stops
  • examples of valid micro-stops:
    - viewpoints
    - cliffs
    - lava fields
    - cafés with scenic value
    - roadside photo stops
    - geothermal pockets
    - short boardwalks
    - fishing villages
    - local food stops
    - harbors
    - waterfalls
    - crater stops
    - scenic churches
    - basalt formations
    - small museums directly on-route
  • DO NOT leave a regional day sparse if the route naturally supports more exploration
  • a flagship scenic day should usually feel rich and continuous, not like 3 stops separated by huge voids
  • micro-stops must be real rows, not only notes

- HARD ANTI-REPEAT:
  • NEVER reuse the same flagship regional circuit twice unless the destination genuinely has no other worthwhile alternative
  • NEVER create two days with materially equivalent structure
  • equivalent names in other languages, misspellings, paraphrases, or tourism nicknames count as the SAME route
  • avoid repeated:
    - museum + lunch + walk + return
    - scenic stop + scenic stop + dinner
    - waterfront + food + harbor + return
    - old town + church + market + viewpoint
  • changing POI names alone is NOT enough
  • each day must have:
    - distinct geography
    - distinct rhythm
    - distinct macro-cluster
    - distinct emotional identity
    - distinct experience bucket

- DAYLIGHT / RETURN VALIDATION:
  • daylight-sensitive natural stops must be scheduled in daylight-friendly hours
  • do NOT place beaches, black sand beaches, waterfalls, cliffs, viewpoints, glaciers, parks, lava fields, craters, coastal roads, or scenic outdoor stops at night
  • if a regional/day-trip day exists, it MUST end with an explicit return row:
    "<Macro-tour> – Return to ${city}"
  • return row must be the final row of the regional day

- SOFT RULES:
  • normal urban day: usually 4–7 rows
  • flagship regional day: usually 6–10 rows when geography supports it
  • dense compact routes may reach around 8–12 rows if natural
  • avoid weak days whenever possible
  • prioritize WOW quality

- Hotel/base: ${JSON.stringify(promptBase)}
- Preferred transport: ${JSON.stringify(promptTransport)}
${forbiddenText ? `- Do NOT repeat these highlights already used elsewhere: ${forbiddenText}` : ''}
${forbiddenUrbanText ? `- Avoid reusing these urban clusters / neighborhoods unless strictly necessary: ${forbiddenUrbanText}` : ''}

${_buildMustSeeCoverageBlock_(city, totalDays)}
${_buildExplorationModeBiasBlock_(city, totalDays)}
${_buildCoverageGuardBlock_(city, totalDays)}
${_buildUrbanDayQualityBlock_(city, totalDays)}
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
  • NEVER output placeholders or leaked planner values such as "recommend me", "recomiéndame", "recommended by planner", etc. in ANY field
  • For a regional / radial / day-trip day, the LEFT side of "activity" MUST be the MACRO destination or route name, never the base city name
- MICRO-STOPS / GAP REPAIR:
  • if the missing day is regional/outward/scenic, do NOT return a sparse day
  • fill the day with real on-route micro-stops instead of leaving 2h+ gaps
  • use specific places, not vague filler
  • regional missing-day rebuilds should usually have 6–10 rows when geography supports it
- ANTI-REPEAT:
  • do NOT repeat a macro-region, circuit, route, neighborhood sequence, experience bucket, or day structure already used
  • treat translated names, misspellings, paraphrases, and tourism nicknames as duplicates
  • if a previous day used Golden Circle / Círculo Dorado / Golden Cycle, do not rebuild another Golden Circle-style day unless no alternative exists
  • if a previous day used South Coast / Costa Sur, do not rebuild another South Coast-style day unless the internal route is clearly different
  • if a previous day used a museum + lunch + walk rhythm, do not repeat that same rhythm
- MUST-SEE / BUCKET RECOVERY:
  • use the strongest unused must-see bucket before filling with generic urban content
  • consider unused iconic special experiences when relevant:
    - wildlife / boat / marine
    - thermal / spa / wellness
    - light adventure / cave / glacier / mountain / valley
    - food / local culture
    - indoor iconic backup
    - short scenic escape
- If the missing day is the final day of the trip, it must still be meaningful, polished, and memorable; do NOT make it feel like leftover filler.
- Use the remaining UNUSED candidate universe first, thinking radially from the base city.
- The replacement day must be built from what the destination still offers, not from a template route.
- For the chosen remaining cluster or local pack, mentally generate 5–15 possible real micro-stops if the destination genuinely offers them, then choose only the ones that fit coherently.
- If excursion/day trip exists, end with "<Region> – Return to ${city}".
- Daylight-sensitive natural stops must be scheduled before night.
- Hotel/base: ${JSON.stringify(promptBase)}
- Transport preference: ${JSON.stringify(promptTransport)}
- The result should feel globally premium and destination-aware, not generic.
- No text outside JSON.
`.trim();

  const buildStrategicRepairPrompt = (repairDays=[], currentRows=[]) => `
${FORMAT}
**ROLE:** Planner “Astra”. Strategic quality repair for "${city}".

The current itinerary already has usable rows, but the following day numbers are invalid or weak because they are too sparse, too gapped, repetitive, structurally similar, missing a return row, contain daylight-sensitive stops at night, or fail to use a stronger must-see bucket:
${JSON.stringify(repairDays)}

Return Format B JSON only:
{"destination":"${city}","rows":[...]}

MANDATORY:
- Generate replacement rows ONLY for these days: ${repairDays.join(', ')}.
- Every returned row MUST have day equal to one of these repair days only.
- Respect these windows intelligently: ${JSON.stringify(perDay.filter(x => repairDays.includes(Number(x?.day))))}.
- The end time provided by the planner is a HARD MAXIMUM boundary, not a target.
- Existing itinerary summary to avoid repeating:
${JSON.stringify((currentRows || []).map(r => ({
  day: r?.day,
  activity: r?.activity,
  from: r?.from,
  to: r?.to,
  transport: r?.transport,
  start: r?.start,
  end: r?.end,
  notes: String(r?.notes || '').slice(0, 180)
})).slice(0, 120))}

REPAIR OBJECTIVE:
- Fix the exact quality failure:
  • if the issue is a huge gap, add REAL on-route micro-stops or rebuild the route with a denser coherent sequence
  • if the issue is a thin regional day, expand it into a proper day trip with real stops
  • if the issue is repetition, replace it with a genuinely different macro-cluster or day identity
  • if the issue is daylight-sensitive content at night, move it earlier or replace it with night-compatible content
  • if the issue is missing return row, add a realistic final return row
  • if the issue is weak filler, use a stronger unused must-see or special experience bucket
- Do NOT return another sparse day.
- Do NOT return another structurally similar day.
- Do NOT solve the problem only by changing names.

MUST-SEE / EXPERIENCE BUCKET LOGIC — ULTRA CRITICAL:
- Before rebuilding, identify unused high-value buckets for this destination.
- Prefer an unused must-see bucket over repeated city filler.
- Potential global bucket types include:
  • flagship regional route
  • secondary regional route
  • wildlife / boat / marine
  • thermal / spa / wellness
  • cave / glacier / mountain / valley / light adventure
  • food / local culture
  • indoor iconic backup
  • short scenic escape
  • historic town / heritage route
  • architecture / design district
- For gateway/outward bases, regional routes and iconic special experiences are often core must-sees.
- The repaired day must have a clearly different identity from all existing days.

MICRO-STOP RULES — ULTRA CRITICAL:
- Regional / outward / scenic days must feel continuous and intentionally routed.
- Avoid gaps bigger than ~2h–2h30 unless the gap is a genuine long transfer.
- If there is a long transfer, the itinerary should still include useful stops before/after it so the day feels complete.
- For each regional repaired day, include real micro-stops such as:
  • viewpoints
  • cliffs
  • small towns
  • harbors
  • beaches
  • lava fields
  • waterfalls
  • crater stops
  • scenic cafés
  • boardwalks
  • geothermal areas
  • photo pullouts
  • local museums on-route
  • churches or landmarks directly on-route
- Do NOT use notes as a substitute for rows.
- The final rows themselves must contain enough real sub-stops.
- Iconic regional repaired days should usually produce 6–10 real rows when geography supports it.

ANTI-REPEAT RULES — ULTRA CRITICAL:
- Avoid all already-used macro-regions, circuits, rings, routes, neighborhoods, highlight combinations, and experience buckets.
- Treat translated names, misspellings, paraphrases, tourism nicknames, and alternate-language names as the SAME underlying route.
- If using the same broad region is unavoidable, the internal route must be clearly different:
  • different sub-stops
  • different sequence
  • different purpose
  • different geography
  • different rhythm
- NEVER repeat the same flagship route as a prior day.
- NEVER create two days that are equivalent in structure even if the names are different.
- If an existing day is:
  • museum + lunch + walk + dinner
  the repaired day must NOT follow the same pattern.
- If an existing day is:
  • scenic stop + scenic stop + return
  the repaired day must be denser or geographically different.
- Each repaired day must have a distinct identity.

REGIONAL / DAY-TRIP CONTRACT:
- For a regional/day-trip day, the LEFT side of "activity" MUST be the macro destination or route name, not the base city.
- A regional/day-trip replacement MUST end with "<Macro-tour> – Return to ${city}".
- The return row must be the FINAL row.
- Use real places in "from" and "to".
- Use realistic transport:
  • urban/local short movements: Walking / Taxi / Public transport as appropriate
  • regional/outward days: Rental car or Guided tour when appropriate
- Do not leak "recommend me", "recomiéndame", "recommended by planner", or transport preference text into any field.

DAYLIGHT / NIGHT CONTRACT:
- Do NOT schedule daylight-sensitive natural stops at night.
- Beaches, black sand beaches, waterfalls, cliffs, viewpoints, glaciers, parks, lava fields, craters, scenic villages, and coastal roads must be in daylight-friendly windows.
- Evening/night should be used for dinners, illuminated urban walks, shows, auroras, indoor experiences, or night-compatible activities.

QUALITY CHECK BEFORE RETURN:
- Every repaired day must have at least 3 meaningful rows.
- Normal/full days should usually have 4–8 rows.
- Iconic regional repaired days should usually have 6–10 real rows if feasible.
- No repaired day may contain obvious 2h30+ dead gaps unless justified by a true long transfer.
- No repaired day may be structurally similar to the existing itinerary.
- No regional repaired day may omit its return row.
- No daylight-sensitive scenic stop may be scheduled at night.
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
    let cleanedTransport = _cleanTransportField_(forced);

    /* ================================
       PATCH · HARD FILTER FOR FORBIDDEN HIGHLIGHTS
    ================================ */
    cleanedTransport = (cleanedTransport || []).filter(r => !_isForbiddenHighlight_(r, forbiddenHighlights, city));

    return Array.isArray(cleanedTransport) ? cleanedTransport : [];
  }

  function _missingDaysFromRows_(rows=[], requestedDays=[]){
    const set = new Set((rows || []).map(r => Number(r?.day)));
    return (requestedDays || []).filter(d => !set.has(Number(d)));
  }

  async function _repairStrategicDaysIfNeeded_(rows=[]){
    const repairDays = _findStrategicRepairDays_(rows, dayNums, totalDays, city);

    if(!repairDays.length) return rows;

    console.warn(`[BLOCK ${label}] Strategic repair needed for repetitive/thin/gapped/daylight/return/bucket issues:`, repairDays);

    let repairedRows = [];

    try{
      repairedRows = await _requestBlockRows_(buildStrategicRepairPrompt(repairDays, rows), repairDays);
    }catch(err){
      console.warn(`[BLOCK ${label}] Strategic repair request failed:`, err);
      repairedRows = [];
    }

    repairedRows = _dedupeRows_(repairedRows, city);

    if(!_hasMinimumRowsForDays_(repairedRows, repairDays)){
      console.warn(`[BLOCK ${label}] Strategic repair returned insufficient rows; keeping original rows.`);
      return rows;
    }

    const candidate = _dedupeRows_(_replaceRowsForDays_(rows, repairedRows, repairDays), city);

    if(!_hasUsableRowsForAllBlockDays_(candidate, dayNums)){
      console.warn(`[BLOCK ${label}] Strategic repair candidate failed usability check; keeping original rows.`);
      return rows;
    }

    const stillBroken = _findStrategicRepairDays_(candidate, repairDays, totalDays, city);

    if(stillBroken.length && _hasCriticalQualityIssueForDays_(candidate, stillBroken, city)){
      console.warn(`[BLOCK ${label}] Strategic repair still has critical quality issue on days:`, stillBroken);
      return rows;
    }

    console.log(`[BLOCK ${label}] OK after strategic repair`);
    return candidate;
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

  primaryRows = _dedupeRows_(primaryRows, city);

  if(_hasUsableRowsForAllBlockDays_(primaryRows, dayNums)){
    primaryRows = await _repairStrategicDaysIfNeeded_(primaryRows);
    console.log(`[BLOCK ${label}] OK`);
    return primaryRows;
  }

  const missingDays = _missingDaysFromRows_(primaryRows, dayNums);

  if(!missingDays.length){
    if(primaryRows.length){
      console.warn(`[BLOCK ${label}] Partial but non-empty rows returned; passing downstream.`);
      primaryRows = await _repairStrategicDaysIfNeeded_(primaryRows);
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

  retryRows = _dedupeRows_(retryRows, city);

  let merged = _dedupeRows_([...(primaryRows || []), ...(retryRows || [])], city);

  if(_hasUsableRowsForAllBlockDays_(merged, dayNums)){
    merged = await _repairStrategicDaysIfNeeded_(merged);
    console.log(`[BLOCK ${label}] OK after retry`);
    return merged;
  }

  const stillMissing = _missingDaysFromRows_(merged, dayNums);

  if(stillMissing.length){
    console.warn(`[BLOCK ${label}] Still missing days after retry:`, stillMissing);
  }

  if(merged.length){
    console.warn(`[BLOCK ${label}] Returning partial rows for downstream repair.`);
    merged = await _repairStrategicDaysIfNeeded_(merged);
    return merged;
  }

  console.warn(`[BLOCK ${label}] FAIL — invalid JSON or empty parse.`);
  return [];
}

function _dedupeRows_(rows=[], city=''){
  const seen = new Set();
  const out = [];

  for(const r of (rows || [])){
    const semantic = _rowSemanticKey_(r, city);
    const dayKey = `${Number(r?.day || 1)}::${semantic}`;

    if(seen.has(dayKey)) continue;

    seen.add(dayKey);
    out.push(r);
  }

  const sorted = out.sort((a,b)=>{
    const da = Number(a?.day || 1), db = Number(b?.day || 1);

    if(da !== db) return da - db;

    return String(a?.start || '').localeCompare(String(b?.start || ''));
  });

  const byDay = {};

  sorted.forEach(r=>{
    const d = Number(r?.day || 1);

    if(!byDay[d]) byDay[d] = [];

    byDay[d].push(r);
  });

  const acceptedDays = [];
  const finalRows = [];

  Object.keys(byDay).map(Number).sort((a,b)=>a-b).forEach(day=>{
    const dayRows = byDay[day] || [];
    const tooSimilar = acceptedDays.some(prevDayRows => {
      if(_areRegionalDaysTooSimilar_(prevDayRows, dayRows, city)) return true;
      if(_areDaysExperienceDuplicates_(prevDayRows, dayRows, city)) return true;
      return _areDaysStructurallyTooSimilar_(prevDayRows, dayRows, city);
    });

    if(tooSimilar){
      const filtered = dayRows.filter(r=>{
        if(_isReturnLikeRow_(r) || _isAuroraRow_(r)) return true;

        const token = _rowShapeToken_(r, city);
        const semantic = _rowSemanticKey_(r, city);

        const repeatedToken = acceptedDays.some(prevDayRows =>
          (prevDayRows || []).some(pr => _rowShapeToken_(pr, city) === token)
        );

        const repeatedPoi = acceptedDays.some(prevDayRows =>
          (prevDayRows || []).some(pr => _rowSemanticKey_(pr, city) === semantic)
        );

        return !repeatedToken && !repeatedPoi;
      });

      if(filtered.length >= 3){
        acceptedDays.push(filtered);
        finalRows.push(...filtered);
      }else{
        acceptedDays.push(dayRows);
        finalRows.push(...dayRows);
      }
    }else{
      acceptedDays.push(dayRows);
      finalRows.push(...dayRows);
    }
  });

  return finalRows.sort((a,b)=>{
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
