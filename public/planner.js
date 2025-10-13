/* =========================================================
    ITRAVELBYMYOWN · PLANNER v31.2
    Base: v31.1 (manteniendo estructura y comportamiento)
    Refuerzos tomados de v29 para edición robusta:
      - Agregar / eliminar días (con confirmación) y renumeración
      - Ajustes de horas por día sin duplicar
      - Detección NL más precisa (evitar generar ante preguntas neutras)
    Ajustes solicitados:
      - Sugerencias de actividades por ciudad (máx. 5) antes de generar
      - Encabezados tabla: "Hora inicio" / "Hora final"
      - Conversación natural, cálida y no repetitiva
      - Preguntar por hotel + transporte + actividades por ciudad (flujo ordenado)
      - Regla de horarios por defecto (08:30–19:00) cuando falte información
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
let collectingInterests = false; // paso para actividades por ciudad
let isItineraryLocked = false;

const DEFAULT_START = '08:30';
const DEFAULT_END   = '19:00';

// (v31.1) flags/UI existentes
let hasSavedOnce = false;
const changedCities = new Set();
let globalChanged = false;

/* ================================
    SECCIÓN 2 · Tono / Mensajería
=================================== */
const tone = {
  es: {
    hi: '¡Bienvenido! 👋 Soy tu concierge de viajes personal. Vamos ciudad por ciudad para dejar tu viaje perfecto.',
    askHotelTransport: (city)=>`Cuéntame, ¿en qué <strong>hotel/zona</strong> te hospedarás en <strong>${city}</strong> y qué <strong>medio de transporte</strong> usarás? Opciones: <em>Vehículo alquilado</em> · <em>Transporte público</em> · <em>Otros (Uber/Taxi)</em> · <em>Combinado</em> · <em>Recomiéndame</em>.<br><small style="display:block;color:#667085;margin-top:.25rem">Responde en lenguaje natural, por ejemplo: “Hotel X en el centro y recomiéndame el transporte”.</small>`,
    askInterestsIntro: (city, picks)=>`En <strong>${city}</strong> suelen disfrutar mucho de: ${picks.join(' · ')}. ¿Quieres incluir alguna? Puedes decir nombres (ej. <em>${picks.slice(0,Math.min(3,picks.length)).join(', ')}</em>) o “no gracias”.`,
    confirmAll: '✨ Genial. Con esa info ya puedo armarlo. Preparando itinerarios…',
    doneAll: '🎉 Itinerarios listos. ¿Te gustaría ajustar algo más o lo dejamos perfecto tal cual?',
    fail: '⚠️ No pude contactar al asistente. Revisa la consola y tu configuración (API Key / URL).'
  }
}['es'];

/* ================================
    SECCIÓN 3 · Referencias DOM
=================================== */
const $cityList = qs('#city-list');
const $addCity  = qs('#add-city-btn');
const $reset    = qs('#reset-planner');         // puede no existir en HTML final, manejo con ?.
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

const $overlayWOW  = qs('#loading-overlay');  // Overlay (reloj de arena)
const $recalcFab   = qs('#recalc-fab');       // puede existir o no, manejo con ?.

/* ================================
    SECCIÓN 4 · Utilidades de fecha
=================================== */
function autoFormatDMYInput(el){
  el.addEventListener('input', ()=>{
    const v = el.value.replace(/\D/g,'').slice(0,8);
    el.value = (v.length===8) ? `${v.slice(0,2)}/${v.slice(2,4)}/${v.slice(4,8)}` : v;
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
function makeHoursBlock(days){
  const wrap = document.createElement('div');
  wrap.className = 'hours-block';
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
  autoFormatDMYInput(qs('.baseDate', row));

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
    if(hasSavedOnce){
      const c = qs('.city',row).value.trim();
      if(c) changedCities.add(c);
      showRecalcFab();
    }
  });

  qs('.remove',row).addEventListener('click', ()=>{
    row.remove();
    if(hasSavedOnce) showRecalcFab();
  });

  row.addEventListener('input', ()=>{
    if(hasSavedOnce){
      const c = qs('.city',row).value.trim();
      if(c) changedCities.add(c);
      showRecalcFab();
    }
  });

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
      const start = qs('.start',hd).value || DEFAULT_START;
      const end   = qs('.end',hd).value   || DEFAULT_END;
      perDay.push({ day: idx+1, start, end });
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

  hasSavedOnce = true;
  changedCities.clear();
  globalChanged = false;
  hideRecalcFab();
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

  // Completar perDay por ciudad con reglas por defecto (si faltan)
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
- Optimiza el/los día(s) afectado(s) (minimiza traslados, agrupa por zonas, respeta ventanas horarias).
- Usa horas por día si están disponibles; si faltan, asume 08:30–19:00.
- No dupliques actividades; conserva las existentes salvo instrucción explícita de reemplazo.
- Máximo 20 filas de actividades por día.
- Notas humanas y breves (motivadoras, con iconos sutiles ✨ ☕ 🏰).
- Nada de texto fuera del JSON.
`;

/* ================================
    SECCIÓN 12 · Llamada al agente
=================================== */
async function callAgent(text, useHistory = true){
  const history = useHistory ? session : [];
  const payload = {
    model: MODEL,
    input: `Responde con naturalidad, variando el tono (cálido, motivador, humano). Evita repeticiones. Si el usuario pregunta por clima, transporte o información general, contesta sin modificar itinerarios. Si detectas intención de cambiar el plan (agregar/eliminar día, mover actividades, cambiar horas), confirma antes de aplicar. 
${text}`,
    history
  };
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
    SECCIÓN 13 · Apply / Merge (reforzada)
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
        transport:'A pie', duration:'120m', notes:'✨ Base inicial para que tu día fluya sin prisas.'
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
function getLandmarksFor(_city){ return LANDMARKS._generic; }
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
    rows.push({
      day:1, start:s, end:e, activity:b.label,
      from: i===0?'Hotel/Zona':'', to:'', transport,
      duration: (b.dur+'m'), notes:'☕ Ritmo relajado para disfrutar sin correr.'
    });
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
// Sugerencias ciudad-relevantes (máx 5)
const DAYTRIP_SUGGEST = {
  'Madrid': ['Segovia','Toledo','Ávila','El Escorial'],
  'Paris': ['Versalles','Giverny','Fontainebleau'],
  'Barcelona': ['Montserrat','Sitges','Girona'],
  'London': ['Windsor','Oxford','Cambridge'],
};
function suggestedActivitiesFor(city, days){
  const picks = [];
  const lc = city.toLowerCase();
  if(/troms|reykjav|rovaniemi|abisko|kiruna|yellowknife|fairbanks|auror/.test(lc)){
    picks.push('Caza de auroras (21:00–23:30)');
  }
  if(/reykjav|hverager|grindav|lagoon|fl[uú]dir|sky lagoon|blue lagoon|secret lagoon/.test(lc)){
    picks.push('Aguas termales (Blue/Sky/Secret Lagoon)');
  }
  const trips = DAYTRIP_SUGGEST[city];
  if(trips && days>=3) picks.push(`Excursión de 1 día: ${trips.slice(0,3).join(' / ')}`);
  if(!picks.length) picks.push('Imperdibles locales y experiencias gastronómicas');
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

  const instructions = `
${FORMAT}
**INSTRUCCIÓN CRÍTICA (Planner ITravelByMyOwn):**
Genera el itinerario SOLO para "${city}" (${dest.days} día/s) optimizando desplazamientos, evitando duplicados y respetando ventanas de tiempo por día.
- Salida: formato B {"destination":"${city}","rows":[...],"replace": true}
- Si ya existen días con contenido, re-optimiza sin duplicar; mejora secuencias y notas humanas (breves y motivadoras).
- Respeta ventanas por día; si faltan, usa 08:30–19:00.

Datos de Viaje:
- Ciudad: "${city}"
- Días totales: ${dest.days}
- Horas por día (start/end): ${JSON.stringify(perDay)}
- BaseDate (día 1): ${baseDate||'N/A'}
- Hotel/Zona base: ${hotel||'pendiente'}
- Transporte: ${transport}
- Intereses declarados: ${JSON.stringify(interests)}

Contexto (solo referencia; no repetir en salida):
${buildIntake()}
`.trim();

  let text = await callAgent(instructions, false); // sin historial
  let parsed = parseJSON(text);

  if(!parsed || (!parsed.rows && !parsed.destinations && !parsed.itineraries)){
    const strict = `
${FORMAT}
**REINTENTO ESTRICTO:** Devuelve SOLO {"destination":"${city}","rows":[...],"replace": true} utilizable.
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
  chatMsg('⚠️ No obtuve respuesta válida del asistente. Te propuse una base para avanzar mientras verificas tu configuración.', 'ai');
}

/* ================================
    SECCIÓN 16 · Flujo principal · HOTELS + INTERESTS
=================================== */
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
  const picks = suggestedActivitiesFor(city, days); // máx 5
  setActiveCity(city); renderCityItinerary(city);
  chatMsg(tone.askInterestsIntro(city, picks),'ai');
}
async function startPlanning(){
  if(savedDestinations.length===0) return;
  $chatBox.style.display='flex';
  planningStarted = true;
  collectingHotels = true;
  collectingInterests = false;
  metaProgressIndex = 0;

  session = []; // reset historial edición
  chatMsg(`${tone.hi}`);
  askNextHotelTransport();
}

/* ================================
    SECCIÓN 17 · Chat handler (NLU edición)
=================================== */
// Utilidades NLU
function normalizeHourToken(tok){
  if(!tok) return null;
  tok = tok.toLowerCase().trim();
  const mapWords = { 'mediodía':'12:00', 'medianoche':'00:00' };
  if(mapWords[tok]) return mapWords[tok];
  const m = tok.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(a\.m\.|p\.m\.|am|pm)?$/i);
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
  const t = text.toLowerCase();
  let m = t.match(/(?:de|entre)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:a\.m\.|p\.m\.|am|pm)?)\s*(?:a|hasta|y)\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:a\.m\.|p\.m\.|am|pm)?)/i);
  if(m){
    const s = normalizeHourToken(m[1]);
    const e = normalizeHourToken(m[2]);
    if(s||e) return {start:s||null, end:e||null};
  }
  m = t.match(/(?:empezar|iniciar|arrancar|inicio)\s*(?:el d[ií]a|la jornada)?\s*(?:a|a las)?\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:a\.m\.|p\.m\.|am|pm)?)/i);
  const startOnly = m ? normalizeHourToken(m[1]) : null;
  m = t.match(/(?:terminar|finalizar|hasta)\s*(?:a las|a)?\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:a\.m\.|p\.m\.|am|pm)?)/i);
  const endOnly = m ? normalizeHourToken(m[1]) : null;
  return {start:startOnly, end:endOnly};
}
function parseTransportFromText(text){
  const t = text.toLowerCase();
  if(/recomiéndame|recomiendame|recomendame/.test(t)) return 'recomiéndame';
  if(/alquilad[oa]|rent[ao]|veh[ií]culo|auto|coche|carro/.test(t)) return 'vehículo alquilado';
  if(/metro|tren|bus|autob[uú]s|p[uú]blico/.test(t)) return 'transporte público';
  if(/uber|taxi|cabify|lyft/.test(t)) return 'otros (Uber/Taxi)';
  if(/combinad[oa]|mixt[oa]/.test(t)) return 'combinado';
  return '';
}
function extractHotelFromText(text){
  const m = text.match(/(?:hotel|hospedar[ée]?\s*en|zona|barrio)[:\s]*([^\|]+?)(?:\s*\||$)/i);
  if(m && m[1]) return m[1].trim();
  if(text.length<120) return text.trim();
  return '';
}

// Detección de intención (evitar disparos por preguntas neutras)
function classifyIntent(text){
  const t = text.toLowerCase();

  // intents de edición de plan
  const addDay = /(agrega|añade|suma)\s+un?\s+d[ií]a/.test(t);
  const removeDay = /(elimina|quita|borra)\s+un?\s+d[ií]a/.test(t) || /d[ií]a\s+menos/.test(t);
  const move = /(mueve|pasa|cambia).+d[ií]a\s*\d+\s*(?:al|a)\s*d[ií]a\s*\d+/.test(t);
  const changeHours = /(empezar|iniciar|arrancar|inicio|terminar|finalizar|hasta)\s/.test(t) || /de\s+\d/.test(t);

  // neutrales (NO deben disparar itinerarios)
  const weather = /(clima|tiempo|temperatura|lluvia|nevadas|fr[ií]o|calor)/.test(t);
  const general = /(moneda|presupuesto|propina|cómo llegar|visado|seguridad|zona|barrio|restaurante|gasolina|baños|alquiler|coche|seguro)/.test(t);

  if(addDay) return {type:'addDay'};
  if(removeDay) return {type:'removeDay'};
  if(move) return {type:'move'};
  if(changeHours) return {type:'changeHours'};

  if(weather) return {type:'neutralWeather'};
  if(general) return {type:'neutralGeneral'};
  return {type:'freeChat'};
}

// Eliminar día con confirmación
let pendingDeleteCity = null;
let awaitingDayNumber = false;

// Agregar día (crea un nuevo índice y ajusta savedDestinations)
function addDayToCity(city){
  if(!itineraries[city]) return;
  const currentDays = Object.keys(itineraries[city].byDay).map(Number);
  const nextDay = currentDays.length ? Math.max(...currentDays)+1 : 1;
  itineraries[city].byDay[nextDay] = [];
  const target = savedDestinations.find(x=>x.city===city);
  if(target) target.days = nextDay;
  // asegurar perDay también
  cityMeta[city] = cityMeta[city] || {};
  cityMeta[city].perDay = cityMeta[city].perDay || [];
  if(!cityMeta[city].perDay.find(x=>x.day===nextDay)){
    cityMeta[city].perDay.push({day:nextDay,start:DEFAULT_START,end:DEFAULT_END});
  }
  renderCityItinerary(city);
  chatMsg(`🗓️ Agregué un nuevo día (${nextDay}) a tu itinerario en ${city}. ¡Vamos a llenarlo de planes bonitos!`, 'ai');
}
function requestDeleteDay(city){
  pendingDeleteCity = city;
  awaitingDayNumber = true;
  chatMsg(`🗑️ ¿Qué día deseas eliminar de ${city}? Indícame el número (ej. "Día 2").`, 'ai');
}
function deleteDayFromCity(city, dayNum){
  if(!itineraries[city] || !itineraries[city].byDay[dayNum]) { chatMsg('No encuentro ese día, ¿puedes confirmar el número?', 'ai'); return; }
  const total = Object.keys(itineraries[city].byDay).length;
  delete itineraries[city].byDay[dayNum];
  const reordered = {};
  let idx = 1;
  Object.keys(itineraries[city].byDay).sort((a,b)=>a-b).forEach(d=>{
    reordered[idx++] = itineraries[city].byDay[d];
  });
  itineraries[city].byDay = reordered;
  const target = savedDestinations.find(x=>x.city===city);
  if(target) target.days = total-1;

  // Ajustar perDay
  if(cityMeta[city]?.perDay?.length){
    cityMeta[city].perDay = cityMeta[city].perDay
      .filter(x=>x.day!==dayNum)
      .sort((a,b)=>a.day-b.day)
      .map((x,i)=>({day:i+1,start:x.start,end:x.end}));
  }

  renderCityItinerary(city);
  chatMsg(`✅ Eliminé el día ${dayNum} y actualicé la numeración en ${city}.`, 'ai');
  awaitingDayNumber = false;
  pendingDeleteCity = null;
}

async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  // Paso: Recolección inicial por ciudad
  if(collectingHotels){
    const city = savedDestinations[metaProgressIndex].city;
    const hotel = extractHotelFromText(text) || text;
    const transport = parseTransportFromText(text) || cityMeta[city]?.transport || '';
    upsertCityMeta({ city, hotel, transport });
    chatMsg(`Perfecto, anoté ${hotel ? `<em>${hotel}</em>` : 'hotel/ zona pendiente'} y ${transport ? `<em>${transport}</em>` : 'transporte pendiente (puedo recomendarte)'} para <strong>${city}</strong>.`, 'ai');
    metaProgressIndex++;
    askNextHotelTransport();
    return;
  }
  if(collectingInterests){
    const city = savedDestinations[metaProgressIndex].city;
    const t = text.toLowerCase();
    const deny = t.includes('no') && !t.includes('sí') && !t.includes('si');
    let picks = [];
    if(!deny){
      picks = text.split(/[,\n;·•]/).map(s=>s.trim()).filter(Boolean);
    }
    upsertCityMeta({city, interests: picks});
    chatMsg(picks.length? `Anotado para ${city}: ${picks.join(' · ')}.` : `Sin actividades extra por ahora en ${city}.`, 'ai');
    metaProgressIndex++;
    askNextInterests();
    return;
  }

  // A partir de aquí, conversación/edición
  const currentCity = activeCity || savedDestinations[0]?.city;
  const data = itineraries[currentCity];
  if(!currentCity || !data){
    chatMsg('Aún no hay itinerario en pantalla. Pulsa "Iniciar planificación" cuando estés listo.','ai');
    return;
  }

  // Si hay una confirmación pendiente de eliminación de día
  if(awaitingDayNumber && pendingDeleteCity){
    const mv = text.toLowerCase().match(/d[ií]a\s*(\d+)/);
    if(mv){
      deleteDayFromCity(pendingDeleteCity, parseInt(mv[1],10));
      return;
    }else{
      chatMsg('Necesito el número del día (ej. "Día 2").', 'ai');
      return;
    }
  }

  session.push({role: 'user', content: text});
  const intent = classifyIntent(text);

  // Preguntas neutras → responder sin modificar itinerarios
  if(intent.type==='neutralWeather' || intent.type==='neutralGeneral' || intent.type==='freeChat'){
    const convOnly = `
Responde al usuario con naturalidad y calidez (varía el tono). 
No modifiques itinerarios. No devuelvas JSON. Responde en texto breve y útil.
Usuario: ${text}
`.trim();
    const ans = await callAgent(convOnly, true);
    const parsed = parseJSON(ans);
    if(parsed){ // por si el modelo se "distrae"
      chatMsg(parsed?.followup || 'Tengo esa info. ¿Quieres que la aplique a tu itinerario?', 'ai');
    }else{
      chatMsg(ans || '¡Listo! ¿Deseas que integre esta información a tu plan?', 'ai');
    }
    return;
  }

  // Edición de horarios / mover / agregar / eliminar día
  const day = data.currentDay || 1;
  const dayRows = (data.byDay[day]||[]).map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)';
  const allDays = Object.keys(data.byDay).map(n=>{
    const rows = data.byDay[n]||[];
    return `Día ${n}:\n${rows.map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)'}`;
  }).join('\n\n');

  const cityPerDay = (cityMeta[currentCity]?.perDay||[]).map(pd=>({day:pd.day, start:pd.start||DEFAULT_START, end:pd.end||DEFAULT_END}));

  // Cambios de horas
  const range = intent.type==='changeHours' ? parseTimeRangeFromText(text) : {start:null,end:null};
  if(range.start || range.end){
    const idx = day-1;
    if(cityPerDay[idx]){
      if(range.start) cityPerDay[idx].start = range.start;
      if(range.end)   cityPerDay[idx].end   = range.end;
    }
  }

  // Movimientos entre días
  let moveInstr = null;
  const mv = text.toLowerCase().match(/(?:mueve|pasa|cambia).+?d[ií]a\s*(\d+)\s*(?:al|a)\s*d[ií]a\s*(\d+)/i);
  if(mv){ moveInstr = {from: parseInt(mv[1],10), to: parseInt(mv[2],10)}; }

  // Agregar día (detectar ciudad mencionada, por si no es la activa)
  if(intent.type==='addDay'){
    // ¿menciona una ciudad explícita?
    let targetCity = currentCity;
    for(const d of savedDestinations){
      const name = d.city.toLowerCase();
      if(text.toLowerCase().includes(name)) { targetCity = d.city; break; }
    }
    addDayToCity(targetCity);
    // hint de excursión si menciona un destino (ej. Segovia)
    const excursionMatch = text.match(/a\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+)*)/);
    const excursion = excursionMatch ? excursionMatch[1] : '';
    if(excursion){
      upsertCityMeta({city:targetCity, interests: [...(cityMeta[targetCity]?.interests||[]), `Excursión a ${excursion}`]});
    }
    showWOW(true);
    await generateCityItinerary(targetCity);
    showWOW(false);
    return;
  }

  // Eliminar día → pedir confirmación si no especifica número
  if(intent.type==='removeDay'){
    requestDeleteDay(currentCity);
    return;
  }

  // Construir prompt para edición (cambios puntuales/mover)
  const hardDirectives = [
    'Optimiza el/los día(s) implicado(s) sin duplicar; conserva lo útil salvo instrucción contraria.',
    'Máximo 20 filas por día; notas breves y humanas (ej. ✨ ☕ 🏰).'
  ];
  if(range.start) hardDirectives.push(`Para el Día ${day}, establece START=${range.start} (conserva END actual si no se indicó).`);
  if(range.end)   hardDirectives.push(`Para el Día ${day}, establece END=${range.end} (conserva START actual si no se indicó).`);
  if(moveInstr)   hardDirectives.push(`Mueve las actividades solicitadas del Día ${moveInstr.from} al Día ${moveInstr.to} y re-optimiza ambos.`);

  const transport = cityMeta[currentCity]?.transport || 'recomiéndame';
  const interests = cityMeta[currentCity]?.interests || [];

  const prompt = `
${FORMAT}
**Edición solicitada para "${currentCity}"**
- Día visible del usuario: ${day}
- Actividades del día actual: ${dayRows}
- Resumen de otros días (referencia): ${allDays}

**Directivas:**
${hardDirectives.map(x=>`- ${x}`).join('\n')}

**Ventanas por día (con posibles overrides):** ${JSON.stringify(cityPerDay)}
**Hotel/Zona:** ${cityMeta[currentCity]?.hotel || 'pendiente'}
**Transporte:** ${transport}
**Intereses:** ${JSON.stringify(interests)}

**Salida requerida:**
- Devuelve formato B {"destination":"${currentCity}","rows":[...],"replace": true} con filas finales SOLO del/los día(s) afectado(s).
- Si hay movimiento entre días, incluye ambos días re-optimizados.
**Solicitud del usuario (texto crudo):** ${text}
`.trim();

  showWOW(true);
  const ans = await callAgent(prompt, true);
  const parsed = parseJSON(ans);

  if(parsed?.followup) session.push({role: 'assistant', content: parsed.followup});

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    applyParsedToState(parsed);
    ensureFullCoverage(currentCity);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    chatMsg(parsed.followup || 'Listo. Afiné tu día para que rinda mejor — ¡se va a sentir genial! ✨','ai');
  }else{
    chatMsg(parsed?.followup || 'No recibí cambios válidos del asistente. ¿Puedes indicarme con más detalle qué ajustamos?','ai');
  }
  showWOW(false);
}

/* ================================
    SECCIÓN 18 · Upsell/Lock + Eventos / INIT
=================================== */
function lockItinerary(){
  isItineraryLocked = true;
  if($upsell) $upsell.style.display='flex';
}
function guardFeature(fn){
  return (...args)=>{
    if(isItineraryLocked){ if($upsell) $upsell.style.display='flex'; return; }
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

// Eventos base (manteniendo compatibilidad)
$addCity?.addEventListener('click', ()=>addCityRow());
$reset?.addEventListener('click', ()=>{  // si existe
  $cityList.innerHTML=''; savedDestinations=[]; itineraries={}; cityMeta={};
  addCityRow();
  if($start) $start.disabled = true;
  $tabs.innerHTML=''; $itWrap.innerHTML='';
  if($chatBox){ $chatBox.style.display='none'; $chatM.innerHTML=''; }
  session = [];
  hasSavedOnce = false; changedCities.clear(); globalChanged=false;
  hideRecalcFab();
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

// CTA premium
$confirmCTA?.addEventListener('click', lockItinerary);
$upsellClose?.addEventListener('click', ()=> { if($upsell) $upsell.style.display='none'; });

// Toolbar (se mantiene)
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

// Cambios globales → mostrar FAB si existe
['#budget','#currency','#special-conditions','#p-adults','#p-young','#p-children','#p-infants','#p-seniors']
  .forEach(sel=>{
    qs(sel)?.addEventListener('input', ()=>{
      if(!hasSavedOnce) return;
      globalChanged = true;
      showRecalcFab();
    });
  });

function showRecalcFab(){ if($recalcFab) $recalcFab.style.display='inline-flex'; }
function hideRecalcFab(){ if($recalcFab) $recalcFab.style.display='none'; }

// Inicial
addCityRow();
