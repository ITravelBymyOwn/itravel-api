/* =========================================================
   ITRAVELBYMYOWN · PLANNER v7.1  (compat DOM v6)
   - Mantiene EXACTAMENTE los IDs/estructura que usabas en v6:
     #cities-container, #add-city, #save-destinations, #start-planning,
     #chat-container, #chat-messages, #intake, #send-btn, #city-tabs,
     #itinerary-container, #itinerary-intro, #confirm-itinerary, etc.
   - Mejora clave: canonización de nombres de ciudad del LLM para que
     las filas SIEMPRE caigan en la pestaña correcta (evita “Barcelona, Spain”).
   - Sidebar: agrega país, fecha base con autoformato, y horas por día (08:30–18:00 por defecto).
   - Flujo hotel único con nota pequeña; no preguntamos horas/fecha si faltan.
========================================================= */

/* ====== SECCIÓN 1: Helpers / Estado ====== */
const qs  = (s, ctx=document)=>ctx.querySelector(s);
const qsa = (s, ctx=document)=>Array.from(ctx.querySelectorAll(s));

const API_URL = 'https://itravelbymyown-api.vercel.app/api/chat';

let savedDestinations = []; // [{city,country,days,baseDate,perDay:[{day,start,end}]}]
let itineraries = {};       // itineraries[city] = { byDay:{1:[rows],...}, currentDay:1, baseDate:null }
let cityMeta = {};          // cityMeta[city] = { baseDate, start, end, hotel, perDay:[] }
let session = [];
let activeCity = null;
let planningStarted = false;
let collectingHotels = false;
let metaProgressIndex = 0;
let isItineraryLocked = false;

/* ====== SECCIÓN 2: Tono / Mensajes ====== */
const tone = {
  hi: '¡Bienvenido! 👋 Soy tu concierge de viajes personal. Te guiaré ciudad por ciudad.',
  askHotel: (city)=>`¿En qué hotel/zona te vas a hospedar en <strong>${city}</strong>?`,
  smallNote: 'Si aún no lo tienes, escribe <em>pendiente</em>. Acepto nombre exacto, dirección, coordenadas o enlace de Google Maps. Más tarde te sugeriré opciones y podremos ajustar.',
  confirmAll: '✨ Perfecto. Ya tengo lo necesario. Generando itinerarios…',
  doneAll: '🎉 Todos los itinerarios fueron generados. ¿Quieres revisarlos o ajustar alguno?',
  fail: '⚠️ No se pudo contactar con el asistente.'
};

/* ====== SECCIÓN 3: Referencias DOM (IDs de v6) ====== */
const $cities = qs('#cities-container');
const $addCity = qs('#add-city');
const $save = qs('#save-destinations');
const $start = qs('#start-planning');

const $chatC = qs('#chat-container');
const $chatM = qs('#chat-messages');
const $intake = qs('#intake');
const $send = qs('#send-btn');

const $tabs = qs('#city-tabs');
const $itineraryWrap = qs('#itinerary-container');
const $intro = qs('#itinerary-intro');

const $confirmCTA = qs('#confirm-itinerary');
const $upsell = qs('#monetization-upsell');
const $upsellClose = qs('#upsell-close');

/* ====== SECCIÓN 4: Fechas / formato ====== */
function autoFormatDMYInput(el){
  if(!el) return;
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
function formatDMY(d){ const dd=String(d.getDate()).padStart(2,'0'); const mm=String(d.getMonth()+1).padStart(2,'0'); return `${dd}/${mm}/${d.getFullYear()}`; }
function addDays(d,n){ const x=new Date(d.getTime()); x.setDate(x.getDate()+n); return x; }

/* ====== SECCIÓN 5: Chat helpers ====== */
function msg(text, who='ai'){
  if(!text) return;
  const div = document.createElement('div');
  div.className = 'chat-message ' + (who==='user'?'user':'ai');
  div.innerHTML = text.replace(/\n/g,'<br>');
  $chatM.appendChild(div);
  $chatM.scrollTop = $chatM.scrollHeight;
}

/* ====== SECCIÓN 6: Normalización / Canonización de ciudad ====== */
function normalize(s){
  return (s||'').toString().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[.,]/g,' ')
    .replace(/\s+/g,' ')
    .toLowerCase();
}
function canonicalCityName(nameFromLLM){
  const n = normalize(nameFromLLM);
  // 1) exacto
  let cand = savedDestinations.find(d=>normalize(d.city)===n);
  if(cand) return cand.city;
  // 2) inclusión (ej: "barcelona spain")
  cand = savedDestinations.find(d=>{
    const a = normalize(d.city);
    return n.includes(a) || a.includes(n);
  });
  if(cand) return cand.city;
  // 3) fallback
  return savedDestinations[0]?.city || nameFromLLM || 'General';
}

/* ====== SECCIÓN 7: UI · Filas de ciudad (sobre #cities-container) ====== */
function makeHoursBlock(days){
  const wrap = document.createElement('div');
  wrap.className = 'hours-block';
  for(let d=1; d<=days; d++){
    const row = document.createElement('div');
    row.className = 'hours-day';
    row.innerHTML = `
      <span>Día ${d}</span>
      <input class="start" type="time" value="08:30">
      <input class="end"   type="time" value="18:00">
    `;
    wrap.appendChild(row);
  }
  return wrap;
}
function addCityRow(pref={city:'',country:'',days:1,baseDate:''}){
  const row = document.createElement('div');
  row.className = 'city-row';
  row.style.display = 'grid';
  row.style.gridTemplateColumns = '2fr 2fr 1fr 1.3fr auto';
  row.style.gap = '.45rem';
  row.style.alignItems = 'end';
  row.innerHTML = `
    <div>
      <label>Ciudad</label>
      <input class="city-name" type="text" placeholder="Ciudad" value="${pref.city||''}">
    </div>
    <div>
      <label>País</label>
      <input class="country-name" type="text" placeholder="País" value="${pref.country||''}">
    </div>
    <div>
      <label>Días</label>
      <input class="city-days" type="number" min="1" value="${pref.days||1}">
    </div>
    <div>
      <label>Inicio (DD/MM/AAAA)</label>
      <input class="base-date" type="text" placeholder="DD/MM/AAAA" value="${pref.baseDate||''}">
    </div>
    <div style="align-self:end">
      <button class="remove" type="button">✖</button>
    </div>
  `;
  const base = qs('.base-date', row);
  autoFormatDMYInput(base);

  const hours = makeHoursBlock(pref.days||1);
  hours.style.marginTop = '.4rem';
  row.appendChild(hours);

  qs('.remove', row).addEventListener('click', ()=> row.remove());
  qs('.city-days', row).addEventListener('change', e=>{
    let n = Math.max(1, parseInt(e.target.value||1,10));
    e.target.value = n;
    hours.innerHTML = '';
    const rebuilt = makeHoursBlock(n).children;
    Array.from(rebuilt).forEach(c=>hours.appendChild(c));
  });

  $cities.appendChild(row);
}

/* ====== SECCIÓN 8: Guardar destinos (manteniendo lógica v6) ====== */
function saveDestinations(){
  const rows = qsa('.city-row', $cities);
  const list = [];
  rows.forEach(r=>{
    const city     = qs('.city-name', r)?.value.trim() || '';
    const country  = qs('.country-name', r)?.value.trim() || '';
    const days     = Math.max(1, parseInt(qs('.city-days', r)?.value||1,10));
    const baseDate = qs('.base-date', r)?.value.trim() || '';
    if(!city) return;
    const perDay=[];
    qsa('.hours-day', r).forEach((hd,idx)=>{
      const start = qs('.start',hd)?.value || '08:30';
      const end   = qs('.end',hd)?.value   || '18:00';
      perDay.push({ day: idx+1, start, end });
    });
    list.push({ city, country, days, baseDate, perDay });
  });

  savedDestinations = list;

  // Inicializa/ajusta estructuras por ciudad
  savedDestinations.forEach(({city,days,baseDate,perDay})=>{
    if(!itineraries[city]) itineraries[city] = { byDay:{}, currentDay:1, baseDate: baseDate||null };
    if(!cityMeta[city]) cityMeta[city] = { baseDate: baseDate||null, start:null, end:null, hotel:'', perDay: perDay||[] };
    else { cityMeta[city].baseDate = baseDate||null; cityMeta[city].perDay = perDay||[]; }
    for(let d=1; d<=days; d++){ if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[]; }
  });

  // Limpia ciudades removidas
  Object.keys(itineraries).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete itineraries[c]; });
  Object.keys(cityMeta).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete cityMeta[c]; });

  renderCityTabs();
  if($intro) $intro.style.display = savedDestinations.length ? 'none' : '';
  $start.disabled = savedDestinations.length===0;
  // v7.1: NO mostramos “Destinos guardados…” en el chat.
}

/* ====== SECCIÓN 9: Tabs + Render ====== */
function setActiveCity(name){
  if(!name) return;
  activeCity = name;
  qsa('.city-tab', $tabs).forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.city === name);
  });
}
function renderCityTabs(){
  const prev = activeCity;
  $tabs.innerHTML = '';
  savedDestinations.forEach(({city})=>{
    const b = document.createElement('button');
    b.className = 'city-tab' + (city===prev?' active':'');
    b.textContent = city;
    b.dataset.city = city;
    b.addEventListener('click', ()=>{ setActiveCity(city); renderCityItinerary(city); });
    $tabs.appendChild(b);
  });
  if(savedDestinations.length){
    const valid = prev && savedDestinations.some(x=>x.city===prev) ? prev : savedDestinations[0].city;
    setActiveCity(valid); renderCityItinerary(valid);
  }else{
    activeCity=null; $itineraryWrap.innerHTML='';
  }
}
function ensureDays(city){
  const byDay = itineraries[city]?.byDay || {};
  const present = Object.keys(byDay).map(n=>+n);
  const maxPresent = present.length ? Math.max(...present) : 0;
  const want = savedDestinations.find(x=>x.city===city)?.days || maxPresent || 1;
  for(let d=1; d<=want; d++){ if(!byDay[d]) byDay[d]=[]; }
  itineraries[city].byDay = byDay;
}
function renderCityItinerary(city){
  if(!city || !itineraries[city]) return;
  ensureDays(city);
  const data = itineraries[city];
  const days = Object.keys(data.byDay).map(n=>+n).sort((a,b)=>a-b);
  $itineraryWrap.innerHTML = '';
  const base = parseDMY(data.baseDate || cityMeta[city]?.baseDate || '');

  const sections=[];
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
      </table>`;
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
        <td>${r.notes||''}</td>`;
      tb.appendChild(tr);
    });
    $itineraryWrap.appendChild(sec);
    sections.push(sec);
  });

  const pager = document.createElement('div');
  pager.className = 'pager';
  const prev = document.createElement('button'); prev.textContent = '«';
  const next = document.createElement('button'); next.textContent = '»';
  pager.appendChild(prev);
  days.forEach(d=>{ const b=document.createElement('button'); b.textContent=d; b.dataset.day=d; pager.appendChild(b); });
  pager.appendChild(next);
  $itineraryWrap.appendChild(pager);

  function show(n){
    sections.forEach((sec,i)=>sec.style.display=(days[i]===n?'block':'none'));
    qsa('button',pager).forEach(x=>x.classList.remove('active'));
    const btn=qsa('button',pager).find(x=>x.dataset.day==String(n)); if(btn) btn.classList.add('active');
    prev.classList.toggle('ghost', n===days[0]);
    next.classList.toggle('ghost', n===days.at(-1));
    itineraries[city].currentDay = n;
  }
  pager.addEventListener('click', e=>{
    const t=e.target;
    if(t===prev)      show(Math.max(days[0], (itineraries[city].currentDay||days[0])-1));
    else if(t===next) show(Math.min(days.at(-1), (itineraries[city].currentDay||days[0])+1));
    else if(t.dataset.day) show(+t.dataset.day);
  });
  show(itineraries[city].currentDay || days[0]);
}

/* ====== SECCIÓN 10: Snapshot / Intake ====== */
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
                day:+d,
                start:r.start||'', end:r.end||'',
                activity:r.activity||'',
                from:r.from||'', to:r.to||'',
                transport:r.transport||'',
                duration:r.duration||'',
                notes:r.notes||''
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
    ['adults','#p-adults'],['young','#p-young'],['children','#p-children'],['infants','#p-infants'],['seniors','#p-seniors']
  ].map(([k,id])=>`${k}:${qs(id)?.value||0}`).join(', ');

  const list = savedDestinations.map(x=>{
    const dates = x.baseDate ? `, start=${x.baseDate}` : '';
    return `${x.city} (${x.country||'—'} · ${x.days} días${dates})`;
  }).join(' | ');

  const special = qs('#special-conditions')?.value?.trim() || 'N/A';

  return [
    `Destinations: ${list}`,
    `Travelers: ${pax}`,
    `Special conditions: ${special}`,
    `Existing: ${getFrontendSnapshot()}`
  ].join('\n');
}

/* ====== SECCIÓN 11: Contrato JSON / LLM ====== */
const FORMAT = `
Devuelve SOLO JSON válido (sin markdown) en uno de estos:
A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}]}], "followup":"Pregunta breve"}
B) {"destination":"City","rows":[{...}],"followup":"Pregunta breve"}
C) {"rows":[{...}],"followup":"Pregunta breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"},"followup":"Pregunta breve"}
Reglas:
- Incluye traslados con transporte y duración (+15% colchón).
- Usa start/end por día si están disponibles; si faltan, asume 08:30–18:00.
- Si falta baseDate, devuelve itinerario sin fechas absolutas.
- Aquí solo pediremos hospedaje; usa "followup" solo si realmente falta algo.
`.trim();

/* ====== SECCIÓN 12: Llamada al agente ====== */
async function callAgent(text){
  const payload = { model:'gpt-5-nano', input:text, history:session };
  try{
    const res = await fetch(API_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(()=>({text:''}));
    return data?.text || '';
  }catch(e){
    console.error(e);
    return `{"followup":"${tone.fail}"}`
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

/* ====== SECCIÓN 13: Apply / Merge (con canonización) ====== */
function dedupeInto(arr,row){
  const key = o => [o.day,o.start||'',o.end||'',(o.activity||'').toLowerCase().trim()].join('|');
  const has = arr.find(x=>key(x)===key(row));
  if(!has) arr.push(row);
}
function pushRows(cityRaw, rows, replace=false){
  const city = canonicalCityName(cityRaw);
  if(!itineraries[city]) itineraries[city] = { byDay:{}, currentDay:1, baseDate: cityMeta[city]?.baseDate||null };
  if(replace) itineraries[city].byDay = {};
  rows.forEach(r=>{
    const d = Math.max(1, parseInt(r.day||1,10));
    if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[];
    const obj = {
      day:d, start:r.start||'', end:r.end||'',
      activity:r.activity||'', from:r.from||'', to:r.to||'',
      transport:r.transport||'', duration:r.duration||'', notes:r.notes||''
    };
    dedupeInto(itineraries[city].byDay[d], obj);
  });
  ensureDays(city);
}
function upsertCityMeta(meta){
  const name = canonicalCityName(meta.city || activeCity || savedDestinations[0]?.city);
  if(!cityMeta[name]) cityMeta[name] = { baseDate:null, start:null, end:null, hotel:'', perDay:[] };
  if(meta.baseDate) cityMeta[name].baseDate = meta.baseDate;
  if(meta.start)    cityMeta[name].start    = meta.start;
  if(meta.end)      cityMeta[name].end      = meta.end;
  if(typeof meta.hotel==='string') cityMeta[name].hotel = meta.hotel;
  if(itineraries[name] && meta.baseDate) itineraries[name].baseDate = meta.baseDate;
}
function applyParsedToState(parsed){
  if(parsed.meta) upsertCityMeta(parsed.meta);

  if(Array.isArray(parsed.destinations)){
    parsed.destinations.forEach(d=>{
      const name = d.name || d.city || d.destination || d.meta?.city || activeCity || savedDestinations[0]?.city;
      pushRows(name, d.rows||[], Boolean(d.replace));
    });
    return;
  }
  const singleName = parsed.destination || parsed.city || parsed.name;
  if(singleName && Array.isArray(parsed.rows)){
    pushRows(singleName, parsed.rows, Boolean(parsed.replace));
    return;
  }
  if(Array.isArray(parsed.rows)){
    const fallback = activeCity || savedDestinations[0]?.city;
    pushRows(fallback, parsed.rows, Boolean(parsed.replace));
  }
}

/* ====== SECCIÓN 14: Generación por ciudad ====== */
async function generateCityItinerary(city){
  const dest = savedDestinations.find(x=>x.city===city); if(!dest) return;

  const perDay = (cityMeta[city]?.perDay?.length ? cityMeta[city].perDay
                 : Array.from({length:dest.days},(_,i)=>({day:i+1,start:'08:30',end:'18:00'})));

  const baseDate = cityMeta[city]?.baseDate || dest.baseDate || '';
  const hotel    = cityMeta[city]?.hotel || '';

  const instructions = `
${FORMAT}

Eres un planificador experto. Genera el itinerario SOLO para "${city}" con ${dest.days} día(s).
- Usa estas horas por día:
${JSON.stringify(perDay)}
- BaseDate (día 1): ${baseDate||'N/A'}
- Hotel/Zona: ${hotel||'pendiente'}

Contexto global:
${buildIntake()}

Devuelve formato B con "destination":"${city}". No agregues texto fuera del JSON.
`.trim();

  const text = await callAgent(instructions);
  const parsed = parseJSON(text);
  if(parsed){
    applyParsedToState(parsed);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
  }else{
    msg(tone.fail);
  }
}

/* ====== SECCIÓN 15: Flujo principal (solo hotel) ====== */
async function startPlanning(){
  if(savedDestinations.length===0) return;
  $chatC.style.display='flex';
  planningStarted = true;
  collectingHotels = true;
  metaProgressIndex = 0;

  session = [
    {role:'system', content:'Eres un concierge de viajes internacional. Respondes SOLO con JSON válido según el formato.'},
    {role:'user',   content: buildIntake()}
  ];

  msg(tone.hi);
  askNextHotel();
}
function askNextHotel(){
  if(metaProgressIndex >= savedDestinations.length){
    collectingHotels = false;
    msg(tone.confirmAll);
    (async ()=>{
      for(const {city} of savedDestinations){ await generateCityItinerary(city); }
      msg(tone.doneAll);
    })();
    return;
  }
  const city = savedDestinations[metaProgressIndex].city;
  setActiveCity(city); renderCityItinerary(city);
  const html = `${tone.askHotel(city)}<br><small style="display:block;color:#667085;margin-top:.25rem">${tone.smallNote}</small>`;
  msg(html,'ai');
}

/* ====== SECCIÓN 16: Chat handler ====== */
async function sendChat(){
  const text = ($intake.value||'').trim();
  if(!text) return;
  msg(text,'user');
  $intake.value='';

  if(collectingHotels){
    const city = savedDestinations[metaProgressIndex].city;
    upsertCityMeta({ city, hotel:text });
    msg(`Perfecto. Hotel/Zona registrado para ${city}.`,'ai');
    metaProgressIndex++; askNextHotel();
    return;
  }

  const currentCity = activeCity || savedDestinations[0]?.city;
  const data = itineraries[currentCity];
  if(!currentCity || !data){ msg('Aún no hay itinerario en pantalla.'); return; }
  const day = data.currentDay || 1;
  const dayRows = (data.byDay[day]||[]).map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)';
  const allDays = Object.keys(data.byDay).map(n=>{
    const rows=data.byDay[n]||[];
    return `Día ${n}:\n${rows.map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n') || '(vacío)'}`;
  }).join('\n\n');

  const prompt = `
${FORMAT}
El usuario está viendo "${currentCity}", Día ${day}.
Actividades del día actual:
${dayRows}

Resumen de otros días (no repitas):
${allDays}

Interpreta su solicitud y actualiza solo el día ${day}.
Devuelve JSON formato B ("destination":"${currentCity}").
`.trim();

  const ans = await callAgent(prompt);
  const parsed = parseJSON(ans);
  if(parsed){
    applyParsedToState(parsed);
    renderCityTabs(); setActiveCity(currentCity); renderCityItinerary(currentCity);
    msg(parsed.followup || 'Listo. Ajusté el día visible.','ai');
  }else{
    msg(ans || '¿Otra cosa?','ai');
  }
}

/* ====== SECCIÓN 17: Upsell / Lock ====== */
function lockItinerary(){ isItineraryLocked = true; if($upsell) $upsell.style.display='flex'; }
function guardFeature(fn){ return (...args)=>{ if(isItineraryLocked){ if($upsell) $upsell.style.display='flex'; return; } fn(...args); }; }

/* ====== SECCIÓN 18: Eventos / INIT ====== */
$addCity?.addEventListener('click', ()=> addCityRow());
$save?.addEventListener('click', saveDestinations);
$start?.addEventListener('click', startPlanning);
$send?.addEventListener('click', sendChat);
$intake?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); sendChat(); } });

$confirmCTA?.addEventListener('click', lockItinerary);
$upsellClose?.addEventListener('click', ()=>{ if($upsell) $upsell.style.display='none'; });

// Toolbar (los IDs de tu HTML v6 siguen igual)
qs('#btn-pdf')?.addEventListener('click', guardFeature(()=>alert('Exportar PDF (demo)')));
qs('#btn-email')?.addEventListener('click', guardFeature(()=>alert('Enviar por email (demo)')));
qs('#btn-maps')?.addEventListener('click', ()=>window.open('https://maps.google.com','_blank'));
qs('#btn-transport')?.addEventListener('click', ()=>window.open('https://www.rome2rio.com/','_blank'));
qs('#btn-weather')?.addEventListener('click', ()=>window.open('https://weather.com','_blank'));
qs('#btn-clothing')?.addEventListener('click', ()=>window.open('https://www.packup.ai/','_blank'));
qs('#btn-restaurants')?.addEventListener('click', ()=>window.open('https://www.thefork.com/','_blank'));
qs('#btn-gas')?.addEventListener('click', ()=>window.open('https://www.google.com/maps/search/gas+station','_blank'));
qs('#btn-bathrooms')?.addEventListener('click', ()=>window.open('https://www.google.com/maps/search/public+restrooms','_blank'));
qs('#btn-lodging')?.addEventListener('click', ()=>window.open('https://www.booking.com','_blank'));
qs('#btn-localinfo')?.addEventListener('click', ()=>window.open('https://www.wikivoyage.org','_blank'));

// Fila inicial
addCityRow();
