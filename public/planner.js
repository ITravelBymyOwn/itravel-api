/* =========================================================
   ITRAVELBYMYOWN · PLANNER v46  (Bloque 1/3)
   Base: v45 (manteniendo TODA la funcionalidad)
   En v46:
   - Recuperado: “pensando…” (tres puntos) y overlay “Generando itinerarios…”
   - Días: <select> con placeholder (vacío) + ancho armónico en una sola línea
   - Al elegir días -> despliega horas por día con encabezados “Hora inicio / Hora final”
   - Inteligencia del agente reforzada: sustituciones, mover, auroras selectivas,
     add/remove day/city, orden de días, etc. (ver Bloques 2 y 3)
   - Consultas informativas: contesta sin proponer cambios, espera instrucción explícita
========================================================= */

/* ==============================
   SECCIÓN 1 · Helpers / Estado
================================= */
const qs  = (s, ctx=document)=>ctx.querySelector(s);
const qsa = (s, ctx=document)=>Array.from(ctx.querySelectorAll(s));

// API
const API_URL = 'https://itravelbymyown-api.vercel.app/api/chat';
const MODEL   = 'gpt-4o-mini';

// Estado
let savedDestinations = [];    // [{city,country,days,baseDate,perDay:[{day,start,end}]}]
let itineraries = {};          // { [city]: { byDay:{ [n]:Row[] }, currentDay, baseDate } }
let cityMeta = {};             // { [city]: { baseDate, start, end, hotel, transport, perDay:[] } }
let session = [];              // historial para ediciones via chat
let activeCity = null;

let planningStarted = false;
let metaProgressIndex = 0;
let collectingHotels = false;
let collectingInterests = false; // v46: desactivado, sólo hotel/transport

let isItineraryLocked = false;
let pendingChange = null;
let hasSavedOnce = false;

const DEFAULT_START = '08:30';
const DEFAULT_END   = '19:00';

/* ==============================
   SECCIÓN 2 · Tono / Mensajería
================================= */
const tone = {
  hi: '¡Hola! Soy Astra ✈️ Tu concierge personal. Vamos a construir tu aventura, ciudad por ciudad.',
  askHotelTransport: (city)=>`Para <strong>${city}</strong>, dime tu <strong>hotel/zona</strong> y el <strong>transporte</strong> (alquiler, público, taxi/uber, combinado o “recomiéndame”).`,
  confirmAll: '✨ Perfecto. Comienzo a generar tus itinerarios…',
  doneAll: '🎉 ¡Listo! Itinerarios generados. ¿Quieres ajustarlos o añadir algo especial?',
  fail: '⚠️ No se pudo contactar con el asistente. Revisa consola/Vercel (API Key, URL).',
  humanOk: 'Perfecto 🙌 Ajusté tu itinerario para que aproveches mejor el tiempo.',
  humanCancelled: 'Anotado, no apliqué cambios.',
  cityAdded: (c)=>`✅ Añadí <strong>${c}</strong> y generé su itinerario.`,
  cityRemoved: (c)=>`🗑️ Eliminé <strong>${c}</strong> de tu plan y reoptimicé las pestañas.`,
  cannotFindCity: 'No identifiqué la ciudad. Dímela con exactitud, por favor.',
};

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
const $thinking    = qs('#thinking-indicator');

/* ==============================
   SECCIÓN 4 · Chat UI + Pensando…
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

// Indicador 3 puntitos (flotante, esquina)
let thinkingTimer = null;
function showThinking(on){
  if(!$thinking) return;
  if(on){
    if(thinkingTimer) return;
    $thinking.style.display = 'block';
    thinkingTimer = setInterval(()=>{/* animado por CSS */}, 1500);
  }else{
    if(thinkingTimer){ clearInterval(thinkingTimer); thinkingTimer=null; }
    $thinking.style.display = 'none';
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
   SECCIÓN 6 · UI ciudades (con headers horas)
================================= */
function hoursHeaderRow(){
  const hdr = document.createElement('div');
  hdr.className = 'hours-day';
  hdr.innerHTML = `
    <span style="opacity:.65;">Día</span>
    <div style="font-weight:600;opacity:.8;">Hora inicio</div>
    <div style="font-weight:600;opacity:.8;">Hora final</div>
  `;
  return hdr;
}
function makeHoursBlock(days){
  const wrap = document.createElement('div');
  wrap.className = 'hours-block';
  // encabezados
  const hdr = hoursHeaderRow();
  wrap.appendChild(hdr);
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
    <label>Días
      <select class="days" style="height:36px;">
        <option value="" ${!pref.days?'selected':''} hidden></option>
        ${Array.from({length:30},(_,i)=>`<option value="${i+1}" ${(pref.days===(i+1))?'selected':''}>${i+1}</option>`).join('')}
      </select>
    </label>
    <label>Inicio<input class="baseDate" placeholder="DD/MM/AAAA" value="${pref.baseDate||''}"></label>
    <button class="remove" type="button">✕</button>
  `;
  const baseDateEl = qs('.baseDate', row);
  autoFormatDMYInput(baseDateEl);

  const hoursWrap = document.createElement('div');
  hoursWrap.className = 'hours-block';
  row.appendChild(hoursWrap);

  // despliegue cuando el usuario elija días
  const daysSelect = qs('.days', row);
  daysSelect.addEventListener('change', ()=>{
    const val = daysSelect.value;
    hoursWrap.innerHTML='';
    if(val){
      const block = makeHoursBlock(parseInt(val,10));
      // quitamos el primer <div> de “Día” para que el span “Día 1..N” encaje
      hoursWrap.appendChild(block);
    }
  });

  // Botón quitar fila
  qs('.remove',row).addEventListener('click', ()=> row.remove());
  $cityList.appendChild(row);
}

/* ==============================
   SECCIÓN 7 · Overlay y locking global
================================= */
function showWOW(on, text='Generando itinerarios...'){
  if(!$overlayWOW) return;
  $overlayWOW.style.display = on ? 'flex' : 'none';
  // mensaje
  const p = $overlayWOW.querySelector('p');
  if(p) p.textContent = text || 'Generando itinerarios...';
  // bloquear inputs
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

/* ==============================
   SECCIÓN 8 · Guardar destinos
   (se mantiene en Bloque 2 para continuidad de v45, pero
    dejamos aquí helpers usados arriba)
================================= */
/* =========================================================
   ITRAVELBYMYOWN · PLANNER v46  (Bloque 2/3)
   CONTINUACIÓN DESDE SECCIÓN 8
========================================================= */

/* ==============================
   SECCIÓN 8 · Guardar destinos
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

    if(!city || !daysVal) return; // hasta que elija días
    const perDay = [];
    // saltar el header (primer children)
    qsa('.hours-day', r).forEach((hd, idx)=>{
      if(idx===0) return; // header
      const start = qs('.start',hd).value || DEFAULT_START;
      const end   = qs('.end',hd).value   || DEFAULT_END;
      perDay.push({ day: idx, start, end });
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
  // limpiar eliminadas
  Object.keys(itineraries).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete itineraries[c]; });
  Object.keys(cityMeta).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete cityMeta[c]; });

  renderCityTabs();
  $start.disabled = savedDestinations.length===0;
  hasSavedOnce = true;
}

/* ==============================
   SECCIÓN 9 · Tabs + Render itinerario
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
- Optimiza el/los día(s) afectado(s) (min traslados, agrupa por zonas, respeta ventanas cuando existan).
- Si faltan ventanas de tiempo, puedes proponer horarios realistas (incluye nocturnas si aplica; inicio temprano permitido).
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
Eres "Astra", agente de viajes experto (40 años). 
- Actúa como guía local en cualquier ciudad.
- Incluye imperdibles de temporada automáticamente (p.ej., auroras sep–abr). 
- Puedes proponer horarios más tempranos si conviene (no restrinjas 08:30–19:00).
- Cuando el usuario pida un cambio, responde con el JSON final; evita preguntas innecesarias.
- Si el usuario hace una consulta informativa (clima, ropa, visado, etc.), SOLO responde en "followup"; NO edites itinerarios ni pidas confirmación.
- Si la instrucción menciona otra ciudad (aunque no sea la pestaña activa), edita esa ciudad.
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
/* =========================================================
   ITRAVELBYMYOWN · PLANNER v46  (Bloque 3/3)
   CONTINUACIÓN DESDE SECCIÓN 13
========================================================= */

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
          pushRows(name, (rows||[]).map(r=>({...r, day:+k})), Boolean(d.replace));
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
          pushRows(name, (rows||[]).map(r=>({...r, day:+k})), Boolean(x.replace));
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

/* ==== v46 · Manipulación de días/actividades ==== */
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
  byDay[a] = B;
  byDay[b] = A;
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

/* Optimización con IA (día/s) */
async function optimizeDay(city, day){
  const rows = (itineraries[city]?.byDay?.[day]||[]).map(r=>({
    day, start:r.start||'', end:r.end||'', activity:r.activity||'',
    from:r.from||'', to:r.to||'', transport:r.transport||'',
    duration:r.duration||'', notes:r.notes||''
  }));
  const perDay = (cityMeta[city]?.perDay||[]).find(x=>x.day===day) || {start:DEFAULT_START,end:DEFAULT_END};
  const baseDate = itineraries[city]?.baseDate || cityMeta[city]?.baseDate || '';

  const prompt = `
${FORMAT}
Ciudad: ${city}
Día: ${day}
Fecha base (d1): ${baseDate||'N/A'}
Ventanas definidas: ${JSON.stringify(perDay)} (vacías = sugiere horas lógicas; inicio temprano permitido)
Filas actuales:
${JSON.stringify(rows)}
Instrucción:
- Reordena y optimiza el día (min traslados; agrupa por zonas).
- Rellena huecos con actividades relevantes (imperdibles/experiencias cercanas).
- Considera temporada/horas de luz/actividades nocturnas (auroras si aplica).
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
}
async function optimizeTwoDays(city, a, b){
  await optimizeDay(city, a);
  if(a!==b) await optimizeDay(city, b);
}

/* ==============================
   SECCIÓN 14 · Imperdibles / Auroras selectivas
================================= */
const AURORA_CITIES = ['tromso','tromsø','rovaniemi','reykjavik','reikiavik','abisko','kiruna','fairbanks','yellowknife','murmansk'];
function monthFromBaseDate(city){
  const base = parseDMY(itineraries[city]?.baseDate || cityMeta[city]?.baseDate || '');
  return base ? (base.getMonth()+1) : null;
}
function isAuroraSeason(city){
  const m = monthFromBaseDate(city);
  if(!m) return true;
  return (m>=9 && m<=12) || (m>=1 && m<=4);
}
function insertNightActivity(city, day, label, notes){
  ensureDays(city);
  const byDay = itineraries[city].byDay;
  if(!byDay[day]) byDay[day]=[];
  const start = '21:00', end='23:30';
  const row = { day, start, end, activity:label, from:'Hotel', to:'Punto de encuentro', transport:'Tour/Bus', duration:'150m', notes };
  byDay[day] = byDay[day].filter(r => (r.end||'') < '21:00');
  byDay[day].push(row);
}
function ensureSignatureActivities(city){
  const lc = (city||'').toLowerCase();
  if(AURORA_CITIES.includes(lc) && isAuroraSeason(city)){
    const days = Object.keys(itineraries[city]?.byDay||{}).map(n=>+n).sort((a,b)=>a-b);
    if(!days.length) return;
    const target = days[0]; // por defecto día 1
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
- Respeta ventanas por día ${JSON.stringify(perDay)} (si faltan, sugiere horas; inicio temprano OK).
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
    ensureSignatureActivities(city);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    return;
  }

  // Fallback mínimo
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
      showWOW(true, 'Generando itinerarios...');
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
  m = t.match(/(?:iniciar|empezar|arrancar|inicio|comenzar)\s*(?:el día|la jornada)?\s*(?:a|a las)?\s*([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)/i);
  const startOnly = m ? normalizeHourToken(m[1]) : null;
  m = t.match(/(?:terminar|finalizar|hasta|acabar)\s*(?:a las|a)?\s*([0-9]{1,2}(?::[0-9]{2})?|\w+(?:\s+y\s+(?:media|cuarto|tres\s+cuartos))?)/i);
  const endOnly = m ? normalizeHourToken(m[1]) : null;
  return {start:startOnly, end:endOnly};
}
function detectCityInText(text){
  const lowered = text.toLowerCase();
  const list = savedDestinations.map(d=>d.city).sort((a,b)=>b.length-a.length);
  for(const c of list){
    if(lowered.includes(c.toLowerCase())) return c;
  }
  return null;
}

function intentFromText(text, currentCity){
  const t = text.toLowerCase();

  // Confirmación/cancelación para flujos internos
  if(/^(sí|si|ok|dale|hazlo|confirmo|de una|aplica)\b/.test(t)) return {type:'confirm'};
  if(/^(no|mejor no|cancela|cancelar|cancelá)\b/.test(t)) return {type:'cancel'};

  // “quedarme un día más” (insertar al final, NO el visible)
  if(/(me\s+quedo|quedarme|agrega|añade|suma)\s+un?\s+d[ií]a\s+m[aá]s/.test(t)){
    const destCity = detectCityInText(t) || currentCity;
    return {type:'add_day_end', city: destCity};
  }

  // Day-trip si viene “para ir a X”
  const addDayTrip = t.match(/(agrega|añade|suma)\s+un?\s+d[ií]a.*?\s+para\s+ir\s+a\s+([a-záéíóúüñ\s]+)/i);
  if(addDayTrip){
    return {type:'add_day_trip', place: addDayTrip[2].trim()};
  }

  // Sustitución puntual (“no quiero X”, “sustituye X”, “pon otra en lugar de X”)
  if(/(no\s+quiero|sustituye|reemplaza|cambia)\s+.+/i.test(t)){
    const m = t.match(/(?:no\s+quiero\s+ir\s+a|sustituye|reemplaza|cambia)\s+(.+?)(?:,|\.|$)/i);
    const target = m ? m[1].trim() : null;
    return {type:'swap_activity', target, details:text};
  }

  // Cambiar horas del día visible
  const range = parseTimeRangeFromText(text);
  if(range.start || range.end) return {type:'change_hours', range};

  // Mover actividad entre días
  const mv = t.match(/(?:mueve|pasa|cambia)\s+(.*?)(?:\s+del\s+d[ií]a\s+(\d+)|\s+del\s+(\d+))\s+(?:al|a)\s+(?:d[ií]a\s+)?(\d+)/i);
  if(mv){
    const query = (mv[1]||'').trim();
    const from = parseInt(mv[2] || mv[3],10);
    const to   = parseInt(mv[4],10);
    if(query) return {type:'move_activity', query, fromDay:from, toDay:to};
  }

  // Swap de días
  const swap = t.match(/(?:pasa|mueve|cambia)\s+el\s+d[ií]a\s+(\d+)\s+(?:al|a)\s+(?:d[ií]a\s+)?(\d+)/i);
  if(swap && !/actividad|museo|visita|tour|cena|almuerzo|desayuno/i.test(t)){
    return {type:'swap_day', from: parseInt(swap[1],10), to: parseInt(swap[2],10)};
  }

  // Auroras “solo en los días N y M”
  if(/aurora|auroras/.test(t)){
    const ds = [...t.matchAll(/d[ií]a[s]?\s*(\d+)/g)].map(m=>parseInt(m[1],10)).filter(Boolean);
    if(ds.length) return {type:'auroras_only_days', days: ds};
  }

  // Agregar ciudad
  const addCity = t.match(/(?:agrega|añade|suma)\s+([a-záéíóúüñ\s]+?)(?:\s+con\s+)?(\d+)\s*d[ií]as?/i);
  if(addCity){
    return {type:'add_city', city:addCity[1].trim(), days:parseInt(addCity[2],10)};
  }
  // Eliminar ciudad
  const delCity = t.match(/(?:elimina|borra|quita)\s+(?:la\s+ciudad\s+)?([a-záéíóúüñ\s]+)/i);
  if(delCity){ return {type:'remove_city', city:delCity[1].trim()}; }

  // Info pura
  if(/clima|tiempo|temperatura|lluvia|luz|horas de luz|alquiler de auto|vuelos|ropa|equipaje|visado|visa|moneda|seguridad|propina/.test(t)){
    return {type:'info_query', details:text};
  }

  const cityMention = detectCityInText(text);
  if(cityMention){ return {type:'free_edit_other', city: cityMention, details:text}; }

  return {type:'free_edit', details:text};
}

/* ==============================
   SECCIÓN 18 · Chat handler
================================= */
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

  const currentCity = activeCity || savedDestinations[0]?.city;
  const data = currentCity ? itineraries[currentCity] : null;
  if(!currentCity || !data){
    chatMsg('Aún no hay itinerario en pantalla. Inicia la planificación primero.','ai');
    return;
  }

  const intent = intentFromText(text, currentCity);

  // Confirm/cancel pendientes (si existiera flujo)
  if(intent.type==='cancel' && pendingChange){ pendingChange=null; chatMsg(tone.humanCancelled,'ai'); return; }

  // 1) Agregar día al final (quedarme un día más)
  if(intent.type==='add_day_end'){
    const city = intent.city || currentCity;
    await (async ()=>{
      showWOW(true,'Aplicando cambio…');
      ensureDays(city);
      const last = Math.max(...Object.keys(itineraries[city].byDay).map(n=>+n));
      insertDayAt(city, last+1);
      await optimizeDay(city, last+1);
      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
      showWOW(false);
      chatMsg('✅ Día agregado al final y optimizado.','ai');
    })();
    return;
  }

  // 2) Day-trip
  if(intent.type==='add_day_trip'){
    await (async ()=>{
      showWOW(true,'Insertando day-trip…');
      const city = currentCity;
      ensureDays(city);
      const last = Math.max(...Object.keys(itineraries[city].byDay).map(n=>+n));
      insertDayAt(city, last+1);
      const rows = [
        {day:last+1, start:'08:00', end:'09:30', activity:`Traslado a ${intent.place}`, from: city, to: intent.place, transport:'Tren/Bus', duration:'90m', notes:'Salida temprana'},
        {day:last+1, start:'09:40', end:'12:10', activity:`Centro histórico de ${intent.place}`, from:intent.place, to:'', transport:'A pie', duration:'150m', notes:'Puntos clave'},
        {day:last+1, start:'12:20', end:'13:50', activity:`Almuerzo en ${intent.place}`, from:intent.place, to:'', transport:'A pie', duration:'90m', notes:''},
        {day:last+1, start:'14:00', end:'16:30', activity:`Recorrido por ${intent.place}`, from:intent.place, to:'', transport:'A pie/Bus', duration:'150m', notes:''},
        {day:last+1, start:'16:40', end:'18:30', activity:`Regreso a ${city}`, from:intent.place, to: city, transport:'Tren/Bus', duration:'110m', notes:'Llegada estimada'}
      ];
      pushRows(city, rows, true);
      await optimizeDay(city, last+1);
      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
      showWOW(false);
      chatMsg('✅ Day-trip agregado y optimizado.','ai');
    })();
    return;
  }

  // 3) Sustituir actividad puntual dentro del día actual
  if(intent.type==='swap_activity'){
    await (async ()=>{
      showWOW(true,'Sustituyendo actividad…');
      const city = currentCity;
      const day  = data.currentDay || 1;
      if(intent.target){
        removeActivitiesByQuery(city, day, intent.target);
      }
      await optimizeDay(city, day); // IA agrega alternativa y ordena
      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
      showWOW(false);
      chatMsg('✅ Sustituí la actividad y reoptimicé el día.','ai');
    })();
    return;
  }

  // 4) Cambiar horas del día visible
  if(intent.type==='change_hours'){
    await (async ()=>{
      showWOW(true,'Ajustando horas…');
      const city = currentCity;
      const day = data.currentDay || 1;
      if(!cityMeta[city]) cityMeta[city]={perDay:[]};
      let pd = cityMeta[city].perDay.find(x=>x.day===day);
      if(!pd){ pd = {day, start:DEFAULT_START, end:DEFAULT_END}; cityMeta[city].perDay.push(pd); }
      if(intent.range.start) pd.start = intent.range.start;
      if(intent.range.end)   pd.end   = intent.range.end;
      await optimizeDay(city, day);
      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
      showWOW(false);
      chatMsg('✅ Ajusté los horarios y optimicé tu día.','ai');
    })();
    return;
  }

  // 5) Mover actividad (entre días)
  if(intent.type==='move_activity'){
    await (async ()=>{
      showWOW(true,'Moviendo actividad…');
      moveActivities(currentCity, intent.fromDay, intent.toDay, intent.query||'');
      await optimizeTwoDays(currentCity, intent.fromDay, intent.toDay);
      renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
      showWOW(false);
      chatMsg('✅ Moví la actividad y reoptimicé ambos días.','ai');
    })();
    return;
  }

  // 6) Swap de días
  if(intent.type==='swap_day'){
    await (async ()=>{
      showWOW(true,'Intercambiando días…');
      swapDays(currentCity, intent.from, intent.to);
      await optimizeTwoDays(currentCity, intent.from, intent.to);
      renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
      showWOW(false);
      chatMsg('✅ Intercambié el orden de esos días y optimicé.','ai');
    })();
    return;
  }

  // 7) Auroras solo en días N, M
  if(intent.type==='auroras_only_days'){
    await (async ()=>{
      showWOW(true,'Ajustando noches de auroras…');
      const city = currentCity;
      const byDay = itineraries[city]?.byDay || {};
      // eliminar auroras existentes en todos
      Object.keys(byDay).forEach(d=>{
        byDay[d] = (byDay[d]||[]).filter(r=>!/aurora/i.test(r.activity||''));
      });
      // añadir solo en los días solicitados
      intent.days.forEach(d=>{
        insertNightActivity(city, d, 'Caza de auroras', 'Tour nocturno guiado; evita conducir. Fotografía incluida.');
      });
      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
      showWOW(false);
      chatMsg('✅ Dejé caza de auroras solo en los días indicados.','ai');
    })();
    return;
  }

  // 8) Agregar ciudad
  if(intent.type==='add_city'){
    const name = intent.city?.trim();
    const days = intent.days || 2;
    if(!name){ chatMsg('Necesito el nombre de la ciudad.','ai'); return; }
    addCityRow({city:name, days, baseDate:''});
    // fuerza mostrar horas tras setear select
    const lastRow = $cityList.lastElementChild;
    const sel = qs('.days', lastRow);
    if(sel){ sel.value = String(days); sel.dispatchEvent(new Event('change')); }
    saveDestinations();
    chatMsg(tone.cityAdded(name),'ai');
    showWOW(true,'Generando itinerario…'); await generateCityItinerary(name); showWOW(false);
    return;
  }

  // 9) Eliminar ciudad
  if(intent.type==='remove_city'){
    const name = intent.city?.trim();
    if(!name){ chatMsg('Necesito el nombre de la ciudad a quitar.','ai'); return; }
    savedDestinations = savedDestinations.filter(x=>x.city!==name);
    delete itineraries[name];
    delete cityMeta[name];
    renderCityTabs();
    chatMsg(tone.cityRemoved(name),'ai');
    return;
  }

  // 10) Info (no toca itinerarios)
  if(intent.type==='info_query'){
    const ans = await callAgent(`${FORMAT}
El usuario te pide información. Responde en "followup" con un mensaje breve, cálido y útil.
No edites el itinerario.`, true);
    const parsed = parseJSON(ans);
    chatMsg(parsed?.followup || 'Aquí tienes la info.','ai');
    return;
  }

  // 11) Edición libre (misma ciudad) o sobre otra ciudad
  if(intent.type==='free_edit' || intent.type==='free_edit_other'){
    const targetCity = intent.type==='free_edit_other' ? intent.city : currentCity;
    const day = itineraries[targetCity]?.currentDay || 1;

    await (async ()=>{
      showWOW(true,'Aplicando cambio…');
      const prompt = `
${FORMAT}
**Ciudad a editar:** ${targetCity}
**Día visible (referencia):** ${day}
**Petición del usuario:** ${text}

Reglas:
- Interpreta con precisión y actualiza SÓLO los días implicados (prioriza el visible ${day} si aplica).
- Si es “un día más”, insértalo AL FINAL.
- Si es “sustituir X”, elimina X, añade alternativa y reoptimiza.
- Si mueves actividades entre días, reoptimiza ambos.
- Devuelve formato B {"destination":"${targetCity}","rows":[...],"replace": true} con las filas finales de los días afectados.
Contexto:
${buildIntake()}
`.trim();
      const ans = await callAgent(prompt, true);
      const parsed = parseJSON(ans);
      if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
        applyParsedToState(parsed);
        renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
        chatMsg(tone.humanOk,'ai');
      }else{
        chatMsg(parsed?.followup || 'No recibí cambios válidos. ¿Intentamos de otro modo?','ai');
      }
      showWOW(false);
    })();
    return;
  }
}

/* ==============================
   SECCIÓN 19 · Upsell/Lock + Eventos / INIT
================================= */
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

/* Eventos */
$addCity?.addEventListener('click', ()=>addCityRow());
qs('#reset-planner')?.addEventListener('click', ()=>{
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
$chatI?.addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    onSend();
  }
});
$confirmCTA?.addEventListener('click', lockItinerary);
$upsellClose?.addEventListener('click', ()=> $upsell.style.display='none');

/* Toolbar */
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
document.addEventListener('DOMContentLoaded', ()=>{
  if(!$cityList.querySelector('.city-row')) addCityRow();
  // no pre-expandir horas hasta que el usuario elija “Días”
});
