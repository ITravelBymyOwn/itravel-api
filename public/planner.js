/* =========================================================
   ITRAVELBYMYOWN · PLANNER v62 (parte 1/3)
   Base: v61
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
   SECCIÓN 12 · Llamada a Astra (estilo global, reforzado v63)
================================= */
async function callAgent(text, useHistory = true, opts = {}){
  const { timeoutMs = 60000 } = opts; // ⏳ 60 s por defecto
  const history = useHistory ? session : [];

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
- Para excursiones nocturnas especiales (ej. auroras, eventos únicos), ubícalas en **horarios plausibles y realistas según temporada y latitud**.

───────────────────────────────
🕒 **GESTIÓN DE HORARIOS**
───────────────────────────────
- Si el usuario definió horarios por día, respétalos y razona a partir de ellos.
- Si NO definió horarios, usa por defecto la ventana base **08:30–19:00** para todos los días sin información.
- Extiende horarios cuando tenga sentido logístico o turístico (cenas, tours nocturnos, auroras boreales, eventos especiales).
- Si extiendes un día por una actividad nocturna, **ajusta inteligentemente el inicio del día siguiente** (por ejemplo, comienza más tarde).
- **No heredes horarios automáticamente** entre días: cada día debe partir de su propia lógica contextual.
- Siempre asegúrate de proponer secuencias horarias coherentes, sin traslados imposibles ni saltos temporales absurdos.
- Añade buffers entre actividades (15 min mínimo, más si hay movilidad reducida o niños).
- Para actividades estacionales como auroras:
  • Nunca las programes de mañana.  
  • Usa franjas realistas (20:00–02:30 aprox.) según temporada y latitud.  
  • Si no es temporada o hay restricciones, sugiere alternativas sensatas.

───────────────────────────────
✈️ **MOVILIDAD Y TRANSPORTE**
───────────────────────────────
- Elige modos de transporte plausibles según el tipo de actividad:
  • A pie en zonas turísticas compactas.  
  • Metro / tren / bus en entornos urbanos o interurbanos lógicos.  
  • Auto o tours organizados para excursiones fuera de la ciudad.
- Considera tiempos reales de traslado y conéctalos con la secuencia del itinerario.
- Ajusta sugerencias de transporte según preferencias del usuario (alquiler, transporte público, Uber/taxi, mixto).

───────────────────────────────
🧭 **SEGURIDAD Y RESTRICCIONES**
───────────────────────────────
- No propongas actividades en zonas con riesgos relevantes, horarios peligrosos o restricciones evidentes.
- Si detectas algo riesgoso, **sustituye** por una alternativa segura, razonable y práctica.
- Incluye breves notas informativas (sin alarmismo) si hay restricciones, estacionalidad o requisitos especiales (visas, permisos, clima extremo, etc.).

───────────────────────────────
📝 **NOTAS Y CONTEXTO TURÍSTICO**
───────────────────────────────
- NUNCA dejes “notes” vacío ni “seed”.
- Usa las notas para:
  • Tips locales y culturales.  
  • Consejos de reservas anticipadas.  
  • Información de accesibilidad o logística.  
  • Recomendaciones realistas (ej. “llevar abrigo”, “reservar con 48h”, “tour en grupo pequeño recomendado”).
- Para actividades estacionales, incluye “valid:” con justificación breve (ej. temporada de auroras, mejor horario de avistamiento, requerimientos climáticos, etc.).

───────────────────────────────
🧠 **RAZONAMIENTO ADAPTATIVO**
───────────────────────────────
- Comprende instrucciones naturales del usuario y tradúcelas a acciones de itinerario inteligentes.
- Si no se indica un día específico, reacomoda de forma lógica sin duplicar.
- Si cambian preferencias de viaje, ajusta automáticamente el itinerario completo manteniendo coherencia.
- Si no hay información horaria, genera itinerarios completos igualmente, con horarios plausibles.
- Si se trata de una edición, responde siempre con JSON válido.
- Si es una pregunta informativa, responde de forma útil y conversacional (sin JSON).

───────────────────────────────
🧭 **INTELIGENCIA CONTEXTUAL GLOBAL**
───────────────────────────────
- Usa tu conocimiento general del mundo real como lo haría un experto humano.
- Considera diferencias hemisféricas, temporadas turísticas, festivos nacionales, cultura local, transporte real, condiciones meteorológicas típicas y patrones de comportamiento de turistas.
- Prioriza fluidez y naturalidad en la planificación: el resultado debe sentirse **coherente, factible y disfrutable**.
- Puedes sugerir una opción principal y una alternativa razonable si corresponde.

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
      const start = cityMeta[city]?.perDay?.find(x=>x.day===newDay)?.start || '08:30';
      const end   = cityMeta[city]?.perDay?.find(x=>x.day===newDay)?.end   || '19:00';
      
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
   SECCIÓN 14 · Validación GLOBAL (2º paso con IA) — reforzado v63
   (fusión de criterios fuertes)
================================= */
async function validateRowsWithAgent(city, rows, baseDate){
  const payload = `
Devuelve SOLO JSON válido:
{
  "allowed":[
    {"day":1,"start":"..","end":"..","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}
  ],
  "removed":[
    {"reason":"..","row":{"day":..,"activity":".."}}
  ]
}

CRITERIOS GLOBALES:
- Corrige horas plausibles (sin solapes ni secuencias ilógicas).
- Transporte lógico según actividad:
  • Barco para whale watching.  
  • Tour/bus para excursiones interurbanas.  
  • Tren/bus/auto para traslados razonables.  
  • A pie/metro en zonas urbanas compactas.
- Day trips ≤ 2 h por trayecto; si no es posible, "removed" con reason "distance:" + sugerencia alternativa.
- Seguridad y restricciones:
  • Si hay riesgo evidente, restricción oficial, alerta razonable o ventana horaria insegura, "removed" con reason "risk:" + sugerencia segura o reubicación alternativa.
  • Prioriza siempre opciones plausibles, seguras y razonables.
- Notas NUNCA vacías ni "seed"; añade tip breve útil y contextual.
- Si duración en minutos, permite "90m" o "1.5h".
- Máx. 20 filas/día; prioriza actividades icónicas y no redundantes.
- Respetar la lógica contextual de la ciudad y temporada.

🕒 **Horarios y plausibilidad reforzada**:
- Si no hay horario definido para el día, usa ventana base 08:30–19:00.
- Extiende horarios solo cuando tenga sentido logístico o turístico (cenas, auroras, tours nocturnos).
- Si extiendes un día por actividad nocturna, considera compensar el inicio del siguiente día (inicio más tarde).
- No heredes horarios directamente de un día al otro.
- Añade buffers realistas entre actividades (≥15 min por defecto).
- Evita solapamientos, horarios absurdos (ej. tours a las 03:00 sin justificación) o secuencias logísticas incoherentes.
- Si detectas horarios irreales, corrígelos proactivamente y añade una nota clara al respecto.

CASOS ESPECIALES:
1) Whale watching:
   - Transporte: "Barco".
   - Salida desde puerto local.
   - Duración: 3–4h aprox.
   - Incluir "valid:" por temporada si aplica.
   - Horario típico: diurno (09:00–15:00 aprox.).

2) Auroras boreales:
   - Siempre en horario nocturno (20:00–02:30 aprox.).
   - Transporte: "Tour", "Bus/Van tour" o "Auto" si procede.
   - Incluir "valid:" con justificación (temporada/latitud).
   - Si aparece fuera de este rango → corregir horario automáticamente o "removed" con reason "valid:season".
   - Si no es temporada o no es plausible en el destino → "removed" con sugerencia alternativa.
   - Si la actividad extiende mucho la jornada, **ajusta el inicio del día siguiente**.

3) Rutas en coche (círculo dorado/costas u otras escénicas):
   - Duración total: 3–6h con paradas clave.
   - Si no hay coche ni tour viable, marcar "logistics" o "risk" y sugerir tour alternativo.
   - Horario plausible: diurno.

4) Museos/monumentos:
   - Horario diurno (aprox. 09:00–18:00).
   - No programar en horarios absurdos o nocturnos.

5) Cenas/vida nocturna:
   - Horario plausible: 19:00–23:30 aprox.
   - Considerar buffers con actividades previas y traslados realistas.

REGLAS DE FUSIÓN:
- Devuelve "allowed" ya corregidas; solo pasa a "removed" lo incompatible.
- Ajusta actividades de manera inteligente antes de removerlas, cuando sea posible.

Contexto:
- Ciudad: "${city}"
- Fecha base (Día 1): ${baseDate || 'N/A'}
- Filas a validar: ${JSON.stringify(rows)}
`.trim();

  try{
    const res = await callAgent(payload, true);
    const parsed = parseJSON(res);
    if(parsed?.allowed) return parsed;
  }catch(e){ console.warn('Validator error', e); }

  // Fail-open con sanitización mínima de notes
  const sanitized = (rows||[]).map(r => {
    const notes = (r.notes||'').trim();
    return { ...r, notes: notes && notes.toLowerCase()!=='seed' ? notes : 'Sugerencia: verifica horarios, seguridad básica y reserva con antelación.' };
  });
  return { allowed: sanitized, removed: [] };
}

/* ==============================
   SECCIÓN 15 · Generación por ciudad (modificada v63)
================================= */
function setOverlayMessage(msg='Astra está generando itinerarios…'){
  const p = $overlayWOW?.querySelector('p');
  if(p) p.textContent = msg;
}

function showWOW(on, msg){
  if(!$overlayWOW) return;
  if(msg) setOverlayMessage(msg);
  $overlayWOW.style.display = on ? 'flex' : 'none';

  const all = qsa('button, input, select, textarea');
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

async function generateCityItinerary(city){
  const dest  = savedDestinations.find(x=>x.city===city);
  if(!dest) return;

  const perDay = Array.from({length:dest.days}, (_,i)=>{
    const src  = (cityMeta[city]?.perDay||[])[i] || dest.perDay?.[i] || {};
    return { day:i+1, start: src.start || DEFAULT_START, end: src.end || DEFAULT_END };
  });

  const baseDate = cityMeta[city]?.baseDate || dest.baseDate || '';
  const hotel    = cityMeta[city]?.hotel || '';
  const transport= cityMeta[city]?.transport || 'recomiéndame';

  // 🧭 Detectar si se debe forzar replanificación
  const forceReplan = (typeof plannerState !== 'undefined' && plannerState.forceReplan && plannerState.forceReplan[city]) ? true : false;

  // ⚠️ Limpieza de historial para evitar sesgos entre ciudades
  if (typeof session !== 'undefined' && Array.isArray(session)) {
    session.length = 0;
  }

  const instructions = `
${FORMAT}
**ROL:** Planificador “Astra”. Crea itinerario completo SOLO para "${city}" (${dest.days} día/s).
- Formato B {"destination":"${city}","rows":[...],"replace": ${forceReplan ? 'true' : 'false'}}.

🚨 **COBERTURA OBLIGATORIA:**
- Devuelve actividades para TODOS los días 1 a ${dest.days}.
- Si el usuario no proporcionó horarios para algunos días, usa como base 08:30–19:00 y amplía inteligentemente si hay actividades nocturnas (auroras, cenas, tours especiales).
- NO dejes ningún día sin actividades.
- Cada fila debe incluir el campo "day" correcto.
- Incluye imperdibles diurnos y nocturnos.
- Si el número total de días es ≥ 4, sugiere automáticamente UN (1) day trip a un imperdible cercano (≤ 2 h por trayecto, ida y vuelta el mismo día).

🕒 **Horarios inteligentes y plausibles:**
- Si el usuario definió horario, respétalo.
- Si no hay horario definido, usa 08:30–19:00 como base diaria.
- Extiende horarios sólo cuando sea razonable:
  • Auroras: 20:00–02:30 aprox. (nunca en horario diurno).  
  • Cenas y vida nocturna: 19:00–23:30 aprox.
- Si extiendes el horario de un día, ajusta de forma inteligente el inicio del siguiente.
- ❌ No heredes horarios directamente entre días.
- Añade buffers realistas entre actividades (≥15 min).

🌍 **Lógica de actividades y seguridad:**
- Agrupar por zonas, evitar solapamientos.
- ❌ NO DUPLICAR actividades ya existentes en ningún día:
  • Siempre verifica todas las actividades de la ciudad antes de proponer nuevas.
  • Si ya existe, sustituye por alternativa distinta.
- Validar plausibilidad global y seguridad:
  • Si actividad especial es plausible, añadir "notes" con "valid: <justificación>".
  • Evitar actividades en zonas o franjas horarias con alertas, riesgos o restricciones evidentes.
  • Sustituir por alternativas seguras cuando aplique.
- Si quedan días sin contenido, distribuye actividades plausibles y/o day trips (≤2 h por trayecto) sin duplicar otras noches.
- Notas SIEMPRE informativas (nunca vacías ni "seed").

Contexto actual:
${buildIntake()}
`.trim();

  showWOW(true, 'Astra está generando itinerarios…');
  const text = await callAgent(instructions, false);
  const parsed = parseJSON(text);

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    let tmpCity = city;
    let tmpRows = [];
    if(parsed.rows){ tmpRows = parsed.rows.map(r=>normalizeRow(r)); }
    else if(parsed.destination && parsed.destination===city){ tmpRows = parsed.rows?.map(r=>normalizeRow(r))||[]; }
    else if(Array.isArray(parsed.destinations)){
      const dd = parsed.destinations.find(d=> (d.name||d.destination)===city);
      tmpRows = (dd?.rows||[]).map(r=>normalizeRow(r));
    }else if(Array.isArray(parsed.itineraries)){
      const ii = parsed.itineraries.find(x=> (x.city||x.name||x.destination)===city);
      tmpRows = (ii?.rows||[]).map(r=>normalizeRow(r));
    }

    // 🧼 FILTRO LOCAL · Eliminar duplicados si existieran en la generación inicial
    const existingActs = Object.values(itineraries[city]?.byDay || {})
      .flat()
      .map(r => String(r.activity || '').trim().toLowerCase());
    tmpRows = tmpRows.filter(r => !existingActs.includes(String(r.activity || '').trim().toLowerCase()));

    const val = await validateRowsWithAgent(tmpCity, tmpRows, baseDate);
    pushRows(tmpCity, val.allowed, forceReplan);

    // 🧭 PASADA FINAL · Rellenar días vacíos si el modelo no los devolvió
    ensureDays(tmpCity);
    for (let d = 1; d <= dest.days; d++) {
      if (!(itineraries[tmpCity].byDay?.[d] || []).length) {
        await optimizeDay(tmpCity, d);
      }
    }

    renderCityTabs(); setActiveCity(tmpCity); renderCityItinerary(tmpCity);
    showWOW(false);

    $resetBtn?.removeAttribute('disabled');
    if(forceReplan && plannerState.forceReplan) delete plannerState.forceReplan[city];

    return;
  }

  renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
  showWOW(false);
  $resetBtn?.removeAttribute('disabled');
  chatMsg('⚠️ Fallback local: revisa configuración de Vercel o API Key.', 'ai');
}

/* 🆕 Rebalanceo masivo tras cambios (agregar días / day trip pedido) */
async function rebalanceWholeCity(city, opts={}){
  const data = itineraries[city];
  const totalDays = Object.keys(data.byDay||{}).length;
  const perDay = Array.from({length: totalDays}, (_,i)=>{
    const src = (cityMeta[city]?.perDay||[]).find(x=>x.day===i+1) || {start:DEFAULT_START,end:DEFAULT_END};
    return { day:i+1, start: src.start||DEFAULT_START, end: src.end||DEFAULT_END };
  });
  const baseDate = data.baseDate || cityMeta[city]?.baseDate || '';
  const wantedTrip = (opts.dayTripTo||'').trim();

  // 🆕 Determinar rango de rebalanceo
  const startDay = opts.start || 1;
  const endDay = opts.end || totalDays;
  const lockedDaysText = startDay > 1 
    ? `Mantén intactos los días 1 a ${startDay - 1}.`
    : '';

  // 🧭 Detectar si se debe forzar replanificación
  const forceReplan = (typeof plannerState !== 'undefined' && plannerState.forceReplan && plannerState.forceReplan[city]) ? true : false;

  const prompt = `
${FORMAT}
**ROL:** Reequilibra la ciudad "${city}" entre los días ${startDay} y ${endDay}, manteniendo lo ya plausible y completando huecos.
${lockedDaysText}
- Formato B {"destination":"${city}","rows":[...],"replace": ${forceReplan ? 'true' : 'false'}}.
- Respeta ventanas: ${JSON.stringify(perDay.filter(x => x.day >= startDay && x.day <= endDay))}, pero puedes proponer horarios diferentes si tienen sentido logístico.

🕒 **Horarios inteligentes:**
- Usa 08:30–19:00 como base cuando no haya horarios definidos.
- Puedes extender horarios cuando sea razonable (auroras: 20:00–02:30, cenas: 19:00–23:30).
- Si extiendes fuertemente un día, ajusta de forma inteligente el inicio del siguiente.
- No heredes horarios entre días.

- Considera IMPERDIBLES y actividades distribuidas sin duplicar.
- Day trips (opcional): si es viable y/o solicitado, añade UN (1) día de excursión (≤2 h por trayecto, ida y vuelta el mismo día) a un imperdible cercano con traslado + actividades + regreso.
${wantedTrip ? `- El usuario indicó preferencia de day trip a: "${wantedTrip}". Si es razonable, úsalo exactamente 1 día.` : `- Si el número total de días es ≥ 4 y no se indicó destino, sugiere automáticamente un imperdible cercano.`}
- ❌ NO DUPLICAR actividades existentes en ningún día.
  • Si ya existe, sustituye por alternativa distinta.
- El último día debe ser más liviano, respetando lógica de preparación de regreso.
- Valida plausibilidad y seguridad global:
  • No propongas actividades en zonas con riesgos relevantes o restricciones evidentes.
  • Si hay alerta razonable, sustitúyelo por alternativa más segura o indica brevemente en notes.
- Notas SIEMPRE útiles (nunca vacías ni "seed").
Contexto actual (para fusionar sin borrar): 
${buildIntake()}
`.trim();

  showWOW(true,'Reequilibrando la ciudad…');
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

    // 🧼 FILTRO LOCAL · Eliminar duplicados usando plannerState.existingActs si está disponible
    let existingActs = Object.values(itineraries[city]?.byDay || {})
      .flat()
      .map(r => String(r.activity || '').trim().toLowerCase());
    if(plannerState.existingActs && plannerState.existingActs[city]){
      existingActs = [...new Set([...existingActs, ...Array.from(plannerState.existingActs[city])])];
    }
    rows = rows.filter(r => !existingActs.includes(String(r.activity || '').trim().toLowerCase()));

    const val = await validateRowsWithAgent(city, rows, baseDate);
    pushRows(city, val.allowed, forceReplan);

    // 🧠 Optimiza solo el rango de días afectado
    for(let d=startDay; d<=endDay; d++) await optimizeDay(city, d);

    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    showWOW(false);
    $resetBtn?.removeAttribute('disabled');

    if(forceReplan && plannerState.forceReplan) delete plannerState.forceReplan[city];

  }else{
    showWOW(false);
    $resetBtn?.removeAttribute('disabled');
    chatMsg('No recibí cambios válidos para el rebalanceo. ¿Intentamos de otra forma?','ai');
  }
}

/* =========================================================
   ITRAVELBYMYOWN · PLANNER v55.1 (parte 3/3)
   Base: v54  ✅
========================================================= */

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
  // ✅ Si ya se procesaron todos los destinos
  if(metaProgressIndex >= savedDestinations.length){
    collectingHotels = false;
    chatMsg(tone.confirmAll);

    (async ()=>{
      showWOW(true, 'Astra está generando itinerarios…');

      // 🧠 OPTIMIZADO: en lugar de for secuencial, uso concurrencia controlada
      const taskFns = savedDestinations.map(({city}) => async () => {
        await generateCityItinerary(city);
      });
      await runWithConcurrency(taskFns);

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

  // ✅ Si no hay hotel definido, no avanzar hasta que el usuario lo indique
  const currentHotel = cityMeta[city].hotel || '';
  if(!currentHotel.trim()){
    setActiveCity(city);
    renderCityItinerary(city);
    chatMsg(tone.askHotelTransport(city), 'ai');
    return;
  }

  // 🧭 Avanzar al siguiente destino si ya hay hotel guardado
  metaProgressIndex++;
  askNextHotelTransport();
}

/* ==============================
   SECCIÓN 17 · NLU robusta + Intents (v61 extendida)
   (expande regex e intents para day trips y preferencias dinámicas)
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

// 🧠 OPTIMIZADO: precomputar listas de ciudades lowercased y ordenar una sola vez
let cachedCityList = [];
function refreshCityCache(){
  cachedCityList = savedDestinations
    .map(d=>d.city)
    .filter(Boolean)
    .sort((a,b)=>b.length - a.length)
    .map(c=>({orig:c, low:c.toLowerCase()}));
}

function detectCityInText(text){
  const lowered = text.toLowerCase();
  if(!cachedCityList.length) refreshCityCache();
  for(const {orig,low} of cachedCityList){
    if(lowered.includes(low)) return orig;
  }
  // Fuzzy extra
  for(const {orig,low} of cachedCityList){
    if(low.startsWith(lowered) || lowered.startsWith(low)) return orig;
    if(levenshteinDistance(lowered, low) <= 2) return orig;
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

  // ✅ Confirmaciones y cancelaciones
  if(/^(sí|si|ok|dale|hazlo|confirmo|de una|aplica)\b/.test(t)) return {type:'confirm'};
  if(/^(no|mejor no|cancela|cancelar|cancelá)\b/.test(t)) return {type:'cancel'};

  // ✅ Agregar un día al FINAL (prioridad sobre varios días)
  if(/\b(me\s+quedo|quedarme)\s+un\s+d[ií]a\s+m[aá]s\b/.test(t) || /\b(un\s+d[ií]a\s+m[aá]s)\b/.test(t) || /(agrega|añade|suma)\s+un\s+d[ií]a/.test(t)){
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    const placeM = t.match(/para\s+ir\s+a\s+([a-záéíóúüñ\s]+)$/i);
    return {type:'add_day_end', city, dayTripTo: placeM ? placeM[1].trim() : null};
  }

  // ✅ Agregar varios días — robusto + soporte para "y uno para ir a Segovia"
  const addMulti = t.match(/(agrega|añade|suma|extiende|prolonga|quedarme|me\s+quedo|me\s+voy\s+a\s+quedar)\s+(\d+|\w+)\s+(d[ií]as?|noches?)(?:.*?y\s+uno\s+para\s+ir\s+a\s+([a-záéíóúüñ\s]+))?/i);
  if(addMulti){
    const n = WORD_NUM[addMulti[2]] || parseInt(addMulti[2],10) || 1;
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    const dayTripTo = addMulti[4] ? addMulti[4].trim() : null;
    return {type:'add_days', city, extraDays:n, dayTripTo};
  }

  // ✅ “Quiero un tour de un día / preferDayTrip” aunque no se agreguen días
  if(/\b(tour de un d[ií]a|excursi[oó]n de un d[ií]a|algo fuera de la ciudad|un viaje de un d[ií]a)\b/.test(t)){
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    const placeM = t.match(/a\s+([a-záéíóúüñ\s]+)$/i);
    return {type:'prefer_day_trip', city, dayTripTo: placeM ? placeM[1].trim() : null};
  }

  // ✅ Eliminar día
  const rem = t.match(/(quita|elimina|borra)\s+el\s+d[ií]a\s+(\d+)/i);
  if(rem){ return {type:'remove_day', city: detectCityInText(t) || detectCityFromCountryInText(t) || activeCity, day: parseInt(rem[2],10)}; }

  // ✅ Intercambiar días
  const swap = t.match(/(?:pasa|mueve|cambia)\s+el\s+d[ií]a\s+(\d+)\s+(?:al|a)\s+(?:d[ií]a\s+)?(\d+)/i);
  if(swap && !/actividad|museo|visita|tour|cena|almuerzo|desayuno/i.test(t)){
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    return {type:'swap_day', city, from: parseInt(swap[1],10), to: parseInt(swap[2],10)};
  }

  // ✅ Mover actividad
  const mv = t.match(/(?:mueve|pasa|cambia)\s+(.*?)(?:\s+del\s+d[ií]a\s+(\d+)|\s+del\s+(\d+))\s+(?:al|a)\s+(?:d[ií]a\s+)?(\d+)/i);
  if(mv){ return {type:'move_activity', city: detectCityInText(t) || detectCityFromCountryInText(t) || activeCity, query:(mv[1]||'').trim(), fromDay:parseInt(mv[2]||mv[3],10), toDay:parseInt(mv[4],10)}; }

  // ✅ Swap activity por texto natural
  if(/\b(no\s+quiero|sustituye|reemplaza|quita|elimina|borra)\b/.test(t)){
    const city = detectCityInText(t) || detectCityFromCountryInText(t) || activeCity;
    const m = t.match(/no\s+quiero\s+ir\s+a\s+(.+?)(?:,|\.)?$/i);
    return {type:'swap_activity', city, target: m ? m[1].trim() : null, details:text};
  }

  // ✅ Horarios personalizados
  const range = parseTimeRangeFromText(text);
  if(range.start || range.end) return {type:'change_hours', city: detectCityInText(t) || detectCityFromCountryInText(t) || activeCity, range};

  // ✅ Añadir ciudad nueva
  const addCity = t.match(/(?:agrega|añade|suma)\s+([a-záéíóúüñ\s]+?)\s+(?:con\s+)?(\d+)\s*d[ií]as?(?:\s+(?:desde|iniciando)\s+(\d{1,2}\/\d{1,2}\/\d{4}))?/i);
  if(addCity){
    return {type:'add_city', city: addCity[1].trim(), days:parseInt(addCity[2],10), baseDate:addCity[3]||''};
  }

  // ✅ Eliminar ciudad
  const delCity = t.match(/(?:elimina|borra|quita)\s+(?:la\s+ciudad\s+)?([a-záéíóúüñ\s]+)/i);
  if(delCity){ return {type:'remove_city', city: delCity[1].trim()}; }

  // ✅ Actualizar perfil de preferencias (pace, transporte, movilidad, niños, dieta, etc.)
  if(/\b(ritmo|relax|tranquilo|aventura|rápido|balanceado|niños|movilidad|caminar poco|transporte|uber|metro|autob[uú]s|bus|auto|veh[ií]culo|dieta|vegetariano|vegano|gluten|cel[ií]aco|preferencia|preferencias)\b/.test(t)){
    return {type:'set_profile', details:text};
  }

  // ✅ Preguntas informativas (clima, seguridad, etc.)
  if(/\b(clima|tiempo|temperatura|lluvia|horas de luz|moneda|cambio|propina|seguridad|visado|visa|fronteras|aduana|vuelos|aerol[ií]neas|equipaje|salud|vacunas|enchufes|taxis|alquiler|conducci[oó]n|peatonal|festivos|temporada|mejor época|gastronom[ií]a|restaurantes|precios|presupuesto|wifi|sim|roaming)\b/.test(t)){
    return {type:'info_query', details:text};
  }

  // 🆓 Edición libre (fallback)
  return {type:'free_edit', details:text};
}

/* ==============================
   SECCIÓN 18 · Edición/Manipulación + Optimización + Validación (v61 extendida)
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

  // 🧠 Bloque adicional si la ciudad está marcada para replanificación o hay day trip pendiente
  let forceReplanBlock = '';
  const hasForceReplan = (typeof plannerState !== 'undefined' && plannerState.forceReplan && plannerState.forceReplan[city]);
  const hasDayTripPending = (typeof plannerState !== 'undefined' && plannerState.dayTripPending && plannerState.dayTripPending[city]);
  const hasPreferDayTrip = (typeof plannerState !== 'undefined' && plannerState.preferences && plannerState.preferences.preferDayTrip);

  if (hasForceReplan || hasDayTripPending || hasPreferDayTrip) {
    forceReplanBlock = `
👉 IMPORTANTE:
- El usuario ha extendido su estadía o indicó preferencia por un tour de 1 día en ${city}.
- REEQUILIBRA el itinerario de ${city} considerando el nuevo total de días.
- Evalúa siempre la posibilidad de realizar excursiones de 1 día a ciudades cercanas (máx. 2 h de trayecto por sentido).
- Si las excursiones aportan más valor turístico que actividades locales adicionales, inclúyelas en el itinerario.
- Si el usuario especificó un destino concreto (dayTripTo), programa ese tour automáticamente.
- Prioriza imperdibles locales primero y evita duplicar cualquier actividad ya existente.
- Respeta ritmo, movilidad y preferencias de viaje (perfil usuario).
- Devuelve una planificación clara y optimizada.
    `;
  }

  // 🧠 OPTIMIZADO: intake reducido si no hay cambios globales
  const intakeData = (hasForceReplan || hasDayTripPending || hasPreferDayTrip)
    ? buildIntake()        // Full contexto solo si es replanificación completa o hay day trip pendiente
    : buildIntakeLite();   // ⚡ más liviano para recalculos simples

  const prompt = `
${FORMAT}
Ciudad: ${city}
Día: ${day}
Fecha base (d1): ${baseDate||'N/A'}
Ventanas definidas: ${JSON.stringify(perDay)}
Filas actuales:
${JSON.stringify(rows)}
${forceReplanBlock}
🕒 **Horarios inteligentes**:
- Si no hay horario definido, usa 08:30–19:00 como base.
- Puedes extender horarios cuando sea razonable (cenas, auroras, tours especiales).
- Si extiendes el horario de un día, ajusta inteligentemente el inicio del día siguiente.
- ❌ No heredes horarios directamente entre días.
- Añade buffers realistas entre actividades (≥15 min).

Instrucción:
- Reordena y optimiza (min traslados; agrupa por zonas).
- Sustituye huecos por opciones realistas (sin duplicar otros días).
- Para nocturnas (p.ej. auroras), usa horarios aproximados locales y añade alternativas cercanas si procede.
- Day trips ≤ 2 h por trayecto (ida), si hay tiempo disponible y aportan valor turístico.
- Prioriza imperdibles locales y considera perfil del viajero (ritmo, movilidad reducida, niños, transporte preferido, etc.).
- Valida PLAUSIBILIDAD GLOBAL y SEGURIDAD: 
  • No propongas actividades en zonas con riesgos o restricciones evidentes. 
  • Sustituye por alternativas seguras si aplica.
  • Añade siempre notas útiles (nunca vacías ni “seed”).
- ❌ NO DUPLICAR actividades ya existentes en otros días de la ciudad.
  • Si ya existe una actividad similar, sustitúyela por una alternativa distinta.
- Devuelve C {"rows":[...],"replace":false}.
Contexto:
${intakeData}
`.trim();

  const ans = await callAgent(prompt, true);
  const parsed = parseJSON(ans);
  if(parsed?.rows){
    let normalized = parsed.rows.map(x=>normalizeRow({...x, day}));

    // 🧼 FILTRO LOCAL · Eliminar duplicados ya existentes
    const allExisting = Object.values(itineraries[city].byDay || {})
      .flat()
      .filter(r => r.day !== day)
      .map(r => String(r.activity||'').trim().toLowerCase());

    normalized = normalized.filter(r=>{
      const act = String(r.activity||'').trim().toLowerCase();
      return act && !allExisting.includes(act);
    });

    const val = await validateRowsWithAgent(city, normalized, baseDate);
    pushRows(city, val.allowed, false);
  }
}

/* ==============================
   SECCIÓN 19 · Chat handler (global)
   — Optimizada con misma estructura comentada + day trip preference
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

  // Detecta intent
  const intent = intentFromText(text);

  // ============================================================
  // 🆕 0) Preferencia general de day trip sin agregar días
  // ============================================================
  if(intent.type === 'free_edit' && /\b(tour|excursi[oó]n|day\s*trip|un\s*d[ií]a\s+fuera|quiero\s+ir\s+a\s+un\s+lugar\s+cercano)\b/i.test(text)){
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
  // 3) Agregar día al FINAL (con o sin day trip semilla)
  // ============================================================
  if(intent.type==='add_day_end' && intent.city){
    const city = intent.city;
    showWOW(true,'Insertando día y optimizando…');
    ensureDays(city);
    const byDay = itineraries[city].byDay || {};
    const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
    const numericPos = days.length + 1;
    insertDayAt(city, numericPos);

    // Semilla para day trip si aplica
    if(intent.dayTripTo){
      const start = cityMeta[city]?.perDay?.find(x=>x.day===numericPos)?.start || DEFAULT_START;
      const end   = cityMeta[city]?.perDay?.find(x=>x.day===numericPos)?.end   || DEFAULT_END;
      const rowsSeed = [
        {day:numericPos,start, end:addMinutes(start,60), activity:`Traslado a ${intent.dayTripTo}`, from: city, to: intent.dayTripTo, transport:'Tren/Bus', duration:'60m', notes:`Traslado de ida para excursión de 1 día (aprox.).`},
        {day:numericPos,start:addMinutes(start,70), end:addMinutes(start,190), activity:`Visita principal en ${intent.dayTripTo}`, from:intent.dayTripTo, to:'', transport:'A pie', duration:'120m', notes:`Tiempo sugerido para lo esencial y fotos.`},
        {day:numericPos,start:addMinutes(start,200), end:addMinutes(start,290), activity:`Almuerzo en ${intent.dayTripTo}`, from:intent.dayTripTo, to:'', transport:'A pie', duration:'90m', notes:`Pausa para comer.`},
        {day:numericPos,start:addMinutes(start,300), end:addMinutes(start,420), activity:`Recorrido por ${intent.dayTripTo}`, from:intent.dayTripTo, to:'', transport:'A pie/Bus', duration:'120m', notes:`Paseo por puntos cercanos antes del regreso.`},
        {day:numericPos,start:addMinutes(start,430), end, activity:`Regreso a ${city}`, from:intent.dayTripTo, to:city, transport:'Tren/Bus', duration:'', notes:`Regreso a la ciudad base el mismo día.`}
      ];
      pushRows(city, rowsSeed, false);
    }

    await optimizeDay(city, numericPos);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    showWOW(false);
    chatMsg('✅ Día agregado y plan reoptimizado globalmente.','ai');
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
    await Promise.all([optimizeDay(intent.city, intent.from), optimizeDay(intent.city, intent.to)]);
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
    await Promise.all([optimizeDay(intent.city, intent.fromDay), optimizeDay(intent.city, intent.toDay)]);
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
  // 8) Cambiar horas
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

🕒 **Horarios inteligentes**:
- Si no hay horario definido, usa 08:30–19:00 como base.
- Puedes extender horarios cuando sea razonable (auroras, cenas, tours especiales).
- Si extiendes el horario de un día, ajusta inteligentemente el inicio del día siguiente.
- ❌ No heredes horarios directamente entre días.
- Añade buffers realistas entre actividades (≥15 min).

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
        e.target.setSelectionRange(pos - (original.length - filtered.length), pos - (original.length - filtered.length));
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
    qsa('.date-tooltip').forEach(t => t.remove());

    // 🔄 Restaurar formulario lateral a valores por defecto
    const $sc = qs('#special-conditions'); if($sc) $sc.value = '';
    const $ad = qs('#p-adults');   if($ad) $ad.value = '1';
    const $yo = qs('#p-young');    if($yo) $yo.value = '0';
    const $ch = qs('#p-children'); if($ch) $ch.value = '0';
    const $in = qs('#p-infants');  if($in) $in.value = '0';
    const $se = qs('#p-seniors');  if($se) $se.value = '0';
    const $bu = qs('#budget');     if($bu) $bu.value = '';
    const $cu = qs('#currency');   if($cu) $cu.value = 'USD';

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
  qs('#monetization-upsell').style.display='flex'; 
});
$upsellClose?.addEventListener('click', ()=> qs('#monetization-upsell').style.display='none');

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

