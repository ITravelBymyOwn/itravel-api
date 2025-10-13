/* =========================================================
    ITRAVELBYMYOWN · PLANNER v31
    Base: v30
    Cambios v31:
    - Unificación de flujo: el botón "Guardar destinos" detecta cambios y
      dispara ajustes con el agente (sin botón Recalcular). Si hay ciudad nueva,
      activa preguntas (hotel + transporte + intereses) solo para esa ciudad.
    - Conversación natural: si la pregunta es informativa (p. ej. clima) y
      toca aspectos del itinerario, el agente responde y luego pregunta
      si quieres actualizar el itinerario; si dices "sí", aplica cambios.
    - Notas inspiradoras: se agregan notas humanas/motivadoras en filas
      vacías o genéricas (sin hacerlas enormes).
    - Se mantiene NLU de horas y movimientos entre días + reoptimización.
    - Sin cambios en HTML/CSS (respetamos tu v29/v30).
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

// (v31) Deltas y control de cambios
let hasSavedOnce = false;
let previousSavedDestinations = []; // snapshot anterior
const changedCities = new Set();
let globalChanged = false;

// (v31) consentimiento para aplicar cambios desde charla informativa
let pendingUpdateConsent = null; // { city, dayOrNull, textOriginal }

/* ================================
    SECCIÓN 2 · Tono / Mensajería
=================================== */
const tone = {
  es: {
    hi: '¡Bienvenido! 👋 Soy tu concierge de viajes personal. Te guiaré ciudad por ciudad.',
    askHotelTransport: (city)=>`¿En qué <strong>hotel/zona</strong> te hospedarás en <strong>${city}</strong> y qué <strong>medio de transporte</strong> usarás? Opciones: <em>Vehículo alquilado</em> · <em>Transporte público (metro/tren/bus)</em> · <em>Otros (Uber/Taxi)</em> · <em>Combinado</em> · <em>Recomiéndame</em>.<br><small style="display:block;color:#667085;margin-top:.25rem">Puedes responder en lenguaje natural, por ejemplo: “Hotel X en el centro y recomiéndame el transporte”.</small>`,
    askInterestsIntro: (city, picks)=>`En <strong>${city}</strong> detecté actividades o excursiones populares: ${picks.join(' · ')}. ¿Quieres incluir alguna? Escríbeme nombres (ej. <em>${picks.slice(0,3).join(', ')}</em>) o di “no gracias”.`,
    confirmAll: '✨ ¡Excelente! Con esto construiré tus itinerarios optimizados. ',
    doneAll: '🎉 ¡Listo! Itinerarios generados. ¿Quieres ajustarlos o añadir algo especial?',
    fail: '⚠️ No se pudo contactar con el asistente. Revisa la consola y la configuración de Vercel (API Key, URL).',
    askApplyChanges: '¡Qué buena idea! Esta info podría mejorar tu itinerario ✨ ¿Quieres que lo actualice ahora?',
    applied: 'Perfecto 🙌 Ajusté tu itinerario para que aproveches mejor el tiempo.',
    declined: '¡Genial! Mantengo el itinerario como está. Si luego quieres actualizarlo, me dices y lo optimizo. 😄'
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

const $overlayWOW  = qs('#loading-overlay');  // Overlay
// FAB podría existir de versiones previas, pero en v31 no lo usamos proactivamente
const $recalcFab   = qs('#recalc-fab');

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
    if(hasSavedOnce){
      const c = qs('.city',row).value.trim();
      if(c) changedCities.add(c);
    }
  });

  qs('.remove',row).addEventListener('click', ()=>{
    row.remove();
    if(hasSavedOnce){
      const c = qs('.city',row)?.value?.trim();
      if(c) changedCities.add(c);
    }
  });

  row.addEventListener('input', ()=>{
    if(hasSavedOnce){
      const c = qs('.city',row).value.trim();
      if(c) changedCities.add(c);
    }
  });

  $cityList.appendChild(row);
}

/* ================================
    SECCIÓN 7 · Guardar destinos (v31: detecta deltas y actúa)
=================================== */
function shallowCloneSaved(list){
  return list.map(x=>({
    city:x.city, country:x.country, days:x.days, baseDate:x.baseDate,
    perDay:(x.perDay||[]).map(p=>({day:p.day,start:p.start,end:p.end}))
  }));
}

function computeDeltas(oldL, newL){
  const oldMap = new Map(oldL.map(o=>[o.city,o]));
  const newMap = new Map(newL.map(n=>[n.city,n]));
  const added = [];
  const removed = [];
  const changed = [];
  for(const [city, o] of oldMap){
    if(!newMap.has(city)){ removed.push(city); continue; }
    const n = newMap.get(city);
    let dif = (o.country!==n.country) || (o.days!==n.days) || (o.baseDate!==n.baseDate);
    if(!dif){
      const oP = JSON.stringify(o.perDay||[]);
      const nP = JSON.stringify(n.perDay||[]);
      dif = (oP!==nP);
    }
    if(dif) changed.push(city);
  }
  for(const [city, n] of newMap){
    if(!oldMap.has(city)) added.push(city);
  }
  return {added, removed, changed};
}

function saveDestinations(){
  // leer UI
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

  const newSnapshot = list;
  const prevSnapshot = shallowCloneSaved(savedDestinations.length? savedDestinations : previousSavedDestinations);

  // actualiza estructuras base
  savedDestinations = newSnapshot;
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

  // si es la primera vez, solo preparar y salir
  if(!hasSavedOnce){
    hasSavedOnce = true;
    previousSavedDestinations = shallowCloneSaved(savedDestinations);
    changedCities.clear();
    globalChanged = false;
    return;
  }

  // v31: usar el mismo botón para ajustes
  const {added, removed, changed} = computeDeltas(prevSnapshot, newSnapshot);

  // removed: por ahora solo actualizar estado, sin agente (si lo deseas, podríamos pedir confirmación para re-balancear)
  if(removed.length){
    removed.forEach(c=>{
      delete itineraries[c];
      delete cityMeta[c];
    });
  }

  // added: flujo de preguntas solo para nuevas ciudades
  if(added.length){
    chatMsg(`Detecté nuevas ciudades: <strong>${added.join(', ')}</strong>. ¡Vamos a configurarlas! 🌍`, 'ai');
    planningStarted = true;
    collectingHotels = true;
    collectingInterests = false;
    metaProgressIndex = 0;

    // Re-ordena savedDestinations para que metaProgressIndex recorra solo added primero
    savedDestinations = [
      ...savedDestinations.filter(x=>added.includes(x.city)),
      ...savedDestinations.filter(x=>!added.includes(x.city))
    ];
    session = [];
    askNextHotelTransport();
    previousSavedDestinations = shallowCloneSaved(savedDestinations);
    return;
  }

  // changed: actualizar directamente las ciudades afectadas
  if(changed.length || globalChanged || changedCities.size){
    const targets = [...new Set([ ...changed, ...Array.from(changedCities) ])];
    chatMsg(`¡Genial! Guardé tus cambios. Ajustaré: <strong>${targets.join(', ') || 'todos'}</strong>. ✨`, 'ai');
    (async ()=>{
      showWOW(true);
      const list = targets.length ? targets : savedDestinations.map(d=>d.city);
      for(const city of list){
        await generateCityItinerary(city);
      }
      showWOW(false);
      chatMsg('¡Listo! Itinerarios actualizados y optimizados. 🙌', 'ai');
    })();
    changedCities.clear(); globalChanged=false;
    previousSavedDestinations = shallowCloneSaved(savedDestinations);
    return;
  }

  // sin cambios detectados
  chatMsg('No vi cambios nuevos que aplicar. Si quieres, dime qué ciudad o día deseas ajustar 💡', 'ai');
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
    SECCIÓN 13 · Apply / Merge (+ notas inspiradoras)
=================================== */
const INSPIRATION_NOTES = [
  'Momento perfecto para fotos inolvidables 📸',
  'Disfruta el ritmo local y saborea el momento ✨',
  'Un plan que te va a encantar — ¡wow! 😍',
  'Ideal para una pausa deliciosa ☕',
  'Aquí se sienten de verdad la historia y el encanto del lugar',
  'La vista te robará un suspiro 🌅',
  'Un clásico imperdible para recordar siempre',
  'Perfecto para recargar energías y seguir explorando 💪',
];

function pickNote(){
  return INSPIRATION_NOTES[Math.floor(Math.random()*INSPIRATION_NOTES.length)];
}

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
  let notes   = r.notes ?? r.nota ?? r.comentarios ?? '';
  const duration = (typeof durRaw === 'number') ? `${durRaw}m` : (String(durRaw)||'');
  const d = Math.max(1, parseInt(r.day ?? r.dia ?? fallbackDay, 10) || 1);

  // notas inspiradoras si vienen vacías o muy genéricas
  if(!notes || /^\s*(itinerario base|auto\-generado|entrada necesaria).*$/i.test(notes)){
    notes = pickNote();
  }

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
        activity:'Exploración por la zona',
        from:'Hotel/Zona', to:'Recorrido',
        transport:'A pie', duration:'120m', notes: pickNote()
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
    rows.push({
      day:1, start:s, end:e, activity:b.label,
      from: i===0?'Hotel/Zona':'', to:'', transport,
      duration: (b.dur+'m'), notes: pickNote()
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
  if(dayTrips && days>=3) picks.push(`Excursión de 1 día: ${dayTrips.slice(0,3).join(' / ')}`);
  if(!picks.length) picks.push('Imperdibles locales y experiencias gastronómicas');
  return picks;
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
  const dayTripHint = DAYTRIP_SUGGEST[city] ? `Si hay espacio y el viajero lo desea, sugiere excursiones de 1 día cercanas: ${DAYTRIP_SUGGEST[city].join(', ')}.` : '';

  const instructions = `
${FORMAT}
**INSTRUCCIÓN CRÍTICA: Eres el planificador de ITravelByMyOwn.**
Genera el itinerario completo SOLO para "${city}" para ${dest.days} día(s), optimizando tiempos/recursos.
- Usa el formato B con "destination":"${city}" y el array "rows"; incluye "replace": true.
- No dupliques actividades; conserva lo existente salvo que debas optimizar o mejorar.
- Respeta horas por día (si faltan, usa 08:30–19:00). Reparte actividades de forma realista.

Datos de Viaje:
- Ciudad: "${city}"
- Días totales: ${dest.days}
- Horas por día (start/end): ${JSON.stringify(perDay)}
- BaseDate (día 1): ${baseDate||'N/A'}
- Hotel/Zona base: ${hotel||'pendiente'}
- Transporte: ${transport}
- Intereses explícitos del usuario: ${JSON.stringify(interests)}

Consideraciones:
- ${auroraHint}
- ${hotspringHint}
- ${dayTripHint}

Contexto (solo referencia):
${buildIntake()}
`.trim();

  let text = await callAgent(instructions, false); // sin historial
  let parsed = parseJSON(text);

  if(!parsed || (!parsed.rows && !parsed.destinations && !parsed.itineraries)){
    const strict = `
${FORMAT}
**REINTENTO:** Genera **SOLO** el itinerario para "${city}" (${dest.days} días) en formato B o en destinations[] con "replace": true.
Ignora 'meta'. El JSON debe contener un array "rows" utilizable.
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
  chatMsg('⚠️ Fallo crítico del asistente. Generé una propuesta base por día para que puedas seguir trabajando manualmente. Revisa tu configuración de Vercel.', 'ai');
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

  session = [];
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
    SECCIÓN 17 · Chat handler (NLU + conversación natural)
=================================== */
// Normaliza horas (9, 9am, 9:30, 21, etc.)
function normalizeHourToken(tok){
  tok = tok.toLowerCase().trim();
  const mapWords = { 'mediodía':'12:00', 'medianoche':'00:00' };
  if(mapWords[tok]) return mapWords[tok];
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
function isAffirmative(text){
  return /\b(s[ií]|claro|adelante|ok|de una|sí, hazlo|perfecto)\b/i.test(text);
}
function isNegative(text){
  return /\b(no|luego|despu[eé]s|por ahora no)\b/i.test(text);
}

async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  // 0) ¿Tenemos una confirmación pendiente para actualizar?
  if(pendingUpdateConsent){
    if(isAffirmative(text)){
      // vuelve a ejecutar edición usando el texto original que detona cambios
      const original = pendingUpdateConsent.textOriginal;
      pendingUpdateConsent = null;
      await runEditOnVisibleDay(original);
      return;
    }else if(isNegative(text)){
      pendingUpdateConsent = null;
      chatMsg(tone.declined,'ai');
      return;
    }
    // si respondió algo distinto, atendemos normalmente abajo
  }

  // 1) recolección hotel + transporte
  if(collectingHotels){
    const city = savedDestinations[metaProgressIndex].city;
    const hotel = extractHotelFromText(text) || text;
    const transport = parseTransportFromText(text) || cityMeta[city]?.transport || '';
    upsertCityMeta({ city, hotel, transport });
    chatMsg(`¡Perfecto! Registré hotel/zona y transporte para ${city}: <em>${hotel || 'pendiente'}</em> · <em>${transport || 'pendiente/recomendaré'}</em>.`, 'ai');
    metaProgressIndex++;
    askNextHotelTransport();
    return;
  }

  // 2) recolección de intereses
  if(collectingInterests){
    const city = savedDestinations[metaProgressIndex].city;
    const picks = text.toLowerCase().includes('no') && !text.toLowerCase().includes('sí') && !text.toLowerCase().includes('si')
      ? []
      : text.split(/[,\n;·•]/).map(s=>s.trim()).filter(Boolean);
    if(picks.length) upsertCityMeta({city, interests: picks});
    else upsertCityMeta({city, interests: []});
    chatMsg(`Anotado para ${city}: ${picks.length? picks.join(' · ') : 'sin actividades extra por ahora'}.`, 'ai');
    metaProgressIndex++;
    askNextInterests();
    return;
  }

  // 3) conversación y/o edición
  // Si el texto es informativo (clima, recomendaciones) pero menciona conceptos de itinerario,
  // primero respondemos y luego preguntamos si desea aplicar.
  const touchesItinerary = /(hora|inicio|fin|d[ií]a\s*\d+|mueve|pasa|agrega|quita|transporte|actividad|itinerario)/i.test(text);
  if(!touchesItinerary){
    // Informativo puro: dejamos al modelo contestar sin tocar itinerario
    const infoPrompt = `
Eres un concierge de viajes cálido y motivador. Responde de forma útil, breve y concreta.
No cambies itinerarios. Si la respuesta puede influir en el plan (por ejemplo, clima, distancias, entradas),
al final sugiere: "${tone.askApplyChanges}"
Contexto del viaje:
${buildIntake()}
Usuario: ${text}
`.trim();
    const ans = await callAgent(infoPrompt);
    const parsed = parseJSON(ans);
    if(parsed?.followup){
      chatMsg(parsed.followup,'ai');
    }else{
      chatMsg(ans || '¡Listo! ¿Quieres que con esto actualice tu itinerario?', 'ai');
    }
    // dejamos registrada confirmación pendiente si creemos que aplica
    pendingUpdateConsent = { city: activeCity || savedDestinations[0]?.city || null, dayOrNull: null, textOriginal: text };
    return;
  }

  // Si toca itinerario, ejecutamos edición de inmediato
  await runEditOnVisibleDay(text);
}

async function runEditOnVisibleDay(text){
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

  const range = parseTimeRangeFromText(text);
  const startOverride = range.start || null;
  const endOverride   = range.end   || null;

  let moveInstr = null;
  const mv = text.toLowerCase().match(/(?:mueve|pasa|cambia).+?d[ií]a\s*(\d+)\s*(?:al|a)\s*d[ií]a\s*(\d+)/i);
  if(mv){ moveInstr = {from: parseInt(mv[1],10), to: parseInt(mv[2],10)}; }

  const cityPerDay = (cityMeta[currentCity]?.perDay||[]).map(pd=>({day:pd.day, start:pd.start||DEFAULT_START, end:pd.end||DEFAULT_END}));
  if(startOverride || endOverride){
    const idx = day-1;
    if(cityPerDay[idx]){
      if(startOverride) cityPerDay[idx].start = startOverride;
      if(endOverride)   cityPerDay[idx].end   = endOverride;
    }
  }

  const hardDirectives = [];
  if(startOverride) hardDirectives.push(`For Day ${day}, START=${startOverride} (keep END as currently defined unless overridden).`);
  if(endOverride)   hardDirectives.push(`For Day ${day}, END=${endOverride} (keep START as currently defined unless overridden).`);
  if(moveInstr)     hardDirectives.push(`Move requested activities from Day ${moveInstr.from} to Day ${moveInstr.to}. Re-optimize both days without duplicates.`);

  const transport = cityMeta[currentCity]?.transport || 'recomiéndame';
  const interests = cityMeta[currentCity]?.interests || [];

  const prompt = `
${FORMAT}
**Contexto Completo del Viaje:**
${buildIntake()}

**Edición solicitada para "${currentCity}"**
- Día visible del usuario: ${day}
- Actividades del día actual: ${dayRows}
- Resumen de otros días (referencia): ${allDays}

**Directivas Duras:**
- Optimiza el/los día(s) afectado(s) (max. 20 filas) respetando proximidad/tiempos.
- No dupliques; conserva lo existente salvo indicación explícita.
${hardDirectives.map(x=>`- ${x}`).join('\n')}

**Ventanas por día (con posibles overrides):** ${JSON.stringify(cityPerDay)}
**Hotel/Zona:** ${cityMeta[currentCity]?.hotel || 'pendiente'}
**Transporte:** ${transport}
**Intereses usuario:** ${JSON.stringify(interests)}

**Salida requerida:**
- Devuelve formato B {"destination":"${currentCity}","rows":[...],"replace": true} con las filas finales SOLO del/los día(s) afectado(s).
**Solicitud del usuario (texto crudo):** ${text}
`.trim();

  showWOW(true);
  const ans = await callAgent(prompt);
  const parsed = parseJSON(ans);

  if(parsed?.followup) session.push({role: 'assistant', content: parsed.followup});

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    applyParsedToState(parsed);
    ensureFullCoverage(currentCity);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    chatMsg(parsed?.followup || tone.applied,'ai');
  }else{
    chatMsg(parsed?.followup || 'No recibí cambios válidos del asistente. ¿Puedes detallar un poco más?','ai');
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

/* Eventos base */
$addCity?.addEventListener('click', ()=>addCityRow());
$reset?.addEventListener('click', ()=>{
  // Mantenemos funcional aunque no lo promociones visualmente
  $cityList.innerHTML=''; savedDestinations=[]; itineraries={}; cityMeta={};
  addCityRow();
  $start.disabled = true;
  $tabs.innerHTML=''; $itWrap.innerHTML='';
  $chatBox.style.display='none'; $chatM.innerHTML='';
  session = [];
  hasSavedOnce = false; previousSavedDestinations = [];
  changedCities.clear(); globalChanged=false;
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

/* Toolbar (igual que antes) */
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

/* Escucha cambios globales que impactan a todas las ciudades */
['#budget','#currency','#special-conditions','#p-adults','#p-young','#p-children','#p-infants','#p-seniors']
  .forEach(sel=>{
    qs(sel)?.addEventListener('input', ()=>{
      if(!hasSavedOnce) return;
      globalChanged = true;
    });
  });

/* Inicial */
addCityRow();
