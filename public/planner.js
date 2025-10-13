/* =========================================================
    ITRAVELBYMYOWN · PLANNER v32
    Base: v31.2  (se mantienen las 18 secciones)
    Cambios v32:
    - Confirmación previa para cambios que afectan itinerarios (add/remove day, day-trip, mover actividades, cambiar horas).
    - NLU mejorada: "7 y media / siete y cuarto", add/remove day ("un día menos"), day-trip ("para ir a Segovia"), mover ("del día X al Y").
    - Modo conversación libre (info): clima, aerolíneas, ropa, alquiler, horarios de luz, etc. -> responde cálido y pregunta si guardar/actualizar.
    - Sugerencias de actividades especiales por ciudad más robustas y dinámicas (máx. ~5).
    - Sidebar: encabezados "Hora inicio" y "Hora final" en los días.
    - Correcciones: inserción/eliminación de días con reindexado correcto; no sobrescribe Día 1 por error.
    - Mantiene estructura, nombres y comportamiento de v31.2 donde no se indicó cambio.
========================================================= */

/* ================================
    SECCIÓN 1 · Helpers / Estado
=================================== */
const qs  = (s, ctx=document)=>ctx.querySelector(s);
const qsa = (s, ctx=document)=>Array.from(ctx.querySelectorAll(s));

// ⚠️ Verifica esta URL (tu API en Vercel)
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
let collectingInterests = false;
let isItineraryLocked = false;

const DEFAULT_START = '08:30';
const DEFAULT_END   = '19:00';

// Confirmaciones v32
let pendingChange = null; // {type, city, payload, prompt}

/* ================================
    SECCIÓN 2 · Tono / Mensajería
=================================== */
const tone = {
  es: {
    hi: '¡Bienvenido! 👋 Soy tu concierge de viajes personal. Vamos ciudad por ciudad para dejar tu plan perfecto.',
    askHotelTransport: (city)=>`Para <strong>${city}</strong>, ¿en qué <strong>hotel/zona</strong> te hospedarás y qué <strong>medio de transporte</strong> usarás? Opciones: <em>Vehículo alquilado</em> · <em>Transporte público</em> · <em>Uber/Taxi</em> · <em>Combinado</em> · <em>Recomiéndame</em>.<br><small style="display:block;color:#667085;margin-top:.25rem">Puedes responder en lenguaje natural, ej: “Hotel X en el centro y recomiéndame el transporte”.</small>`,
    askInterestsIntro: (city, picks)=>`En <strong>${city}</strong> suelen destacar: ${picks.join(' · ')}. ¿Quieres incluir alguna? Escribe nombres separados por coma o “recomiéndame”.`,
    confirmAll: '✨ ¡Perfecto! Ya tengo lo necesario. Empezaré a generar tus itinerarios optimizados…',
    doneAll: '🎉 ¡Listo! Itinerarios generados. ¿Quieres afinarlos o añadir algo especial?',
    fail: '⚠️ No se pudo contactar con el asistente. Revisa la consola y tu configuración de Vercel (API Key / URL).',
    askConfirm: (msg)=>`¿Confirmas? ${msg} <br><small>Responde “sí” para aplicar o “no” para cancelar.</small>`,
    humanDone: 'Perfecto ✅ Ajusté tu itinerario para que aproveches mejor el tiempo. ¡Va a quedar genial! ✨'
  }
}['es'];

/* ================================
    SECCIÓN 3 · Referencias DOM
=================================== */
const $cityList = qs('#city-list');
const $addCity  = qs('#add-city-btn');
const $reset    = qs('#reset-planner');   // existe en tu HTML v31.x
const $save     = qs('#save-destinations');

const $start    = qs('#start-planning');
const $chatBox  = qs('#chat-container');
const $chatM    = qs('#chat-messages');
const $chatI    = qs('#chat-input');
const $send     = qs('#send-btn');

const $tabs     = qs('#city-tabs');
const $itWrap   = qs('#itinerary-container');

const $upsell     = qs('#monetization-upsell');
const $upsellClose = qs('#upsell-close');
const $confirmCTA  = qs('#confirm-itinerary');

const $overlayWOW  = qs('#loading-overlay');  // Overlay

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

/* ================================
    SECCIÓN 6 · UI · Filas de ciudades
=================================== */
function makeHoursHeader(){
  const h = document.createElement('div');
  h.className = 'hours-day';
  h.innerHTML = `
    <span style="opacity:.6">Días</span>
    <span style="font-weight:600;opacity:.8">Hora inicio</span>
    <span style="font-weight:600;opacity:.8">Hora final</span>
  `;
  return h;
}
function makeHoursBlock(days){
  const wrap = document.createElement('div');
  wrap.className = 'hours-block';
  wrap.appendChild(makeHoursHeader());
  for(let d=1; d<=days; d++){
    const row = document.createElement('div');
    row.className = 'hours-day';
    row.innerHTML = `
      <span>Día ${d}</span>
      <input class="start" type="time" value="">
      <input class="end"  type="time" value="">
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
    const city     = qs('.city',r).value.trim();
    const country  = qs('.country',r).value.trim();
    const daysVal  = qs('.days',r).value;
    const days     = Math.max(1, parseInt(daysVal||'0',10)||1);
    const baseDate = qs('.baseDate',r).value.trim();

    if(!city) return;
    const perDay = [];
    qsa('.hours-day', r).forEach((hd, idx)=>{
      if(idx===0) return; // encabezado
      const start = qs('.start',hd)?.value || DEFAULT_START;
      const end   = qs('.end',hd)?.value   || DEFAULT_END;
      perDay.push({ day: idx, start, end });
    });
    if(perDay.length===0){
      for(let d=1; d<=days; d++) perDay.push({day:d,start:DEFAULT_START,end:DEFAULT_END});
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

/* ================================
    SECCIÓN 11 · Contrato JSON / LLM
=================================== */
const FORMAT = `
Devuelve SOLO JSON válido (sin markdown) en uno de estos:
A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}]}], "followup":"Pregunta breve"}
B) {"destination":"City","rows":[{...}],"replace":true,"followup":"Pregunta breve"}
C) {"rows":[{...}],"replace":true,"followup":"Pregunta breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto","transport":"Texto","interests":["..."]},"followup":"Pregunta breve"}
Reglas:
- Optimiza el/los día(s) afectado(s) para aprovechar tiempo y recursos (minimiza traslados, agrupa por zonas, respeta ventanas horarias).
- Usa horas por día si están disponibles; si faltan, asume 08:30–19:00.
- No dupliques actividades; conserva las existentes salvo instrucción explícita de reemplazo.
- Máximo 20 filas de actividades por día.
- Nada de texto fuera del JSON.
`;

/* ================================
    SECCIÓN 12 · Llamada al agente
=================================== */
async function callAgent(text, useHistory = true){
  const history = useHistory ? session : [];
  const payload = { model: MODEL, input:text, history: history };
  try{
    const res = await fetch(API_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if(!res.ok) {
      console.error(`Error HTTP ${res.status} al llamar a la API: ${res.statusText}`);
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json().catch(()=>({text:''}));
    return data?.text || '';
  }catch(e){
    console.error("Fallo al contactar la API:", e);
    return `{"followup":"${tone.fail}"}`;
  }
}
async function callAgentFree(text){ // modo respuesta libre (no JSON)
  const payload = { model: MODEL, input:text, history: session };
  try{
    const res = await fetch(API_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(()=>({text:''}));
    return data?.text || '';
  }catch(e){
    console.error(e);
    return 'Pude tener un problema de conexión. Intenta de nuevo 😉';
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

/* ================================
    SECCIÓN 13 · Apply / Merge
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
function pushRows(city, rows, replace=false){
  if(!city || !rows) return;
  if(!itineraries[city]) itineraries[city] = {byDay:{},currentDay:1,baseDate:cityMeta[city]?.baseDate||null};
  if(replace) itineraries[city].byDay = {};
  rows.forEach(raw=>{
    const obj = normalizeRow(raw, 1);
    const d = obj.day;
    if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[];
    dedupeInto(itineraries[city].byDay[d], obj);
    if(itineraries[city].byDay[d].length>20) itineraries[city].byDay[d] = itineraries[city].byDay[d].slice(0,20);
  });
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
          const mapped = (rows||[]).map(r=>normalizeRow({...r, day:+k}, +k));
          pushRows(name, mapped, false);
        });
        return;
      }
      if(Array.isArray(d.rows)){
        const mapped = d.rows.map(r=>normalizeRow(r, 1));
        pushRows(name, mapped, Boolean(d.replace));
      }
    });
    return;
  }
  if(parsed.destination && Array.isArray(parsed.rows)){
    const name = parsed.destination;
    const mapped = parsed.rows.map(r=>normalizeRow(r, 1));
    pushRows(name, mapped, Boolean(parsed.replace));
    return;
  }
  if(Array.isArray(parsed.itineraries)){
    parsed.itineraries.forEach(x=>{
      const name = x.city || x.name || x.destination || activeCity || savedDestinations[0]?.city;
      if(!name) return;
      if(x.rowsByDay && typeof x.rowsByDay==='object'){
        Object.entries(x.rowsByDay).forEach(([k,rows])=>{
          const mapped = (rows||[]).map(r=>normalizeRow({...r, day:+k}, +k));
          pushRows(name, mapped, false);
        });
      }else if(Array.isArray(x.rows)){
        const mapped = x.rows.map(r=>normalizeRow(r, 1));
        pushRows(name, mapped, Boolean(x.replace));
      }
    });
    return;
  }
  if(Array.isArray(parsed.rows)){
    const city = activeCity || savedDestinations[0]?.city;
    const mapped = parsed.rows.map(r=>normalizeRow(r, 1));
    pushRows(city, mapped, Boolean(parsed.replace));
  }
}
function ensureFullCoverage(city){
  const dest = savedDestinations.find(x=>x.city===city);
  if(!dest) return;
  const days = dest.days || 1;
  const perDay = (cityMeta[city]?.perDay && cityMeta[city].perDay.length)
    ? cityMeta[city].perDay
    : Array.from({length:days}, (_,i)=>({day:i+1,start:DEFAULT_START,end:DEFAULT_END}));

  for(let d=1; d<=days; d++){
    const rows = itineraries[city]?.byDay?.[d] || [];
    if(!rows.length){
      pushRows(city, [{
        day:d, start:(perDay[d-1]?.start||DEFAULT_START), end:(perDay[d-1]?.end||DEFAULT_END),
        activity:'Bloque base (auto-completado)', from:'Hotel/Zona', to:'Recorrido',
        transport:'A pie', duration:'120m',
        notes:'✨ Punto base para organizar el día. ¡Luego lo afinamos!'
      }], false);
    }
  }
}

/* ================================
    SECCIÓN 14 · Fallback local inteligente
=================================== */
const LANDMARKS = {
  _generic: [
    'Casco histórico','Catedral/Basílica','Museo principal','Mercado central',
    'Mirador/colina','Parque urbano','Paseo por barrio emblemático','Plaza principal',
    'Museo alternativo','Café/pastelería típica','Cena recomendada'
  ]
};
function getLandmarksFor(city){ return LANDMARKS._generic; }
function addMinutes(hhmm, min){
  const [H,M] = hhmm.split(':').map(n=>parseInt(n||'0',10));
  const d = new Date(2000,0,1,H||0,M||0,0);
  d.setMinutes(d.getMinutes()+min);
  const HH = String(d.getHours()).padStart(2,'0');
  const MM = String(d.getMinutes()).padStart(2,'0');
  return `${HH}:${MM}`;
}
function synthesizeDayRows(start, end, picks){
  const blocks = [
    {label:`Desayuno cerca del hotel`, dur:45, type:'walk'},
    {label:picks[0], dur:120, type:'walk'},
    {label:picks[1], dur:90, type:'metro'},
    {label:`Almuerzo típico`, dur:70, type:'walk'},
    {label:picks[2], dur:75, type:'walk'},
    {label:picks[3], dur:90, type:'metro'},
    {label:`Café/pastelería local`, dur:35, type:'walk'},
    {label:`Cena recomendada`, dur:90, type:'walk'}
  ];
  let cur = start||DEFAULT_START;
  const rows=[];
  blocks.forEach((b,i)=>{
    const s = cur;
    let e = addMinutes(cur, b.dur);
    if(e>end) e=end;
    const transport = (b.type==='metro'?'Metro/Bus':'A pie');
    rows.push({ day:1, start:s, end:e, activity:b.label, from: i===0?'Hotel/Zona':'', to:'', transport, duration: (b.dur+'m'), notes:'Itinerario base (auto-generado). Ajustable.' });
    cur = addMinutes(e, 10);
    if(cur>=end) return;
  });
  if(rows.length) rows[rows.length-1].end = end;
  return rows;
}
function synthesizeLocalItinerary(city, days, perDay){
  const rowsByDay = {};
  const pool = getLandmarksFor(city).slice();
  for(let d=1; d<=days; d++){
    const pd = perDay.find(x=>x.day===d) || {start:DEFAULT_START, end:DEFAULT_END};
    const s = pd.start || DEFAULT_START;
    const e = pd.end   || DEFAULT_END;
    const picks=[];
    for(let i=0;i<4;i++) picks.push(pool[(d*3+i) % pool.length]);
    const dayRows = synthesizeDayRows(s,e,picks).map(r=>({...r, day:d}));
    rowsByDay[d]=dayRows;
  }
  return rowsByDay;
}

/* ================================
    SECCIÓN 15 · Generación por ciudad
=================================== */
const AURORA_CITIES = ['Reykjavik','Reikiavik','Tromso','Tromsø','Rovaniemi','Abisko','Kiruna','Fairbanks','Yellowknife','Murmansk'];
const HOTSPRING_HINTS = ['Reykjavik','Reikiavik','Hveragerdi','Flúðir','Selfoss','Grindavik'];
const DAYTRIP_SUGGEST = {
  'Madrid': ['Segovia','Toledo','Ávila','El Escorial'],
  'Paris': ['Versalles','Giverny','Fontainebleau'],
  'Barcelona': ['Montserrat','Sitges','Girona'],
  'London': ['Windsor','Oxford','Cambridge'],
};
function suggestedActivitiesFor(city, days){
  const picks = [];
  if(AURORA_CITIES.some(n=>n.toLowerCase()===city.toLowerCase())){
    picks.push('Caza de auroras (21:00–23:30)');
  }
  if(HOTSPRING_HINTS.some(n=>n.toLowerCase()===city.toLowerCase())){
    picks.push('Aguas termales (Blue Lagoon / Sky Lagoon / Secret Lagoon)');
  }
  const dayTrips = DAYTRIP_SUGGEST[city];
  if(dayTrips && days>=2) picks.push(`Excursión 1 día: ${dayTrips.slice(0,3).join(' / ')}`);
  if(!picks.length) picks.push('Imperdibles locales & experiencias gastronómicas');
  return picks.slice(0,5);
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
  const interests= cityMeta[city]?.interests || [];

  const auroraHint = AURORA_CITIES.some(n=>n.toLowerCase()===city.toLowerCase())
    ? 'Si aplica en temporada, considera incluir “Caza de auroras” 21:00–23:30 (ajústalo si el usuario indica otra franja).'
    : '';
  const hotspringHint = HOTSPRING_HINTS.some(n=>n.toLowerCase()===city.toLowerCase())
    ? 'Considera aguas termales (Blue Lagoon / Sky Lagoon / Secret Lagoon) con horarios habituales y reservas anticipadas.'
    : '';
  const dayTripHint = DAYTRIP_SUGGEST[city] ? `Si hay espacio, sugiere excursiones de 1 día cercanas: ${DAYTRIP_SUGGEST[city].join(', ')}.` : '';

  const instructions = `
${FORMAT}
Eres un experto concierge de viajes con 40 años de experiencia. Responde con tono cálido, humano y variado.
Genera el itinerario completo SOLO para "${city}" para ${dest.days} día(s), optimizando tiempos/recursos.
- Usa el formato B con "destination":"${city}" y "rows"; incluye "replace": true.
- No dupliques actividades; conserva lo útil y mejora donde aporte valor.
- Respeta horas por día (si faltan, usa 08:30–19:00).

Datos:
- Ciudad: "${city}"
- Días: ${dest.days}
- Horas por día: ${JSON.stringify(perDay)}
- BaseDate: ${baseDate||'N/A'}
- Hotel/Zona: ${hotel||'pendiente'}
- Transporte: ${transport}
- Intereses: ${JSON.stringify(interests)}

Consideraciones:
- ${auroraHint}
- ${hotspringHint}
- ${dayTripHint}

Contexto:
${buildIntake()}
`.trim();

  let text = await callAgent(instructions, false);
  let parsed = parseJSON(text);

  if(!parsed || (!parsed.rows && !parsed.destinations && !parsed.itineraries)){
    const strict = `
${FORMAT}
**REINTENTO:** Genera **SOLO** el itinerario para "${city}" (${dest.days} días) en formato B con "replace": true.
`.trim();
    text = await callAgent(strict, false);
    parsed = parseJSON(text);
  }

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    applyParsedToState(parsed);
    ensureFullCoverage(city);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    return;
  }

  // Fallback local
  const rowsByDay = synthesizeLocalItinerary(city, dest.days, perDay);
  const rowsFlat = Object.entries(rowsByDay).flatMap(([d,rows])=>rows.map(r=>({...r, day:+d})));
  pushRows(city, rowsFlat, true);
  renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
  chatMsg('⚠️ Fallo crítico del asistente. Generé una propuesta base por día para que puedas seguir trabajando manualmente.', 'ai');
}

/* ================================
    SECCIÓN 16 · Flujo principal · HOTELS + INTERESTS
=================================== */
async function startPlanning(){
  if(savedDestinations.length===0) return;
  $chatBox.style.display='flex';
  planningStarted = true;
  collectingHotels = true;
  collectingInterests = false;
  metaProgressIndex = 0;

  session = []; // solo edición
  chatMsg(`${tone.hi}`);
  askNextHotelTransport();
}
function askNextHotelTransport(){
  if(metaProgressIndex >= savedDestinations.length){
    collectingHotels = false;
    collectingInterests = true;
    metaProgressIndex = 0;
    askNextInterests();
    return;
  }
  const city = savedDestinations[metaProgressIndex].city;
  setActiveCity(city); renderCityItinerary(city);
  chatMsg(tone.askHotelTransport(city),'ai');
}
function askNextInterests(){
  if(metaProgressIndex >= savedDestinations.length){
    collectingInterests = false;
    chatMsg(tone.confirmAll);
    (async ()=>{
      showWOW(true);
      for(const {city} of savedDestinations){
        await generateCityItinerary(city);
      }
      showWOW(false);
      chatMsg(tone.doneAll);
    })();
    return;
  }
  const city = savedDestinations[metaProgressIndex].city;
  const days = savedDestinations[metaProgressIndex].days || 1;
  const picks = suggestedActivitiesFor(city, days);
  setActiveCity(city); renderCityItinerary(city);
  chatMsg(tone.askInterestsIntro(city, picks),'ai');
}

/* ================================
    SECCIÓN 17 · Chat handler (NLU para horas y movimientos)
=================================== */
// ==== Utilidades NLU v32 ====
const WORD_NUM = { 'uno':1,'dos':2,'tres':3,'cuatro':4,'cinco':5,'seis':6,'siete':7,'ocho':8,'nueve':9,'diez':10,'once':11,'doce':12,'trece':13,'catorce':14,'quince':15,'dieciséis':16,'dieciseis':16,'diecisiete':17,'dieciocho':18,'diecinueve':19,'veinte':20 };
function toNumberWord(w){
  w = w.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
  return WORD_NUM[w] ?? null;
}
function normalizeHourToken(tok){
  tok = tok.toLowerCase().trim();
  tok = tok.normalize('NFD').replace(/\p{Diacritic}/gu,'');
  const mapWords = { 'mediodia':'12:00', 'medianoche':'00:00' };
  if(mapWords[tok]) return mapWords[tok];

  // "siete y media", "7 y cuarto", "nueve y diez"
  let m = tok.match(/^([a-z]+|\d{1,2})\s+y\s+(media|cuarto|(\d{1,2}))\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if(m){
    let hh = isNaN(+m[1]) ? toNumberWord(m[1]) : parseInt(m[1],10);
    let mm = 0;
    if(m[2]==='media') mm = 30;
    else if(m[2]==='cuarto') mm = 15;
    else mm = parseInt(m[3]||'0',10);
    const ap = m[4]?.toLowerCase();
    if(ap){ if((ap.includes('p')||ap==='pm') && hh<12) hh+=12; if((ap.includes('a')||ap==='am')&&hh===12) hh=0; }
    if(hh>=0 && hh<=24 && mm>=0 && mm<60) return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  }

  // "7", "7:30", "9 pm", "siete", "13"
  m = tok.match(/^([a-z]+|\d{1,2})(?::(\d{1,2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if(m){
    let hh = isNaN(+m[1]) ? toNumberWord(m[1]) : parseInt(m[1],10);
    let mm = m[2]?parseInt(m[2],10):0;
    const ap = m[3]?.toLowerCase();
    if(ap){
      if((ap.includes('p')||ap==='pm') && hh<12) hh += 12;
      if((ap.includes('a')||ap==='am') && hh===12) hh = 0;
    }
    if(hh>=0 && hh<=24 && mm>=0 && mm<60) return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
  }
  return null;
}
function parseTimeRangeFromText(text){
  const t = text.toLowerCase();
  let m = t.match(/(?:de|entre)\s+([a-z0-9: ]+(?:am|pm|a\.m\.|p\.m\.)?)\s*(?:a|hasta|y)\s*([a-z0-9: ]+(?:am|pm|a\.m\.|p\.m\.)?)/i);
  if(m){
    const s = normalizeHourToken(m[1]);
    const e = normalizeHourToken(m[2]);
    if(s||e) return {start:s||null, end:e||null};
  }
  m = t.match(/(?:empezar|iniciar|arrancar|inicio|comenzar)\s*(?:el d[ií]a|la jornada)?\s*(?:a|a las)?\s*([a-z0-9: ]+(?:am|pm|a\.m\.|p\.m\.)?)/i);
  const startOnly = m ? normalizeHourToken(m[1]) : null;
  m = t.match(/(?:terminar|finalizar|hasta|cerrar)\s*(?:a las|a)?\s*([a-z0-9: ]+(?:am|pm|a\.m\.|p\.m\.)?)/i);
  const endOnly = m ? normalizeHourToken(m[1]) : null;
  return {start:startOnly, end:endOnly};
}
function parseAddRemoveMoveIntents(text){
  const t = text.toLowerCase();

  // add day possibly with day-trip destination
  let m = t.match(/(agrega|añade|sum[a]?|agregar|añadir)\s+un\s+d[ií]a\s+m[aá]s\s+en\s+([a-záéíóúüñ ]+)(?:\s+para\s+ir\s+a\s+([a-záéíóúüñ ]+))?/i);
  if(m) return {type:'add-day', city:m[2].trim().replace(/\s+/g,' ').replace(/^\w/,c=>c.toUpperCase()), toCity: m[3]?.trim()||null};

  // remove day
  m = t.match(/(un\s+d[ií]a\s+menos|quita|elimina|remueve)\s+(?:en\s+)?([a-záéíóúüñ ]+)/i);
  if(m) return {type:'remove-day', city:m[2].trim().replace(/\s+/g,' ').replace(/^\w/,c=>c.toUpperCase())};

  // move activities between days
  m = t.match(/(?:mueve|pasa|cambia).+?d[ií]a\s*(\d+)\s*(?:al|a)\s*d[ií]a\s*(\d+)/i);
  if(m) return {type:'move-day', from:parseInt(m[1],10), to:parseInt(m[2],10)};

  // explicit day-trip request
  m = t.match(/(?:ir|excursi[oó]n).+?\s+a\s+([a-záéíóúüñ ]+)\s+(?:desde|partiendo de)\s+([a-záéíóúüñ ]+)/i);
  if(m) return {type:'day-trip', toCity:m[1].trim(), city:m[2].trim()};

  return null;
}
function isInfoOnlyQuery(text){
  const t = text.toLowerCase();
  return /(clima|tiempo|temperatura|horas de luz|aerol[ií]neas|tiquetes|vuelos|equipaje|ropa|alquiler de auto|conducir|seguridad|costos|moneda|propinas|enchufes|visa|visado)/i.test(t);
}

// ==== Confirm & apply ====
async function confirmAndApply(change){
  pendingChange = change;
  const msg = {
    'add-day': `Agregar <strong>1 día</strong> en <strong>${change.city}</strong>${change.toCity?` para visitar <strong>${change.toCity}</strong>`:''}.`,
    'remove-day': `Eliminar <strong>1 día</strong> en <strong>${change.city}</strong>. ¿Qué número de día deseas eliminar? Escríbelo (ej. "Día 2").`,
    'move-day': `Mover actividades del <strong>día ${change.from}</strong> al <strong>día ${change.to}</strong> en <strong>${activeCity}</strong>.`,
    'edit-hours': `Actualizar horarios del <strong>día ${change.day}</strong> en <strong>${activeCity}</strong> ${change.start?`(inicio: ${change.start})`:''} ${change.end?`(fin: ${change.end})`:''}.`,
    'day-trip': `Agregar excursión de 1 día a <strong>${change.toCity}</strong> saliendo desde <strong>${change.city}</strong>.`
  }[change.type] || 'Aplicar cambios.';
  chatMsg(tone.askConfirm(msg),'ai');
}
function parseYes(text){ return /\b(s[ií]|sí|si|dale|ok|de acuerdo|aplica|vamos)\b/i.test(text); }
function parseDayNumber(text){
  const m = text.match(/d[ií]a\s*(\d+)/i);
  if(m) return parseInt(m[1],10);
  const n = toNumberWord(text.trim());
  return n||null;
}

// ==== Handler principal ====
async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  // Paso 1: recolección hotel + transporte
  if(collectingHotels){
    const city = savedDestinations[metaProgressIndex].city;
    const transport = (()=>{
      const t = text.toLowerCase();
      if(/recomiend/.test(t)) return 'recomiéndame';
      if(/alquilad|rent|veh[ií]culo|auto|coche|carro/.test(t)) return 'vehículo alquilado';
      if(/metro|tren|bus|autob[uú]s|p[uú]blico/.test(t)) return 'transporte público';
      if(/uber|taxi|cabify|lyft/.test(t)) return 'otros (Uber/Taxi)';
      if(/combinad|mixt/.test(t)) return 'combinado';
      return cityMeta[city]?.transport || 'recomiéndame';
    })();
    const hotel = text;
    upsertCityMeta({ city, hotel, transport });
    chatMsg(`Anotado para <strong>${city}</strong>: hotel/zona y transporte.`, 'ai');
    metaProgressIndex++;
    askNextHotelTransport();
    return;
  }
  // Paso 2: intereses
  if(collectingInterests){
    const city = savedDestinations[metaProgressIndex].city;
    const picks = /no\b/i.test(text) ? [] : text.split(/[,\n;·•]/).map(s=>s.trim()).filter(Boolean);
    upsertCityMeta({city, interests: picks});
    chatMsg(`Anotado para <strong>${city}</strong>: ${picks.length? picks.join(' · ') : 'sin actividades extra por ahora'}.`, 'ai');
    metaProgressIndex++;
    askNextInterests();
    return;
  }

  const currentCity = activeCity || savedDestinations[0]?.city;
  const data = itineraries[currentCity];
  if(!currentCity || !data){
    chatMsg('Aún no hay itinerario en pantalla. Por favor, inicia la planificación primero.');
    return;
  }
  session.push({role: 'user', content: text});

  // Si tenemos un pendingChange esperando confirmación
  if(pendingChange){
    if(pendingChange.type==='remove-day' && !pendingChange.payload?.day){
      // esperamos el número de día
      const num = parseDayNumber(text);
      if(!num){ chatMsg('Necesito el número del día (ej. “Día 2”).', 'ai'); return; }
      pendingChange.payload = {day:num};
      chatMsg(tone.askConfirm(`Eliminar el <strong>día ${num}</strong> en <strong>${pendingChange.city}</strong>.`),'ai');
      return;
    }
    if(parseYes(text)){
      await applyPendingChange();
      pendingChange = null;
      return;
    }else{
      chatMsg('Sin problemas, no haré cambios. ¿En qué más te ayudo? 😊','ai');
      pendingChange = null;
      return;
    }
  }

  // Detección de info-only
  if(isInfoOnlyQuery(text)){
    const infoPrompt = `
Responde como experto en viajes (40 años de experiencia), con tono cálido y natural.
Contesta a la consulta del usuario con datos útiles, tips y estructura clara, sin modificar itinerarios.
Consulta del usuario: """${text}"""
Finaliza preguntando si desea que guarde/ajuste algo en los itinerarios con esa información.
`.trim();
    showWOW(true);
    const reply = await callAgentFree(infoPrompt);
    showWOW(false);
    chatMsg(reply || 'Te compartí recomendaciones útiles. ¿Quieres que las refleje en el itinerario?', 'ai');
    return;
  }

  // Detección de intents mayores (add/remove/day-trip/move)
  const intent = parseAddRemoveMoveIntents(text);
  if(intent){
    if(intent.type==='add-day'){
      await confirmAndApply({type:'add-day', city:intent.city||currentCity, toCity:intent.toCity||null});
      return;
    }
    if(intent.type==='remove-day'){
      await confirmAndApply({type:'remove-day', city:intent.city||currentCity, payload:null});
      return;
    }
    if(intent.type==='move-day'){
      await confirmAndApply({type:'move-day', city:currentCity, from:intent.from, to:intent.to});
      return;
    }
    if(intent.type==='day-trip'){
      await confirmAndApply({type:'day-trip', city:intent.city||currentCity, toCity:intent.toCity});
      return;
    }
  }

  // Cambios de horario del día visible (no auto-aplico, pido confirmación)
  const range = parseTimeRangeFromText(text);
  if(range.start || range.end){
    await confirmAndApply({type:'edit-hours', city:currentCity, day:(data.currentDay||1), start:range.start||null, end:range.end||null});
    return;
  }

  // Ediciones generales (cambiar actividad, etc.) -> prompt de edición (con confirm implícita via followup)
  const day = data.currentDay || 1;
  const dayRows = (data.byDay[day]||[]).map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)';
  const allDays = Object.keys(data.byDay).map(n=>{
    const rows = data.byDay[n]||[];
    return `Día ${n}:\n${rows.map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)'}`;
  }).join('\n\n');

  const cityPerDay = (cityMeta[currentCity]?.perDay||[]).map(pd=>({day:pd.day, start:pd.start||DEFAULT_START, end:pd.end||DEFAULT_END}));

  const prompt = `
${FORMAT}
Eres un experto en turismo internacional (40 años). Responde de forma humana y motivadora.
El usuario pide un ajuste en "${currentCity}". Optimiza sin duplicar y respeta ventanas.
- Devuelve formato B {"destination":"${currentCity}","rows":[...],"replace": true} con filas SOLO del/los día(s) afectado(s).
Contexto:
${buildIntake()}

Día visible: ${day}
Actividades del día: 
${dayRows}

Resto de días (solo referencia):
${allDays}

Ventanas por día: ${JSON.stringify(cityPerDay)}
Solicitud literal del usuario: """${text}"""
`.trim();

  showWOW(true);
  const ans = await callAgent(prompt);
  const parsed = parseJSON(ans);
  if(parsed?.followup) session.push({role: 'assistant', content: parsed.followup});
  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    applyParsedToState(parsed);
    ensureFullCoverage(currentCity);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    chatMsg(parsed.followup || tone.humanDone, 'ai');
  }else{
    chatMsg(parsed?.followup || 'No recibí cambios válidos. ¿Quieres que lo intentemos de otra forma?','ai');
  }
  showWOW(false);
}

// Aplica pendingChange
async function applyPendingChange(){
  const ch = pendingChange;
  const city = ch.city || activeCity;
  if(!city) { chatMsg('No encontré la ciudad objetivo.','ai'); return; }

  if(ch.type==='add-day'){
    // incrementar días y generar contenido nuevo (si toCity -> day-trip)
    const dest = savedDestinations.find(d=>d.city===city);
    if(!dest){ chatMsg('No encontré la ciudad en destinos.','ai'); return; }
    dest.days += 1;
    if(!cityMeta[city]) cityMeta[city]={perDay:[]};
    cityMeta[city].perDay = cityMeta[city].perDay || [];
    cityMeta[city].perDay.push({day:dest.days,start:DEFAULT_START,end:DEFAULT_END});
    if(!itineraries[city]) itineraries[city]={byDay:{},currentDay:1,baseDate:dest.baseDate||null};
    itineraries[city].byDay[dest.days] = [];
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);

    showWOW(true);
    await generateCityItinerary(city);
    // Si hay day-trip destino específico -> lo mencionamos al agente en edición del día nuevo
    if(ch.toCity){
      const editPrompt = `
${FORMAT}
Añade una jornada de excursión de 1 día a "${ch.toCity}" saliendo y regresando a "${city}" en el nuevo día agregado.
Optimiza el día creado, sin afectar los demás. Devuelve formato B con "replace": false y rows del día nuevo.
Contexto:
${buildIntake()}
`.trim();
      const reply = await callAgent(editPrompt);
      const pj = parseJSON(reply);
      if(pj) { applyParsedToState(pj); renderCityTabs(); setActiveCity(city); renderCityItinerary(city); }
    }
    showWOW(false);
    chatMsg('¡Hecho! Agregué un día y lo optimicé. ✨','ai');
    return;
  }

  if(ch.type==='remove-day'){
    const dest = savedDestinations.find(d=>d.city===city);
    if(!dest){ chatMsg('No encontré la ciudad en destinos.','ai'); return; }
    const dayToRemove = ch.payload?.day;
    if(!dayToRemove || !itineraries[city]?.byDay?.[dayToRemove]){
      chatMsg('Ese día no existe. ¿Quieres intentar con otro número?','ai'); return;
    }
    // Elimina y reindexa
    delete itineraries[city].byDay[dayToRemove];
    const newByDay = {};
    let idx=1;
    Object.keys(itineraries[city].byDay).map(n=>+n).sort((a,b)=>a-b).forEach(d=>{
      newByDay[idx] = (itineraries[city].byDay[d]||[]).map(r=>({...r, day:idx}));
      idx++;
    });
    itineraries[city].byDay = newByDay;
    dest.days = Math.max(1, dest.days-1);
    cityMeta[city].perDay = Array.from({length:dest.days}, (_,i)=> cityMeta[city].perDay?.[i] || {day:i+1,start:DEFAULT_START,end:DEFAULT_END});
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    chatMsg(`✅ Eliminé el día ${dayToRemove} y actualicé la numeración en ${city}.`, 'ai');
    return;
  }

  if(ch.type==='move-day'){
    const from = ch.from, to = ch.to;
    const block = itineraries[city]?.byDay?.[from] || [];
    if(!block.length){ chatMsg('No encontré actividades en el día origen.','ai'); return; }
    // mueve actividades, concatena y re-optimiza por agente
    itineraries[city].byDay[to] = (itineraries[city].byDay[to] || []).concat(block.map(r=>({...r, day:to})));
    itineraries[city].byDay[from] = [];
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);

    const prompt = `
${FORMAT}
Re-optimiza "${city}" para los días ${from} y ${to} tras mover actividades.
- No dupliques.
- Devuelve solo filas de los días ${from} y ${to} en formato B con "replace": false.
Contexto:
${buildIntake()}
`.trim();
    showWOW(true);
    const ans = await callAgent(prompt);
    const pj = parseJSON(ans);
    if(pj) { applyParsedToState(pj); renderCityTabs(); setActiveCity(city); renderCityItinerary(city); }
    showWOW(false);
    chatMsg(tone.humanDone,'ai');
    return;
  }

  if(ch.type==='edit-hours'){
    const d = ch.day;
    const per = cityMeta[city]?.perDay || [];
    const slot = per.find(x=>x.day===d);
    if(slot){
      if(ch.start) slot.start = ch.start;
      if(ch.end)   slot.end   = ch.end;
    }
    const editPrompt = `
${FORMAT}
Actualiza "${city}" para el Día ${d} usando la ventana: ${JSON.stringify(slot || {start:DEFAULT_START,end:DEFAULT_END})}
- Re-optimiza SOLO el Día ${d}.
- Formato B con "replace": false y filas del Día ${d}.
Contexto:
${buildIntake()}
`.trim();
    showWOW(true);
    const ans = await callAgent(editPrompt);
    const pj = parseJSON(ans);
    if(pj){ applyParsedToState(pj); renderCityTabs(); setActiveCity(city); renderCityItinerary(city); }
    showWOW(false);
    chatMsg(tone.humanDone,'ai');
    return;
  }

  if(ch.type==='day-trip'){
    const prompt = `
${FORMAT}
Agrega una excursión de 1 día a "${ch.toCity}" saliendo y regresando a "${city}" en el mejor día disponible.
- Si el destino tiene varios puntos (ej. Segovia/Toledo), recorre lo esencial; si es único (Versalles), detállalo como actividad única.
- Devuelve formato B con "replace": false.
Contexto:
${buildIntake()}
`.trim();
    showWOW(true);
    const ans = await callAgent(prompt);
    const pj = parseJSON(ans);
    if(pj){ applyParsedToState(pj); renderCityTabs(); setActiveCity(city); renderCityItinerary(city); }
    showWOW(false);
    chatMsg('Añadí la excursión y ajusté tu plan para que rinda mejor. ✨','ai');
    return;
  }
}

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

// Eventos base (igual que v31.2 excepto mejoras menores)
$addCity?.addEventListener('click', ()=>addCityRow());
$reset?.addEventListener('click', ()=>{
  $cityList.innerHTML=''; savedDestinations=[]; itineraries={}; cityMeta={};
  addCityRow();
  $start.disabled = true;
  $tabs.innerHTML=''; $itWrap.innerHTML='';
  $chatBox.style.display='none'; $chatM.innerHTML='';
  session = []; pendingChange=null;
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

// Toolbar
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

// Inicial
addCityRow();
