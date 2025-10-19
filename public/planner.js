/* =========================================================
    ITRAVELBYMYOWN · PLANNER v46 (Bloque 1/3 · FIX cabecera)
    Base: v45  · Corrección: primera fila = Ciudad, País,
    Número de días, Orden de visita, Fecha de inicio de los Recorridos
    + Se mantiene expansión de horas por día.
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
    hi: '¡Hola! Soy tu concierge de viajes ✈️ Voy a construir tu aventura, ciudad por ciudad.',
    askHotelTransport: (city)=>`Para <strong>${city}</strong>, cuéntame <strong>hotel/zona</strong> y el <strong>medio de transporte</strong> (alquiler, público, taxi/uber, combinado o “recomiéndame”).`,
    confirmAll: '✨ Genial. Ya tengo lo necesario. Comienzo a generar tus itinerarios…',
    doneAll: '🎉 ¡Listo! Itinerarios generados. ¿Quieres ajustarlos o añadir algo especial?',
    fail: '⚠️ No se pudo contactar con el asistente. Revisa consola/Vercel.',
    askConfirm: (summary)=>`¿Lo aplico ahora? ${summary}<br><small>Responde “sí” para aplicar o “no”.</small>`,
    askWhichDayToRemove: '¿Qué día deseas eliminar?',
    humanOk: 'Perfecto 🙌 Ajusté tu itinerario para que aproveches mejor el tiempo.',
    humanCancelled: 'Anotado, no apliqué cambios.',
    fuzzySuggest: (suggested)=>`¿Querías decir <strong>${suggested}</strong>? 🌍 Puedo armar el itinerario si me confirmas.`,
    fuzzyNotFound: 'No pude reconocer esa ciudad. ¿Puedes revisarla o escribirla de nuevo?',
    genError: (city)=>`⚠️ No pude generar el itinerario de <strong>${city}</strong> en este intento.`,
    thinking: '🤔 Astra está procesando tu solicitud…'
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
  if(!el) return;
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
    SECCIÓN 6 · UI · Filas de ciudades (cabecera restaurada)
    Cabecera: Ciudad, País, Número de días, Orden de visita,
              Fecha de inicio de los Recorridos
    — Al seleccionar "días", se despliegan horas inicio/fin por día.
=================================== */
function lettersOnly(el){
  if(!el) return;
  el.addEventListener('input', ()=>{
    el.value = el.value.replace(/[^A-Za-zÀ-ÿ\u00f1\u00d1\s]/g, '');
  });
}
function buildDaysSelect(selected=''){
  const sel = document.createElement('select');
  sel.className = 'days';
  const empty = document.createElement('option');
  empty.value = ''; empty.textContent = '';
  sel.appendChild(empty);
  for(let i=0;i<=30;i++){
    const opt = document.createElement('option');
    opt.value = String(i); opt.textContent = String(i);
    if(String(selected)===String(i)) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}
function makeHoursBlock(days){
  const wrap = document.createElement('div');
  wrap.className = 'hours-block';
  for(let d=1; d<=days; d++){
    const row = document.createElement('div');
    row.className = 'hours-day';
    row.innerHTML = `
      <span>Día ${d}</span>
      <input class="start" type="time" aria-label="Hora inicio" value="">
      <input class="end"  type="time" aria-label="Hora final"  value="">
    `;
    wrap.appendChild(row);
  }
  return wrap;
}
function addCityRow(pref={city:'',country:'',days:'',order:'',baseDate:''}){
  const row = document.createElement('div');
  row.className = 'city-row';

  // Ciudad
  const cityLabel = document.createElement('label');
  cityLabel.innerHTML = `Ciudad<input class="city" placeholder="Ciudad" value="${pref.city||''}">`;

  // País
  const countryLabel = document.createElement('label');
  countryLabel.innerHTML = `País<input class="country" placeholder="País" value="${pref.country||''}">`;

  // Número de días
  const daysLabel = document.createElement('label');
  daysLabel.textContent = 'Días';
  const daysSelect = buildDaysSelect(pref.days||'');
  daysLabel.appendChild(daysSelect);

  // Orden de visita
  const orderLabel = document.createElement('label');
  orderLabel.innerHTML = `Orden de visita<input class="order" type="number" min="1" placeholder="" value="${pref.order||''}">`;

  // Fecha de inicio de los Recorridos
  const baseDateLabel = document.createElement('label');
  baseDateLabel.innerHTML = `Fecha de inicio de los Recorridos<input class="baseDate" placeholder="DD/MM/AAAA" value="${pref.baseDate||''}">`;

  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove';
  removeBtn.type = 'button';
  removeBtn.textContent = '✕';

  row.appendChild(cityLabel);
  row.appendChild(countryLabel);
  row.appendChild(daysLabel);
  row.appendChild(orderLabel);
  row.appendChild(baseDateLabel);
  row.appendChild(removeBtn);

  autoFormatDMYInput(qs('.baseDate', row));
  lettersOnly(qs('.city', row));
  lettersOnly(qs('.country', row));

  // Bloque de horas por día (se genera al elegir días)
  const hoursWrap = document.createElement('div');
  hoursWrap.className = 'hours-block';
  row.appendChild(hoursWrap);

  daysSelect.addEventListener('change', ()=>{
    const n = Math.max(0, parseInt(daysSelect.value||'0',10));
    hoursWrap.innerHTML = '';
    if(n>0){
      const tmp = makeHoursBlock(n).children;
      Array.from(tmp).forEach(c=>hoursWrap.appendChild(c));
    }
  });

  if(pref.days && String(pref.days) !== ''){
    daysSelect.dispatchEvent(new Event('change'));
  }

  removeBtn.addEventListener('click', ()=> row.remove());
  $cityList.appendChild(row);
}

/* ================================
    SECCIÓN 7 · Guardar destinos (soporta "orden de visita")
=================================== */
function saveDestinations(){
  const rows = qsa('.city-row', $cityList);
  const list = [];
  rows.forEach((r, idx)=>{
    let city     = qs('.city',r).value.trim();
    city = normalizeCityName(city);
    const country  = qs('.country',r).value.trim();
    const daysSel  = qs('.days',r);
    const daysVal  = daysSel ? (daysSel.value||'') : '';
    const days     = Math.max(0, parseInt(daysVal||'0',10)||0);
    const baseDate = qs('.baseDate',r).value.trim();
    const orderRaw = qs('.order',r)?.value.trim();
    const order    = orderRaw === '' ? (idx+1) : Math.max(1, parseInt(orderRaw,10)|| (idx+1));

    if(!city) return;

    // Horas por día
    const perDay = [];
    qsa('.hours-day', r).forEach((hd, i)=>{
      const start = qs('.start',hd).value || '';
      const end   = qs('.end',hd).value   || '';
      perDay.push({ day: i+1, start, end });
    });
    if(perDay.length===0 && days>0){
      for(let d=1; d<=days; d++) perDay.push({day:d,start:'',end:''});
    }

    list.push({ city, country, days, baseDate, perDay, order });
  });

  // ordena por "orden de visita"
  list.sort((a,b)=> (a.order||9999) - (b.order||9999));
  savedDestinations = list;

  // sincroniza estructuras
  savedDestinations.forEach(({city,days,baseDate,perDay})=>{
    if(!itineraries[city]) itineraries[city] = { byDay:{}, currentDay:1, baseDate: baseDate||null };
    if(!cityMeta[city]) cityMeta[city] = { baseDate: baseDate||null, start:null, end:null, hotel:'', transport:'', interests:[], perDay: perDay||[] };
    else {
      cityMeta[city].baseDate = baseDate||null;
      cityMeta[city].perDay   = perDay||[];
    }
    const byDay = itineraries[city].byDay || {};
    if(days>0){
      for(let d=1; d<=days; d++){
        if(!byDay[d]) byDay[d]=[];
      }
      itineraries[city].byDay = byDay;
    }
  });

  // limpia removidos
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

  // usa savedDestinations ya ordenado por "orden de visita"
  savedDestinations.forEach(({city})=>{
    const b = document.createElement('button');
    b.className = 'city-tab' + (city===prev?' active':'');
    b.textContent = city;
    b.dataset.city = city;
    b.addEventListener('click', ()=>{
      setActiveCity(city);
      renderCityItinerary(city); // Sección 9
    });
    $tabs.appendChild(b);
  });

  if(savedDestinations.length){
    const valid = prev && savedDestinations.some(x=>x.city===prev) ? prev : savedDestinations[0].city;
    setActiveCity(valid);
    renderCityItinerary(valid); // Sección 9
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

  // sincroniza perDay con days actuales
  savedDestinations.forEach(dest=>{
    if(!cityMeta[dest.city]) cityMeta[dest.city] = {};
    if(!cityMeta[dest.city].perDay) cityMeta[dest.city].perDay = [];
    cityMeta[dest.city].perDay = Array.from({length:dest.days||0}, (_,i)=>{
      const prev = (cityMeta[dest.city].perDay||[]).find(x=>x.day===i+1) || dest.perDay?.[i];
      return { day:i+1, start:(prev && prev.start)?prev.start:'', end:(prev && prev.end)?prev.end:'' };
    });
  });

  const list = savedDestinations.map(x=>{
    const dates = x.baseDate ? `, start=${x.baseDate}` : '';
    return `${x.city} (${x.country||'—'} · ${x.days||0} días${dates})`;
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
- Usa horas por día si están disponibles; si faltan, sugiere horas lógicas (incluye nocturnas si aplica).
- No dupliques; conserva lo existente salvo instrucción explícita.
- Máximo 20 filas por día.
- Nada de texto fuera del JSON.
`;

/* ================================
    SECCIÓN 12 · Llamada al agente + helpers de locking
=================================== */
async function callAgent(text, useHistory = true){
  const history = useHistory ? session : [];
  const globalStyle = `
Eres "Astra", agente de viajes con 40 años de experiencia.
- Responde con calidez, variedad y emoción.
- Incluye imperdibles reales por ciudad y temporada SIN pedir confirmación adicional.
- Evalúa temporada, horas de luz y clima para proponer actividades realistas.
- Si la consulta es informativa, responde y luego pregunta si desea actualizar el itinerario.
- No inventes datos; si dudas, pide una breve aclaración.
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
/* ==== Helpers de locking UX ==== */
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
    SECCIÓN 13 · Apply / Merge + utilidades de edición
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

/* ==== Manipulación de días/actividades y optimización ==== */
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

  // perDay (ventanas) también se corre
  if(cityMeta[city]){
    const pd = cityMeta[city].perDay || [];
    for(let d = pd.length; d >= pos; d--){
      pd[d] = {...pd[d-1], day:d+1};
    }
    pd[pos-1] = {day:pos, start: cityMeta[city].start||'', end: cityMeta[city].end||''};
    cityMeta[city].perDay = pd;
  }
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

  if(cityMeta[city]){
    const pd = (cityMeta[city].perDay||[]).filter(x=>x.day!==day).map(x=>x.day>day?({...x,day:x.day-1}):x);
    cityMeta[city].perDay = pd;
  }
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

  if(cityMeta[city]){
    const pd = cityMeta[city].perDay||[];
    const ia = pd.findIndex(x=>x.day===a);
    const ib = pd.findIndex(x=>x.day===b);
    if(ia>-1) pd[ia].day = b;
    if(ib>-1) pd[ib].day = a;
    cityMeta[city].perDay = pd.sort((x,y)=>x.day-y.day);
  }
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

/* Optimización con IA (por día y par de días) */
async function optimizeDay(city, day){
  const work = async ()=>{
    const data = itineraries[city];
    const rows = (data?.byDay?.[day]||[]).map(r=>({
      day, start:r.start||'', end:r.end||'', activity:r.activity||'',
      from:r.from||'', to:r.to||'', transport:r.transport||'',
      duration:r.duration||'', notes:r.notes||''
    }));
    const perDay = (cityMeta[city]?.perDay||[]).find(x=>x.day===day) || {start:cityMeta[city]?.start||'',end:cityMeta[city]?.end||''};
    const baseDate = data.baseDate || cityMeta[city]?.baseDate || '';

    const prompt = `
${FORMAT}
Ciudad: ${city}
Día: ${day}
Fecha base (d1): ${baseDate||'N/A'}
Ventanas definidas: ${JSON.stringify(perDay)} (vacías = sugiere horas lógicas; permite nocturnas si aplica)
Filas actuales:
${JSON.stringify(rows)}
Instrucción:
- Reordena y optimiza el día (min traslados; agrupa por zonas).
- Rellena huecos con actividades relevantes (imperdibles/experiencias cercanas, válidas por temporada).
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
    SECCIÓN 15 · Generación por ciudad
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

    const perDay = Array.from({length:dest.days||0}, (_,i)=>{
      const src  = (cityMeta[norm]?.perDay||[])[i] || dest.perDay?.[i] || {};
      // si no hay horas por día, usar ventanas globales de la ciudad
      return { day:i+1, start: (src.start || cityMeta[norm]?.start || ''), end: (src.end || cityMeta[norm]?.end || '') };
    });
    const baseDate = cityMeta[norm]?.baseDate || dest.baseDate || '';
    const hotel    = cityMeta[norm]?.hotel || '';
    const transport= cityMeta[norm]?.transport || 'recomiéndame';

    const instructions = `
${FORMAT}
**ROL:** Eres “Astra”.
**TAREA:** Genera el itinerario COMPLETO para "${norm}" (${dest.days||0} día[s]) con imperdibles y actividades emblemáticas automáticas, válidas para la temporada.
- Valida existencia y sentido de cada actividad para la ciudad/fecha.
- Horarios lógicos (no pongas nocturnas en la mañana; permite nocturnas cuando aplique).
- Respeta ventanas por día si existen; si faltan, sugiere horas lógicas (usa ventana global ciudad como base).
- Evita solapes y dupes. Optimiza traslados.
- Devuelve B {"destination":"${norm}","rows":[...],"replace": true} cubriendo TODOS los días.

Datos base:
- Ciudad: "${norm}"
- Días: ${dest.days||0}
- Horas/día: ${JSON.stringify(perDay)}
- BaseDate (día 1): ${baseDate||'N/A'}
- Hotel/Zona: ${hotel||'pendiente'}
- Transporte: ${transport}

Contexto:
${buildIntake()}
`.trim();

    let text = await callAgent(instructions, false);
    let parsed = parseJSON(text);

    const coversAllDays = (p)=>{
      try{
        const tmp = {};
        if(p?.rows){ p.rows.forEach(r=>{ if(r?.day) tmp[r.day]=true; }); }
        else if(Array.isArray(p?.destinations)){
          const dd = p.destinations.find(d=> (d.name||d.destination)===norm);
          if(dd?.rows) dd.rows.forEach(r=>{ if(r?.day) tmp[r.day]=true; });
        }else if(Array.isArray(p?.itineraries)){
          const ii = p.itineraries.find(x=> (x.city||x.name||x.destination)===norm);
          if(ii?.rows) ii.rows.forEach(r=>{ if(r?.day) tmp[r.day]=true; });
        }
        const want = savedDestinations.find(x=>x.city===norm)?.days || 0;
        for(let d=1; d<=want; d++){ if(!tmp[d]) return false; }
        return want>0;
      }catch(_){ return false; }
    };

    if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries) && coversAllDays(parsed)){
      applyParsedToState(parsed);
      renderCityTabs(); setActiveCity(norm); renderCityItinerary(norm);
      return;
    }

    // Reintento estricto si no cubre todos los días
    const strict = `
${FORMAT}
**REINTENTO ESTRICTO:** Devuelve solo para "${norm}" (${dest.days||0} días) en formato B con "replace": true, cubriendo TODOS los días. 
Nada fuera del JSON.
`.trim();
    text = await callAgent(strict, false);
    parsed = parseJSON(text);

    if(parsed && coversAllDays(parsed)){
      applyParsedToState(parsed);
      renderCityTabs(); setActiveCity(norm); renderCityItinerary(norm);
      return;
    }

    chatMsg(tone.genError(norm),'ai');
  };
  return runWithLock(work);
}
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
    SECCIÓN 17 · Chat handler / Intents
    (NLU avanzada + comandos en lenguaje natural)
=================================== */
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
function intentFromText(text){
  const t = text.toLowerCase().trim();
  // Confirmaciones básicas
  if(/^(sí|si|ok|dale|confirmo)/.test(t)) return {type:'confirm'};
  if(/^(no|cancela)/.test(t)) return {type:'cancel'};

  // Agregar día
  if(/(agrega|añade)\s+un?\s+d[ií]a/.test(t)){
    let pos = null;
    if(/\binicio\b/.test(t)) pos = 'start';
    else if(/\bfinal\b/.test(t)) pos = 'end';
    else {
      const p = parseOrdinalDay(t);
      if(p) pos = p;
    }
    const placeMatch = t.match(/para\s+ir\s+a\s+([a-záéíóúüñ\s]+)$/i);
    const place = placeMatch ? placeMatch[1].trim() : null;
    return {type:'add_day', position:pos, place};
  }

  // Eliminar día
  if(/(quita|elimina|borra)\s+un?\s+d[ií]a/.test(t)){
    const d = parseOrdinalDay(t);
    return d ? {type:'remove_day', day:d} : {type:'ask_remove_day_direct'};
  }

  // Mover actividad entre días
  if(/mueve\s+([a-záéíóúüñ\s]+)\s+al?\s+d[ií]a\s+\d+/.test(t)){
    const m = t.match(/mueve\s+([a-záéíóúüñ\s]+)\s+al?\s+d[ií]a\s+(\d+)/);
    if(m) return {type:'move_activity', activity:m[1].trim(), targetDay:parseInt(m[2],10)};
  }

  // Sustituir actividad
  if(/sustituye\s+([a-záéíóúüñ\s]+)\s+por\s+([a-záéíóúüñ\s]+)/.test(t)){
    const m = t.match(/sustituye\s+([a-záéíóúüñ\s]+)\s+por\s+([a-záéíóúüñ\s]+)/);
    if(m) return {type:'replace_activity', from:m[1].trim(), to:m[2].trim()};
  }

  // Quitar actividad
  if(/(quita|elimina|borra)\s+([a-záéíóúüñ\s]+)/.test(t)){
    const m = t.match(/(quita|elimina|borra)\s+([a-záéíóúüñ\s]+)/);
    if(m) return {type:'remove_activity', activity:m[2].trim()};
  }

  // Agregar ciudad
  if(/(agrega|añade)\s+[a-záéíóúüñ]+/.test(t)){
    const m = t.match(/agrega\s+([a-záéíóúüñ\s]+?)(?:\s+(\d+)\s+d[ií]as?)?$/i);
    if(m){ return {type:'add_city', name: m[1].trim(), days: m[2]?parseInt(m[2],10):null}; }
  }

  // Eliminar ciudad
  if(/(quita|elimina|borra)\s+la?\s+ciudad\s+([a-záéíóúüñ\s]+)/.test(t)){
    const m = t.match(/(quita|elimina|borra)\s+la?\s+ciudad\s+([a-záéíóúüñ\s]+)/);
    if(m) return {type:'remove_city', name:m[2].trim()};
  }

  return {type:'free_edit', details:text};
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

// Eventos principales UI
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

// Eventos Chat
$send?.addEventListener('click', ()=>{
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';
  const intent = intentFromText(text);

  const city = activeCity || (savedDestinations[0]?.city || null);
  if(!city && intent.type!=='add_city'){ chatMsg('No hay ciudad activa.', 'ai'); return; }

  switch(intent.type){
    case 'add_city': {
      const name = normalizeCityName(intent.name||'').trim();
      if(!name){ chatMsg('Necesito el nombre de la ciudad.','ai'); return; }
      const days = intent.days || 2;
      addCityRow({city:name, days});
      saveDestinations();
      chatMsg(`Añadí <strong>${name}</strong>. Dime tu hotel/zona y transporte.`, 'ai');
      break;
    }
    case 'remove_city': {
      const name = normalizeCityName(intent.name||'').trim();
      savedDestinations = savedDestinations.filter(x=>x.city!==name);
      delete itineraries[name];
      delete cityMeta[name];
      renderCityTabs();
      chatMsg(`Eliminé <strong>${name}</strong> de tu itinerario.`, 'ai');
      break;
    }
    case 'add_day': {
      const dest = savedDestinations.find(x=>x.city===city);
      const currentDays = dest?.days || 0;
      let pos = intent.position;
      if(pos==='start') pos = 1;
      else if(pos==='end' || pos===null) pos = currentDays+1;
      insertDayAt(city, pos);
      renderCityTabs();
      chatMsg(`Agregué un día ${pos===1?'al inicio':pos===currentDays+1?'al final':`en la posición ${pos}`}.`, 'ai');
      break;
    }
    case 'remove_day': {
      removeDayAt(city, intent.day);
      renderCityTabs();
      chatMsg(`Eliminé el día ${intent.day}.`, 'ai');
      break;
    }
    case 'move_activity': {
      moveActivities(city, itineraries[city].currentDay, intent.targetDay, intent.activity);
      renderCityItinerary(city);
      chatMsg(`Moví <strong>${intent.activity}</strong> al día ${intent.targetDay}.`, 'ai');
      break;
    }
    case 'replace_activity': {
      removeActivitiesByQuery(city, itineraries[city].currentDay, intent.from);
      pushRows(city, [{day: itineraries[city].currentDay, activity: intent.to}], false);
      renderCityItinerary(city);
      chatMsg(`Reemplacé <strong>${intent.from}</strong> por <strong>${intent.to}</strong>.`, 'ai');
      break;
    }
    case 'remove_activity': {
      removeActivitiesByQuery(city, itineraries[city].currentDay, intent.activity);
      renderCityItinerary(city);
      chatMsg(`Eliminé <strong>${intent.activity}</strong> del día actual.`, 'ai');
      break;
    }
    default: {
      chatMsg('Recibido 👌 Estoy procesando tu instrucción...', 'ai');
      // Instrucciones libres: enviar al agente LLM
      (async ()=>{
        const resp = await callAgent(text, true);
        const parsed = parseJSON(resp);
        if(parsed) applyParsedToState(parsed);
        renderCityItinerary(city);
      })();
    }
  }
});
$chatI?.addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    $send.click();
  }
});

// Upsell / botones secundarios
$confirmCTA?.addEventListener('click', lockItinerary);
$upsellClose?.addEventListener('click', ()=> $upsell.style.display='none');

qs('#btn-pdf')?.addEventListener('click', guardFeature(()=>alert('Exportar PDF')));
qs('#btn-email')?.addEventListener('click', guardFeature(()=>alert('Enviar por email')));
qs('#btn-maps')?.addEventListener('click', ()=>window.open('https://maps.google.com','_blank'));
qs('#btn-transport')?.addEventListener('click', guardFeature(()=>window.open('https://www.rome2rio.com/','_blank')));
qs('#btn-weather')?.addEventListener('click', guardFeature(()=>window.open('https://weather.com','_blank')));
qs('#btn-clothing')?.addEventListener('click', guardFeature(()=>window.open('https://www.packup.ai/','_blank')));
qs('#btn-restaurants')?.addEventListener('click', guardFeature(()=>window.open('https://www.thefork.com/','_blank')));
qs('#btn-gas')?.addEventListener('click', guardFeature(()=>window.open('https://www.google.com/maps/search/gas+station','_blank')));
qs('#btn-bathrooms')?.addEventListener('click', guardFeature(()=>window.open('https://www.google.com/maps/search/public+restrooms','_blank')));
qs('#btn-lodging')?.addEventListener('click', guardFeature(()=>window.open('https://www.booking.com','_blank')));
qs('#btn-localinfo')?.addEventListener('click', guardFeature(()=>window.open('https://www.wikivoyage.org','_blank')));

addCityRow();

/* ================================
    SECCIÓN 19 · Fuzzy Matching + Similitud
=================================== */
const KNOWN_CITIES = [
  'Reykjavik','Reikiavik','Reikjavik','Tromsø','Tromso','Paris','Madrid','Barcelona',
  'Luxor','Florence','Rome','Roma','Oslo','London','Saint Petersburg','San Petersburgo',
  'Rovaniemi','Abisko','Kiruna','Fairbanks','Yellowknife','Grindavik','Hveragerdi','Flúðir','Fludir',
  'Selfoss','Milan','Milán','Segovia','Versalles','Montserrat','Girona','Sitges','Venezia','Venecia'
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
