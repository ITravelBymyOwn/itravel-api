/* =========================================================
    ITRAVELBYMYOWN · PLANNER v27 (SOLUCIÓN REFORZADA)
    Base: v26
    Cambios v27:
    - Corrección de la URL API de Vercel (se usaba un placeholder).
    - Ajuste de la lógica en SECCIÓN 16/17 para aislar el prompt de GENERACIÓN de la sesión de chat.
    - El prompt de generación inicial (`generateCityItinerary`) se hace más explícito y sin historial.
    - Se maneja mejor el estado de la API en el fallback.
========================================================= */

/* ================================
    SECCIÓN 1 · Helpers / Estado
=================================== */
const qs  = (s, ctx=document)=>ctx.querySelector(s);
const qsa = (s, ctx=document)=>Array.from(ctx.querySelectorAll(s));

// !!! MUY IMPORTANTE: Cambia esta URL si tu API no está en la raíz de Vercel.
// Si el frontend está en Webflow y el backend en Vercel, debería ser la URL de Vercel.
// Si Webflow es el dominio principal y Vercel es un subdominio, verifica tu configuración.
// A modo de ejemplo, uso la estructura más común:
const API_URL = 'https://ITravelByMyOwn-api.vercel.app/api/chat'; // <-- Verifica esta URL
const MODEL   = 'gpt-4o-mini';

let savedDestinations = [];
let itineraries = {};
let cityMeta = {};
let session = []; // Historial de chat (solo para conversación y edición)
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
    SECCIÓN 4 · Utilidades de fecha (sin cambios)
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
    SECCIÓN 5 · Mensajes de chat (sin cambios)
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
    SECCIÓN 6 · UI · Filas de ciudades (sin cambios)
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
    SECCIÓN 7 · Guardar destinos (sin cambios)
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
    SECCIÓN 8 · Tabs + Render (sin cambios)
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
    SECCIÓN 9 · Render Itinerario (sin cambios)
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
    SECCIÓN 10 · Snapshot para IA (sin cambios respecto a v26)
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
      cityMeta[dest.city].perDay = Array.from({length:dest.days}, (_,i)=>({
        day:i+1, start:'08:30', end:'19:00'
      }));
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
    SECCIÓN 11 · Contrato JSON / LLM (sin cambios)
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
    SECCIÓN 12 · Llamada al agente (REFORZADO)
=================================== */
async function callAgent(text, useHistory = true){
    // Usa session como historial SOLO si useHistory es true
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
    SECCIÓN 13 · Apply / Merge (sin cambios)
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
function pushRows(city, rows, replace=false){
    if(!itineraries[city]) itineraries[city] = {byDay:{},currentDay:1,baseDate:cityMeta[city]?.baseDate||null};
    if(replace) itineraries[city].byDay = {};
    rows.forEach(r=>{
      const d = Math.max(1, parseInt(r.day||1,10));
      if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[];
      const obj = {
        day:d,
        start:r.start||'',
        end:r.end||'',
        activity:r.activity||'',
        from:r.from||'',
        to:r.to||'',
        transport:r.transport||'',
        duration:r.duration||'',
        notes:r.notes||''
      };
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
    if(meta.start)     cityMeta[name].start    = meta.start;
    if(meta.end)       cityMeta[name].end      = meta.end;
    if(typeof meta.hotel==='string') cityMeta[name].hotel = meta.hotel;
    if(itineraries[name] && meta.baseDate) itineraries[name].baseDate = meta.baseDate;
}
function applyParsedToState(parsed){
    if(parsed && parsed.itinerary) parsed = parsed.itinerary;
    if(parsed && parsed.destinos) parsed.destination = parsed.destinos;
    if(parsed && parsed.destino) parsed.destination = parsed.destino;

    if(parsed?.meta) upsertCityMeta(parsed.meta);

    if(Array.isArray(parsed?.destinations)){
      parsed.destinations.forEach(d=>{
        const name = d.name || d.destination || d.meta?.city || activeCity || savedDestinations[0]?.city;
        pushRows(name, d.rows||[], Boolean(d.replace));
      });
      return;
    }
    if(parsed?.destination && Array.isArray(parsed.rows)){
      pushRows(parsed.destination, parsed.rows, Boolean(parsed.replace));
      return;
    }
    if(Array.isArray(parsed?.rows)){
      const city = activeCity || savedDestinations[0]?.city;
      pushRows(city, parsed.rows, Boolean(parsed.replace));
    }
}

/* ================================
    SECCIÓN 14 · Fallback local inteligente (sin cambios)
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
    const d = new Date(2000,0,1,H,M,0);
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
      const e = pd.end    || '19:00';
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
    SECCIÓN 15 · Generación por ciudad (REFORZADO)
=================================== */
async function generateCityItinerary(city){
    const dest  = savedDestinations.find(x=>x.city===city);
    if(!dest) return;

    const perDay = (cityMeta[city]?.perDay && cityMeta[city].perDay.length)
      ? cityMeta[city].perDay
      : Array.from({length:dest.days}, (_,i)=>({day:i+1,start:'08:30',end:'19:00'}));

    const baseDate = cityMeta[city]?.baseDate || dest.baseDate || '';
    const hotel    = cityMeta[city]?.hotel || '';

    // PROMPT DE GENERACIÓN INICIAL MUY EXPLÍCITO
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

    // Llamada al agente SIN historial de chat (useHistory=false) para evitar que se confunda.
    let text = await callAgent(instructions, false);
    let parsed = parseJSON(text);

    // Si el agente falló o devolvió solo 'meta' (formato D), forzar reintento con prompt estricto.
    if(!parsed || (!parsed.rows && !parsed.destinations)){
      const strict = `
${FORMAT}
**REINTENTO:** Eres el planificador. Genera **SOLO** el itinerario completo para "${city}" (${dest.days} días) y devuélvelo en formato B o C.
**Ignora cualquier instrucción previa de devolver 'meta' o 'D'.** El JSON debe contener el array "rows".
`.trim();
      text = await callAgent(strict, false); // Reintento también SIN historial de chat
      parsed = parseJSON(text);
    }

    if(parsed && (parsed.rows || parsed.destinations)){
      applyParsedToState(parsed);
      renderCityTabs();
      setActiveCity(city);
      renderCityItinerary(city);
      return;
    }

    // FALLBACK LOCAL: Si todo falla (API error, JSON inválido, etc.)
    const rowsByDay = synthesizeLocalItinerary(city, dest.days, perDay);
    const rowsFlat = Object.entries(rowsByDay).flatMap(([d,rows])=>rows.map(r=>({...r, day:+d})));
    pushRows(city, rowsFlat, true);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    chatMsg('⚠️ Fallo crítico del asistente. Generé una propuesta base por día para que puedas seguir trabajando manualmente. Revisa tu configuración de Vercel.', 'ai');
}

/* ================================
    SECCIÓN 16 · Flujo principal · HOTELS (REFORZADO)
=================================== */
async function startPlanning(){
    if(savedDestinations.length===0) return;
    $chatBox.style.display='flex';
    planningStarted = true;
    collectingHotels = true;
    metaProgressIndex = 0;
    
    // El primer mensaje solo es para inicializar la sesión de chat con el 'system prompt'
    session = [];
    chatMsg(`${tone.hi}`);
    askNextHotel();
}
function askNextHotel(){
    if(metaProgressIndex >= savedDestinations.length){
      collectingHotels = false;
      chatMsg(tone.confirmAll);
      (async ()=>{
        // Generar itinerarios de forma secuencial
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
    SECCIÓN 17 · Chat handler (sin cambios respecto a v26)
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

    // 1. Añadir el mensaje de usuario a la sesión para el historial
    session.push({role: 'user', content: text});

    const day = data.currentDay || 1;
    const dayRows = (data.byDay[day]||[]).map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)';
    const allDays = Object.keys(data.byDay).map(n=>{
      const rows = data.byDay[n]||[];
      return `Día ${n}:\n${rows.map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)'}`;
    }).join('\n\n');

    // 2. Construir el prompt detallado, incluyendo TODO el contexto
    const prompt = `
${FORMAT}
**Contexto Completo del Viaje (Importante):**
${buildIntake()}

**Instrucciones de Edición para el Agente:**
- El usuario está viendo "${currentCity}", Día ${day}.
- Actividades del día actual: ${dayRows}
- Resumen de otros días (no repitas): ${allDays}
- Interpreta la solicitud final del usuario (a continuación) y actualiza solo el día ${day} del itinerario.
- Limita a 20 filas como máximo.
- Devuelve JSON formato B ("destination":"${currentCity}").

**Solicitud del usuario:** ${text}
`.trim();

    // 3. Llamar al agente usando el historial de chat (useHistory=true por defecto)
    const ans = await callAgent(prompt);
    const parsed = parseJSON(ans);

    // 4. Registrar la respuesta de followup del agente en el historial
    if(parsed?.followup) session.push({role: 'assistant', content: parsed.followup});

    if(parsed && (parsed.rows || parsed.destinations)){
      applyParsedToState(parsed);
      renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
      chatMsg(parsed.followup || 'Listo. Ajusté el día visible.', 'ai');
    }else{
      // Fallback si la edición falla. No se regenera todo, solo se notifica.
      chatMsg(parsed?.followup || 'No recibí cambios válidos del agente. Por favor, intenta de nuevo o sé más específico.','ai');
    }
}

/* ================================
    SECCIÓN 18 · Upsell/Lock + Eventos / INIT (sin cambios respecto a v26)
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
    session = []; // Resetear sesión de chat
});
$save.addEventListener('click', saveDestinations);
$start.addEventListener('click', startPlanning);
$send.addEventListener('click', onSend);
$chatI.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); onSend(); } });

$confirmCTA.addEventListener('click', lockItinerary);
$upsellClose.addEventListener('click', ()=> $upsell.style.display='none');

// ACTIVACIÓN DE LA TOOLBAR AMPLIADA CON GUARDAS (guardFeature)
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

addCityRow();
