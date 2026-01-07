/* =========================================================
   ITRAVELBYMYOWN · PLANNER v79.3
   Base: v78
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

// ✅ QUIRÚRGICO: estos defaults quedan SOLO como fallback interno/legacy,
// pero NO deben forzar ventanas por día cuando el usuario no las definió.
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
   - Si NO definió → devolver null (INFO decide; NO forzar 08:30–19:00).
   - No hereda horarios entre días.
   - Devuelve siempre una lista completa para todos los días.
================================= */
function getEffectivePerDay(city, totalDays){
  const meta = cityMeta[city] || {};
  const perDay = Array.isArray(meta.perDay) ? meta.perDay.slice() : [];

  const norm = (v)=>{
    const s = (v==null ? '' : String(v)).trim();
    return s ? s : null;
  };

  // Mapa por día: solo conserva si hay algo definido
  const map = new Map(
    perDay.map(x=>[
      x.day,
      { start: norm(x.start), end: norm(x.end) }
    ])
  );

  const result = [];
  for(let d=1; d<=totalDays; d++){
    if(map.has(d)){
      const val = map.get(d) || {};
      result.push({ day:d, start: norm(val.start), end: norm(val.end) });
    } else {
      // ✅ NO default: INFO decide
      result.push({ day:d, start: null, end: null });
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

    const normTime = (v)=>{
      const s = (v==null ? '' : String(v)).trim();
      return s ? s : null; // ✅ null = no definido → INFO decide
    };

    const perDay = [];
    qsa('.hours-day', r).forEach((hd, idx)=>{
      const start = normTime(qs('.start',hd).value);
      const end   = normTime(qs('.end',hd).value);
      perDay.push({ day: idx+1, start, end });
    });

    // ✅ Si no hay inputs de horas (o días sin bloque), NO forzar defaults
    if(perDay.length===0){
      for(let d=1; d<=days; d++) perDay.push({day:d, start:null, end:null});
    } else {
      // ✅ Alinear tamaño a days: rellena con nulls si faltan días (no hereda)
      for(let d=perDay.length+1; d<=days; d++){
        perDay.push({day:d, start:null, end:null});
      }
      // ✅ Truncar si sobran
      if(perDay.length > days) perDay.length = days;
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
      // Alinear perDay al número de días (rellenar o truncar) — SIN DEFAULTS
      const aligned = [];
      for(let d=1; d<=days; d++){
        const src = perDay[d-1]
          || cityMeta[city].perDay?.find(x=>x.day===d)
          || { day:d, start:null, end:null };
        aligned.push({ day:d, start: (src.start==null?null:src.start), end: (src.end==null?null:src.end) });
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

  function escapeHTML(s){
    return String(s ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  // ✅ Alineado con API: duration suele venir en 2 líneas:
  // "Transporte: ...\nActividad: ..."
  function formatDurationForDisplay(val){
    if(!val) return '';
    const s = String(val).trim();
    if(!s) return '';

    // Render seguro + respeta saltos de línea del contrato
    const safe = escapeHTML(s).replace(/\n/g, '<br>');
    return safe;
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
        <td>${escapeHTML(r.start||'')}</td>
        <td>${escapeHTML(r.end||'')}</td>
        <td>${escapeHTML(cleanActivity)}</td>
        <td>${escapeHTML(r.from||'')}</td>
        <td>${escapeHTML(r.to||'')}</td>
        <td>${escapeHTML(r.transport||'')}</td>
        <td>${formatDurationForDisplay(r.duration||'')}</td>
        <td>${escapeHTML(cleanNotes)}</td>
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
    perDay: perDayFull,

    // ✅ QUIRÚRGICO (A1): señales explícitas para el agente INFO/PLANNER
    days_total: totalDays,
    allow_ai_schedule: true
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

function resolveChatApiUrl(fallback){
  try{
    const qs = new URLSearchParams(location.search);

    // 1) Prefer absolute explicit param (embed -> iframe qs)
    const abs = (qs.get('chatApiAbs') || qs.get('chatApiABS') || '').trim();
    if(abs) return decodeURIComponent(abs);

    // 2) Build from apiBase + chatApi if present
    const apiBase = (qs.get('apiBase') || '').trim();
    const chatApi = (qs.get('chatApi') || '').trim();
    if(apiBase && chatApi) return apiBase.replace(/\/$/,'') + chatApi;

    // 3) Fallback to same-origin /api/chat if no explicit config
    return fallback || '/api/chat';
  }catch(_){
    return fallback || '/api/chat';
  }
}

async function callAgent(text, useHistory = true, opts = {}){
  // ⏳ Timeout ligeramente más agresivo para mejorar percepción de velocidad
  const { timeoutMs = 45000, cityName = null, baseDate = null } = opts;

  // 🧠 Historial compacto: últimas 6 interacciones para reducir tokens pero mantener contexto
  const history = (() => {
    if(!useHistory || !session?.messages?.length) return [];
    try{
      const msgs = session.messages;
      const tail = msgs.slice(Math.max(0, msgs.length - 12)); // 6 pares aprox
      return tail.map(m => ({ role: m.role, content: m.content }));
    }catch(_){
      return [];
    }
  })();

  // ───────────────── Heurística dinámica global (sin romper si no está) ─────────────────
  let heuristicsContext = '';
  try{
    if(cityName && typeof getHeuristicDayTripContext === 'function'){
      const stayDaysForCity = (() => {
        try{
          // intenta derivar de planner state si existe
          const rows = (typeof qsa === 'function' ? qsa('.city-row') : []);
          if(rows?.length){
            const r = rows.find(rr => {
              const c = rr.querySelector?.('.city')?.value?.trim();
              return c && c.toLowerCase() === String(cityName).toLowerCase();
            }) || rows[0];
            const d = Number(r?.querySelector?.('.days')?.value || 0);
            return d || null;
          }
        }catch(_){}
        return null;
      })();

      const auroraCity   = (typeof isAuroraCityDynamic === 'function') ? !!isAuroraCityDynamic(cityName) : null;
      const auroraSeason = (typeof inAuroraSeasonDynamic === 'function') ? !!inAuroraSeasonDynamic(baseDate) : null;

      const auroraWindow = (typeof AURORA_DEFAULT_WINDOW !== 'undefined' && AURORA_DEFAULT_WINDOW) ? AURORA_DEFAULT_WINDOW : null;
      const dayTripCtx   = await getHeuristicDayTripContext(cityName, stayDaysForCity);

      heuristicsContext = `
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
REGLAS CRÍTICAS (NO NEGOCIABLES):
- El itinerario se decide en INFO (tú). El planner solo ordena/corrige choques pequeños.
- No inventes ventanas rígidas si el usuario no las dio.
- Cenas en horario adecuado (19:00–21:30 aprox.) aunque no haya show.
- Tours / day trips deben desglosarse en paradas clave.
- Siempre “Regreso a la ciudad” al final de excursiones fuera de la ciudad.
- Auroras: si aplican, distribúyelas (no consecutivas, no solo el último día).
- Duración SIEMPRE en 2 líneas:
  Transporte: ...
  Actividad: ...
  Si no sabes: “Verificar duración en el Info Chat”.
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

    const res = await fetch(resolveChatApiUrl(API_URL), {
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

  let duration = '';
  if (typeof durRaw === 'number') {
    duration = `${durRaw}m`;
  } else {
    const s = String(durRaw ?? '');
    // ✅ preservar si ya viene en 2 líneas
    if (/Transporte\s*:/i.test(s) || /Actividad\s*:/i.test(s)) duration = s;
    else duration = s;
  }

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

      // 🕒 ✅ SIN HORARIO PREDEFINIDO: si no hay horario definido, dejar null para que el API decida
      const start = cityMeta[city]?.perDay?.find(x=>x.day===newDay)?.start ?? null;
      const end   = cityMeta[city]?.perDay?.find(x=>x.day===newDay)?.end   ?? null;

      if(!cityMeta[city]) cityMeta[city] = { perDay: [] };
      if(!Array.isArray(cityMeta[city].perDay)) cityMeta[city].perDay = [];

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
   SECCIÓN 14 · Validación GLOBAL (2º paso) — LIMPIA (SIN LEGACY)
   ✅ Fuente de verdad: API (INFO→rows_draft, PLANNER→rows)
   ✅ Este validador es SOLO “guardián” local: estructura, formato y guard rails.
   🚫 Eliminado TODO legacy: callAgent / parseJSON / ENABLE_VALIDATOR / prompts internos.
   ✅ Salida compatible: { allowed:[...], rejected:[...] } (+ alias removed)
================================= */

async function validateRowsWithAgent(city, rows, baseDate){
  // =========================
  // Helpers locales (no dependen de nada externo)
  // =========================
  const toStr = v => (v == null ? '' : String(v));
  const lc = s => toStr(s).trim().toLowerCase();

  const canon = (s) => toStr(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\p{L}\p{N}\s\-–—]/gu,' ')
    .replace(/\s+/g,' ')
    .trim();

  const isHHMM = (t)=> /^\d{2}:\d{2}$/.test(toStr(t).trim());

  const toMin = (hhmm)=>{
    const m = toStr(hhmm).trim().match(/^(\d{1,2}):(\d{2})$/);
    if(!m) return null;
    const h = Math.min(23, Math.max(0, parseInt(m[1],10)));
    const mi = Math.min(59, Math.max(0, parseInt(m[2],10)));
    return h*60 + mi;
  };

  const toHH = (mins)=>{
    let m = Math.round(Math.max(0, Number(mins)||0)) % (24*60);
    const h = Math.floor(m/60);
    const mm = m%60;
    return `${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  };

  const addMin = (hhmm, add)=>{
    const b = toMin(hhmm);
    if(b == null) return hhmm || '09:00';
    return toHH(b + (Number(add)||0));
  };

  const hasTwoLineDuration = (duration)=>{
    const s = toStr(duration);
    return /Transporte\s*:\s*.*\nActividad\s*:\s*/i.test(s);
  };

  const ensureTwoLineDuration = (duration)=>{
    const s = toStr(duration).trim();
    if(hasTwoLineDuration(s)) return s;

    // Si viene "2h" / "90m", lo usamos como Actividad y dejamos transporte “verificar”
    if(/^\~?\s*\d+(\.\d+)?\s*h(\d+\s*m)?$/i.test(s) || /^\~?\s*\d+\s*m$/i.test(s) || /^\~?\s*\d+\s*h$/i.test(s)){
      return `Transporte: Verificar duración en el Info Chat\nActividad: ${s.replace(/\s+/g,'')}`;
    }

    // default (no inventar)
    return `Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat`;
  };

  const strongTour = /(excursi[oó]n|day\s*trip|tour\b|circuito|ruta|road\s*trip|pen[ií]nsula|parque\s+nacional|volc[aá]n|glaciar|cascada|waterfall|crater|geyser|lagoon|hot\s*spring|thermal|island\s+tour)/i;

  const isAurora = (act)=> /\baurora|northern\s+light(s)?\b/i.test(toStr(act));
  const isReturnRow = (r)=> /(^|\b)regreso\b/i.test(toStr(r?.activity)) || /\breturn\b/i.test(toStr(r?.activity));

  const isOutOfTownLike = (r)=>{
    const a = toStr(r?.activity).toLowerCase();
    const f = toStr(r?.from).toLowerCase();
    const t = toStr(r?.to).toLowerCase();
    const tr = toStr(r?.transport).toLowerCase();

    if (strongTour.test(a) || strongTour.test(f) || strongTour.test(t)) return true;
    if (/(veh[ií]culo|carro|auto|car|van|tour\s+guiado|bus\s+tur[ií]stico)/i.test(tr) && strongTour.test(a)) return true;
    return false;
  };

  const normalizeRowSafe = (r, fallbackDay=1)=>{
    const day = Math.max(1, parseInt(r?.day ?? fallbackDay, 10) || 1);

    // No inventamos ventanas; solo normalizamos HH:MM si es posible
    let start = toStr(r?.start).trim();
    let end   = toStr(r?.end).trim();

    // Si vienen vacíos, los dejamos vacíos (la API/otros guard-rails podrán llenarlo)
    if(start && !isHHMM(start)){
      const m = start.match(/(\d{1,2}):(\d{2})/);
      start = m ? `${String(Math.min(23, Math.max(0, parseInt(m[1],10)))).padStart(2,'0')}:${String(Math.min(59, Math.max(0, parseInt(m[2],10)))).padStart(2,'0')}` : start;
    }
    if(end && !isHHMM(end)){
      const m = end.match(/(\d{1,2}):(\d{2})/);
      end = m ? `${String(Math.min(23, Math.max(0, parseInt(m[1],10)))).padStart(2,'0')}:${String(Math.min(59, Math.max(0, parseInt(m[2],10)))).padStart(2,'0')}` : end;
    }

    const activity = toStr(r?.activity).trim();
    const from = toStr(r?.from).trim();
    const to   = toStr(r?.to).trim();
    const transport = toStr(r?.transport).trim();
    const notes = toStr(r?.notes).trim();

    // duration SIEMPRE 2 líneas
    const duration = ensureTwoLineDuration(r?.duration);

    const kind = toStr(r?.kind).trim();
    const zone = toStr(r?.zone).trim();

    const out = {
      day,
      start,
      end,
      activity,
      from,
      to,
      transport,
      duration,
      notes,
      kind,
      zone
    };

    // preservar _crossDay si existe
    if(typeof r?._crossDay !== 'undefined') out._crossDay = !!r._crossDay;

    return out;
  };

  // =========================
  // Inicio
  // =========================
  const inRows = Array.isArray(rows) ? rows : [];
  if(!inRows.length) return { allowed: [], rejected: [], removed: [] };

  // Normalización base + filtros mínimos (sin inventar POIs)
  const rejected = [];
  let norm = inRows.map((r, i)=>{
    const rr = normalizeRowSafe(r, 1);
    rr._idx = (typeof r?._idx !== 'undefined') ? r._idx : i;
    return rr;
  });

  // Rechazar solo casos realmente inválidos (activity vacía)
  norm = norm.filter(r=>{
    if(!r.activity){
      rejected.push({ reason:'Fila sin activity (vacía).', row:r });
      return false;
    }
    return true;
  });

  // Agrupar por día
  const byDay = {};
  for(const r of norm){
    const d = Number(r.day)||1;
    (byDay[d] ||= []).push(r);
  }

  // =========================
  // Guard rails estructurales (sin creatividad)
  // =========================
  const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  for(const d of days){
    let list = byDay[d] || [];

    // Orden estable por start (si existe) y luego por índice
    list.sort((a,b)=>{
      const sa = toMin(a.start) ?? 1e9;
      const sb = toMin(b.start) ?? 1e9;
      if(sa !== sb) return sa - sb;
      return (Number(a._idx)||0) - (Number(b._idx)||0);
    });

    // 1) “No diurnas 01:00–05:00” (guard rail, NO inventa actividades)
    // - Si una fila NO es aurora y tiene start entre 01–05, la movemos a 09:00 y preservamos duración aproximada
    for(let i=0; i<list.length; i++){
      const r = list[i];
      if(isAurora(r.activity)) continue;
      const s = toMin(r.start);
      if(s != null && s >= 60 && s <= 300){
        // Mantener duración si podemos (a partir de end-start)
        const e = toMin(r.end);
        let dur = 60;
        if(e != null){
          let dd = e - s;
          if(dd <= 0) dd += 24*60;
          if(dd >= 30) dur = dd;
        }
        r.start = '09:00';
        r.end   = addMin(r.start, dur);
      }
    }

    // 2) Detectar “día con macro-tour/out-of-town”
    const tourLike = list.some(r=> isOutOfTownLike(r) || strongTour.test(toStr(r.activity)));
    if(tourLike){
      // 2a) En días tour: reforzar formato "Destino – Sub-parada" SOLO si no tiene "–" y NO es Regreso
      // (No inventa POIs; solo etiqueta como sub-parada)
      for(const r of list){
        if(isReturnRow(r)) continue;
        const a = toStr(r.activity).trim();
        if(!a) continue;
        // ya tiene dash “–” o “-”
        if(/[–-]/.test(a) && a.split(/[–-]/).length >= 2) continue;

        // Evitar tocar cosas claramente “simples” como “Check-in”, “Almuerzo”, etc.
        const ca = canon(a);
        if(/^(check in|checkin|check-out|checkout|almuerzo|cena|desayuno|comida|lunch|dinner|breakfast)\b/i.test(ca)) continue;

        // Etiqueta neutra (no inventa)
        r.activity = `Tour – ${a}`;
      }

      // 2b) Asegurar “Regreso a {ciudad}” al final del día tour si no existe
      const hasReturn = list.some(r=> isReturnRow(r) && new RegExp(canon(city||''),'i').test(canon(r.activity)));
      const hasAnyReturn = list.some(r=> isReturnRow(r));

      if(!hasReturn && !hasAnyReturn){
        // Hora final: si hay end válido, usarlo; si no, dejar vacío (no inventar ventana)
        const last = [...list].reverse().find(r=>toStr(r.end).trim());
        const endGuess = last ? toStr(last.end).trim() : '';
        const startGuess = endGuess ? addMin(endGuess, -45) : ''; // buffer simple
        const transportGuess = toStr(last?.transport).trim() || 'Vehículo alquilado o Tour guiado';

        list.push({
          day: d,
          start: startGuess,
          end: endGuess,
          activity: `Regreso a ${city}`,
          from: toStr(last?.to).trim() || toStr(last?.from).trim() || '',
          to: city,
          transport: transportGuess,
          duration: ensureTwoLineDuration(`Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat`),
          notes: 'Cierre del day-trip y regreso a la ciudad base.',
          kind: 'return',
          zone: toStr(last?.zone).trim() || ''
        });
      }
    }

    // 3) Duración 2 líneas (doble-check)
    for(const r of list){
      r.duration = ensureTwoLineDuration(r.duration);
    }

    // 4) Límite duro (no reventar UI)
    if(list.length > 20) list = list.slice(0,20);

    // Guardar
    byDay[d] = list;
  }

  // Aplanar en orden día
  const allowed = [];
  for(const d of Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b)){
    allowed.push(...(byDay[d]||[]).map(r=>{
      const rr = { ...r };
      delete rr._idx;
      return rr;
    }));
  }

  // Compat alias (por si algún caller espera "removed")
  const removed = rejected.map(x=>({ reason:x.reason, row:x.row }));

  return { allowed, rejected, removed };
}

/* ==============================
   SECCIÓN 15 · Generación por ciudad (quirúrgico para recuperar estabilidad)
================================= */

/* ─────────────────────────────────────────────────────────────
   [15.1] Overlay helpers (se conserva, pero FIX: no re-habilitar de más)
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
    // ✅ Mantener habilitado solo reset
    if (el.id === 'reset-planner') return;

    // ✅ Mantener control específico de info chat floating (si existe)
    if (el.id === 'info-chat-floating') {
      try { el.disabled = on; } catch(_) {}
      return;
    }

    if(on){
      // Guardar estado previo solo 1 vez
      if(typeof el._prevDisabled === 'undefined'){
        try { el._prevDisabled = !!el.disabled; } catch(_) { el._prevDisabled = false; }
      }
      try { el.disabled = true; } catch(_) {}
    }else{
      // Restaurar exactamente el estado previo
      if(typeof el._prevDisabled !== 'undefined'){
        try { el.disabled = el._prevDisabled; } catch(_) {}
        delete el._prevDisabled;
      }
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   SECCIÓN 15.2 · Generación principal por ciudad
   Base v60 + injertos v64 + dedupe global con normKey
   🆕 v75→API42.6.x: primer poblado con doble etapa INFO→PLANNER
   🆕 Robustez: usa callApiChat (si existe) con timeout/reintentos + caché research
   🆕 Auroras: normalización + tope no consecutivo por día ANTES de pushRows
   🆕 Inyección segura post-planner: duration normalizada / cena / retorno a ciudad
   🆕 Rendimiento: optimizeDay sólo en días realmente vacíos o “flacos” (≥ umbral)
   🆕 Coherencia: 1 sola aurora por día + limpieza de transporte tras “Regreso”
───────────────────────────────────────────────────────────── */
async function generateCityItinerary(city){
  window.__cityLocks = window.__cityLocks || {};
  if (window.__cityLocks[city]) { console.warn(`[Mutex] Generación ya en curso para ${city}`); return; }
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

  /* ==================== Helpers API ==================== */
  const hasCallApiChat = (typeof callApiChat === 'function');

  async function callPlannerAPI_withResearch(researchJson){
    if (hasCallApiChat) {
      const resp = await callApiChat('planner', { research_json: researchJson }, { timeoutMs: 42000, retries: 1 });
      const txt  = (typeof resp === 'object' && resp) ? (resp.text ?? resp) : resp;
      return cleanToJSONPlus(txt || resp) || {};
    }
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "planner", research_json: researchJson }),
    });
    if (!resp.ok) throw new Error(`API planner HTTP ${resp.status}`);
    const data = await resp.json();
    return cleanToJSONPlus(data?.text || data) || {};
  }

  async function callInfoAPI(context){
    if (hasCallApiChat) {
      const resp = await callApiChat('info', { context }, { timeoutMs: 32000, retries: 1 });
      const txt  = (typeof resp === 'object' && resp) ? (resp.text ?? resp) : resp;
      return cleanToJSONPlus(txt || resp) || {};
    }
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "info", context }),
    });
    if (!resp.ok) throw new Error(`API info HTTP ${resp.status}`);
    const data = await resp.json();
    return cleanToJSONPlus(data?.text || data) || {};
  }

  async function callPlannerAPI_legacy(messages, opts = {}) {
    const payload = { mode: "planner", messages };
    if (opts.itinerary_id) payload.itinerary_id = opts.itinerary_id;
    if (typeof opts.version === 'number') payload.version = opts.version;

    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`API planner(legacy) HTTP ${resp.status}`);
    const data = await resp.json();
    const text = data?.text || "";
    return parseJSON(text);
  }

  function hasCoverageForAllDays(rows, totalDays){
    if(!Array.isArray(rows) || !rows.length) return false;
    const flags = new Set(rows.map(r=>Number(r.day)||1));
    for(let d=1; d<=totalDays; d++){ if(!flags.has(d)) return false; }
    return true;
  }
  // 🆕 umbral de “día flaco”
  function dayIsTooThin(city, day, min=3){
    const cur = itineraries[city]?.byDay?.[day] || [];
    return cur.filter(r=>!!r.activity).length < min;
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
    const forceReplan = !!(plannerState?.forceReplan && plannerState.forceReplan[city]);

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

    const intakeText = `
${FORMAT}
**Genera únicamente ${dest.days} día/s para "${city}"** (tabs ya existen en UI).
Ventanas base por día (UI): ${JSON.stringify(perDay)}.
Hotel/zona: ${hotel || 'a determinar'} · Transporte preferido: ${transport || 'a determinar'}.
Requisitos:
- Cobertura completa días 1–${dest.days} (sin días vacíos).
- Rutas madre → subparadas; inserta "Regreso a ${city}" en day-trips.
- Horarios plausibles: base 08:30–19:00; buffers ≥15m.
- Transporte coherente: urbano a pie/metro; interurbano vehículo/tour si no hay bus local.
- Duraciones normalizadas ("1h30m", "45m"). Máx 20 filas/día.
Notas:
- Breves y útiles (con "valid:" cuando aplique).
- Si el research trae auroras, respétalas tal cual (ventana/nota/duración).
Contexto adicional:
${heuristicsContext}
INTAKE:
${buildIntake()}
`.trim();

    if (typeof setOverlayMessage === 'function') {
      try { setOverlayMessage(`Generando itinerario para ${city}…`); } catch(_) {}
    }

    /* =================== Doble etapa INFO→PLANNER con caché =================== */
    window.__researchCache = window.__researchCache || {};
    const cached = window.__researchCache[city];

    let parsed = null;
    try{
      const context = __collectPlannerContext__(city, 1);
      const research = cached || await callInfoAPI(context);
      if(!cached) window.__researchCache[city] = research;
      const structured = await callPlannerAPI_withResearch(research);
      parsed = structured;
    }catch(errInfoPlanner){
      console.warn('[generateCityItinerary] INFO→PLANNER falló, uso LEGACY:', errInfoPlanner);
      const apiMessages = [{ role: "user", content: intakeText }];
      const current = itineraries?.[city] || null;
      parsed = await callPlannerAPI_legacy(apiMessages, {
        itinerary_id: current?.itinerary_id,
        version: typeof current?.version === 'number' ? current.version : undefined,
      });
    }

    if(parsed && (parsed.rows || parsed.destination)){
      const rowsFromApi = Array.isArray(parsed.rows) ? parsed.rows : [];
      // 1 sola pasada de normalización → performance
      let tmpRows = rowsFromApi.map(r=>normalizeRow(r));

      // Dedupe contra lo ya existente
      const existingActs = Object.values(itineraries[city]?.byDay||{}).flat().map(r=>normKey(String(r.activity||'')));
      tmpRows = tmpRows.filter(r=>!existingActs.includes(normKey(String(r.activity||''))));

      // Fixes suaves
      if(typeof applyTransportSmartFixes==='function') tmpRows=applyTransportSmartFixes(tmpRows);
      if(typeof applyThermalSpaMinDuration==='function') tmpRows=applyThermalSpaMinDuration(tmpRows);
      if(typeof sanitizeNotes==='function') tmpRows=sanitizeNotes(tmpRows);

      // === PIPELINE COHERENTE (una sola pasada por transformación pesada) ===
      // A) normalizaciones
      if(typeof normalizeDurationLabel==='function') tmpRows = tmpRows.map(normalizeDurationLabel);
      if(typeof normalizeAuroraWindow==='function')  tmpRows = tmpRows.map(normalizeAuroraWindow);
      // B) auroras: 1 por día + tope no consecutivo (cap global)
      if(typeof enforceOneAuroraPerDay==='function') tmpRows = enforceOneAuroraPerDay(tmpRows);
      if(typeof enforceAuroraCapForDay==='function' && typeof suggestedAuroraCap==='function'){
        const cap = suggestedAuroraCap(dest.days || tmpRows.reduce((m,r)=>Math.max(m, Number(r.day)||1), 1));
        const byDay = {}; tmpRows.forEach(r => { const d=Number(r.day)||1; (byDay[d]=byDay[d]||[]).push(r); });
        const rebuilt = [];
        Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b).forEach(day=>{
          rebuilt.push(...enforceAuroraCapForDay(city, day, byDay[day], cap));
        });
        tmpRows = rebuilt;
      }
      // C) transporte (relleno sólo si falta)
      if(typeof enforceTransportAndOutOfTown==='function') tmpRows = enforceTransportAndOutOfTown(city, tmpRows);
      // D) anti-solapes + cruce nocturno tabs-safe (PATCH dentro de fixOverlaps)
      if(typeof fixOverlaps==='function') tmpRows = fixOverlaps(tmpRows);
      // E) retorno a ciudad si day-trip
      if(typeof ensureReturnRow==='function') tmpRows = ensureReturnRow(city, tmpRows);
      // F) limpiar transporte en actividades urbanas posteriores al regreso
      if(typeof clearTransportAfterReturn==='function') tmpRows = clearTransportAfterReturn(city, tmpRows);
      // G) cena si procede
      if(plannerState?.preferences?.alwaysIncludeDinner && typeof injectDinnerIfMissing==='function'){
        tmpRows = injectDinnerIfMissing(city, tmpRows);
      }
      // H) poda de genéricos redundantes
      if(typeof pruneGenericPerDay==='function') tmpRows = pruneGenericPerDay(tmpRows);

      // Empuje a estado
      pushRows(city, tmpRows, !!forceReplan);

      // Render/optimización sólo donde hace falta
      ensureDays(city);
      const totalDays = dest.days || Object.keys(itineraries[city].byDay||{}).length || 1;

      const hasAll = hasCoverageForAllDays(tmpRows, totalDays);
      for(let d=1; d<=totalDays; d++){
        const need = forceReplan || !hasAll || dayIsTooThin(city, d, 3);
        if (need){ /* eslint-disable no-await-in-loop */ await optimizeDay(city,d); }
      }

      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
      if(forceReplan && plannerState?.forceReplan) delete plannerState.forceReplan[city];
      if(plannerState?.preferences){ delete plannerState.preferences.preferDayTrip; delete plannerState.preferences.preferAurora; }
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

/* ─────────────────────────────────────────────────────────────
   [15.3] Rebalanceo / optimización
   (eliminado en tu modelo limpio: vive en API)
───────────────────────────────────────────────────────────── */

/* ==============================
   SECCIÓN 16 · Inicio (hotel/transport)
   v60 base + overlay bloqueado global hasta terminar todas las ciudades
   (concurrencia controlada vía runWithConcurrency)
   + Mejora: resolutor inteligente de hotel/zona y banderas globales de cena/vespertino/auroras
   ✅ FIX QUIRÚRGICO: si falta transporte, pedir SOLO transporte (evita confusión)
   ✅ FIX QUIRÚRGICO NUEVO: si falla generación de alguna ciudad, NO “doneAll”
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
  // - Ventana vespertina flexible
  // - Sugerencias icónicas con frecuencia moderada (similares a auroras)
  if(!plannerState.preferences) plannerState.preferences = {};
  plannerState.preferences.alwaysIncludeDinner = true;
  plannerState.preferences.flexibleEvening     = true;
  plannerState.preferences.iconicHintsModerate = true;

  // 1) Saludo inicial
  chatMsg(`${tone.hi}`);

  // 2) Tip del Info Chat (se muestra una sola vez al iniciar)
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

// Pre-carga alias por ciudad
function preloadHotelAliases(city){
  if(!city) return;
  if(!plannerState.hotelAliases) plannerState.hotelAliases = {};
  if(plannerState.hotelAliases[city]) return;

  const base = [city];
  const extras = [
    'centro','downtown','old town','historic center','main square','cathedral',
    'harbor','port','university','station','bus terminal','train station'
  ];

  const prev = (cityMeta[city]?.hotel ? [cityMeta[city].hotel] : []);
  plannerState.hotelAliases[city] = [...new Set([...base, ...extras, ...prev])];
}

function resolveHotelInput(userText, city){
  const raw = String(userText||'').trim();
  if(!raw) return {text:'', confidence:0};

  // 1) Links → conf alta
  if(/^https?:\/\//i.test(raw)){
    return { text: raw, confidence: 0.98, resolvedVia: 'url' };
  }

  const candidates = new Set();
  (plannerState.hotelAliases?.[city] || []).forEach(x=>candidates.add(x));

  const byDay = itineraries?.[city]?.byDay || {};
  Object.values(byDay).flat().forEach(r=>{
    if(r?.activity) candidates.add(r.activity);
    if(r?.to)       candidates.add(r.to);
    if(r?.from)     candidates.add(r.from);
  });

  if(cityMeta?.[city]?.hotel) candidates.add(cityMeta[city].hotel);

  let best = { text: raw, confidence: 0.50, resolvedVia: 'raw', score: 0.5 };
  const list = [...candidates].filter(Boolean);
  for(const c of list){
    const j = _jaccard(raw, c);
    const l = _levRatio(raw, c);
    const score = 0.6*j + 0.4*l;
    if(score > (best.score||0)){
      best = { text: c, confidence: Math.max(0.55, Math.min(0.99, score)), resolvedVia: 'alias', score };
    }
  }

  hotelResolverCache[city] = hotelResolverCache[city] || {};
  hotelResolverCache[city][raw] = best;
  return best;
}

/* ====== Helper mínimo para detectar “no sé / recomiéndame” en transporte ====== */
function __wantsTransportRecommendation__(txt){
  const t = String(txt||'').toLowerCase();
  return /\b(recomiend|no\s*s[eé]|no\s*se|no\s*tengo|da\s*igual|como\s*sea|cualquiera)\b/.test(t);
}

function askNextHotelTransport(){
  // ✅ Si ya se procesaron todos los destinos → generar itinerarios
  if(metaProgressIndex >= savedDestinations.length){
    collectingHotels = false;
    chatMsg(tone.confirmAll);

    (async ()=>{
      showWOW(true, 'Astra está generando itinerarios…');

      try{
        // ⚙️ Concurrencia controlada (v60): no tocar
        const taskFns = savedDestinations.map(({city}) => async () => {
          // ✅ generateCityItinerary ahora lanza si falla (ver SECCIÓN 15)
          await generateCityItinerary(city);
        });

        await runWithConcurrency(taskFns);

        // ✅ SOLO si TODAS las ciudades se generaron bien
        chatMsg(tone.doneAll);

      }catch(err){
        console.error('[askNextHotelTransport] Generación global falló:', err);

        // ✅ NO afirmar éxito si hubo error
        chatMsg(
          `⚠️ Hubo un error generando uno o más itinerarios. ` +
          `Revisa la consola (F12) y vuelve a intentar.`,
          'ai'
        );

      }finally{
        showWOW(false);
      }
    })();
    return;
  }

  // 🧠 Validación y persistencia del destino actual
  const city = savedDestinations[metaProgressIndex].city;
  if(!cityMeta[city]){
    cityMeta[city] = { baseDate: null, hotel:'', transport:'', perDay: [] };
  }

  preloadHotelAliases(city);

  // ⛔ Debe esperar hotel/zona
  const currentHotel = cityMeta[city].hotel || '';
  if(!currentHotel.trim()){
    setActiveCity(city);
    renderCityItinerary(city);
    chatMsg(tone.askHotelTransport(city), 'ai');
    return;
  }

  // ⛔ Debe esperar transporte
  const currentTransport = cityMeta[city].transport || '';
  if(!currentTransport.trim()){
    setActiveCity(city);
    renderCityItinerary(city);

    chatMsg(
      `Perfecto. Para <strong>${city}</strong>, ¿cómo te vas a mover? ` +
      `(ej: “vehículo alquilado”, “transporte público”, “Uber/taxi”, o escribe “recomiéndame”).`,
      'ai'
    );
    return;
  }

  // 🧭 Avanzar al siguiente destino
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

/* ===========================================================
   SECCIÓN 18 · Guard rails + Validación flexible FINAL (v79.x)
   Objetivo: robustez sin romper lo estable.
   Fuente de verdad: API (INFO + PLANNER)
   Aquí solo: robustez, normalización, retries controlados, anti-regresiones.
=========================================================== */

/* ─────────────────────────────────────────────────────────────
   [18.1] Helper: Canonización + normalización de strings
───────────────────────────────────────────────────────────── */
function canonTxt(s){
  return String(s||'')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\p{L}\p{N}\s]/gu,' ')
    .replace(/\s+/g,' ')
    .trim();
}

/* ─────────────────────────────────────────────────────────────
   [18.2] Helper: HH:MM validator + normalizer
───────────────────────────────────────────────────────────── */
function isHHMM(v){
  return /^(\d{1,2}):(\d{2})$/.test(String(v||'').trim());
}
function pad2(n){ return String(n).padStart(2,'0'); }
function normHHMM(v){
  const m = String(v||'').trim().match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return String(v||'').trim();
  let hh = Math.min(23, Math.max(0, parseInt(m[1],10)));
  let mm = Math.min(59, Math.max(0, parseInt(m[2],10)));
  return `${pad2(hh)}:${pad2(mm)}`;
}

/* ─────────────────────────────────────────────────────────────
   [18.3] Helper: Duración (2 líneas) guard
───────────────────────────────────────────────────────────── */
function hasTwoLineDuration(s){
  const t = String(s||'');
  return /Transporte\s*:\s*.*\nActividad\s*:\s*/i.test(t);
}
function forceTwoLineDuration(duration){
  const d = String(duration||'').trim();
  if(hasTwoLineDuration(d)) return d;
  // Si viene vacío o no cumple, lo forzamos al placeholder estándar.
  return "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat";
}

/* ─────────────────────────────────────────────────────────────
   [18.4] Helper: Normalizar filas (contrato tabla)
───────────────────────────────────────────────────────────── */
function normalizeRow(r){
  const out = { ...(r||{}) };
  out.day = Number(out.day||1) || 1;

  // start/end: normaliza si están presentes
  if(out.start && isHHMM(out.start)) out.start = normHHMM(out.start);
  if(out.end && isHHMM(out.end)) out.end = normHHMM(out.end);

  out.activity = String(out.activity||'').trim();
  out.from = String(out.from||'').trim();
  out.to = String(out.to||'').trim();
  out.transport = String(out.transport||'').trim();
  out.notes = String(out.notes||'').trim();
  out.kind = String(out.kind||'').trim();
  out.zone = String(out.zone||'').trim();

  out.duration = forceTwoLineDuration(out.duration);

  // _crossDay opcional
  if(out._crossDay != null) out._crossDay = !!out._crossDay;

  return out;
}
function normalizeRows(rows){
  if(!Array.isArray(rows)) return [];
  return rows.map(normalizeRow).filter(r => r.activity || r.notes || r.transport);
}

/* ─────────────────────────────────────────────────────────────
   [18.5] Helper: Dedupe básico (misma activity+start+day)
───────────────────────────────────────────────────────────── */
function dedupeRows(rows){
  const seen = new Set();
  const out = [];
  for(const r of (rows||[])){
    const key = `${r.day}__${String(r.start||'')}__${canonTxt(r.activity)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────
   [18.6] Helper: Extraer JSON del API { text:"..." }
───────────────────────────────────────────────────────────── */
function parseApiTextToJSON(apiText){
  try{
    if(!apiText) return null;
    if(typeof apiText === 'object') return apiText;
    const raw = String(apiText||'');
    // intento directo
    try{ return JSON.parse(raw); }catch(_){}
    // recorte tolerante
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if(first>=0 && last>first){
      try{ return JSON.parse(raw.slice(first,last+1)); }catch(_){}
    }
  }catch(_){}
  return null;
}

/* ─────────────────────────────────────────────────────────────
   [18.7] Helper: Call API (INFO/PLANNER) con timeout + abort
   ✅ QUIRÚRGICO v79.x: NO colisionar firmas con la Sección 15.2
   - Si ya existe window.callApiChat (firma mode,payload,opts), no redefinir.
   - Si no existe, definimos un shim COMPATIBLE con 15.2.
───────────────────────────────────────────────────────────── */
function __getChatEndpoint18__(){
  try{
    const qs = new URLSearchParams(window.location.search || '');
    const abs = (qs.get('chatApiAbs') || '').trim();
    if(abs) return abs;

    const apiBase = (qs.get('apiBase') || '').trim();
    const chatApi = (qs.get('chatApi') || '/api/chat').trim() || '/api/chat';
    if(apiBase){
      return apiBase.replace(/\/+$/,'') + (chatApi.startsWith('/') ? chatApi : `/${chatApi}`);
    }
  }catch(_){}
  return "/api/chat";
}

if (typeof window !== 'undefined' && typeof window.callApiChat !== 'function' && typeof callApiChat !== 'function') {
  window.callApiChat = async function(mode, payload = {}, opts = {}) {
    const retries   = Number(opts.retries || 0);

    const modeLc = String(mode || '').toLowerCase();
    const defaultTimeout =
      (modeLc === 'info')    ? 120000 :
      (modeLc === 'planner') ? 120000 :
      (modeLc === 'validate')? 30000  :
      90000;

    const timeoutMs = Number(opts.timeoutMs || defaultTimeout);
    const url = __getChatEndpoint18__();

    const doOnce = async ()=>{
      const ctrl = new AbortController();
      const t = setTimeout(()=>ctrl.abort(new Error(`timeout ${timeoutMs}ms (${mode})`)), timeoutMs);
      try{
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type':'application/json' },
          body: JSON.stringify({ mode, ...payload }),
          signal: ctrl.signal
        });
        const data = await resp.json().catch(()=>null);
        if(!resp.ok) throw new Error(`API ${mode} HTTP ${resp.status}`);
        return data;
      } finally {
        clearTimeout(t);
      }
    };

    let lastErr = null;
    for (let i=0; i<=retries; i++){
      try { return await doOnce(); }
      catch(e){ lastErr = e; }
    }
    throw lastErr || new Error("callApiChat failed");
  };

  // exponer símbolo (sin window.) si alguien lo usa así
  if (typeof callApiChat !== 'function') {
    var callApiChat = window.callApiChat;
  }
} else {
  // Si existe window.callApiChat, aseguramos alias global
  if (typeof callApiChat !== 'function' && typeof window !== 'undefined' && typeof window.callApiChat === 'function') {
    var callApiChat = window.callApiChat;
  }
}

/* ─────────────────────────────────────────────────────────────
   [18.8] Guard: detectar placeholders de baja calidad (global)
───────────────────────────────────────────────────────────── */
function isGenericPlaceholderActivity(activity){
  const t = canonTxt(activity);
  if(!t) return true;
  const bad = [
    "museo de arte",
    "parque local",
    "cafe local",
    "restaurante local",
    "exploracion de la costa",
    "exploracion de la ciudad",
    "paseo por la ciudad",
    "recorrido por la ciudad"
  ];
  if(t.length <= 10 && /^(museo|parque|cafe|restaurante|plaza|mercado)$/i.test(t)) return true;
  if(bad.some(b => t===b || t.includes(b))) return true;
  if(/^(museo|parque|cafe|restaurante)\b/i.test(t) && t.split(' ').length <= 3) return true;
  return false;
}

/* ─────────────────────────────────────────────────────────────
   [18.9] Validación flexible FINAL (no rompe lo estable)
───────────────────────────────────────────────────────────── */
function softValidateRows(rows, { daysTotal=1 }={}){
  const issues = [];
  const clean = normalizeRows(rows);

  if(!clean.length) issues.push("rows vacío.");
  // Cobertura por día (soft)
  const need = Math.max(1, Number(daysTotal)||1);
  const present = new Set(clean.map(r=>Number(r.day)||1));
  for(let d=1; d<=need; d++){
    if(!present.has(d)) issues.push(`falta día ${d}.`);
  }

  // duration 2 líneas (hard-enforced por normalizeRow)
  // placeholders (soft)
  if(clean.some(r => isGenericPlaceholderActivity(r.activity))){
    issues.push("hay activity genérica (placeholder).");
  }

  return { ok: issues.length===0, issues, rows: clean };
}

/* ─────────────────────────────────────────────────────────────
   [18.10] Normalización final de respuesta API Planner
───────────────────────────────────────────────────────────── */
function normalizePlannerResponse(parsed, { daysTotal=1 }={}){
  if(!parsed) return { destination:"", rows:[], followup:"" };

  let rows = [];
  if(Array.isArray(parsed.rows)) rows = parsed.rows;
  else if(Array.isArray(parsed.rows_final)) rows = parsed.rows_final;
  else if(Array.isArray(parsed.rows_draft)) rows = parsed.rows_draft;

  rows = dedupeRows(normalizeRows(rows));

  const destination = String(parsed.destination || parsed.city || parsed.place || '').trim();
  const followup = String(parsed.followup || '').trim();

  const audit = softValidateRows(rows, { daysTotal });
  return { destination, rows: audit.rows, followup, _audit: audit };
}

/* ===========================================================
   FIN SECCIÓN 18
=========================================================== */

/* ==============================
   SECCIÓN 19 · Chat handler (global)
   v71.fix — Post-API (INFO + PLANNER como fuente de verdad)
   ✅ Mantiene flujos existentes (add/swap/move/etc.)
   ✅ Mantiene colecta hotel/transporte y reequilibrio
   ✅ Mantiene info_query (para preguntas informativas dentro del chat del planner)
   🆕 QUIRÚRGICO: “free_edit” ya NO arma prompts ni llama callAgent.
      En su lugar:
      1) guarda la instrucción en plannerState.pendingEdits[city]
      2) dispara replan/optimize usando el API vía optimizeDay()/rebalanceWholeCity()
   ⚠️ NO toca el Info Chat EXTERNO (eso vive en SECCIÓN 21 y se mantiene).
================================= */
async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  // Colecta hotel/transporte
  if(collectingHotels){
    const city = savedDestinations[metaProgressIndex].city;

    // 🚀 Resolver inteligentemente el hotel/zona (tolera typos, idiomas, landmarks)
    const res = resolveHotelInput(text, city);
    const resolvedHotel = res.text || text;

    // Detección de transporte (conserva tu lógica original)
    const transport = (/recom/i.test(text)) ? 'recomiéndame'
      : (/alquilad|rent|veh[ií]culo|coche|auto|carro/i.test(text)) ? 'vehículo alquilado'
      : (/metro|tren|bus|autob[uú]s|p[uú]blico/i.test(text)) ? 'transporte público'
      : (/uber|taxi|cabify|lyft/i.test(text)) ? 'otros (Uber/Taxi)'
      : '';

    // Guardar lo que venga (al menos hotel) para que askNextHotelTransport()
    // pueda pedir sólo lo faltante en esta misma ciudad.
    upsertCityMeta({ city, hotel: resolvedHotel, transport });

    // 🗣️ Feedback al usuario según confianza del match (hotel/zona)
    if(res.resolvedVia==='url' || (res.confidence||0) >= 0.80){
      chatMsg(`🏨 Tomé <strong>${resolvedHotel}</strong> como tu referencia de hotel/zona en <strong>${city}</strong>.`, 'ai');
    }else if((res.confidence||0) >= 0.65){
      chatMsg(`🏨 Usaré <strong>${resolvedHotel}</strong> como referencia en <strong>${city}</strong> (interpretado por similitud). Si deseas otro, escríbelo con más detalle o pega el link.`, 'ai');
    }else{
      chatMsg(`🏨 Registré tu referencia para <strong>${city}</strong>. Si tienes el <em>link</em> del lugar exacto o el nombre preciso, compártelo para afinar distancias.`, 'ai');
    }

    // 🌌 Activar preferAurora automáticamente si la ciudad es apta
    try{
      const canon = (typeof normalizeCityForGeo==='function') ? normalizeCityForGeo(city) : city;
      const coords = (typeof getCoordinatesForCity==='function') ? (getCoordinatesForCity(canon) || getCoordinatesForCity(city)) : null;
      const auroraCity = coords && (typeof isAuroraCityDynamic==='function') ? isAuroraCityDynamic(coords.lat, coords.lng) : false;

      // Si no hay coords, usa heurística por nombre (Reykjavik/Tromsø variantes)
      if(!coords){
        const low = String(canon||city||'').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
        if(/\breikj?avik\b|\breikiavik\b|\breykiavik\b|\breykjavik\b/.test(low)) { if(!plannerState.preferences) plannerState.preferences={}; plannerState.preferences.preferAurora = true; }
        if(/\btroms[oø]\b|\btromso\b/.test(low)) { if(!plannerState.preferences) plannerState.preferences={}; plannerState.preferences.preferAurora = true; }
      }else if(auroraCity){
        if(!plannerState.preferences) plannerState.preferences = {};
        plannerState.preferences.preferAurora = true;
      }
    }catch(_){ /* no-op seguro */ }

    // ✅ FIX: NO avanzar a la siguiente ciudad si falta transport.
    // Deja metaProgressIndex intacto y vuelve a preguntar sólo lo faltante.
    if(!transport){
      // askNextHotelTransport() ya decide si pide hotel o transporte según cityMeta
      askNextHotelTransport();
      return;
    }

    // Si hay transport, sí avanzamos.
    metaProgressIndex++;
    askNextHotelTransport();
    return;
  }

  // Cambio de hotel
  const hotelChangeMatch = text.match(/^(?:hotel|zona|direcci[oó]n):?\s*(.+)$/i);
  if(hotelChangeMatch && activeCity){
    const newHotelRaw = hotelChangeMatch[1].trim();
    const city = activeCity;

    // 🧠 Resolver también en cambios de hotel
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

    // ✅ Ventanas: NO predefinir horas. Si no existen, dejar null para que el API decida.
    if (!cityMeta[city]) cityMeta[city] = { perDay: [] };
    cityMeta[city].perDay = cityMeta[city].perDay || [];
    const ensureWindow = (d)=>{
      let pd = cityMeta[city].perDay.find(x=>x.day===d);
      if(!pd){
        pd = { day:d, start:null, end:null };
        cityMeta[city].perDay.push(pd);
      }else{
        if(pd.start == null || String(pd.start).trim()==='') pd.start = null;
        if(pd.end   == null || String(pd.end).trim()==='')   pd.end   = null;
      }
    };
    const total = Object.keys(itineraries[city].byDay||{}).length;
    for(let d=prevTotal+1; d<=total; d++) ensureWindow(d);

    // 👉 Definir "día suave" en el NUEVO último día (solo si existe en tu lógica)
    if(!plannerState.lightDayTarget) plannerState.lightDayTarget = {};
    plannerState.lightDayTarget[city] = total;

    // Reequilibrar desde el último día original hasta el nuevo final
    await rebalanceWholeCity(city, { start: Math.max(1, prevTotal), end: total, dayTripTo: intent.dayTripTo||'' });

    // Garantía de completitud del último día (si tu optimizeDay ya está post-API)
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
    itineraries[city].lastOriginalDay = prevTotal; // histórico

    // Forzar replan del rango
    if (!plannerState.forceReplan) plannerState.forceReplan = {};
    plannerState.forceReplan[city] = true;

    const numericPos = prevTotal + 1;
    insertDayAt(city, numericPos);

    // ✅ Ventanas: NO predefinir horas. Si no existen, dejar null.
    if (!cityMeta[city]) cityMeta[city] = { perDay: [] };
    cityMeta[city].perDay = cityMeta[city].perDay || [];
    const ensureWindow = (d)=>{
      let pd = cityMeta[city].perDay.find(x=>x.day===d);
      if(!pd){
        pd = { day:d, start:null, end:null };
        cityMeta[city].perDay.push(pd);
      }else{
        if(pd.start == null || String(pd.start).trim()==='') pd.start = null;
        if(pd.end   == null || String(pd.end).trim()==='')   pd.end   = null;
      }
    };
    ensureWindow(numericPos);

    // Semilla opcional si el usuario pidió "para ir a X"
    // ✅ QUIRÚRGICO: NO inyectar horarios por defecto. Si no hay start/end, dejamos vacíos y el API decide en optimize/rebalance.
    if (intent.dayTripTo) {
      const destTrip  = intent.dayTripTo;
      const pd = cityMeta[city]?.perDay?.find(x => x.day === numericPos) || {};
      const seedStart = (pd.start == null || String(pd.start).trim()==='') ? '' : String(pd.start).trim();
      const seedEnd   = (pd.end   == null || String(pd.end).trim()==='')   ? '' : String(pd.end).trim();

      // ✅ FIX QUIRÚRGICO (alineado con API): duration SIEMPRE 2 líneas
      pushRows(city, [{
        day: numericPos,
        start: seedStart,
        end: seedEnd,
        activity: `Traslado a ${destTrip}`,
        from: `Hotel (${city})`,
        to: destTrip,
        transport: 'Tren/Bus',
        duration: "Transporte: ~1h\nActividad: 0m",
        notes: `Inicio del day trip desde el hotel en ${city} hacia ${destTrip}.`
      }], false);
    }

    const total = Object.keys(itineraries[city].byDay||{}).length;

    // 👉 Definir "día suave" en el NUEVO último día
    if(!plannerState.lightDayTarget) plannerState.lightDayTarget = {};
    plannerState.lightDayTarget[city] = total;

    // Rebalancear desde el último día original hasta el nuevo final
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
    // ✅ Secuencial (evita timeouts/paralelismo)
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
    // ✅ Secuencial para evitar paralelismo y timeouts
    await optimizeDay(intent.city, intent.from);
    await optimizeDay(intent.city, intent.to);
    renderCityTabs(); setActiveCity(intent.city); renderCityItinerary(intent.city);
    showWOW(false);
    chatMsg('✅ Intercambié el orden y optimicé ambos días.','ai');
    return;
  }

  // Mover actividad
  if(intent.type==='move_activity' && intent.city){
    showWOW(true,'Moviendo actividad…');
    moveActivities(intent.city, intent.fromDay, intent.toDay, intent.query||'');
    // ✅ Secuencial para evitar paralelismo y timeouts
    await optimizeDay(intent.city, intent.fromDay);
    await optimizeDay(intent.city, intent.toDay);
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
    if(!pd){ pd = {day, start:null, end:null}; cityMeta[city].perDay.push(pd); }
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

  // Preguntas informativas (dentro del chat del planner)
  // ⚠️ Esto NO es el Info Chat EXTERNO; ese se mantiene aparte en SECCIÓN 21.
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

  // ===========================
  // Edición libre (post-API)
  // ===========================
  if(intent.type==='free_edit'){
    const city = activeCity || savedDestinations[0]?.city;
    if(!city){ chatMsg('Aún no hay itinerario en pantalla. Inicia la planificación primero.'); return; }

    const dayVisible = itineraries[city]?.currentDay || 1;

    // Heurística simple: si el usuario menciona "día X", tratamos como edición del día.
    let scope = 'city';
    let editDay = null;
    const mDay = String(text||'').match(/\b(?:d[ií]a|day)\s*(\d{1,2})\b/i);
    if(mDay){
      const d = parseInt(mDay[1],10);
      if(Number.isFinite(d) && d>0){
        scope = 'day';
        editDay = d;
      }
    }

    if(!plannerState) window.plannerState = {};
    if(!plannerState.pendingEdits) plannerState.pendingEdits = {};
    plannerState.pendingEdits[city] = { scope, day: editDay, text: String(text||'') };

    showWOW(true,'Aplicando tu cambio…');

    try{
      if(scope === 'day' && editDay){
        await optimizeDay(city, editDay);
      } else {
        // Preferimos rebalanceWholeCity si existe (mantiene tu comportamiento global)
        if(typeof rebalanceWholeCity === 'function'){
          const total = Object.keys(itineraries[city]?.byDay || {}).length || (savedDestinations.find(x=>x.city===city)?.days || 1);
          await rebalanceWholeCity(city, { start: 1, end: total });
        } else {
          // Fallback secuencial por día
          const total = Object.keys(itineraries[city]?.byDay || {}).length || 1;
          for(let d=1; d<=total; d++) await optimizeDay(city, d);
        }
      }

      renderCityTabs();
      setActiveCity(city);
      renderCityItinerary(city);
      showWOW(false);
      chatMsg('✅ Apliqué el cambio y reoptimicé el itinerario.','ai');
    }catch(_){
      showWOW(false);
      chatMsg('⚠️ No pude aplicar el cambio ahora mismo. Intenta reformularlo o indícame el día exacto (por ejemplo: “Día 3: …”).','ai');
    }
    return;
  }
}

/* ==============================
   SECCIÓN 20 · Orden de ciudades + Eventos — optimizada
   (COHERENTE con API v43.5)
================================= */
(function(){
  if (window.__ITBMO_SECTION20_REORDER_PATCH__) return;
  window.__ITBMO_SECTION20_REORDER_PATCH__ = true;

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

    up.addEventListener('click', ()=>{
      if(row.previousElementSibling){
        $cityList.insertBefore(row, row.previousElementSibling);
        saveDestinations();
      }
    });

    down.addEventListener('click', ()=>{
      if(row.nextElementSibling){
        $cityList.insertBefore(row.nextElementSibling, row);
        saveDestinations();
      }
    });
  }

  try{
    const rows = qsa('.city-row', $cityList);
    rows.forEach(r=>{
      const already = Array.from(r.querySelectorAll('button'))
        .some(b=>b.textContent==='↑' || b.textContent==='↓');
      if(!already) addRowReorderControls(r);
    });
  }catch(_){}

  if (!window.__ITBMO_ORIG_ADD_CITY_ROW__) {
    window.__ITBMO_ORIG_ADD_CITY_ROW__ = addCityRow;
  }

  const origAddCityRow = window.__ITBMO_ORIG_ADD_CITY_ROW__;

  addCityRow = function(pref){
    origAddCityRow(pref);
    const row = $cityList?.lastElementChild;
    if(row){
      const already = Array.from(row.querySelectorAll('button'))
        .some(b=>b.textContent==='↑' || b.textContent==='↓');
      if(!already) addRowReorderControls(row);
    }
  };

  document.addEventListener('input', (e)=>{
    if(e.target?.classList?.contains('country')){
      const original = e.target.value;
      const filtered = original.replace(/[^\p{L}\s]/gu,'');
      if(filtered !== original){
        const pos = e.target.selectionStart;
        e.target.value = filtered;
        if(typeof pos === 'number'){
          e.target.setSelectionRange(
            pos - (original.length - filtered.length),
            pos - (original.length - filtered.length)
          );
        }
      }
    }
  });
})();

/* ==============================
   SECCIÓN 21 · INIT y listeners
   (RESET restaurado + alineado con API v43.5)
   FIX QUIRÚRGICO:
   - __ensureInfoAgentClient__ NO puede romper init si no existe
   - input listener corregido (antes: classList.matches NO existe)
   - Reset robusto (guards: no revienta si algo está undefined)
   - Evita doble-bind del reset
================================= */

$addCity?.addEventListener('click', ()=>addCityRow());

/* ================= VALIDACIONES ================= */

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

    setTimeout(()=>tooltip.classList.add('visible'), 20);
    setTimeout(()=>{
      tooltip.classList.remove('visible');
      setTimeout(()=>tooltip.remove(), 300);
    }, 3500);

    firstInvalid.focus();
    return false;
  }
  return true;
}

function formHasBasics(){
  const row = qs('.city-row', $cityList);
  if(!row) return false;

  const city    = (qs('.city', row)?.value||'').trim();
  const country = (qs('.country', row)?.value||'').trim();
  const days    = parseInt(qs('.days', row)?.value||'0', 10);
  const base    = (qs('.baseDate', row)?.value||'').trim();

  return !!(city && country && days>0 && /^(\d{2})\/(\d{2})\/(\d{4})$/.test(base));
}

/* ================= GUARDAR DESTINOS ================= */

$save?.addEventListener('click', ()=>{
  try { saveDestinations(); } catch(_) {}

  if(formHasBasics() && validateBaseDatesDMY()){
    if ($start) $start.disabled = false;
    try { document.dispatchEvent(new CustomEvent('itbmo:destinationsSaved')); } catch(_) {}
  } else {
    if ($start) $start.disabled = true;
  }
});

/* FIX: antes estaba mal (classList.matches NO existe). */
document.addEventListener('input', (e)=>{
  if(!$start) return;
  const t = e.target;
  // Solo reacciona a inputs del bloque destinos
  if(t && typeof t.matches === 'function' && t.matches('.city, .country, .days, .baseDate')){
    if(!formHasBasics()) $start.disabled = true;
  }
});

/* ================= RESET ================= */

function ensureResetButton(){
  let btn = document.getElementById('reset-planner');
  if(!btn){
    const bar = document.querySelector('#actions-bar') || document.body;
    btn = document.createElement('button');
    btn.id = 'reset-planner';
    btn.className = 'btn warn';
    btn.textContent = 'Reiniciar planificación';
    btn.type = 'button';
    bar.appendChild(btn);
  }
  return btn;
}

function _safeClearObject(obj){
  if(!obj || typeof obj !== 'object') return;
  try { Object.keys(obj).forEach(k=>delete obj[k]); } catch(_) {}
}
function _safeClearArray(arr){
  if(!arr || !Array.isArray(arr)) return;
  try { arr.length = 0; } catch(_) {}
}

function bindReset(){
  const $btn = ensureResetButton();
  if(!$btn) return;

  // Evita doble bind si por cualquier motivo se llama otra vez
  if($btn.dataset && $btn.dataset.bound === '1') return;
  if($btn.dataset) $btn.dataset.bound = '1';

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
    setTimeout(()=>overlay.classList.add('active'),10);

    const closeOverlay = ()=>{
      overlay.classList.remove('active');
      setTimeout(()=>overlay.remove(),300);
    };

    overlay.querySelector('#confirm-reset')?.addEventListener('click', ()=>{
      try {
        /* 🔹 Limpieza SEGURA (sin reasignar consts; con guards) */
        try { if($cityList) $cityList.innerHTML=''; } catch(_) {}
        try { addCityRow(); } catch(_) {}

        // Arrays/objetos globales (si existen)
        try { if(typeof savedDestinations !== 'undefined' && Array.isArray(savedDestinations)) savedDestinations.length = 0; } catch(_) {}
        try { if(typeof itineraries !== 'undefined') _safeClearObject(itineraries); } catch(_) {}
        try { if(typeof cityMeta !== 'undefined') _safeClearObject(cityMeta); } catch(_) {}
        try { if(typeof session !== 'undefined' && Array.isArray(session)) session.length = 0; } catch(_) {}

        // Flags (si existen)
        try { if(typeof pendingChange !== 'undefined') pendingChange = null; } catch(_) {}
        try { if(typeof planningStarted !== 'undefined') planningStarted = false; } catch(_) {}
        try { if(typeof metaProgressIndex !== 'undefined') metaProgressIndex = 0; } catch(_) {}
        try { if(typeof collectingHotels !== 'undefined') collectingHotels = false; } catch(_) {}
        try { if(typeof isItineraryLocked !== 'undefined') isItineraryLocked = false; } catch(_) {}
        try { if(typeof activeCity !== 'undefined') activeCity = null; } catch(_) {}

        // UI
        try { if ($start) $start.disabled = true; } catch(_) {}
        try { if ($tabs) $tabs.innerHTML=''; } catch(_) {}
        try { if ($itWrap) $itWrap.innerHTML=''; } catch(_) {}
        try { if ($chatBox) $chatBox.style.display='none'; } catch(_) {}
        try { if ($chatM) $chatM.innerHTML=''; } catch(_) {}

        try { qsa('.date-tooltip').forEach(t=>t.remove()); } catch(_) {}
        try { $overlayWOW && ($overlayWOW.style.display='none'); } catch(_){}

        // plannerState (si existe)
        try {
          if (typeof plannerState !== 'undefined' && plannerState) {
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
        } catch(_) {}

        // Hooks
        try { document.dispatchEvent(new CustomEvent('itbmo:plannerReset')); } catch(_) {}

        closeOverlay();

        const firstCity = qs('.city-row .city');
        if(firstCity) firstCity.focus();
      } catch (err) {
        console.error('[bindReset] reset failed', err);
        // Si algo explota, igual cerramos modal para que no se “pegue”
        closeOverlay();
      }
    });

    overlay.querySelector('#cancel-reset')?.addEventListener('click', closeOverlay);

    // Escape cierra
    const escHandler = (e)=>{
      if(e.key === 'Escape'){
        closeOverlay();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  });
}

/* ================= START ================= */

$start?.addEventListener('click', ()=>{
  if(!formHasBasics() || !validateBaseDatesDMY()){
    chatMsg('Completa y guarda los destinos antes de continuar.','ai');
    return;
  }

  try { document.dispatchEvent(new CustomEvent('itbmo:startPlanning')); } catch(_) {}
  startPlanning();
});

/* ================= CHAT ================= */

$send?.addEventListener('click', onSend);
$chatI?.addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    onSend();
  }
});

/* ================= INIT ================= */

// FIX QUIRÚRGICO: esto NO puede romper el sitio si falta la función
function _safeEnsureInfoAgentClient(){
  try {
    if (typeof __ensureInfoAgentClient__ === 'function') {
      __ensureInfoAgentClient__();
      return;
    }
  } catch(_) {}
  // fallback silencioso (no rompe init)
}

document.addEventListener('DOMContentLoaded', ()=>{
  if(window.__ITBMO_SECTION21_READY__) return;
  window.__ITBMO_SECTION21_READY__ = true;

  if(!qs('#city-list .city-row')) addCityRow();

  _safeEnsureInfoAgentClient();

  try { if (typeof bindInfoChatListeners === 'function') bindInfoChatListeners(); } catch(_) {}
  bindReset();

  if ($start) $start.disabled = true;
});
