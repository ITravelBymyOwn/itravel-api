/* =========================================================
   ITRAVELBYMYOWN · PLANNER v65
   Base: v64
   Cambios mínimos:
   - Bloqueo sidebar y botón reset al guardar destinos.
   - Overlay bloquea botón flotante Info Chat.
   - Placeholder visible y tooltip para inputs de fecha.
========================================================= */

/* ==============================
   SECCIÓN 1 · Helpers / Estado
================================= */
const qs  = (s, ctx=document)=>ctx.querySelector(s);
const qsa = (s, ctx=document)=>Array.from(ctx.querySelectorAll(s));

const API_URL = 'https://itravelbymyown-api.vercel.app/api/chat';
const MODEL   = 'gpt-4o-mini';

let savedDestinations = [];      // [{ city, country, days, baseDate, perDay:[{day,start,end}] }]
// 🧠 itineraries ahora soporta originalDays para rebalanceos selectivos
let itineraries = {};            // { [city]: { byDay:{[n]:Row[]}, currentDay, baseDate, originalDays } }
let cityMeta = {};               // { [city]: { baseDate, start, end, hotel, transport, perDay:[] } }
let session = [];                // historial para el agente principal
let infoSession = [];            // historial separado para Info Chat
let activeCity = null;

let planningStarted = false;
let metaProgressIndex = 0;
let collectingHotels = false;
let isItineraryLocked = false;

const DEFAULT_START = '08:30';
const DEFAULT_END   = '19:00';

let pendingChange = null;
let hasSavedOnce = false;

// 🧠 Estado global para persistir configuración del planner
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
  currency: 'USD'
};

// ⚡ Performance toggles (optimizaciones IA)
const ENABLE_VALIDATOR = false;      // ⬅️ si quieres doble validación IA, pon true
const MAX_CONCURRENCY  = 2;          // ⬅️ sube a 3 si tu API lo tolera

// 🧵 Helper: ejecuta tareas con concurrencia limitada
async function runWithConcurrency(taskFns, limit = MAX_CONCURRENCY){
  const queue = [...taskFns];
  const workers = Array.from({length: Math.min(limit, queue.length)}, async ()=> {
    while (queue.length){
      const fn = queue.shift();
      try { await fn(); } catch(e){ console.warn('Task error:', e); }
    }
  });
  await Promise.all(workers);
}

/* ==============================
   SECCIÓN 2 · Tono / Mensajería
================================= */
const tone = {
  hi: '¡Hola! Soy Astra ✨, tu concierge de viajes. Vamos a crear itinerarios inolvidables 🌍',

  // 💬 Mensaje breve que aparece UNA SOLA VEZ justo después del saludo,
  // para sugerir el uso del Info Chat antes de dar los hoteles/transportes.
  infoTip: '💡 Si necesitas ayuda para elegir hospedaje, transporte u otros detalles, abre el <strong>Info Chat</strong> (botón verde), consulta lo que gustes y luego continúa con el itinerario.',

  // 🔎 Pregunta por hotel/zona y transporte con validación: acepta nombre exacto,
  // zona aproximada, dirección o link; “recomiéndame” también es válido.
  // Además, le avisa al usuario que se validará lo entendido y se confirmará si hay dudas.
  askHotelTransport: (city)=>`Para <strong>${city}</strong>, indícame tu <strong>hotel o zona</strong> (puede ser nombre exacto, zona aproximada, dirección o link) y el <strong>medio de transporte</strong> (alquiler, público, taxi/uber, combinado o “recomiéndame”). Validaré que lo entendí bien para optimizar el itinerario; si hay dudas, te lo confirmo antes de seguir.`,

  confirmAll: '✨ Listo. Empiezo a generar tus itinerarios…',
  doneAll: '🎉 Itinerarios generados. Si deseas cambiar algo, solo escríbelo y yo lo ajustaré por ti ✨ Para cualquier detalle específico —clima, transporte, ropa, seguridad y más— abre el Info Chat 🌐 y te daré toda la información que necesites.',
  fail: '⚠️ No se pudo contactar con el asistente. Revisa consola/Vercel (API Key, URL).',
  askConfirm: (summary)=>`¿Confirmas? ${summary}<br><small>Responde “sí” para aplicar o “no” para cancelar.</small>`,
  humanOk: 'Perfecto 🙌 Ajusté tu itinerario para que aproveches mejor el tiempo. ¡Va a quedar genial! ✨',
  humanCancelled: 'Anotado, no apliqué cambios. ¿Probamos otra idea? 🙂',
  cityAdded: (c)=>`✅ Añadí <strong>${c}</strong> y generé su itinerario.`,
  cityRemoved: (c)=>`🗑️ Eliminé <strong>${c}</strong> de tu plan y reoptimicé las pestañas.`,
  cannotFindCity: 'No identifiqué la ciudad. Dímela con exactitud, por favor.',
  thinking: 'Astra está pensando…'
};

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
const $infoToggle   = qs('#info-chat-toggle');
const $infoModal    = qs('#info-chat-modal');
const $infoInput    = qs('#info-chat-input');
const $infoSend     = qs('#info-chat-send');
const $infoClose    = qs('#info-chat-close');
const $infoMessages = qs('#info-chat-messages');
// 🆕 Botón flotante adicional (v55)
const $infoFloating = qs('#info-chat-floating');

// 🆕 Sidebar y botón reset
const $sidebar = qs('.sidebar');
const $resetBtn = qs('#reset-planner');

/* ==============================
   SECCIÓN 3H · Heurística Global Inteligente (Auroras + Day Trips)
================================= */

// 🌍 Cinturón de auroras (latitud aprox. ≥ 60° N/S)
const AURORA_LATITUDE_THRESHOLD = 60;
const AURORA_SEASON_MONTHS = [8,9,10,11,12,1,2,3,4];

// 🌌 Ventana horaria estándar para tours de auroras
const AURORA_DEFAULT_WINDOW = { start: '20:00', end: '02:00' };

// 🔹 Heurística dinámica para auroras
function isAuroraCityDynamic(lat, lng){
  if(typeof lat !== 'number') return false;
  return Math.abs(lat) >= AURORA_LATITUDE_THRESHOLD;
}

function inAuroraSeasonDynamic(baseDateStr){
  try{
    if(!baseDateStr) return true; // sin fecha → asumimos plausible
    const [mm] = baseDateStr.split(/[\/\-]/);
    const m = parseInt(mm||'9',10);
    return AURORA_SEASON_MONTHS.includes(m);
  }catch{ return true; }
}

// 🌐 Day trip dinámico: se decidirá en el prompt, pero puedes sugerir candidatos comunes
// ⚡ En vez de listas fijas, usamos algunos patrones heurísticos + razonamiento posterior
const GLOBAL_DAY_TRIP_HINTS = {
  radiusKm: 200, // radio máximo razonable
  examples: [
    'París: Versalles, Giverny, Mont Saint-Michel',
    'Bruselas: Brujas, Gante',
    'Roma: Florencia, Tivoli, Pompeya',
    'Londres: Oxford, Bath, Cambridge',
    'Zúrich: Lucerna, Jungfraujoch',
    'Rovaniemi: Kemi, Levi, auroras',
    'Tromsø: Lyngen Alps, Ersfjordbotn'
  ]
};

function getHeuristicDayTripContext(city){
  // 👇 Aquí no devolvemos lista fija sino contexto que el agente puede usar para razonar
  return {
    radiusKm: GLOBAL_DAY_TRIP_HINTS.radiusKm,
    hintExamples: GLOBAL_DAY_TRIP_HINTS.examples,
    city
  };
}

// 🧭 Normalizador de claves para dedupe
function normKey(s){
  return String(s||'').normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .toLowerCase().replace(/\s+/g,' ').trim();
}

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
  // 🆕 Placeholder visible + tooltip
  el.placeholder = 'MM/DD/AAAA';
  el.title = 'Formato: MM/DD/AAAA';
  el.addEventListener('input', ()=>{
    const v = el.value.replace(/\D/g,'').slice(0,8);
    if(v.length===8) el.value = `${v.slice(0,2)}/${v.slice(2,4)}/${v.slice(4,8)}`;
    else el.value = v;
  });
}
function parseDMY(str){
  if(!str) return null;
  const m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(str.trim());
  if(!m) return null;
  const d = new Date(+m[3], (+m[2]-1), +m[1]);
  if(d.getFullYear()!=+m[3] || d.getMonth()!=+m[2]-1 || d.getDate()!=+m[1]) return null;
  return d;
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
   🧭 Helper global para ventanas horarias por día
   - Si el usuario definió horario para un día → usarlo.
   - Si no definió → usar 08:30–19:00 como base.
   - No hereda horarios entre días.
   - Devuelve siempre una lista completa para todos los días.
================================= */
function getEffectivePerDay(city, totalDays){
  const baseStart = '08:30';
  const baseEnd   = '19:00';
  const meta = cityMeta[city] || {};
  const perDay = Array.isArray(meta.perDay) ? meta.perDay.slice() : [];
  const map = new Map(perDay.map(x=>[x.day, {start:x.start||baseStart, end:x.end||baseEnd}]));

  const result = [];
  for(let d=1; d<=totalDays; d++){
    if(map.has(d)){
      const val = map.get(d);
      result.push({day:d, start:val.start||baseStart, end:val.end||baseEnd});
    } else {
      result.push({day:d, start:baseStart, end:baseEnd});
    }
  }
  return result;
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
  guide.textContent = '⏰ Usa horario de 24 h — Ej: 08:30 (mañana) · 21:00 (noche)';
  wrap.appendChild(guide);

  // Encabezado único de horas
  const header = document.createElement('div');
  header.className = 'hours-header';
  header.innerHTML = `
    <span></span>
    <span class="header-start">Hora Inicio</span>
    <span class="header-end">Hora Final</span>
  `;
  wrap.appendChild(header);

  for(let d=1; d<=days; d++){
    const row = document.createElement('div');
    row.className = 'hours-day';
    row.innerHTML = `
      <span>Día ${d}</span>
      <input class="start" type="time" aria-label="Hora inicio" placeholder="HH:MM">
      <input class="end"   type="time" aria-label="Hora final"  placeholder="HH:MM">
    `;
    wrap.appendChild(row);
  }
  return wrap;
}

function addCityRow(pref={city:'',country:'',days:'',baseDate:''}){
  const row = document.createElement('div');
  row.className = 'city-row';
  row.innerHTML = `
    <label>Ciudad<input class="city" placeholder="Ciudad" value="${pref.city||''}"></label>
    <label>País<input class="country" placeholder="País" value="${pref.country||''}"></label>
    <label>Días<select class="days"><option value="" selected disabled></option>${Array.from({length:30},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join('')}</select></label>
    <label class="date-label">
      Inicio
      <div class="date-wrapper">
        <input class="baseDate" placeholder="__/__/____" value="${pref.baseDate||''}">
        <small class="date-format">DD/MM/AAAA</small>
      </div>
    </label>
    <button class="remove" type="button">✕</button>
  `;
  const baseDateEl = qs('.baseDate', row);
  autoFormatDMYInput(baseDateEl);

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

  // 🧠 Reconstrucción exacta de días + marca de replanificación cuando cambie el total (↑ o ↓)
  list.forEach(({city, days})=>{
    const prevDays = itineraries[city] ? Object.keys(itineraries[city].byDay||{}).length : 0;
    if(!itineraries[city]) itineraries[city] = { byDay:{}, currentDay:1, baseDate:null };

    if(prevDays !== days){
      // Reconstruir la matriz por día para que coincida EXACTAMENTE con "days"
      itineraries[city].byDay = {};
      for(let d=1; d<=days; d++){ itineraries[city].byDay[d] = []; }

      // Marcar para que el agente regenere con el nuevo total de días
      if (typeof plannerState !== 'undefined') {
        if (!plannerState.forceReplan) plannerState.forceReplan = {};
        plannerState.forceReplan[city] = true;
      }
    }
  });

  savedDestinations = list;

  // 🔄 Sincronizar meta + byDay con el sidebar (siempre coherentes)
  savedDestinations.forEach(({city,days,baseDate,perDay})=>{
    // cityMeta
    if(!cityMeta[city]){
      cityMeta[city] = { baseDate: baseDate||null, start:null, end:null, hotel:'', transport:'', perDay:[...perDay] };
    }else{
      cityMeta[city].baseDate = baseDate||null;
      // Alinear perDay al número de días (rellenar o truncar)
      const aligned = [];
      for(let d=1; d<=days; d++){
        const src = perDay[d-1] || cityMeta[city].perDay?.find(x=>x.day===d) || { day:d, start:DEFAULT_START, end:DEFAULT_END };
        aligned.push({ day:d, start: src.start||DEFAULT_START, end: src.end||DEFAULT_END });
      }
      cityMeta[city].perDay = aligned;
    }

    // itineraries
    if(!itineraries[city]) itineraries[city] = { byDay:{}, currentDay:1, baseDate: baseDate||null };
    itineraries[city].baseDate = baseDate || null;
    for(let d=1; d<=days; d++){
      if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[];
    }
    // Eliminar días sobrantes si el usuario redujo el total
    Object.keys(itineraries[city].byDay).forEach(k=>{
      const n = +k;
      if(n>days) delete itineraries[city].byDay[n];
    });
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
    $itWrap.innerHTML = '<p>No hay actividades aún. El asistente las generará aquí.</p>';
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
      <div class="day-title"><strong>Día ${dayNum}</strong>${dateLabel}</div>
      <table class="itinerary">
        <thead>
          <tr>
            <th>Hora inicio</th><th>Hora final</th><th>Actividad</th><th>Desde</th>
            <th>Hacia</th><th>Transporte</th><th>Duración</th><th>Notas</th>
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
    const t = e.target;
    if(t===prev)      show(Math.max(days[0], (itineraries[city].currentDay||days[0])-1));
    else if(t===next) show(Math.min(days.at(-1), (itineraries[city].currentDay||days[0])+1));
    else if(t.dataset.day) show(+t.dataset.day);
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

  // 🧭 NUEVO: usar getEffectivePerDay en lugar de rellenar manualmente perDay
  savedDestinations.forEach(dest=>{
    if(!cityMeta[dest.city]) cityMeta[dest.city] = {};
    cityMeta[dest.city].perDay = getEffectivePerDay(dest.city, dest.days);
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

// 🧠 Intake compacto por ciudad y rango de días (para prompts ligeros en rebalance y optimizeDay)
function buildIntakeLite(city, range = null){
  const it = itineraries[city];
  if(!it) return `City: ${city} (no data)`;

  const daysObj = it.byDay || {};
  let entries = Object.entries(daysObj);
  if(range && typeof range.start === 'number' && typeof range.end === 'number'){
    entries = entries.filter(([d]) => {
      const n = +d; return n >= range.start && n <= range.end;
    });
  }

  const compact = Object.fromEntries(entries.map(([d,rows])=>[
    d,
    rows.map(r=>({
      start: r.start || '',
      end: r.end || '',
      activity: r.activity || '',
      from: r.from || '',
      to: r.to || ''
    }))
  ]));

  // 🧭 NUEVO: usar ventanas efectivas para el rango solicitado
  const totalDays = savedDestinations.find(x=>x.city===city)?.days || 0;
  let perDayFull = getEffectivePerDay(city, totalDays);
  if(range){
    perDayFull = perDayFull.filter(pd => pd.day >= range.start && pd.day <= range.end);
  }

  const meta = {
    baseDate: it.baseDate || cityMeta[city]?.baseDate || null,
    transport: cityMeta[city]?.transport || '',
    perDay: perDayFull
  };

  return JSON.stringify({ city, meta, days: compact });
}

/* ==============================
   SECCIÓN 11 · Contrato JSON / LLM (reforzado v61)
================================= */
const FORMAT = `
Devuelve SOLO JSON válido (sin markdown) en uno de estos:
A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}]}], "followup":"Pregunta breve"}
B) {"destination":"City","rows":[{...}],"replace":false,"followup":"Pregunta breve"}
C) {"rows":[{...}],"replace":false,"followup":"Pregunta breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" | ["HH:MM",...],"end":"HH:MM" | ["HH:MM",...],"hotel":"Texto","transport":"Texto"},"followup":"Pregunta breve"}

🧭 Campos adicionales opcionales:
- "preferences": {
    "pace": "relax" | "balanced" | "adventure",
    "transport": "public" | "car" | "taxi" | "mixed",
    "kids": true | false,
    "lowWalking": true | false,
    "accessibility": true | false,
    "diet": ["gluten-free","vegan","vegetarian","none"],
    "avoidMuseums": true | false,
    "preferNature": true | false,
    "preferDayTrip": true | false,
    "avoidQueues": true | false,
    "preferTransit": "metro" | "bus" | "walk" | "car",
    "budget": "$" | "$$" | "$$$"
  }
- "dayTripTo": "Nombre del destino para tour de 1 día" (si aplica)
- "locks": {"days":[2,3], "mode":"hard|soft"}
- "constraints": {"replaceRange":{"start":2,"end":4}}
- "remove":[{"day":2,"query":"Museo del Prado"}]
- "planBWeather": true | false

Reglas:
- Optimiza el/los día(s) afectado(s) (min traslados, agrupa por zonas, respeta ventanas).
- Usa horas por día del usuario; si faltan, sugiere horas realistas (apertura/cierre).
- Valida PLAUSIBILIDAD GLOBAL (geografía, temporada, clima aproximado, logística).
- Seguridad y restricciones:
  • No incluyas actividades en zonas con riesgos relevantes o restricciones evidentes; prefiera alternativas seguras.
  • Si detectas un posible riesgo/aviso, indica en "notes" un aviso breve (sin alarmismo) o, si es improcedente, exclúyelo.

🧭 Day trips inteligentes:
- Siempre evalúa imperdibles cercanos (≤ 2 h por trayecto, regreso mismo día) independientemente del número de días.
- Antes de proponer actividades locales adicionales, determina si ya cubriste los principales imperdibles de la ciudad.
- Si quedan días disponibles o el usuario agregó días extra, determina si es mejor:
   • Agregar más actividades locales, o
   • Proponer un tour de 1 día a un destino icónico cercano.
- Si la ciudad tiene pocos imperdibles, prioriza excursiones cercanas aunque el viaje sea corto.
- Si el usuario menciona un destino directamente (“dayTripTo”), prográmalo automáticamente como day trip.
- Proporciona alternativas razonables si hay más de un destino viable.
- Evita duplicar actividades. Si algo ya está cubierto, ofrece opciones diferentes.
- Respeta preferencias del viajero (p.ej., ritmo relajado, movilidad reducida, viajar con niños).

📝 Notas:
- NUNCA dejes "notes" vacío ni "seed"; escribe siempre un tip breve, utilidad práctica, o contexto turístico.
- Indica si es necesario reservar con antelación (“Reserva recomendada”).
- Para actividades estacionales/nocturnas (p. ej. auroras):
  • Inclúyelas SOLO si plausibles para ciudad/fechas aproximadas.
  • Añade en "notes" marcador "valid: <justificación breve>" y hora aproximada típica de inicio local.
  • Propón 1 tour recomendado si tiene sentido y alternativas locales de bajo costo.

📌 Fusión de datos:
- Conserva lo existente por defecto (merge); NO borres lo actual salvo instrucción explícita (replace=true o replaceRange definido).
- Máximo 20 filas por día. Nada de texto fuera del JSON.
`;

/* ==============================
   SECCIÓN 12 · Llamada a Astra (estilo global, reforzado v64 con heurística dinámica)
================================= */
async function callAgent(text, useHistory = true, opts = {}){
  const { timeoutMs = 60000, cityName = null, baseDate = null } = opts; // ⏳ 60 s por defecto
  const history = useHistory ? session : [];

  // 🧭 Hook dinámico de heurísticas globales
  let heuristicsContext = '';
  if (cityName) {
    let auroraCity = false;
    let auroraSeason = false;
    let auroraWindow = AURORA_DEFAULT_WINDOW;
    let dayTripContext = {};

    try {
      const coords = getCoordinatesForCity(cityName);
      if (coords && typeof coords.lat === 'number' && typeof coords.lng === 'number') {
        auroraCity = isAuroraCityDynamic(coords.lat, coords.lng);
        auroraSeason = inAuroraSeasonDynamic(baseDate);
      }
      dayTripContext = getHeuristicDayTripContext(cityName) || {};
    } catch (err) {
      console.warn('Heurística dinámica no disponible para:', cityName, err);
    }

    heuristicsContext = `
───────────────────────────────
🧭 CONTEXTO HEURÍSTICO GLOBAL
───────────────────────────────
- Ciudad analizada: ${cityName}
- Aurora City: ${auroraCity}
- Aurora Season: ${auroraSeason}
- Aurora Window: ${JSON.stringify(auroraWindow)}
- DayTrip Context: ${JSON.stringify(dayTripContext)}
    `.trim();
  }

  const globalStyle = `
Eres "Astra", un agente de viajes internacional con conocimiento experto y actualizado de **destinos turísticos, transporte, cultura, gastronomía, clima, estacionalidad, seguridad y logística global**.

Tu propósito es ayudar a planificar viajes **de forma inteligente, práctica y realista**, como lo haría el mejor planificador humano con acceso ilimitado a conocimiento.

───────────────────────────────
🌍 **RAZONAMIENTO GLOBAL**
───────────────────────────────
- Analiza contexto completo: destino, fechas, temporada, horarios de luz, clima típico, patrones de movilidad, restricciones, accesibilidad y perfil de viaje del usuario (ritmo, edad, niños, movilidad reducida, preferencias culturales, etc.).
- Comprende diferencias geográficas y culturales: horarios locales habituales, costumbres, feriados, estacionalidad turística, festivales, horarios comerciales y zonas horarias.
- Detecta imperdibles auténticos: puntos turísticos icónicos, experiencias culturales, actividades de temporada, excursiones cercanas y gastronomía local.
- Evalúa **distancias y tiempos reales** para construir itinerarios lógicos, fluidos y sin estrés innecesario.
- Ajusta decisiones de planificación **según la lógica de un viajero experimentado**: prioriza, optimiza, equilibra y deja espacio razonable para descanso.

───────────────────────────────
🚀 **EXCURSIONES Y EXPERIENCIAS**
───────────────────────────────
- Considera excursiones de 1 día a destinos cercanos **≤ 2 h por trayecto** si aportan valor turístico o cultural.
- Si ya se cubrieron imperdibles locales, prioriza experiencias complementarias (ej. day trips icónicos, naturaleza, gastronomía, tours culturales).
- Si la ciudad es pequeña o con pocos imperdibles, **propón excursiones estratégicas** aunque la estadía sea corta.
- Si el usuario menciona un destino específico (dayTripTo), intégralo inteligentemente en el itinerario.
- Para excursiones nocturnas especiales (ej. auroras), ubícalas en **horarios plausibles y realistas según temporada y latitud**.

───────────────────────────────
🕒 **GESTIÓN DE HORARIOS**
───────────────────────────────
- Si el usuario definió horarios por día, respétalos y razona a partir de ellos.
- Si NO definió horarios, usa por defecto la ventana base **08:30–19:00** para todos los días sin información.
- Extiende horarios cuando tenga sentido logístico o turístico (cenas, tours nocturnos, auroras boreales, eventos especiales).
- Si extiendes un día por una actividad nocturna, **ajusta inteligentemente el inicio del día siguiente**.
- No heredes horarios automáticamente entre días.
- Añade buffers entre actividades (15 min mínimo, más si hay movilidad reducida o niños).
- Para actividades estacionales como auroras:
  • Nunca las programes de mañana.  
  • Usa franjas realistas (20:00–02:30 aprox.) según temporada y latitud.  
  • Si no es temporada o hay restricciones, sugiere alternativas sensatas.

───────────────────────────────
✈️ **MOVILIDAD Y TRANSPORTE**
───────────────────────────────
- Elige modos de transporte plausibles según el tipo de actividad.
- Considera tiempos reales de traslado y conéctalos con la secuencia del itinerario.
- Ajusta sugerencias de transporte según preferencias del usuario.

───────────────────────────────
🧭 **SEGURIDAD Y RESTRICCIONES**
───────────────────────────────
- No propongas actividades en zonas con riesgos relevantes, horarios peligrosos o restricciones evidentes.
- Si detectas algo riesgoso, **sustituye** por una alternativa segura y práctica.

───────────────────────────────
📝 **NOTAS Y CONTEXTO TURÍSTICO**
───────────────────────────────
- NUNCA dejes “notes” vacío ni “seed”.
- Usa las notas para tips, reservas anticipadas, información de accesibilidad, cultura local y recomendaciones prácticas.
- Para actividades estacionales, incluye “valid:” con justificación breve.

───────────────────────────────
🧠 **RAZONAMIENTO ADAPTATIVO**
───────────────────────────────
- Comprende instrucciones naturales del usuario y tradúcelas a acciones inteligentes.
- Si no se indica un día específico, reacomoda de forma lógica sin duplicar.
- Si cambian preferencias de viaje, ajusta automáticamente el itinerario completo manteniendo coherencia.
- Si no hay información horaria, genera itinerarios completos igualmente, con horarios plausibles.

───────────────────────────────
🧭 **INTELIGENCIA CONTEXTUAL GLOBAL**
───────────────────────────────
- Usa tu conocimiento general del mundo real como lo haría un experto humano.
- Considera diferencias hemisféricas, temporadas turísticas, festivos nacionales, cultura local, transporte real, condiciones meteorológicas típicas y patrones de comportamiento de turistas.
- Prioriza fluidez y naturalidad en la planificación.
- Puedes sugerir una opción principal y una alternativa razonable si corresponde.

${heuristicsContext}

Recuerda siempre:
- Entregar respuestas accionables, bien razonadas y libres de inconsistencias.
- Devuelve JSON válido si se trata de una edición.
- Por defecto, fusiona cambios (replace=false) salvo instrucción contraria.
`.trim();

  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort('timeout'), timeoutMs);

  try{
    showThinking(true);
    const res = await fetch(API_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ model: MODEL, input: `${globalStyle}\n\n${text}`, history }),
      signal: ctrl.signal
    });
    const data = res.ok ? await res.json().catch(()=>({text:''})) : {text:''};
    return data?.text || '';
  }catch(e){
    console.error("Fallo al contactar la API:", e);
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
Eres "Astra", asistente informativo de viajes.
- SOLO respondes preguntas informativas (clima, visados, movilidad, seguridad, presupuesto, enchufes, mejor época, etc.) de forma breve, clara y accionable.
- Considera factores de seguridad básicos al responder: advierte si hay riesgos relevantes o restricciones evidentes.
- NO propones ediciones de itinerario ni devuelves JSON. Respondes en texto directo.
`.trim();

  try{
    setInfoChatBusy(true);

    const res = await fetch(API_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        model: MODEL,
        input: `${globalStyle}\n\n${text}`,
        history,
        mode: 'info'
      })
    });

    const data = res.ok ? await res.json().catch(()=>({text:''})) : {text:''};
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
    console.error("Fallo Info Chat:", e);
    return tone.fail;
  }finally{
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
function normalizeRow(r = {}, fallbackDay = 1){
  const start   = r.start ?? r.start_time ?? r.startTime ?? r.hora_inicio ?? DEFAULT_START;
  const end     = r.end   ?? r.end_time   ?? r.endTime   ?? r.hora_fin    ?? DEFAULT_END;
  const act     = r.activity ?? r.title ?? r.name ?? r.descripcion ?? r.descripcion_actividad ?? '';
  const from    = r.from ?? r.origin ?? r.origen ?? '';
  const to      = r.to   ?? r.destination ?? r.destino ?? '';
  const trans   = r.transport ?? r.transportMode ?? r.modo_transporte ?? '';
  const durRaw  = r.duration ?? r.durationMinutes ?? r.duracion ?? '';
  const notes   = r.notes ?? r.nota ?? r.comentarios ?? '';
  const duration = (typeof durRaw === 'number') ? `${durRaw}m` : (String(durRaw)||'');
  const d = Math.max(1, parseInt(r.day ?? r.dia ?? fallbackDay, 10) || 1);
  return { day:d, start:start||DEFAULT_START, end:end||DEFAULT_END, activity:act||'', from, to, transport:trans||'', duration, notes };
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
    if(!byDay[newDay]){  // evita duplicados de días
      insertDayAt(city, newDay);

      // 🕒 🆕 Horario inteligente base si no hay horario definido
      const baseStart = '08:30';
      const baseEnd = '19:00';
      const start = cityMeta[city]?.perDay?.find(x=>x.day===newDay)?.start || baseStart;
      const end   = cityMeta[city]?.perDay?.find(x=>x.day===newDay)?.end   || baseEnd;

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

  // 🧼 Recolección previa de actividades existentes para evitar duplicados
  const allExistingActs = Object.values(byDay)
    .flat()
    .map(r => String(r.activity || '').trim().toLowerCase())
    .filter(Boolean);
  if(!plannerState.existingActs) plannerState.existingActs = {};
  plannerState.existingActs[city] = new Set(allExistingActs);

  // 🧠 Rebalanceo automático sólo en el rango afectado, con instrucción de evitar duplicados
  showWOW(true, 'Astra está reequilibrando la ciudad…');
  const customOpts = { 
    start: rebalanceStart, 
    end: rebalanceEnd, 
    avoidDuplicates: true 
  };

  rebalanceWholeCity(city, customOpts)
    .catch(err => console.error('Error en rebalance automático:', err))
    .finally(() => showWOW(false));
}

/* ==============================
   SECCIÓN 14 · Validación GLOBAL (2º paso con IA) — reforzado
   Base v60 (exacta) + injertos quirúrgicos v64 (protecciones auroras, termales,
   notas obligatorias, tolerancia de duraciones, límites suaves)
================================= */
async function validateRowsWithAgent(city, rows, baseDate){
  const payload = `
Devuelve SOLO JSON válido:
{
  "allowed":[
    {"day":1,"start":"..","end":"..","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}
  ],
  "removed":[
    {"reason":"..","row":{"day":..,"start":"..","end":"..","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}}
  ]
}

CRITERIOS GLOBALES (corrige y valida):
- Sin solapes; añade buffers realistas (≥15 min).
- Transporte coherente por actividad (barco para whale watching; tour/bus/van para excursiones; tren/bus/auto interurbano; a pie/metro en ciudad).
- Day trips ≤ 2 h por trayecto; si excede, muévelo a "removed" con reason "distance:" + alternativa viable.
- Seguridad/restricciones:
  • Si hay riesgo evidente, restricción oficial, alerta razonable o franja insegura, "removed" con reason "risk:" + sugerencia segura.
  • Prioriza siempre opciones plausibles, seguras y razonables.
- Notas SIEMPRE útiles (nunca vacías ni "seed"); añade "valid:" cuando aplique (temporada/operativa).
- Duración flexible: acepta "90m", "1.5h", "2h", etc.
- Máx. 20 filas por día; si hay exceso, prioriza icónicas y no redundantes.

CASOS ESPECIALES:
1) Whale watching: transporte "Barco", salida desde puerto local, 3–4h aprox., incluir "valid:" por temporada si aplica.
2) Auroras: nocturno (20:00–02:30 aprox.), transporte "Tour/Bus/Van" o "Auto"; incluir "valid:" si plausible por fecha/latitud.
3) Rutas en coche (círculo dorado/costas): 3–6h conducción total con paradas clave; si sin coche ni tour viable, marca "logistics" o "risk" y sugiere tour.
4) Museos/monumentos: horario diurno.
5) Cenas/vida nocturna: 19:00–23:30 aprox.

PROTECCIONES (no eliminar injustificadamente):
- No mandes auroras a "removed" a menos que haya "risk:" claro o "distance:" real.
- Blue Lagoon / termales: recomienda ≥ 3h de permanencia; ajusta duración si fuese menor.
- Evita duplicados exactos dentro del mismo día.

REGLAS DE FUSIÓN:
- Devuelve "allowed" ya corregidas; solo pasa a "removed" lo incompatible.
- En "removed.row" incluye la fila completa que descartas (si es posible).

Contexto:
- Ciudad: "${city}"
- Fecha base (Día 1): ${baseDate || 'N/A'}
- Filas a validar: ${JSON.stringify(rows)}
`.trim();

  // Helpers locales (sin dependencias externas)
  const toStr = v => (v==null ? '' : String(v));
  const lc = s => toStr(s).trim().toLowerCase();
  const isAurora = a => /\baurora|northern\s+light(s)?\b/i.test(toStr(a));
  const isThermal = a => /(blue\s*lagoon|bláa\s*lón(i|í)d|laguna\s+azul|termal(es)?|hot\s*spring|thermal\s*bath)/i.test(toStr(a));

  // Post-sanitizado suave de filas "allowed"
  const postSanitize = (arr=[])=>{
    // Agrupar por día para aplicar límite blando de 20
    const byDay = {};
    arr.forEach(r=>{
      const d = Number(r.day)||1;
      (byDay[d] ||= []).push(r);
    });

    const out = [];
    for(const dStr of Object.keys(byDay)){
      const d = Number(dStr);
      let dayRows = byDay[d].map(r=>{
        // Notas nunca vacías ni "seed"
        let notes = toStr(r.notes).trim();
        if(!notes || lc(notes)==='seed'){
          notes = 'Sugerencia: verifica horarios, seguridad y reservas con antelación.';
        }

        // Auroras: si faltan ventanas, establecer una base plausible; transporte coherente
        if(isAurora(r.activity)){
          const start = r.start && r.start.match(/^\d{2}:\d{2}$/) ? r.start : '20:30';
          const end   = r.end   && r.end.match(/^\d{2}:\d{2}$/)   ? r.end   : '02:00';
          const transport = r.transport ? r.transport : 'Tour/Bus/Van';
          if(!/valid:/i.test(notes)) notes = (notes ? notes+' · ' : '') + 'valid: ventana nocturna auroral (sujeto a clima).';
          return {...r, day:d, start, end, transport, notes};
        }

        // Termales / Blue Lagoon: reforzar ≥ 3h si viniera menor/indefinido
        if(isThermal(r.activity)){
          let duration = toStr(r.duration).trim();
          const isShort =
            (!duration) ||
            /^(\d{1,2})m$/.test(duration) && Number(RegExp.$1) < 180 ||
            /^(\d+(?:\.\d+)?)h$/.test(duration) && Number(RegExp.$1) < 3;
          if(isShort) duration = '3h';
          if(!/min\s*stay|3h/i.test(notes)) notes = (notes ? notes+' · ' : '') + 'min stay ~3h (ajustable)';
          return {...r, day:d, duration, notes};
        }

        return {...r, day:d, notes};
      });

      // Límite suave: máximo 20 filas por día
      if(dayRows.length > 20){
        // Prioriza no-duplicadas e icónicas (heurística simple: descarta texto muy corto/repetido)
        const seen = new Set();
        const filtered = [];
        for(const r of dayRows){
          const key = lc(r.activity) + '|' + (r.start||'') + '|' + (r.end||'');
          if(!seen.has(key)){
            seen.add(key);
            filtered.push(r);
          }
          if(filtered.length === 20) break;
        }
        dayRows = filtered;
      }

      out.push(...dayRows);
    }

    return out;
  };

  try{
    const res = await callAgent(payload, true);
    const parsed = parseJSON(res);

    if(parsed?.allowed){
      // Sanitizado local y protecciones suaves
      const allowed = postSanitize(parsed.allowed || []);
      const removed = Array.isArray(parsed.removed) ? parsed.removed : [];
      return { allowed, removed };
    }
  }catch(e){
    console.warn('Validator error', e);
  }

  // Fail-open con sanitización mínima si el agente falla
  const sanitized = (rows||[]).map(r => {
    const notesRaw = toStr(r.notes).trim();
    const notes = notesRaw && lc(notesRaw)!=='seed'
      ? notesRaw
      : 'Sugerencia: verifica horarios, seguridad básica y reserva con antelación.';
    // Ajuste suave si es aurora o termal aun en fail-open
    if(isAurora(r.activity)){
      return {
        ...r,
        start: r.start && /^\d{2}:\d{2}$/.test(r.start) ? r.start : '20:30',
        end:   r.end   && /^\d{2}:\d{2}$/.test(r.end)   ? r.end   : '02:00',
        transport: r.transport || 'Tour/Bus/Van',
        notes: /valid:/i.test(notes) ? notes : notes + ' · valid: ventana nocturna auroral (sujeto a clima).'
      };
    }
    if(isThermal(r.activity)){
      let duration = toStr(r.duration).trim();
      if(!duration) duration = '3h';
      return { ...r, duration, notes: /min\s*stay/i.test(notes) ? notes : notes + ' · min stay ~3h (ajustable)' };
    }
    return { ...r, notes };
  });

  // También aplicamos límite suave de 20 por día en fail-open
  const grouped = {};
  sanitized.forEach(r=>{
    const d = Number(r.day)||1;
    (grouped[d] ||= []).push(r);
  });
  const allowed = Object.keys(grouped).flatMap(dStr=>{
    const d = Number(dStr);
    const arr = grouped[d];
    if(arr.length <= 20) return arr.map(x=>({...x, day:d}));
    const seen = new Set(); const out=[];
    for(const r of arr){
      const key = lc(r.activity) + '|' + (r.start||'') + '|' + (r.end||'');
      if(!seen.has(key)){
        seen.add(key); out.push({...r, day:d});
      }
      if(out.length===20) break;
    }
    return out;
  });

  return { allowed, removed: [] };
}

/* ==============================
   SECCIÓN 15 · Generación por ciudad (versión restaurada v65 estable)
================================= */

/* ─────────────────────────────────────────────────────────────
   [15.1] Overlay helpers (mensajes y bloqueo de UI)
   - ✅ Mantiene habilitado solo “reset-planner”
   - 🆕 Bloquea “info-chat-floating”
   - 🆕 Atributo aria-busy + manejo de tabindex (accesibilidad)
───────────────────────────────────────────────────────────── */
function setOverlayMessage(msg='Astra está generando itinerarios…'){
  const p = $overlayWOW?.querySelector('p');
  if(p) p.textContent = msg;
}

function showWOW(on, msg){
  if(!$overlayWOW) return;
  if(msg) setOverlayMessage(msg);
  $overlayWOW.style.display = on ? 'flex' : 'none';
  $overlayWOW.setAttribute('aria-busy', on ? 'true' : 'false');

  const all = qsa('button, input, select, textarea, a');
  all.forEach(el=>{
    // ✅ Mantener habilitado solo el botón de reset
    if (el.id === 'reset-planner') return;

    // 🆕 Bloquear también el botón flotante de Info Chat
    if (el.id === 'info-chat-floating') {
      el.disabled = on;
      return;
    }

    if(on){
      el._prevDisabled = el.disabled;
      el.disabled = true;
      el._prevTabIndex = el.getAttribute('tabindex');
      el.setAttribute('tabindex','-1');
    }else{
      if(typeof el._prevDisabled !== 'undefined'){
        el.disabled = el._prevDisabled;
        delete el._prevDisabled;
      }else{
        el.disabled = false;
      }
      if(typeof el._prevTabIndex !== 'undefined'){
        el.setAttribute('tabindex', el._prevTabIndex);
        delete el._prevTabIndex;
      }else{
        el.removeAttribute('tabindex');
      }
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   SECCIÓN 15.2 · Generación principal por ciudad
   Base: v60 (exacta) + injertos quirúrgicos v64 (mutex, auroras, termales,
   fixers, dedupe, validaciones) · Sin parches predefinidos.
   Nota: No cierra overlay aquí para evitar desbloqueo prematuro de UI.
───────────────────────────────────────────────────────────── */
async function generateCityItinerary(city){
  // 🔒 Mutex simple por ciudad (evita carreras si el usuario dispara acciones rápidas)
  window.__cityLocks = window.__cityLocks || {};
  if (window.__cityLocks[city]) {
    console.warn(`[Mutex] Generación ya en curso para ${city}`);
    return;
  }
  window.__cityLocks[city] = true;

  // Helpers locales puros (sin efectos colaterales)
  const toHHMM = s => String(s||'').trim();
  const parseHHMM = (hhmm)=>{
    const m = /^(\d{1,2}):(\d{2})$/.exec(toHHMM(hhmm));
    if(!m) return null;
    const h = Math.min(23, Math.max(0, +m[1]));
    const min = Math.min(59, Math.max(0, +m[2]));
    return {h, min};
  };
  const addMinutes = (hhmm, mins)=>{
    const t = parseHHMM(hhmm);
    if(!t) return null;
    let total = t.h*60 + t.min + mins;
    while(total < 0) total += 24*60;
    total = total % (24*60);
    const h = Math.floor(total/60);
    const m = total % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  };

  try {
    const dest  = savedDestinations.find(x=>x.city===city);
    if(!dest) return;

    const perDay = Array.from({length:dest.days}, (_,i)=>{
      const src  = (cityMeta[city]?.perDay||[])[i] || dest.perDay?.[i] || {};
      return { day:i+1, start: src.start || DEFAULT_START, end: src.end || DEFAULT_END };
    });

    const baseDate = cityMeta[city]?.baseDate || dest.baseDate || '';
    const hotel    = cityMeta[city]?.hotel || '';
    const transport= cityMeta[city]?.transport || 'recomiéndame';

    // 🧭 ¿Replan forzado?
    const forceReplan = (typeof plannerState !== 'undefined' && plannerState.forceReplan && plannerState.forceReplan[city]) ? true : false;

    // 🧠 Contexto heurístico (auroras / day trips) — sin “defaults” predefinidos
    let heuristicsContext = '';
    let auroraCity=false, auroraSeason=false;
    try{
      const coords = getCoordinatesForCity(city);
      auroraCity = coords ? isAuroraCityDynamic(coords.lat, coords.lng) : false;
      auroraSeason = baseDate ? inAuroraSeasonDynamic(baseDate) : false;
      const auroraWindow = AURORA_DEFAULT_WINDOW;
      const dayTripContext = getHeuristicDayTripContext(city) || {};

      heuristicsContext = `
───────────────────────────────
🧭 CONTEXTO HEURÍSTICO GLOBAL
───────────────────────────────
- Ciudad: ${city}
- Aurora City: ${auroraCity}
- Aurora Season: ${auroraSeason}
- Aurora Window: ${JSON.stringify(auroraWindow)}
- Day Trip Context: ${JSON.stringify(dayTripContext)}
      `.trim();
    }catch(err){
      console.warn('Heurística no disponible:', city, err);
      heuristicsContext = '⚠️ Sin contexto heurístico disponible.';
    }

    // Requisito condicional (no “parche”, solo guía contextual al agente)
    const auroraRequirement = (auroraCity && (auroraSeason || !baseDate)) ? `
🌌 **Instrucción contextual**:
- Si es plausible, incluye **al menos una noche** de auroras (20:00–02:30 aprox.), con "valid:" en notes y transporte coherente (Tour/Van/Auto).
- Ajusta el inicio del día siguiente si se extiende demasiado.
` : '';

    const instructions = `
${FORMAT}
**ROL:** Planificador “Astra”. Elabora el itinerario completo SOLO para "${city}" (${dest.days} día/s).
- Formato B {"destination":"${city}","rows":[...],"replace": ${forceReplan ? 'true' : 'false'}}.

🧭 Cobertura:
- Cubre TODOS los días 1–${dest.days}. Sin días vacíos.
- Ventanas base por día: ${JSON.stringify(perDay)}. Puedes proponer extensiones lógicas (cenas, tours nocturnos, auroras).
- Imperdibles diurnos y nocturnos. Balance sin redundancias.

🚆 Transporte lógico por tipo:
- Barco: actividades marinas / whale watching.
- Bus/Van tour: excursiones interurbanas.
- Tren/Bus/Auto: trayectos terrestres razonables.
- A pie/Metro: zonas urbanas compactas.

🕒 Horarios plausibles:
- Base 08:30–19:00 si no se indicó algo mejor.
- Añade buffers ≥15 min. Evita solapes y herencia ciega de horarios entre días.
- Si extiendes por nocturnas, compensa siguiente día.

🧭 Day trips:
- Solo si aportan valor y ≤ 2 h por trayecto (ida), regreso mismo día. Itinerario secuencial claro (ida → visitas → regreso).

${auroraRequirement}

🔎 Notas:
- SIEMPRE informativas (nunca vacías ni "seed"); incluye "valid:" cuando corresponda (temporada/latitud/operativa).

${heuristicsContext}

Contexto actual:
${buildIntake()}
`.trim();

    // Actualiza mensaje de overlay sin cerrar (el cierre lo hará el orquestador)
    if (typeof setOverlayMessage === 'function') {
      try { setOverlayMessage(`Generando itinerario para ${city}…`); } catch(_) {}
    }

    // Llamada al agente
    const text = await callAgent(instructions, true);
    const parsed = parseJSON(text);

    if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
      // Normalización multi-formato
      let tmpRows = [];
      if(parsed.rows){
        tmpRows = parsed.rows.map(r=>normalizeRow(r));
      }else if(parsed.destination===city && parsed.rows){
        tmpRows = parsed.rows.map(r=>normalizeRow(r));
      }else if(Array.isArray(parsed.destinations)){
        const d=parsed.destinations.find(x=>(x.name||x.destination)===city);
        tmpRows=(d?.rows||[]).map(r=>normalizeRow(r));
      }else if(Array.isArray(parsed.itineraries)){
        const i=parsed.itineraries.find(x=>(x.city||x.name||x.destination)===city);
        tmpRows=(i?.rows||[]).map(r=>normalizeRow(r));
      }

      // 🧼 Anti-duplicados locales vs lo ya existente en la ciudad
      const existingActs = Object.values(itineraries[city]?.byDay||{})
        .flat().map(r=>String(r.activity||'').trim().toLowerCase());
      tmpRows = tmpRows.filter(r=>!existingActs.includes(String(r.activity||'').trim().toLowerCase()));

      // 🛠️ Fixers globales (si existen en el entorno)
      if(typeof applyTransportSmartFixes==='function') tmpRows=applyTransportSmartFixes(tmpRows);
      if(typeof applyThermalSpaMinDuration==='function') tmpRows=applyThermalSpaMinDuration(tmpRows);
      if(typeof sanitizeNotes==='function') tmpRows=sanitizeNotes(tmpRows);

      // ✅ Validación global con IA (no elimina auroras plausibles)
      const val = await validateRowsWithAgent(city, tmpRows, baseDate);
      pushRows(city, val.allowed, forceReplan);

      /* ♨️ Refuerzo local termales / Blue Lagoon ≥ 3h (sin suposiciones rígidas) */
      (function enforceThermal3h(){
        const hotWords = ['laguna azul','blue lagoon','bláa lónið','termal','termales','hot spring','thermal bath'];
        const byDay = itineraries[city]?.byDay || {};
        for(const d of Object.keys(byDay)){
          byDay[d] = (byDay[d]||[]).map(r=>{
            const name = String(r.activity||'').toLowerCase();
            if(hotWords.some(w=>name.includes(w))){
              const start = toHHMM(r.start);
              const hasStart = !!parseHHMM(start);
              // Si no trae duración ≥ 3h, ajusta suave (no invade otras actividades)
              const newEnd = hasStart ? addMinutes(start, 180) : r.end;
              const durTxt = String(r.duration||'').toLowerCase();
              const hoursMatch = /(\d+(?:\.\d+)?)\s*h/.exec(durTxt);
              const durH = hoursMatch ? parseFloat(hoursMatch[1]) : null;
              if(!durH || durH < 3) r.duration = '3h';
              if(newEnd) r.end = newEnd;
              r.notes = (r.notes ? String(r.notes)+' · ' : '') + 'min stay ~3h (ajustable)';
            }
            return r;
          });
        }
      })();

      /* 🌌 Post-proceso auroras: garantiza ≥ 1 noche si ciudad/temporada lo permiten */
      if (auroraCity && (auroraSeason || !baseDate)) {
        const acts = Object.values(itineraries[city]?.byDay || {})
          .flat()
          .map(r => String(r.activity || '').toLowerCase());
        const hasAurora = acts.some(a => a.includes('aurora') || a.includes('northern light'));
        if (!hasAurora) {
          const byDay = itineraries[city]?.byDay || {};
          const dayLoads = [];
          for(let d=1; d<=dest.days; d++){
            const rows = byDay[d] || [];
            const diurnas = rows.filter(x=>{
              const e = parseHHMM(x.end||'');
              return e ? (e.h*60+e.min) <= (19*60+30) : true;
            }).length;
            dayLoads.push({day:d, load:diurnas});
          }
          dayLoads.sort((a,b)=> a.load===b.load ? a.day - b.day : a.load - b.load);
          let chosen = dayLoads[0]?.day || 1;
          // Evita concentrar auroras el último día si hay alternativa
          if(chosen === dest.days && dayLoads[1]) chosen = dayLoads[1].day;

          const auroraRow = normalizeRow({
            day: chosen,
            start: '20:30',
            end: '02:00',
            activity: 'Caza de auroras',
            from: 'Hotel/Base',
            to: 'Punto de observación',
            transport: 'Tour/Bus/Van',
            notes: 'valid: ventana nocturna auroral (sujeto a clima); vestir térmico'
          });
          pushRows(city, [auroraRow], false);
          console.warn(`[Aurora Injection] Añadida aurora automáticamente en ${city} (día ${chosen})`);
        }
      }

      // 🧩 Relleno mínimo + micro-optimizaciones por día vacío
      ensureDays(city);
      for(let d=1; d<=dest.days; d++){
        if(!(itineraries[city].byDay?.[d]||[]).length){
          await optimizeDay(city,d);
        }
      }

      // Render UI (sin cerrar overlay aquí)
      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);

      // Limpieza de flags
      if(forceReplan && plannerState?.forceReplan) delete plannerState.forceReplan[city];
      if(plannerState?.preferences){
        delete plannerState.preferences.preferDayTrip;
        delete plannerState.preferences.preferAurora;
      }
      $resetBtn?.removeAttribute('disabled');
      return;
    }

    // Fallback sin JSON válido — mantén UI y registro
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    $resetBtn?.removeAttribute('disabled');
    chatMsg('⚠️ Fallback local: sin respuesta JSON válida del agente.','ai');

  } catch(err){
    console.error(`[ERROR] generateCityItinerary(${city})`, err);
    chatMsg(`⚠️ No se pudo generar el itinerario para <strong>${city}</strong>.`, 'ai');
  } finally {
    delete window.__cityLocks[city];
    // ⚠️ NO hacemos showWOW(false) aquí; el cierre global lo maneja el orquestador de concurrencia.
  }
}

/* ==============================
   SECCIÓN 15.3 · Rebalanceo masivo tras cambios (agregar días / day trip pedido)
   Base v60 exacta + injertos v64 (protecciones, anti-duplicados, rango selectivo)
================================= */
async function rebalanceWholeCity(city, opts = {}) {
  const data = itineraries[city];
  if (!data) {
    chatMsg('No hay datos para reequilibrar esta ciudad.', 'ai');
    return;
  }

  const totalDays = Object.keys(data.byDay || {}).length;

  // Ventanas por día actuales (v60)
  const perDay = Array.from({ length: totalDays }, (_, i) => {
    const src = (cityMeta[city]?.perDay || []).find(x => x.day === i + 1) || { start: DEFAULT_START, end: DEFAULT_END };
    return { day: i + 1, start: src.start || DEFAULT_START, end: src.end || DEFAULT_END };
  });

  const baseDate   = data.baseDate || cityMeta[city]?.baseDate || '';
  const wantedTrip = (opts.dayTripTo || '').trim();

  // 🆕 Determinar rango de rebalanceo (merge v64; no tocar días previos si no aplica)
  const startDay = Math.max(1, Number.isInteger(opts.start) ? opts.start : 1);
  const endDay   = Math.min(totalDays, Number.isInteger(opts.end) ? opts.end : totalDays);
  const lockedDaysText = startDay > 1 ? `Mantén intactos los días 1 a ${startDay - 1}.` : '';

  // 🧭 Detectar si se debe forzar replanificación completa (bandera global)
  const forceReplan = (
    typeof plannerState !== 'undefined'
    && plannerState.forceReplan
    && plannerState.forceReplan[city]
  ) ? true : false;

  // ⚖️ Construir prompt robusto (v60 + refuerzos v64)
  const prompt = `
${FORMAT}
**ROL:** Reequilibra la ciudad "${city}" entre los días ${startDay} y ${endDay}, manteniendo lo ya plausible y completando huecos.
${lockedDaysText}
- Formato B {"destination":"${city}","rows":[...],"replace": ${forceReplan ? 'true' : 'false'}}.
- Respeta ventanas por día: ${JSON.stringify(perDay.filter(x => x.day >= startDay && x.day <= endDay))}, pero puedes proponer horarios diferentes si tienen sentido logístico (cenas, tours nocturnos, auroras, termales).
- Considera IMPERDIBLES y distribuye sin duplicar.
- Day trips (opcional): si es viable y/o solicitado, añade UN (1) día de excursión (≤ 2 h por trayecto, ida y vuelta el mismo día) a un imperdible cercano con traslado + actividades + regreso.
${wantedTrip ? `- Preferencia explícita de day trip a: "${wantedTrip}". Úsalo exactamente 1 día si es razonable.` : `- Si el total de días es ≥ 4 y no se indicó destino, sugiere un imperdible cercano.`}
- ❌ NO DUPLICAR actividades existentes en ningún día.
  • Si ya existe, sustituye por alternativa distinta (mismo valor turístico).
- Último día algo más liviano y con lógica de regreso.
- Valida PLAUSIBILIDAD y SEGURIDAD:
  • Evita proponer actividades en zonas/horarios con riesgos o restricciones evidentes.
  • Para auroras, usa ventana 20:00–02:30 aprox. con nota "valid:" si procede.
  • Para termales (Blue Lagoon, etc.), estancia recomendada ≥ 3h (ajusta duración si viniera menor).
- Notas SIEMPRE útiles (nunca vacías ni "seed").
Contexto para fusionar sin borrar lo plausible:
${buildIntake()}
`.trim();

  showWOW(true, 'Reequilibrando la ciudad…');

  try {
    const ans = await callAgent(prompt, true);
    const parsed = parseJSON(ans);

    // Normalización de filas desde distintos formatos aceptados por el agente
    let rows = [];
    if (parsed && (parsed.rows || parsed.destinations || parsed.itineraries)) {
      if (parsed.rows) {
        rows = parsed.rows.map(r => normalizeRow(r));
      } else if (parsed.destination === city && parsed.rows) {
        rows = parsed.rows.map(r => normalizeRow(r));
      } else if (Array.isArray(parsed.destinations)) {
        const dd = parsed.destinations.find(d => (d.name || d.destination) === city);
        rows = (dd?.rows || []).map(r => normalizeRow(r));
      } else if (Array.isArray(parsed.itineraries)) {
        const ii = parsed.itineraries.find(x => (x.city || x.name || x.destination) === city);
        rows = (ii?.rows || []).map(r => normalizeRow(r));
      }
    }

    // 🧼 Anti-duplicados local (merge v64):
    //   - Considera lo que ya existe en la ciudad
    //   - Fusiona con plannerState.existingActs[city] si está disponible
    let existingActs = Object.values(itineraries[city]?.byDay || {})
      .flat()
      .map(r => String(r.activity || '').trim().toLowerCase());

    if (plannerState?.existingActs?.[city]) {
      existingActs = [...new Set([...existingActs, ...Array.from(plannerState.existingActs[city])])];
    }

    rows = (rows || []).filter(r => {
      const act = String(r.activity || '').trim().toLowerCase();
      return act && !existingActs.includes(act);
    });

    // 🛡️ Validación global con protecciones (auroras, termales, etc.)
    const val = await validateRowsWithAgent(city, rows, baseDate);

    // 🔄 Merge controlado:
    // - Si forceReplan => reemplazo completo (replace=true en pushRows)
    // - Si no => fusión aditiva (replace=false)
    pushRows(city, val.allowed, !!forceReplan);

    // 🧠 Optimiza SOLO el rango de días afectado (merge v64)
    for (let d = startDay; d <= endDay; d++) {
      await optimizeDay(city, d);
    }

    // 🔄 Render final coherente (no desbloquear UI antes de tiempo)
    renderCityTabs();
    setActiveCity(city);
    renderCityItinerary(city);

    // ✅ Mantener patrón v60: ocultar WOW y habilitar reset al final
    showWOW(false);
    $resetBtn?.removeAttribute('disabled');

    // 🧽 Limpiar bandera de replan si se usó
    if (forceReplan && plannerState?.forceReplan) {
      delete plannerState.forceReplan[city];
    }

  } catch (err) {
    console.warn('rebalanceWholeCity error', err);
    showWOW(false);
    $resetBtn?.removeAttribute('disabled');
    chatMsg('No recibí cambios válidos para el rebalanceo. ¿Intentamos de otra forma?', 'ai');
  }
}

/* ==============================
   SECCIÓN 16 · Inicio (hotel/transport)
   v60 base + overlay bloqueado global hasta terminar todas las ciudades
   (concurrencia controlada vía runWithConcurrency)
================================= */
async function startPlanning(){
  if(savedDestinations.length===0) return;
  $chatBox.style.display='flex';
  planningStarted = true;
  collectingHotels = true;
  session = [];
  metaProgressIndex = 0;

  // 1) Saludo inicial
  chatMsg(`${tone.hi}`);

  // 2) Tip del Info Chat (se muestra una sola vez al iniciar)
  //    Queda inmediatamente DEBAJO del saludo, antes de pedir el primer hotel/transporte.
  chatMsg(`${tone.infoTip}`, 'ai');

  // 3) Comienza flujo de solicitud de hotel/zona y transporte
  askNextHotelTransport();
}

function askNextHotelTransport(){
  // ✅ Si ya se procesaron todos los destinos → generar itinerarios
  if(metaProgressIndex >= savedDestinations.length){
    collectingHotels = false;
    chatMsg(tone.confirmAll);

    (async ()=>{
      // 🔒 Mantener UI bloqueada durante la generación global
      showWOW(true, 'Astra está generando itinerarios…');

      // ⚙️ Concurrencia controlada (v60): no tocar
      const taskFns = savedDestinations.map(({city}) => async () => {
        await generateCityItinerary(city);
      });
      await runWithConcurrency(taskFns);

      // ✅ Al terminar TODAS las ciudades, desbloquear UI
      showWOW(false);
      chatMsg(tone.doneAll);
    })();
    return;
  }

  // 🧠 Validación y persistencia del destino actual
  const city = savedDestinations[metaProgressIndex].city;
  if(!cityMeta[city]){
    cityMeta[city] = { baseDate: null, hotel:'', transport:'', perDay: [] };
  }

  // ⛔ Debe esperar explícitamente hotel/zona antes de avanzar (requisito)
  const currentHotel = cityMeta[city].hotel || '';
  if(!currentHotel.trim()){
    setActiveCity(city);
    renderCityItinerary(city);
    chatMsg(tone.askHotelTransport(city), 'ai');
    return; // 👈 No avanza hasta que el usuario indique hotel/zona
  }

  // 🧭 Avanzar al siguiente destino si ya hay hotel guardado
  metaProgressIndex++;
  askNextHotelTransport();
}


/* ==============================
   SECCIÓN 17 · NLU robusta + Intents (v60 base + mejoras v64)
   - Mantiene lógica global limpia (sin disparar acciones aquí)
   - No desbloquea UI, no reequilibra ni genera (solo detecta intención)
   - Soporta preferencias de day trip y auroras
   - Soporta “un día más” y “N días” (+ opcional “y uno para ir a X”)
   - Soporta ventanas horarias en lenguaje natural (e.g., “tres y cuarto”)
================================= */

// Números en texto → enteros
const WORD_NUM = {
  'una':1,'uno':1,'un':1,'dos':2,'tres':3,'cuatro':4,'cinco':5,
  'seis':6,'siete':7,'ocho':8,'nueve':9,'diez':10,
  'once':11,'doce':12,'trece':13,'catorce':14,'quince':15
};

// Normaliza tokens de hora (e.g., “tres y cuarto”, “mediodía”, “11 pm”)
function normalizeHourToken(tok){
  tok = String(tok||'').toLowerCase().trim();

  // “tres y media / cuarto / tres cuartos”
  const yM = tok.match(/^(\d{1,2}|\w+)\s+y\s+(media|cuarto|tres\s+cuartos)$/i);
  if(yM){
    let h = yM[1];
    let hh = WORD_NUM[h] || parseInt(h,10);
    if(!isFinite(hh)) return null;
    let mm = 0;
    const frag = yM[2].replace(/\s+/g,' ');
    if(frag==='media') mm=30;
    else if(frag==='cuarto') mm=15;
    else if(frag==='tres cuartos') mm=45;
    if(hh>=0 && hh<=24) return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
    return null;
  }

  // Palabras especiales
  const mapWords = { 'mediodía':'12:00', 'medianoche':'00:00' };
  if(mapWords[tok]) return mapWords[tok];

  // Números en texto
  const w = WORD_NUM[tok]; if(w) return `${String(w).padStart(2,'0')}:00`;

  // Formatos hh[:mm] am/pm
  const m = tok.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if(!m) return null;
  let hh = parseInt(m[1],10);
  let mm = m[2] ? parseInt(m[2],10) : 0;
  const ap = m[3]?.toLowerCase();
  if(ap){
    if((ap==='pm' || ap==='p.m.') && hh<12) hh += 12;
    if((ap==='am' || ap==='a.m.') && hh===12) hh = 0;
  }
  if(hh>=0 && hh<=24 && mm>=0 && mm<60) return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  return null;
}

// Extrae ventana horaria desde texto libre
function parseTimeRangeFromText(text){
  const t = String(text||'').toLowerCase();

  // “de/entre X a/hasta Y”
  let m = t.match(/(?:de|entre)\s+([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)\s*(?:a|hasta|y)\s*([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)/i);
  if(m){
    const s = normalizeHourToken(m[1]);
    const e = normalizeHourToken(m[2]);
    if(s||e) return { start: s||null, end: e||null };
  }

  // Solo inicio
  m = t.match(/(?:iniciar|empezar|arrancar|inicio)\s*(?:el día|la jornada)?\s*(?:a|a las)?\s*([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)/i);
  const startOnly = m ? normalizeHourToken(m[1]) : null;

  // Solo fin
  m = t.match(/(?:terminar|finalizar|hasta|acabar)\s*(?:a las|a)?\s*([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)/i);
  const endOnly = m ? normalizeHourToken(m[1]) : null;

  return { start: startOnly, end: endOnly };
}

// Cache de ciudades para detección rápida + fuzzy
let cachedCityList = [];
function refreshCityCache(){
  cachedCityList = (savedDestinations||[])
    .map(d=>d.city)
    .filter(Boolean)
    .sort((a,b)=>b.length - a.length)
    .map(c=>({orig:c, low:String(c).toLowerCase()}));
}

function detectCityInText(text){
  const lowered = String(text||'').toLowerCase();
  if(!cachedCityList.length) refreshCityCache();

  // Coincidencia directa por inclusión
  for(const {orig, low} of cachedCityList){
    if(lowered.includes(low)) return orig;
  }
  // Fuzzy simple
  for(const {orig, low} of cachedCityList){
    if(low.startsWith(lowered) || lowered.startsWith(low)) return orig;
    if(levenshteinDistance(lowered, low) <= 2) return orig;
  }
  return null;
}

// Heurística: ciudad por país mencionado
function detectCityFromCountryInText(text){
  const lowered = String(text||'').toLowerCase();
  const countryMap = {
    'islandia':'reykjavik','españa':'madrid','francia':'parís','italia':'roma',
    'inglaterra':'londres','reino unido':'londres','japón':'tokio',
    'eeuu':'nueva york','estados unidos':'nueva york','alemania':'berlín',
    'portugal':'lisboa','brasil':'rio de janeiro','argentina':'buenos aires',
    'chile':'santiago','méxico':'ciudad de méxico','mexico':'ciudad de méxico'
  };
  for(const k in countryMap){
    if(lowered.includes(k)) return countryMap[k];
  }
  return null;
}

// Distancia de Levenshtein (fuzzy)
function levenshteinDistance(a,b){
  const m = [];
  for(let i=0;i<=b.length;i++){ m[i]=[i]; }
  for(let j=0;j<=a.length;j++){ m[0][j]=j; }
  for(let i=1;i<=b.length;i++){
    for(let j=1;j<=a.length;j++){
      m[i][j] = b.charAt(i-1)===a.charAt(j-1)
        ? m[i-1][j-1]
        : Math.min(m[i-1][j-1]+1, Math.min(m[i][j-1]+1, m[i-1][j]+1));
    }
  }
  return m[b.length][a.length];
}

/**
 * Devuelve un objeto { type: <intent>, ...payload } sin efectos secundarios.
 * No invoca generación ni rebalanceo ni desbloquea UI; eso lo hace el caller.
 */
function intentFromText(text){
  const t = String(text||'').toLowerCase().trim();

  // Confirmaciones / cancelaciones
  if(/^(sí|si|ok|dale|hazlo|confirmo|de una|aplica)\b/.test(t)) return { type:'confirm' };
  if(/^(no|mejor no|cancela|cancelar|cancelá)\b/.test(t))        return { type:'cancel' };

  // “Un día más” (prioritario sobre “N días”)
  if(/\b(me\s+quedo|quedarme)\s+un\s+d[ií]a\s+m[aá]s\b/.test(t) || /\b(un\s+d[ií]a\s+m[aá]s)\b/.test(t) || /(agrega|añade|suma)\s+un\s+d[ií]a\b/.test(t)){
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    const placeM = t.match(/para\s+ir\s+a\s+([a-záéíóúüñ\s]+)$/i);
    return { type:'add_day_end', city, dayTripTo: placeM ? placeM[1].trim() : null };
  }

  // “N días / N noches” + opcional “y uno para ir a X”
  const addMulti = t.match(/(agrega|añade|suma|extiende|prolonga|quedarme|me\s+quedo|me\s+voy\s+a\s+quedar)\s+(\d+|\w+)\s+(d[ií]as?|noches?)(?:.*?y\s+uno\s+para\s+ir\s+a\s+([a-záéíóúüñ\s]+))?/i);
  if(addMulti){
    const n = WORD_NUM[addMulti[2]] || parseInt(addMulti[2],10) || 1;
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    const dayTripTo = addMulti[4] ? addMulti[4].trim() : null;
    return { type:'add_days', city, extraDays:n, dayTripTo };
  }

  // Preferencia explícita de day trip (sin agregar días)
  if(/\b(tour de un d[ií]a|excursi[oó]n de un d[ií]a|un\s*d[ií]a\s+fuera|viaje de un d[ií]a|day\s*trip|una escapada|algo fuera de la ciudad)\b/.test(t)){
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    const placeM = t.match(/\b(?:a|hacia)\s+([a-záéíóúüñ\s]+)$/i);
    return { type:'prefer_day_trip', city, dayTripTo: placeM ? placeM[1].trim() : null };
  }

  // Preferencia explícita de auroras
  if(/\b(auroras|aurora boreal|northern lights|ver auroras|tour de auroras|ver la aurora)\b/.test(t)){
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    return { type:'prefer_aurora', city };
  }

  // Eliminar día
  const rem = t.match(/(quita|elimina|borra)\s+el\s+d[ií]a\s+(\d+)/i);
  if(rem){
    return {
      type:'remove_day',
      city: detectCityInText(t) || detectCityFromCountryInText(t) || activeCity,
      day: parseInt(rem[2],10)
    };
  }

  // Intercambiar días (si no menciona actividad)
  const swap = t.match(/(?:pasa|mueve|cambia)\s+el\s+d[ií]a\s+(\d+)\s+(?:al|a)\s+(?:d[ií]a\s+)?(\d+)/i);
  if(swap && !/actividad|museo|visita|tour|cena|almuerzo|desayuno/i.test(t)){
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    return { type:'swap_day', city, from: parseInt(swap[1],10), to: parseInt(swap[2],10) };
  }

  // Mover actividad entre días
  const mv = t.match(/(?:mueve|pasa|cambia)\s+(.*?)(?:\s+del\s+d[ií]a\s+(\d+)|\s+del\s+(\d+))\s+(?:al|a)\s+(?:d[ií]a\s+)?(\d+)/i);
  if(mv){
    return {
      type:'move_activity',
      city: detectCityInText(t) || detectCityFromCountryInText(t) || activeCity,
      query: (mv[1]||'').trim(),
      fromDay: parseInt(mv[2]||mv[3],10),
      toDay: parseInt(mv[4],10)
    };
  }

  // Sustituir/eliminar actividad por texto natural
  if(/\b(no\s+quiero|sustituye|reemplaza|quita|elimina|borra)\b/.test(t)){
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    const m = t.match(/no\s+quiero\s+ir\s+a\s+(.+?)(?:,|\.)?$/i);
    return { type:'swap_activity', city, target: m ? m[1].trim() : null, details: text };
  }

  // Cambiar horas (ventana diaria)
  const range = parseTimeRangeFromText(text);
  if(range.start || range.end){
    return {
      type:'change_hours',
      city: detectCityInText(t) || detectCityFromCountryInText(t) || activeCity,
      range
    };
  }

  // Agregar ciudad
  const addCity = t.match(/(?:agrega|añade|suma)\s+([a-záéíóúüñ\s]+?)\s+(?:con\s+)?(\d+)\s*d[ií]as?(?:\s+(?:desde|iniciando)\s+(\d{1,2}\/\d{1,2}\/\d{4}))?/i);
  if(addCity){
    return {
      type:'add_city',
      city: addCity[1].trim(),
      days: parseInt(addCity[2],10),
      baseDate: addCity[3] || ''
    };
  }

  // Eliminar ciudad
  const delCity = t.match(/(?:elimina|borra|quita)\s+(?:la\s+ciudad\s+)?([a-záéíóúüñ\s]+)/i);
  if(delCity){
    return { type:'remove_city', city: delCity[1].trim() };
  }

  // Ajuste de perfil / preferencias (ritmo, movilidad, transporte, dieta, etc.)
  if(/\b(ritmo|relax|tranquilo|aventura|rápido|balanceado|niños|movilidad|caminar poco|transporte|uber|metro|tren|bus|autob[uú]s|veh[ií]culo|coche|auto|dieta|vegetariano|vegano|gluten|cel[ií]aco|preferencia|preferencias)\b/.test(t)){
    return { type:'set_profile', details: text };
  }

  // Preguntas informativas (clima, moneda, enchufes, etc.)
  if(/\b(clima|tiempo|temperatura|lluvia|horas de luz|moneda|cambio|propina|seguridad|visado|visa|fronteras|aduana|vuelos|aerol[ií]neas|equipaje|salud|vacunas|enchufes|taxis|alquiler|conducci[oó]n|peatonal|festivos|temporada|mejor época|gastronom[ií]a|restaurantes|precios|presupuesto|wifi|sim|roaming)\b/.test(t)){
    return { type:'info_query', details: text };
  }

  // Fallback: edición libre
  return { type:'free_edit', details: text };
}

/* ==============================
   SECCIÓN 18 · Edición/Manipulación + Optimización + Validación
   (Base v60 + refuerzos v64 + ajuste multi-noche de auroras)
   Refuerzo v65.1:
   - Si, tras evitar duplicados, el día queda "ligero", el agente DEBE completarlo
     con imperdibles pendientes o experiencias complementarias (barrios, miradores,
     mercados, playa urbana —p.ej., La Barceloneta en Barcelona—), manteniendo lógica
     y evitando duplicados entre días. Objetivo: ~6–7h netas dentro de la ventana diaria.
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

  // 🧊 Protege actividades especiales (auroras, Blue Lagoon/termales) para no perderlas en reordenamientos
  const protectedRows = rows.filter(r=>{
    const act = (r.activity||'').toLowerCase();
    return act.includes('aurora') || act.includes('northern light') ||
           act.includes('laguna azul') || act.includes('blue lagoon');
  });
  const rowsForOptimization = rows.filter(r=>{
    const act = (r.activity||'').toLowerCase();
    return !act.includes('aurora') && !act.includes('northern light') &&
           !act.includes('laguna azul') && !act.includes('blue lagoon');
  });

  // 🧠 Flags de replanificación / preferencias
  const hasForceReplan     = (typeof plannerState !== 'undefined' && plannerState.forceReplan && plannerState.forceReplan[city]);
  const hasDayTripPending  = (typeof plannerState !== 'undefined' && plannerState.dayTripPending && plannerState.dayTripPending[city]);
  const hasPreferDayTrip   = (typeof plannerState !== 'undefined' && plannerState.preferences && plannerState.preferences.preferDayTrip);

  let forceReplanBlock = '';
  if (hasForceReplan || hasDayTripPending || hasPreferDayTrip) {
    forceReplanBlock = `
👉 IMPORTANTE:
- El usuario ha extendido su estadía o indicó preferencia por un tour de 1 día en ${city}.
- REEQUILIBRA el itinerario de ${city} considerando el nuevo total de días.
- Evalúa excursiones de 1 día (máx. 2 h por trayecto) cuando aporten valor.
- Si el usuario especificó un destino (dayTripTo), prográmalo.
- Prioriza imperdibles locales y evita duplicados globales.
- Devuelve una planificación clara y optimizada.`;
  }

  // ⚡ Intake reducido si no se requiere replan global
  const intakeData = (hasForceReplan || hasDayTripPending || hasPreferDayTrip)
    ? buildIntake()
    : buildIntakeLite(city, { start: day, end: day }); // 👈 acotamos al día visible para rapidez

  // 🧭 Detección de contexto auroral para permitir múltiples noches
  let auroraCity=false;
  try{
    const coords = getCoordinatesForCity(city);
    auroraCity = coords ? isAuroraCityDynamic(coords.lat, coords.lng) : false;
  }catch(_){ auroraCity=false; }

  const prompt = `
${FORMAT}
Ciudad: ${city}
Día: ${day}
Fecha base (d1): ${baseDate||'N/A'}
Ventanas definidas para el día ${day}: ${JSON.stringify(perDay)}
Filas actuales (a optimizar sin perder protegidas):
${JSON.stringify(rowsForOptimization)}
${forceReplanBlock}

🕒 **Horarios inteligentes**:
- Si no hay horario definido, usa 08:30–19:00 como base.
- Puedes extender horarios cuando sea razonable:
  • Auroras: 20:00–02:30 aprox. (nunca diurno).
  • Cenas/vida nocturna: 19:00–23:30 aprox.
- Si extiendes una noche, **ajusta el inicio del día siguiente**.

🌍 **Optimización**:
- Reordena para minimizar traslados y agrupar por zonas.
- Evita duplicados con otros días ya planificados.
- **Si tras evitar duplicados el día queda "ligero" (< ~6h netas), DEBES completarlo** con:
   • Imperdibles de la ciudad que aún no estén cubiertos, y/o
   • Experiencias complementarias: barrio histórico, mercado principal, miradores/parques, paseo costero o **playa urbana si aplica** (p.ej., en Barcelona la playa de **La Barceloneta** es una opción frecuente), rutas panorámicas o gastronomía típica.
- Respeta la ventana del día; añade buffers ≥15 min entre actividades.
- Day trips ≤ 2 h por trayecto (ida), si hay tiempo y aportan valor.

🌌 **Auroras (si aplica)**:
- En destinos aurorales se permiten **múltiples noches de auroras** (una por cada noche si tiene sentido y clima/latitud lo justifican).
- No consideres las auroras **duplicadas** si están en **noches distintas**.
- Usa transporte plausible (“Tour/Bus/Van” o “Auto”) y añade breve justificación en notes (p.ej. \`valid:\`).

📝 **Notas**:
- Siempre útiles y concisas (nunca vacías ni “seed”).
- Indica “valid:” cuando sea estacional/operativo.

❌ **No duplicar**:
- No repitas la **misma actividad** ya existente **en el mismo día**.
- Entre días, evita duplicados salvo **auroras** (permitidas multi-noche en destinos aurorales).

Devuelve C {"rows":[...],"replace":false}.

Contexto mínimo para fusionar sin borrar:
${intakeData}
`.trim();

  const ans = await callAgent(prompt, true, { cityName: city, baseDate });
  const parsed = parseJSON(ans);
  if(parsed?.rows){
    let normalized = parsed.rows.map(x=>normalizeRow({...x, day}));

    // 🧼 FILTRO LOCAL · Evitar duplicados entre días, PERO permitir auroras multi-noche
    const allExisting = Object.values(itineraries[city].byDay || {})
      .flat()
      .filter(r => r.day !== day)
      .map(r => String(r.activity||'').trim().toLowerCase());

    normalized = normalized.filter(r=>{
      const act = String(r.activity||'').trim().toLowerCase();
      const isAurora = act.includes('aurora') || act.includes('northern light');
      if(isAurora && auroraCity) return true; // auroras permitidas multi-noche
      return act && !allExisting.includes(act);
    });

    // 🧭 Post-procesadores (refuerzos v64)
    if(typeof applyBufferBetweenRows === 'function'){
      normalized = applyBufferBetweenRows(normalized);     // Buffers ≥15 min
    }
    if(typeof reorderLinearVisits === 'function'){
      normalized = reorderLinearVisits(normalized);        // Secuencia lineal lógica
    }
    if(typeof ensureAuroraNight === 'function'){
      // Garantiza al menos una noche si procede; no elimina noches extra
      normalized = ensureAuroraNight(normalized, city);
    }

    // 🧩 Reconstrucción con protegidas (auroras/termales previamente existentes)
    const finalRows = [...normalized, ...protectedRows];

    // ✅ Validación global y push
    const val = await validateRowsWithAgent(city, finalRows, baseDate);
    pushRows(city, val.allowed, false);
  }
}

/* ==============================
   SECCIÓN 19 · Chat handler (global)
   — Optimizada con intents extendidos, day trips y auroras
================================= */
async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  // ============================================================
  // 🧠 OPTIMIZACIONES GLOBALES
  // ============================================================
  // - Evita reoptimizar días innecesarios (solo días afectados).
  // - Usa `buildIntakeLite()` cuando no se requiere contexto completo.
  // - Reutiliza `callInfoAgent` para consultas informativas.
  // - Unifica renderizaciones posteriores para mejorar fluidez visual.
  // ============================================================

  // Colecta hotel/transporte (primer paso antes de generar itinerarios)
  if(collectingHotels){
    const city = savedDestinations[metaProgressIndex].city;
    const transport = (/recom/i.test(text)) ? 'recomiéndame'
      : (/alquilad|rent|veh[ií]culo|coche|auto|carro/i.test(text)) ? 'vehículo alquilado'
      : (/metro|tren|bus|autob[uú]s|p[uú]blico/i.test(text)) ? 'transporte público'
      : (/uber|taxi|cabify|lyft/i.test(text)) ? 'otros (Uber/Taxi)'
      : '';

    // 🧠 Guardar hotel y transporte aunque sea texto libre (zona, dirección, coordenadas o link)
    upsertCityMeta({ city, hotel: text, transport });
    metaProgressIndex++;
    askNextHotelTransport();
    return;
  }

  // 🆕 Detectar cambio de hotel después de haber generado itinerario
  const hotelChangeMatch = text.match(/^(?:hotel|zona|direcci[oó]n):?\s*(.+)$/i);
  if(hotelChangeMatch && activeCity){
    const newHotel = hotelChangeMatch[1].trim();
    const city = activeCity;
    if(!cityMeta[city]) cityMeta[city] = { baseDate:null, hotel:'', transport:'', perDay:[] };
    const prevHotel = cityMeta[city].hotel || '';

    // ✅ Solo si el hotel cambió realmente
    if(newHotel && newHotel !== prevHotel){
      cityMeta[city].hotel = newHotel;
      chatMsg(`🏨 Actualicé el hotel/zona de <strong>${city}</strong>. Reajustando itinerario…`, 'ai');
      showWOW(true,'Reequilibrando tras cambio de hotel…');
      await rebalanceWholeCity(city);
      showWOW(false);
      chatMsg('✅ Itinerario reequilibrado tras el cambio de hotel.','ai');
    } else {
      chatMsg('ℹ️ El hotel ya estaba configurado con esa información.','ai');
    }
    return;
  }

  // Detecta intent (v17 extendida: day trips, auroras, etc.)
  const intent = intentFromText(text);

  // ============================================================
  // 0) Preferencia explícita de day trip sin agregar días
  //    (ej: “quiero un tour de un día cerca de X”)
  // ============================================================
  if(intent.type === 'free_edit' && /\b(tour de un d[ií]a|excursi[oó]n de un d[ií]a|algo fuera de la ciudad|un viaje de un d[ií]a|una escapada|salida de un d[ií]a)\b/i.test(text)){
    const city = activeCity || savedDestinations[0]?.city;
    if(city){
      if(!plannerState.preferences) plannerState.preferences = {};
      plannerState.preferences.preferDayTrip = true;
      chatMsg(`🧭 Perfecto — tendré en cuenta incluir una <strong>excursión de 1 día</strong> cerca de <strong>${city}</strong> cuando sea viable.`, 'ai');
      await rebalanceWholeCity(city);
      return;
    }
  }

  // ============================================================
  // 0.b) Preferencia explícita de auroras
  //      (ej: “quiero ver auroras en Tromsø”)
  // ============================================================
  if(intent.type === 'prefer_aurora'){
    const city = intent.city || activeCity || savedDestinations[0]?.city;
    if(city){
      if(!plannerState.preferences) plannerState.preferences = {};
      plannerState.preferences.preferAurora = true;
      chatMsg(`🌌 Perfecto — priorizaré <strong>noches de auroras</strong> en <strong>${city}</strong> cuando sea plausible.`, 'ai');
      // Opcional: reequilibrar ciudad para forzar una noche clara de auroras
      await rebalanceWholeCity(city);
      return;
    }
  }

  // ============================================================
  // 1) Normalizar "un día más" a add_day_end (y capturar day trip)
  // ============================================================
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

  // ============================================================
  // 2) Agregar varios días + rebalanceo global opcional
  // ============================================================
  if(intent.type==='add_days' && intent.city && intent.extraDays>0){
    const city = intent.city;
    showWOW(true,'Agregando días y reoptimizando…');
    addMultipleDaysToCity(city, intent.extraDays);
    await rebalanceWholeCity(city, { dayTripTo: intent.dayTripTo||'' });
    showWOW(false);
    chatMsg(`✅ Agregué ${intent.extraDays} día(s) a ${city}, incorporé actividades plausibles y reoptimicé todo el itinerario.`, 'ai');
    return;
  }

  // ============================================================
  // 3) Agregar día al FINAL (con o sin day trip detallado)
  //    ⚠️ FIX: asegura ventana válida del nuevo día (08:30–19:00 por defecto)
  // ============================================================
  if (intent.type === 'add_day_end' && intent.city) {
    const city = intent.city;
    showWOW(true, 'Insertando día y optimizando…');
    ensureDays(city);
    const byDay = itineraries[city].byDay || {};
    const days = Object.keys(byDay).map(n => +n).sort((a, b) => a - b);
    const numericPos = days.length + 1;
    insertDayAt(city, numericPos);

    // ✅ Ventana de horario del nuevo día (hereda del anterior si existe; si no, 08:30–19:00)
    if(!cityMeta[city]) cityMeta[city] = { baseDate:null, hotel:'', transport:'', perDay:[] };
    let pd = cityMeta[city].perDay.find(x=>x.day===numericPos);
    if(!pd){
      const prev = cityMeta[city].perDay.find(x=>x.day===numericPos-1) || {};
      const start = prev.start || DEFAULT_START;
      const end   = prev.end   || DEFAULT_END;
      cityMeta[city].perDay.push({ day:numericPos, start, end });
    }

    // =============================
    // Semilla + itinerario detallado para day trip (si aplica)
    // =============================
    if (intent.dayTripTo) {
      const destTrip = intent.dayTripTo;
      const start =
        cityMeta[city]?.perDay?.find(x => x.day === numericPos)?.start ||
        DEFAULT_START;
      const end =
        cityMeta[city]?.perDay?.find(x => x.day === numericPos)?.end ||
        DEFAULT_END;

      // Semilla inicial clara
      const rowsSeed = [
        {
          day: numericPos,
          start,
          end: addMinutes(start, 60),
          activity: `Traslado a ${destTrip}`,
          from: `Hotel (${city})`,
          to: destTrip,
          transport: 'Tren/Bus',
          duration: '≈ 1h',
          notes: `Inicio del day trip desde el hotel en ${city} hacia ${destTrip}.`,
        },
      ];
      pushRows(city, rowsSeed, false);

      // Prompt reforzado para secuencia clara de day trip
      const promptDayTrip = `
${FORMAT}
Genera un itinerario completo y secuencial de 1 día para visitar **${destTrip}** saliendo desde **${city}** y regresando el mismo día.

🚆 Instrucciones:
- El trayecto debe iniciar siempre en "Hotel (${city})" y finalizar en "Hotel (${city})".
- Incluye traslados claramente rotulados con “Desde” y “Hacia”:
  • Hotel (${city}) → ${destTrip}
  • Lugares intermedios en orden lógico
  • ${destTrip} → Hotel (${city})
- No uses nombres genéricos como “Excursión a…”.
- Incluye visitas clave, pausas (almuerzo/café) y tiempos de traslado realistas.
- Evita duplicar traslados si ya existe uno inicial.
- Devuelve formato JSON: {"rows":[...]} con campos (day,start,end,activity,from,to,transport,duration,notes).
- Notas siempre útiles, nunca vacías.
`.trim();

      try {
        const ansTrip = await callAgent(promptDayTrip, true);
        const parsedTrip = parseJSON(ansTrip);
        if (parsedTrip?.rows?.length) {
          const detailedRows = parsedTrip.rows.map(r =>
            normalizeRow({ ...r, day: numericPos })
          );

          // Limpiar semilla si el modelo ya incluye traslado equivalente
          const hasTransfer = detailedRows.some(
            r =>
              String(r.from).toLowerCase() === `hotel (${city})`.toLowerCase() &&
              String(r.to).toLowerCase() === destTrip.toLowerCase() &&
              /traslado|viaje/i.test(r.activity)
          );
          if (hasTransfer) {
            itineraries[city].byDay[numericPos] = (itineraries[city].byDay[numericPos] || [])
              .filter(r =>
                !(
                  String(r.from).toLowerCase() === `hotel (${city})`.toLowerCase() &&
                  String(r.to).toLowerCase() === destTrip.toLowerCase() &&
                  /traslado/i.test(r.activity)
                )
              );
          }

          pushRows(city, detailedRows, false);
          chatMsg(
            `🧭 Generé un itinerario completo y secuencial de excursión a <strong>${destTrip}</strong>.`,
            'ai'
          );
        } else {
          chatMsg(
            `⚠️ No logré generar un itinerario detallado para <strong>${destTrip}</strong>; se mantiene la estructura básica.`,
            'ai'
          );
        }
      } catch (err) {
        console.error('Error generando day trip:', err);
        chatMsg(
          `⚠️ Ocurrió un error al generar el itinerario detallado para ${destTrip}.`,
          'ai'
        );
      }
    }

    // Optimización del nuevo día (usa la ventana recién fijada)
    await optimizeDay(city, numericPos);
    renderCityTabs();
    setActiveCity(city);
    renderCityItinerary(city);
    showWOW(false);
    chatMsg('✅ Día agregado y plan reoptimizado globalmente.', 'ai');
    return;
  }

  // ============================================================
  // 4) Quitar día (reoptimiza sólo días posteriores)
  // ============================================================
  if(intent.type==='remove_day' && intent.city && Number.isInteger(intent.day)){
    showWOW(true,'Eliminando día…');
    removeDayAt(intent.city, intent.day);
    const totalDays = Object.keys(itineraries[intent.city].byDay||{}).length;
    for(let d=intent.day; d<=totalDays; d++) await optimizeDay(intent.city, d);
    renderCityTabs(); setActiveCity(intent.city); renderCityItinerary(intent.city);
    showWOW(false);
    chatMsg('✅ Día eliminado y plan reequilibrado.','ai');
    return;
  }

  // ============================================================
  // 5) Intercambiar días
  // ============================================================
  if(intent.type==='swap_day' && intent.city){
    showWOW(true,'Intercambiando días…');
    swapDays(intent.city, intent.from, intent.to);
    await Promise.all([
      optimizeDay(intent.city, intent.from),
      optimizeDay(intent.city, intent.to)
    ]);
    renderCityTabs(); setActiveCity(intent.city); renderCityItinerary(intent.city);
    showWOW(false);
    chatMsg('✅ Intercambié el orden y optimicé ambos días.','ai');
    return;
  }

  // ============================================================
  // 6) Mover actividad entre días
  // ============================================================
  if(intent.type==='move_activity' && intent.city){
    showWOW(true,'Moviendo actividad…');
    moveActivities(intent.city, intent.fromDay, intent.toDay, intent.query||'');
    await Promise.all([
      optimizeDay(intent.city, intent.fromDay),
      optimizeDay(intent.city, intent.toDay)
    ]);
    renderCityTabs(); setActiveCity(intent.city); renderCityItinerary(intent.city);
    showWOW(false);
    chatMsg('✅ Moví la actividad y optimicé los días implicados.','ai');
    return;
  }

  // ============================================================
  // 7) Sustituir/Eliminar actividad (día visible)
  // ============================================================
  if(intent.type==='swap_activity' && intent.city){
    const city = intent.city;
    const day  = itineraries[city]?.currentDay || 1;
    showWOW(true,'Ajustando actividades…');
    const q = intent.target ? intent.target.toLowerCase() : '';
    if(q){
      const before = itineraries[city].byDay[day]||[];
      itineraries[city].byDay[day] = before.filter(r => !String(r.activity||'').toLowerCase().includes(q));
    }
    await optimizeDay(city, day);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    showWOW(false);
    chatMsg('✅ Sustituí la actividad y reoptimicé el día.','ai');
    return;
  }

  // ============================================================
  // 8) Cambiar horas (ventana por día)
  // ============================================================
  if(intent.type==='change_hours' && intent.city){
    showWOW(true,'Ajustando horarios…');
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
    chatMsg('✅ Ajusté los horarios y reoptimicé tu día.','ai');
    return;
  }

  // ============================================================
  // 9) Agregar ciudad
  // ============================================================
  if(intent.type==='add_city' && intent.city){
    const name = intent.city.trim().replace(/\s+/g,' ').replace(/^./,c=>c.toUpperCase());
    const days = intent.days || 2;
    addCityRow({city:name, days:'', baseDate:intent.baseDate||''});
    const lastRow = $cityList.lastElementChild;
    const sel = lastRow?.querySelector('.days');
    if(sel){ sel.value = String(days); sel.dispatchEvent(new Event('change')); }
    saveDestinations();
    chatMsg(
      `✅ Añadí <strong>${name}</strong>. Dime tu <strong>hotel/zona</strong> (puedes dar zona aproximada, dirección exacta, nombre de hotel o incluso pegar coordenadas o link de Google Maps) y el <strong>medio de transporte</strong> (alquiler, público, taxi/uber, combinado o “recomiéndame”).`,
      'ai'
    );
    return;
  }

  // ============================================================
  // 10) Eliminar ciudad
  // ============================================================
  if(intent.type==='remove_city' && intent.city){
    const name = intent.city.trim();
    savedDestinations = savedDestinations.filter(x=>x.city!==name);
    delete itineraries[name];
    delete cityMeta[name];
    renderCityTabs();
    chatMsg(`🗑️ Eliminé <strong>${name}</strong> de tu itinerario.`, 'ai');
    return;
  }

  // ============================================================
  // 11) Preguntas informativas
  // ============================================================
  if(intent.type==='info_query'){
    try{
      setChatBusy(true);
      const ans = await callInfoAgent(text);
      chatMsg(ans || '¿Algo más que quieras saber?');
    } finally {
      setChatBusy(false);
    }
    return;
  }

  // ============================================================
  // 12) Edición libre — reoptimiza sólo días con cambios
  // ============================================================
  if(intent.type==='free_edit'){
    const city = activeCity || savedDestinations[0]?.city;
    if(!city){ chatMsg('Aún no hay itinerario en pantalla. Inicia la planificación primero.'); return; }
    const day = itineraries[city]?.currentDay || 1;
    showWOW(true,'Aplicando tu cambio…');

    const data = itineraries[city];
    const dayRows = (data?.byDay?.[day]||[]).map(r=>`• ${r.start||''}-${r.end||''} ${r.activity}`).join('\n') || '(vacío)';
    const perDay = (cityMeta[city]?.perDay||[]).map(pd=>({day:pd.day, start:pd.start||DEFAULT_START, end:pd.end||DEFAULT_END}));

    const prompt = `
${FORMAT}
**Contexto (reducido si es posible):**
${buildIntakeLite()}

**Ciudad a editar:** ${city}
**Día visible:** ${day}
**Actividades del día:**
${dayRows}

**Ventanas por día:** ${JSON.stringify(perDay)}
**Instrucción del usuario (libre):** ${text}

🕒 Horarios:
- Usa 08:30–19:00 como base si no hay nada definido.
- Puedes extender horarios cuando sea razonable (auroras, cenas, tours especiales).
- Si extiendes el horario de un día, ajusta inteligentemente el inicio del día siguiente.
- Añade buffers ≥15 min entre actividades.

- Integra lo pedido SIN borrar lo existente (fusión). 
- Si no se especifica un día concreto, reacomoda toda la ciudad evitando duplicados.
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

      // ⚡ Optimiza solo días con cambios
      const daysChanged = new Set(rows.map(r=>r.day).filter(Boolean));
      await Promise.all([...daysChanged].map(d=>optimizeDay(city, d)));

      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
      showWOW(false);
      chatMsg('✅ Apliqué el cambio y reoptimicé los días implicados.','ai');
    }else{
      showWOW(false);
      chatMsg(parsed?.followup || 'No recibí cambios válidos. ¿Intentamos de otra forma?','ai');
    }
    return;
  }
}

/* ==============================
   SECCIÓN 20 · Orden de ciudades + Eventos — optimizada
================================= */
function addRowReorderControls(row){
  const ctrlWrap = document.createElement('div');
  ctrlWrap.style.display = 'flex';
  ctrlWrap.style.gap = '.35rem';
  ctrlWrap.style.alignItems = 'center';

  const up = document.createElement('button');
  up.textContent = '↑';
  up.className = 'btn ghost';
  const down = document.createElement('button');
  down.textContent = '↓';
  down.className = 'btn ghost';

  ctrlWrap.appendChild(up);
  ctrlWrap.appendChild(down);
  row.appendChild(ctrlWrap);

  // 🆙 Subir ciudad
  up.addEventListener('click', ()=>{
    if(row.previousElementSibling){
      $cityList.insertBefore(row, row.previousElementSibling);
      saveDestinations(); // ⚡ sincroniza inmediatamente orden
    }
  });

  // ⬇️ Bajar ciudad
  down.addEventListener('click', ()=>{
    if(row.nextElementSibling){
      $cityList.insertBefore(row.nextElementSibling, row);
      saveDestinations(); // ⚡ sincroniza inmediatamente orden
    }
  });
}

// 🧭 Inyectar controles de ordenamiento a cada nueva fila de ciudad
const origAddCityRow = addCityRow;
addCityRow = function(pref){
  origAddCityRow(pref);
  const row = $cityList.lastElementChild;
  if(row) addRowReorderControls(row);
};

// 🧼 País: permitir solo letras y espacios (protección suave en input)
document.addEventListener('input', (e)=>{
  if(e.target && e.target.classList && e.target.classList.contains('country')){
    const original = e.target.value;
    const filtered = original.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g,'');
    if(filtered !== original){
      const pos = e.target.selectionStart;
      e.target.value = filtered;
      if(typeof pos === 'number'){
        // ⚡ Ajuste más suave del cursor para que no salte abruptamente
        e.target.setSelectionRange(
          pos - (original.length - filtered.length),
          pos - (original.length - filtered.length)
        );
      }
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
    tooltip.textContent = 'Por favor ingresa la fecha de inicio (DD/MM/AAAA) para cada ciudad 🗓️';
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

// ⛔ Reset con confirmación modal (corregido: visible → active)
qs('#reset-planner')?.addEventListener('click', ()=>{
  const overlay = document.createElement('div');
  overlay.className = 'reset-overlay';

  const modal = document.createElement('div');
  modal.className = 'reset-modal';
  modal.innerHTML = `
    <h3>¿Reiniciar planificación? 🧭</h3>
    <p>Esto eliminará todos los destinos, itinerarios y datos actuales.<br><strong>No se podrá deshacer.</strong></p>
    <div class="reset-actions">
      <button id="confirm-reset" class="btn warn">Sí, reiniciar</button>
      <button id="cancel-reset" class="btn ghost">Cancelar</button>
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
    if ($start) $start.disabled = true;
    if ($tabs) $tabs.innerHTML='';
    if ($itWrap) $itWrap.innerHTML='';
    if ($chatBox) $chatBox.style.display='none';
    if ($chatM) $chatM.innerHTML='';
    session = []; hasSavedOnce=false; pendingChange=null;

    // 🔄 Flags de planificación
    planningStarted = false;
    metaProgressIndex = 0;
    collectingHotels = false;
    isItineraryLocked = false;
    activeCity = null;

    // 🔄 Limpiar overlays/tooltips si están activos
    try { if ($overlayWOW) $overlayWOW.style.display = 'none'; } catch(_) {}
    qsa('.date-tooltip').forEach(t => t.remove());

    // 🔄 Restaurar formulario lateral a valores por defecto
    const $sc = qs('#special-conditions'); if($sc) $sc.value = '';
    const $ad = qs('#p-adults');   if($ad) $ad.value = '1';
    const $yo = qs('#p-young');    if($yo) $yo.value = '0';
    const $ch = qs('#p-children'); if($ch) $ch.value = '0';
    const $in = qs('#p-infants');  if($in) $in.value = '0';
    const $se = qs('#p-seniors');  if($se) $se.value = '0';
    const $bu = qs('#budget');     if($bu) $bu.value = '';
    const $cu = qs('#currency');   if($cu) $cu.value = 'USD'; // ✅ FIX: era $value

    // 🔄 Sincronizar plannerState (definido en Sección 1)
    if (typeof plannerState !== 'undefined') {
      plannerState.destinations = [];
      plannerState.specialConditions = '';
      plannerState.travelers = { adults:1, young:0, children:0, infants:0, seniors:0 };
      plannerState.budget = '';
      plannerState.currency = 'USD';
      plannerState.forceReplan = {};     // 🧼 limpiar banderas de replanificación
      plannerState.preferences = {};     // 🧼 limpiar preferencias (day trips, auroras, etc.)
      plannerState.dayTripPending = {};  // 🧼 limpiar flags de day trip pendiente
      plannerState.existingActs = {};    // 🧼 limpiar cache de actividades existentes
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

// CTA y upsell (con guardas para evitar null.style)
$confirmCTA?.addEventListener('click', ()=>{ 
  isItineraryLocked = true;
  const upsell = qs('#monetization-upsell');
  if (upsell) upsell.style.display = 'flex';
});
$upsellClose?.addEventListener('click', ()=>{
  const upsell = qs('#monetization-upsell');
  if (upsell) upsell.style.display = 'none';
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
}
function closeInfoModal(){
  const modal = qs('#info-chat-modal');
  if(!modal) return;
  modal.classList.remove('active');
  modal.style.display = 'none';
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
});
