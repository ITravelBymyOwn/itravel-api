/* ===== BLOQUE 1 de 7 ===== */
/* =========================================================
    ITRAVELBYMYOWN · PLANNER v37
    Base: v36 completa — Mejora global de IA y UX
========================================================= */

/* ================================
    SECCIÓN 1 · Helpers / Estado
=================================== */
const qs  = (s, ctx=document)=>ctx.querySelector(s);
const qsa = (s, ctx=document)=>Array.from(ctx.querySelectorAll(s));

const API_URL = 'https://itravelbymyown-api.vercel.app/api/chat';
const MODEL   = 'gpt-4o-mini';

let savedDestinations = [];
let itineraries = {};
let cityMeta = {};
let session = []; // historial solo para edición via chat
let activeCity = null;
let planningStarted = false;
let metaProgressIndex = 0;
let collectingHotels = false;
let isItineraryLocked = false;

const DEFAULT_START = '08:30';
const DEFAULT_END   = '19:00';

let pendingChange = null;
let hasSavedOnce = false;

/* ================================
    SECCIÓN 2 · Tono / Mensajería
=================================== */
const tone = {
  es: {
    hi: '¡Hola! Soy Astra ✨ tu concierge de viajes 🌍 Estoy aquí para crear itinerarios mágicos para ti.',
    askHotelTransport: (city)=>`Para <strong>${city}</strong>, cuéntame <strong>hotel/zona</strong> y el <strong>medio de transporte</strong> (alquiler, público, taxi/uber, combinado o “recomiéndame”).`,
    confirmAll: '✨ Perfecto. Comenzaré a generar tus itinerarios…',
    doneAll: '🎉 ¡Listo! Itinerarios generados. ¿Quieres ajustarlos o añadir algo especial?',
    fail: '⚠️ No se pudo contactar con el asistente. Revisa consola/Vercel (API Key, URL).',
    askConfirm: (summary)=>`¿Lo aplico ahora? ${summary}<br><small>Responde “sí” para aplicar o “no” para cancelar.</small>`,
    askWhichDayToRemove: '¿Qué día deseas eliminar?',
    humanOk: '✅ Listo, tu itinerario ha sido actualizado.',
    humanCancelled: '❌ No se aplicaron cambios.',
    fuzzySuggest: (suggested)=>`¿Querías decir <strong>${suggested}</strong>? 🌍 Puedo armar el itinerario si me confirmas.`,
    fuzzyNotFound: 'No pude reconocer esa ciudad. ¿Puedes revisarla o escribirla de nuevo?',
    genError: (city)=>`⚠️ No pude generar el itinerario de <strong>${city}</strong> en este intento.`,
    thinking: '✨ Astra está generando tu itinerario…'
  }
}['es'];

/* ================================
    SECCIÓN 3 · Referencias DOM
=================================== */
const $cityList = qs('#city-list');
const $addCity  = qs('#add-city-btn');
const $reset    = qs('#reset-planner');
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

/* ================================
    SECCIÓN 4 · Utilidades de fecha
=================================== */
function autoFormatDMYInput(el){
  el.addEventListener('input', ()=>{
    const v = el.value.replace(/\D/g,'').slice(0,8);
    if(v.length===8){
      el.value = `${v.slice(0,2)}/${v.slice(2,4)}/${v.slice(4,8)}`;
    }else{
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
function addDays(d, n){
  const x = new Date(d.getTime());
  x.setDate(x.getDate()+n);
  return x;
}

/* ================================
    SECCIÓN 5 · Mensajes de chat
=================================== */
function chatMsg(text, who='ai'){
  if(!text) return;
  const div = document.createElement('div');
  div.className = `chat-message ${who==='user'?'user':'ai'}`;
  div.innerHTML = text.replace(/\n/g,'<br>');
  $chatM.appendChild(div);
  $chatM.scrollTop = $chatM.scrollHeight;
}
/* ===== BLOQUE 2 de 7 ===== */
/* ================================
    SECCIÓN 6 · UI · Filas de ciudades
=================================== */
function makeHoursBlock(days){
  const wrap = document.createElement('div');
  wrap.className = 'hours-block';
  for(let d=1; d<=days; d++){
    const row = document.createElement('div');
    row.className = 'hours-day';
    row.innerHTML = `
      <span>Día ${d}</span>
      <input class="start" type="time" aria-label="Hora inicio" placeholder="HH:MM" value="">
      <input class="end"  type="time" aria-label="Hora final"  placeholder="HH:MM" value="">
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
    <label>Días<input class="days" type="number" min="1" value="${pref.days||''}"></label>
    <label>Inicio<input class="baseDate" placeholder="DD/MM/AAAA" value="${pref.baseDate||''}"></label>
    <button class="remove" type="button">✕</button>
  `;
  const baseDateEl = qs('.baseDate', row);
  autoFormatDMYInput(baseDateEl);

  const hoursWrap = document.createElement('div');
  hoursWrap.className = 'hours-block';
  row.appendChild(hoursWrap);

  const daysInput = qs('.days', row);
  daysInput.addEventListener('input', ()=>{
    const n = Math.max(0, parseInt(daysInput.value||0,10));
    hoursWrap.innerHTML='';
    if(n>0){
      const tmp = makeHoursBlock(n).children;
      Array.from(tmp).forEach(c=>hoursWrap.appendChild(c));
    }
  });

  qs('.remove',row).addEventListener('click', ()=> row.remove());
  $cityList.appendChild(row);
}

/* ================================
    SECCIÓN 7 · Guardar destinos
=================================== */
function saveDestinations(){
  const rows = qsa('.city-row', $cityList);
  const list = [];
  rows.forEach(r=>{
    let city     = qs('.city',r).value.trim();
    city = normalizeCityName(city);
    const country  = qs('.country',r).value.trim();
    const daysVal  = qs('.days',r).value;
    const days     = Math.max(1, parseInt(daysVal||'0',10)||1);
    const baseDate = qs('.baseDate',r).value.trim();

    if(!city) return;
    const perDay = [];
    qsa('.hours-day', r).forEach((hd, idx)=>{
      const start = qs('.start',hd).value || '';
      const end   = qs('.end',hd).value   || '';
      perDay.push({ day: idx+1, start, end });
    });
    if(perDay.length===0){
      for(let d=1; d<=days; d++) perDay.push({day:d,start:'',end:''});
    }

    list.push({ city, country, days, baseDate, perDay });
  });

  savedDestinations = list;
  savedDestinations.forEach(({city,days,baseDate,perDay})=>{
    if(!itineraries[city]) itineraries[city] = { byDay:{}, currentDay:1, baseDate: baseDate||null };
    if(!cityMeta[city]) cityMeta[city] = { baseDate: baseDate||null, start:null, end:null, hotel:'', transport:'', interests:[], perDay: perDay||[] };
    else {
      cityMeta[city].baseDate = baseDate||null;
      cityMeta[city].perDay   = perDay||[];
    }
    for(let d=1; d<=days; d++){
      if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[];
    }
  });
  Object.keys(itineraries).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete itineraries[c]; });
  Object.keys(cityMeta).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete cityMeta[c]; });

  renderCityTabs();
  $start.disabled = savedDestinations.length===0;
  hasSavedOnce = true;
}

/* ================================
    SECCIÓN 8 · Tabs + Render
=================================== */
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

/* ================================
    SECCIÓN 9 · Render Itinerario
=================================== */
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
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.start||''}</td>
        <td>${r.end||''}</td>
        <td>${r.activity||''}</td>
        <td>${r.from||''}</td>
        <td>${r.to||''}</td>
        <td>${r.transport||''}</td>
        <td>${r.duration||''}</td>
        <td>${r.notes||''}</td>
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
/* ===== BLOQUE 3 de 7 ===== */
/* ================================
    SECCIÓN 10 · Snapshot para IA
=================================== */
function getFrontendSnapshot(){
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(itineraries).map(([city,data])=>[
        city,
        {
          baseDate: data.baseDate || cityMeta[city]?.baseDate || null,
          transport: cityMeta[city]?.transport || '',
          interests: cityMeta[city]?.interests || [],
          days: Object.fromEntries(
            Object.entries(data.byDay||{}).map(([d,rows])=>[
              d,
              rows.map(r=>({
                day:+d,
                start:r.start||'',
                end:r.end||'',
                activity:r.activity||'',
                from:r.from||'',
                to:r.to||'',
                transport:r.transport||'',
                duration:r.duration||'',
                notes:r.notes||''
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
      return { day:i+1, start:(prev && prev.start)?prev.start:'', end:(prev && prev.end)?prev.end:'' };
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

/* ================================
    SECCIÓN 11 · Contrato JSON / LLM
=================================== */
const FORMAT = `
Devuelve SOLO JSON válido en uno de estos formatos:
A) {"destinations":[{"name":"City","rows":[...]}],"followup":"Pregunta breve"}
B) {"destination":"City","rows":[...],"replace":true,"followup":"Pregunta breve"}
C) {"rows":[...],"replace":true,"followup":"Pregunta breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM","end":"HH:MM","hotel":"Texto","transport":"Texto","interests":["..."]},"followup":"Pregunta breve"}
`;

/* ================================
    SECCIÓN 12 · Llamada al agente + locking
=================================== */
async function callAgent(text, useHistory = true){
  const history = useHistory ? session : [];
  const globalStyle = `
Eres "Astra", agente de viajes experto y cálido.
- Incluye imperdibles reales por ciudad y temporada SIN pedir confirmación adicional.
- Analiza temporada (ej. auroras sep–abr), clima y horas de luz para actividades realistas.
- Si la consulta es informativa, responde directamente y luego pregunta si actualizar el itinerario.
- No inventes datos; si dudas, pide confirmación breve.
`.trim();

  const payload = { model: MODEL, input: `${globalStyle}\n\n${text}`, history };
  try{
    const res = await fetch(API_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(()=>({text:''}));
    return data?.text || '';
  }catch(e){
    console.error("Fallo al contactar la API:", e);
    return `{"followup":"${tone.fail}"}`;
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

/* Helpers locking */
function showWOW(on){
  if(!$overlayWOW) return;
  $overlayWOW.style.display = on ? 'flex' : 'none';
  const all = qsa('button, input, select, textarea');
  all.forEach(el=>{
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
async function runWithLock(fn){
  chatMsg(tone.thinking,'ai');
  showWOW(true);
  try{
    const out = await fn();
    return out;
  }finally{
    showWOW(false);
  }
}

/* ================================
    SECCIÓN 13 · Apply / Merge + CRUD
=================================== */
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
  const start   = r.start ?? r.start_time ?? '';
  const end     = r.end   ?? r.end_time   ?? '';
  const act     = r.activity ?? r.title ?? '';
  const from    = r.from ?? '';
  const to      = r.to ?? '';
  const trans   = r.transport ?? '';
  const durRaw  = r.duration ?? '';
  const notes   = r.notes ?? '';
  const duration = (typeof durRaw === 'number') ? `${durRaw}m` : (String(durRaw)||'');
  const d = Math.max(1, parseInt(r.day ?? fallbackDay, 10) || 1);
  return { day:d, start:start||'', end:end||'', activity:act||'', from, to, transport:trans||'', duration, notes };
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
    if(byDay[d].length>20) byDay[d] = byDay[d].slice(0,20);
  });

  itineraries[city].byDay = byDay;
  ensureDays(city);
}
function upsertCityMeta(meta){
  const name = meta.city || activeCity || savedDestinations[0]?.city;
  if(!name) return;
  if(!cityMeta[name]) cityMeta[name] = { baseDate:null, start:null, end:null, hotel:'', transport:'', interests:[], perDay:[] };
  if(meta.baseDate) cityMeta[name].baseDate = meta.baseDate;
  if(meta.start)    cityMeta[name].start    = meta.start;
  if(meta.end)      cityMeta[name].end      = meta.end;
  if(typeof meta.hotel==='string') cityMeta[name].hotel = meta.hotel;
  if(typeof meta.transport==='string') cityMeta[name].transport = meta.transport;
  if(Array.isArray(meta.interests)) cityMeta[name].interests = meta.interests;
  if(itineraries[name] && meta.baseDate) itineraries[name].baseDate = meta.baseDate;
}
function applyParsedToState(parsed){
  if(!parsed) return;
  if(parsed.meta) upsertCityMeta(parsed.meta);

  if(Array.isArray(parsed.destinations)){
    parsed.destinations.forEach(d=>{
      const name = d.name || d.destination || activeCity;
      if(!name) return;
      if(d.rowsByDay){
        Object.entries(d.rowsByDay).forEach(([k,rows])=>{
          pushRows(name, (rows||[]).map(r=>({...r, day:+k})), Boolean(d.replace));
        });
      }else if(Array.isArray(d.rows)){
        pushRows(name, d.rows, Boolean(d.replace));
      }
    });
    return;
  }
  if(parsed.destination && Array.isArray(parsed.rows)){
    pushRows(parsed.destination, parsed.rows, Boolean(parsed.replace));
    return;
  }
  if(Array.isArray(parsed.itineraries)){
    parsed.itineraries.forEach(x=>{
      const name = x.city || x.name || x.destination || activeCity;
      if(!name) return;
      if(x.rowsByDay){
        Object.entries(x.rowsByDay).forEach(([k,rows])=>{
          pushRows(name, (rows||[]).map(r=>({...r, day:+k})), Boolean(x.replace));
        });
      }else if(Array.isArray(x.rows)){
        pushRows(name, x.rows, Boolean(x.replace));
      }
    });
    return;
  }
  if(Array.isArray(parsed.rows)){
    const city = activeCity || savedDestinations[0]?.city;
    pushRows(city, parsed.rows, Boolean(parsed.replace));
  }
}
/* ===== BLOQUE 4 de 7 ===== */
/* ================================
    SECCIÓN 14 · Day-trip helpers
=================================== */
function addMinutes(hhmm, min){
  if(!hhmm) return '';
  const [H,M] = hhmm.split(':').map(n=>parseInt(n||'0',10));
  const d = new Date(2000,0,1,H||0,M||0,0);
  d.setMinutes(d.getMinutes()+min);
  const HH = String(d.getHours()).padStart(2,'0');
  const MM = String(d.getMinutes()).padStart(2,'0');
  return `${HH}:${MM}`;
}
function seedDayTripRows(cityFrom, place, day, start='08:30', end='19:00'){
  return [
    {day, start, end: addMinutes(start,60), activity:`Traslado a ${place}`, from: cityFrom, to: place, transport:'Tren/Bus', duration:'60m', notes:'Salida temprana'},
    {day, start: addMinutes(start,70), end: addMinutes(start,190), activity:`Visita principal en ${place}`, from: place, to: '', transport:'A pie', duration:'120m', notes:'Puntos clave'},
    {day, start: addMinutes(start,200), end: addMinutes(start,290), activity:`Almuerzo en ${place}`, from: place, to: '', transport:'A pie', duration:'90m', notes:'Opcional'},
    {day, start: addMinutes(start,300), end: addMinutes(start,420), activity:`Recorrido por ${place}`, from: place, to: '', transport:'A pie/Bus', duration:'120m', notes:''},
    {day, start: addMinutes(start,430), end, activity:`Regreso a ${cityFrom}`, from: place, to: cityFrom, transport:'Tren/Bus', duration:'', notes:'Llegada estimada'}
  ];
}

/* ================================
    SECCIÓN 15 · Generación itinerario con imperdibles
=================================== */
async function generateCityItinerary(city){
  const work = async ()=>{
    const norm = normalizeCityName(city);
    const dest  = savedDestinations.find(x=>x.city===norm);
    if(!dest){
      const sug = fuzzyBestCity(city);
      if(sug) { chatMsg(tone.fuzzySuggest(sug),'ai'); pendingChange = { type:'confirm_fuzzy_add', city:sug }; }
      else chatMsg(tone.fuzzyNotFound,'ai');
      return;
    }

    const perDay = Array.from({length:dest.days}, (_,i)=>{
      const src  = (cityMeta[norm]?.perDay||[])[i] || dest.perDay?.[i] || {};
      return { day:i+1, start: src.start || '', end: src.end || '' };
    });

    const baseDate = cityMeta[norm]?.baseDate || dest.baseDate || '';
    const hotel    = cityMeta[norm]?.hotel || '';
    const transport= cityMeta[norm]?.transport || 'recomiéndame';

    const instructions = `
${FORMAT}
**ROL:** Eres Astra, agente experto.
**TAREA:** Genera itinerario COMPLETO para "${norm}" (${dest.days} día[s]) con imperdibles y actividades nocturnas si aplican.
- Evalúa temporada para decidir si incluir auroras (sep–abr en el norte).
- Considera horas de luz y clima.
- Recomienda coche de alquiler si es más económico/flexible.
- Usa horas definidas si existen; si no, sugiere horas lógicas (24h, sin límite artificial de 19:00).
- Devuelve formato B con "replace": true.
`.trim();

    let text = await callAgent(instructions, false);
    let parsed = parseJSON(text);

    const needsRetry = !(parsed && (parsed.rows || parsed.destinations || parsed.itineraries));
    if(needsRetry){
      const strict = `
${FORMAT}
**REINTENTO:** Devuelve solo para "${norm}" en formato B con "replace": true cubriendo TODOS los días.
`.trim();
      text = await callAgent(strict, false);
      parsed = parseJSON(text);
    }

    if(parsed){
      applyParsedToState(parsed);
      renderCityTabs(); setActiveCity(norm); renderCityItinerary(norm);
      return;
    }

    chatMsg(tone.genError(norm),'ai');
  };
  return runWithLock(work);
}
/* ===== BLOQUE 5 de 7 ===== */
/* ================================
    SECCIÓN 16 · Flujo principal · HOTELS ONLY
=================================== */
async function startPlanning(){
  if(savedDestinations.length===0) return;
  $chatBox.style.display='flex';
  planningStarted = true;
  collectingHotels = true;
  metaProgressIndex = 0;
  session = [];
  chatMsg(`${tone.hi}`);
  askNextHotelTransport();
}
function askNextHotelTransport(){
  if(metaProgressIndex >= savedDestinations.length){
    collectingHotels = false;
    chatMsg(tone.confirmAll);
    (async ()=>{
      await runWithLock(async ()=>{
        for(const {city} of savedDestinations){
          await generateCityItinerary(city);
        }
      });
      chatMsg(tone.doneAll);
    })();
    return;
  }
  const city = savedDestinations[metaProgressIndex].city;
  setActiveCity(city); renderCityItinerary(city);
  chatMsg(tone.askHotelTransport(city),'ai');
}

/* ================================
    SECCIÓN 17 · Chat handler / NLU + Confirmación (v37)
=================================== */
/* —— utilidades NLU de horas y ordinales —— */
const WORD_NUM = {
  'una':1,'uno':1,'un':1,'dos':2,'tres':3,'cuatro':4,'cinco':5,'seis':6,'siete':7,'ocho':8,'nueve':9,'diez':10
};
function normalizeHourToken(tok){
  tok = (tok||'').toLowerCase().trim();
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
    if(hh>=0 && hh<=24) return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
    return null;
  }
  const mapWords = { 'mediodía':'12:00', 'medianoche':'00:00' };
  if(mapWords[tok]) return mapWords[tok];

  const w = WORD_NUM[tok];
  if(w) return String(w).padStart(2,'0')+':00';

  const m = tok.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if(!m) return null;
  let hh = parseInt(m[1],10);
  let mm = m[2]?parseInt(m[2],10):0;
  const ap = m[3]?.toLowerCase();
  if(ap){
    if((ap==='pm' || ap==='p.m.') && hh<12) hh += 12;
    if((ap==='am' || ap==='a.m.') && hh===12) hh = 0;
  }
  if(hh>=0 && hh<=24 && mm>=0 && mm<60){
    return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
  }
  return null;
}
function parseTimeRangeFromText(text){
  const t = (text||'').toLowerCase();
  let m = t.match(/(?:de|entre)\s+([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)\s*(?:a|hasta|y)\s*([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)/i);
  if(m){
    const s = normalizeHourToken(m[1]);
    const e = normalizeHourToken(m[2]);
    if(s||e) return {start:s||null, end:e||null};
  }
  m = t.match(/(?:empezar|iniciar|arrancar|inicio|comenzar)\s*(?:el día|la jornada)?\s*(?:a|a las)?\s*([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)/i);
  const startOnly = m ? normalizeHourToken(m[1]) : null;
  m = t.match(/(?:terminar|finalizar|hasta|acabar)\s*(?:a las|a)?\s*([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)/i);
  const endOnly = m ? normalizeHourToken(m[1]) : null;
  return {start:startOnly, end:endOnly};
}
function parseOrdinalDay(text){
  const t = (text||'').toLowerCase();
  const mNum = t.match(/(?:d[ií]a)?\s*(\d{1,2})/);
  if(mNum) return parseInt(mNum[1],10);
  const mWord = t.match(/\b(primer|segundo|tercer|cuarto|quinto|sexto|s[eé]ptimo|octavo|noveno|d[eé]cimo)\b/);
  if(mWord){
    const map = {primer:1, segundo:2, tercer:3, cuarto:4, quinto:5, sexto:6, 'séptimo':7, septimo:7, octavo:8, noveno:9, 'décimo':10, decimo:10};
    return map[mWord[1]];
  }
  const oneWord = t.match(/\b(uno|una)\b/); if(oneWord) return 1;
  return null;
}

/* —— helpers de manipulación de días/actividades —— */
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
  const q = (query||'').toLowerCase().trim();
  const moved = [];
  const remain = [];
  src.forEach(r=>{
    const hay = !q || String(r.activity||'').toLowerCase().includes(q);
    if(hay){ moved.push(r); } else { remain.push(r); }
  });
  byDay[fromDay] = remain.map(normalizeRow);
  moved.forEach(r=>{
    const copy = {...r, day: toDay};
    dedupeInto(dst, copy);
  });
  byDay[toDay] = dst.map(normalizeRow).sort((a,b)=> (a.start||'') < (b.start||'') ? -1 : 1);
  itineraries[city].byDay = byDay;
}
function removeActivitiesByQuery(city, day, query){
  ensureDays(city);
  const byDay = itineraries[city].byDay || {};
  const src = byDay[day] || [];
  const q = String(query||'').toLowerCase().trim();
  if(!q){ byDay[day]=src; return; }
  byDay[day] = src.filter(r=>!String(r.activity||'').toLowerCase().includes(q));
  itineraries[city].byDay = byDay;
}

/* —— optimización por IA (rellena huecos, ordena, incluye nocturnas si apl.) —— */
async function optimizeDay(city, day){
  const work = async ()=>{
    const data = itineraries[city];
    const rows = (data?.byDay?.[day]||[]).map(r=>({
      day, start:r.start||'', end:r.end||'', activity:r.activity||'',
      from:r.from||'', to:r.to||'', transport:r.transport||'',
      duration:r.duration||'', notes:r.notes||''
    }));
    const perDay = (cityMeta[city]?.perDay||[]).find(x=>x.day===day) || {start:'',end:''};
    const baseDate = data.baseDate || cityMeta[city]?.baseDate || '';

    const prompt = `
${FORMAT}
Ciudad: ${city}
Día: ${day}
Fecha base (d1): ${baseDate||'N/A'}
Ventanas definidas: ${JSON.stringify(perDay)} (vacías = sugiere horas lógicas; incluye nocturnas si aplica)
Filas actuales:
${JSON.stringify(rows)}
Instrucción:
- Reordena y optimiza (min traslados; agrupa por zonas).
- Rellena huecos con actividades relevantes (imperdibles/experiencias cercanas).
- Considera temporada/horas de luz/actividades nocturnas (auroras si aplica).
- No repitas lo ya presente en otros días de la misma ciudad.
- Devuelve C {"rows":[...],"replace":true}.
Contexto:
${buildIntake()}
`.trim();

    const ans = await callAgent(prompt, true);
    const parsed = parseJSON(ans);
    if(parsed?.rows){
      pushRows(city, parsed.rows.map(x=>({...x, day})), true);
    }
  };
  return runWithLock(work);
}
async function optimizeTwoDays(city, a, b){
  await optimizeDay(city, a);
  if(a!==b) await optimizeDay(city, b);
}

/* —— intents —— */
function intentFromText(text, city){
  const t = (text||'').toLowerCase();

  if(/^(sí|si|ok|dale|hazlo|confirmo|de una)\b/.test(t)) return {type:'confirm'};
  if(/^(no|mejor no|cancela|cancelar|cancelá|cancelalo|cancélalo)\b/.test(t)) return {type:'cancel'};

  // Agregar día (posible destino/day-trip y posible posición)
  if(/(agrega|añade|sum[aá])\s+un?\s+d[ií]a/.test(t)){
    let pos = null;
    if(/\binicio\b/.test(t)) pos = 'start';
    else if(/\bfinal\b/.test(t)) pos = 'end';
    else {
      const p = parseOrdinalDay(t);
      if(p) pos = p;
    }
    // "para ir a X" o "a X"
    const placeMatch = t.match(/para\s+ir\s+a\s+([a-záéíóúüñ\s]+)$/i) || t.match(/\ba\s+([a-záéíóúüñ\s]+)\s*$/i);
    const place = placeMatch ? placeMatch[1].trim() : null;
    const night = /\baurora|auroras|noche|nocturn[oa]\b/.test(t);
    return {type:'add_day', position:pos, place, night};
  }

  // Quitar día
  if(/(quita|elimina|borra)\s+un?\s+d[ií]a/.test(t) || /(quita|elimina|borra)\s+el\s+d[ií]a/.test(t)){
    const d = parseOrdinalDay(t);
    return d ? {type:'remove_day', day:d} : {type:'ask_remove_day_direct'};
  }

  // Swap de días (pasa el día 3 al 2) sin mencionar actividad
  const swap = t.match(/(?:pasa|mueve|cambia)\s+el\s+d[ií]a\s+(\d+)\s+(?:al|a)\s+(?:d[ií]a\s+)?(\d+)/i);
  if(swap && !/actividad|museo|visita|tour|cena|almuerzo|desayuno/i.test(t)){
    return {type:'swap_day', from: parseInt(swap[1],10), to: parseInt(swap[2],10)};
  }

  // Quitar actividad por texto
  if(/\b(no\s+quiero|quita|elimina|borra)\b.+/.test(t)){
    const query = t.replace(/^(no\s+quiero|quita|elimina|borra)\s*/i,'').trim();
    if(query) return {type:'remove_activity', query};
  }

  // Mover actividad concreta del día X → Y
  const mv = t.match(/(?:mueve|pasa|cambia)\s+(.*?)(?:\s+del\s+d[ií]a\s+(\d+)|\s+del\s+(\d+))\s+(?:al|a)\s+(?:d[ií]a\s+)?(\d+)/i);
  if(mv){
    const query = (mv[1]||'').trim();
    const from = parseInt(mv[2] || mv[3],10);
    const to   = parseInt(mv[4],10);
    if(query) return {type:'move_activity', query, fromDay:from, toDay:to};
  }

  // Cambiar horas del día visible
  const range = parseTimeRangeFromText(text);
  if(range.start || range.end){ return {type:'change_hours', range}; }

  // Agregar ciudad (con días opcionales)
  if(/(agrega|añade)\s+(una\s+)?ciudad\b|\bagrega\s+[a-záéíóúüñ\s]+(\s+\d+\s+d[ií]as)?$/i.test(t) || /agrega\s+[a-záéíóúüñ]+(\s+\d+\s+d[ií]as)?/i.test(t)){
    const m = t.match(/agrega\s+([a-záéíóúüñ\s]+?)(?:\s+(\d+)\s+d[ií]as?)?$/i);
    if(m){ return {type:'add_city', name: m[1].trim(), days: m[2]?parseInt(m[2],10):null}; }
  }

  // Quitar ciudad
  if(/(quita|elimina|borra)\s+[a-záéíóúüñ\s]+$/i.test(t)){
    const m = t.match(/(quita|elimina|borra)\s+([a-záéíóúüñ\s]+)$/i);
    if(m){ return {type:'remove_city', name: m[2].trim()}; }
  }

  // Información general (modo chat tipo ChatGPT)
  if(/clima|tiempo|temperatura|lluvia|horas de luz|alquiler de auto|aerol[ií]neas|vuelos|ropa|equipaje|visado|visa|estaci[oó]n|temporada|costumbre|gastronom[ií]a|seguridad|moneda|enchufe|conductor/.test(t)){
    return {type:'info_query', details:text};
  }

  // Edición libre
  return {type:'free_edit', details:text};
}

/* —— prompts de edición —— */
function buildEditPrompt(city, directive, opts={}){
  const data = itineraries[city];
  const day = data?.currentDay || 1;
  const dayRows = (data?.byDay?.[day]||[]).map(r=>`• ${r.start||''}-${r.end||''} ${r.activity}`).join('\n') || '(vacío)';
  const allDays = Object.keys(data?.byDay||{}).map(n=>{
    const rows = data.byDay[n]||[];
    return `Día ${n}:\n${rows.map(r=>`• ${r.start||''}-${r.end||''} ${r.activity}`).join('\n') || '(vacío)'}`;
  }).join('\n\n');

  const perDay = (cityMeta[city]?.perDay||[]).map(pd=>({day:pd.day, start:pd.start||'', end:pd.end||''}));
  const overrides = opts.overrides ? JSON.stringify(opts.overrides) : '{}';

  return `
${FORMAT}
**Contexto del viaje:**
${buildIntake()}

**Ciudad a editar:** ${city}
**Día visible:** ${day}
**Actividades del día actual:**
${dayRows}

**Resumen resto de días (referencia, no dupliques):**
${allDays}

**Ventanas por día (vacío=flexible):** ${JSON.stringify(perDay)}
**Directiva de edición:** ${directive}
**Opciones:** ${JSON.stringify(opts)}
**Reglas estrictas:**
- Devuelve formato B {"destination":"${city}","rows":[...],"replace": true} con SOLO las filas finales de los días implicados.
- Si "addOneDay" es true, añade un día al final (no borres los demás) y numera bien.
- Si "daysStrict" se indica, edita solo esos días.
- Reoptimiza, sin duplicar, con notas humanas breves y motivadoras.
- Ten en cuenta overrides de horas (si hay): ${overrides}
`.trim();
}
async function applyAgentEdit(city, prompt){
  await runWithLock(async ()=>{
    const ans = await callAgent(prompt, true);
    const parsed = parseJSON(ans);

    if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
      applyParsedToState(parsed);
      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
      chatMsg(tone.humanOk,'ai');
    }else{
      chatMsg(parsed?.followup || 'No recibí cambios válidos. ¿Intentamos de nuevo?','ai');
    }
  });
}

/* —— manejador de chat —— */
async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  // Confirmación por fuzzy add pendiente
  if(pendingChange?.type === 'confirm_fuzzy_add'){
    if(/^sí|si|ok|dale|confirmo/i.test(text)){
      const city = pendingChange.city;
      pendingChange = null;
      addCityRow({city});
      saveDestinations();
      chatMsg(`✅ ${city} agregada a tu itinerario.`, 'ai');
      return;
    }
    if(/^no|cancela/i.test(text)){
      pendingChange = null;
      chatMsg(tone.humanCancelled,'ai');
      return;
    }
  }

  // Colecta hotel/transporte (v37 solo esta pregunta)
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

  // Si no hay ciudad activa, intentar fuzzy desde el texto
  const currentCity = activeCity || savedDestinations[0]?.city;
  const data = itineraries[currentCity];
  if(!currentCity || !data){
    const guess = fuzzyBestCity(text);
    if(guess){
      chatMsg(tone.fuzzySuggest(guess),'ai');
      pendingChange = { type:'confirm_fuzzy_add', city: guess };
      return;
    }
    chatMsg('Aún no hay itinerario en pantalla. Por favor, inicia la planificación primero.');
    return;
  }

  // Intents
  const intent = intentFromText(text, currentCity);

  if(intent.type==='confirm' && pendingChange){
    const { city, prompt } = pendingChange;
    pendingChange = null;
    await applyAgentEdit(city, prompt);
    return;
  }
  if(intent.type==='cancel' && pendingChange){
    pendingChange = null;
    chatMsg(tone.humanCancelled,'ai');
    return;
  }

  // 1) Agregar día (por defecto al final si no se indica)
  if(intent.type==='add_day'){
    await runWithLock(async ()=>{
      const city = currentCity;
      ensureDays(city);
      const byDay = itineraries[city].byDay || {};
      const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
      const numericPos = (intent.position==='start') ? 1
        : (intent.position==='end' || !intent.position ? days.length+1 : Math.max(1, Math.min(+intent.position, days.length+1)));
      insertDayAt(city, numericPos);

      // Si hay "para ir a X", crear day-trip base y luego optimizar
      if(intent.place){
        const rows = seedDayTripRows(city, intent.place, numericPos);
        pushRows(city, rows, true);
      }

      // Si se menciona noche/auroras, garantizar bloque nocturno en ese día
      if(intent.night){
        const end = (cityMeta[city]?.perDay?.find(x=>x.day===numericPos)?.end) || '23:30';
        pushRows(city, [{
          day:numericPos, start:'21:00', end:end,
          activity:'Actividad nocturna (p.ej., caza de auroras)',
          from:'Hotel', to:'', transport:'Tour/Bus',
          duration:'150m', notes:'Horario estimado'
        }], false);
      }

      await optimizeDay(city, numericPos);
      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
      chatMsg('✅ Día agregado y optimizado.','ai');
    });
    return;
  }

  // 2) Quitar día: preguntar si no dieron número
  if(intent.type==='ask_remove_day_direct'){
    pendingChange = {type:'remove_day_wait'};
    chatMsg(tone.askWhichDayToRemove,'ai');
    return;
  }
  if(intent.type==='remove_day' || (intent.type==='confirm' && pendingChange?.type==='remove_day_wait')){
    await runWithLock(async ()=>{
      const day = intent.day || parseOrdinalDay(text);
      if(!Number.isInteger(day) || day<=0){
        pendingChange = {type:'remove_day_wait'};
        chatMsg(tone.askWhichDayToRemove,'ai'); return;
      }
      removeDayAt(currentCity, day);
      renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
      chatMsg(tone.humanOk,'ai');
      pendingChange = null;
    });
    return;
  }

  // 3) Quitar actividad en el día visible y optimizar
  if(intent.type==='remove_activity'){
    await runWithLock(async ()=>{
      const q = intent.query || '';
      const day = data.currentDay || 1;
      removeActivitiesByQuery(currentCity, day, q);
      await optimizeDay(currentCity, day);
      renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
      chatMsg('✅ Actividad eliminada y horario reoptimizado.','ai');
    });
    return;
  }

  // 4) Mover actividad del día X → Y y optimizar ambos
  if(intent.type==='move_activity'){
    await runWithLock(async ()=>{
      moveActivities(currentCity, intent.fromDay, intent.toDay, intent.query||'');
      await optimizeTwoDays(currentCity, intent.fromDay, intent.toDay);
      renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
      chatMsg('✅ Moví la actividad y optimicé los días implicados.','ai');
    });
    return;
  }

  // 4b) Swap de días
  if(intent.type==='swap_day'){
    await runWithLock(async ()=>{
      swapDays(currentCity, intent.from, intent.to);
      await optimizeTwoDays(currentCity, intent.from, intent.to);
      renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
      chatMsg('✅ Intercambié el orden de esos días y optimicé.','ai');
    });
    return;
  }

  // 5) Cambiar horas del día visible
  if(intent.type==='change_hours'){
    await runWithLock(async ()=>{
      const range = intent.range;
      const day = data.currentDay || 1;
      if(!cityMeta[currentCity]) cityMeta[currentCity]={perDay:[]};
      let pd = cityMeta[currentCity].perDay.find(x=>x.day===day);
      if(!pd){ pd = {day, start:'', end:''}; cityMeta[currentCity].perDay.push(pd); }
      if(range.start) pd.start = range.start;
      if(range.end)   pd.end   = range.end;
      await optimizeDay(currentCity, day);
      renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
      chatMsg('✅ Ajusté los horarios y optimicé tu día.','ai');
    });
    return;
  }

  // 6) Agregar ciudad
  if(intent.type==='add_city'){
    const name = normalizeCityName(intent.name||'').trim();
    if(!name){ chatMsg('Necesito el nombre de la ciudad.','ai'); return; }
    const days = intent.days || 2;
    addCityRow({city:name, days});
    saveDestinations();
    chatMsg(`Añadí <strong>${name}</strong>. Dime tu hotel/zona y transporte para generar el plan.`, 'ai');
    return;
  }

  // 7) Quitar ciudad
  if(intent.type==='remove_city'){
    const name = normalizeCityName(intent.name||'').trim();
    if(!name){ chatMsg('Necesito el nombre de la ciudad a quitar.','ai'); return; }
    savedDestinations = savedDestinations.filter(x=>x.city!==name);
    delete itineraries[name];
    delete cityMeta[name];
    renderCityTabs();
    chatMsg(`Eliminé <strong>${name}</strong> de tu itinerario.`, 'ai');
    return;
  }

  // 8) Info query (modo chat — responde natural tipo ChatGPT)
  if(intent.type==='info_query'){
    const ans = await callAgent(`
El usuario te pide información (NO edites aún). Responde con precisión, calidez y utilidad.
Si esta info podría afectar el plan (clima/temporada/transporte/seguridad), pregunta si desea actualizar.
${FORMAT}
{"followup":"mensaje breve para continuar"}`, true);
    const parsed = parseJSON(ans);
    chatMsg(parsed?.followup || '¿Quieres que ajuste tu itinerario con esta información?','ai');
    return;
  }

  // 9) Edición libre → confirmación breve y ejecución
  if(intent.type==='free_edit'){
    const day = data.currentDay || 1;
    const summary = `Aplicar tus cambios en <strong>${currentCity}</strong> afectando el <strong>día ${day}</strong> y reoptimizar.`;
    const prompt = buildEditPrompt(currentCity,
      `Interpreta con precisión el deseo del usuario y actualiza los días implicados (prioriza el día visible ${day}). Reoptimiza sin duplicar.`,
      { daysStrict:[day], userText:text }
    );
    pendingChange = { city: currentCity, prompt, summary };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }
}
/* ===== BLOQUE 6 de 7 ===== */
/* ================================
    SECCIÓN 18 · Upsell/Lock + Eventos / INIT
=================================== */
function lockItinerary(){
  isItineraryLocked = true;
  $upsell.style.display='flex';
}
function guardFeature(fn){
  return (...args)=>{
    if(isItineraryLocked){ $upsell.style.display='flex'; return; }
    fn(...args);
  };
}

/* Eventos */
const $addCityBtn = $addCity;
$addCityBtn?.addEventListener('click', ()=>addCityRow());
$reset?.addEventListener('click', ()=>{
  $cityList.innerHTML=''; savedDestinations=[]; itineraries={}; cityMeta={};
  addCityRow();
  $start.disabled = true;
  $tabs.innerHTML=''; $itWrap.innerHTML='';
  $chatBox.style.display='none'; $chatM.innerHTML='';
  session = []; hasSavedOnce=false; pendingChange=null;
});
$save?.addEventListener('click', saveDestinations);
$start?.addEventListener('click', startPlanning);
$send?.addEventListener('click', onSend);

// Chat: Enter envía, Shift+Enter = nueva línea
$chatI?.addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    onSend();
  }
});

$confirmCTA?.addEventListener('click', lockItinerary);
$upsellClose?.addEventListener('click', ()=> $upsell.style.display='none');

/* Toolbar (igual que versiones previas) */
qs('#btn-pdf')?.addEventListener('click', guardFeature(()=>alert('Exportar PDF (demo)')));
qs('#btn-email')?.addEventListener('click', guardFeature(()=>alert('Enviar por email (demo)')));
qs('#btn-maps')?.addEventListener('click', ()=>window.open('https://maps.google.com','_blank'));
qs('#btn-transport')?.addEventListener('click', guardFeature(()=>window.open('https://www.rome2rio.com/','_blank')));
qs('#btn-weather')?.addEventListener('click', guardFeature(()=>window.open('https://weather.com','_blank')));
qs('#btn-clothing')?.addEventListener('click', guardFeature(()=>window.open('https://www.packup.ai/','_blank')));
qs('#btn-restaurants')?.addEventListener('click', guardFeature(()=>window.open('https://www.thefork.com/','_blank')));
qs('#btn-gas')?.addEventListener('click', guardFeature(()=>window.open('https://www.google.com/maps/search/gas+station','_blank')));
qs('#btn-bathrooms')?.addEventListener('click', guardFeature(()=>window.open('https://www.google.com/maps/search/public+restrooms','_blank')));
qs('#btn-lodging')?.addEventListener('click', guardFeature(()=>window.open('https://www.booking.com','_blank')));
qs('#btn-localinfo')?.addEventListener('click', guardFeature(()=>window.open('https://www.wikivoyage.org','_blank')));

/* Inicial */
addCityRow();
/* ===== BLOQUE 7 de 7 ===== */
/* ================================
    SECCIÓN 19 · Fuzzy Matching + Similitud
=================================== */
const KNOWN_CITIES = [
  'Reykjavik','Reikiavik','Reikjavik','Tromsø','Tromso','Paris','Madrid','Barcelona',
  'Luxor','Florence','Rome','Roma','Oslo','London','Saint Petersburg','San Petersburgo',
  'Rovaniemi','Abisko','Kiruna','Fairbanks','Yellowknife','Grindavik','Hveragerdi','Flúðir','Fludir','Selfoss',
  'Milan','Milán','Segovia','Versalles','Montserrat','Girona','Sitges','Venezia','Venecia'
];
function stripAccentsLower(s){
  return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
}
function levenshteinDistance(a,b){
  const A = a, B = b;
  const matrix = [];
  for(let i=0;i<=B.length;i++){ matrix[i]=[i]; }
  for(let j=0;j<=A.length;j++){ matrix[0][j]=j; }
  for(let i=1;i<=B.length;i++){
    for(let j=1;j<=A.length;j++){
      if(B.charAt(i-1)==A.charAt(j-1)){
        matrix[i][j]=matrix[i-1][j-1];
      }else{
        matrix[i][j]=Math.min(matrix[i-1][j-1]+1, Math.min(matrix[i][j-1]+1,matrix[i-1][j]+1));
      }
    }
  }
  return matrix[B.length][A.length];
}
function stringSimilarity(a,b){
  const A = stripAccentsLower(a), B = stripAccentsLower(b);
  const longer = A.length > B.length ? A : B;
  const shorter = A.length > B.length ? B : A;
  const longerLength = longer.length;
  if(longerLength === 0) return 1.0;
  const editDistance = levenshteinDistance(longer, shorter);
  return (longerLength - editDistance) / parseFloat(longerLength);
}
function normalizeCityName(input){
  if(!input) return '';
  const clean = stripAccentsLower(input);
  let bestMatch = '';
  let bestScore = 0;
  for(const city of KNOWN_CITIES){
    const score = stringSimilarity(clean, city);
    if(score > bestScore){ bestScore = score; bestMatch = city; }
  }
  const preferred = {
    'reikjavik':'Reykjavik','reikiavik':'Reykjavik','reykjavik':'Reykjavik',
    'tromso':'Tromsø','san petersburgo':'Saint Petersburg','roma':'Rome',
    'milan':'Milán','venezia':'Venecia'
  };
  const bestKey = stripAccentsLower(bestMatch);
  const preferredName = preferred[bestKey] || bestMatch;
  return bestScore > 0.8 ? preferredName : input;
}
function fuzzyBestCity(text){
  const base = stripAccentsLower(text);
  let bestMatch = '';
  let bestScore = 0;
  const tokens = base.split(/[^a-z0-9áéíóúüñ]+/i).filter(Boolean);
  const candidates = new Set(tokens.concat([base]));
  for(const cand of candidates){
    for(const city of KNOWN_CITIES){
      const score = stringSimilarity(cand, city);
      if(score > bestScore){ bestScore = score; bestMatch = city; }
    }
  }
  const preferred = normalizeCityName(bestMatch);
  return bestScore>0.8 ? preferred : null;
}
