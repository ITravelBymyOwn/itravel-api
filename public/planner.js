/* =========================================================
    ITRAVELBYMYOWN · PLANNER v35
    Base: v34 (manteniendo estructura y secciones)
    Cambios v35 (resumen):
    - Chat tipo ChatGPT (NLU ampliada) para: agregar día (inicio/final/N),
      quitar día, quitar actividades (con optimización y relleno),
      mover actividades entre días (reoptimiza ambos), agregar/quitar ciudades.
    - Generación IA SIEMPRE para todos los días; si falla → NO fallback local,
      se informa el error y se pide reintentar (fatal).
    - Imperdibles obtenidos por el modelo (con chequeo de faltantes y sugerencia).
    - Day-trip inteligente (si el usuario menciona destino en “agrega un día”).
    - Actividades nocturnas (p.ej., auroras) → día con actividades diurnas + bloque nocturno.
    - Temporada/fechas/clima condicionan qué actividades proponer (ej. auroras sep–abr).
    - Horarios flexibles si el usuario no define; el agente puede sugerir y luego el usuario ajusta.
    - Preguntas iniciales SOLO: hospedaje + transporte (se elimina “intereses”).
    - Fuzzy matching ciudades en sidebar y chat (se conserva).
    - Confirmaciones más humanas y breves.
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
// v35: eliminamos la fase “interests” (el agente sugiere imperdibles solo)
let isItineraryLocked = false;

const DEFAULT_START = '08:30';
const DEFAULT_END   = '19:00';

// confirmación previa a cambios
let pendingChange = null; // { type?, city, prompt, summary, ... }
let hasSavedOnce = false;

/* ================================
    SECCIÓN 2 · Tono / Mensajería
=================================== */
const tone = {
  es: {
    hi: '¡Hola! Soy tu concierge de viajes ✈️ Voy a construir tu aventura, ciudad por ciudad.',
    askHotelTransport: (city)=>`Para <strong>${city}</strong>, cuéntame <strong>hotel/zona</strong> y el <strong>medio de transporte</strong> (alquiler, público, taxi/uber, combinado o “recomiéndame”). Puedes responder en una sola frase.`,
    confirmAll: '✨ Genial. Ya tengo lo necesario. Comienzo a generar tus itinerarios…',
    doneAll: '🎉 ¡Listo! Itinerarios generados. ¿Quieres ajustarlos o añadir algo especial?',
    fail: '⚠️ No se pudo contactar con el asistente. Revisa consola/Vercel (API Key, URL).',
    // v35: confirmaciones breves y humanas
    askConfirm: (summary)=>`¿Lo aplico ahora? ${summary}<br><small>Responde “sí” para aplicar o “no” para dejarlo como está.</small>`,
    askWhereAddDay: '¿Dónde agrego el día: al <strong>inicio</strong>, al <strong>final</strong> o en un <strong>número específico</strong> (por ejemplo “día 2”)?',
    askWhichDayToRemove: '¿Qué día deseas eliminar?',
    humanOk: 'Perfecto 🙌 Ajusté tu itinerario para que aproveches mejor el tiempo.',
    humanCancelled: 'Anotado, no apliqué cambios.',
    // fuzzy
    fuzzySuggest: (suggested)=>`¿Querías decir <strong>${suggested}</strong>? 🌍 Puedo armar el itinerario si me confirmas.`,
    fuzzyNotFound: 'No pude reconocer esa ciudad. ¿Puedes revisarla o escribirla de nuevo?',
    // generación fallida
    genError: (city)=>`⚠️ No pude generar el itinerario de <strong>${city}</strong> en este intento. ¿Quieres que lo reintente ahora?`
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
    city = normalizeCityName(city); // v34/v35 fuzzy
    const country  = qs('.country',r).value.trim();
    const daysVal  = qs('.days',r).value;
    const days     = Math.max(1, parseInt(daysVal||'0',10)||1);
    const baseDate = qs('.baseDate',r).value.trim();

    if(!city) return;
    const perDay = [];
    qsa('.hours-day', r).forEach((hd, idx)=>{
      const start = qs('.start',hd).value || ''; // v35: dejamos vacío si el usuario no lo define → horario flexible
      const end   = qs('.end',hd).value   || '';
      perDay.push({ day: idx+1, start, end });
    });
    if(perDay.length===0){
      for(let d=1; d<=days; d++) perDay.push({day:d,start:'',end:''}); // v35: flexible
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

  // v35: respetar “flexible” si el usuario no definió horas
  savedDestinations.forEach(dest=>{
    if(!cityMeta[dest.city]) cityMeta[dest.city] = {};
    if(!cityMeta[dest.city].perDay) cityMeta[dest.city].perDay = [];
    cityMeta[dest.city].perDay = Array.from({length:dest.days}, (_,i)=>{
      const prev = (cityMeta[dest.city].perDay||[]).find(x=>x.day===i+1) || dest.perDay?.[i];
      return {
        day: i+1,
        start: (prev && prev.start) ? prev.start : '', // vacío = flexible
        end:   (prev && prev.end)   ? prev.end   : ''
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
- Usa horas por día si están disponibles; si faltan, el agente puede sugerir horas lógicas según temporada y actividad (no limites a 08:30–19:00 si hay actividades nocturnas).
- No dupliques; conserva lo existente salvo instrucción explícita.
- Máximo 20 filas por día.
- Nada de texto fuera del JSON.
`;
/* ================================
    SECCIÓN 12 · Llamada al agente (prompts reforzados)
=================================== */
async function callAgent(text, useHistory = true){
  const history = useHistory ? session : [];
  const globalStyle = `
Eres "Astra", agente de viajes con 40 años de experiencia.
- Responde con calidez, variedad y emoción.
- Usa tu conocimiento para proponer imperdibles reales por ciudad y temporada.
- Si el usuario pide un cambio, proponlo con brevedad y pide confirmación; tras “sí” aplicas.
- Si una respuesta informativa podría afectar el plan, pregunta si desea actualizar el itinerario.
- No inventes datos si no estás seguro: pide confirmación o aclara la duda.
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
    SECCIÓN 13 · Apply / Merge + utilidades de edición (v35)
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
  const start   = r.start ?? r.start_time ?? r.startTime ?? r.hora_inicio ?? '';
  const end     = r.end   ?? r.end_time   ?? r.endTime   ?? r.hora_fin    ?? '';
  const act     = r.activity ?? r.title ?? r.name ?? r.descripcion ?? r.descripcion_actividad ?? '';
  const from    = r.from ?? r.origin ?? r.origen ?? '';
  const to      = r.to   ?? r.destination ?? r.destino ?? '';
  const trans   = r.transport ?? r.transportMode ?? r.modo_transporte ?? '';
  const durRaw  = r.duration ?? r.durationMinutes ?? r.duracion ?? '';
  const notes   = r.notes ?? r.nota ?? r.comentarios ?? '';
  const duration = (typeof durRaw === 'number') ? `${durRaw}m` : (String(durRaw)||'');
  const d = Math.max(1, parseInt(r.day ?? r.dia ?? fallbackDay, 10) || 1);
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

/* ==== v35 · Utilidades de manipulación de días y actividades ==== */
// Inserta un nuevo día en posición (1..N+1) reindexando
function insertDayAt(city, position){
  ensureDays(city);
  const byDay = itineraries[city].byDay || {};
  const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  const maxD = days.length ? Math.max(...days) : 0;
  const pos = Math.min(Math.max(1, position), maxD+1);
  // desplazar hacia adelante desde pos
  for(let d = maxD; d >= pos; d--){
    byDay[d+1] = (byDay[d]||[]).map(r=>({...r, day:d+1}));
  }
  byDay[pos] = []; // nuevo día vacío
  itineraries[city].byDay = byDay;
  // actualizar savedDestinations.days
  const dest = savedDestinations.find(x=>x.city===city);
  if(dest) dest.days = (dest.days||maxD) + 1;
}

// Elimina un día y reindexa siguientes
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

// Mover una o varias actividades que hagan match con query (string parcial) de un día a otro
function moveActivities(city, fromDay, toDay, query=''){
  ensureDays(city);
  const byDay = itineraries[city].byDay || {};
  const src = byDay[fromDay] || [];
  const dst = byDay[toDay] || [];
  const q = query.trim().toLowerCase();
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

// Quitar actividades por query difusa en un día
function removeActivitiesByQuery(city, day, query){
  ensureDays(city);
  const byDay = itineraries[city].byDay || {};
  const src = byDay[day] || [];
  const q = String(query||'').toLowerCase().trim();
  if(!q){ byDay[day]=src; return; }
  byDay[day] = src.filter(r=>!String(r.activity||'').toLowerCase().includes(q));
  itineraries[city].byDay = byDay;
}

// Optimizar un día: pide al modelo reordenar y rellenar huecos respetando horario y sin duplicar
async function optimizeDay(city, day){
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
Día a optimizar: ${day}
Fecha base (d1): ${baseDate||'N/A'}
Ventanas definidas por usuario para el día: ${JSON.stringify(perDay)} (si están vacías, sugiere horas lógicas)
Filas actuales del día:
${JSON.stringify(rows)}

Instrucción:
- Reordena y optimiza el día para minimizar traslados y aprovechar el tiempo.
- Si hay huecos tras quitar o mover actividades, sugiere y agrega actividades relevantes (imperdibles pendientes o cercanas).
- Considera temporada/horas de luz y si hay actividades nocturnas.
- No repitas actividades que ya existen en otros días de esta ciudad si se mencionan en “Existing”.
- Devuelve formato C {"rows":[...],"replace":true}.
Contexto:
${buildIntake()}
`.trim();

  const ans = await callAgent(prompt, true);
  const parsed = parseJSON(ans);
  if(parsed?.rows){
    pushRows(city, parsed.rows.map(x=>({...x, day})), true);
  }
}

// Optimiza dos días implicados (origen/destino) tras mover
async function optimizeTwoDays(city, a, b){
  await optimizeDay(city, a);
  if(a!==b) await optimizeDay(city, b);
}

/* ================================
    SECCIÓN 14 · (v35) Sugerencias / Day-trip helpers
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
// Construye rápidamente un bloque de day-trip (se usará como indicación; la IA lo terminará de optimizar)
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
    SECCIÓN 15 · Generación por ciudad (v35: sin fallback local)
=================================== */
async function generateCityItinerary(city){
  const norm = normalizeCityName(city);
  const dest  = savedDestinations.find(x=>x.city===norm);
  if(!dest){
    const sug = fuzzyBestCity(city);
    if(sug) { chatMsg(tone.fuzzySuggest(sug),'ai'); pendingChange = { type:'confirm_fuzzy_add', city:sug }; }
    else chatMsg(tone.fuzzyNotFound,'ai');
    return;
  }

  // horas por día (permitimos vacío = flexible)
  const perDay = Array.from({length:dest.days}, (_,i)=>{
    const src  = (cityMeta[norm]?.perDay||[])[i] || dest.perDay?.[i] || {};
    return { day:i+1, start: src.start || '', end: src.end || '' };
  });

  const baseDate = cityMeta[norm]?.baseDate || dest.baseDate || '';
  const hotel    = cityMeta[norm]?.hotel || '';
  const transport= cityMeta[norm]?.transport || 'recomiéndame';

  const instructions = `
${FORMAT}
**ROL:** Eres el planificador “Astra” (40 años de experiencia).
**TAREA:** Genera el itinerario COMPLETO para "${norm}" para ${dest.days} día(s).
- Debes devolver TODOS los días con actividades coherentes, optimizadas y SIN duplicados.
- Considera fechas y temporada (ej. auroras sep–abr, horas de luz, clima típico) para proponer actividades realistas.
- Imperdibles del destino: inclúyelos; si no caben, prioriza y deja fuera los menores.
- Respeta horas definidas por usuario si existen; si están vacías, sugiere horas lógicas (incluye nocturnas si aplica).
- Devuelve en formato:
  B {"destination":"${norm}","rows":[...],"replace": true}
  o A si prefieres agrupar por destino, pero debe cubrir todos los días.

Datos:
- Ciudad: "${norm}"
- Días: ${dest.days}
- Horas/día: ${JSON.stringify(perDay)}
- BaseDate (día 1): ${baseDate||'N/A'}
- Hotel/Zona: ${hotel||'pendiente'}
- Transporte: ${transport}

Contexto:
${buildIntake()}
`.trim();

  // Primer intento
  let text = await callAgent(instructions, false);
  let parsed = parseJSON(text);

  // Reintento estricto si no vino en formato válido
  const needsRetry = !(parsed && (parsed.rows || parsed.destinations || parsed.itineraries));
  if(needsRetry){
    const strict = `
${FORMAT}
**REINTENTO ESTRICTO:** Devuelve solo para "${norm}" (${dest.days} días) en formato B con "replace": true, cubriendo TODOS los días. Nada de 'meta'.
`.trim();
    text = await callAgent(strict, false);
    parsed = parseJSON(text);
  }

  // Validación dura: debe cubrir todos los días
  const coversAllDays = (p)=>{
    try{
      const tmp = {};
      if(p?.rows){
        p.rows.forEach(r=>{ tmp[r.day]=true; });
      }else if(Array.isArray(p?.destinations)){
        const dd = p.destinations.find(d=> (d.name||d.destination)===norm);
        if(dd?.rows) dd.rows.forEach(r=>{ tmp[r.day]=true; });
      }else if(Array.isArray(p?.itineraries)){
        const ii = p.itineraries.find(x=> (x.city||x.name||x.destination)===norm);
        if(ii?.rows) ii.rows.forEach(r=>{ tmp[r.day]=true; });
      }
      const destObj = savedDestinations.find(x=>x.city===norm);
      if(!destObj) return false;
      for(let d=1; d<=destObj.days; d++){ if(!tmp[d]) return false; }
      return true;
    }catch(_){ return false; }
  };

  if(parsed && coversAllDays(parsed)){
    applyParsedToState(parsed);
    renderCityTabs(); setActiveCity(norm); renderCityItinerary(norm);

    // Chequeo de imperdibles faltantes (apoyado en la propia salida del modelo)
    // Hacemos una consulta rápida para que el modelo liste must-sees que no haya incluido.
    const auditPrompt = `
Devuelve SOLO JSON: {"missing":["..."]}.
Ciudad: ${norm}
Días: ${dest.days}
Basado en este snapshot de actividades ya generadas:
${getFrontendSnapshot()}
Lista breve de imperdibles internacionales que NO aparezcan aún (según tu conocimiento, considerando temporada): máximo 5.
`.trim();
    const auditAns = await callAgent(auditPrompt, false);
    const audit = parseJSON(auditAns);
    const missing = Array.isArray(audit?.missing) ? audit.missing.filter(Boolean) : [];
    if(missing.length){
      chatMsg(`✨ Veo que aún no hemos incluido <strong>${missing.join(', ')}</strong>. ¿Quieres que los agregue en los huecos disponibles?`,'ai');
      pendingChange = { type:'imperdibles_add', city:norm, missing };
    }
    return;
  }

  // Si falla → NO fallback local
  chatMsg(tone.genError(norm),'ai');
}

/* ================================
    SECCIÓN 16 · Flujo principal · HOTELS ONLY (v35)
=================================== */
async function startPlanning(){
  if(savedDestinations.length===0) return;
  $chatBox.style.display='flex';
  planningStarted = true;
  collectingHotels = true;
  metaProgressIndex = 0;

  session = []; // historial para edición
  chatMsg(`${tone.hi}`);
  askNextHotelTransport();
}
function askNextHotelTransport(){
  if(metaProgressIndex >= savedDestinations.length){
    collectingHotels = false;
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
  setActiveCity(city); renderCityItinerary(city);
  chatMsg(tone.askHotelTransport(city),'ai');
}
/* ================================
    SECCIÓN 17 · Chat handler / NLU + Confirmación (v35)
=================================== */
// Números en palabras básicas
const WORD_NUM = {
  'una':1,'uno':1,'un':1,'dos':2,'tres':3,'cuatro':4,'cinco':5,'seis':6,'siete':7,'ocho':8,'nueve':9,'diez':10
};
// 7 y media / y cuarto / y tres cuartos
function normalizeHourToken(tok){
  tok = tok.toLowerCase().trim();
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

// Intents v35
function intentFromText(text, city){
  const t = text.toLowerCase();

  // Confirmación/cancelación cortas
  if(/^(sí|si|ok|dale|hazlo|confirmo|de una)\b/.test(t)) return {type:'confirm'};
  if(/^(no|mejor no|cancela|cancelar|cancelá)\b/.test(t)) return {type:'cancel'};

  // Agregar día
  if(/(agrega|añade|sum[aá])\s+un?\s+d[ií]a/.test(t)){
    // posición: inicio/final/día N
    let pos = null;
    if(/\binicio\b/.test(t)) pos = 'start';
    else if(/\bfinal\b/.test(t)) pos = 'end';
    else {
      const p = parseOrdinalDay(t);
      if(p) pos = p;
    }
    // ¿hay day-trip o lugar?
    const placeMatch = t.match(/para\s+ir\s+a\s+([a-záéíóúüñ\s]+)$/i) || t.match(/a\s+([a-záéíóúüñ\s]+)\s*$/i);
    const place = placeMatch ? placeMatch[1].trim() : null;
    // actividad nocturna ejemplo “auroras”
    const night = /\baurora|auroras|noche|nocturn[oa]\b/.test(t);
    return {type:'add_day', position:pos, place, night};
  }

  // Quitar día (sin ejemplo)
  if(/(quita|elimina|borra)\s+un?\s+d[ií]a/.test(t) || /(quita|elimina|borra)\s+el\s+d[ií]a/.test(t)){
    const d = parseOrdinalDay(t);
    return d ? {type:'remove_day', day:d} : {type:'ask_remove_day_direct'};
  }

  // Quitar actividad (ej. “no quiero el museo” / “quita museo”)
  if(/\b(no\s+quiero|quita|elimina|borra)\b.+/.test(t)){
    // posible actividad
    const actMatch = t.replace(/(no\s+quiero|quita|elimina|borra)/i,'').trim();
    if(actMatch && !/d[ií]a\s+\d+/.test(t) && !/(ciudad|rom[a|e]|barcelona|madrid|troms)/i.test(actMatch)){
      return {type:'remove_activity', query: actMatch};
    }
  }

  // Mover actividad día X→Y
  const mv = t.match(/(?:mueve|pasa|cambia)\s+(.*?)(?:\s+del\s+d[ií]a\s+(\d+)|\s+del\s+(\d+))\s+(?:al|a)\s+(?:d[ií]a\s+)?(\d+)/i);
  if(mv){
    const query = (mv[1]||'').trim();
    const from = parseInt(mv[2] || mv[3],10);
    const to   = parseInt(mv[4],10);
    return {type:'move_activity', query, fromDay:from, toDay:to};
  }

  // Cambiar horas
  const range = parseTimeRangeFromText(text);
  if(range.start || range.end){
    return {type:'change_hours', range};
  }

  // Agregar ciudad
  if(/(agrega|añade)\s+(una\s+)?ciudad\b|\bagrega\s+[a-záéíóúüñ\s]+(\s+\d+\s+d[ií]as)?$/i.test(t) || /agrega\s+[a-záéíóúüñ]+(\s+\d+\s+d[ií]as)?/i.test(t)){
    const m = t.match(/agrega\s+([a-záéíóúüñ\s]+?)(?:\s+(\d+)\s+d[ií]as?)?$/i);
    if(m){
      return {type:'add_city', name: m[1].trim(), days: m[2]?parseInt(m[2],10):null};
    }
  }

  // Quitar ciudad
  if(/(quita|elimina|borra)\s+[a-záéíóúüñ\s]+$/i.test(t)){
    const m = t.match(/(quita|elimina|borra)\s+([a-záéíóúüñ\s]+)$/i);
    if(m){
      return {type:'remove_city', name: m[2].trim()};
    }
  }

  // Pregunta informativa (clima/transporte/etc.)
  if(/clima|tiempo|temperatura|lluvia|horas de luz|alquiler de auto|aerol[ií]neas|vuelos|ropa|equipaje|visado|visa|estaci[oó]n|temporada/.test(t)){
    return {type:'info_query', details:text};
  }

  // Edición libre
  return {type:'free_edit', details:text};
}

async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  // Confirmación imperdibles
  if(pendingChange?.type === 'imperdibles_add'){
    if(/^sí|si|ok|dale|confirmo/i.test(text)){
      const {city, missing} = pendingChange;
      pendingChange = null;
      const day = itineraries[city]?.currentDay || 1;
      // Pide al modelo insertar imperdibles en huecos del itinerario
      const prompt = `
${FORMAT}
Edita ${city} insertando estas actividades en huecos adecuados del día visible (${day}) o distribuyéndolas en días lógicos sin duplicar:
${JSON.stringify(missing)}
Devuelve B {"destination":"${city}","rows":[...],"replace": true} SOLO con los días modificados.
Contexto:
${buildIntake()}
`.trim();
      const ans = await callAgent(prompt, true);
      const parsed = parseJSON(ans);
      if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
        applyParsedToState(parsed);
        renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
        chatMsg(tone.humanOk,'ai');
      }else{
        chatMsg('No pude insertar esas actividades ahora. ¿Intentamos de nuevo?','ai');
      }
      return;
    }
    if(/^no/i.test(text)){
      pendingChange = null;
      chatMsg(tone.humanCancelled,'ai');
      return;
    }
  }

  // confirmación ciudad sugerida
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

  // Conversación / edición
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

  const intent = intentFromText(text, currentCity);

  // Confirm/cancel pendiente genérico
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

  // --- Acciones específicas ---

  // 1) Agregar día (inicio/final/N). Si incluye "place" → day-trip seed y optimización.
  if(intent.type==='add_day'){
    const city = currentCity;
    let pos = intent.position;
    if(!pos){
      pendingChange = {type:'await_add_day_pos', city, intent};
      chatMsg(tone.askWhereAddDay,'ai');
      return;
    }
    if(pendingChange?.type==='await_add_day_pos'){
      pos = (/inicio/.test(text.toLowerCase())) ? 'start'
        : (/final/.test(text.toLowerCase())) ? 'end'
        : parseOrdinalDay(text) || intent.position;
      pendingChange = null;
    }
    // Calcular posición numérica
    ensureDays(city);
    const byDay = itineraries[city].byDay || {};
    const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
    const numericPos = (pos==='start') ? 1 : (pos==='end' ? days.length+1 : Math.max(1, Math.min(+pos, days.length+1)));

    insertDayAt(city, numericPos);
    // Si el usuario mencionó un lugar → seed day-trip
    if(intent.place){
      const rows = seedDayTripRows(city, intent.place, numericPos);
      pushRows(city, rows, true);
    }
    // Si es actividad nocturna → añadimos bloque auroras (o genérico) al final del día
    if(intent.night){
      const end = (cityMeta[city]?.perDay?.find(x=>x.day===numericPos)?.end) || '23:30';
      const startN = '21:00';
      pushRows(city, [{day:numericPos,start:startN,end:end,activity:'Actividad nocturna (p.ej., caza de auroras)',from:'Hotel',to:'',transport:'Tour/Bus',duration:'150m',notes:'Horario aproximado'}], false);
    }

    // Optimiza el día nuevo
    await optimizeDay(city, numericPos);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    chatMsg('✅ Día agregado. ¿Seguimos ajustando?','ai');
    return;
  }

  // 2) Quitar día
  if(intent.type==='ask_remove_day_direct'){
    pendingChange = {type:'remove_day_wait'};
    chatMsg(tone.askWhichDayToRemove,'ai');
    return;
  }
  if(intent.type==='remove_day' || (intent.type==='confirm' && pendingChange?.type==='remove_day_wait')){
    const day = intent.day || parseOrdinalDay(text);
    if(!Number.isInteger(day) || day<=0){
      pendingChange = {type:'remove_day_wait'};
      chatMsg(tone.askWhichDayToRemove,'ai'); return;
    }
    removeDayAt(currentCity, day);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    chatMsg(tone.humanOk,'ai');
    pendingChange = null;
    return;
  }

  // 3) Quitar actividad (y optimizar/rellenar)
  if(intent.type==='remove_activity'){
    const q = intent.query || '';
    const day = data.currentDay || 1;
    removeActivitiesByQuery(currentCity, day, q);
    await optimizeDay(currentCity, day);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    chatMsg('He quitado esa actividad y optimicé tu día.','ai');
    return;
  }

  // 4) Mover actividad entre días (y reoptimiza ambos)
  if(intent.type==='move_activity'){
    moveActivities(currentCity, intent.fromDay, intent.toDay, intent.query||'');
    await optimizeTwoDays(currentCity, intent.fromDay, intent.toDay);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    chatMsg('Listo, moví la actividad y reoptimicé los días implicados.','ai');
    return;
  }

  // 5) Cambiar horas del día visible
  if(intent.type==='change_hours'){
    const range = intent.range;
    const day = data.currentDay || 1;
    // actualiza perDay overrides
    if(!cityMeta[currentCity]) cityMeta[currentCity]={perDay:[]};
    let pd = cityMeta[currentCity].perDay.find(x=>x.day===day);
    if(!pd){ pd = {day, start:'', end:''}; cityMeta[currentCity].perDay.push(pd); }
    if(range.start) pd.start = range.start;
    if(range.end)   pd.end   = range.end;
    await optimizeDay(currentCity, day);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    chatMsg('Ajusté los horarios y optimicé tu día.','ai');
    return;
  }

  // 6) Agregar ciudad
  if(intent.type==='add_city'){
    const name = normalizeCityName(intent.name||'').trim();
    if(!name){ chatMsg('Necesito el nombre de la ciudad.','ai'); return; }
    const days = intent.days || 2; // por defecto 2 si no lo dijo
    addCityRow({city:name, days});
    saveDestinations();
    chatMsg(`Añadí <strong>${name}</strong>. Dime tu hotel/zona y transporte para generar el plan.`, 'ai');
    return;
  }

  // 7) Quitar ciudad
  if(intent.type==='remove_city'){
    const name = normalizeCityName(intent.name||'').trim();
    if(!name){ chatMsg('Necesito el nombre de la ciudad a quitar.','ai'); return; }
    // remove from savedDestinations
    savedDestinations = savedDestinations.filter(x=>x.city!==name);
    delete itineraries[name];
    delete cityMeta[name];
    renderCityTabs();
    chatMsg(`Eliminé <strong>${name}</strong> de tu itinerario.`, 'ai');
    return;
  }

  // 8) Info query
  if(intent.type==='info_query'){
    const infoPrompt = `
${FORMAT}
El usuario te pide información (no edites itinerario aún). Responde breve, cálido y útil.
Si crees que esta info afectaría el plan (clima/temporada/transporte), pregunta si desea actualizar.
{"followup":"mensaje breve para continuar"}
`.trim();
    const ans = await callAgent(infoPrompt + `\n\nConsulta: ${text}\n\nContexto:\n${buildIntake()}`, true);
    const parsed = parseJSON(ans);
    chatMsg(parsed?.followup || '¿Quieres que ajuste tu itinerario con esta información?','ai');
    return;
  }

  // 9) Edición libre → prompt de edición con días implicados (día visible por defecto)
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

// Construcción de prompt de edición
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
  showWOW(true);
  const ans = await callAgent(prompt, true);
  const parsed = parseJSON(ans);

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    applyParsedToState(parsed);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);

    // Chequeo imperdibles tras edición
    const auditPrompt = `
Devuelve SOLO JSON: {"missing":["..."]}.
Ciudad: ${city}
Basado en este snapshot después de la edición:
${getFrontendSnapshot()}
Lista imperdibles que falten aún (máx 5) considerando temporada; vacío si nada falta.
`.trim();
    const auditAns = await callAgent(auditPrompt, false);
    const audit = parseJSON(auditAns);
    const missing = Array.isArray(audit?.missing) ? audit.missing.filter(Boolean) : [];
    if(missing.length){
      chatMsg(`✨ Veo que aún no hemos incluido <strong>${missing.join(', ')}</strong>. ¿Quieres que los agregue ahora?`,'ai');
      pendingChange = { type:'imperdibles_add', city, missing };
    }else{
      chatMsg(tone.humanOk,'ai');
    }
  }else{
    chatMsg(parsed?.followup || 'No recibí cambios válidos. ¿Intentamos de nuevo?','ai');
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
    SECCIÓN 19 · Fuzzy Matching + Similitud
=================================== */
const KNOWN_CITIES = [
  'Reykjavik','Reikiavik','Reikjavik','Tromsø','Tromso','Paris','Madrid','Barcelona',
  'Luxor','Florence','Rome','Roma','Oslo','London','Saint Petersburg','San Petersburgo',
  'Rovaniemi','Abisko','Kiruna','Fairbanks','Yellowknife','Grindavik','Hveragerdi','Flúðir','Fludir','Selfoss','Milan','Milán','Segovia','Versalles','Montserrat','Girona','Sitges'
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
        matrix[i][j]=Math.min(
          matrix[i-1][j-1]+1,
          Math.min(matrix[i][j-1]+1,matrix[i-1][j]+1)
        );
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
    'tromso':'Tromsø','san petersburgo':'Saint Petersburg','roma':'Rome','milan':'Milán'
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
