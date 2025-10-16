/* =========================================================
    ITRAVELBYMYOWN · PLANNER v40
    Base: v36 + restauración v33 + mejoras globales
    BLOQUE 1/3: Estado, helpers, UI base, tabs, render
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
let session = [];
let activeCity = null;
let planningStarted = false;
let metaProgressIndex = 0;
let collectingHotels = false;
let collectingInterests = false;
let isItineraryLocked = false;
let pendingChange = null;
let hasSavedOnce = false;

const DEFAULT_START = '08:30';
const DEFAULT_END   = '19:00';

/* ================================
    SECCIÓN 2 · Tono / Mensajería
=================================== */
const tone = {
  es: {
    hi: '¡Hola! Soy Astra ✨ Tu copiloto de viajes. Vamos a construir tu aventura, ciudad por ciudad 🌍',
    askHotelTransport: (city)=>`Para <strong>${city}</strong>, cuéntame <strong>hotel/zona</strong> y el <strong>medio de transporte</strong> que usarás (alquiler, público, taxi/uber, combinado o “recomiéndame”). Puedes responder en una sola frase.`,
    askInterestsIntro: (city, picks)=>`En <strong>${city}</strong> normalmente brillan estas ideas: ${picks.map(x=>`<em>${x}</em>`).join(' · ')}. ¿Alguna te emociona para incluirla? Puedes decir “sí: …”, “no por ahora” o “recomiéndame”.`,
    confirmAll: '✨ Genial. Ya tengo lo necesario. Comienzo a generar tus itinerarios…',
    doneAll: '🎉 ¡Listo! Itinerarios generados. ¿Quieres ajustarlos o añadir algo especial?',
    fail: '⚠️ No se pudo contactar con el asistente. Revisa consola/Vercel (API Key, URL).',
    askConfirm: (summary)=>`¿Confirmas? ${summary}<br><small>Responde “sí” para aplicar o “no” para cancelar.</small>`,
    humanOk: 'Perfecto 🙌 Ajusté tu itinerario para que aproveches mejor el tiempo. ¡Va a quedar genial! ✨',
    humanCancelled: 'Anotado, no apliqué cambios. ¿Probamos otra idea? 🙂'
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
- Optimiza el/los día(s) afectado(s) (min traslados, agrupa por zonas, respeta ventanas).
- Usa horas por día si están disponibles; si faltan, 08:30–19:00.
- No dupliques; conserva lo existente salvo instrucción explícita.
- Máximo 20 filas por día.
- Nada de texto fuera del JSON.
`;

/* ================================
    SECCIÓN 12 · Llamada al agente
=================================== */
async function callAgent(text, useHistory = true){
  const history = useHistory ? session : [];
  const globalStyle = `
Eres "Astra", agente de viajes con 40 años de experiencia.
Responde con calidez, variedad y emoción. Usa tu conocimiento turístico global.
Evita repeticiones. Si la consulta es informativa (clima, cultura, transporte), responde normalmente
y luego sugiere si quieres ajustar el itinerario con lo aprendido.
Evita bloquear la UI en consultas informativas; bloquea solo cuando apliques cambios.
Si el destino lo amerita (p.ej. zonas árticas), prefiere tours guiados para actividades fuera del
centro urbano; solo sugiere coche de alquiler cuando sea realmente óptimo y seguro.
`.trim();

  const payload = { model: MODEL, input: `${globalStyle}\n\n${text}`, history };
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
    SECCIÓN 13 · Apply / Merge + utilidades de edición
    (restaura v33: replace solo afecta días presentes; no duplica)
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
/* v33/v36: replace ahora sustituye SOLO días presentes en rows (no borra otros).
   Además: limita a 20 filas por día y deduplica por (day,start,end,activity). */
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
      if(Array.isArray(d.rows)){
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
      const name = x.city || x.name || x.destination || activeCity || savedDestinations[0]?.city;
      if(!name) return;

      if(x.rowsByDay && typeof x.rowsByDay==='object'){
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
/* Asegura que cada día tenga al menos una fila “base” para no dejar el UI vacío al reindexar. */
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
        notes:'✨ Punto base para organizar el día. Luego afinamos.'
      }], false);
    }
  }
}

/* ==== v40 · Manipulación estable de días/actividades ==== */
function insertDayAt(city, position){
  ensureDays(city);
  const byDay = itineraries[city].byDay || {};
  const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  const maxD = days.length ? Math.max(...days) : 0;
  const pos = Math.min(Math.max(1, position), maxD+1);
  // Desplazar días hacia abajo desde el final
  for(let d = maxD; d >= pos; d--){
    byDay[d+1] = (byDay[d]||[]).map(r=>({...r, day:d+1}));
  }
  // Crear día vacío
  byDay[pos] = [];
  itineraries[city].byDay = byDay;
  // Actualizar contador en savedDestinations
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
  byDay[a] = A.length ? B.map(r=>({...r, day:a})) : [];
  byDay[b] = B.length ? A.map(r=>({...r, day:b})) : [];
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

/* ==== Optimización con IA a nivel de día ==== */
async function optimizeDay(city, day){
  const rows = (itineraries[city]?.byDay?.[day]||[]).map(r=>({
    day, start:r.start||DEFAULT_START, end:r.end||DEFAULT_END, activity:r.activity||'',
    from:r.from||'', to:r.to||'', transport:r.transport||'',
    duration:r.duration||'', notes:r.notes||''
  }));
  const perDay = (cityMeta[city]?.perDay||[]).find(x=>x.day===day) || {start:DEFAULT_START,end:DEFAULT_END};
  const baseDate = itineraries[city].baseDate || cityMeta[city]?.baseDate || '';

  const prompt = `
${FORMAT}
Ciudad: ${city}
Día: ${day}
Fecha base (d1): ${baseDate||'N/A'}
Ventanas definidas: ${JSON.stringify(perDay)} (vacías = sugiere horas lógicas, incluyendo nocturnas si corresponde)
Filas actuales:
${JSON.stringify(rows)}
Instrucción:
- Reordena y optimiza el día (min traslados; agrupa por zonas).
- Rellena huecos con actividades relevantes (imperdibles/experiencias cercanas) sin duplicar otros días.
- Considera temporada/horas de luz/actividades nocturnas (auroras si aplica → prefiere tour/bus, no coche).
- Devuelve C {"rows":[...],"replace":true}.
Contexto:
${getFrontendSnapshot()}
`.trim();

  const ans = await callAgent(prompt, true);
  const parsed = parseJSON(ans);
  if(parsed?.rows){
    pushRows(city, parsed.rows.map(x=>({...x, day})), true);
  }
}
async function optimizeTwoDays(city, a, b){
  await optimizeDay(city, a);
  if(a!==b) await optimizeDay(city, b);
}

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
  // Heurística de transporte: preferir tren/bus; tours si aplica (poblaciones turísticas).
  const isToury = /segovia|toledo|ávila|avila|versalles|montserrat|girona|sitges|giverny|fontainebleau|pompeya|pompei/i.test(place);
  const goMode = isToury ? 'Tren/Bus (tour sugerido)' : 'Tren/Bus';
  return [
    {day, start, end: addMinutes(start,75), activity:`Traslado a ${place}`, from: cityFrom, to: place, transport:goMode, duration:'75m', notes:'Salida temprana, tickets anticipados recomendados'},
    {day, start: addMinutes(start,85), end: addMinutes(start,205), activity:`Paseo histórico por ${place}`, from: place, to: '', transport:'A pie', duration:'120m', notes:'Casco antiguo / puntos clave'},
    {day, start: addMinutes(start,215), end: addMinutes(start,300), activity:`Almuerzo en ${place}`, from: place, to: '', transport:'A pie', duration:'85m', notes:'Cocina local'},
    {day, start: addMinutes(start,310), end: addMinutes(start,430), activity:`Recorrido complementario en ${place}`, from: place, to: '', transport:'A pie/Bus', duration:'120m', notes:''},
    {day, start: addMinutes(start,440), end, activity:`Regreso a ${cityFrom}`, from: place, to: cityFrom, transport:goMode, duration:'', notes:'Llegada estimada al atardecer'}
  ];
}

/* ================================
    SECCIÓN 15 · Generación por ciudad (imperdibles sin duplicar)
=================================== */
const LANDMARKS = {
  _generic: [
    'Casco histórico','Catedral/Basílica','Museo principal','Mercado central',
    'Mirador/colina','Parque urbano','Barrio emblemático','Plaza principal',
    'Museo alternativo','Café/pastelería típica','Cena recomendada'
  ]
};
function getLandmarksFor(city){ return LANDMARKS._generic; }
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
      duration: (b.dur+'m'),
      notes:'Itinerario base (auto-generado). Ajustable.'
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
**ROL:** Eres el planificador “Astra” (40 años de experiencia).
**TAREA:** Genera el itinerario completo SOLO para "${city}" para ${dest.days} día(s), optimizando tiempos/recursos.
- Usa el formato B {"destination":"${city}","rows":[...],"replace": true}.
- No dupliques actividades ya existentes en otros días; si hay nuevas, colócalas en días libres o reoptimiza con criterio.
- Respeta ventanas por día (si faltan, 08:30–19:00; permite nocturnas si aplica).
- Preferir tours/guías para actividades fuera del centro (p.ej. auroras en Tromsø).
- Incluye notas humanas y motivadoras (breves).

Datos:
- Ciudad: "${city}"
- Días: ${dest.days}
- Horas/día: ${JSON.stringify(perDay)}
- BaseDate (día 1): ${baseDate||'N/A'}
- Hotel/Zona: ${hotel||'pendiente'}
- Transporte: ${transport}
- Intereses: ${JSON.stringify(interests)}

Contexto actual (no repitas lo ya planificado):
${getFrontendSnapshot()}
`.trim();

  let text = await callAgent(instructions, false);
  let parsed = parseJSON(text);

  const coversAllDays = (p)=>{
    try{
      const tmp = {};
      const mark = (rows)=>rows.forEach(r=>{ tmp[r.day]=true; });
      if(p?.rows){ mark(p.rows); }
      else if(Array.isArray(p?.destinations)){
        const dd = p.destinations.find(d=> (d.name||d.destination)===city);
        if(dd?.rows) mark(dd.rows);
      }else if(Array.isArray(p?.itineraries)){
        const ii = p.itineraries.find(x=> (x.city||x.name||x.destination)===city);
        if(ii?.rows) mark(ii.rows);
      }
      const want = savedDestinations.find(x=>x.city===city)?.days || 0;
      for(let d=1; d<=want; d++){ if(!tmp[d]) return false; }
      return true;
    }catch(_){ return false; }
  };

  if(!parsed || (!parsed.rows && !parsed.destinations && !parsed.itineraries) || !coversAllDays(parsed)){
    const strict = `
${FORMAT}
**REINTENTO ESTRICTO:** Devuelve solo para "${city}" (${dest.days} días) en formato B con "replace": true, cubriendo TODOS los días sin duplicar lo existente.
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
  chatMsg('⚠️ Fallback local: revisa configuración de Vercel o API Key.', 'ai');
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

  session = []; // historial para edición
  chatMsg(`${tone.hi}`);
  askNextHotelTransport();
}
function askNextHotelTransport(){
  if(metaProgressIndex >= savedDestinations.length){
    // Paso a intereses
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
function suggestedActivitiesFor(city, days){
  const name = (city||'').toLowerCase();
  const picks = [];
  // Ártico / auroras
  if(['tromso','tromsø','rovaniemi','reykjavik','reikiavik','abisko','kiruna','fairbanks','yellowknife'].some(n=>name===n)){
    picks.push('Caza de auroras (21:00–23:30)');
  }
  // Islandia termal + círculo dorado
  if(['reykjavik','reikiavik','grindavik','hveragerdi','flúðir','fludir','selfoss'].some(n=>name===n)){
    picks.push('Aguas termales (Blue/Sky/Secret Lagoon)');
    picks.push('Círculo Dorado');
  }
  // Day-trips típicos
  const DAYTRIP_SUGGEST = {
    'Madrid': ['Segovia (Alcázar, acueducto)','Toledo (casco histórico)','Ávila (murallas)','El Escorial'],
    'Paris': ['Versalles','Giverny','Fontainebleau'],
    'Barcelona': ['Montserrat','Girona','Sitges'],
    'Reykjavik': ['Círculo Dorado','Costa Sur (Vík)','Blue Lagoon','Avistamiento de ballenas'],
    'Tromso': ['Caza de auroras','Fiordos en barco','Avistamiento de ballenas (en temporada)'],
    'Luxor': ['Valle de los Reyes','Templo de Karnak','Globo aerostático al amanecer']
  };
  if(DAYTRIP_SUGGEST[city]) picks.push(...DAYTRIP_SUGGEST[city].slice(0,5));
  if(!picks.length) picks.push('Imperdibles locales y experiencias gastronómicas');
  return [...new Set(picks)].slice(0,5);
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
    SECCIÓN 17 · Chat handler / NLU + Confirmación (global)
=================================== */
// Números en palabras básicas
const WORD_NUM = {
  'cero':0,'una':1,'uno':1,'un':1,'dos':2,'tres':3,'cuatro':4,'cinco':5,'seis':6,'siete':7,'ocho':8,'nueve':9,'diez':10
};
// 7 y media / y cuarto / y tres cuartos
function normalizeHourToken(tok){
  tok = tok.toLowerCase().trim();
  const yM = tok.match(/^(\d{1,2}|\w+)\s+y\s+(media|cuarto|tres\s+cuartos)$/i);
  if(yM){
    let h = yM[1];
    let hh = WORD_NUM[h] ?? parseInt(h,10);
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
  if(Number.isInteger(w)) return String(w).padStart(2,'0')+':00';
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
  const t = text.toLowerCase();
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
  const t = text.toLowerCase();
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
function intentFromText(text, city){
  const t = text.toLowerCase();

  // Confirmación/cancelación
  if(/^(sí|si|ok|vale|dale|hazlo|confirmo|de una)\b/.test(t)) return {type:'confirm'};
  if(/^(no|mejor no|cancela|cancelar|cancelá|cancelemos)\b/.test(t)) return {type:'cancel'};

  // Añadir día (posible mención de day-trip)
  if(/(agrega|añade|sum[aá])\s+un?\s+d[ií]a/.test(t) || /\bun d[ií]a m[aá]s\b/.test(t)){
    let pos = null;
    if(/\binicio\b/.test(t)) pos = 'start';
    else if(/\bfinal\b/.test(t)) pos = 'end';
    else {
      const p = parseOrdinalDay(t);
      if(p) pos = p;
    }
    const placeMatch = t.match(/para\s+ir\s+a\s+([a-záéíóúüñ\s]+)$/i) || t.match(/a\s+([a-záéíóúüñ\s]+)\s*(?:en\s+tren|en\s+bus|en\s+tour)?$/i);
    const place = placeMatch ? placeMatch[1].trim() : null;
    const night = /\baurora|auroras|noche|nocturn[oa]\b/.test(t);
    return {type:'add_day', position:pos, place, night};
  }

  // Quitar día (o pedir número)
  if(/(quita|elimina|borra)\s+(un\s+)?d[ií]a/.test(t) || /(quita|elimina|borra)\s+el\s+d[ií]a/.test(t)){
    const d = parseOrdinalDay(t);
    return d ? {type:'remove_day', day:d} : {type:'ask_remove_day_direct'};
  }

  // Swap de días
  const swap = t.match(/(?:pasa|mueve|cambia)\s+el\s+d[ií]a\s+(\d+)\s+(?:al|a)\s+(?:d[ií]a\s+)?(\d+)/i);
  if(swap && !/actividad|museo|visita|tour|cena|almuerzo|desayuno/i.test(t)){
    return {type:'swap_day', from: parseInt(swap[1],10), to: parseInt(swap[2],10)};
  }

  // Quitar actividad (por nombre)
  if(/\b(no\s+quiero|quita|elimina|borra)\b.+/.test(t)){
    const query = t.replace(/^(no\s+quiero|quita|elimina|borra)\s*/i,'').trim();
    if(query) return {type:'remove_activity', query};
  }

  // Mover actividad día X→Y (con texto de actividad)
  const mv = t.match(/(?:mueve|pasa|cambia)\s+(.*?)(?:\s+del\s+d[ií]a\s+(\d+)|\s+del\s+(\d+))\s+(?:al|a)\s+(?:d[ií]a\s+)?(\d+)/i);
  if(mv){
    const query = (mv[1]||'').trim();
    const from = parseInt(mv[2] || mv[3],10);
    const to   = parseInt(mv[4],10);
    if(query) return {type:'move_activity', query, fromDay:from, toDay:to};
  }

  // Cambiar horas
  const range = parseTimeRangeFromText(text);
  if(range.start || range.end){ return {type:'change_hours', range}; }

  // Agregar ciudad
  if(/(agrega|añade)\s+(una\s+)?ciudad\b|\bagrega\s+[a-záéíóúüñ\s]+(\s+\d+\s+d[ií]as)?$/i.test(t) || /agrega\s+[a-záéíóúüñ]+(\s+\d+\s+d[ií]as)?/i.test(t)){
    const m = t.match(/agrega\s+([a-záéíóúüñ\s]+?)(?:\s+(\d+)\s+d[ií]as?)?$/i);
    if(m){ return {type:'add_city', name: m[1].trim(), days: m[2]?parseInt(m[2],10):null}; }
  }

  // Quitar ciudad
  if(/(quita|elimina|borra)\s+[a-záéíóúüñ\s]+$/i.test(t)){
    const m = t.match(/(quita|elimina|borra)\s+([a-záéíóúüñ\s]+)$/i);
    if(m){ return {type:'remove_city', name: m[2].trim()}; }
  }

  // Info query (modo ChatGPT)
  if(/clima|tiempo|temperatura|lluvia|horas de luz|alquiler de auto|aerol[ií]neas|vuelos|ropa|equipaje|visado|visa|mejor época|festivales|comida|restaurante|donde comer|vale la pena|qué ver|que ver|imprescindibles/.test(t)){
    return {type:'info_query', details:text};
  }

  return {type:'free_edit', details:text};
}

function buildEditPrompt(city, directive, opts={}){
  const data = itineraries[city];
  const day = data?.currentDay || 1;
  const dayRows = (data?.byDay?.[day]||[]).map(r=>`• ${r.start||''}-${r.end||''} ${r.activity}`).join('\n') || '(vacío)';
  const allDays = Object.keys(data?.byDay||{}).map(n=>{
    const rows = data.byDay[n]||[];
    return `Día ${n}:\n${rows.map(r=>`• ${r.start||''}-${r.end||''} ${r.activity}`).join('\n') || '(vacío)'}`;
  }).join('\n\n');

  const perDay = (cityMeta[city]?.perDay||[]).map(pd=>({day:pd.day, start:pd.start||DEFAULT_START, end:pd.end||DEFAULT_END}));
  const overrides = opts.overrides ? JSON.stringify(opts.overrides) : '{}';

  return `
${FORMAT}
**Contexto del viaje (estado actual):**
${getFrontendSnapshot()}

**Ciudad a editar:** ${city}
**Día visible:** ${day}
**Actividades del día actual:**
${dayRows}

**Resumen resto de días (referencia, no dupliques):**
${allDays}

**Ventanas por día:** ${JSON.stringify(perDay)}
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
  showWOW(true); // bloquear solo al aplicar cambios
  const ans = await callAgent(prompt, true);
  const parsed = parseJSON(ans);

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    applyParsedToState(parsed);
    ensureFullCoverage(city);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    chatMsg(tone.humanOk,'ai');
  }else{
    chatMsg(parsed?.followup || 'No recibí cambios válidos. ¿Me das un poco más de contexto?','ai');
  }
  showWOW(false);
}

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

  // Colecta intereses
  if(collectingInterests){
    const city = savedDestinations[metaProgressIndex].city;
    const picks = /no/i.test(text) && !/sí|si/i.test(text)
      ? [] : text.split(/[,\n;·•]/).map(s=>s.trim()).filter(Boolean);
    upsertCityMeta({city, interests: picks});
    metaProgressIndex++;
    askNextInterests();
    return;
  }

  // Edición / conversación ya con itinerario visible
  const currentCity = activeCity || savedDestinations[0]?.city;
  const data = itineraries[currentCity];
  if(!currentCity || !data){
    // Intentar detectar ciudad por fuzzy
    const guess = fuzzyBestCity(text);
    if(guess){
      chatMsg(`¿Querías trabajar en <strong>${guess}</strong>? Si quieres la agrego. Responde “sí” para confirmar o “no” para cancelar.`, 'ai');
      pendingChange = { type:'confirm_fuzzy_add', city: guess };
      return;
    }
    chatMsg('Aún no hay itinerario en pantalla. Por favor, inicia la planificación primero.');
    return;
  }

  // Confirm fuzzy add
  if(pendingChange?.type === 'confirm_fuzzy_add'){
    if(/^sí|si|ok|vale|dale|confirmo/i.test(text)){
      const city = pendingChange.city;
      pendingChange = null;
      addCityRow({city});
      saveDestinations();
      chatMsg(`✅ <strong>${city}</strong> agregada. Dime hotel/zona y transporte para generar el plan.`, 'ai');
      return;
    }
    if(/^no|cancela|cancelar/i.test(text)){
      pendingChange = null;
      chatMsg(tone.humanCancelled,'ai');
      return;
    }
  }

  const intent = intentFromText(text, currentCity);

  // Confirmación de cambios pendientes (genérico)
  if(intent.type==='confirm' && pendingChange && pendingChange.prompt){
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

  // 1) Agregar día (por defecto al final; respeta posición si la hay; day-trip si hay "para ir a X")
  if(intent.type==='add_day'){
    showWOW(true);
    const city = currentCity;
    ensureDays(city);
    const byDay = itineraries[city].byDay || {};
    const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
    const numericPos = (intent.position==='start') ? 1
      : (intent.position==='end' || !intent.position ? days.length+1 : Math.max(1, Math.min(+intent.position, days.length+1)));

    insertDayAt(city, numericPos);

    // Day-trip si menciona lugar
    if(intent.place){
      const end = (cityMeta[city]?.perDay?.find(x=>x.day===numericPos)?.end) || '19:00';
      const start = (cityMeta[city]?.perDay?.find(x=>x.day===numericPos)?.start) || '08:30';
      const rows = seedDayTripRows(city, intent.place, numericPos, start, end);
      pushRows(city, rows, true);
    }

    // Actividad nocturna si se pide (ej. auroras)
    if(intent.night){
      const endN = (cityMeta[city]?.perDay?.find(x=>x.day===numericPos)?.end) || '23:59';
      pushRows(city, [{day:numericPos,start:'21:00',end:endN,activity:'Caza de auroras (tour/nocturna)',from:'Hotel',to:'',transport:'Tour/Bus',duration:'150m',notes:'Horario estimado'}], false);
    }

    // Optimizar SOLO el día nuevo
    await optimizeDay(city, numericPos);
    ensureFullCoverage(city);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    chatMsg('✅ Día agregado y optimizado.','ai');
    showWOW(false);
    return;
  }

  // 2) Quitar día
  if(intent.type==='ask_remove_day_direct'){
    pendingChange = {type:'remove_day_wait'};
    chatMsg('¿Qué día deseas eliminar? (ej. “2”)','ai');
    return;
  }
  if(intent.type==='remove_day' || (intent.type==='confirm' && pendingChange?.type==='remove_day_wait')){
    const day = intent.day || parseOrdinalDay(text);
    if(!Number.isInteger(day) || day<=0){
      pendingChange = {type:'remove_day_wait'};
      chatMsg('Necesito un número de día válido.','ai'); return;
    }
    showWOW(true);
    removeDayAt(currentCity, day);
    ensureFullCoverage(currentCity);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    chatMsg('✅ Día eliminado y reindexado.','ai');
    pendingChange = null;
    showWOW(false);
    return;
  }

  // 3) Quitar actividad (por texto incluye)
  if(intent.type==='remove_activity'){
    showWOW(true);
    const q = intent.query || '';
    const day = data.currentDay || 1;
    removeActivitiesByQuery(currentCity, day, q);
    await optimizeDay(currentCity, day);
    ensureFullCoverage(currentCity);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    chatMsg('✅ Actividad eliminada y horario reoptimizado.','ai');
    showWOW(false);
    return;
  }

  // 4) Mover actividad entre días
  if(intent.type==='move_activity'){
    showWOW(true);
    moveActivities(currentCity, intent.fromDay, intent.toDay, intent.query||'');
    await optimizeTwoDays(currentCity, intent.fromDay, intent.toDay);
    ensureFullCoverage(currentCity);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    chatMsg('✅ Moví la actividad y optimicé los días implicados.','ai');
    showWOW(false);
    return;
  }

  // 4b) Swap de días
  if(intent.type==='swap_day'){
    showWOW(true);
    swapDays(currentCity, intent.from, intent.to);
    await optimizeTwoDays(currentCity, intent.from, intent.to);
    ensureFullCoverage(currentCity);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    chatMsg('✅ Intercambié el orden de esos días y optimicé.','ai');
    showWOW(false);
    return;
  }

  // 5) Cambiar horas del día visible
  if(intent.type==='change_hours'){
    showWOW(true);
    const range = intent.range;
    const day = data.currentDay || 1;
    if(!cityMeta[currentCity]) cityMeta[currentCity]={perDay:[]};
    let pd = cityMeta[currentCity].perDay.find(x=>x.day===day);
    if(!pd){ pd = {day, start:DEFAULT_START, end:DEFAULT_END}; cityMeta[currentCity].perDay.push(pd); }
    if(range.start) pd.start = range.start;
    if(range.end)   pd.end   = range.end;
    await optimizeDay(currentCity, day);
    ensureFullCoverage(currentCity);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    chatMsg('✅ Ajusté los horarios y optimicé tu día.','ai');
    showWOW(false);
    return;
  }

  // 6) Agregar ciudad
  if(intent.type==='add_city'){
    const name = normalizeCityName(intent.name||'').trim();
    if(!name){ chatMsg('Necesito el nombre de la ciudad.','ai'); return; }
    const days = intent.days || 2;
    addCityRow({city:name, days});
    saveDestinations();
    chatMsg(`✅ Añadí <strong>${name}</strong>. Dime tu hotel/zona y transporte para generar el plan.`, 'ai');
    return;
  }

  // 7) Quitar ciudad (desde cualquier tab activa)
  if(intent.type==='remove_city'){
    const name = normalizeCityName(intent.name||'').trim();
    if(!name){ chatMsg('Necesito el nombre de la ciudad a quitar.','ai'); return; }
    savedDestinations = savedDestinations.filter(x=>x.city!==name);
    delete itineraries[name];
    delete cityMeta[name];
    renderCityTabs();
    chatMsg(`✅ Eliminé <strong>${name}</strong> de tu itinerario.`, 'ai');
    return;
  }

  // 8) Info query (modo ChatGPT) — NO bloquear UI
  if(intent.type==='info_query'){
    const infoPrompt = `
${FORMAT}
La consulta del usuario es informativa (no edites el itinerario). Responde breve, cálido y útil
con conocimiento turístico global (clima, ropa, transporte, gastronomía, imperdibles, mejor época).
Luego sugiere amablemente si desea que adaptes el itinerario en base a lo dicho y devuelve:
{"followup":"mensaje breve para continuar"}
`.trim();
    const ans = await callAgent(infoPrompt + `\n\nConsulta: ${text}`, true);
    const parsed = parseJSON(ans);
    chatMsg(parsed?.followup || '¿Quieres que ajuste tu itinerario con esta información?','ai');
    return;
  }

  // 9) Edición libre → confirmación breve
  if(intent.type==='free_edit'){
    const day = data.currentDay || 1;
    const summary = `Aplicar tus cambios en <strong>${currentCity}</strong> afectando el <strong>día ${day}</strong> (o días necesarios) y reoptimizar.`;
    const prompt = buildEditPrompt(currentCity,
      `Interpreta con precisión el deseo del usuario y actualiza los días implicados (prioriza el día visible ${day}). Reoptimiza sin duplicar.`,
      { daysStrict:[day], userText:text }
    );
    pendingChange = { city: currentCity, prompt, summary };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }
}

/* ================================
    SECCIÓN 18 · Upsell/Lock + Overlay + Eventos / INIT
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
  // Mensaje único en overlay (sin spam en chat)
  $overlayWOW.querySelector('.wow-text')?.remove();
  if(on){
    const span = document.createElement('div');
    span.className = 'wow-text';
    span.textContent = '✨ Astra está generando tu itinerario…';
    $overlayWOW.appendChild(span);
  }
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

/* Eventos */
$addCity?.addEventListener('click', ()=>addCityRow());
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

/* ================================
    SECCIÓN 19 · Fuzzy Matching + Similitud (global)
=================================== */
const KNOWN_CITIES = [
  'Reykjavik','Reikiavik','Reikjavik','Tromsø','Tromso','Paris','Madrid','Barcelona',
  'Luxor','Florence','Rome','Roma','Oslo','London','Saint Petersburg','San Petersburgo',
  'Rovaniemi','Abisko','Kiruna','Fairbanks','Yellowknife','Grindavik','Hveragerdi','Flúðir','Fludir','Selfoss','Milan','Milán','Segovia','Versalles','Montserrat','Girona','Sitges','Venezia','Venecia',
  // Apertura global (seed mínimo; fuzzy permite ciudades fuera de esta lista)
  'New York','Tokyo','Kyoto','Seoul','Bangkok','Singapore','Hong Kong','Sydney','Melbourne','Auckland','Cape Town','Johannesburg','Rio de Janeiro','Sao Paulo','Buenos Aires','Santiago','Lima','Bogotá','CDMX','Mexico City','Los Angeles','San Francisco','Toronto','Vancouver','Montréal','Istanbul','Athens','Cairo','Marrakesh','Dubai','Abu Dhabi','Doha','Delhi','Mumbai','Kathmandu','Bali','Jakarta','Hanoi','Ho Chi Minh City','Kuala Lumpur','Phuket','Chiang Mai','Siem Reap','Amman','Petra','Jerusalem','Tel Aviv','Amalfi','Naples','Milan','Venice','Prague','Vienna','Budapest','Munich','Berlin','Hamburg','Copenhagen','Stockholm','Helsinki','Tallinn','Riga','Vilnius','Warsaw','Krakow','Zurich','Geneva','Interlaken','Lucerne','Brussels','Bruges','Antwerp','Amsterdam','Rotterdam','The Hague','Dublin','Edinburgh','Glasgow','Reykjavík'
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
    'milan':'Milán','venezia':'Venecia','cdmx':'Mexico City','reykjavík':'Reykjavik'
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
