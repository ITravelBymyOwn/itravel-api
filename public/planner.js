/* =========================================================
    ITRAVELBYMYOWN · PLANNER v31.1
    Base: v27 (se respetan secciones y estructura)
    Cambios relevantes desde v27→v31.1:
    - Botón "Guardar destinos" detecta diffs y alimenta al agente solo con cambios.
    - Flujo correcto: guardar → habilita iniciar; el chat pide hotel+transporte; loader solo al generar/ajustar.
    - Prompt instructivo para conversación natural y confirmación antes de tocar itinerarios.
    - Manejo de horarios parciales (completa defaults día a día).
    - Edición por chat reemplaza el día visible (no duplica filas).
    - Inserción de notas inspiradoras si faltan.
    - Excursiones 1 día (instrucciones al agente para proponer/optimizar).
    - Shift+Enter en el chat (no enviar).
    - Fallback de lugares genérico (sin listas por ciudad).
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
let session = [];             // historial contextual para ediciones conversacionales
let activeCity = null;
let planningStarted = false;
let metaProgressIndex = 0;
let collectingCityMeta = false;  // ahora recolecta hotel + transporte
let isItineraryLocked = false;

// Estado para detectar cambios del sidebar
let lastSavedSnapshot = null;   // JSON.stringify de lo guardado la última vez
let hasEverSaved = false;       // primera guardada vs subsiguientes

/* ================================
    SECCIÓN 2 · Tono / Mensajería
=================================== */
// Reemplazamos frases fijas por un prompt instructivo (el agente genera lenguaje natural).
const tone = {
  hi: '¡Bienvenido! 👋 Soy tu concierge de viajes personal. Te haré unas preguntas rápidas por ciudad (hotel/zona y medio de transporte preferido) y luego generaré itinerarios optimizados. ¡Comencemos!'
};

/* ================================
    SECCIÓN 3 · Referencias DOM
=================================== */
const $cityList = qs('#city-list');
const $addCity  = qs('#add-city-btn');
// (HTML v31.1 ya no incluye reset; hacemos guardia)
const $reset    = qs('#reset-planner');
const $save     = qs('#save-destinations');

const $start    = qs('#start-planning');
const $chatBox  = qs('#chat-container');
const $chatM    = qs('#chat-messages');
const $chatI    = qs('#chat-input');
const $send     = qs('#send-btn');

const $tabs     = qs('#city-tabs');
const $itWrap   = qs('#itinerary-container');

// Upsell & confirm
const $upsell     = qs('#monetization-upsell');
const $upsellClose = qs('#upsell-close');
const $confirmCTA  = qs('#confirm-itinerary');

// Loader overlay
const $loading = qs('#loading-overlay');

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
  div.innerHTML = (text||'').replace(/\n/g,'<br>');
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
    SECCIÓN 7 · Guardar destinos (differences)
=================================== */
function snapshotSidebar(){
  // Construye un snapshot limpio del sidebar para comparar cambios
  const rows = qsa('.city-row', $cityList);
  const cities = [];
  rows.forEach(r=>{
    const city     = qs('.city',r).value.trim();
    if(!city) return;
    const country  = qs('.country',r).value.trim();
    const daysVal  = qs('.days',r).value;
    const days     = Math.max(1, parseInt(daysVal||'0',10)||1);
    const baseDate = qs('.baseDate',r).value.trim();

    const perDay = [];
    qsa('.hours-day', r).forEach((hd, idx)=>{
      const start = qs('.start',hd).value || ''; // puede venir vacío (parcial)
      const end   = qs('.end',hd).value   || '';
      perDay.push({ day: idx+1, start, end });
    });

    cities.push({ city, country, days, baseDate, perDay });
  });

  const pax = {
    adults:   Number(qs('#p-adults')?.value||0),
    young:    Number(qs('#p-young')?.value||0),
    children: Number(qs('#p-children')?.value||0),
    infants:  Number(qs('#p-infants')?.value||0),
    seniors:  Number(qs('#p-seniors')?.value||0)
  };
  const specialConditions = (qs('#special-conditions')?.value||'').trim();
  const budgetVal = qs('#budget')?.value || '';
  const currencyVal = qs('#currency')?.value || 'USD';

  return {
    destinations: cities,
    pax,
    specialConditions,
    budget: budgetVal ? { amount: Number(budgetVal), currency: currencyVal } : null
  };
}

function computeDiff(prevSnap, nextSnap){
  // Detecta cambios entre snapshots (ciudades, días, fechas, horas por día, pax, presupuesto, etc.)
  const changes = { cities: [], added: [], removed: [], globals: [] };

  const mapPrev = new Map((prevSnap?.destinations||[]).map(d=>[d.city, d]));
  const mapNext = new Map((nextSnap.destinations||[]).map(d=>[d.city, d]));

  // Ciudades removidas y cambiadas
  (prevSnap?.destinations||[]).forEach(pd=>{
    const nd = mapNext.get(pd.city);
    if(!nd){
      changes.removed.push(pd.city);
      return;
    }
    // Compara atributos
    const diffs = [];
    if(pd.country !== nd.country) diffs.push({field:'country', from:pd.country, to:nd.country});
    if(pd.days !== nd.days)       diffs.push({field:'days', from:pd.days, to:nd.days});
    if(pd.baseDate !== nd.baseDate) diffs.push({field:'baseDate', from:pd.baseDate, to:nd.baseDate});

    // Horas por día (permite parciales, completa luego)
    const maxDays = Math.max(pd.days||0, nd.days||0);
    const perDayDiff = [];
    for(let i=1;i<=maxDays;i++){
      const p = (pd.perDay||[]).find(x=>x.day===i) || {day:i, start:'', end:''};
      const n = (nd.perDay||[]).find(x=>x.day===i) || {day:i, start:'', end:''};
      if((p.start||'')!==(n.start||'') || (p.end||'')!==(n.end||'')){
        perDayDiff.push({ day:i, from:{start:p.start||'',end:p.end||''}, to:{start:n.start||'',end:n.end||''} });
      }
    }
    if(diffs.length || perDayDiff.length){
      changes.cities.push({ city:pd.city, diffs, perDayDiff });
    }
  });

  // Ciudades nuevas
  (nextSnap.destinations||[]).forEach(nd=>{
    const pd = mapPrev.get(nd.city);
    if(!pd) changes.added.push(nd.city);
  });

  // Globals
  if(JSON.stringify(prevSnap?.pax||{}) !== JSON.stringify(nextSnap.pax||{})){
    changes.globals.push({ field:'pax', to: nextSnap.pax });
  }
  const prevBudget = prevSnap?.budget || null;
  const nextBudget = nextSnap?.budget || null;
  if(JSON.stringify(prevBudget) !== JSON.stringify(nextBudget)){
    changes.globals.push({ field:'budget', to: nextBudget });
  }
  if((prevSnap?.specialConditions||'') !== (nextSnap?.specialConditions||'')){
    changes.globals.push({ field:'specialConditions', to: nextSnap.specialConditions });
  }

  return changes;
}

function saveDestinations(){
  const snap = snapshotSidebar();

  // Normaliza perDay faltantes con defaults (08:30–19:00)
  snap.destinations = snap.destinations.map(d=>{
    const filled = Array.from({length:d.days}, (_,i)=>{
      const pd = (d.perDay||[]).find(x=>x.day===i+1) || {day:i+1,start:'',end:''};
      return { day:i+1, start: pd.start||'08:30', end: pd.end||'19:00' };
    });
    return { ...d, perDay: filled };
  });

  // Actualiza estados locales (savedDestinations, itineraries bases, cityMeta)
  savedDestinations = snap.destinations;
  savedDestinations.forEach(({city,days,baseDate,perDay})=>{
    if(!itineraries[city]) itineraries[city] = { byDay:{}, currentDay:1, baseDate: baseDate||null };
    if(!cityMeta[city]) cityMeta[city] = { baseDate: baseDate||null, start:null, end:null, hotel:'', transport:'', perDay: perDay||[] };
    else {
      cityMeta[city].baseDate = baseDate||null;
      cityMeta[city].perDay   = perDay||[];
    }
    for(let d=1; d<=days; d++){
      if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[];
    }
  });
  // Limpia ciudades removidas a nivel de estado
  Object.keys(itineraries).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete itineraries[c]; });
  Object.keys(cityMeta).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete cityMeta[c]; });

  renderCityTabs();
  // Habilita "Iniciar planificación" si hay al menos 1 destino
  $start.disabled = savedDestinations.length===0;

  // Detección de cambios vs último snapshot guardado
  const diff = lastSavedSnapshot ? computeDiff(lastSavedSnapshot, snap) : null;

  if(!hasEverSaved){
    // Primer guardado: solo preparamos; NO llamamos al agente aún.
    lastSavedSnapshot = snap;
    hasEverSaved = true;
    chatMsg('Datos guardados. Cuando quieras, presiona "Iniciar planificación".', 'ai');
    return;
  }

  // Guardado tras modificaciones
  lastSavedSnapshot = snap;

  // Si hay ciudades nuevas → entramos al flujo de preguntas solo para esas ciudades.
  if(diff && diff.added && diff.added.length){
    if(!$chatBox.style.display || $chatBox.style.display==='none'){
      $chatBox.style.display='flex';
    }
    planningStarted = true;
    collectingCityMeta = true;
    metaProgressIndex = 0;

    // reordena savedDestinations para iniciar preguntas desde las nuevas primero
    const nameSet = new Set(diff.added);
    const reordered = [
      ...savedDestinations.filter(d=>nameSet.has(d.city)),
      ...savedDestinations.filter(d=>!nameSet.has(d.city))
    ];
    savedDestinations = reordered;

    chatMsg('¡Perfecto! Veo nuevas ciudades. Te preguntaré hotel/zona y transporte para integrarlas al plan. 🧭', 'ai');
    askNextCityMeta();
    return;
  }

  // Si son cambios en ciudades existentes o globals → alimentar al agente para ajustes.
  if(diff && (diff.cities.length || diff.globals.length || diff.removed.length)){
    if(!$chatBox.style.display || $chatBox.style.display==='none'){
      $chatBox.style.display='flex';
    }
    applySidebarChangesViaAgent(diff);
  }else{
    chatMsg('Cambios guardados (sin impacto en itinerarios).', 'ai');
  }
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

  const budgetVal = qs('#budget')?.value || '';
  const currencyVal = qs('#currency')?.value || 'USD';
  const budget = budgetVal ? `${budgetVal} ${currencyVal}` : 'N/A';
  const specialConditions = (qs('#special-conditions')?.value||'').trim()||'N/A';

  // Completa perDay por ciudad (parciales → defaults)
  savedDestinations.forEach(dest=>{
    const days = dest.days||1;
    const perDay = Array.from({length:days}, (_,i)=>{
      const pd = dest.perDay?.find(x=>x.day===i+1) || {day:i+1, start:'', end:''};
      return { day:i+1, start: pd.start||'08:30', end: pd.end||'19:00' };
    });
    if(!cityMeta[dest.city]) cityMeta[dest.city]={};
    cityMeta[dest.city].perDay = perDay;
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
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto","transport":"Texto"},"followup":"Pregunta breve"}
Reglas:
- Incluye traslados con transporte y duración (+15% colchón).
- Usa horas por día si están disponibles; si faltan, asume 08:30–19:00.
- Máximo 20 filas de actividades por día.
- Nada de texto fuera del JSON.
`;

// Prompt instructivo global para estilo "ChatGPT" y decisiones
const BEHAVIOR = `
Eres el concierge IA de ITravelByMyOwn. Hablas en español, tono cálido, motivador y natural.
- Responde con variedad, evitando frases repetitivas.
- Si el usuario pide info (clima, ropa, recomendaciones, etc.) y no requiere cambios de itinerario, responde normalmente y luego pregunta:
  "¿Quieres que actualice tu itinerario con esto?"
- Si el usuario confirma, produce JSON según el contrato para los días/ciudades impactados.
- Si el usuario pide cambios (horarios, mover actividades, agregar días o excursiones 1 día), optimiza el día/los días implicados:
  * Mantén actividades salvo que pidan cambiarlas; reordena para aprovechar tiempo y recursos.
  * Si cambia hora de inicio o fin y solo recibes una de las dos, conserva la otra según la regla vigente.
  * Cuando se pida excursión 1 día (p.ej., Segovia desde Madrid), incluye varios puntos clave si el destino lo amerita; si es un único sitio (Versalles), genera actividad única con tiempos detallados.
- Considera temporada y clima cuando sea relevante a sugerencias.
- Antes de devolver JSON que modifique itinerario, incluye "replace": true para sobreescribir el día visible (evitar duplicados).
`;

/* ================================
    SECCIÓN 12 · Llamada al agente
=================================== */
async function callAgent(input, useHistory = true){
  const history = useHistory ? session : [];
  const payload = { model: MODEL, input, history };
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
    return `{"followup":"No pude contactar al asistente. Verifica configuración de API."}`;
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
    SECCIÓN 13 · Apply / Merge (MEJORADA)
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

// Inserta nota humana si no viene
const NOTE_POOL = [
  "✨ Disfruta cada rincón: ¡es un lugar que enamora!",
  "📸 Momento perfecto para fotos inolvidables.",
  "☕ Tómate un respiro y saborea lo local.",
  "🌿 Ritmo tranquilo para absorber la atmósfera.",
  "🚶‍♀️ Paseo ideal si el clima acompaña.",
  "🍽️ Excelente oportunidad para probar sabores típicos.",
  "🌇 Atento a la luz dorada cerca del atardecer."
];
function enrichNotes(row){
  if((row.notes||'').trim()) return row;
  const pick = NOTE_POOL[Math.floor(Math.random()*NOTE_POOL.length)];
  return { ...row, notes: pick };
}

// Normaliza una fila del agente a nuestro contrato
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

  return enrichNotes({
    day: d,
    start: start || '',
    end: end || '',
    activity: act || '',
    from: from || '',
    to: to || '',
    transport: trans || '',
    duration: duration || '',
    notes: notes || ''
  });
}

function pushRows(city, rows, replace=false){
  if(!city || !rows) return;
  if(!itineraries[city]) itineraries[city] = {byDay:{},currentDay:1,baseDate:cityMeta[city]?.baseDate||null};
  if(replace) itineraries[city].byDay = {};
  rows.forEach((raw)=>{
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
  if(!cityMeta[name]) cityMeta[name] = { baseDate:null, start:null, end:null, hotel:'', transport:'', perDay:[] };
  if(meta.baseDate) cityMeta[name].baseDate = meta.baseDate;
  if(meta.start)    cityMeta[name].start    = meta.start;
  if(meta.end)      cityMeta[name].end      = meta.end;
  if(typeof meta.hotel==='string') cityMeta[name].hotel = meta.hotel;
  if(typeof meta.transport==='string') cityMeta[name].transport = meta.transport;
  if(itineraries[name] && meta.baseDate) itineraries[name].baseDate = meta.baseDate;
}

function applyParsedToState(parsed, forceReplaceDay=null){
  if(!parsed) return;

  // Acepta envoltorios alternativos
  if(parsed.itinerary) parsed = parsed.itinerary;
  if(parsed.destinos)  parsed.destinations = parsed.destinos;
  if(parsed.destino && parsed.rows) parsed.destination = parsed.destino;

  if(parsed.meta) upsertCityMeta(parsed.meta);

  const wantsReplace = Boolean(parsed.replace);

  // 1) destinations: [{ name|destination, rows|rowsByDay }]
  if(Array.isArray(parsed.destinations)){
    parsed.destinations.forEach(d=>{
      const name = d.name || d.destination || d.meta?.city || activeCity || savedDestinations[0]?.city;
      if(!name) return;

      if(d.rowsByDay && typeof d.rowsByDay === 'object'){
        Object.entries(d.rowsByDay).forEach(([k,rows])=>{
          const mapped = (rows||[]).map(r=>normalizeRow({...r, day:+k}, +k));
          if(wantsReplace || forceReplaceDay) {
            // reemplazo por día si corresponde
            itineraries[name] = itineraries[name] || {byDay:{},currentDay:1,baseDate:cityMeta[name]?.baseDate||null};
            itineraries[name].byDay[+k] = [];
          }
          pushRows(name, mapped, false);
        });
        return;
      }

      if(Array.isArray(d.rows)){
        const mapped = d.rows.map(r=>normalizeRow(r, 1));
        if(forceReplaceDay){
          // Reemplaza solo el día visible
          const dnum = itineraries[name]?.currentDay || 1;
          itineraries[name] = itineraries[name] || {byDay:{},currentDay:dnum,baseDate:cityMeta[name]?.baseDate||null};
          itineraries[name].byDay[dnum] = [];
          pushRows(name, mapped.map(r=>({...r, day:dnum})), false);
        }else{
          pushRows(name, mapped, Boolean(d.replace));
        }
      }
    });
    return;
  }

  // 2) destination + rows
  if(parsed.destination && Array.isArray(parsed.rows)){
    const name = parsed.destination;
    const mapped = parsed.rows.map((r)=>normalizeRow(r, 1));
    if(forceReplaceDay){
      const dnum = itineraries[name]?.currentDay || 1;
      itineraries[name] = itineraries[name] || {byDay:{},currentDay:dnum,baseDate:cityMeta[name]?.baseDate||null};
      itineraries[name].byDay[dnum] = [];
      pushRows(name, mapped.map(r=>({...r, day:dnum})), false);
    }else{
      pushRows(name, mapped, Boolean(parsed.replace));
    }
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
          if(wantsReplace || forceReplaceDay) {
            itineraries[name] = itineraries[name] || {byDay:{},currentDay:1,baseDate:cityMeta[name]?.baseDate||null};
            itineraries[name].byDay[+k] = [];
          }
          pushRows(name, mapped, false);
        });
      }else if(Array.isArray(x.rows)){
        const mapped = x.rows.map(r=>normalizeRow(r, 1));
        if(forceReplaceDay){
          const dnum = itineraries[name]?.currentDay || 1;
          itineraries[name] = itineraries[name] || {byDay:{},currentDay:dnum,baseDate:cityMeta[name]?.baseDate||null};
          itineraries[name].byDay[dnum] = [];
          pushRows(name, mapped.map(r=>({...r, day:dnum})), false);
        }else{
          pushRows(name, mapped, Boolean(x.replace));
        }
      }
    });
    return;
  }

  // 4) rows solo -> sobre ciudad activa
  if(Array.isArray(parsed.rows)){
    const city = activeCity || savedDestinations[0]?.city;
    const mapped = parsed.rows.map(r=>normalizeRow(r, 1));
    if(forceReplaceDay){
      const dnum = itineraries[city]?.currentDay || 1;
      itineraries[city] = itineraries[city] || {byDay:{},currentDay:dnum,baseDate:cityMeta[city]?.baseDate||null};
      itineraries[city].byDay[dnum] = [];
      pushRows(city, mapped.map(r=>({...r, day:dnum})), false);
    }else{
      pushRows(city, mapped, Boolean(parsed.replace));
    }
  }
}

/* ================================
    SECCIÓN 14 · Fallback local inteligente (GENÉRICO)
=================================== */
const LANDMARKS = {
  _generic: [
    'Casco histórico','Catedral/Basílica','Museo principal','Mercado central',
    'Mirador/colina','Parque urbano','Barrio emblemático','Plaza principal',
    'Museo alternativo','Café/pastelería típica','Cena recomendada'
  ]
};
function getLandmarksFor(city){
  return LANDMARKS._generic;
}
function addMinutes(hhmm, min){
  const [H,M] = (hhmm||'08:30').split(':').map(n=>parseInt(n||'0',10));
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
    rows.push(enrichNotes({
      day:1, start:s, end:e, activity:b.label,
      from: i===0?'Hotel/Zona':'', to:'', transport,
      duration: (b.dur+'m'), notes:''
    }));
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
function showLoader(on=true){
  if(!$loading) return;
  $loading.style.display = on ? 'flex' : 'none';
  document.body.style.pointerEvents = on ? 'none':'auto';
}
async function generateCityItinerary(city){
  const dest  = savedDestinations.find(x=>x.city===city);
  if(!dest) return;

  const perDay = (cityMeta[city]?.perDay && cityMeta[city].perDay.length)
    ? cityMeta[city].perDay
    : Array.from({length:dest.days}, (_,i)=>({day:i+1,start:'08:30',end:'19:00'}));

  const baseDate = cityMeta[city]?.baseDate || dest.baseDate || '';
  const hotel    = cityMeta[city]?.hotel || '';
  const transport = cityMeta[city]?.transport || '';

  const instructions = `
${BEHAVIOR}
${FORMAT}
**Genera SOLO el itinerario para "${city}" (${dest.days} día/s) en formato B con "destination":"${city}", "rows" y "replace":true.**
- Usa las horas por día (start/end) provistas; donde falten, asume 08:30–19:00.
- Optimiza tiempos y orden. Incluye transporte y duración.
- Si se detecta oportunidad de excursión 1 día (según contexto), proponla dentro del plan del día adecuado.

Datos de Viaje:
- Ciudad: "${city}"
- Días totales: ${dest.days}
- Horas por día (start/end): ${JSON.stringify(perDay)}
- BaseDate (día 1): ${baseDate||'N/A'}
- Hotel/Zona de base: ${hotel||'pendiente'}
- Transporte preferido: ${transport||'pendiente'}

Contexto del viaje (referencia):
${buildIntake()}
`.trim();

  let text = await callAgent(instructions, false); // sin historial para generación completa por ciudad
  let parsed = parseJSON(text);

  if(!parsed || (!parsed.rows && !parsed.destinations && !parsed.itineraries)){
    const strict = `
${BEHAVIOR}
${FORMAT}
**REINTENTO:** Genera SOLO el itinerario para "${city}" (${dest.days} días) en formato B con "destination":"${city}", "rows" y "replace":true.
Ignora 'meta'. El JSON debe contener un array "rows" utilizable.
`.trim();
    text = await callAgent(strict, false);
    parsed = parseJSON(text);
  }

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    applyParsedToState(parsed, /*forceReplaceDay*/ null);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    return;
  }

  // Fallback local
  const rowsByDay = synthesizeLocalItinerary(city, dest.days, perDay);
  const rowsFlat = Object.entries(rowsByDay).flatMap(([d,rows])=>rows.map(r=>({...r, day:+d})));
  pushRows(city, rowsFlat, true);
  renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
  chatMsg('⚠️ No recibí un JSON válido. Generé un itinerario base para seguir trabajando.', 'ai');
}

/* ================================
    SECCIÓN 16 · Flujo principal · City Meta (Hotel + Transporte)
=================================== */
async function startPlanning(){
  if(savedDestinations.length===0) return;
  $chatBox.style.display='flex';
  planningStarted = true;
  collectingCityMeta = true;
  metaProgressIndex = 0;

  session = []; // historial para edición posterior
  chatMsg(`${tone.hi}`);

  askNextCityMeta();
}
function askNextCityMeta(){
  if(metaProgressIndex >= savedDestinations.length){
    collectingCityMeta = false;
    chatMsg('✨ ¡Perfecto! Ya tengo hotel/zona y transporte para todas las ciudades. Comienzo a generar tus itinerarios optimizados.', 'ai');
    (async ()=>{
      showLoader(true);
      for(const {city} of savedDestinations){
        await generateCityItinerary(city);
      }
      showLoader(false);
      chatMsg('🎉 Todos los itinerarios fueron generados. ¿Quieres revisarlos o ajustar alguno?', 'ai');
    })();
    return;
  }
  const city = savedDestinations[metaProgressIndex].city;
  setActiveCity(city); renderCityItinerary(city);

  const msg = `
Para <strong>${city}</strong>, cuéntame por favor:
1) <b>Hotel o zona base</b> (nombre, dirección o enlace).
2) <b>Medio de transporte</b> (alquiler, público, taxi/uber, combinación, o “recomiéndame”).
`.trim();
  chatMsg(msg,'ai');
}

/* ================================
    SECCIÓN 17 · Chat handler (edición natural + confirmación)
=================================== */
function buildChangePromptFromDiff(diff){
  // Resume los cambios en lenguaje para el agente
  const parts = [];
  if(diff.added.length) parts.push(`Ciudades nuevas: ${diff.added.join(', ')}`);
  if(diff.removed.length) parts.push(`Ciudades removidas: ${diff.removed.join(', ')}`);
  diff.cities.forEach(c=>{
    const d1 = c.diffs.map(d=>`${d.field}: ${d.from||'—'} → ${d.to||'—'}`).join(' | ');
    const d2 = c.perDayDiff.map(p=>`Día ${p.day} horas: ${p.from.start||'08:30'}–${p.from.end||'19:00'} → ${p.to.start||'(def)'}–${p.to.end||'(def)'}`).join(' | ');
    const b = [d1,d2].filter(Boolean).join(' || ');
    parts.push(`${c.city}: ${b}`);
  });
  diff.globals.forEach(g=>{
    parts.push(`Global ${g.field}: ${JSON.stringify(g.to)}`);
  });
  return parts.join('\n');
}

async function applySidebarChangesViaAgent(diff){
  const summary = buildChangePromptFromDiff(diff);
  const impactedCities = new Set([
    ...diff.cities.map(c=>c.city),
    ...diff.added,
    ...diff.removed
  ]);
  // Si hay ciudades removidas, simplemente las quitamos del estado (ya hecho antes).
  if(diff.removed.length){
    chatMsg(`Se removieron: ${diff.removed.join(', ')}.`, 'ai');
  }

  const prompt = `
${BEHAVIOR}
${FORMAT}
El usuario actualizó datos desde el panel lateral. Aplica SOLO los cambios necesarios.

Cambios detectados:
${summary}

Contexto (importante):
${buildIntake()}

Instrucciones:
- Si solo cambian horas de un día, ajusta SOLO ese día y devuelve "replace":true.
- Si aumentan días de una ciudad (p.ej., +1 día en Madrid), añade un día y sugiere excursión 1 día si es razonable (p.ej., Segovia/Toledo).
- Si hay ciudades nuevas, espera a tener hotel/transporte para ellas (se preguntará aparte).
- Devuelve formato B o A/C con "replace":true cuando modifiques el día visible.
`.trim();

  showLoader(true);
  const ans = await callAgent(prompt); // con historial actual
  showLoader(false);

  const parsed = parseJSON(ans);
  if(parsed?.followup) session.push({role: 'assistant', content: parsed.followup});

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    // Forzamos reemplazar el día visible cuando venga de cambios puntuales
    applyParsedToState(parsed, /*forceReplaceDay*/ true);
    renderCityTabs(); renderCityItinerary(activeCity);
    chatMsg(parsed.followup || 'Listo. Ajusté lo necesario en tu itinerario.', 'ai');
  }else{
    // Puede ser una respuesta textual (p.ej., explicación). Muestra y pregunta por confirmación si aplica.
    chatMsg((parsed?.followup)||'He registrado tus cambios. Si quieres, dime qué parte del itinerario deseas actualizar.', 'ai');
  }
}

async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  // Shift+Enter para saltos de línea (gestión en keydown abajo)

  // 1) Recolección de hotel + transporte
  if(collectingCityMeta){
    const city = savedDestinations[metaProgressIndex].city;
    // Guardamos tal cual (el agente tendrá libertad semántica)
    // Heurística simple: si el texto contiene palabras de transporte, lo asignamos también.
    upsertCityMeta({ city, hotel: text });
    if(!/alquiler|rent|públic|metro|bus|tren|taxi|uber|cabify|combinación|combination|recomiéndame/i.test(text)){
      chatMsg('¿Qué medio de transporte usarás (alquiler, público, taxi/uber, combinación) o prefieres que te recomiende?', 'ai');
      // Esperamos siguiente input
      collectingCityMeta = 'await-transport';
      return;
    }else{
      // Intenta extraer transporte simple
      const m = text.toLowerCase();
      let transport = 'recomiéndame';
      if(/alquiler|rent/i.test(m)) transport = 'alquiler';
      else if(/públic|metro|bus|tren/i.test(m)) transport = 'público';
      else if(/taxi|uber|cabify/i.test(m)) transport = 'taxi/uber';
      else if(/combinación|combination/i.test(m)) transport = 'combinación';
      upsertCityMeta({ city, transport });
    }
    chatMsg(`¡Perfecto! Hotel/zona y transporte registrados para ${city}.`, 'ai');
    metaProgressIndex++;
    collectingCityMeta = true;
    askNextCityMeta();
    return;
  }
  if(collectingCityMeta==='await-transport'){
    const city = savedDestinations[metaProgressIndex].city;
    let transport = (text||'').toLowerCase();
    if(/alquiler|rent/i.test(transport)) transport = 'alquiler';
    else if(/públic|metro|bus|tren/i.test(transport)) transport = 'público';
    else if(/taxi|uber|cabify/i.test(transport)) transport = 'taxi/uber';
    else if(/combinación|combination/i.test(transport)) transport = 'combinación';
    else transport = 'recomiéndame';
    upsertCityMeta({ city, transport });
    chatMsg(`¡Listo! Transporte registrado para ${city}.`, 'ai');
    metaProgressIndex++;
    collectingCityMeta = true;
    askNextCityMeta();
    return;
  }

  // 2) Conversación libre / Edición de itinerario
  const currentCity = activeCity || savedDestinations[0]?.city;
  const data = currentCity ? itineraries[currentCity] : null;

  // Conversación sin tocar itinerario (clima, recomendaciones, etc.)
  // Estrategia: solicitamos al agente que responda en texto humano y SOLO si el usuario acepta, generamos JSON.
  const day = data?.currentDay || 1;
  const dayRows = data ? ((data.byDay[day]||[]).map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)') : '';
  const allDays = data ? (Object.keys(data.byDay).map(n=>{
    const rows = data.byDay[n]||[];
    return `Día ${n}:\n${rows.map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)'}`;
  }).join('\n\n')) : '';

  session.push({role: 'user', content: text});

  const prompt = `
${BEHAVIOR}
${FORMAT}

Contexto de viaje:
${buildIntake()}

Vista actual del usuario:
- Ciudad en pantalla: "${currentCity||'N/A'}", Día ${day}
- Actividades del día actual: 
${dayRows}

Resumen de otros días (solo referencia):
${allDays}

Instrucción:
1) Si el mensaje del usuario es INFORMATIVO/CONSULTA (clima, sugerencias, etc.), responde SOLO en texto natural (sin JSON) y al final pregunta si desea actualizar el itinerario con eso.
2) Si el mensaje implica CAMBIO (p.ej., "agrega un día", "mueve X a día 3", "cambia inicio a las 10"), devuelve JSON en formato B con "destination":"${currentCity||''}", "rows":[...] y "replace":true, tocando SOLO el día visible u otros días explícitamente mencionados. Respeta la regla: si cambia solo inicio, conserva fin previo; si cambia solo fin, conserva inicio previo.
3) Para excursiones 1 día (p.ej., Segovia desde Madrid) agrega el nuevo día con itinerario de múltiples puntos si corresponde; si es un único sitio (Versalles), una actividad principal detallada.

Mensaje del usuario:
${text}
`.trim();

  showLoader(true);
  const ans = await callAgent(prompt); // con historial
  showLoader(false);

  const parsed = parseJSON(ans);

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    // Edición: reemplazar día visible para evitar duplicados
    applyParsedToState(parsed, /*forceReplaceDay*/ true);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    chatMsg(parsed.followup || '¡Ajustado! ¿Quieres seguir puliendo algún detalle?', 'ai');
    return;
  }

  // Si no es JSON válido, lo tratamos como respuesta conversacional
  const textAnswer = ans && typeof ans === 'string' ? ans : (parsed?.followup||'');
  if(textAnswer) chatMsg(textAnswer, 'ai');
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

$addCity?.addEventListener('click', ()=>addCityRow());
// (reset ya no existe; guardia)
$reset?.addEventListener('click', ()=>{
  $cityList.innerHTML=''; savedDestinations=[]; itineraries={}; cityMeta={};
  addCityRow();
  $start.disabled = true;
  $tabs.innerHTML=''; $itWrap.innerHTML='';
  $chatBox.style.display='none'; $chatM.innerHTML='';
  session = [];
  hasEverSaved = false; lastSavedSnapshot = null;
});
$save?.addEventListener('click', saveDestinations);
$start?.addEventListener('click', startPlanning);
$send?.addEventListener('click', onSend);

// Shift+Enter para salto de línea; Enter para enviar
$chatI?.addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    onSend();
  }
});

// CTA “Elijo este itinerario”
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
