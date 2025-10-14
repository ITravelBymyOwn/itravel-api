/* =========================================================
    ITRAVELBYMYOWN · PLANNER v34
    Base: v33 (manteniendo estructura y secciones originales)
    Reglas cumplidas:
    1) Partir exactamente de v33      2) Mantener coherencia integral HTML/CSS/JS
    3) Entregar el código completo, listo para copiar/pegar

    Cambios v34 (localizados y robustos, sin romper lo estable):
    - 🪄 Fuzzy matching / normalización de nombres de ciudades:
      · Aplica en Sidebar (Sección 7) y Chat (Sección 17)
      · Normaliza variantes (“Reikjavik”→“Reykjavik”, “Tromso”→“Tromsø”, etc.)
      · Sugerencias naturales cuando no reconoce bien una ciudad
    - 🌟 Detección de imperdibles faltantes (Secciones 14 y 15):
      · Tras generar/reoptimizar: si faltan “imperdibles” típicos, propone agregarlos
      · Si el usuario dice “sí”, los inserta sin borrar otras actividades
    - 💬 Mensajes naturales si no se reconoce ciudad (Secciones 15 y 17)
    - 🧭 NLU ampliado (Sección 17):
      · “todos los días, dame actividades”
      · “quita solo las auroras del día 2”
      · “agrega la actividad que falta”
    - ✨ Nueva Sección 19: utilidades de fuzzy y similitud (aisladas)
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

// v32→v33: confirmación previa a cambios
let pendingChange = null; // { city, prompt, summary, ... }
let hasSavedOnce = false;

/* ================================
    SECCIÓN 2 · Tono / Mensajería
=================================== */
const tone = {
  es: {
    hi: '¡Hola! Soy tu concierge de viajes ✈️ Voy a construir tu aventura, ciudad por ciudad.',
    askHotelTransport: (city)=>`Para <strong>${city}</strong>, cuéntame <strong>hotel/zona</strong> y el <strong>medio de transporte</strong> que usarás (alquiler, público, taxi/uber, combinado o “recomiéndame”). Puedes responder en una sola frase.`,
    askInterestsIntro: (city, picks)=>`En <strong>${city}</strong> normalmente brillan estas ideas: ${picks.map(x=>`<em>${x}</em>`).join(' · ')}. ¿Alguna te emociona para incluirla? Puedes decir “sí: …”, “no por ahora” o “recomiéndame”.`,
    confirmAll: '✨ Genial. Ya tengo lo necesario. Comienzo a generar tus itinerarios…',
    doneAll: '🎉 ¡Listo! Itinerarios generados. ¿Quieres ajustarlos o añadir algo especial?',
    fail: '⚠️ No se pudo contactar con el asistente. Revisa consola/Vercel (API Key, URL).',
    askConfirm: (summary)=>`¿Confirmas? ${summary}<br><small>Responde “sí” para aplicar o “no” para cancelar.</small>`,
    humanOk: 'Perfecto 🙌 Ajusté tu itinerario para que aproveches mejor el tiempo. ¡Va a quedar genial! ✨',
    humanCancelled: 'Anotado, no apliqué cambios. ¿Probamos otra idea? 🙂',
    // v34
    fuzzySuggest: (suggested)=>`¿Querías decir <strong>${suggested}</strong>? 🌍`,
    fuzzyError: 'No reconozco esa ciudad. ¿Puedes revisarla o escribirla de nuevo?'
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
    let city     = qs('.city',r).value.trim();
    const country  = qs('.country',r).value.trim();
    const daysVal  = qs('.days',r).value;
    const days     = Math.max(1, parseInt(daysVal||'0',10)||1);
    const baseDate = qs('.baseDate',r).value.trim();

    // v34: aplicar fuzzy matching en sidebar (normaliza de inmediato)
    city = normalizeCityName(city);

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
function addDaysUtil(len){ return Array.from({length:len}, (_,i)=>i+1); }
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
  // Prompt global para estilo natural y capacidad “investigación” si el modelo lo soporta.
  const globalStyle = `
Eres "Astra", agente de viajes con 40 años de experiencia. Responde con calidez, variedad y emoción.
Investiga mentalmente o con tus herramientas si las tienes (web, conocimiento reciente) para sugerir
imperdibles y excursiones cercanas. Evita repeticiones. Cuando el usuario pida un cambio, primero
propón amablemente lo que harás y pide confirmación; SOLO tras “sí” ejecuta la edición.
Si la consulta es informativa (clima, consejos, etc.), responde normalmente y luego pregunta si
quiere que actualices el itinerario con lo aprendido.
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
    SECCIÓN 13 · Apply / Merge (fusión segura)
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
// Normaliza fila
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
// v33: replace ahora sustituye SOLO días presentes en rows
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
          pushRows(name, (rows||[]).map(r=>({...r, day:+k})), false);
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
          pushRows(name, (rows||[]).map(r=>({...r, day:+k})), false);
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
    SECCIÓN 14 · Fallback local inteligente / Sugerencias
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

// Sugerencias específicas por ciudad (imperdibles + day-trips)
const DAYTRIP_SUGGEST = {
  'Madrid': ['Segovia (Alcázar, acueducto)','Toledo (casco histórico)','Ávila (murallas)','El Escorial'],
  'Paris': ['Versalles','Giverny','Fontainebleau'],
  'Barcelona': ['Montserrat','Girona','Sitges'],
  'Reykjavik': ['Círculo Dorado','Costa Sur (Vík)','Blue Lagoon','Avistamiento de ballenas'],
  'Tromso': ['Caza de auroras','Fiordos en barco','Avistamiento de ballenas (en temporada)'],
  'Luxor': ['Valle de los Reyes','Templo de Karnak','Globo aerostático al amanecer']
};
function suggestedActivitiesFor(city, days){
  const name = (city||'').toLowerCase();
  const picks = [];
  if(['tromso','tromsø','rovaniemi','reykjavik','reikiavik','abisko','kiruna','fairbanks','yellowknife'].some(n=>name===n)){
    picks.push('Caza de auroras (21:00–23:30)');
  }
  if(['reykjavik','reikiavik','grindavik','hveragerdi','flúðir','fludir','selfoss'].some(n=>name===n)){
    picks.push('Aguas termales (Blue/Sky/Secret Lagoon)');
    picks.push('Círculo Dorado');
  }
  const dayTrips = DAYTRIP_SUGGEST[city];
  if(dayTrips) picks.push(...dayTrips.slice(0,5));
  if(!picks.length) picks.push('Imperdibles locales y experiencias gastronómicas');
  return [...new Set(picks)].slice(0,5);
}

// v34: imperdibles por ciudad (para verificar faltantes post-generación)
const MUST_SEE = {
  'Reykjavik': ['Caza de auroras', 'Blue Lagoon', 'Círculo Dorado'],
  'Tromsø': ['Caza de auroras', 'Fiordos', 'Avistamiento de ballenas'],
  'Tromso': ['Caza de auroras', 'Fiordos', 'Avistamiento de ballenas'] // alias
};
function detectMissingImperdibles(city){
  const checklist = MUST_SEE[city] || MUST_SEE[normalizeCityName(city)] || [];
  const existing = (itineraries[city]?.byDay && Object.values(itineraries[city].byDay).flat().map(r=>r.activity)) || [];
  const missing = checklist.filter(x=>!existing.some(a=>String(a||'').toLowerCase().includes(x.toLowerCase())));
  return missing;
}

/* ================================
    SECCIÓN 15 · Generación por ciudad
=================================== */
async function generateCityItinerary(city){
  // v34: fuzzy matching al generar
  const normalizedCity = normalizeCityName(city);
  if(normalizedCity !== city){
    chatMsg(`${tone.fuzzySuggest(normalizedCity)}`, 'ai');
    city = normalizedCity;
  }

  const dest  = savedDestinations.find(x=>x.city===city);
  if(!dest){
    chatMsg(`${tone.fuzzyError}`,'ai');
    return;
  }

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
**ROL:** Eres el planificador “Astra” (40 años de experiencia). Si tu modelo puede, apóyate en web/buscadores para validar imperdibles y tiempos típicos.
**TAREA:** Genera el itinerario completo SOLO para "${city}" para ${dest.days} día(s), optimizando tiempos/recursos.
- Usa el formato B {"destination":"${city}","rows":[...],"replace": true}.
- No dupliques actividades; conserva y mejora si hace falta.
- Respeta ventanas por día (si faltan, 08:30–19:00).
- Incluye notas humanas y motivadoras (breves).

Datos:
- Ciudad: "${city}"
- Días: ${dest.days}
- Horas/día: ${JSON.stringify(perDay)}
- BaseDate (día 1): ${baseDate||'N/A'}
- Hotel/Zona: ${hotel||'pendiente'}
- Transporte: ${transport}
- Intereses: ${JSON.stringify(interests)}

Contexto:
${buildIntake()}
`.trim();

  let text = await callAgent(instructions, false);
  let parsed = parseJSON(text);

  if(!parsed || (!parsed.rows && !parsed.destinations && !parsed.itineraries)){
    const strict = `
${FORMAT}
**REINTENTO:** Devuelve solo para "${city}" (${dest.days} días) en formato B con "replace": true. Nada de 'meta'.
`.trim();
    text = await callAgent(strict, false);
    parsed = parseJSON(text);
  }

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    applyParsedToState(parsed);
    ensureFullCoverage(city);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);

    // v34: detección de imperdibles faltantes post-generación
    const missing = detectMissingImperdibles(city);
    if(missing.length){
      chatMsg(`✨ Veo que aún no hemos incluido ${missing.join(', ')} — es una experiencia imperdible. ¿Quieres que la agregue?`,'ai');
      pendingChange = { type:'imperdibles_add', city, missing };
    }
    return;
  }

  // Fallback local si la API falla
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
    SECCIÓN 17 · Chat handler / NLU + Confirmación
=================================== */
// Números en palabras básicas
const WORD_NUM = {
  'una':1,'uno':1,'un':1,'dos':2,'tres':3,'cuatro':4,'cinco':5,'seis':6,'siete':7,'ocho':8,'nueve':9,'diez':10
};
// 7 y media / y cuarto / y tres cuartos
function normalizeHourToken(tok){
  tok = tok.toLowerCase().trim();
  // casos con “y media/cuarto/tres cuartos”
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
function intentFromText(text, city){
  const t = text.toLowerCase();

  // Confirmación/cancelación
  if(/^(sí|si|ok|dale|hazlo|confirmo|de una)\b/.test(t)) return {type:'confirm'};
  if(/^(no|mejor no|cancela|cancelar|cancelá)\b/.test(t)) return {type:'cancel'};

  // Añadir día (posible mención de day-trip)
  if(/agrega|añade|sum[aá]|un d[ií]a m[aá]s/.test(t)){
    return {type:'add_day', details:text};
  }
  // Quitar día (con confirmación numérica)
  if(/(quita|elimina|borra).+d[ií]a/.test(t)) return {type:'ask_remove_day'};
  const rm = t.match(/^(\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)$/);
  if(rm && pendingChange && pendingChange.type==='remove_day_wait'){
    const num = WORD_NUM[rm[0]] || parseInt(rm[0],10);
    return {type:'remove_day_confirm', day:num};
  }

  // Mover actividad día X→Y
  const mv = t.match(/(?:mueve|pasa|cambia).+?d[ií]a\s*(\d+)\s*(?:al|a)\s*d[ií]a\s*(\d+)/i);
  if(mv){ return {type:'move_day', from:parseInt(mv[1],10), to:parseInt(mv[2],10)}; }

  // Cambiar horas
  const range = parseTimeRangeFromText(text);
  if(range.start || range.end){
    return {type:'change_hours', range};
  }

  // v34: NLU ampliado
  if(/todos\s+los\s+d[ií]as.*actividades/.test(t)){
    return {type:'fill_all_days'};
  }
  const rmAct = t.match(/quita\s+solo\s+las\s+(\w+(?:\s+\w+)*)\s+del\s+d[ií]a\s*(\d+)/i);
  if(rmAct){
    return {type:'remove_activity_day', keyword: rmAct[1], day: parseInt(rmAct[2],10)};
  }
  if(/agrega\s+la\s+actividad\s+que\s+falta/.test(t)){
    return {type:'add_missing_activity'};
  }

  // Cambiar actividad puntual (heurística simple)
  if(/no quiero|sustituye|reemplaza|cambia esta actividad|dame otra opci[oó]n/.test(t)){
    return {type:'swap_activity', details:text};
  }

  // Pregunta informativa (clima, transporte, etc.)
  if(/clima|tiempo|temperatura|lluvia|horas de luz|alquiler de auto|aerol[ií]neas|vuelos|ropa|equipaje|visado|visa/.test(t)){
    return {type:'info_query', details:text};
  }

  // Por default: edición libre → pedir confirmación
  return {type:'free_edit', details:text};
}

async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  // v34: flujo para imperdibles pendientes
  if(pendingChange?.type === 'imperdibles_add'){
    if(/^sí|si|ok|dale|confirmo/i.test(text)){
      const {city, missing} = pendingChange;
      pendingChange = null;
      const targetDay = itineraries[city]?.currentDay || 1;
      const imperdibleRows = missing.map((act)=>({
        day: targetDay,
        start: '21:00',
        end: '23:00',
        activity: act,
        from: 'Hotel/Zona',
        to: act,
        transport: 'Tour/Traslado',
        duration: '120m',
        notes: '✨ Actividad imperdible agregada automáticamente.'
      }));
      pushRows(city, imperdibleRows, false);
      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
      chatMsg(tone.humanOk,'ai');
      return;
    }
    if(/^no|cancela/i.test(text)){
      pendingChange = null;
      chatMsg(tone.humanCancelled,'ai');
      return;
    }
  }

  // Paso 1: recolección hotel + transporte
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

  // Paso 2: recolección intereses
  if(collectingInterests){
    const city = savedDestinations[metaProgressIndex].city;
    const picks = /no/i.test(text) && !/sí|si/i.test(text)
      ? [] : text.split(/[,\n;·•]/).map(s=>s.trim()).filter(Boolean);
    upsertCityMeta({city, interests: picks});
    metaProgressIndex++;
    askNextInterests();
    return;
  }

  // A partir de aquí: edición / conversación
  let currentCity = activeCity || savedDestinations[0]?.city;

  // v34: si el usuario menciona ciudad en el texto y hay sugerencia fuzzy
  const extracted = fuzzyExtractCityFromText(text);
  if(extracted && (!currentCity || extracted.suggestion.toLowerCase() !== String(currentCity).toLowerCase())){
    chatMsg(tone.fuzzySuggest(extracted.suggestion),'ai');
    pendingChange = { type:'confirm_fuzzy_add_or_switch', city: extracted.suggestion };
    return;
  }
  if(pendingChange?.type === 'confirm_fuzzy_add_or_switch'){
    if(/^sí|si|ok|dale|confirmo/i.test(text)){
      const {city} = pendingChange;
      pendingChange = null;
      // Si ya existe, solo activar; si no, agregar
      if(!savedDestinations.find(d=>d.city===city)){
        addCityRow({city});
        saveDestinations();
      }
      setActiveCity(city);
      renderCityItinerary(city);
      chatMsg(`✅ ${city} listo. ¿Deseas que genere o ajuste su itinerario?`,'ai');
      return;
    }
    if(/^no|cancela/i.test(text)){
      pendingChange = null;
      chatMsg(tone.humanCancelled,'ai');
      return;
    }
  }

  const data = itineraries[currentCity];
  if(!currentCity || !data){
    chatMsg('Aún no hay itinerario en pantalla. Por favor, inicia la planificación primero.');
    return;
  }

  const intent = intentFromText(text, currentCity);

  // Confirmación flujo
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

  // Eliminar día: pedir número
  if(intent.type==='ask_remove_day'){
    pendingChange = {type:'remove_day_wait'};
    chatMsg('¿Qué día deseas eliminar? Indícame el número (ej. "4").','ai');
    return;
  }
  if(intent.type==='remove_day_confirm'){
    const day = intent.day;
    if(!Number.isInteger(day) || day<=0){
      chatMsg('Necesito un número de día válido.','ai'); return;
    }
    const prompt = buildEditPrompt(currentCity, `Eliminar el día ${day} y reindexar el resto sin perder contenido.`, { daysStrict:[day] });
    pendingChange = { city: currentCity, prompt, summary:`Eliminar el <strong>día ${day}</strong> en ${currentCity} y reindexar.` };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }

  // Cambiar horas del día visible
  if(intent.type==='change_hours'){
    const range = intent.range;
    const summary = `Actualizar horarios del <strong>día ${data.currentDay}</strong> en ${currentCity} ${range.start?`(inicio: ${range.start})`:''} ${range.end?`(fin: ${range.end})`:''}.`;
    const prompt = buildEditPrompt(currentCity,
      `Ajusta horarios del día ${data.currentDay} con overrides: ${JSON.stringify(range)}. Reoptimiza sin duplicar.`,
      { daysStrict:[data.currentDay], overrides:range }
    );
    pendingChange = { city: currentCity, prompt, summary };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }

  // Mover actividades entre días
  if(intent.type==='move_day'){
    const {from,to} = intent;
    const summary = `Mover actividades del <strong>día ${from}</strong> al <strong>día ${to}</strong> en ${currentCity} y reoptimizar ambos días.`;
    const prompt = buildEditPrompt(currentCity,
      `Mueve actividades del día ${from} al día ${to}. Reoptimiza ambos días. No dupliques.`,
      { daysStrict:[from,to] }
    );
    pendingChange = { city: currentCity, prompt, summary };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }

  // Añadir un día (posible day-trip)
  if(intent.type==='add_day'){
    const summary = `Añadir un <strong>día extra</strong> en ${currentCity} (si el texto menciona un destino como Segovia/Versalles, enfoca ese day-trip).`;
    const prompt = buildEditPrompt(currentCity,
      `Añade un día extra al final. Si el texto menciona un destino (ej. Segovia, Versalles), crea un day-trip optimizado a ese lugar con sus puntos clave.`,
      { addOneDay:true }
    );
    pendingChange = { city: currentCity, prompt, summary };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }

  // Cambiar actividad puntual
  if(intent.type==='swap_activity'){
    const summary = `Sustituir una actividad del <strong>día ${data.currentDay}</strong> en ${currentCity} por otra sugerida (manteniendo el resto).`;
    const prompt = buildEditPrompt(currentCity,
      `Interpreta la actividad a sustituir según el texto del usuario y reemplázala por una opción coherente cercana. Reoptimiza SOLO el día visible.`,
      { daysStrict:[data.currentDay] }
    );
    pendingChange = { city: currentCity, prompt, summary };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }

  // v34: NLU ampliado — llenar todos los días con actividades base
  if(intent.type==='fill_all_days'){
    const summary = `Completar actividades en <strong>todos los días</strong> de ${currentCity}, respetando ventanas por día.`;
    const prompt = buildEditPrompt(currentCity,
      `Rellena actividades razonables para todos los días sin duplicar, respetando ventanas y manteniendo lo ya bueno.`,
      { daysStrict: Object.keys(itineraries[currentCity]?.byDay||{}).map(n=>+n) }
    );
    pendingChange = { city: currentCity, prompt, summary };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }

  // v34: NLU — quitar solo “keyword” del día N
  if(intent.type==='remove_activity_day'){
    const {keyword, day} = intent;
    const summary = `Quitar actividades que contengan "<strong>${keyword}</strong>" del <strong>día ${day}</strong> en ${currentCity}.`;
    const prompt = buildEditPrompt(currentCity,
      `Elimina actividades cuyo nombre contenga "${keyword}" del día ${day}". Reoptimiza el día sin duplicar.`,
      { daysStrict:[day], userText:`quitar ${keyword} del día ${day}` }
    );
    pendingChange = { city: currentCity, prompt, summary };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }

  // v34: NLU — agregar la actividad que falta (imperdibles)
  if(intent.type==='add_missing_activity'){
    const missing = detectMissingImperdibles(currentCity);
    if(missing.length){
      chatMsg(`Puedo agregar: ${missing.join(', ')}. ¿Quieres que los inserte?`,'ai');
      pendingChange = { type:'imperdibles_add', city: currentCity, missing };
      return;
    }else{
      chatMsg('No veo imperdibles faltantes evidentes ahora mismo.','ai');
      return;
    }
  }

  // Consulta informativa: responde y ofrece actualizar
  if(intent.type==='info_query'){
    const infoPrompt = `
${FORMAT}
El usuario te pide información (no edites itinerario aún). Responde breve, cálido, con datos útiles.
Luego sugiere si desea actualizar itinerario con lo aprendido y devuelve:
{"followup":"mensaje breve para continuar"}
`.trim();
    const ans = await callAgent(infoPrompt + `\n\nConsulta: ${text}`, true);
    const parsed = parseJSON(ans);
    chatMsg(parsed?.followup || '¿Quieres que ajuste tu itinerario con esta información?','ai');
    return;
  }

  // Edición libre → pedir confirmación
  if(intent.type==='free_edit'){
    const summary = `Aplicar tus cambios en <strong>${currentCity}</strong> afectando el <strong>día ${data.currentDay}</strong> (o días necesarios) y reoptimizar.`;
    const prompt = buildEditPrompt(currentCity,
      `Interpreta con precisión el deseo del usuario y actualiza los días implicados (prioriza el día visible ${data.currentDay}). Reoptimiza sin duplicar.`,
      { daysStrict:[data.currentDay], userText:text }
    );
    pendingChange = { city: currentCity, prompt, summary };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }
}

// Construcción de prompt de edición (respeta formato B, replace:true)
function buildEditPrompt(city, directive, opts={}){
  const data = itineraries[city];
  const day = data?.currentDay || 1;
  const dayRows = (data?.byDay?.[day]||[]).map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)';
  const allDays = Object.keys(data?.byDay||{}).map(n=>{
    const rows = data.byDay[n]||[];
    return `Día ${n}:\n${rows.map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)'}`;
  }).join('\n\n');

  const perDay = (cityMeta[city]?.perDay||[]).map(pd=>({day:pd.day, start:pd.start||DEFAULT_START, end:pd.end||DEFAULT_END}));
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
  showWOW(true);
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
    SECCIÓN 19 · Fuzzy Matching + Similitud (NUEVA v34)
=================================== */
// Lista base local (extensible). Para MVP garantiza robustez y velocidad.
// Puedes ampliarla sin romper nada (o pasar a fuente externa en v35+).
const KNOWN_CITIES = [
  'Reykjavik','Tromsø','Tromso','Paris','Madrid','Barcelona','Luxor',
  'Florence','Rome','Oslo','London','Reikiavik','Reikjavik','Tromsoee',
  'Saint Petersburg','San Petersburgo','Rovaniemi','Abisko','Kiruna',
  'Fairbanks','Yellowknife','Grindavik','Hveragerdi','Flúðir','Fludir','Selfoss'
];

// Normaliza un nombre de ciudad: quita acentos/espacios, compara con base y devuelve mejor match si supera umbral.
function normalizeCityName(input){
  if(!input) return '';
  const clean = input.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  let bestMatch = '';
  let bestScore = 0;
  for(const city of KNOWN_CITIES){
    const score = stringSimilarity(clean, city.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase());
    if(score > bestScore){ bestScore = score; bestMatch = city; }
  }
  // Mapeos de alias comunes → nombre preferido
  const preferred = {
    'reikjavik':'Reykjavik','reikiavik':'Reykjavik','reykjavik':'Reykjavik',
    'tromso':'Tromsø','tromsoee':'Tromsø',
    'san petersburgo':'Saint Petersburg'
  };
  const bestKey = bestMatch.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const preferredName = preferred[bestKey] || bestMatch;

  return bestScore > 0.8 ? preferredName : input;
}

// Intenta extraer/identificar una ciudad mencionada en texto libre y sugiere la más cercana.
function fuzzyExtractCityFromText(text){
  const lower = text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  let bestMatch = '';
  let bestScore = 0;

  // prueba por tokens (palabras) y por string completo
  const tokens = lower.split(/[^a-zA-Záéíóúñü]+/).filter(Boolean);
  const candidates = new Set(tokens.concat([lower]));
  for(const cand of candidates){
    for(const city of KNOWN_CITIES){
      const score = stringSimilarity(cand, city.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase());
      if(score > bestScore){ bestScore = score; bestMatch = city; }
    }
  }
  if(bestScore > 0.8){
    // normaliza al nombre preferido
    return {suggestion: normalizeCityName(bestMatch), score: bestScore};
  }
  return null;
}

// Similitud basada en distancia de Levenshtein normalizada
function stringSimilarity(a,b){
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  const longerLength = longer.length;
  if(longerLength === 0) return 1.0;
  const editDistance = levenshteinDistance(longer, shorter);
  return (longerLength - editDistance) / parseFloat(longerLength);
}
function levenshteinDistance(a,b){
  const matrix = [];
  let i;
  for(i=0;i<=b.length;i++){ matrix[i]=[i]; }
  let j;
  for(j=0;j<=a.length;j++){ matrix[0][j]=j; }
  for(i=1;i<=b.length;i++){
    for(j=1;j<=a.length;j++){
      if(b.charAt(i-1)==a.charAt(j-1)){
        matrix[i][j]=matrix[i-1][j-1];
      }else{
        matrix[i][j]=Math.min(matrix[i-1][j-1]+1,Math.min(matrix[i][j-1]+1,matrix[i-1][j]+1));
      }
    }
  }
  return matrix[b.length][a.length];
}
