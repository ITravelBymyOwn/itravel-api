/* =========================================================
    ITRAVELBYMYOWN · PLANNER v27 (COMPATIBLE & ROBUSTO)
    Base: v26
    Cambios v27:
    - Normalización de filas del agente (startTime/endTime/title/origin/destination/transportMode/durationMinutes)
    - Compatibilidad con múltiples envoltorios: destinations[], destination+rows, itineraries[], rowsByDay
    - Mantengo TODAS las demás secciones y comportamiento igual que v26
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
let isItineraryLocked = false;

/* ================================
    SECCIÓN 2 · Tono / Mensajería
=================================== */
const tone = {
  es: {
    hi: '¡Bienvenido! 👋 Soy tu concierge de viajes personal. Te guiaré ciudad por ciudad.',
    askHotel: (city)=>`¿En qué hotel/zona te vas a hospedar en <strong>${city}</strong>?`,
    smallNote: 'Si aún no lo tienes, escribe <em>pendiente</em>. Acepto nombre exacto, dirección, coordenadas o enlace de Google Maps.',
    confirmAll: '✨ Perfecto. Ya tengo lo necesario. Generando itinerarios…',
    doneAll: '🎉 Todos los itinerarios fueron generados. ¿Quieres revisarlos o ajustar alguno?',
    fail: '⚠️ No se pudo contactar con el asistente. Revisa la consola y la configuración de Vercel (API Key, URL).'
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

const $upsell     = qs('#monetization-upsell');
const $upsellClose = qs('#upsell-close');
const $confirmCTA  = qs('#confirm-itinerary');

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
      const start = qs('.start',hd).value || '08:30';
      const end   = qs('.end',hd).value    || '19:00';
      perDay.push({ day: idx+1, start, end });
    });
    list.push({ city, country, days, baseDate, perDay });
  });

  savedDestinations = list;
  savedDestinations.forEach(({city,days,baseDate,perDay})=>{
    if(!itineraries[city]) itineraries[city] = { byDay:{}, currentDay:1, baseDate: baseDate||null };
    if(!cityMeta[city]) cityMeta[city] = { baseDate: baseDate||null, start:null, end:null, hotel:'', perDay: perDay||[] };
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
            <th>Inicio</th><th>Fin</th><th>Actividad</th><th>Desde</th>
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

  const list = savedDestinations.map(x=>{
    const dates = x.baseDate ? `, start=${x.baseDate}` : '';
    return `${x.city} (${x.country||'—'} · ${x.days} días${dates})`;
  }).join(' | ');

  savedDestinations.forEach(dest=>{
    if(!cityMeta[dest.city] || !cityMeta[dest.city].perDay || !cityMeta[dest.city].perDay.length){
      cityMeta[dest.city] = cityMeta[dest.city] || {};
      cityMeta[dest.city].perDay = Array.from({length:dest.days}, (_,i)=>({day:i+1,start:'08:30',end:'19:00'}));
    }else{
      cityMeta[dest.city].perDay = cityMeta[dest.city].perDay.map(pd=>({
        day: pd.day,
        start: pd.start || '08:30',
        end:   pd.end   || '19:00'
      }));
    }
  });

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
B) {"destination":"City","rows":[{...}],"followup":"Pregunta breve"}
C) {"rows":[{...}],"followup":"Pregunta breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"},"followup":"Pregunta breve"}
Reglas:
- Incluye traslados con transporte y duración (+15% colchón).
- Usa horas por día si están disponibles; si faltan, asume 08:30–19:00.
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
    SECCIÓN 13 · Apply / Merge (MEJORADA v27)
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

// Normaliza una fila cualquiera del agente a nuestro contrato
function normalizeRow(r = {}, fallbackDay = 1){
  const start   = r.start ?? r.start_time ?? r.startTime ?? r.hora_inicio ?? '';
  const end     = r.end   ?? r.end_time   ?? r.endTime   ?? r.hora_fin    ?? '';
  const act     = r.activity ?? r.title ?? r.name ?? r.descripcion ?? r.descripcion_actividad ?? '';
  const from    = r.from ?? r.origin ?? r.origen ?? '';
  const to      = r.to   ?? r.destination ?? r.destino ?? '';
  const trans   = r.transport ?? r.transportMode ?? r.modo_transporte ?? '';
  const durRaw  = r.duration ?? r.durationMinutes ?? r.duracion ?? '';
  const notes   = r.notes ?? r.nota ?? r.comentarios ?? '';

  // durationMinutes -> "XXm"
  const duration = (typeof durRaw === 'number') ? `${durRaw}m` : (String(durRaw)||'');

  const d = Math.max(1, parseInt(r.day ?? r.dia ?? fallbackDay, 10) || 1);

  return {
    day: d,
    start: start || '',
    end: end || '',
    activity: act || '',
    from: from || '',
    to: to || '',
    transport: trans || '',
    duration: duration || '',
    notes: notes || ''
  };
}

function pushRows(city, rows, replace=false){
  if(!city || !rows) return;
  if(!itineraries[city]) itineraries[city] = {byDay:{},currentDay:1,baseDate:cityMeta[city]?.baseDate||null};
  if(replace) itineraries[city].byDay = {};
  rows.forEach((raw, idx)=>{
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
  if(!cityMeta[name]) cityMeta[name] = { baseDate:null, start:null, end:null, hotel:'', perDay:[] };
  if(meta.baseDate) cityMeta[name].baseDate = meta.baseDate;
  if(meta.start)    cityMeta[name].start    = meta.start;
  if(meta.end)      cityMeta[name].end      = meta.end;
  if(typeof meta.hotel==='string') cityMeta[name].hotel = meta.hotel;
  if(itineraries[name] && meta.baseDate) itineraries[name].baseDate = meta.baseDate;
}

function applyParsedToState(parsed){
  if(!parsed) return;

  // Acepta envoltorios alternativos
  if(parsed.itinerary) parsed = parsed.itinerary;
  if(parsed.destinos)  parsed.destinations = parsed.destinos;
  if(parsed.destino && parsed.rows) parsed.destination = parsed.destino;

  if(parsed.meta) upsertCityMeta(parsed.meta);

  // 1) destinations: [{ name|destination, rows|rowsByDay }]
  if(Array.isArray(parsed.destinations)){
    parsed.destinations.forEach(d=>{
      const name = d.name || d.destination || d.meta?.city || activeCity || savedDestinations[0]?.city;
      if(!name) return;

      // rowsByDay { "1":[...], "2":[...] }
      if(d.rowsByDay && typeof d.rowsByDay === 'object'){
        Object.entries(d.rowsByDay).forEach(([k,rows])=>{
          const mapped = (rows||[]).map(r=>normalizeRow({...r, day:+k}, +k));
          pushRows(name, mapped, false);
        });
        return;
      }

      // rows []
      if(Array.isArray(d.rows)){
        const mapped = d.rows.map((r,i)=>normalizeRow(r, 1));
        pushRows(name, mapped, Boolean(d.replace));
      }
    });
    return;
  }

  // 2) destination + rows
  if(parsed.destination && Array.isArray(parsed.rows)){
    const name = parsed.destination;
    const mapped = parsed.rows.map((r,i)=>normalizeRow(r, 1));
    pushRows(name, mapped, Boolean(parsed.replace));
    return;
  }

  // 3) itineraries: [{ city|name|destination, rows|rowsByDay }]
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

  // 4) rows solo -> sobre ciudad activa
  if(Array.isArray(parsed.rows)){
    const city = activeCity || savedDestinations[0]?.city;
    const mapped = parsed.rows.map(r=>normalizeRow(r, 1));
    pushRows(city, mapped, Boolean(parsed.replace));
  }
}

/* ================================
    SECCIÓN 14 · Fallback local inteligente
=================================== */
const LANDMARKS = {
  Barcelona: [
    'Sagrada Familia','Barrio Gótico','Casa Batlló','La Pedrera','Parc Güell',
    'La Rambla y Boquería','Montjuïc','Playa Barceloneta','Catedral de Barcelona',
    'Camp Nou / Barça Immersive','Parc de la Ciutadella','Tibidabo / mirador'
  ],
  Madrid: [
    'Museo del Prado','Parque del Retiro','Palacio Real','Plaza Mayor y San Miguel',
    'Gran Vía','Templo de Debod','Barrio de Las Letras','Museo Reina Sofía',
    'Puerta del Sol','Chueca / Malasaña','Estadio Bernabéu (exterior)','Matadero Madrid / Madrid Río'
  ],
  Paris: [
    'Torre Eiffel','Louvre','Notre-Dame (exterior)','Sainte-Chapelle','Barrio Latino & Sorbona',
    'Le Marais','Montmartre & Sacré-Cœur','Museo d’Orsay','Campos Elíseos & Arco del Triunfo',
    'Ópera Garnier','Jardines de Luxemburgo','Río Sena (orillas)'
  ],
  _generic: [
    'Casco histórico','Catedral/Basílica','Museo principal','Mercado central',
    'Mirador/colina','Parque urbano','Paseo por barrio emblemático','Plaza principal',
    'Museo alternativo','Café/pastelería típica','Cena recomendada'
  ]
};
function getLandmarksFor(city){
  return LANDMARKS[city] || LANDMARKS._generic;
}
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
  let cur = start||'08:30';
  const rows=[];
  blocks.forEach((b,i)=>{
    const s = cur;
    let e = addMinutes(cur, b.dur);
    if(e>end) e=end;
    const transport = (b.type==='metro'?'Metro/Bus':'A pie');
    rows.push({
      day:1, start:s, end:e, activity:b.label,
      from: i===0?'Hotel/Zona':'', to:'', transport,
      duration: (b.dur+'m'), notes:'Itinerario base (auto-generado). Ajustable.'
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
    const pd = perDay.find(x=>x.day===d) || {start:'08:30', end:'19:00'};
    const s = pd.start || '08:30';
    const e = pd.end   || '19:00';
    const picks=[];
    for(let i=0;i<4;i++){
      const item = pool[(d*3+i) % pool.length];
      picks.push(item);
    }
    const dayRows = synthesizeDayRows(s,e,picks).map(r=>({...r, day:d}));
    rowsByDay[d]=dayRows;
  }
  return rowsByDay;
}

/* ================================
    SECCIÓN 15 · Generación por ciudad
=================================== */
async function generateCityItinerary(city){
  const dest  = savedDestinations.find(x=>x.city===city);
  if(!dest) return;

  const perDay = (cityMeta[city]?.perDay && cityMeta[city].perDay.length)
    ? cityMeta[city].perDay
    : Array.from({length:dest.days}, (_,i)=>({day:i+1,start:'08:30',end:'19:00'}));

  const baseDate = cityMeta[city]?.baseDate || dest.baseDate || '';
  const hotel    = cityMeta[city]?.hotel || '';

  const instructions = `
${FORMAT}
**INSTRUCCIÓN CRÍTICA: Eres el planificador de ITravelByMyOwn.**
**Genera el itinerario completo SOLO para "${city}" para ${dest.days} día(s).**
- Usa el formato B con "destination":"${city}" y el array "rows".
- Incluye actividades turísticas realistas, con horarios, transporte y duración para cada día.

Datos de Viaje:
- Ciudad: "${city}"
- Días totales: ${dest.days}
- Horas por día (start/end): ${JSON.stringify(perDay)}
- BaseDate (día 1): ${baseDate||'N/A'}
- Hotel/Zona de base: ${hotel||'pendiente'}

Contexto Completo del Viaje (solo referencia):
${buildIntake()}
`.trim();

  let text = await callAgent(instructions, false); // sin historial
  let parsed = parseJSON(text);

  if(!parsed || (!parsed.rows && !parsed.destinations && !parsed.itineraries)){
    const strict = `
${FORMAT}
**REINTENTO:** Genera **SOLO** el itinerario para "${city}" (${dest.days} días) en formato B o en destinations[].
Ignora 'meta'. El JSON debe contener un array "rows" utilizable.
`.trim();
    text = await callAgent(strict, false);
    parsed = parseJSON(text);
  }

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    applyParsedToState(parsed);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    return;
  }

  // Fallback local
  const rowsByDay = synthesizeLocalItinerary(city, dest.days, perDay);
  const rowsFlat = Object.entries(rowsByDay).flatMap(([d,rows])=>rows.map(r=>({...r, day:+d})));
  pushRows(city, rowsFlat, true);
  renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
  chatMsg('⚠️ Fallo crítico del asistente. Generé una propuesta base por día para que puedas seguir trabajando manualmente. Revisa tu configuración de Vercel.', 'ai');
}

/* ================================
    SECCIÓN 16 · Flujo principal · HOTELS
=================================== */
async function startPlanning(){
  if(savedDestinations.length===0) return;
  $chatBox.style.display='flex';
  planningStarted = true;
  collectingHotels = true;
  metaProgressIndex = 0;

  session = []; // solo se usa para edición
  chatMsg(`${tone.hi}`);
  askNextHotel();
}
function askNextHotel(){
  if(metaProgressIndex >= savedDestinations.length){
    collectingHotels = false;
    chatMsg(tone.confirmAll);
    (async ()=>{
      for(const {city} of savedDestinations){
        await generateCityItinerary(city);
      }
      chatMsg(tone.doneAll);
    })();
    return;
  }
  const city = savedDestinations[metaProgressIndex].city;
  setActiveCity(city); renderCityItinerary(city);

  const msg = `${tone.askHotel(city)}<br><small style="display:block;color:#667085;margin-top:.25rem">${tone.smallNote}</small>`;
  chatMsg(msg,'ai');
}

/* ================================
    SECCIÓN 17 · Chat handler
=================================== */
async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  if(collectingHotels){
    const city = savedDestinations[metaProgressIndex].city;
    upsertCityMeta({ city, hotel: text });
    chatMsg(`Perfecto. Hotel/Zona registrado para ${city}.`, 'ai');
    metaProgressIndex++;
    askNextHotel();
    return;
  }

  const currentCity = activeCity || savedDestinations[0]?.city;
  const data = itineraries[currentCity];

  if(!currentCity || !data){
    chatMsg('Aún no hay itinerario en pantalla. Por favor, inicia la planificación primero.');
    return;
  }

  session.push({role: 'user', content: text});

  const day = data.currentDay || 1;
  const dayRows = (data.byDay[day]||[]).map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)';
  const allDays = Object.keys(data.byDay).map(n=>{
    const rows = data.byDay[n]||[];
    return `Día ${n}:\n${rows.map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)'}`;
  }).join('\n\n');

  const prompt = `
${FORMAT}
**Contexto Completo del Viaje (Importante):**
${buildIntake()}

**Instrucciones de Edición para el Agente:**
- El usuario está viendo "${currentCity}", Día ${day}.
- Actividades del día actual: ${dayRows}
- Resumen de otros días (no repitas): ${allDays}
- Interpreta la solicitud final del usuario y actualiza solo el día ${day}.
- Máximo 20 filas.
- Devuelve JSON formato B ("destination":"${currentCity}").
**Solicitud del usuario:** ${text}
`.trim();

  const ans = await callAgent(prompt); // con historial
  const parsed = parseJSON(ans);

  if(parsed?.followup) session.push({role: 'assistant', content: parsed.followup});

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    applyParsedToState(parsed);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    chatMsg(parsed.followup || 'Listo. Ajusté el día visible.', 'ai');
  }else{
    chatMsg(parsed?.followup || 'No recibí cambios válidos del asistente. Por favor, intenta de nuevo o sé más específico.','ai');
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

$addCity.addEventListener('click', ()=>addCityRow());
$reset.addEventListener('click', ()=>{
  $cityList.innerHTML=''; savedDestinations=[]; itineraries={}; cityMeta={};
  addCityRow();
  $start.disabled = true;
  $tabs.innerHTML=''; $itWrap.innerHTML='';
  $chatBox.style.display='none'; $chatM.innerHTML='';
  session = [];
});
$save.addEventListener('click', saveDestinations);
$start.addEventListener('click', startPlanning);
$send.addEventListener('click', onSend);
$chatI.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); onSend(); } });

$confirmCTA.addEventListener('click', lockItinerary);
$upsellClose.addEventListener('click', ()=> $upsell.style.display='none');

// Toolbar (igual que v26)
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
