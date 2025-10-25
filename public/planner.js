/* =========================================================
   ITRAVELBYMYOWN · PLANNER v56 (parte 1/3)
   Base: v55.1
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
let itineraries = {};            // { [city]: { byDay:{[n]:Row[]}, currentDay, baseDate } }
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
   SECCIÓN 6 · UI ciudades (sidebar)
================================= */
function makeHoursBlock(days){
  const wrap = document.createElement('div');
  wrap.className = 'hours-block';

  // Agregar encabezado único de horas
  const header = document.createElement('div');
  header.className = 'hours-header';
  header.innerHTML = `
    <span></span>
    <span class="header-start">Hora Inicio</span>
    <span class="header-end">Hora Final</span>
  `;
  wrap.appendChild(header);

  // 🆕 Dropdown de horas y minutos
  const hourOptions = Array.from({length:24},(_,i)=>
    `<option value="${String(i).padStart(2,'0')}">${String(i).padStart(2,'0')}</option>`
  ).join('');
  const minuteOptions = Array.from({length:12},(_,i)=>{
    const m = String(i*5).padStart(2,'0');
    return `<option value="${m}">${m}</option>`;
  }).join('');

  for(let d=1; d<=days; d++){
    const row = document.createElement('div');
    row.className = 'hours-day';
    row.innerHTML = `
      <span>Día ${d}</span>
      <div class="time-select start">
        <select class="hour-select start-hour" aria-label="Hora inicio (horas)">${hourOptions}</select> :
        <select class="minute-select start-minute" aria-label="Hora inicio (minutos)">${minuteOptions}</select>
      </div>
      <div class="time-select end">
        <select class="hour-select end-hour" aria-label="Hora final (horas)">${hourOptions}</select> :
        <select class="minute-select end-minute" aria-label="Hora final (minutos)">${minuteOptions}</select>
      </div>
    `;
    wrap.appendChild(row);
  }
  return wrap;
}

function addCityRow(pref={city:'',country:'',days:'',baseDate:''}){
  const row = document.createElement('div');
  row.className = 'city-row';

  // 🆕 Bloque de selects para fecha en formato dd/mm/aaaa
  const dayOptions = `<option value="" disabled selected>dd</option>` +
    Array.from({length:31},(_,i)=>
      `<option value="${String(i+1).padStart(2,'0')}">${String(i+1).padStart(2,'0')}</option>`
    ).join('');

  const monthOptions = `<option value="" disabled selected>mm</option>` +
    [
      'Enero','Febrero','Marzo','Abril','Mayo','Junio',
      'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'
    ].map((m,i)=>`<option value="${String(i+1).padStart(2,'0')}">${m}</option>`).join('');

  row.innerHTML = `
    <label>Ciudad<input class="city" placeholder="Ciudad" value="${pref.city||''}"></label>
    <label>País<input class="country" placeholder="País" value="${pref.country||''}"></label>
    <label>Días<select class="days"><option value="" selected disabled></option>${Array.from({length:30},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join('')}</select></label>
    <label class="date-label">
      Inicio
      <div class="date-wrapper">
        <div class="date-input-group">
          <select class="baseDay">${dayOptions}</select>
          <span class="date-separator">/</span>
          <select class="baseMonth">${monthOptions}</select>
          <span class="date-separator">/</span>
          <input class="baseYear" type="text" maxlength="4" placeholder="aaaa" inputmode="numeric">
        </div>
      </div>
    </label>
    <button class="remove" type="button">✕</button>
  `;

  // 🧩 Cargar fecha previa si existe (pref.baseDate en formato DD/MM/AAAA)
  if(pref.baseDate){
    const [d,m,y] = pref.baseDate.split('/');
    qs('.baseDay',row).value = d||'';
    qs('.baseMonth',row).value = m||'';
    qs('.baseYear',row).value = y||'';
  }

  // 🕐 Horas
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
   SECCIÓN 7 · Guardar destinos ✅ FLEXIBLE
================================= */
function saveDestinations(){
  const rows = qsa('.city-row', $cityList);
  const list = [];

  rows.forEach(r=>{
    const city     = qs('.city',r).value.trim();
    const country  = qs('.country',r).value.trim().replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g,'');
    const daysVal  = qs('.days',r).value;
    const days     = Math.max(1, parseInt(daysVal||'0',10)||1);

    // 🗓️ Construcción de baseDate
    const daySel = qs('.baseDay', r)?.value || '';
    const monthSel = qs('.baseMonth', r)?.value || '';
    const yearSel = qs('.baseYear', r)?.value || '';
    const baseDate = (daySel && monthSel && yearSel) ? `${daySel}/${monthSel}/${yearSel}` : '';

    if(!city) {
      console.warn('Fila sin ciudad ignorada');
      return;
    }

    // ⏰ Horarios por día
    const perDay = [];
    qsa('.hours-day', r).forEach((hd, idx)=>{
      const start = qs('.start',hd)?.value || DEFAULT_START;
      const end   = qs('.end',hd)?.value   || DEFAULT_END;
      perDay.push({ day: idx+1, start, end });
    });
    if(perDay.length === 0){
      for(let d=1; d<=days; d++) perDay.push({day:d,start:DEFAULT_START,end:DEFAULT_END});
    }

    list.push({ city, country, days, baseDate, perDay });
  });

  savedDestinations = list;

  // 🧭 Actualiza itinerarios y metadatos de ciudades
  savedDestinations.forEach(({city,days,baseDate,perDay})=>{
    if(!itineraries[city]) itineraries[city] = { byDay:{}, currentDay:1, baseDate: baseDate || null };
    if(!cityMeta[city]) cityMeta[city] = { baseDate: baseDate || null, start:null, end:null, hotel:'', transport:'', perDay: perDay || [] };
    else {
      cityMeta[city].baseDate = baseDate || null;
      cityMeta[city].perDay   = perDay || [];
    }
    for(let d=1; d<=days; d++){
      if(!itineraries[city].byDay[d]) itineraries[city].byDay[d] = [];
    }
  });

  // 🧹 Limpia ciudades eliminadas
  Object.keys(itineraries).forEach(c=>{
    if(!savedDestinations.find(x=>x.city===c)) delete itineraries[c];
  });
  Object.keys(cityMeta).forEach(c=>{
    if(!savedDestinations.find(x=>x.city===c)) delete cityMeta[c];
  });

  renderCityTabs();

  // 🧠 Construir plannerState con información opcional
  plannerState = {
    destinations: savedDestinations,
    specialConditions: $specialConditions?.value.trim() || '',
    travelers: {
      adults: parseInt($pAdults?.value || 0),
      young: parseInt($pYoung?.value || 0),
      children: parseInt($pChildren?.value || 0),
      infants: parseInt($pInfants?.value || 0),
      seniors: parseInt($pSeniors?.value || 0),
    },
    budget: {
      amount: parseFloat($budget?.value || 0),
      currency: $currency?.value || 'USD'
    }
  };

 // ✅ Activar / desactivar botones según haya destinos
if (savedDestinations.length > 0) {
  // 1. Bloquea sidebar primero
  if ($sidebar) $sidebar.classList.add('disabled');
  if ($infoFloating) {
    $infoFloating.style.pointerEvents = 'none';
    $infoFloating.style.opacity = '0.6';
  }

  // 2. 🔥 Reforzar activación después del bloqueo visual
  if ($start) {
    $start.disabled = false;
    $start.removeAttribute('disabled');
  }
  if ($resetBtn) {
    $resetBtn.disabled = false;
    $resetBtn.removeAttribute('disabled');
  }
} else {
  if ($start) $start.disabled = true;
  if ($resetBtn) $resetBtn.setAttribute('disabled', 'true');
}

/* ==============================
   SECCIÓN 8 · Tabs + Render + Actualización plannerState
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

  // 🧠 Actualiza plannerState con toda la información del sidebar
  updatePlannerStateFromSidebar();
}

/* ==============================
   🧠 Función auxiliar: Actualizar plannerState desde Sidebar
================================= */
function updatePlannerStateFromSidebar(){
  // 🗺️ Destinos
  const cities = [...document.querySelectorAll('.city-row')].map(row => {
    const cityName = row.querySelector('.city')?.value?.trim();
    const country = row.querySelector('.country')?.value?.trim();
    const day = row.querySelector('.baseDay')?.value;
    const month = row.querySelector('.baseMonth')?.value;
    const year = row.querySelector('.baseYear')?.value;
    const daysVal = row.querySelector('.days')?.value || '1';

    const startHour = row.querySelector('.hour-select[data-type="start"]')?.value;
    const startMinute = row.querySelector('.minute-select[data-type="start"]')?.value;
    const endHour = row.querySelector('.hour-select[data-type="end"]')?.value;
    const endMinute = row.querySelector('.minute-select[data-type="end"]')?.value;

    return {
      name: cityName || '',
      country: country || '',
      date: `${day}-${month}-${year}`,
      startTime: (startHour && startMinute) ? `${startHour}:${startMinute}` : null,
      endTime: (endHour && endMinute) ? `${endHour}:${endMinute}` : null,
      days: Math.max(1, parseInt(daysVal, 10) || 1)
    };
  }).filter(c => c.name);

  // ✨ Preferencias
  const preferences = document.getElementById('special-conditions')?.value?.trim() || '';

  // 👥 Viajeros
  const travelers = {
    adults: parseInt(document.getElementById('p-adults')?.value || '0', 10),
    young: parseInt(document.getElementById('p-young')?.value || '0', 10),
    children: parseInt(document.getElementById('p-children')?.value || '0', 10),
    infants: parseInt(document.getElementById('p-infants')?.value || '0', 10),
    seniors: parseInt(document.getElementById('p-seniors')?.value || '0', 10)
  };

  // 💰 Presupuesto
  const budgetValue = parseFloat(document.getElementById('budget')?.value || '0');
  const currency = document.getElementById('currency')?.value || 'USD';
  const budget = { amount: budgetValue, currency };

  // 🧠 Guardar en plannerState global
  plannerState.cities = cities;
  plannerState.preferences = preferences;
  plannerState.travelers = travelers;
  plannerState.budget = budget;
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
   SECCIÓN 11 · Contrato JSON / LLM (reforzado v49)
================================= */
const FORMAT = `
Devuelve SOLO JSON válido (sin markdown) en uno de estos:
A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}]}], "followup":"Pregunta breve"}
B) {"destination":"City","rows":[{...}],"replace":false,"followup":"Pregunta breve"}
C) {"rows":[{...}],"replace":false,"followup":"Pregunta breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" | ["HH:MM",...],"end":"HH:MM" | ["HH:MM",...],"hotel":"Texto","transport":"Texto"},"followup":"Pregunta breve"}
Reglas:
- Optimiza el/los día(s) afectado(s) (min traslados, agrupa por zonas, respeta ventanas).
- Usa horas por día del usuario; si faltan, sugiere horas realistas (apertura/cierre).
- Valida PLAUSIBILIDAD GLOBAL (geografía, temporada, clima aproximado, logística).
- Seguridad y restricciones:
  • No incluyas actividades en zonas con riesgos relevantes o restricciones evidentes; prefiera alternativas seguras.
  • Si detectas un posible riesgo/aviso, indica en "notes" un aviso breve (sin alarmismo) o, si es improcedente, exclúyelo.
- Day trips: cuando se agregan días, evalúa imperdibles cercanos (≤2 h por trayecto, regreso mismo día) y proponlos 1 día si encajan.
- Notas: NUNCA dejes "notes" vacío ni "seed"; escribe una nota breve y útil (p. ej., por qué es especial, tip de entrada, reserva sugerida).
- Para actividades estacionales/nocturnas (p. ej. auroras):
  • Inclúyelas SOLO si plausibles para ciudad/fechas aproximadas.
  • Añade en "notes" marcador "valid: <justificación breve>" y hora aproximada típica de inicio local.
  • Propón 1 tour recomendado si tiene sentido y alternativas locales de bajo costo.
- Conserva lo existente por defecto (fusión); NO borres lo actual salvo instrucción explícita (replace=true).
- Máximo 20 filas por día. Nada de texto fuera del JSON.
`;

/* ==============================
   SECCIÓN 12 · Llamada a Astra (estilo global)
================================= */
async function callAgent(text, useHistory = true){
  const history = useHistory ? session : [];
  const globalStyle = `
Eres "Astra", agente de viajes internacional.
- RAZONA con sentido común global: geografía, temporadas, ventanas horarias, distancias y logística básica.
- Identifica IMPERDIBLES diurnos y nocturnos; si el tiempo es limitado, prioriza lo esencial.
- Para fenómenos estacionales (ej. auroras): sugiere 1 tour (si procede) y alternativas cercanas económicas; indica hora de inicio aproximada típica de la ciudad.
- Para PREGUNTAS INFORMATIVAS: responde útil, cálido y concreto; NO sugieras cambios salvo que te lo pidan.
- Para EDICIONES: entrega directamente el JSON según contrato y por defecto FUSIONA (replace=false).
- Si el usuario NO especifica un día concreto, REVISA y reacomoda el ITINERARIO COMPLETO de la ciudad evitando duplicados y absurdos.
- Day trips inteligentes: cuando se agregan días, evalúa excursiones de 1 día a imperdibles cercanos (≤2 h por trayecto) y proponlas si encajan, con regreso a la ciudad base.

🕓 **Ventanas horarias y planificación**:
- RESPETA estrictamente las horas de inicio y final indicadas por el usuario para cada día. Estas horas definen la ventana operativa del itinerario.
- NO propongas actividades fuera de esta ventana. Si alguna atracción no calza, descártala o reemplázala por otra razonable dentro de la ventana.
- Usa horarios típicos de apertura/cierre reales como referencia adicional para evitar sugerir horas inviables.
- Si ajustas horas por razones logísticas, documenta claramente en "notes" el motivo.

🧭 **Atracciones y distribución inteligente**:
- Selecciona y distribuye actividades de forma lógica y geográficamente coherente.
- Da prioridad a grandes atracciones turísticas cercanas (dentro de la misma zona o a ≤30 min de traslado) para optimizar tiempos y evitar solapamientos.
- Maximiza el aprovechamiento de cada día sin sobrecargarlo.
- Para lugares mundialmente reconocidos, propon actividades bien distribuidas a lo largo de la ventana horaria disponible.

🛡️ **Seguridad y plausibilidad**:
- No propongas actividades en zonas con riesgos relevantes, horarios inviables o restricciones evidentes.
- Prioriza siempre rutas y experiencias seguras y razonables.
- Si hay una alerta razonable o restricción, sustituye por una alternativa más segura o indícalo brevemente en “notes” (sin alarmismo).
- Si la hora indicada por el usuario es inviable (por cierre, clima o seguridad), ajústala de forma lógica y documenta en "notes".

📝 **Notas y estilo de salida**:
- Notas SIEMPRE informativas (nunca vacías ni "seed").
- Evita listas locales o sesgos regionales; actúa como experto global.
`.trim();

  try{
    showThinking(true);
    const res = await fetch(API_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ model: MODEL, input: `${globalStyle}\n\n${text}`, history })
    });
    const data = res.ok ? await res.json().catch(()=>({text:''})) : {text:''};
    return data?.text || '';
  }catch(e){
    console.error("Fallo al contactar la API:", e);
    return `{"followup":"${tone.fail}"}`;
  }finally{
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
- Considera factores de seguridad básicos al responder: advierte si hay riesgos relevantes, restricciones o condiciones que puedan afectar la experiencia.
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

  if(Array.isArray(parsed.destinations)){
    parsed.destinations.forEach(d=>{
      const name = d.name || d.destination || d.meta?.city || activeCity || savedDestinations[0]?.city;
      if(!name) return;

      if(d.rowsByDay && typeof d.rowsByDay === 'object'){
        Object.entries(d.rowsByDay).forEach(([k,rows])=>{
          pushRows(name, (rows||[]).map(r=>({...r, day:+k})), Boolean(d.replace));
        });
        return;
      }
      if(Array.isArray(d.rows)) pushRows(name, d.rows, Boolean(d.replace));
    });
    return;
  }
  if(parsed.destination && Array.isArray(parsed.rows)){
    pushRows(parsed.destination, parsed.rows, Boolean(parsed.replace));
    return;
  }
  if(Array.isArray(parsed.itineraries)){
    parsed.itineraries.forEach(x=>{
      const name = x.city || x.name || x.destination || activeCity || savedDestinations[0]?.city;
      if(!name) return;
      if(x.rowsByDay && typeof x.rowsByDay==='object'){
        Object.entries(x.rowsByDay).forEach(([k,rows])=>{
          pushRows(name, (rows||[]).map(r=>({...r, day:+k})), Boolean(x.replace));
        });
      }else if(Array.isArray(x.rows)) pushRows(name, x.rows, Boolean(x.replace));
    });
    return;
  }
  if(Array.isArray(parsed.rows)){
    const city = activeCity || savedDestinations[0]?.city;
    pushRows(city, parsed.rows, Boolean(parsed.replace));
  }
}

/* ==============================
   SECCIÓN 13B · Add Multiple Days (mejorada con rebalanceo automático)
================================= */
function addMultipleDaysToCity(city, extraDays){
  if(!city || extraDays <= 0) return;
  ensureDays(city);

  const byDay = itineraries[city].byDay || {};
  const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  let currentMax = days.length ? Math.max(...days) : 0;

  // 🧼 Corregido: solo agregar días realmente nuevos y evitar duplicados
  for(let i=1; i<=extraDays; i++){
    const newDay = currentMax + i;
    if(!byDay[newDay]){  
      insertDayAt(city, newDay);

      const start = cityMeta[city]?.perDay?.find(x=>x.day===newDay)?.start || DEFAULT_START;
      const end   = cityMeta[city]?.perDay?.find(x=>x.day===newDay)?.end   || DEFAULT_END;
      
      if(!cityMeta[city]) cityMeta[city] = { perDay: [] };
      if(!cityMeta[city].perDay.find(x=>x.day===newDay)){
        cityMeta[city].perDay.push({ day:newDay, start, end });
      }
    }
  }

  // ✅ Actualiza dest.days correctamente
  const dest = savedDestinations.find(x=>x.city===city);
  if(dest){
    const totalExisting = currentMax;
    const totalAdded = extraDays;
    dest.days = totalExisting + totalAdded;
  }

  // 🧽 🆕 Limpieza antes de rebalancear — evita duplicados
  Object.keys(byDay).forEach(d => { 
    byDay[d] = []; 
  });

  // 🧠 Rebalanceo automático tras agregar días
  showWOW(true, 'Astra está reequilibrando la ciudad…');
  rebalanceWholeCity(city)
    .then(() => {
      renderCityTabs();
      setActiveCity(city);
      renderCityItinerary(city);
    })
    .catch(err => {
      console.error('Error en rebalance automático:', err);
      chatMsg('⚠️ No se pudo completar el rebalanceo automáticamente. Intenta manualmente.', 'ai');
    })
    .finally(() => showWOW(false));
}

/* ==============================
   SECCIÓN 14 · Validación GLOBAL (2º paso con IA) — reforzado
   (fusión de criterios fuertes v55)
================================= */
async function validateRowsWithAgent(city, rows, baseDate){
  // 🧠 Información adicional desde plannerState
  const citiesGuide = (plannerState?.cities || []).map(c => `
📍 Ciudad: ${c.name} (${c.country})
📅 Fecha: ${c.date}
🕓 Inicio sugerido: ${c.startTime || 'No especificado'}
🕗 Fin preferido: ${c.endTime || 'No especificado'}
🗓️ Días: ${c.days}
`).join('\n');

  const preferencesGuide = plannerState?.preferences
    ? `✨ Preferencias y restricciones:\n${plannerState.preferences}\n`
    : '';

  const travelersGuide = plannerState?.travelers ? `
👥 Composición del grupo:
- Adultos: ${plannerState.travelers.adults}
- Jóvenes: ${plannerState.travelers.young}
- Niños: ${plannerState.travelers.children}
- Infantes: ${plannerState.travelers.infants}
- Mayores: ${plannerState.travelers.seniors}
` : '';

  const budgetGuide = plannerState?.budget
    ? `💰 Presupuesto total: ${plannerState.budget.amount} ${plannerState.budget.currency}\n`
    : '';

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
- Corrige horas plausibles (sin solapes).
- Transporte lógico según actividad (barco para whale watching; tour/bus para excursiones; tren/bus/auto interurbano; a pie/metro en zona).
- Day trips ≤ 2 h por trayecto; si no, "removed" con reason "distance:" + alternativa.
- Seguridad/restricciones:
  • Si hay riesgo evidente, restricción oficial, alerta razonable o ventana horaria insegura, "removed" con reason "risk:" + sugerencia segura o reubicación alternativa.
  • Prioriza siempre opciones plausibles, seguras y razonables.
- Notas NUNCA vacías ni "seed"; añade tip breve útil.
- Si duración en minutos, permite "90m" o "1.5h".
- Máx. 20 filas/día; prioriza icónicas y no redundantes.

CASOS ESPECIALES:
1) Whale watching: "Barco", salida desde puerto local, 3–4h aprox., incluir "valid:" por temporada si aplica.
2) Auroras: nocturno (20:00–02:00 aprox.), "Tour"/"Bus/Van tour" o "Auto" si procede; "valid:" con justificación.
3) Rutas en coche (círculo dorado/costas): 3–6h conducción total con paradas clave; si sin coche ni tour viable, marca "logistics" o "risk" y sugiere tour.
4) Museos/monumentos: horario diurno.
5) Cenas/vida nocturna: 19:00–23:30 aprox.

REGLAS DE FUSIÓN:
- Devuelve "allowed" ya corregidas; solo pasa a "removed" lo incompatible.

Información del usuario (sidebar):
${citiesGuide}
${preferencesGuide}${travelersGuide}${budgetGuide}

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
   SECCIÓN 15 · Generación por ciudad
================================= */
function setOverlayMessage(msg='Astra está generando itinerarios…'){
  const p = $overlayWOW?.querySelector('p');
  if(p) p.textContent = msg;
}

function showWOW(on, msg){
  if(!$overlayWOW) return;
  if(msg) setOverlayMessage(msg);
  $overlayWOW.style.display = on ? 'flex' : 'none';

  // 🆕 Ahora bloqueamos solo inputs y controles dentro del sidebar
  const sidebarEls = qsa('.sidebar button, .sidebar input, .sidebar select, .sidebar textarea');
  sidebarEls.forEach(el=>{
    // ✅ Mantener habilitado solo el botón de reset
    if (el.id === 'reset-planner') return;

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

  // 🆕 Bloquear también el botón flotante de Info Chat
  const infoFloating = qs('#info-chat-floating');
  if (infoFloating) {
    if(on){
      infoFloating._prevDisabled = infoFloating.disabled;
      infoFloating.disabled = true;
    }else{
      if(typeof infoFloating._prevDisabled !== 'undefined'){
        infoFloating.disabled = infoFloating._prevDisabled;
        delete infoFloating._prevDisabled;
      }else{
        infoFloating.disabled = false;
      }
    }
  }
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

  const instructions = `
${FORMAT}
**ROL:** Planificador “Astra”. Crea itinerario completo SOLO para "${city}" (${dest.days} día/s).
- Formato B {"destination":"${city}","rows":[...],"replace": false}.
- Revisa IMPERDIBLES diurnos y nocturnos.
- ⚡ Para fenómenos como auroras (Reykjavik / Tromsø), sugiere 1 tour en un día + alternativas locales en otros días.
- Respeta estrictamente ventanas horarias por día: ${JSON.stringify(perDay)}.
- Agrupar por zonas, evitar solapamientos y horas inviables.
- Valida plausibilidad global y seguridad:
  • No propongas actividades en zonas con riesgos relevantes, horarios inseguros o restricciones evidentes.
  • Si hay alerta razonable, sustituye por alternativa más segura o indícalo brevemente en “notes”.
  • Para actividades especiales, añade "notes" con "valid: <justificación>".
- Si quedan días sin contenido, distribuye actividades plausibles y/o day trips (≤2 h por trayecto, regreso mismo día) sin duplicar otras noches.
- Notas SIEMPRE informativas (nunca vacías ni "seed").
- Nada de texto fuera del JSON.
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

    // ✅ Validación semántica global
    const val = await validateRowsWithAgent(tmpCity, tmpRows, baseDate);
    if(Array.isArray(val.allowed) && val.allowed.length){
      pushRows(tmpCity, val.allowed, false);
      renderCityTabs(); setActiveCity(tmpCity); renderCityItinerary(tmpCity);
      showWOW(false);
      // 🛠 Habilita el botón de reset tras generar al menos un itinerario
      $resetBtn?.removeAttribute('disabled');
      return;
    }
  }

  renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
  showWOW(false);
  // 🛠 Asegura habilitar el reset también en fallback
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

  const prompt = `
${FORMAT}
**ROL:** Reequilibra COMPLETAMENTE la ciudad "${city}" (${totalDays} día/s) manteniendo lo ya plausible y completando huecos.
- Formato B {"destination":"${city}","rows":[...],"replace": false}.
- Respeta ventanas horarias: ${JSON.stringify(perDay)}.
- Considera IMPERDIBLES y actividades distribuidas sin duplicar.
- Day trips (opcional): si es viable y/o solicitado, añade UN (1) día de excursión (≤2 h por trayecto, ida y vuelta el mismo día) a un imperdible cercano con traslado + actividades + regreso.
${wantedTrip ? `- El usuario indicó preferencia de day trip a: "${wantedTrip}". Si es razonable, úsalo exactamente 1 día.` : ''}
- Valida plausibilidad y seguridad global:
  • No propongas actividades en zonas con riesgos relevantes o restricciones evidentes.
  • Si hay alerta razonable, sustituye por alternativa más segura o indica brevemente en notes.
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

    const val = await validateRowsWithAgent(city, rows, baseDate);
    pushRows(city, val.allowed, false);

    // 🔁 Reoptimiza TODOS los días para coherencia fina
    for(let d=1; d<=totalDays; d++) await optimizeDay(city, d);

    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    showWOW(false);

    // 🛠 Asegura habilitar el reset tras cualquier rebalanceo
    $resetBtn?.removeAttribute('disabled');
  }else{
    showWOW(false);
    // 🛠 También habilita reset en caso de no cambios válidos
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
  if(metaProgressIndex >= savedDestinations.length){
    collectingHotels = false;
    chatMsg(tone.confirmAll);

    (async ()=>{
      showWOW(true, 'Astra está generando itinerarios…');
      for(const {city} of savedDestinations){
        await generateCityItinerary(city);
      }
      showWOW(false);
      chatMsg(tone.doneAll);
    })();
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

  const prompt = `
${FORMAT}
Ciudad: ${city}
Día: ${day}
Fecha base (d1): ${baseDate||'N/A'}
Ventanas definidas: ${JSON.stringify(perDay)}
Filas actuales:
${JSON.stringify(rows)}
Instrucción:
- Reordena y optimiza (min traslados; agrupa por zonas).
- Sustituye huecos por opciones realistas (sin duplicar otros días).
- Para nocturnas (p.ej. auroras), usa horarios aproximados locales y añade alternativas cercanas si procede.
- Day trips ≤ 2 h por trayecto (ida), solo si hay tiempo disponible y sin interferir actividades icónicas.
- Valida PLAUSIBILIDAD GLOBAL y SEGURIDAD: 
  • No propongas actividades en zonas con riesgos o restricciones evidentes. 
  • Sustituye por alternativas seguras si aplica.
  • Añade siempre notas útiles (nunca vacías ni “seed”).
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

  const intent = intentFromText(text);

  // Normaliza "un día más" → add_day_end (y captura destino si lo hay)
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

  // Agregar varios días (con rebalanceo global y day trip opcional)
  if(intent.type==='add_days' && intent.city && intent.extraDays>0){
    const city = intent.city;
    showWOW(true,'Agregando días y reoptimizando…');
    addMultipleDaysToCity(city, intent.extraDays);
    await rebalanceWholeCity(city, { dayTripTo: intent.dayTripTo||'' });
    showWOW(false);
    chatMsg(`✅ Agregué ${intent.extraDays} día(s) a ${city}, incorporé actividades plausibles y reoptimicé todo el itinerario.`, 'ai');
    return;
  }

  // 1) Agregar día al FINAL (con posibilidad de day trip)
  if(intent.type==='add_day_end' && intent.city){
    const city = intent.city;
    showWOW(true,'Insertando día y optimizando…');
    ensureDays(city);
    const byDay = itineraries[city].byDay || {};
    const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
    const numericPos = days.length + 1;
    insertDayAt(city, numericPos);

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

    await rebalanceWholeCity(city, { dayTripTo: intent.dayTripTo||'' });

    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    showWOW(false);
    chatMsg('✅ Día agregado y plan reoptimizado globalmente.','ai');
    return;
  }

  // 2) Quitar día
  if(intent.type==='remove_day' && intent.city && Number.isInteger(intent.day)){
    showWOW(true,'Eliminando día…');
    removeDayAt(intent.city, intent.day);
    const totalDays = Object.keys(itineraries[intent.city].byDay||{}).length;
    for(let d=1; d<=totalDays; d++) await optimizeDay(intent.city, d);
    renderCityTabs(); setActiveCity(intent.city); renderCityItinerary(intent.city);
    showWOW(false);
    chatMsg('✅ Día eliminado y plan reequilibrado.','ai');
    return;
  }

  // 3) Swap de días
  if(intent.type==='swap_day' && intent.city){
    showWOW(true,'Intercambiando días…');
    swapDays(intent.city, intent.from, intent.to);
    await optimizeDay(intent.city, intent.from);
    if(intent.to!==intent.from) await optimizeDay(intent.city, intent.to);
    renderCityTabs(); setActiveCity(intent.city); renderCityItinerary(intent.city);
    showWOW(false);
    chatMsg('✅ Intercambié el orden y optimicé ambos días.','ai');
    return;
  }

  // 4) Mover actividad entre días
  if(intent.type==='move_activity' && intent.city){
    showWOW(true,'Moviendo actividad…');
    moveActivities(intent.city, intent.fromDay, intent.toDay, intent.query||'');
    await optimizeDay(intent.city, intent.fromDay);
    await optimizeDay(intent.city, intent.toDay);
    renderCityTabs(); setActiveCity(intent.city); renderCityItinerary(intent.city);
    showWOW(false);
    chatMsg('✅ Moví la actividad y optimicé los días implicados.','ai');
    return;
  }

  // 5) Sustituir/Eliminar actividad (día visible)
  if(intent.type==='swap_activity' && intent.city){
    const city = intent.city;
    const day  = itineraries[city]?.currentDay || 1;
    showWOW(true,'Ajustando actividades…');
    const q = intent.target ? intent.target.toLowerCase() : '';
    if(q){
      const before = itineraries[city].byDay[day]||[];
      const filtered = before.filter(r => !String(r.activity||'').toLowerCase().includes(q));
      itineraries[city].byDay[day] = filtered;
    }
    await optimizeDay(city, day);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    showWOW(false);
    chatMsg('✅ Sustituí la actividad y reoptimicé el día.','ai');
    return;
  }

  // 6) Cambiar horas
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

  // 7) Agregar ciudad
  if(intent.type==='add_city' && intent.city){
    const name = intent.city.trim().replace(/\s+/g,' ').replace(/^./,c=>c.toUpperCase());
    const days = intent.days || 2;
    addCityRow({city:name, days:'', baseDate:intent.baseDate||''});
    const lastRow = $cityList.lastElementChild;
    const sel = lastRow?.querySelector('.days');
    if(sel){ sel.value = String(days); sel.dispatchEvent(new Event('change')); }
    saveDestinations();
    chatMsg(`✅ Añadí <strong>${name}</strong>. Dime tu hotel/zona y transporte para generar el plan.`, 'ai');
    return;
  }

  // 8) Eliminar ciudad
  if(intent.type==='remove_city' && intent.city){
    const name = intent.city.trim();
    savedDestinations = savedDestinations.filter(x=>x.city!==name);
    delete itineraries[name];
    delete cityMeta[name];
    renderCityTabs();
    chatMsg(`🗑️ Eliminé <strong>${name}</strong> de tu itinerario.`, 'ai');
    return;
  }

  // 9) Preguntas informativas
  if(intent.type==='info_query'){
    try{
      setChatBusy(true);
      const ans = await callAgent(
`Responde en texto claro y conciso a la pregunta del usuario (sin JSON, sin proponer ediciones de itinerario):
"${text}"`, 
      true);
      chatMsg(ans || '¿Algo más que quieras saber?');
    } finally {
      setChatBusy(false);
    }
    return;
  }

  // 10) Edición libre —— si NO se especifica día, reoptimiza TODA la ciudad
  if(intent.type==='free_edit'){
    const city = activeCity || savedDestinations[0]?.city;
    if(!city){ chatMsg('Aún no hay itinerario en pantalla. Inicia la planificación primero.'); return; }
    const day = itineraries[city]?.currentDay || 1;
    showWOW(true,'Aplicando tu cambio…');

    const data = itineraries[city];
    const dayRows = (data?.byDay?.[day]||[]).map(r=>`• ${r.start||''}-${r.end||''} ${r.activity}`).join('\n') || '(vacío)';
    const allDays = Object.keys(data?.byDay||{}).map(n=>{
      const rows = data.byDay[n]||[];
      return `Día ${n}:\n${rows.map(r=>`• ${r.start||''}-${r.end||''} ${r.activity}`).join('\n') || '(vacío)'}`;
    }).join('\n\n');
    const perDay = (cityMeta[city]?.perDay||[]).map(pd=>({day:pd.day, start:pd.start||DEFAULT_START, end:pd.end||DEFAULT_END}));

    const prompt = `
${FORMAT}
**Contexto:**
${buildIntake()}

**Ciudad a editar:** ${city}
**Día visible:** ${day}
**Actividades del día:**
${dayRows}

**Resumen resto de días (referencia, no dupliques):**
${allDays}

**Ventanas por día:** ${JSON.stringify(perDay)}
**Instrucción del usuario (libre):** ${text}

- Integra lo pedido SIN borrar lo existente (fusión). 
- Si el usuario no especifica un día concreto, revisa y reacomoda TODA la ciudad evitando duplicados.
- Para nocturnas (p.ej. auroras), incluye 1 tour (mandatorio si procede) + varias noches alternativas cercanas (≤1h desde el centro cuando aplique), con hora aproximada local de inicio.
- Devuelve formato B {"destination":"${city}","rows":[...],"replace": false}.
- Valida plausibilidad global y, si mantienes actividad especial, añade "notes: valid: ...".
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

      // 🔁 Reoptimiza TODOS los días para garantizar coherencia global y evitar duplicados
      const totalDays = Object.keys(itineraries[city].byDay||{}).length;
      for(let d=1; d<=totalDays; d++) await optimizeDay(city, d);

      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
      showWOW(false);
      chatMsg('✅ Apliqué el cambio, revisé toda la ciudad y reoptimicé el itinerario completo.','ai');
    }else{
      showWOW(false);
      chatMsg(parsed?.followup || 'No recibí cambios válidos. ¿Intentamos de otra forma?','ai');
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
   (v55.4 ajusta validación dd/mm/aaaa + ciclo completo botón Reset y desbloqueo sidebar)
================================= */
$addCity?.addEventListener('click', ()=>addCityRow());

function validateBaseDatesDMY(){
  // 🆕 Valida selects .baseDay, .baseMonth y input .baseYear
  const rows = qsa('.city-row', $cityList);
  let firstInvalid = null;

  // 🧼 Limpia tooltips previos si existieran
  const prevTooltip = document.querySelector('.date-tooltip');
  if (prevTooltip) prevTooltip.remove();

  for(const r of rows){
    const dayEl = qs('.baseDay', r);
    const monthEl = qs('.baseMonth', r);
    const yearEl = qs('.baseYear', r);

    const day = dayEl?.value || '';
    const month = monthEl?.value || '';
    const year = yearEl?.value.trim() || '';

    // Validación básica: todos deben tener valor y año debe tener 4 dígitos
    if(!day || !month || !/^\d{4}$/.test(year)){
      firstInvalid = dayEl || monthEl || yearEl;
      [dayEl, monthEl, yearEl].forEach(el=>{
        el?.classList.add('shake-highlight');
        setTimeout(()=>el?.classList.remove('shake-highlight'), 800);
      });
      break;
    }
  }

  if(firstInvalid){
    const tooltip = document.createElement('div');
    tooltip.className = 'date-tooltip';
    tooltip.textContent = 'Por favor selecciona el día, mes y año de inicio para cada ciudad 🗓️';
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

$save?.addEventListener('click', ()=>{
  saveDestinations();
  // 🆕 Activar botón de reinicio cuando hay destinos guardados
  if ($resetBtn && savedDestinations.length > 0) {
    $resetBtn.removeAttribute('disabled');
  }
});

// ⛔ Reset con confirmación modal
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
  setTimeout(()=>overlay.classList.add('visible'), 10);

  const confirmReset = overlay.querySelector('#confirm-reset');
  const cancelReset  = overlay.querySelector('#cancel-reset');

  confirmReset.addEventListener('click', ()=>{
    // 🧹 Limpieza total de variables y UI
    $cityList.innerHTML = '';
    savedDestinations = [];
    itineraries = {};
    cityMeta = {};
    session = [];
    hasSavedOnce = false;
    pendingChange = null;

    // 🧹 Limpieza visual
    addCityRow();
    $start.disabled = true;
    $tabs.innerHTML = '';
    $itWrap.innerHTML = '';
    $chatBox.style.display = 'none';
    $chatM.innerHTML = '';

    // 🧹 Desactivar botón de reinicio y desbloquear sidebar tras reinicio
    if ($resetBtn) $resetBtn.setAttribute('disabled','true');
    if ($sidebar)  $sidebar.classList.remove('disabled');

    // 🧹 Restaurar info floating si aplica
    if($infoFloating){
      $infoFloating.style.pointerEvents = 'auto';
      $infoFloating.style.opacity = '1';
    }

    overlay.classList.remove('visible');
    setTimeout(()=>overlay.remove(), 300);
  });

  cancelReset.addEventListener('click', ()=>{
    overlay.classList.remove('visible');
    setTimeout(()=>overlay.remove(), 300);
  });

  document.addEventListener('keydown', function escHandler(e){
    if(e.key === 'Escape'){
      overlay.classList.remove('visible');
      setTimeout(()=>overlay.remove(), 300);
      document.removeEventListener('keydown', escHandler);
    }
  });
});

// ▶️ Start: valida fechas y luego ejecuta startPlanning()
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

  // 🧼 Limpieza previa por si se re-vincula
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


