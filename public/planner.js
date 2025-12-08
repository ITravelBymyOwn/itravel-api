/* =========================================================
   ITRAVELBYMYOWN · PLANNER v76
   Base: v75
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
    // Formato estándar del planner: DD/MM/AAAA
    const m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(baseDateStr.trim());
    if(m){
      const month = parseInt(m[2], 10);
      return AURORA_SEASON_MONTHS.includes(month);
    }
    // Fallback robusto si llegara otro formato: intenta inferir el mes
    const parts = baseDateStr.split(/[\/\-]/).map(x=>parseInt(x,10)).filter(Number.isFinite);
    if(parts.length >= 2){
      const [a,b] = parts;
      const monthGuess = (a > 12 && b >=1 && b<=12) ? b : (a>=1 && a<=12 ? a : b);
      return AURORA_SEASON_MONTHS.includes(monthGuess);
    }
    return true;
  }catch{ return true; }
}

// 🌐 Day trip dinámico (neutral, sin ejemplos preestablecidos)
const GLOBAL_DAY_TRIP_HINTS = {
  radiusKm: 200 // radio máximo razonable; el agente decide candidatos
};

function getHeuristicDayTripContext(city){
  // Contexto neutro para que el agente razone sin sesgos por destino
  return {
    radiusKm: GLOBAL_DAY_TRIP_HINTS.radiusKm,
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
  // 🆕 Placeholder visible + tooltip (coherente con todo el planner)
  el.placeholder = 'DD/MM/AAAA';
  el.title = 'Formato: DD/MM/AAAA';
  el.addEventListener('input', ()=>{
    const v = el.value.replace(/\D/g,'').slice(0,8);
    if(v.length===8){
      // DD/MM/AAAA
      el.value = `${v.slice(0,2)}/${v.slice(2,4)}/${v.slice(4,8)}`;
    } else {
      el.value = v;
    }
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
   SECCIÓN 12 · Llamada a Astra (estilo global, v66 inteligencia contextual)
   Base v65, mejoras v66: inteligencia global, imperdibles, energía/ritmo,
   day trips ≤2h (≤3h si >5 días en ciudad), sensibilidad costera, auroras,
   notas obligatorias y optimizaciones de latencia.
   Mantiene compatibilidad con: callAgent, callInfoAgent, parseJSON, session/infoSession,
   MODEL, API_URL, showThinking, setInfoChatBusy, tone, AURORA_DEFAULT_WINDOW, 
   isAuroraCityDynamic, inAuroraSeasonDynamic, getCoordinatesForCity, getHeuristicDayTripContext.
   ────────────────────────────────────────────────────────────
   🔍 v66 — Sección 12 reforzada con inteligencia contextual global
================================= */
async function callAgent(text, useHistory = true, opts = {}){
  // ⏳ Timeout ligeramente más agresivo para mejorar percepción de velocidad
  const { timeoutMs = 45000, cityName = null, baseDate = null } = opts;

  // 🧠 Historial compacto: últimas 6 interacciones para reducir tokens pero mantener contexto
  const history = useHistory
    ? (Array.isArray(session) ? session.slice(Math.max(0, session.length - 12)) : [])
    : [];

  // ───────────────── Heurísticas dinámicas (no bloqueantes) ────────────────
  let heuristicsContext = '';
  let auroraCity = false;
  let auroraSeason = false;
  let dayTripCtx = {};
  let stayDaysForCity = 0; // usado para regla ≤3h si >5 días
  try {
    if (cityName) {
      const coords = getCoordinatesForCity(cityName);
      if (coords && typeof coords.lat === 'number' && typeof coords.lng === 'number') {
        auroraCity = isAuroraCityDynamic(coords.lat, coords.lng);
      }
      auroraSeason = inAuroraSeasonDynamic(baseDate);
      dayTripCtx = getHeuristicDayTripContext(cityName) || {};
      // Detecta días de estancia actuales (si existen estructuras globales)
      if (typeof itineraries !== 'undefined' && itineraries[cityName]?.byDay) {
        stayDaysForCity = Object.keys(itineraries[cityName].byDay).length;
      } else if (Array.isArray(savedDestinations)) {
        const d = savedDestinations.find(x => x.city === cityName);
        stayDaysForCity = d?.days || 0;
      }
      const auroraWindow = AURORA_DEFAULT_WINDOW;

      heuristicsContext = `
───────────────────────────────
🧭 CONTEXTO HEURÍSTICO GLOBAL
───────────────────────────────
- Ciudad: ${cityName}
- Estancia (días): ${stayDaysForCity}
- Aurora City: ${auroraCity}
- Aurora Season: ${auroraSeason}
- Aurora Window: ${JSON.stringify(auroraWindow)}
- Day Trip Context: ${JSON.stringify(dayTripCtx)}
      `.trim();
    }
  } catch (err) {
    console.warn('Heurística dinámica no disponible para:', cityName, err);
  }

  // ───────────────── Estilo / Reglas globales reforzadas (v66) ─────────────
  const globalStyle = `
Eres "Astra", planificador internacional experto. Respondes con itinerarios y ediciones **realistas, optimizados y accionables**.

📌 PRIORIDADES (v66):
1) **Imperdibles primero**: identifica y coloca los atractivos icónicos de cada ciudad antes que el resto.
2) **Secuencia lógica y sin estrés**: agrupa por zonas, reduce traslados, incluye buffers (≥15 min).
3) **Sin duplicados**: evita repetir actividades entre días, salvo excepciones de temporada/nocturnas justificadas (e.g., auroras).
4) **Ritmo/Energía**: balancea caminatas, comidas y descansos; evita jornadas maratónicas.
5) **Experiencia local**: incluye gastronomía relevante y momentos fotogénicos cuando aporte valor.
6) **Day trips**: solo si **aportan gran valor** y
   • ≤ 2 h por trayecto (ida) por defecto; 
   • ≤ 3 h por trayecto (ida) si la estancia en la ciudad **es > 5 días** (aplica a esta ciudad).
   Siempre ida y vuelta el mismo día, con traslados claros y agenda secuencial (origen → visitas → regreso).
7) **Sensibilidad costera**: si la ciudad es costera (p.ej. Barcelona), considera paseo marítimo/puerto/playa icónica cuando el tiempo lo permita, sin forzar clima.
8) **Auroras** (si plausible por ciudad/fecha): horario nocturno 20:00–02:30, con \`valid:\` en notas, transporte coherente; puede repetirse varias noches **si** agrega valor.
9) **Notas útiles siempre**: jamás dejes \`notes\` vacío ni \`seed\`; incluye tips de reserva, accesibilidad o contexto.

🕒 HORARIOS:
- Usa ventanas definidas por el usuario si existen; si no, asume base **08:30–19:00**.
- Puedes ampliar para cenas/tours nocturnos/auroras y **compensar el inicio del día siguiente** si corresponde.
- Nunca propongas auroras de día.

🌦️ CLIMA/ESTACIONALIDAD (nivel general):
- Ten en cuenta plausibilidad por estación (sin consultar en vivo); si una actividad es muy sensible al clima, sugiere plan B razonable.

🛡️ SEGURIDAD/RESTRICCIONES:
- Evita zonas con riesgos evidentes y marca alternativas seguras cuando aplique (breve, sin alarmismo).

📄 FORMATO (estricto):
- Usa el contrato JSON que se provee en el prompt de llamada (FORMAT). Nada de markdown ni texto fuera del JSON.
- No excedas 20 filas por día.

${heuristicsContext}
  `.trim();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);

  try{
    showThinking?.(true);

    // 🔽 Cuerpo compacto: evita texto redundante en payload para reducir tokens/latencia
    const payload = {
      model: MODEL,
      input: `${globalStyle}\n\n${text}`,
      history
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });

    // Fail-soft
    const data = res.ok ? await res.json().catch(()=>({text:''})) : {text:''};
    return (data?.text || '');
  } catch(e){
    console.error("Fallo al contactar la API:", e);
    return `{"followup":"${tone?.fail || 'No pude completar la acción.'}"}`;
  } finally{
    clearTimeout(timer);
    showThinking?.(false);
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

/* Info Chat: respuesta breve, factual y accionable (sin JSON) */
async function callInfoAgent(text){
  const history = Array.isArray(infoSession) ? infoSession.slice(Math.max(0, infoSession.length - 12)) : [];
  const globalStyle = `
Eres "Astra", asistente informativo de viajes.
- SOLO respondes preguntas informativas (clima histórico aproximado, visados, movilidad, seguridad, presupuesto, enchufes, mejor época, normas básicas) de forma breve, clara y accionable.
- Considera factores de seguridad básicos y estacionalidad de forma general (sin consultar fuentes en vivo).
- NO propones ediciones de itinerario ni devuelves JSON. Respondes en texto directo.
`.trim();

  try{
    setInfoChatBusy?.(true);

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

    // Persistimos historial compacto
    if(Array.isArray(infoSession)){
      infoSession.push({ role:'user',      content: text });
      infoSession.push({ role:'assistant', content: answer });
      // Recorte suave para no crecer infinito
      if(infoSession.length > 24) infoSession.splice(0, infoSession.length - 24);
    }

    // Protección por si el modelo devuelve JSON por error
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
    return tone?.fail || 'No se pudo obtener información en este momento.';
  }finally{
    setInfoChatBusy?.(false);
  }
}

/* ==============================
   SECCIÓN 13 · Merge / utilidades
================================= */
function dedupeInto(arr, row){
  // 🔧 Mejora: normalización robusta para evitar duplicados multi-idioma
  const key = o => [
    o.day,
    o.start || '',
    o.end   || '',
    normKey(o.activity || '')
  ].join('|');
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
  // 🔧 Mejora: usar normKey en activity/from/to para evitar duplicados semánticos en el MISMO día
  const seen = new Set();
  const out = [];
  for(const r of rows.sort((a,b)=> (a.start||'') < (b.start||'') ? -1 : 1)){
    const k = [normKey(r.activity||''), normKey(r.from||''), normKey(r.to||'')].join('|');
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
    .map(r => normKey(String(r.activity || '')))
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
   Base v60 (exacta) + injertos v64 + ⚡ early-exit cuando ENABLE_VALIDATOR=false
================================= */
async function validateRowsWithAgent(city, rows, baseDate){
  // Helpers locales (sin dependencias externas)
  const toStr = v => (v==null ? '' : String(v));
  const lc = s => toStr(s).trim().toLowerCase();
  const isAurora = a => /\baurora|northern\s+light(s)?\b/i.test(toStr(a));
  const isThermal = a => /(blue\s*lagoon|bláa\s*lón(i|í)d|laguna\s+azul|termal(es)?|hot\s*spring|thermal\s*bath)/i.test(toStr(a));

  // 📦 Sanitizado local (reutilizado en fast-path y fallback)
  const localSanitize = (inRows = [])=>{
    const sanitized = (inRows||[]).map(r => {
      const notesRaw = toStr(r.notes).trim();
      const notes = notesRaw && lc(notesRaw)!=='seed'
        ? notesRaw
        : 'Sugerencia: verifica horarios, seguridad básica y reserva con antelación.';
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

    // Límite suave de 20 por día + dedupe por actividad canonizada
    const grouped = {};
    sanitized.forEach(r=>{
      const d = Number(r.day)||1;
      (grouped[d] ||= []).push(r);
    });
    const allowed = Object.keys(grouped).flatMap(dStr=>{
      const d = Number(dStr);
      let arr = grouped[d];

      // Dedupe fuerte por actividad canonizada para mismo día
      const seenActs = new Set();
      arr = arr.filter(x=>{
        const k = normKey(x.activity || '');
        if(!k) return false;
        if(seenActs.has(k)) return false;
        seenActs.add(k);
        return true;
      });

      if(arr.length <= 20) return arr.map(x=>({...x, day:d}));
      const out=[]; const seen = new Set();
      for(const r of arr){
        const key = normKey(r.activity || '') + '|' + (r.start||'') + '|' + (r.end||'');
        if(!seen.has(key)){
          seen.add(key); out.push({...r, day:d});
        }
        if(out.length===20) break;
      }
      return out;
    });
    return { allowed, removed: [] };
  };

  // ⚡ Fast-path: sin llamada a IA cuando ENABLE_VALIDATOR=false
  if (ENABLE_VALIDATOR === false) {
    return localSanitize(rows);
  }

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
...
Contexto:
- Ciudad: "${city}"
- Fecha base (Día 1): ${baseDate || 'N/A'}
- Filas a validar: ${JSON.stringify(rows)}
`.trim();

  // Post-sanitizado suave para respuestas con IA
  const postSanitize = (arr=[])=>{
    const byDay = {};
    arr.forEach(r=>{
      const d = Number(r.day)||1;
      (byDay[d] ||= []).push(r);
    });
    const out = [];
    for(const dStr of Object.keys(byDay)){
      const d = Number(dStr);
      let dayRows = byDay[d].map(r=>{
        let notes = toStr(r.notes).trim();
        if(!notes || lc(notes)==='seed'){
          notes = 'Sugerencia: verifica horarios, seguridad y reservas con antelación.';
        }
        if(isAurora(r.activity)){
          const start = r.start && r.start.match(/^\d{2}:\d{2}$/) ? r.start : '20:30';
          const end   = r.end   && r.end.match(/^\d{2}:\d{2}$/)   ? r.end   : '02:00';
          const transport = r.transport ? r.transport : 'Tour/Bus/Van';
          if(!/valid:/i.test(notes)) notes = (notes ? notes+' · ' : '') + 'valid: ventana nocturna auroral (sujeto a clima).';
          return {...r, day:d, start, end, transport, notes};
        }
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

      // Dedupe por actividad canonizada + límite 20
      const seenActs = new Set();
      dayRows = dayRows.filter(x=>{
        const k = normKey(x.activity||'');
        if(!k) return false;
        if(seenActs.has(k)) return false;
        seenActs.add(k);
        return true;
      });

      if(dayRows.length > 20){
        const seen = new Set(); const filtered=[];
        for(const r of dayRows){
          const key = normKey(r.activity||'') + '|' + (r.start||'') + '|' + (r.end||'');
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
      const allowed = postSanitize(parsed.allowed || []);
      const removed = Array.isArray(parsed.removed) ? parsed.removed : [];
      return { allowed, removed };
    }
  }catch(e){
    console.warn('Validator error', e);
  }

  // Fallback local
  return localSanitize(rows);
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
   Base v60 + injertos v64 + dedupe global con normKey
   🆕 v75→API42.4: consume /api/chat (mode:"planner") y su contrato JSON
   🆕 Eliminado: bloque de "Aurora Injection" local (la decide INFO→PLANNER)
───────────────────────────────────────────────────────────── */
async function generateCityItinerary(city){
  window.__cityLocks = window.__cityLocks || {};
  if (window.__cityLocks[city]) {
    console.warn(`[Mutex] Generación ya en curso para ${city}`);
    return;
  }
  window.__cityLocks[city] = true;

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

  // 🆕 helper para invocar /api/chat (planner)
  async function callPlannerAPI(messages, opts = {}) {
    const payload = {
      mode: "planner",
      messages,
    };
    if (opts.itinerary_id) payload.itinerary_id = opts.itinerary_id;
    if (typeof opts.version === 'number') payload.version = opts.version;

    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`API planner HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const text = data?.text || "";
    return parseJSON(text);
  }

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

    const forceReplan = (typeof plannerState !== 'undefined' && plannerState.forceReplan && plannerState.forceReplan[city]) ? true : false;

    let heuristicsContext = '';
    try{
      const coords = getCoordinatesForCity(city);
      const dayTripContext = getHeuristicDayTripContext(city) || {};

      heuristicsContext = `
───────────────────────────────
🧭 CONTEXTO HEURÍSTICO GLOBAL
───────────────────────────────
- Ciudad: ${city}
- Coords: ${coords ? JSON.stringify(coords) : 'N/D'}
- Day Trip Context: ${JSON.stringify(dayTripContext)}
      `.trim();
    }catch(err){
      console.warn('Heurística no disponible:', city, err);
      heuristicsContext = '⚠️ Sin contexto heurístico disponible.';
    }

    // NOTA: la decisión, ventana y notas de auroras las define el flujo INFO→PLANNER en el API.
    const intakeText = `
${FORMAT}
**Genera únicamente ${dest.days} día/s para "${city}"** (tabs y tablas ya existen en UI).
Ventanas base por día (UI): ${JSON.stringify(perDay)}.
Hotel/zona: ${hotel || 'a determinar'} · Transporte preferido: ${transport || 'a determinar'}.

Requisitos:
- Cobertura completa días 1–${dest.days} (sin días vacíos).
- Usa rutas madre → subparadas cuando aplique. Inserta "Regreso a ${city}" en day-trips.
- Horarios plausibles: base 08:30–19:00 si no hay nada mejor; buffers ≥15m. (No bloquees nocturnos si el research lo sugiere.)
- Transporte coherente: urbano a pie/metro; interurbano vehículo o tour si no hay bus local.
- Duraciones normalizadas ("1h30m", "45m"). Máx 20 filas/día.

Notas:
- Siempre informativas, breves y útiles (con "valid:" cuando corresponda).
- Si el research trae auroras, respétalas tal cual (ventanas/nota/duración).

Contexto adicional:
${heuristicsContext}

INTAKE:
${buildIntake()}
`.trim();

    if (typeof setOverlayMessage === 'function') {
      try { setOverlayMessage(`Generando itinerario para ${city}…`); } catch(_) {}
    }

    const apiMessages = [{ role: "user", content: intakeText }];
    const current = itineraries?.[city] || null;
    const parsed = await callPlannerAPI(apiMessages, {
      itinerary_id: current?.itinerary_id,
      version: typeof current?.version === 'number' ? current.version : undefined,
    });

    if(parsed && (parsed.rows || parsed.destination)){
      const rowsFromApi = Array.isArray(parsed.rows) ? parsed.rows : [];
      let tmpRows = rowsFromApi.map(r=>normalizeRow(r));

      // 🧼 Anti-duplicados contra lo ya presente en la ciudad
      const existingActs = Object.values(itineraries[city]?.byDay||{})
        .flat()
        .map(r=>normKey(String(r.activity||'')));
      tmpRows = tmpRows.filter(r=>!existingActs.includes(normKey(String(r.activity||''))));

      // 🔧 Fixes suaves (no invasivos)
      if(typeof applyTransportSmartFixes==='function') tmpRows=applyTransportSmartFixes(tmpRows);
      if(typeof applyThermalSpaMinDuration==='function') tmpRows=applyThermalSpaMinDuration(tmpRows);
      if(typeof sanitizeNotes==='function') tmpRows=sanitizeNotes(tmpRows);

      // 🧩 Empuje a estado
      pushRows(city, tmpRows, !!forceReplan);

      // ✅ Asegura días con contenido mínimo
      ensureDays(city);
      for(let d=1; d<=dest.days; d++){
        if(!(itineraries[city].byDay?.[d]||[]).length){
          await optimizeDay(city,d);
        }
      }

      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);

      if(forceReplan && plannerState?.forceReplan) delete plannerState.forceReplan[city];
      if(plannerState?.preferences){
        delete plannerState.preferences.preferDayTrip;
        delete plannerState.preferences.preferAurora;
      }
      $resetBtn?.removeAttribute('disabled');
      return;
    }

    // Fallback visual si el API no trajo JSON válido
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    $resetBtn?.removeAttribute('disabled');
    chatMsg('⚠️ Fallback local: sin respuesta JSON válida del API.','ai');

  } catch(err){
    console.error(`[ERROR] generateCityItinerary(${city})`, err);
    chatMsg(`⚠️ No se pudo generar el itinerario para <strong>${city}</strong>.`, 'ai');
  } finally {
    delete window.__cityLocks[city];
  }
}

/* ==============================
   SECCIÓN 15.3 · Rebalanceo global por ciudad
   v69 (base) + FIX: deduplicación robusta sin bloquear comidas/traslados
   + Fallback de generación por día si el agente no retorna filas útiles
================================= */

/* ——— Utilitarios LOCALES (scope de la sección) ——— */

/** Normaliza texto: minúsculas, sin tildes, sin símbolos, colapsa espacios. */
function __canonTxt__(s){
  return String(s||'')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\p{L}\p{N}\s]/gu,' ')
    .replace(/\s+/g,' ')
    .trim();
}

/** Detecta actividades genéricas que NO deben bloquearse al extender días. */
function __isGenericActivity__(name){
  const t = __canonTxt__(name);
  // comidas, descansos, traslados, compras sin lugar concreto
  const generic = [
    'desayuno','almuerzo','comida','merienda','cena',
    'descanso','relax','tiempo libre','libre',
    'traslado','transfer','check in','check-in','check out','check-out',
    'shopping','compras'
  ];
  // si solo contiene una de estas palabras o patrones muy genéricos
  if (generic.some(g => t === g || t.startsWith(g+' ') || (' '+t+' ').includes(' '+g+' '))) return true;
  // si es extremadamente corto y sin entidad clara
  if (t.split(' ').length <= 2 && /^(almuerzo|cena|desayuno|traslado|descanso)$/i.test(t)) return true;
  return false;
}

/** Quita algunas palabras poco discriminantes (sin romper nombres propios). */
function __stripStopWords__(s){
  const STOP = [
    'the','la','el','los','las','de','del','da','do','dos','das','di','du',
    'a','al','en','of','and','y','e'
  ];
  const toks = s.split(' ').filter(w=>w && !STOP.includes(w));
  return toks.join(' ').trim() || s;
}

/** Alias frecuentes (multi-idioma) para POIs de Barcelona y genéricos de ciudad. */
function __aliasKey__(base){
  const ALIAS = [
    // Barcelona frecuentes
    ['park guell','parc guell','parque guell','parque güell','park güell','güell park','guell park','guell'],
    ['sagrada familia','basilica sagrada familia','templo expiatorio de la sagrada familia','templo de la sagrada familia'],
    ['casa batllo','casa batlló','batllo','batlló'],
    ['la rambla','las ramblas','rambla'],
    ['barceloneta','playa de la barceloneta'],
    ['gothic quarter','barrio gotico','barrio gótico','gothic','gotico','gótico'],
    ['ciutadella','parc de la ciutadella','parque de la ciutadella','ciutadella park'],
    ['born','el borne','el born'],
    // genéricos urbanos frecuentes
    ['old town','ciudad vieja','casco antiguo','centro historico','centro histórico'],
  ];
  for(const group of ALIAS){
    const norm = group.map(__canonTxt__);
    if(norm.some(a=>base.includes(a))) return norm[0];
  }
  return base;
}

/** Genera clave canónica para deduplicar POIs (omite genéricos). */
function __placeKey__(name){
  const raw = String(name||'').trim();
  if(!raw) return '';
  if(__isGenericActivity__(raw)) return ''; // <- no bloquea genéricos
  const base = __stripStopWords__(__canonTxt__(raw));
  return __aliasKey__(base);
}

/** Construye Set de claves previas (días < start) para exclusión de POIs. */
function __buildPrevActivityKeySet__(byDay, start){
  const keys = new Set();
  const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  for(const d of days){
    if(d >= start) break;
    for(const r of (byDay[d]||[])){
      const k = __placeKey__(r.activity||'');
      if(k) keys.add(k);
    }
  }
  return keys;
}

/** Lista acotada para mostrar al agente como referencia. */
function __keysToExampleList__(keys, limit=80){
  return Array.from(keys).slice(0, limit);
}

/* ——— Rebalanceo por rango (manteniendo v69) ——— */
async function rebalanceWholeCity(city, rangeOpt = {}){
  if(!city || !itineraries[city]) return;

  const data     = itineraries[city];
  const baseDate = data.baseDate || cityMeta[city]?.baseDate || '';
  const byDay    = data.byDay || {};
  const allDays  = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  if(!allDays.length) return;

  // v69: rango explícito o completo
  const start = Math.max(1, parseInt(rangeOpt.start||1,10));
  const end   = Math.max(start, parseInt(rangeOpt.end||allDays[allDays.length-1],10));

  // Conjunto de POIs ya cubiertos en n−1 días (NO comidas/traslados)
  const prevKeySet = __buildPrevActivityKeySet__(byDay, start);

  // Histórico opcional del planner (si existe)
  try{
    const extra = plannerState?.existingActs?.[city];
    if(Array.isArray(extra)){
      for(const name of extra){
        const k = __placeKey__(name);
        if(k) prevKeySet.add(k);
      }
    }
  }catch(_){}

  const prevExamples = __keysToExampleList__(prevKeySet);

  showWOW(true, `Reequilibrando ${city}…`);

  const prompt = `
${FORMAT}
Ciudad: ${city}
Rango de reequilibrio: Días ${start}–${end}
Fecha base (Día 1): ${baseDate || 'N/A'}

Objetivo:
• Mantener intactos los días 1–${start-1}.
• Reoptimizar el itinerario desde el día ${start} hasta el ${end}.

Reglas duras:
1) No repitas POIs ya cubiertos en días 1–${start-1} aunque cambien idioma/nombre.
   Lista de exclusión (normalizada): ${JSON.stringify(prevExamples)}
   ⚠️ Las actividades genéricas (comidas/traslados/descansos) SÍ se pueden repetir en distintos lugares.
2) Evita duplicados dentro del mismo día.
3) Balance energético: si el día ${start-1} fue intenso, el ${start} debe ser más liviano y/o iniciar más tarde.
4) Mantén coherencia geográfica/temática y huecos razonables.
5) Devuelve formato C {"rows":[...],"replace":false} o D {"itinerary":{"${city}":{...}}}.
`.trim();

  const ans = await callAgent(prompt, true, { cityName: city, baseDate });
  const parsed = parseJSON(ans);

  let appliedRows = 0;

  if(parsed && parsed.itinerary && parsed.itinerary[city]){
    // Mantiene el merge v69 existente
    mergeItinerary(city, parsed.itinerary[city], { start, end });
    // Contamos filas nuevas (si el merge expone byDay)
    try{
      const seg = parsed.itinerary[city].byDay || {};
      appliedRows = Object.values(seg).flat().length;
    }catch(_){}
  } else if(parsed && parsed.rows){
    const merged = { ...(data.byDay || {}) };
    const newRows = parsed.rows.map(r=>normalizeRow(r));

    // filtro local anti-duplicados dentro del rango y contra prevKeySet
    const byDayLocal = {};
    for(const r of newRows){
      if(!r || !r.day) continue;
      const key = __placeKey__(r.activity||'');
      // si es genérico, no bloquea por prevKeySet; igual prevenimos duplicado intra-día por texto
      const dedupeKey = key || __canonTxt__(r.activity||'');
      byDayLocal[r.day] = byDayLocal[r.day] || new Set();
      if(byDayLocal[r.day].has(dedupeKey)) continue;
      if(key && prevKeySet.has(key)) continue; // excluye solo POIs reales ya vistos
      byDayLocal[r.day].add(dedupeKey);

      // limpia posibles placeholders generados previamente
      merged[r.day] = (merged[r.day]||[]).filter(x=> !(x && x.__generated__ && x.day===r.day));
      merged[r.day] = [...(merged[r.day]||[]), {...r, __generated__: true}];
      appliedRows++;
    }

    // orden horario por día (mantiene v69)
    Object.keys(merged).forEach(d=>{
      merged[d] = (merged[d]||[]).map(normalizeRow)
        .sort((a,b)=>(a.start||'')<(b.start||'')?-1:1);
    });

    itineraries[city].byDay = merged;
  }

  // ✅ Fallback seguro: si no se aplicó nada, generamos por día con 18.optimizeDay
  if(!appliedRows){
    try{
      for(let d=start; d<=end; d++){
        // evita borrar lo previo; optimizeDay respeta anti-duplicados multi-día
        // y reequilibra con reglas v66 (balance, buffers, clima/auroras)
        /* eslint-disable no-await-in-loop */
        await optimizeDay(city, d);
      }
    }catch(_){}
  }

  // Render y UI (v69 intacto)
  renderCityTabs();
  setActiveCity(city);
  renderCityItinerary(city);
  showWOW(false);
}

/* ==============================
   SECCIÓN 16 · Inicio (hotel/transport)
   v60 base + overlay bloqueado global hasta terminar todas las ciudades
   (concurrencia controlada vía runWithConcurrency)
   + Mejora: resolutor inteligente de hotel/zona y banderas globales de cena/vespertino/auroras
================================= */
async function startPlanning(){
  if(savedDestinations.length===0) return;
  $chatBox.style.display='flex';
  planningStarted = true;
  collectingHotels = true;
  session = [];
  metaProgressIndex = 0;

  // 🛠️ Preferencias globales (consumidas por el optimizador/AI):
  // - Cena visible en la franja correcta, aunque no haya “actividad especial”
  // - Ventana vespertina flexible (no anclar rígido 08:30–19:00 si el contexto lo amerita)
  // - Sugerencias icónicas con frecuencia moderada (similares a auroras)
  if(!plannerState.preferences) plannerState.preferences = {};
  plannerState.preferences.alwaysIncludeDinner = true;
  plannerState.preferences.flexibleEvening     = true;
  plannerState.preferences.iconicHintsModerate = true;

  // 1) Saludo inicial
  chatMsg(`${tone.hi}`);

  // 2) Tip del Info Chat (se muestra una sola vez al iniciar)
  //    Queda inmediatamente DEBAJO del saludo, antes de pedir el primer hotel/transporte.
  chatMsg(`${tone.infoTip}`, 'ai');

  // 3) Comienza flujo de solicitud de hotel/zona y transporte
  askNextHotelTransport();
}

/* ====== Resolutor inteligente de Hotel/Zona (fuzzy & alias) ====== */
const hotelResolverCache = {}; // cache por ciudad
function _normTxt(s){
  return String(s||'')
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
}
function _tokenSet(str){
  return new Set(_normTxt(str).split(' ').filter(Boolean));
}
function _jaccard(a,b){
  const A=_tokenSet(a), B=_tokenSet(b);
  const inter = [...A].filter(x=>B.has(x)).length;
  const uni   = new Set([...A,...B]).size || 1;
  return inter/uni;
}
function _levRatio(a,b){
  // usa levenshteinDistance disponible en la Sección 17
  const A=_normTxt(a), B=_normTxt(b);
  const maxlen = Math.max(A.length,B.length) || 1;
  return (maxlen - levenshteinDistance(A,B))/maxlen;
}

// Pre-carga alias por ciudad: nombres populares, barrios, POIs cercanos, etc.
function preloadHotelAliases(city){
  if(!city) return;
  if(!plannerState.hotelAliases) plannerState.hotelAliases = {};
  if(plannerState.hotelAliases[city]) return;

  const base = [city];
  const extras = [
    'centro','downtown','old town','historic center','main square','cathedral',
    'harbor','port','university','station','bus terminal','train station'
  ];

  // si existen referencias del usuario en cityMeta (últimos hoteles elegidos), úsalas
  const prev = (cityMeta[city]?.hotel ? [cityMeta[city].hotel] : []);
  plannerState.hotelAliases[city] = [...new Set([...base, ...extras, ...prev])];
}

function resolveHotelInput(userText, city){
  const raw = String(userText||'').trim();
  if(!raw) return {text:'', confidence:0};

  // 1) Atajos: links → conf alta
  if(/^https?:\/\//i.test(raw)){
    return { text: raw, confidence: 0.98, resolvedVia: 'url' };
  }

  // 2) Si el usuario da “zona/landmark”, intenta casar con alias y POIs ya vistos
  const candidates = new Set();

  // Aliases precargados
  (plannerState.hotelAliases?.[city] || []).forEach(x=>candidates.add(x));

  // Heurística: añade nombres de sitios del itinerario actual (si existe)
  const byDay = itineraries?.[city]?.byDay || {};
  Object.values(byDay).flat().forEach(r=>{
    if(r?.activity) candidates.add(r.activity);
    if(r?.to)       candidates.add(r.to);
    if(r?.from)     candidates.add(r.from);
  });

  // Hotel previo del usuario si existía
  if(cityMeta?.[city]?.hotel) candidates.add(cityMeta[city].hotel);

  // 3) Puntuar por mezcla: Jaccard de tokens + Levenshtein ratio
  let best = { text: raw, confidence: 0.50, resolvedVia: 'raw' };
  const list = [...candidates].filter(Boolean);
  for(const c of list){
    const j = _jaccard(raw, c);
    const l = _levRatio(raw, c);
    // mezcla: 60% Jaccard + 40% Levenshtein ratio
    const score = 0.6*j + 0.4*l;
    if(score > (best.score||0)){
      best = { text: c, confidence: Math.max(0.55, Math.min(0.99, score)), resolvedVia: 'alias', score };
    }
  }

  // 4) Cache y retorno
  hotelResolverCache[city] = hotelResolverCache[city] || {};
  hotelResolverCache[city][raw] = best;
  return best;
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

  // 🔎 Pre-carga de alias/POIs para ayudar al usuario a escribir “a su manera”
  preloadHotelAliases(city);

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
   SECCIÓN 17 · NLU robusta + Intents
   v60 base + mejoras v64
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

// Normaliza tokens de hora (e.g., “tres y media / cuarto”, “mediodía”, “11 pm”)
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

// Heurística: ciudad por país mencionado (sin mapas fijos; usa tus destinos guardados)
function detectCityFromCountryInText(text){
  const raw = String(text||'');
  const lowered = raw.toLowerCase();

  // helper unicode (coincide con uso global del planner)
  const norm = (s)=> String(s||'')
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .toLowerCase().trim();

  const loweredNorm = norm(lowered);

  // Busca en savedDestinations por coincidencia con su "country" (si existe)
  for(const d of (savedDestinations||[])){
    const ctry = norm(d.country || '');
    if(ctry && loweredNorm.includes(ctry)){
      return d.city || null;
    }
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

  // “Un día más”
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

  // Intercambiar días
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

  // Sustituir/eliminar actividad
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

  // Ajuste de perfil / preferencias
  if(/\b(ritmo|relax|tranquilo|aventura|rápido|balanceado|niños|movilidad|caminar poco|transporte|uber|metro|tren|bus|autob[uú]s|veh[ií]culo|coche|auto|dieta|vegetariano|vegano|gluten|cel[ií]aco|preferencia|preferencias)\b/.test(t)){
    return { type:'set_profile', details: text };
  }

  // Preguntas informativas
  if(/\b(clima|tiempo|temperatura|lluvia|horas de luz|moneda|cambio|propina|seguridad|visado|visa|fronteras|aduana|vuelos|aerol[ií]neas|equipaje|salud|vacunas|enchufes|taxis|alquiler|conducci[oó]n|peatonal|festivos|temporada|mejor época|gastronom[ií]a|restaurantes|precios|presupuesto|wifi|sim|roaming)\b/.test(t)){
    return { type:'info_query', details: text };
  }

  // Fallback: edición libre
  return { type:'free_edit', details: text };
}

/* ==============================
   SECCIÓN 18 · Edición/Manipulación + Optimización + Validación
   Base v73 — Ajuste flexible FINAL (quirúrgico)
   Cambios clave (PATCH 42.4-INFO/PLANNER):
   • Doble etapa vía API:
       (1) mode:"info"  → investigación, imperdibles, macro-tours (≤8 sub-paradas),
           tiempos REALES entre puntos y **tiempos de regreso** (hotel/ciudad).
       (2) mode:"planner" → estructuración en filas (rows) sin inventar datos.
   • Respeto estricto de preferencias/condiciones del usuario (prioridad máxima).
   • Se eliminan **patrones locales** de “fuera de ciudad” (global sin listas por país).
   • Se conserva validación + pushRows y utilitarios previos (buffers/overlaps, etc.)
================================= */

/* --- aliasKey para deduplicado por sinónimos comunes --- */
function aliasKey(s){
  const x = normKey(s);
  if(/\bmontju(i|ï|ic)\b/.test(x)) return 'montjuic';
  if(/\bsagrada\s*fam(ilia)?\b/.test(x)) return 'sagrada_familia';
  if(/\bpark?\s*gu(e|ë|é)ll\b/.test(x)) return 'park_guell';
  if(/\bcasa\s*batllo\b/.test(x)) return 'casa_batllo';
  if(/\bla\s*pedrera|casa\s*mila\b/.test(x)) return 'la_pedrera';
  if(/\bboqueria\b/.test(x)) return 'boqueria';
  if(/\bbarceloneta\b/.test(x)) return 'barceloneta';
  if(/\bpicasso\b/.test(x)) return 'museo_picasso';
  if(/\bpaseo\s*de\s*gracia\b/.test(x)) return 'paseo_de_gracia';
  return x;
}

/* --- Normalizador mínimo de ciudad para auroras (compatibilidad) --- */
function normalizeCityForGeo(name){
  const raw = String(name||'').trim();
  const low = raw.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
  if(/\breikj?avik\b|\breikiavik\b|\breykiavik\b|\breykjavik\b/.test(low)) return 'Reykjavik';
  if(/\btroms[oø]\b|\btromso\b/.test(low)) return 'Tromsø';
  return raw;
}

/* === Utilidades auroras (tope no-consecutivo) — mantenidas por compatibilidad === */
function countAuroraNights(city){
  const byDay = itineraries[city]?.byDay || {};
  let c=0;
  for(const d of Object.keys(byDay)){
    const rows = byDay[d]||[];
    if(rows.some(r=>/\baurora\b|\bnorthern\s+lights?\b/i.test(String(r.activity||'')))) c++;
  }
  return c;
}
function suggestedAuroraCap(stayDays){
  if(stayDays>=5) return 2;
  if(stayDays>=3) return 1;
  return 1;
}
function isConsecutiveAurora(city, day){
  const byDay = itineraries[city]?.byDay||{};
  const prev = byDay[day-1]||[];
  const next = byDay[day+1]||[];
  const hasPrev = prev.some(r=>/\baurora\b|\bnorthern\s+lights?\b/i.test(String(r.activity||'')));
  const hasNext = next.some(r=>/\baurora\b|\bnorthern\s+lights?\b/i.test(String(r.activity||'')));
  return hasPrev || hasNext;
}
function enforceAuroraCapForDay(city, day, rows, cap){
  const already = countAuroraNights(city);
  const willAdd = rows.some(r=>/\baurora\b|\bnorthern\s+lights?\b/i.test(String(r.activity||'')));
  if(!willAdd) return rows;
  if(isConsecutiveAurora(city, day)) {
    return rows.filter(r=>!/\baurora\b|\bnorthern\s+lights?\b/i.test(String(r.activity||'')));
  }
  if(already >= cap){
    return rows.filter(r=>!/\baurora\b|\bnorthern\s+lights?\b/i.test(String(r.activity||'')));
  }
  return rows;
}

/* === Helpers Sección 18 (quirúrgicos) === */

// Determina si una fila es naturalmente nocturna (apto para cruce de día)
function __isNightRow__(row){
  const name = String(row.activity||'').toLowerCase();
  const start = String(row.start||'');
  const nightKW = /\baurora\b|\bnorthern\s+lights?\b|\bnight\b|\bnocturn/i;
  const isAurora = nightKW.test(name);
  const hh = /^(\d{1,2}):(\d{2})$/.exec(start);
  const startM = hh ? (+hh[1])*60 + (+hh[2]) : null;
  return isAurora || (startM!=null && startM >= 18*60);
}

// Normaliza ventana de auroras (si viniera incompleta)
function normalizeAuroraWindow(row){
  const isAurora = /\baurora\b|\bnorthern\s+lights?\b/i.test(String(row.activity||''));
  if(!isAurora) return row;

  const toMin = t => { const m = String(t||"").match(/^(\d{1,2}):(\d{2})$/); if(!m) return null; return parseInt(m[1],10)*60 + parseInt(m[2],10); };
  const toHH = m => `${String(Math.floor((m%1440)/60)).padStart(2,'0')}:${String((m%1440)%60).padStart(2,'0')}`;

  let s = toMin(row.start||"20:30");
  let e = toMin(row.end||"02:00");
  if(s==null) s = 20*60+30;
  if(e==null) e = 2*60;

  if(s < 18*60) s = 18*60;
  if(e <= s) e += 24*60;
  if((e - s) < 4*60) e = s + 4*60;
  if(e < (24*60 + 30)) e = Math.max(e, 24*60 + 30);

  const durMin = e - s;
  const durLbl = durMin >= 60
    ? `${Math.floor(durMin/60)}h${(durMin%60? ' '+(durMin%60)+'m' : '')}`
    : `${durMin}m`;

  const cross = e >= 24*60;
  return { ...row, start: toHH(s), end: toHH(e), duration: durLbl, _crossDay: !!cross };
}

// Corrige solapes y aplica buffers mínimos (aceptando cruce post-medianoche)
function fixOverlaps(rows){
  const toMin = t => { const m = String(t||'').match(/^(\d{1,2}):(\d{2})$/); if(!m) return null; return parseInt(m[1],10)*60 + parseInt(m[2]) };
  const toHH  = m => `${String(Math.floor((m%1440)/60)).padStart(2,'0')}:${String((m%1440)%60).padStart(2,'0')}`;
  const durMin = d => {
    if(!d) return 0;
    const m = String(d).match(/(\d+)\s*h(?:\s*(\d+)\s*m)?/i);
    if(m) return parseInt(m[1],10)*60 + (m[2]?parseInt(m[2],10):0);
    const m2 = String(d).match(/(\d+)\s*m/i);
    if(m2) return parseInt(m2[1],10);
    return 0;
  };

  const expanded = rows.map(r=>{
    let s = toMin(r.start||"");
    let e = toMin(r.end||"");
    const d = durMin(r.duration||"");
    let cross = false;

    if(s!=null && (e==null || e<=s)){
      if(__isNightRow__(r) || (d>0 && s>=18*60)){
        e = (e!=null ? e : s + Math.max(d,60)) + 24*60;
        cross = true;
      }else{
        e = e!=null ? (e <= s ? s + Math.max(d,60) : e) : s + Math.max(d,60);
      }
    }else if(s==null && e!=null && d>0){
      s = e - d;
      if(s<0) s = 9*60;
    }else if(s==null && e==null){
      s = 9*60; e = s + 60;
    }

    return { __s:s, __e:e, __d:d, __cross:cross, raw:r };
  });

  expanded.sort((a,b)=> (a.__s||0) - (b.__s||0));

  const out = [];
  let prevEnd = null;
  for(const item of expanded){
    let { __s:s, __e:e, __d:d, __cross:cross, raw:r } = item;

    if(prevEnd!=null && s < prevEnd + 15){
      const shift = (prevEnd + 15) - s;
      s += shift; e += shift;
    }
    prevEnd = Math.max(prevEnd ?? 0, e);

    const finalDur = d>0 ? r.duration : `${Math.max(60, e - s)}m`;

    out.push({
      ...r,
      start: toHH(s),
      end: toHH(e),
      duration: finalDur,
      _crossDay: (r._crossDay || cross || e >= 24*60) ? true : false
    });
  }

  return out;
}

/* ---------------------------
   PATCH A.1 — Unificador formato
---------------------------- */
function unifyRowsFormat(parsed, preferCity){
  if(!parsed) return { rows: [] };
  if(Array.isArray(parsed.rows)) return { rows: parsed.rows };
  if(Array.isArray(parsed.destinations)){
    if(preferCity){
      const dd = parsed.destinations.find(d=> (d.name||d.destination)===preferCity);
      if(dd && Array.isArray(dd.rows)) return { rows: dd.rows };
    }
    const first = parsed.destinations.find(d=>Array.isArray(d.rows));
    if(first) return { rows: first.rows };
  }
  if(parsed.destination && Array.isArray(parsed.rows)) return { rows: parsed.rows };
  if(Array.isArray(parsed.itineraries)){
    const ii = preferCity
      ? parsed.itineraries.find(x=> (x.city||x.name||x.destination)===preferCity)
      : parsed.itineraries[0];
    if(ii && Array.isArray(ii.rows)) return { rows: ii.rows };
  }
  return { rows: [] };
}

/* ---------------------------
   Transporte/“fuera de ciudad” — GLOBAL (sin listas locales)
   - No sobrescribe si ya viene transport del research/planner.
   - Considera "fuera de ciudad" cuando el destino 'to' NO contiene el nombre de la ciudad (case-insensitive) y no está vacío.
---------------------------- */
function isOutOfTownRow(city, row){
  const cityLow = String(city||'').toLowerCase();
  const to = String(row.to||'').toLowerCase();
  if(!to) return false;
  return !to.includes(cityLow);
}
function enforceTransportAndOutOfTown(city, rows){
  return rows.map(r=>{
    if(r && r.transport) return r; // respetar research/planner
    const out = isOutOfTownRow(city, r);
    if(out){
      return { ...r, transport: 'Vehículo alquilado o Tour guiado' };
    }
    return r;
  });
}

/* ---------------------------
   Helpers mínimos para tiempos (usados por overlaps)
---------------------------- */
function __toMinHHMM__(t){
  const m = String(t||'').match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return null;
  return parseInt(m[1],10)*60 + parseInt(m[2],10);
}
function __toHHMMfromMin__(m){
  const mm = ((m%1440)+1440)%1440;
  const h = Math.floor(mm/60), mi = mm%60;
  return `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`;
}
function __addMinutesSafe__(hhmm, add){
  if(typeof addMinutes === 'function') return addMinutes(hhmm, add);
  const s = __toMinHHMM__(hhmm)||540; // 09:00 fallback
  return __toHHMMfromMin__(s + (add||0));
}

/* ---------------------------
   (DEPRECATED) Retornos locales — se mantienen por compatibilidad pero NO se usan ya.
---------------------------- */
function ensureReturnToCity(city, day, rows){ return rows; }
function ensureEndReturnToHotel(rows){ return rows; }

/* ---------------------------
   NEW: Recolector de contexto completo para INFO
---------------------------- */
function __collectPlannerContext__(city, day){
  const byDay = itineraries[city]?.byDay || {};
  const totalDays = Object.keys(byDay).length || 0;
  const meta = cityMeta[city] || {};
  const perDay = (meta.perDay||[]).map(x=>({ day:x.day, start:x.start||DEFAULT_START, end:x.end||DEFAULT_END }));
  const currentRows = (byDay[day]||[]).map(r=>({
    day, start:r.start||'', end:r.end||'', activity:r.activity||'',
    from:r.from||'', to:r.to||'', transport:r.transport||'',
    duration:r.duration||'', notes:r.notes||''
  }));

  return {
    city,
    country: meta.country || '',
    base_date: meta.baseDate || '',
    days_total: totalDays,
    hotel_address: meta.hotel || '',
    transport_preferred: meta.transport || (plannerState?.preferences?.transport || ''),
    windows: perDay,
    current_day: day,
    current_rows: currentRows,
    travelers: plannerState?.travelers || {},
    pace: plannerState?.pace || '',
    budget: plannerState?.budget || '',
    preferences: { ...(plannerState?.preferences||{}) },
    special_conditions: { ...(plannerState?.conditions||{}) },
    all_cities: (savedDestinations||[]).map(c=>({ city:c.city, days:c.days, baseDate:c.baseDate })),
    rules: {
      max_substops_per_tour: 8,
      optimize_order_by_distance_and_time: true,
      respect_user_preferences_and_conditions: true,
      avoid_duplicates_across_days: true
    }
  };
}

/* ================= MAIN: optimizeDay (nuevo flujo INFO → PLANNER) ================= */
async function optimizeDay(city, day){
  const data = itineraries[city];
  const baseDate = data?.baseDate || cityMeta[city]?.baseDate || '';

  // Filas "protegidas"
  const rows = (data?.byDay?.[day]||[]).map(r=>({
    day,start:r.start||'',end:r.end||'',activity:r.activity||'',
    from:r.from||'',to:r.to||'',transport:r.transport||'',
    duration:r.duration||'',notes:r.notes||'', _crossDay: !!r._crossDay
  }));
  const protectedRows = rows.filter(r=>{
    const act=(r.activity||'').toLowerCase();
    return act.includes('laguna azul')||act.includes('blue lagoon');
  });

  try{
    // 1) INFO
    const context = __collectPlannerContext__(city, day);
    const infoResp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode:'info', context })
    });
    const infoData = await infoResp.json();
    const research = cleanToJSONPlus(infoData?.text || infoData);

    // 2) PLANNER
    const plannerResp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode:'planner', research_json: research })
    });
    const plannerData = await plannerResp.json();
    const structured = cleanToJSONPlus(plannerData?.text || plannerData) || {};

    // Unificar y normalizar
    const unified = unifyRowsFormat(structured, city);
    let finalRows = (unified?.rows||[]).map(x=>normalizeRow({ ...x, day: (x.day||day) }));

    if(typeof applyBufferBetweenRows==='function') finalRows = applyBufferBetweenRows(finalRows);
    if(typeof reorderLinearVisits==='function')    finalRows = reorderLinearVisits(finalRows);

    // Respetar auroras del research/planner
    finalRows = finalRows.map(normalizeAuroraWindow);

    // Transporte: sólo rellenamos si vinieron vacíos
    finalRows = enforceTransportAndOutOfTown(city, finalRows);

    // Anti-solapes y cruce post-medianoche
    finalRows = fixOverlaps(finalRows);

    // Reincorporar protegidas
    if(protectedRows.length){
      finalRows = [...finalRows, ...protectedRows];
      finalRows = fixOverlaps(finalRows);
    }

    // Validación final y volcado
    const val=await validateRowsWithAgent(city, finalRows, baseDate);
    pushRows(city, val.allowed, false);

  }catch(e){
    console.error('optimizeDay INFO→PLANNER error:', e);
    const val=await validateRowsWithAgent(city, rows, baseDate);
    pushRows(city, val.allowed, false);
  }
}

/* ==============================
   SECCIÓN 19 · Chat handler (global)
   v71.fix — Extensión de días estable + integración INFO→PLANNER
   - Mantiene flujos existentes (add/swap/move/etc.)
   - Rebalanceos y optimizaciones llaman a optimizeDay (que ya usa INFO→PLANNER)
   - Respeta y registra preferencias/condiciones del usuario
================================= */
async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  // Colecta hotel/transporte
  if(collectingHotels){
    const city = savedDestinations[metaProgressIndex].city;

    // Resolver inteligentemente el hotel/zona (tolera typos, idiomas, landmarks)
    const res = resolveHotelInput(text, city);
    const resolvedHotel = res.text || text;

    // Detección de transporte (conserva tu lógica original)
    const transport = (/recom/i.test(text)) ? 'recomiéndame'
      : (/alquilad|rent|veh[ií]culo|coche|auto|carro/i.test(text)) ? 'vehículo alquilado'
      : (/metro|tren|bus|autob[uú]s|p[uú]blico/i.test(text)) ? 'transporte público'
      : (/uber|taxi|cabify|lyft/i.test(text)) ? 'otros (Uber/Taxi)'
      : '';

    upsertCityMeta({ city, hotel: resolvedHotel, transport });

    // Feedback al usuario según confianza del match
    if(res.resolvedVia==='url' || (res.confidence||0) >= 0.80){
      chatMsg(`🏨 Tomé <strong>${resolvedHotel}</strong> como tu referencia de hotel/zona en <strong>${city}</strong>.`, 'ai');
    }else if((res.confidence||0) >= 0.65){
      chatMsg(`🏨 Usaré <strong>${resolvedHotel}</strong> como referencia en <strong>${city}</strong> (interpretado por similitud). Si deseas otro, escríbelo con más detalle o pega el link.`, 'ai');
    }else{
      chatMsg(`🏨 Registré tu referencia para <strong>${city}</strong>. Si tienes el <em>link</em> del lugar exacto o el nombre preciso, compártelo para afinar distancias.`, 'ai');
    }

    // Activar preferAurora automáticamente si la ciudad es apta
    try{
      const canon = (typeof normalizeCityForGeo==='function') ? normalizeCityForGeo(city) : city;
      const coords = (typeof getCoordinatesForCity==='function') ? (getCoordinatesForCity(canon) || getCoordinatesForCity(city)) : null;
      const auroraCity = coords && (typeof isAuroraCityDynamic==='function') ? isAuroraCityDynamic(coords.lat, coords.lng) : false;

      if(!coords){
        const low = String(canon||city||'').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
        if(/\breikj?avik\b|\breikiavik\b|\breykiavik\b|\breykjavik\b/.test(low)) { if(!plannerState.preferences) plannerState.preferences={}; plannerState.preferences.preferAurora = true; }
        if(/\btroms[oø]\b|\btromso\b/.test(low)) { if(!plannerState.preferences) plannerState.preferences={}; plannerState.preferences.preferAurora = true; }
      }else if(auroraCity){
        if(!plannerState.preferences) plannerState.preferences = {};
        plannerState.preferences.preferAurora = true;
      }
    }catch(_){ /* no-op */ }

    metaProgressIndex++;
    askNextHotelTransport();
    return;
  }

  // Cambio de hotel
  const hotelChangeMatch = text.match(/^(?:hotel|zona|direcci[oó]n):?\s*(.+)$/i);
  if(hotelChangeMatch && activeCity){
    const newHotelRaw = hotelChangeMatch[1].trim();
    const city = activeCity;

    // Resolver también en cambios de hotel
    const res = resolveHotelInput(newHotelRaw, city);
    const newHotel = res.text || newHotelRaw;

    if(!cityMeta[city]) cityMeta[city] = { baseDate:null, hotel:'', transport:'', perDay:[] };
    const prevHotel = cityMeta[city].hotel || '';
    if(newHotel && newHotel !== prevHotel){
      cityMeta[city].hotel = newHotel;

      if(res.resolvedVia==='url' || (res.confidence||0) >= 0.80){
        chatMsg(`🏨 Actualicé el hotel/zona de <strong>${city}</strong> a <strong>${newHotel}</strong>. Reajustando itinerario…`, 'ai');
      }else if((res.confidence||0) >= 0.65){
        chatMsg(`🏨 Apliqué <strong>${newHotel}</strong> como nueva referencia en <strong>${city}</strong> (interpretado por similitud). Reajustando itinerario…`, 'ai');
      }else{
        chatMsg(`🏨 Actualicé tu referencia en <strong>${city}</strong>. Si tienes el link exacto, compártelo. Reajustando itinerario…`, 'ai');
      }

      showWOW(true,'Reequilibrando tras cambio de hotel…');
      await rebalanceWholeCity(city);
      showWOW(false);
      chatMsg('✅ Itinerario reequilibrado tras el cambio de hotel.','ai');
    } else {
      chatMsg('ℹ️ El hotel ya estaba configurado con esa información.','ai');
    }
    return;
  }

  const intent = intentFromText(text);

  // Day trip preferencia libre
  if(intent.type === 'free_edit' && /\b(tour de un d[ií]a|excursi[oó]n de un d[ií]a|viaje de un d[ií]a|escapada|salida de un d[ií]a)\b/i.test(text)){
    const city = activeCity || savedDestinations[0]?.city;
    if(city){
      if(!plannerState.preferences) plannerState.preferences = {};
      plannerState.preferences.preferDayTrip = true;
      chatMsg(`🧭 Consideraré una <strong>excursión de 1 día</strong> cerca de <strong>${city}</strong> si aporta valor.`, 'ai');
      await rebalanceWholeCity(city);
      return;
    }
  }

  // Preferencia de auroras
  if(intent.type === 'prefer_aurora'){
    const city = intent.city || activeCity || savedDestinations[0]?.city;
    if(city){
      if(!plannerState.preferences) plannerState.preferences = {};
      plannerState.preferences.preferAurora = true;
      chatMsg(`🌌 Priorizaré <strong>noches de auroras</strong> en <strong>${city}</strong> cuando sea plausible.`, 'ai');
      await rebalanceWholeCity(city);
      return;
    }
  }

  // Normalizar "un día más"
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

  /* ---------- Agregar varios días N>0 ---------- */
  if(intent.type==='add_days' && intent.city && intent.extraDays>0){
    const city = intent.city;
    showWOW(true,'Agregando días y reoptimizando…');

    ensureDays(city);

    // total ANTES de agregar (último día ORIGINAL)
    const byDayPre  = itineraries[city].byDay || {};
    const prevTotal = Object.keys(byDayPre).length || 0;

    // Marcar explícitamente el "último original" (histórico)
    itineraries[city].lastOriginalDay = prevTotal;

    // Forzar replan en rango y añadir días
    if (!plannerState.forceReplan) plannerState.forceReplan = {};
    plannerState.forceReplan[city] = true;

    addMultipleDaysToCity(city, intent.extraDays);

    // Ventanas seguras para todos los días nuevos
    if (!cityMeta[city]) cityMeta[city] = { perDay: [] };
    cityMeta[city].perDay = cityMeta[city].perDay || [];
    const ensureWindow = (d)=>{
      let pd = cityMeta[city].perDay.find(x=>x.day===d);
      if(!pd){ pd = {day:d, start:DEFAULT_START, end:DEFAULT_END}; cityMeta[city].perDay.push(pd); }
      if(!pd.start) pd.start = DEFAULT_START;
      if(!pd.end)   pd.end   = DEFAULT_END;
    };
    const total = Object.keys(itineraries[city].byDay||{}).length;
    for(let d=prevTotal+1; d<=total; d++) ensureWindow(d);

    // Día suave en el nuevo último día
    if(!plannerState.lightDayTarget) plannerState.lightDayTarget = {};
    plannerState.lightDayTarget[city] = total;

    // Reequilibrar rango completo (usa optimizeDay → INFO→PLANNER)
    await rebalanceWholeCity(city, { start: Math.max(1, prevTotal), end: total, dayTripTo: intent.dayTripTo||'' });

    // Garantía de completitud del último día
    if ((itineraries[city].byDay?.[total]||[]).length < 3) {
      await optimizeDay(city, total);
    }

    showWOW(false);
    chatMsg(`✅ Agregué ${intent.extraDays} día(s) a ${city}. Reoptimicé de D${prevTotal} a D${total} y marqué D${total} como "ligero pero COMPLETO".`, 'ai');
    return;
  }

  /* ---------- Agregar exactamente 1 día al final ---------- */
  if (intent.type === 'add_day_end' && intent.city) {
    const city = intent.city;
    showWOW(true, 'Insertando día y optimizando…');

    ensureDays(city);
    const byDay = itineraries[city].byDay || {};
    const days  = Object.keys(byDay).map(n => +n).sort((a,b)=>a-b);

    // total ANTES de insertar (último día ORIGINAL)
    const prevTotal = days.length || 0;
    itineraries[city].lastOriginalDay = prevTotal;

    // Forzar replan del rango
    if (!plannerState.forceReplan) plannerState.forceReplan = {};
    plannerState.forceReplan[city] = true;

    const numericPos = prevTotal + 1;
    insertDayAt(city, numericPos);

    // Ventanas seguras para {numericPos}
    if (!cityMeta[city]) cityMeta[city] = { perDay: [] };
    cityMeta[city].perDay = cityMeta[city].perDay || [];
    const ensureWindow = (d)=>{
      let pd = cityMeta[city].perDay.find(x=>x.day===d);
      if(!pd){ pd = {day:d, start:DEFAULT_START, end:DEFAULT_END}; cityMeta[city].perDay.push(pd); }
      if(!pd.start) pd.start = DEFAULT_START;
      if(!pd.end)   pd.end   = DEFAULT_END;
    };
    ensureWindow(numericPos);

    // Semilla opcional si el usuario pidió "para ir a X"
    if (intent.dayTripTo) {
      const destTrip  = intent.dayTripTo;
      const baseStart = cityMeta[city]?.perDay?.find(x => x.day === numericPos)?.start || DEFAULT_START;
      pushRows(city, [{
        day: numericPos,
        start: baseStart,
        end: addMinutes(baseStart, 60),
        activity: `Traslado a ${destTrip}`,
        from: `Hotel (${city})`,
        to: destTrip,
        transport: 'Tren/Bus',
        duration: '≈ 1h',
        notes: `Inicio del day trip desde el hotel en ${city} hacia ${destTrip}.`
      }], false);
    }

    const total = Object.keys(itineraries[city].byDay||{}).length;

    // Día suave en el nuevo último día
    if(!plannerState.lightDayTarget) plannerState.lightDayTarget = {};
    plannerState.lightDayTarget[city] = total;

    // Rebalancear desde el último día original hasta el final (optimizeDay nuevo)
    await rebalanceWholeCity(city, { start: Math.max(1, prevTotal), end: total });

    // Garantía de completitud del nuevo día
    if ((itineraries[city].byDay?.[total]||[]).length < 3) {
      await optimizeDay(city, total);
    }

    renderCityTabs();
    setActiveCity(city);
    renderCityItinerary(city);
    showWOW(false);
    chatMsg('✅ Día agregado y plan reoptimizado (primeros días intactos; el nuevo último día queda "ligero pero COMPLETO").', 'ai');
    return;
  }

  // Quitar día
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

  // Intercambiar días
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

  // Mover actividad
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

  // Sustituir/Eliminar actividad
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

  // Cambiar horas
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

  // Agregar ciudad
  if(intent.type==='add_city' && intent.city){
    const name = intent.city.trim().replace(/\s+/g,' ').replace(/^./,c=>c.toUpperCase());
    const days = intent.days || 2;
    addCityRow({city:name, days:'', baseDate:intent.baseDate||''});
    const lastRow = $cityList.lastElementChild;
    const sel = lastRow?.querySelector('.days');
    if(sel){ sel.value = String(days); sel.dispatchEvent(new Event('change')); }
    saveDestinations();
    chatMsg(
      `✅ Añadí <strong>${name}</strong>. Dime tu <strong>hotel/zona</strong> (nombre, zona, dirección o link) y el <strong>medio de transporte</strong> (alquiler, público, taxi/uber, combinado o “recomiéndame”).`,
      'ai'
    );
    return;
  }

  // Eliminar ciudad
  if(intent.type==='remove_city' && intent.city){
    const name = intent.city.trim();
    savedDestinations = savedDestinations.filter(x=>x.city!==name);
    delete itineraries[name];
    delete cityMeta[name];
    renderCityTabs();
    chatMsg(`🗑️ Eliminé <strong>${name}</strong> de tu itinerario.`, 'ai');
    return;
  }

  // Preguntas informativas → usa Info Agent (independiente del plan)
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

  // Edición libre
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
${buildIntakeLite(city)}

**Ciudad a editar:** ${city}
**Día visible:** ${day}
**Actividades del día:**
${dayRows}

**Ventanas por día:** ${JSON.stringify(perDay)}
**Instrucción del usuario (libre):** ${text}

🕒 Horarios:
- Base 08:30–19:00 si no hay ventana.
- Se puede extender por cenas/tours/auroras.
- Evita huecos > 60–75 min sin descanso/almuerzo/traslado.
- Buffers ≥15 min entre actividades.

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

// 🧼 País: permitir letras Unicode y espacios (global)
document.addEventListener('input', (e)=>{
  if(e.target && e.target.classList && e.target.classList.contains('country')){
    const original = e.target.value;
    // Acepta cualquier letra Unicode y espacios (requiere flag 'u')
    const filtered = original.replace(/[^\p{L}\s]/gu,'');
    if(filtered !== original){
      const pos = e.target.selectionStart;
      e.target.value = filtered;
      if(typeof pos === 'number'){
        // ⚡ Ajuste suave del cursor
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
   (mantiene v55.1 + FIX: el botón “Iniciar planificación”
    **sólo** se habilita después de pulsar **Guardar destinos** con datos válidos)
================================= */
$addCity?.addEventListener('click', ()=>addCityRow());

function validateBaseDatesDMY(){
  const rows = qsa('.city-row', $cityList);
  let firstInvalid = null;
  for(const r of rows){
    const el = qs('.baseDate', r);
    const v  = (el?.value||'').trim();
    if(!v || !/^(\d{2})\/(\d{2})\/(\d{4})$/.test(v) || !parseDMY(v)){
      firstInvalid = el;
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

/* ===== Guardar destinos: sólo aquí se evalúa habilitar “Iniciar planificación” ===== */
$save?.addEventListener('click', ()=>{
  // ejecuta lógica propia de guardado
  try { saveDestinations(); } catch(_) {}

  // valida y sólo entonces habilita
  const basicsOK = formHasBasics();
  const datesOK  = validateBaseDatesDMY();
  if (basicsOK && datesOK) {
    hasSavedOnce = true;
    if ($start) $start.disabled = false;
  } else {
    if ($start) $start.disabled = true;
  }
});

/* ===== Reglas para habilitación del botón ===== */
function formHasBasics(){
  const row = qs('.city-row', $cityList);
  if(!row) return false;
  const city  = (qs('.city', row)?.value||'').trim();
  const country = (qs('.country', row)?.value||'').trim();
  const days  = parseInt(qs('.days', row)?.value||'0', 10);
  const base  = (qs('.baseDate', row)?.value||'').trim();
  return !!(city && country && days>0 && /^(\d{2})\/(\d{2})\/(\d{4})$/.test(base));
}

// Ya NO habilitamos al escribir; sólo deshabilitamos si se borran datos
document.addEventListener('input', (e)=>{
  if(!$start) return;
  if(e.target && (
     e.target.classList?.contains('city') ||
     e.target.classList?.contains('country') ||
     e.target.classList?.contains('days') ||
     e.target.classList?.contains('baseDate')
  )){
    // si el usuario rompe el formulario, deshabilita hasta que vuelva a Guardar
    if(!formHasBasics()) $start.disabled = true;
  }
});

/* ===== Recuperación/inyector del botón Reset si no existe ===== */
function ensureResetButton(){
  let btn = document.getElementById('reset-planner');
  if(!btn){
    const bar = document.querySelector('#actions-bar') || document.body;
    btn = document.createElement('button');
    btn.id = 'reset-planner';
    btn.className = 'btn warn';
    btn.textContent = 'Reiniciar planificación';
    btn.setAttribute('type','button');
    (bar || document.body).appendChild(btn);
  }
  return btn;
}

// ⛔ Reset con confirmación modal
function bindReset(){
  const $btn = ensureResetButton();
  $btn.removeAttribute('disabled');

  $btn.addEventListener('click', ()=>{
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
      // Estado principal
      $cityList.innerHTML=''; savedDestinations=[]; itineraries={}; cityMeta={};
      addCityRow();
      if ($start) $start.disabled = true;
      $tabs.innerHTML=''; $itWrap.innerHTML='';
      $chatBox.style.display='none'; $chatM.innerHTML='';
      session = []; hasSavedOnce=false; pendingChange=null;

      // Flags
      planningStarted = false;
      metaProgressIndex = 0;
      collectingHotels = false;
      isItineraryLocked = false;
      activeCity = null;

      try { $overlayWOW && ($overlayWOW.style.display = 'none'); } catch(_) {}
      qsa('.date-tooltip').forEach(t => t.remove());

      const $sc = qs('#special-conditions'); if($sc) $sc.value = '';
      const $ad = qs('#p-adults');   if($ad) $ad.value = '1';
      const $yo = qs('#p-young');    if($yo) $yo.value = '0';
      const $ch = qs('#p-children'); if($ch) $ch.value = '0';
      const $in = qs('#p-infants');  if($in) $in.value = '0';
      const $se = qs('#p-seniors');  if($se) $se.value = '0';
      const $bu = qs('#budget');     if($bu) $bu.value = '';
      const $cu = qs('#currency');   if($cu) $cu.value = 'USD';

      if (typeof plannerState !== 'undefined') {
        plannerState.destinations = [];
        plannerState.specialConditions = '';
        plannerState.travelers = { adults:1, young:0, children:0, infants:0, seniors:0 };
        plannerState.budget = '';
        plannerState.currency = 'USD';
        plannerState.forceReplan = {};
        plannerState.preferences = {};
        plannerState.dayTripPending = {};
        plannerState.existingActs = {};
      }

      overlay.classList.remove('active');
      setTimeout(()=>overlay.remove(), 300);

      if ($sidebar) $sidebar.classList.remove('disabled');
      if ($infoFloating){
        $infoFloating.style.pointerEvents = 'auto';
        $infoFloating.style.opacity = '1';
        $infoFloating.disabled = false;
      }
      if ($resetBtn) $resetBtn.setAttribute('disabled','true');

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
}

// ▶️ Start: valida y ejecuta
$start?.addEventListener('click', ()=>{
  if(!$start) return;
  if(!hasSavedOnce){ // protección extra: exigir paso por “Guardar”
    chatMsg('Primero pulsa “Guardar destinos” para continuar.','ai');
    return;
  }
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
  const upsell = qs('#monetization-upsell');
  if (upsell) upsell.style.display = 'flex';
});
$upsellClose?.addEventListener('click', ()=>{
  const upsell = qs('#monetization-upsell');
  if (upsell) upsell.style.display = 'none';
});

/* 🆕 Listener: Rebalanceo inteligente al agregar días (para integraciones internas) */
document.addEventListener('itbmo:addDays', e=>{
  const { city, extraDays, dayTripTo } = e.detail || {};
  if(!city || !extraDays) return;
  addMultipleDaysToCity(city, extraDays);
  const start = itineraries[city]?.originalDays || 1;
  const end   = (itineraries[city]?.originalDays || 0) + extraDays;
  rebalanceWholeCity(city, { start, end, dayTripTo });
});

/* ====== Info Chat ====== */
function openInfoModal(){ const m=qs('#info-chat-modal'); if(!m) return; m.style.display='flex'; m.classList.add('active'); }
function closeInfoModal(){ const m=qs('#info-chat-modal'); if(!m) return; m.classList.remove('active'); m.style.display='none'; }
async function sendInfoMessage(){
  const input = qs('#info-chat-input'); const btn = qs('#info-chat-send');
  if(!input || !btn) return; const txt = (input.value||'').trim(); if(!txt) return;
  infoChatMsg(txt,'user'); input.value=''; input.style.height='auto';
  const ans = await callInfoAgent(txt); infoChatMsg(ans||'');
}
function bindInfoChatListeners(){
  const toggleTop = qs('#info-chat-toggle');
  const toggleFloating = qs('#info-chat-floating');
  const close  = qs('#info-chat-close');
  const send   = qs('#info-chat-send');
  const input  = qs('#info-chat-input');

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

  i2?.addEventListener('keydown', (e)=>{
    if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendInfoMessage(); }
  });

  if(i2){
    i2.setAttribute('rows','1');
    i2.style.overflowY = 'hidden';
    const maxRows = 10;
    i2.addEventListener('input', ()=>{
      i2.style.height = 'auto';
      const lh = parseFloat(window.getComputedStyle(i2).lineHeight) || 20;
      const lines = Math.min(i2.value.split('\n').length, maxRows);
      i2.style.height = `${lh * lines + 8}px`;
      i2.scrollTop = i2.scrollHeight;
    });
  }

  document.addEventListener('click', (e)=>{
    const el = e.target.closest('#info-chat-toggle, #info-chat-floating');
    if(el){ e.preventDefault(); openInfoModal(); }
  });
}

// Inicialización
document.addEventListener('DOMContentLoaded', ()=>{
  if(!document.querySelector('#city-list .city-row')) addCityRow();
  bindInfoChatListeners();
  bindReset();
  // tras cargar, el botón start queda deshabilitado hasta que el usuario pulse Guardar
  if ($start) $start.disabled = !hasSavedOnce;
});
