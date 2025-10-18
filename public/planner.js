/* =========================================================
   ITRAVELBYMYOWN · PLANNER v43 (parte 1/3)
   Base: v42 (manteniendo HTML/CSS y UX)
   Cambios v43 (solo agregado/modular):
   - NLU global robusta (ciudad explícita/implícita, slots).
   - Day-trips genéricos enriquecidos (cualquier ciudad).
   - Imperdibles automáticos por destino/estación (auroras, termales, etc.).
   - Ediciones dirigidas a otra ciudad (aunque no sea la tab activa).
   - Sustituir actividad dentro de un día (sin borrar el resto).
   - Agregar / Eliminar ciudad vía chat (persistente).
   - Indicador de "pensando" (… + cuadradito) para todas las respuestas.
   - Nunca se reintroduce la pregunta de intereses adicionales.
========================================================= */

/* ==============================
   SECCIÓN 1 · Helpers / Estado
================================= */
const qs  = (s, ctx=document)=>ctx.querySelector(s);
const qsa = (s, ctx=document)=>Array.from(ctx.querySelectorAll(s));

// ⚠️ Tu API
const API_URL = 'https://itravelbymyown-api.vercel.app/api/chat';
const MODEL   = 'gpt-4o-mini';

let savedDestinations = [];    // [{city,country,days,baseDate,perDay:[{day,start,end}]}]
let itineraries = {};          // { [city]: { byDay:{ [n]:Row[] }, currentDay, baseDate } }
let cityMeta = {};             // { [city]: { baseDate, start, end, hotel, transport, perDay:[] } }
let session = [];              // historial para ediciones via chat
let activeCity = null;

let planningStarted = false;
let metaProgressIndex = 0;
let collectingHotels = false;
// v43: NO recolectamos intereses (petición explícita)
let collectingInterests = false;

let isItineraryLocked = false;

const DEFAULT_START = '08:30';
const DEFAULT_END   = '19:00';

let pendingChange = null; // { city, prompt, summary, type? }
let hasSavedOnce = false;

/* ==============================
   SECCIÓN 2 · Tono / Mensajería
================================= */
const tone = {
  es: {
    hi: '¡Hola! Soy tu concierge de viajes ✈️ Voy a construir tu aventura, ciudad por ciudad.',
    askHotelTransport: (city)=>`Para <strong>${city}</strong>, dime tu <strong>hotel/zona</strong> y el <strong>medio de transporte</strong> (alquiler, público, taxi/uber, combinado o “recomiéndame”).`,
    confirmAll: '✨ Listo. Empiezo a generar tus itinerarios…',
    doneAll: '🎉 Itinerarios generados. ¿Quieres ajustarlos o añadir algo especial?',
    fail: '⚠️ No se pudo contactar con el asistente. Revisa consola/Vercel (API Key, URL).',
    askConfirm: (summary)=>`¿Confirmas? ${summary}<br><small>Responde “sí” para aplicar o “no” para cancelar.</small>`,
    humanOk: 'Perfecto 🙌 Ajusté tu itinerario para que aproveches mejor el tiempo. ¡Va a quedar genial! ✨',
    humanCancelled: 'Anotado, no apliqué cambios. ¿Probamos otra idea? 🙂',
    cityAdded: (c)=>`✅ Añadí <strong>${c}</strong> y generé su itinerario.`,
    cityRemoved: (c)=>`🗑️ Eliminé <strong>${c}</strong> de tu plan y reoptimicé las pestañas.`,
    cannotFindCity: 'No identifiqué la ciudad. Dímela con exactitud, por favor.',
  }
}['es'];

/* ==============================
   SECCIÓN 3 · Referencias DOM
================================= */
const $cityList = qs('#city-list');
const $addCity  = qs('#add-city-btn');
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

/* ==============================
   SECCIÓN 4 · Chat UI + Typing
================================= */
function chatMsg(html, who='ai'){
  if(!html) return;
  const div = document.createElement('div');
  div.className = `chat-message ${who==='user'?'user':'ai'}`;
  div.innerHTML = String(html).replace(/\n/g,'<br>');
  $chatM.appendChild(div);
  $chatM.scrollTop = $chatM.scrollHeight;
  return div;
}

// v43 · Indicador “pensando” estilo ChatGPT
let typingTimer = null;
let typingNode = null;
let blackSquareNode = null;
function showThinking(on){
  // crea si no existe
  if(on){
    if(typingNode) return;
    const wrap = document.createElement('div');
    wrap.className = 'chat-message ai';
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '.5rem';

    const dots = document.createElement('span');
    dots.textContent = '• • •';
    dots.style.letterSpacing = '4px';
    dots.style.fontWeight = '700';
    dots.style.opacity = '0.7';

    const square = document.createElement('div');
    square.style.width = '10px';
    square.style.height = '10px';
    square.style.background = '#111';
    square.style.borderRadius = '2px';
    square.style.opacity = '0.85';

    wrap.appendChild(dots);
    wrap.appendChild(square);

    $chatM.appendChild(wrap);
    $chatM.scrollTop = $chatM.scrollHeight;

    typingNode = dots;
    blackSquareNode = square;

    // animación simple sin CSS extra
    let phase = 0;
    typingTimer = setInterval(()=>{
      phase = (phase+1)%4;
      typingNode.textContent = ['•  ', '• •', '• • •', ' • •'][phase];
      typingNode.style.opacity = (phase%2?0.6:0.9);
      blackSquareNode.style.opacity = (phase%2?0.55:0.9);
    }, 400);
  }else{
    if(typingTimer) clearInterval(typingTimer);
    typingTimer = null;
    if(typingNode){
      const parent = typingNode.parentElement;
      if(parent) parent.remove();
    }
    typingNode = null;
    blackSquareNode = null;
  }
}

/* ==============================
   SECCIÓN 5 · Fechas / horas
================================= */
function autoFormatDMYInput(el){
  el.addEventListener('input', ()=>{
    const v = el.value.replace(/\D/g,'').slice(0,8);
    if(v.length===8) el.value = `${v.slice(0,2)}/${v.slice(2,4)}/${v.slice(4,8)}`;
    else el.value = v;
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
function addDays(d, n){ const x=new Date(d.getTime()); x.setDate(x.getDate()+n); return x; }
function addMinutes(hhmm, min){
  const [H,M] = (hhmm||DEFAULT_START).split(':').map(n=>parseInt(n||'0',10));
  const d = new Date(2000,0,1,H||0,M||0,0);
  d.setMinutes(d.getMinutes()+min);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/* ==============================
   SECCIÓN 6 · UI ciudades (intacto)
================================= */
function makeHoursBlock(days){
  const wrap = document.createElement('div');
  wrap.className = 'hours-block';
  for(let d=1; d<=days; d++){
    const row = document.createElement('div');
    row.className = 'hours-day';
    row.innerHTML = `
      <span>Día ${d}</span>
      <input class="start" type="time" aria-label="Hora inicio" placeholder="HH:MM">
      <input class="end"   type="time" aria-label="Hora final"  placeholder="HH:MM">
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

/* ==============================
   SECCIÓN 7 · Guardar destinos
================================= */
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
    if(!cityMeta[city]) cityMeta[city] = { baseDate: baseDate||null, start:null, end:null, hotel:'', transport:'', perDay: perDay||[] };
    else {
      cityMeta[city].baseDate = baseDate||null;
      cityMeta[city].perDay   = perDay||[];
    }
    for(let d=1; d<=days; d++){
      if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[];
    }
  });
  // limpia ciudades eliminadas
  Object.keys(itineraries).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete itineraries[c]; });
  Object.keys(cityMeta).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete cityMeta[c]; });

  renderCityTabs();
  $start.disabled = savedDestinations.length===0;
  hasSavedOnce = true;
}

/* ==============================
   SECCIÓN 8 · Tabs + Render
================================= */
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

/* ==============================
   SECCIÓN 9 · Render Itinerario
================================= */
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
/* =========================================================
   ITRAVELBYMYOWN · PLANNER v43 (parte 2/3)
========================================================= */

/* ==============================
   SECCIÓN 10 · Snapshot + Intake
================================= */
function getFrontendSnapshot(){
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(itineraries).map(([city,data])=>[
        city,
        {
          baseDate: data.baseDate || cityMeta[city]?.baseDate || null,
          transport: cityMeta[city]?.transport || '',
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

  // asegurar perDay
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

/* ==============================
   SECCIÓN 11 · Contrato JSON / LLM
================================= */
const FORMAT = `
Devuelve SOLO JSON válido (sin markdown) en uno de estos:
A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}]}], "followup":"Pregunta breve"}
B) {"destination":"City","rows":[{...}],"replace":true,"followup":"Pregunta breve"}
C) {"rows":[{...}],"replace":true,"followup":"Pregunta breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" | ["HH:MM",...],"end":"HH:MM" | ["HH:MM",...],"hotel":"Texto","transport":"Texto"},"followup":"Pregunta breve"}
Reglas:
- Optimiza el/los día(s) afectado(s) (min traslados, agrupa por zonas, respeta ventanas).
- Usa horas por día si están disponibles; si faltan, 08:30–19:00.
- No dupliques; conserva lo existente salvo instrucción explícita.
- Máximo 20 filas por día.
- Nada de texto fuera del JSON.
`;

/* ==============================
   SECCIÓN 12 · Llamada al agente
================================= */
async function callAgent(text, useHistory = true){
  const history = useHistory ? session : [];
  const globalStyle = `
Eres "Astra", agente de viajes experto (40 años). Piensa como un guía local por cada ciudad del mundo:
- Identifica imperdibles reales (museos clave, cascos históricos, miradores, mercados, comidas típicas).
- Si la ciudad es de auroras (Tromsø, Rovaniemi, Abisko, Kiruna, Reykjavik, Fairbanks, Yellowknife, etc.) y la estación lo permite (aprox. sep–abr), incluye "Caza de auroras" 21:00–23:30 como actividad nocturna en al menos un día, preferentemente en tour (NO coche alquilado).
- Cuando el usuario pida un cambio, responde con el JSON final; evita preguntas innecesarias. No borres otros días.
- Si la solicitud es informativa (clima, dudas), responde una frase en "followup" y NO edites hasta que te diga “sí”.
`.trim();

  try{
    showThinking(true);
    const res = await fetch(API_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ model: MODEL, input: `${globalStyle}\n\n${text}`, history })
    });
    const data = res.ok ? await res.json().catch(()=>({text:''})) : {text:''};
    return data?.text || '';
  }catch(e){
    console.error("Fallo al contactar la API:", e);
    return `{"followup":"${tone.fail}"}`;
  }finally{
    showThinking(false);
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

/* ==============================
   SECCIÓN 13 · Merge / utilidades
================================= */
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
  if(!cityMeta[name]) cityMeta[name] = { baseDate:null, start:null, end:null, hotel:'', transport:'', perDay:[] };
  if(meta.baseDate) cityMeta[name].baseDate = meta.baseDate;
  if(meta.start)    cityMeta[name].start    = meta.start;
  if(meta.end)      cityMeta[name].end      = meta.end;
  if(typeof meta.hotel==='string') cityMeta[name].hotel = meta.hotel;
  if(typeof meta.transport==='string') cityMeta[name].transport = meta.transport;
  if(Array.isArray(meta.perDay)) cityMeta[name].perDay = meta.perDay;
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
      if(Array.isArray(d.rows)) pushRows(name, d.rows, Boolean(d.replace));
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
      }else if(Array.isArray(x.rows)) pushRows(name, x.rows, Boolean(x.replace));
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
        notes:'✨ Punto base para organizar el día. Luego lo afinamos.'
      }], false);
    }
  }
}

/* ==============================
   SECCIÓN 14 · Imperdibles / Sugerencias
================================= */
const AURORA_CITIES = ['tromso','tromsø','rovaniemi','reykjavik','reikiavik','abisko','kiruna','fairbanks','yellowknife','murmansk'];
function monthFromBaseDate(city){
  const base = parseDMY(itineraries[city]?.baseDate || cityMeta[city]?.baseDate || '');
  return base ? (base.getMonth()+1) : null;
}
function isAuroraSeason(city){
  const m = monthFromBaseDate(city);
  if(!m) return true; // si no hay fechas, no bloqueamos
  // Sep (9) a Abr (4)
  return (m>=9 && m<=12) || (m>=1 && m<=4);
}
function insertNightActivity(city, day, label, notes){
  ensureDays(city);
  const byDay = itineraries[city].byDay;
  if(!byDay[day]) byDay[day]=[];
  // evitar solapado: colocamos 21:00–23:30
  const start = '21:00', end='23:30';
  const row = { day, start, end, activity:label, from:'Hotel', to:'Punto de encuentro', transport:'Tour/Bus', duration:'150m', notes };
  // eliminar cualquier actividad nocturna que choque (21:00+)
  byDay[day] = byDay[day].filter(r => (r.end||'') < '21:00');
  byDay[day].push(row);
}
function ensureSignatureActivities(city){
  const lc = (city||'').toLowerCase();
  if(AURORA_CITIES.includes(lc) && isAuroraSeason(city)){
    // añade en el último día si no existe ya
    const days = Object.keys(itineraries[city]?.byDay||{}).map(n=>+n).sort((a,b)=>a-b);
    if(!days.length) return;
    const target = days[Math.min(1, days.length)-1] || days[0]; // día 1 por defecto
    const already = (itineraries[city].byDay[target]||[]).some(r=>/aurora/i.test(r.activity||''));
    if(!already){
      insertNightActivity(city, target, 'Caza de auroras', 'Mejor en tour: guía, clima y fotografía; evita conducir.');
    }
  }
}

/* ==============================
   SECCIÓN 15 · Generación por ciudad
================================= */
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

  const instructions = `
${FORMAT}
**ROL:** Planificador “Astra”. Crea itinerario completo SOLO para "${city}" (${dest.days} día/s).
- Formato B {"destination":"${city}","rows":[...],"replace": true}.
- Respeta ventanas por día ${JSON.stringify(perDay)} (si falta, 08:30–19:00).
- Incluye notas humanas breves; no dupliques; agrupa por zonas.
- Si aplica auroras, añade bloque 21:00–23:30 (en tour). Nada de texto fuera del JSON.

Datos:
- BaseDate día 1: ${baseDate||'N/A'}
- Hotel/Zona: ${hotel||'pendiente'}
- Transporte: ${transport}

Contexto:
${buildIntake()}
`.trim();

  const text = await callAgent(instructions, false);
  const parsed = parseJSON(text);

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    applyParsedToState(parsed);
    ensureFullCoverage(city);
    ensureSignatureActivities(city);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    return;
  }

  // Fallback mínimo (muy raro)
  ensureFullCoverage(city);
  ensureSignatureActivities(city);
  renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
  chatMsg('⚠️ Fallback local: revisa configuración de Vercel o API Key.', 'ai');
}

/* ==============================
   SECCIÓN 16 · Inicio (solo hotel/transport)
================================= */
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

/* ==============================
   SECCIÓN 17 · NLU avanzada
================================= */
// números en palabras básicas
const WORD_NUM = {'una':1,'uno':1,'un':1,'dos':2,'tres':3,'cuatro':4,'cinco':5,'seis':6,'siete':7,'ocho':8,'nueve':9,'diez':10};
function normalizeHourToken(tok){
  tok = tok.toLowerCase().trim();
  const yM = tok.match(/^(\d{1,2}|\w+)\s+y\s+(media|cuarto|tres\s+cuartos)$/i);
  if(yM){
    let h = yM[1];
    let hh = WORD_NUM[h] || parseInt(h,10);
    if(!isFinite(hh)) return null;
    let mm = 0; const frag = yM[2].replace(/\s+/g,' ');
    if(frag==='media') mm=30; else if(frag==='cuarto') mm=15; else if(frag==='tres cuartos') mm=45;
    if(hh>=0 && hh<=24) return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
    return null;
  }
  const mapWords = { 'mediodía':'12:00', 'medianoche':'00:00' };
  if(mapWords[tok]) return mapWords[tok];

  const w = WORD_NUM[tok]; if(w) return String(w).padStart(2,'0')+':00';
  const m = tok.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if(!m) return null;
  let hh = parseInt(m[1],10), mm = m[2]?parseInt(m[2],10):0; const ap = m[3]?.toLowerCase();
  if(ap){ if((ap==='pm' || ap==='p.m.') && hh<12) hh += 12; if((ap==='am' || ap==='a.m.') && hh===12) hh = 0; }
  if(hh>=0 && hh<=24 && mm>=0 && mm<60) return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  return null;
}
function parseTimeRangeFromText(text){
  const t = text.toLowerCase();
  let m = t.match(/(?:de|entre)\s+([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)\s*(?:a|hasta|y)\s*([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)/i);
  if(m){ const s=normalizeHourToken(m[1]); const e=normalizeHourToken(m[2]); if(s||e) return {start:s||null, end:e||null}; }
  m = t.match(/(?:iniciar|empezar|arrancar|inicio)\s*(?:el día|la jornada)?\s*(?:a|a las)?\s*([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)/i);
  const startOnly = m ? normalizeHourToken(m[1]) : null;
  m = t.match(/(?:terminar|finalizar|hasta|acabar)\s*(?:a las|a)?\s*([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)/i);
  const endOnly = m ? normalizeHourToken(m[1]) : null;
  return {start:startOnly, end:endOnly};
}
// utilidad: detectar ciudad mencionada en texto (de las guardadas)
function detectCityInText(text){
  const lowered = text.toLowerCase();
  const list = savedDestinations.map(d=>d.city).sort((a,b)=>b.length-a.length); // preferir match largo
  for(const c of list){
    if(lowered.includes(c.toLowerCase())) return c;
  }
  return null;
}

/* ==== Intents */
function intentFromText(text, currentCity){
  const t = text.toLowerCase();

  // Confirmación/cancelación
  if(/^(sí|si|ok|dale|hazlo|confirmo|de una|aplica)\b/.test(t)) return {type:'confirm'};
  if(/^(no|mejor no|cancela|cancelar|cancelá)\b/.test(t)) return {type:'cancel'};

  // Agregar ciudad: "agrega roma 3 días" / "añade Roma con 2 días desde 03/11/2025"
  const addCity = t.match(/(?:agrega|añade|sum[aá])\s+([a-záéíóúüñ\s]+?)\s+(?:con\s+)?(\d+)\s*d[ií]as?(?:\s+(?:desde|iniciando)\s+(\d{1,2}\/\d{1,2}\/\d{4}))?/i);
  if(addCity){
    return {type:'add_city', city:titleCase(addCity[1].trim()), days:parseInt(addCity[2],10), baseDate:addCity[3]||''};
  }
  // Eliminar ciudad
  const delCity = t.match(/(?:elimina|borra|quita)\s+(?:la\s+ciudad\s+)?([a-záéíóúüñ\s]+)/i);
  if(delCity){ return {type:'remove_city', city:titleCase(delCity[1].trim())}; }

  // Añadir día (posible "para ir a X")
  if(/(agrega|añade|suma)\s+un\s+d[ií]a\s+m[aá]s/.test(t)){
    const dest = t.match(/para\s+ir\s+a\s+([a-záéíóúüñ\s]+)/i);
    return {type:'add_day', details:text, dayTripTo: dest ? titleCase(dest[1].trim()) : null};
  }

  // Mover actividad día X→Y
  const mv = t.match(/(?:mueve|pasa|cambia).+?d[ií]a\s*(\d+)\s*(?:al|a)\s*d[ií]a\s*(\d+)/i);
  if(mv){ return {type:'move_day', from:parseInt(mv[1],10), to:parseInt(mv[2],10)}; }

  // Cambiar horas
  const range = parseTimeRangeFromText(text);
  if(range.start || range.end) return {type:'change_hours', range};

  // Sustituir actividad puntual
  if(/(no quiero|sustituye|reemplaza|cambia esta actividad|otra opci[oó]n|dame otra)/i.test(t)){
    // captar actividad específica si se menciona algo tras "no quiero ir a ..."
    const m = t.match(/no quiero ir a\s+(.+?)(?:,|\.)?$/i);
    return {type:'swap_activity', target: m ? m[1].trim() : null, details:text};
  }

  // Auroras en días N,M
  if(/aurora|auroras/.test(t)){
    // “en los días 2 y 4”
    const ds = [...t.matchAll(/d[ií]a[s]?\s*(\d+)/g)].map(m=>parseInt(m[1],10)).filter(Boolean);
    if(ds.length) return {type:'add_aurora_days', days: ds};
  }

  // Pregunta informativa
  if(/clima|tiempo|temperatura|lluvia|luz|horas de luz|alquiler de auto|vuelos|ropa|equipaje|visado|visa|moneda|seguridad|propina/.test(t)){
    return {type:'info_query', details:text};
  }

  // Pregunta “sobre otra ciudad” detectada
  const cityMention = detectCityInText(text);
  if(cityMention && !t.includes('dí') && !t.includes('día')){ // heurística simple
    return {type:'info_query_other_city', details:text, city: cityMention};
  }

  // Por default: edición libre
  return {type:'free_edit', details:text};
}
function titleCase(s){ return s.replace(/\w\S*/g, t=>t[0].toUpperCase()+t.slice(1)); }
/* =========================================================
   ITRAVELBYMYOWN · PLANNER v43.1-fix (parte 3/3 COMPLETO)
   Partiendo de v43.1 (intacto) y corrigiendo solo lo necesario:
   - País: solo letras y espacios (validación de entrada).
   - Días: convertir input numérico a <select> (1–30) de forma segura,
           sin sobrescribir addCityRow() ni otras funciones base.
   - “Agregar un día más”: no usa el día visible; inserta al final,
     o en la posición dada por el usuario. Si el texto menciona otra
     ciudad, se cambia al tab de esa ciudad antes de aplicar.
   - Mantener comportamiento v42 (no duplicar, reindexar cuando corresponde).
========================================================= */

/* ==============================
   SECCIÓN 18 · Prompts de edición
================================= */
function buildEditPrompt(city, directive, opts={}){
  const data = itineraries[city];
  const allDays = Object.keys(data?.byDay||{}).map(n=>{
    const rows = data.byDay[n]||[];
    return `Día ${n}:\n${rows.map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)'}`;
  }).join('\n\n');

  const perDay = (cityMeta[city]?.perDay||[]).map(pd=>({day:pd.day, start:pd.start||DEFAULT_START, end:pd.end||DEFAULT_END}));
  const overrides = opts.overrides ? JSON.stringify(opts.overrides) : '{}';
  const extraDayTrip = opts.dayTripTo ? `- Si "dayTripTo" está definido ("${opts.dayTripTo}"), crea un day-trip completo.\n` : '';

  return `
${FORMAT}
**Contexto del viaje (snapshot):**
${buildIntake()}

**Ciudad a editar:** ${city}

**Resumen del itinerario actual:**
${allDays}

**Ventanas por día:** ${JSON.stringify(perDay)}

**Directiva de edición:**
${directive}

**Reglas estrictas:**
- Devuelve formato B {"destination":"${city}","rows":[...],"replace": true}.
- Si "addOneDay" es true:
  • Si "insertDay" está definido, inserta el día en esa posición y desplaza el resto hacia adelante.
  • Si no, añade al final.
  • No repitas actividades previas; evita duplicados exactos.
  • Usa imperdibles nuevos o experiencias complementarias.
  • Si "dayTripTo" está definido → crea itinerario coherente de day-trip (ida/visita/regreso).
- Mantén coherencia en horarios y transporte.
- Respeta overrides de horas (si hay): ${overrides}
${extraDayTrip}
`.trim();
}

/* ==============================
   SECCIÓN 19 · Aplicar edición
================================= */
async function applyAgentEdit(city, prompt){
  showWOW(true);
  const ans = await callAgent(prompt, true);
  const parsed = parseJSON(ans);

  if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
    applyParsedToState(parsed);
    ensureFullCoverage(city);
    ensureSignatureActivities(city); // mantiene auroras/imperdibles si aplica
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    chatMsg(tone.humanOk,'ai');
  }else{
    chatMsg(parsed?.followup || 'No recibí cambios válidos. ¿Me das un poco más de contexto?','ai');
  }
  showWOW(false);
}

/* ==============================
   SECCIÓN 20 · Operaciones locales
================================= */
async function addCityByChat(cityName, days, baseDate){
  if(!cityName || !days) return chatMsg(tone.cannotFindCity,'ai');
  const exists = savedDestinations.find(d=>d.city.toLowerCase()===cityName.toLowerCase());
  if(exists){
    chatMsg(`Ya tenías <strong>${cityName}</strong> en tu plan. Actualizo/genero su itinerario…`,'ai');
  }else{
    const perDay = Array.from({length:days}, (_,i)=>({day:i+1,start:DEFAULT_START,end:DEFAULT_END}));
    savedDestinations.push({ city: cityName, country:'', days, baseDate: baseDate||'', perDay });
    itineraries[cityName] = { byDay:{}, currentDay:1, baseDate: baseDate||null };
    cityMeta[cityName] = { baseDate: baseDate||null, start:null, end:null, hotel:'', transport:'recomiéndame', interests:[], perDay };
    renderCityTabs();
  }
  setActiveCity(cityName);
  renderCityItinerary(cityName);
  await generateCityItinerary(cityName);
  chatMsg(tone.cityAdded(cityName),'ai');
}

function removeCityByChat(cityName){
  const idx = savedDestinations.findIndex(d=>d.city.toLowerCase()===cityName.toLowerCase());
  if(idx<0){ chatMsg(tone.cannotFindCity,'ai'); return; }
  savedDestinations.splice(idx,1);
  delete itineraries[cityName];
  delete cityMeta[cityName];
  renderCityTabs();
  if(savedDestinations.length){ setActiveCity(savedDestinations[0].city); renderCityItinerary(activeCity); }
  chatMsg(tone.cityRemoved(cityName),'ai');
}

function reindexDays(city, insertPos){
  const it = itineraries[city];
  if(!it || !it.byDay) return;
  const old = Object.entries(it.byDay).sort((a,b)=>+a[0]-+b[0]);
  const newByDay = {};
  let offset = 0;
  for(const [day, rows] of old){
    const num = +day;
    if(num >= insertPos) offset++;
    newByDay[num+offset] = rows.map(r=>({...r, day:num+offset}));
  }
  it.byDay = newByDay;
}

function localSwapActivity(city, day, targetText){
  ensureDays(city);
  const rows = itineraries[city].byDay[day]||[];
  if(!rows.length){ return; }
  let idx = -1;
  if(targetText){
    const t = targetText.toLowerCase();
    idx = rows.findIndex(r => (r.activity||'').toLowerCase().includes(t));
  }
  if(idx<0) idx = rows.findIndex(r => !/desayuno|almuerzo|cena|hotel/i.test(r.activity||''));
  if(idx<0) idx = 0;

  const altBank = [
    {label:'Museo local destacado', dur:90, trans:'A pie'},
    {label:'Paseo por el casco histórico', dur:75, trans:'A pie'},
    {label:'Mirador / vistas panorámicas', dur:60, trans:'Transporte público'},
    {label:'Mercado típico y cafés', dur:60, trans:'A pie'}
  ];
  const pick = altBank[idx % altBank.length];

  const start = rows[idx]?.start || DEFAULT_START;
  const end   = addMinutes(start, pick.dur);
  rows[idx] = {
    day,
    start, end,
    activity: pick.label,
    from: rows[idx]?.from || 'Zona céntrica',
    to: rows[idx]?.to || 'Atracción',
    transport: pick.trans,
    duration: `${pick.dur}m`,
    notes: 'Sustitución solicitada; optimizado cerca del bloque previo.'
  };
  itineraries[city].byDay[day] = rows;
}

function insertNightActivity(city, day, label, note){
  ensureDays(city);
  const rows = itineraries[city].byDay[day] || [];
  const exists = rows.some(r => (r.activity||'').toLowerCase().includes(label.toLowerCase()));
  if(exists) return;
  // bloque nocturno 21:00–23:30 si no choca
  const start = '21:00';
  const end   = '23:30';
  rows.push({
    day, start, end,
    activity: label,
    from: 'Hotel/Zona',
    to: 'Punto de encuentro (tour)',
    transport: 'Traslado en tour',
    duration: '150m',
    notes: note || 'Se recomienda tour guiado y vestimenta térmica.'
  });
  // ordenar por hora
  rows.sort((a,b)=>(a.start||'00:00').localeCompare(b.start||'00:00'));
  itineraries[city].byDay[day] = rows;
}

function addAurorasDays(city, dayList){
  ensureDays(city);
  const daysAvail = Object.keys(itineraries[city].byDay||{}).map(n=>+n);
  dayList.forEach(d=>{
    if(daysAvail.includes(d)){
      insertNightActivity(city, d, 'Caza de auroras', 'Tour recomendado; evitar conducir en hielo/niebla.');
    }
  });
}

/* ==============================
   SECCIÓN 21 · Chat handler
================================= */
async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  // Detectar si el usuario menciona una ciudad específica distinta al tab activo
  const detectedCity = detectCityInText(text);
  const targetCity = detectedCity || activeCity || savedDestinations[0]?.city;

  if(detectedCity && itineraries[detectedCity]){
    setActiveCity(detectedCity);
    renderCityItinerary(detectedCity);
  }

  if(!targetCity || !itineraries[targetCity]){
    chatMsg('Aún no hay itinerario en pantalla. Inicia la planificación primero.','ai');
    return;
  }

  const intent = intentFromText(text, targetCity);

  // Alta/Baja de ciudades por chat (global)
  if(intent.type==='add_city'){
    await addCityByChat(intent.city, intent.days || 2, intent.baseDate || '');
    return;
  }
  if(intent.type==='remove_city'){
    removeCityByChat(intent.city);
    return;
  }

  // Confirmaciones
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

  // Horarios de día visible (sin cambios)
  if(intent.type==='change_hours'){
    const range = intent.range;
    const cd = itineraries[targetCity]?.currentDay || 1;
    const summary = `Actualizar horarios del <strong>día ${cd}</strong> en ${targetCity} ${range.start?`(inicio ${range.start})`:''} ${range.end?`(fin ${range.end})`:''}.`;
    const prompt = buildEditPrompt(targetCity,
      `Ajusta horarios del día ${cd} con overrides: ${JSON.stringify(range)}. Reoptimiza sin duplicar.`,
      { daysStrict:[cd], overrides:range }
    );
    pendingChange = { city: targetCity, prompt, summary };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }

  // Mover actividades día X → Y (sin cambios)
  if(intent.type==='move_day'){
    const {from,to} = intent;
    const summary = `Mover actividades del <strong>día ${from}</strong> al <strong>día ${to}</strong> en ${targetCity} y reoptimizar ambos.`;
    const prompt = buildEditPrompt(targetCity,
      `Mueve actividades del día ${from} al día ${to}. Reoptimiza ambos días. No dupliques.`,
      { daysStrict:[from,to] }
    );
    pendingChange = { city: targetCity, prompt, summary };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }

  // Añadir un día (con o sin day-trip, con o sin posición específica)
  if(intent.type==='add_day'){
    // Por defecto: insertar al final. Si el usuario dijo "en la posición X", la usamos.
    const byDay = itineraries[targetCity]?.byDay || {};
    const last = Math.max(0, ...Object.keys(byDay).map(n=>+n));
    const insertPos = intent.insertDay
      ? Math.max(1, Math.min(intent.insertDay, last + 1))
      : (last + 1);

    // Si se inserta en medio, reindexar localmente para desplazar días existentes.
    if(intent.insertDay) reindexDays(targetCity, insertPos);

    const summary = intent.dayTripTo
      ? `Añadir un <strong>día ${insertPos}</strong> en ${targetCity} para un day-trip a <strong>${intent.dayTripTo}</strong>.`
      : `Añadir un <strong>día ${insertPos}</strong> en ${targetCity} con actividades nuevas (sin duplicar).`;

    const prompt = buildEditPrompt(
      targetCity,
      `Añade un día extra en la posición ${insertPos}. Si insertas en medio, reacomoda el resto. No repitas actividades previas; crea bloques novedosos y coherentes.`,
      { addOneDay:true, insertDay:insertPos, dayTripTo: intent.dayTripTo || null }
    );

    pendingChange = { city: targetCity, prompt, summary };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }

  // Sustitución de actividad (local + confirmable por LLM si hace falta)
  if(intent.type==='swap_activity'){
    const cd = itineraries[targetCity]?.currentDay || 1;
    // Intento local inmediato para mejor UX
    localSwapActivity(targetCity, cd, intent.details || '');
    renderCityItinerary(targetCity);

    const summary = `He sustituido una actividad en el <strong>día ${cd}</strong> de ${targetCity}. ¿Quieres que además lo reoptimice con el asistente?`;
    const prompt = buildEditPrompt(
      targetCity,
      `Interpreta la actividad a sustituir según el texto del usuario y reemplázala por una opción coherente cercana. Reoptimiza SOLO el día ${cd}.`,
      { daysStrict:[cd] }
    );
    pendingChange = { city: targetCity, prompt, summary };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }

  // Auroras en días concretos (ej.: “agrega caza de auroras en días 2 y 4”)
  if(intent.type==='add_auroras'){
    const days = intent.daysArray?.length ? intent.daysArray : [(itineraries[targetCity]?.currentDay||1)];
    addAurorasDays(targetCity, days);
    renderCityItinerary(targetCity);
    chatMsg(`Añadí “caza de auroras” en los días ${days.join(', ')} de <strong>${targetCity}</strong>. ¿Deseas que lo refine y reoptimice con el asistente? Responde “sí” para confirmar.`, 'ai');

    const prompt = buildEditPrompt(
      targetCity,
      `Agrega una actividad nocturna “Caza de auroras” en los días ${days.join(', ')} y reoptimiza suavemente sin duplicar.`,
      { daysStrict:days }
    );
    pendingChange = { city: targetCity, prompt, summary:`Refinar auroras y reoptimizar días ${days.join(', ')} en ${targetCity}.` };
    return;
  }

  // Consultas informativas (no alteran itinerario salvo confirmación)
  if(intent.type==='info_query'){
    const infoPrompt = `
${FORMAT}
El usuario te pide información (no edites itinerario aún). Responde breve, cálido, útil y actualizado.
Luego sugiere si desea actualizar itinerario con lo aprendido y devuelve:
{"followup":"mensaje breve para continuar"}
`.trim();
    const ans = await callAgent(infoPrompt + `\n\nConsulta: ${text}`, true);
    const parsed = parseJSON(ans);
    chatMsg(parsed?.followup || '¿Quieres que ajuste tu itinerario con esta información?','ai');
    return;
  }

  // Edición libre (por defecto, afectar el día actual solo si el texto lo sugiere)
  if(intent.type==='free_edit'){
    const cd = itineraries[targetCity]?.currentDay || 1;
    const summary = `Aplicar tus cambios en <strong>${targetCity}</strong> afectando el <strong>día ${cd}</strong> (o días necesarios) y reoptimizar.`;
    const prompt = buildEditPrompt(targetCity,
      `Interpreta con precisión el deseo del usuario y actualiza los días implicados (prioriza el día visible ${cd} si aplica). Reoptimiza sin duplicar.`,
      { daysStrict:[cd], userText:text }
    );
    pendingChange = { city: targetCity, prompt, summary };
    chatMsg(tone.askConfirm(pendingChange.summary),'ai');
    return;
  }
}

/* ==============================
   SECCIÓN 22 · Validaciones y helpers UI
================================= */

/* País: solo letras y espacios.
   Nota: mantenemos acentos y Ñ/ñ. */
document.addEventListener('input', (e)=>{
  if(e.target && e.target.classList && e.target.classList.contains('country')){
    const original = e.target.value;
    const filtered = original.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g,'');
    if(filtered !== original){
      const pos = e.target.selectionStart;
      e.target.value = filtered;
      // intentar conservar la posición del cursor
      if(typeof pos === 'number'){ e.target.setSelectionRange(pos-1, pos-1); }
    }
  }
});

/* Transformar inputs de "Días" a <select> (1–30) de forma segura,
   sin tocar addCityRow() ni otras funciones base. */
function transformDaysInputs(scope=document){
  const dayInputs = scope.querySelectorAll('.city-row .days');
  dayInputs.forEach(input=>{
    if(input && input.tagName.toLowerCase()==='input'){
      const currentVal = parseInt(input.value||'0',10) || 1;
      const select = document.createElement('select');
      select.className = input.className; // conserva "days"
      select.setAttribute('aria-label', input.getAttribute('aria-label')||'Días');
      // copiar estilos inline si existieran
      if(input.style.cssText) select.style.cssText = input.style.cssText;

      for(let i=1;i<=30;i++){
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = i;
        if(i===currentVal) opt.selected = true;
        select.appendChild(opt);
      }

      // Reemplazo
      input.parentNode.replaceChild(select, input);
    }
  });
}

/* Observer para transformar automáticamente cuando se añaden filas de ciudades */
const rowsObserver = new MutationObserver(mutations=>{
  for(const m of mutations){
    m.addedNodes && m.addedNodes.forEach(node=>{
      if(node.nodeType===1){
        if(node.classList.contains('city-row')){
          transformDaysInputs(node);
        }else{
          // por si la fila viene envuelta en otra estructura
          const cr = node.querySelector?.('.city-row');
          if(cr) transformDaysInputs(cr);
        }
      }
    });
  }
});
const cityListRoot = document.getElementById('city-list');
if(cityListRoot){
  rowsObserver.observe(cityListRoot, { childList:true, subtree:true });
}

/* ==============================
   SECCIÓN 23 · Eventos / INIT
================================= */
$addCity?.addEventListener('click', ()=>addCityRow());
$save?.addEventListener('click', saveDestinations);
$start?.addEventListener('click', startPlanning);
$send?.addEventListener('click', onSend);
$confirmCTA?.addEventListener('click', lockItinerary);
$upsellClose?.addEventListener('click', ()=> $upsell.style.display='none');

// Chat: Enter envía, Shift+Enter = nueva línea
$chatI?.addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    onSend();
  }
});

// Transformación inicial (para la primera fila creada al cargar)
transformDaysInputs(document);

