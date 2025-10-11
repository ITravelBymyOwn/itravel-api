/* ============================================================
   ITRAVELBYMYOWN · PLANNER (v4)
   Mantiene la arquitectura previa y añade:
   - Campo País (sidebar)
   - Autogeneración de horas por día al escribir "Días"
   - Restricciones/Condiciones especiales (sidebar)
   - Autoformato de fecha 20102025 → 20/10/2025
   - Defaults si faltan horas: 08:30–18:00
   - En meta inicial SOLO se pregunta HOSPEDAJE + nota pequeña
   - Lógica WOW, upsell y bloqueo conservados
   ============================================================ */

/* ==========================
   SECCIÓN 1 · Helpers & DOM
   ========================== */
const qs  = (s, ctx=document)=>ctx.querySelector(s);
const qsa = (s, ctx=document)=>Array.from(ctx.querySelectorAll(s));
const ce  = (tag, cls)=>{ const el=document.createElement(tag); if(cls) el.className=cls; return el; };

const $cityList         = qs('#city-list');
const $addCity          = qs('#add-city-btn');
const $save             = qs('#save-destinations');
const $reset            = qs('#reset-planner');
const $start            = qs('#start-planning');
const $chatC            = qs('#chat-container');
const $chatM            = qs('#chat-messages');
const $chatInput        = qs('#chat-input');
const $send             = qs('#send-btn');
const $tabs             = qs('#city-tabs');
const $wrap             = qs('#itinerary-container');
const $intro            = qs('#itinerary-intro');
const $confirm          = qs('#confirm-itinerary');
const $upsell           = qs('#monetization-upsell');
const $upsellClose      = qs('#upsell-close');

const travelerIds = ['p-adults','p-young','p-children','p-infants','p-seniors'];
const API_URL     = 'https://itravelbymyown-api.vercel.app/api/chat';
const DEFAULT_START = '08:30';
const DEFAULT_END   = '18:00';

/* Estado principal */
let savedDestinations = [];  // [{city,country,days,order,baseDate?}]
let itineraries       = {};  // { [city]: { byDay:{1:[rows],...}, currentDay:1, baseDate:'DD/MM/YYYY' } }
let cityMeta          = {};  // { [city]: { baseDate:null|str, start:str|[str], end:str|[str], hotel:'' } }
let session           = [];
let activeCity        = null;
let isItineraryLocked = false;

/* Conversación / meta */
let planningStarted   = false;
let metaProgressIndex = 0;     // índice de ciudad para pedir hospedaje
let collectingMeta    = false;
let awaitingMetaReply = false;
let batchGenerating   = false;

/* ==========================
   SECCIÓN 2 · Idioma y tono
   ========================== */
function detectLang(){
  const n=(navigator.language||'en').toLowerCase();
  if(n.startsWith('es')) return 'es';
  if(n.startsWith('pt')) return 'pt';
  if(n.startsWith('fr')) return 'fr';
  return 'en';
}
const LANG = detectLang();
const tone = {
  es: {
    hi: '¡Bienvenido! 👋 Soy tu concierge de viajes personal.',
    askHotel: (city)=>`¿En qué <strong>hotel/zona</strong> te vas a hospedar en <strong>${city}</strong>?`,
    askHotelNote: ' <small style="display:block;color:#667085;margin-top:.25rem">Si aún no lo tienes, escribe <em>pendiente</em>. Acepto nombre exacto, dirección, coordenadas o enlace de Google Maps. Más tarde sugeriré opciones y podremos ajustar.</small>',
    doneAll: 'Perfecto 🎉 Ya tengo lo necesario. Generando itinerarios...',
    generatedAll: '✨ Todos los itinerarios fueron generados. ¿Quieres revisarlos o ajustar alguno?',
  },
  en: {
    hi: 'Welcome! 👋 I’m your personal travel concierge.',
    askHotel: (city)=>`Where will you <strong>stay</strong> in <strong>${city}</strong>? (hotel/area)`,
    askHotelNote: ' <small style="display:block;color:#667085;margin-top:.25rem">If you don’t know yet, write <em>pending</em>. I accept hotel name, address, coordinates or Google Maps link. I’ll suggest options later.</small>',
    doneAll: 'Great 🎉 I have everything. Generating itineraries...',
    generatedAll: '✨ All itineraries are ready. Want to review or tweak any city?',
  },
  fr: {
    hi: 'Bienvenue ! 👋 Je suis votre concierge de voyage.',
    askHotel: (city)=>`Dans quel <strong>hôtel/quartier</strong> logerez-vous à <strong>${city}</strong> ?`,
    askHotelNote: ' <small style="display:block;color:#667085;margin-top:.25rem">Si vous ne savez pas encore, écrivez <em>en attente</em>. Nom d’hôtel, adresse, coordonnées ou lien Google Maps acceptés. Je proposerai des options ensuite.</small>',
    doneAll: 'Parfait 🎉 Je lance la génération des itinéraires...',
    generatedAll: '✨ Tous les itinéraires sont prêts. Souhaitez-vous réviser ou ajuster ?',
  },
  pt: {
    hi: 'Bem-vindo! 👋 Sou o seu concierge de viagens.',
    askHotel: (city)=>`Onde vai se <strong>hospedar</strong> em <strong>${city}</strong>? (hotel/bairro)`,
    askHotelNote: ' <small style="display:block;color:#667085;margin-top:.25rem">Se ainda não tem, escreva <em>pendente</em>. Aceito nome, endereço, coordenadas ou link do Maps. Depois sugiro opções.</small>',
    doneAll: 'Perfeito 🎉 Vou gerar os roteiros...',
    generatedAll: '✨ Todos os roteiros prontos. Quer revisar ou ajustar algum?',
  }
}[detectLang()];

/* ==========================
   SECCIÓN 3 · Fecha helpers
   ========================== */
function parseDMY(str){
  if(!str) return null;
  const mFull = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  const mCompact = str.match(/^(\d{2})(\d{2})(\d{4})$/);
  let d,m,y;
  if(mFull){ d=+mFull[1]; m=+mFull[2]-1; y=+mFull[3]; }
  else if(mCompact){ d=+mCompact[1]; m=+mCompact[2]-1; y=+mCompact[3]; }
  else return null;
  const dt=new Date(y,m,d);
  if(dt.getMonth()!==m || dt.getDate()!==d) return null;
  return dt;
}
function formatDMY(d){
  if(!(d instanceof Date)) return d||null;
  const dd=String(d.getDate()).padStart(2,'0');
  const mm=String(d.getMonth()+1).padStart(2,'0');
  const yy=d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}
function addDays(d, n){ const x=new Date(d.getTime()); x.setDate(x.getDate()+n); return x; }
function autoFormatDateInput(input){
  let v=input.value.replace(/\D/g,'');
  if(v.length===8){ input.value=`${v.slice(0,2)}/${v.slice(2,4)}/${v.slice(4)}`; }
}

/* ======================================
   SECCIÓN 4 · Sidebar destinos (UI rows)
   ====================================== */
function addCityRow(pref={city:'', country:'', days:'', baseDate:''}){
  const row = ce('div','city-row');
  const iCity = ce('input'); iCity.placeholder='Ciudad'; iCity.value=pref.city||'';
  const iCountry = ce('input'); iCountry.placeholder='País'; iCountry.value=pref.country||'';
  const iDays = ce('input'); iDays.type='number'; iDays.min='1'; iDays.placeholder='Días'; iDays.value=pref.days||'';
  const iDate = ce('input'); iDate.placeholder='DD/MM/AAAA (opcional)'; iDate.value=pref.baseDate||'';
  iDate.addEventListener('input', ()=>autoFormatDateInput(iDate));
  const bDel = ce('button','remove'); bDel.textContent='✕'; bDel.onclick=()=>{ row.nextElementSibling?.classList?.contains('hours-block')&&row.nextElementSibling.remove(); row.remove(); validateSave(); };
  row.append(iCity,iCountry,iDays,iDate,bDel);
  $cityList.appendChild(row);

  // bloque dinámico de horas por día
  iDays.addEventListener('input', ()=>renderHoursBlock(row, Math.max(0, parseInt(iDays.value||'0',10))));
  validateSave();
}
function renderHoursBlock(row, nDays){
  let hours = row.nextElementSibling;
  if(!hours || !hours.classList.contains('hours-block')){
    hours = ce('div','hours-block'); row.after(hours);
  }
  hours.innerHTML='';
  if(nDays<=0) return;
  const grid = ce('div','grid-days');
  for(let d=1; d<=nDays; d++){
    const wrap = ce('div','hours-day');
    const label = ce('label'); label.textContent=`Día ${d}`;
    const iStart = ce('input'); iStart.type='time'; iStart.value=DEFAULT_START;
    const iEnd   = ce('input'); iEnd.type='time'; iEnd.value=DEFAULT_END;
    wrap.append(label,iStart,iEnd);
    grid.appendChild(wrap);
  }
  hours.appendChild(grid);
}
$addCity.addEventListener('click', ()=>{ addCityRow(); });

function validateSave(){
  const rows=qsa('.city-row',$cityList);
  const ok = rows.length>0 && rows.every(r=>{
    const c=r.children[0].value.trim(); const p=r.children[1].value.trim();
    const d=parseInt(r.children[2].value,10); return c && p && d>0;
  });
  $save.disabled=!ok; $start.disabled=savedDestinations.length===0;
}
$cityList.addEventListener('input', validateSave);

/* =================================================
   SECCIÓN 5 · Guardar destinos + sincronizar estado
   ================================================= */
$save.addEventListener('click', ()=>{
  const rows=qsa('.city-row',$cityList);
  const list = rows.map((r,idx)=>{
    const [iCity,iCountry,iDays,iDate] = [r.children[0],r.children[1],r.children[2],r.children[3]];
    const baseDate = iDate.value.trim();
    // horas por día
    let starts=[], ends=[];
    const hrsBlock = r.nextElementSibling?.classList?.contains('hours-block') ? r.nextElementSibling : null;
    if(hrsBlock){
      qsa('.hours-day', hrsBlock).forEach((hd)=>{
        const st=hd.children[1].value||DEFAULT_START;
        const en=hd.children[2].value||DEFAULT_END;
        starts.push(st); ends.push(en);
      });
    }
    if(starts.length===0){ // defaults si no colocó bloque
      const nd = Math.max(1, parseInt(iDays.value||'1',10));
      starts=Array(nd).fill(DEFAULT_START); ends=Array(nd).fill(DEFAULT_END);
    }
    // guarda meta
    const city=iCity.value.trim();
    if(!cityMeta[city]) cityMeta[city]={ baseDate:null, start:null, end:null, hotel:'' };
    cityMeta[city].baseDate = baseDate || null;
    cityMeta[city].start = starts.length===1?starts[0]:starts;
    cityMeta[city].end   = ends.length===1?ends[0]:ends;

    return { city, country:iCountry.value.trim(), days:Math.max(1,parseInt(iDays.value,10)||1), order:idx+1, baseDate };
  }).filter(x=>x.city && x.country);

  // ordenar y fijar estructuras
  savedDestinations = list;
  savedDestinations.forEach(({city,days,baseDate})=>{
    if(!itineraries[city]) itineraries[city]={ byDay:{}, currentDay:1, baseDate:null };
    if(baseDate) itineraries[city].baseDate=baseDate;
    const present=Object.keys(itineraries[city].byDay).length;
    if(present<days){ for(let d=present+1; d<=days; d++) itineraries[city].byDay[d]=itineraries[city].byDay[d]||[]; }
    if(present>days){
      const trimmed={}; for(let d=1; d<=days; d++) trimmed[d]=itineraries[city].byDay[d]||[];
      itineraries[city].byDay=trimmed; if(itineraries[city].currentDay>days) itineraries[city].currentDay=days;
    }
  });
  // eliminar ciudades removidas
  Object.keys(itineraries).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete itineraries[c]; });
  Object.keys(cityMeta).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete cityMeta[c]; });

  renderCityTabs();
  msg('✅ Destinos guardados. Cuando quieras dale a “Iniciar planificación”.');
  $start.disabled = savedDestinations.length===0;
});

/* ===========================================
   SECCIÓN 6 · Tabs y renderizado de itinerario
   =========================================== */
function setActiveCity(name){
  if(!name) return;
  activeCity=name;
  qsa('.city-tab',$tabs).forEach(b=>b.classList.toggle('active', b.dataset.city===name));
}
function renderCityTabs(){
  const prev=activeCity; $tabs.innerHTML='';
  savedDestinations.forEach(({city})=>{
    const b=ce('button','city-tab'); b.textContent=city; b.dataset.city=city;
    b.addEventListener('click',()=>{ setActiveCity(city); renderCityItinerary(city); });
    if(city===prev) b.classList.add('active'); $tabs.appendChild(b);
  });
  if(savedDestinations.length){
    $intro.style.display='none';
    const valid = prev && savedDestinations.some(x=>x.city===prev) ? prev : savedDestinations[0].city;
    setActiveCity(valid); renderCityItinerary(valid);
  }else{
    $intro.style.display=''; $wrap.innerHTML=''; activeCity=null;
  }
}
function renderCityItinerary(city){
  if(!city || !itineraries[city]) return;
  const data=itineraries[city]; const days=Object.keys(data.byDay||{}).map(n=>+n).sort((a,b)=>a-b);
  $wrap.innerHTML='';
  if(!days.length){ $wrap.innerHTML='<p>No hay actividades aún. El asistente las añadirá.</p>'; return; }

  const base = parseDMY(data.baseDate || cityMeta[city]?.baseDate || '');
  const sections=[];
  days.forEach(dayNum=>{
    const sec=ce('div'); sec.className='day-section';
    const dateLabel = base ? ` (${formatDMY(addDays(base, dayNum-1))})` : '';
    sec.innerHTML = `
      <div class="day-title">Día ${dayNum}${dateLabel}</div>
      <table class="itinerary">
        <thead>
          <tr>
            <th>Inicio</th><th>Fin</th><th>Actividad</th><th>Desde</th>
            <th>Hacia</th><th>Transporte</th><th>Duración</th><th>Notas</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>`;
    const tb=qs('tbody',sec);
    (data.byDay[dayNum]||[]).forEach(r=>{
      const tr=ce('tr');
      tr.innerHTML=`
        <td>${r.start||''}</td><td>${r.end||''}</td><td>${r.activity||''}</td>
        <td>${r.from||''}</td><td>${r.to||''}</td><td>${r.transport||''}</td>
        <td>${r.duration||''}</td><td>${r.notes||''}</td>`;
      tb.appendChild(tr);
    });
    $wrap.appendChild(sec); sections.push(sec);
  });

  const pager=ce('div','pager');
  const prev=ce('button'); prev.textContent='«';
  const next=ce('button'); next.textContent='»';
  pager.append(prev); days.forEach(d=>{ const b=ce('button'); b.textContent=d; b.dataset.day=d; pager.appendChild(b); }); pager.append(next);
  $wrap.appendChild(pager);

  function show(n){
    sections.forEach((sec,i)=>sec.style.display=days[i]===n?'block':'none');
    qsa('button',pager).forEach(x=>x.classList.remove('active'));
    const btn=qsa('button',pager).find(x=>x.dataset.day==String(n)); if(btn) btn.classList.add('active');
    prev.classList.toggle('ghost', n===days[0]); next.classList.toggle('ghost', n===days.at(-1));
    if(itineraries[city]) itineraries[city].currentDay=n;
  }
  pager.addEventListener('click', e=>{
    const t=e.target;
    if(t===prev) show(Math.max(days[0], (itineraries[city]?.currentDay||days[0])-1));
    else if(t===next) show(Math.min(days.at(-1), (itineraries[city]?.currentDay||days[0])+1));
    else if(t.dataset.day) show(+t.dataset.day);
  });
  show(itineraries[city]?.currentDay||days[0]);
}

/* ===================================
   SECCIÓN 7 · Chat UI (mensajería)
   =================================== */
function msg(text, who='ai'){
  if(!text) return;
  const div=ce('div','chat-message ' + (who==='user'?'user':'ai'));
  if(/^\s*\{[\s\S]*\}\s*$/.test(text)) text='✅ Itinerario actualizado en la interfaz.';
  if(text.length>1200) text=text.slice(0,1200)+'…';
  div.innerHTML = text.replace(/\n/g,'<br>');
  $chatM.appendChild(div); $chatM.scrollTop=$chatM.scrollHeight;
}

/* =======================================
   SECCIÓN 8 · API/LLM + contrato de datos
   ======================================= */
async function callAgent(payload){
  try{
    const res = await fetch(API_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }catch(e){
    console.error(e);
    return { text: '{"followup":"⚠️ No se pudo contactar con el asistente."}' };
  }
}
function parseJSON(text){
  if(!text) return null;
  try{ return JSON.parse(text); }catch(_){}
  const m=text.match(/```json\s*([\s\S]*?)```/i)||text.match(/```([\s\S]*?)```/i);
  if(m&&m[1]){ try{ return JSON.parse(m[1]); }catch(_){ } }
  const m2=text.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
  if(m2&&m2[1]){ try{ return JSON.parse(m2[1]); }catch(_){ } }
  try{
    const cleaned=text.replace(/^[^\{]+/,'').replace(/[^\}]+$/,'');
    return JSON.parse(cleaned);
  }catch(_){ return null; }
}

function buildIntake(){
  const pax = Object.fromEntries(travelerIds.map(id=>[id.replace('p-',''), (qs('#'+id).value||'0')]));
  const sc  = qs('#special-conditions').value.trim();
  const dests = savedDestinations.map(d=>({
    name:d.city, country:d.country, days:d.days, baseDate: d.baseDate||null,
    meta: cityMeta[d.city]||{}
  }));
  return { pax, specialConditions:sc, destinations:dests };
}

const FORMAT = `
Devuelve SOLO JSON (sin texto extra) con alguno de estos formatos:
A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}]}], "followup":"Pregunta breve"}
B) {"destination":"City","rows":[{...}],"followup":"Pregunta breve"}
C) {"rows":[{...}],"followup":"Pregunta breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"},"followup":"Pregunta breve"}
Reglas:
- Incluye traslados con transporte y duración (+15% colchón).
- Si faltan datos, pregúntalo en "followup" y asume valores razonables.
- Nada de markdown. Solo JSON.`.trim();

/* =======================================================
   SECCIÓN 9 · Generación por ciudad (cuando hay la meta)
   ======================================================= */
function metaIsComplete(m){ return !!(m && (m.start && m.end) && typeof m.hotel==='string'); }

async function generateCityItinerary(city){
  const conf = cityMeta[city] || {};
  const days = (savedDestinations.find(x=>x.city===city)?.days) || 1;
  const instructions = `
${FORMAT}
Eres un planificador experto. Genera el itinerario SOLO para "${city}" con ${days} días.
- Prioriza imperdibles y optimiza tiempos/orden.
- Usa horas indicadas por día (si hay arrays) o default ${DEFAULT_START}-${DEFAULT_END}.
- Si no hay baseDate, no pongas fechas, solo "Día N".
- Devuelve formato B con "destination":"${city}".
Contexto: ${JSON.stringify({ meta:conf, special:qs('#special-conditions').value||'' })}`.trim();

  const payload = { model:'gpt-5-nano', input: instructions, history: session };
  const res = await callAgent(payload);
  const raw = res?.text || '';
  session.push({role:'assistant', content: raw});
  const parsed = parseJSON(raw);
  if(parsed){
    applyParsedToState(parsed,false);
    if(itineraries[city] && conf.baseDate) itineraries[city].baseDate = conf.baseDate;
    setActiveCity(city); renderCityItinerary(city);
    if(parsed.followup) msg(parsed.followup,'ai');
  }else{
    msg(`❌ No pude interpretar el itinerario para ${city}.`,'ai');
  }
}

async function maybeGenerateAllCities(){
  batchGenerating=true;
  for(const {city} of savedDestinations){
    const m=cityMeta[city]; const hasRows=Object.values(itineraries[city]?.byDay||{}).some(a=>a.length>0);
    if(metaIsComplete(m) && !hasRows){ await generateCityItinerary(city); }
  }
  batchGenerating=false; msg(tone.generatedAll,'ai');
}

/* =============================================
   SECCIÓN 10 · Start (flujo de meta: hospedaje)
   ============================================= */
async function askForNextCityHotel(){
  if(awaitingMetaReply) return;
  if(metaProgressIndex >= savedDestinations.length){
    collectingMeta=false; msg(tone.doneAll,'ai'); await maybeGenerateAllCities(); return;
  }
  const city=savedDestinations[metaProgressIndex].city;
  awaitingMetaReply=true;
  msg(tone.askHotel(city) + tone.askHotelNote, 'ai');
}
async function startPlanning(){
  if(savedDestinations.length===0){ alert('Agrega y guarda destinos primero.'); return; }
  $chatC.style.display='block';
  planningStarted=true; collectingMeta=true; awaitingMetaReply=false; metaProgressIndex=0;
  session=[
    {role:'system', content:'Eres un concierge de viajes. Devuelves itinerarios en JSON limpio según el formato.'},
    {role:'user', content: JSON.stringify(buildIntake()) }
  ];
  msg(`${tone.hi} Te guiaré por ciudad.`, 'ai');
  await askForNextCityHotel();
}
$start.addEventListener('click', startPlanning);

/* =========================================
   SECCIÓN 11 · Merge helpers y actualización
   ========================================= */
function ensureDays(city){
  const byDay=itineraries[city].byDay||{};
  const present=Object.keys(byDay).map(n=>+n);
  const maxPresent=present.length?Math.max(...present):0;
  const saved=savedDestinations.find(x=>x.city===city)?.days||0;
  const want=Math.max(saved,maxPresent);
  const have=present.length;
  if(have<want){ for(let d=have+1; d<=want; d++) itineraries[city].byDay[d]=itineraries[city].byDay[d]||[]; }
  if(have>want){ const trimmed={}; for(let d=1; d<=want; d++) trimmed[d]=byDay[d]||[]; itineraries[city].byDay=trimmed; }
}
function dedupeInto(arr,row){
  const key=o=>[o.day,o.start||'',o.end||'',(o.activity||'').trim().toLowerCase()].join('|');
  const has=arr.find(x=>key(x)===key(row)); if(!has) arr.push(row);
}
function pushRows(city, rows, replace=false){
  if(!itineraries[city]) itineraries[city]={byDay:{}, currentDay:1, baseDate:null};
  if(replace) itineraries[city].byDay={};
  rows.forEach(r=>{
    const d=Math.max(1,parseInt(r.day||1,10));
    if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[];
    const row={ day:d,start:r.start||'',end:r.end||'',activity:r.activity||'',from:r.from||'',to:r.to||'',transport:r.transport||'',duration:r.duration||'',notes:r.notes||'' };
    dedupeInto(itineraries[city].byDay[d],row);
  });
  ensureDays(city);
}
function upsertCityMeta(meta){
  const name=meta.city || activeCity || savedDestinations[0]?.city; if(!name) return;
  if(!cityMeta[name]) cityMeta[name]={ baseDate:null,start:null,end:null,hotel:'' };
  if(meta.baseDate) cityMeta[name].baseDate=meta.baseDate;
  if(meta.start)    cityMeta[name].start=meta.start;
  if(meta.end)      cityMeta[name].end=meta.end;
  if(typeof meta.hotel==='string') cityMeta[name].hotel=meta.hotel;
  if(itineraries[name] && meta.baseDate){ itineraries[name].baseDate=meta.baseDate; }
}
function applyParsedToState(parsed, forceReplaceAll=false){
  const rootReplace=Boolean(parsed.replace)||forceReplaceAll;
  if(parsed.meta && parsed.meta.city){ upsertCityMeta(parsed.meta); }
  if(Array.isArray(parsed.destinations)){
    parsed.destinations.forEach(d=>{
      if(d.meta && d.meta.city) upsertCityMeta(d.meta);
      const name=d.name || d.meta?.city || activeCity || savedDestinations[0]?.city || 'General';
      const destReplace=rootReplace||Boolean(d.replace);
      pushRows(name, d.rows||[], destReplace);
    }); return;
  }
  if(parsed.destination && Array.isArray(parsed.rows)){ pushRows(parsed.destination, parsed.rows, rootReplace); return; }
  if(Array.isArray(parsed.rows)){ pushRows(activeCity || savedDestinations[0]?.city || 'General', parsed.rows, rootReplace); }
}

/* ============================================
   SECCIÓN 12 · Chat principal (incluye la meta)
   ============================================ */
async function sendChat(){
  const text=($chatInput.value||'').trim(); if(!text) return;
  if(isItineraryLocked){ showUpsell(); return; }
  msg(text,'user'); $chatInput.value='';

  // Fase de hospedaje
  if(collectingMeta){
    const city = savedDestinations[metaProgressIndex]?.city;
    if(!city){ collectingMeta=false; await maybeGenerateAllCities(); return; }
    // cualquier texto se acepta como hotel; si escribe pendiente, guardamos "Pendiente"
    const h = text.toLowerCase().includes('pend') ? 'Pendiente' : text;
    cityMeta[city] = cityMeta[city] || { baseDate:null,start:null,end:null,hotel:'' };
    cityMeta[city].hotel = h;
    awaitingMetaReply=false; metaProgressIndex++;
    if(metaProgressIndex < savedDestinations.length){ await askForNextCityHotel(); }
    else{ collectingMeta=false; msg(tone.doneAll,'ai'); await maybeGenerateAllCities(); }
    return;
  }

  // Edición libre (día visible)
  const targetCity = activeCity || savedDestinations[0]?.city;
  const dCur = itineraries[targetCity]?.currentDay || 1;
  const currentRows = (itineraries[targetCity]?.byDay?.[dCur]||[]).map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n')||'(vacío)';
  const prompt = `
${FORMAT}
El usuario está viendo "${targetCity}", DÍA ${dCur}.
Actividades actuales del día ${dCur}:
${currentRows}

Debes interpretar su petición y devolver solo JSON formato B con "destination":"${targetCity}" (cambios del día ${dCur}).`;
  const res = await callAgent({ model:'gpt-5-nano', input: prompt, history: session });
  const raw = res?.text || ''; session.push({role:'assistant', content: raw});
  const parsed = parseJSON(raw);
  if(parsed){ applyParsedToState(parsed,false); renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity); msg(parsed.followup || 'Listo. ¿Otro ajuste?','ai'); }
  else msg(raw || 'Listo.','ai');
}
$send.addEventListener('click', sendChat);
$chatInput.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); sendChat(); } });

/* ============================================
   SECCIÓN 13 · Toolbar + acciones auxiliares
   ============================================ */
function requireUnlocked(action){
  if(isItineraryLocked){ showUpsell(); return false; } return true;
}
qs('#btn-pdf').onclick        = ()=>{ if(!requireUnlocked()) return; alert('Exportar PDF (stub)'); };
qs('#btn-email').onclick      = ()=>{ if(!requireUnlocked()) return; alert('Enviar email (stub)'); };
qs('#btn-maps').onclick       = ()=>window.open('https://maps.google.com','_blank');
qs('#btn-transport').onclick  = ()=>window.open('https://moovitapp.com','_blank');
qs('#btn-weather').onclick    = ()=>window.open('https://weather.com','_blank');
qs('#btn-clothing').onclick   = ()=>alert('Sugerencias de ropa según clima (próximo)');
qs('#btn-restaurants').onclick= ()=>window.open('https://www.google.com/maps/search/restaurants/','_blank');
qs('#btn-gas').onclick        = ()=>window.open('https://www.google.com/maps/search/gas+station/','_blank');
qs('#btn-bathrooms').onclick  = ()=>window.open('https://www.refugerestrooms.org/','_blank');
qs('#btn-lodging').onclick    = ()=>window.open('https://www.google.com/maps/search/hotels/','_blank');
qs('#btn-localinfo').onclick  = ()=>window.open('https://www.wikivoyage.org/','_blank');

/* ============================================
   SECCIÓN 14 · Confirmar (lock) + upsell modal
   ============================================ */
$confirm.addEventListener('click', ()=>{ isItineraryLocked=true; alert('Itinerario fijado. Funciones de edición/exportación bloqueadas en Free.'); });
function showUpsell(){ $upsell.style.display='flex'; }
$upsellClose?.addEventListener('click', ()=>{ $upsell.style.display='none'; });

/* ============================================
   SECCIÓN 15 · INIT + reset + fila inicial
   ============================================ */
function resetPlanner(){
  savedDestinations=[]; itineraries={}; cityMeta={}; session=[]; activeCity=null;
  $cityList.innerHTML=''; $tabs.innerHTML=''; $wrap.innerHTML=''; $intro.style.display='';
  isItineraryLocked=false; planningStarted=false; collectingMeta=false; awaitingMetaReply=false; metaProgressIndex=0;
  addCityRow(); validateSave();
}
$reset.addEventListener('click', resetPlanner);

// fila inicial
addCityRow(); validateSave();
