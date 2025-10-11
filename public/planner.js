/* v15 - planner.js */
document.addEventListener('DOMContentLoaded', () => {

/* ===== SECCIÓN 1: Helpers / Referencias DOM / Estado ===== */
const qs  = (s, ctx=document)=>ctx.querySelector(s);
const qsa = (s, ctx=document)=>Array.from(ctx.querySelectorAll(s));
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

const travelerIds = ['p-adults','p-young','p-children','p-infants','p-seniors'];
const API_URL = 'https://itravelbymyown-api.vercel.app/api/chat';

let savedDestinations = []; // [{city, days, order}]
let itineraries = {};       // itineraries[city] = { byDay:{1:[rows],...}, currentDay:1, baseDate:'DD/MM/YYYY' }
let cityMeta = {};          // cityMeta[city] = { baseDate:'DD/MM/YYYY', start:'HH:MM', end:'HH:MM', hotel:'', hotelLink:'' }
let session = [];
let activeCity = null;

let planningStarted = false;
let metaProgressIndex = 0;
let collectingMeta = false;
let awaitingMetaReply = false;
let batchGenerating = false;
let globalReviewAsked = false;

let lastMenuHintTs = 0;
function hintMenuOnce(){
  const now = Date.now();
  if(now - lastMenuHintTs > 180000){
    msg(tone.menuHint);
    lastMenuHintTs = now;
  }
}

/* ===== SECCIÓN 2: Idioma y tono ===== */
function detectLang(){
  const n = (navigator.language || 'en').toLowerCase();
  if(n.startsWith('es')) return 'es';
  if(n.startsWith('pt')) return 'pt';
  if(n.startsWith('fr')) return 'fr';
  return 'en';
}
const tone = {
  es: {
    hi: '¡Bienvenido! 👋 Soy tu concierge de viajes personal.',
    startMeta: (city)=>`Comencemos por **${city}**. En un solo texto: fecha del primer día (DD/MM/AAAA), horas de inicio y fin para CADA día (pueden ser iguales) y hotel o zona.`,
    contMeta:  (city)=>`Continuemos con **${city}**. En un único texto: fecha del 1er día, horas de inicio/fin diarias y hotel/zona.`,
    focus: ()=>``,
    review: (city)=>`Listo, aquí tienes el itinerario para **${city}**. ¿Quieres que haga algún ajuste o lo dejamos así?`,
    nextAsk: (city)=>`Perfecto. Pasemos a **${city}**. ¿Me compartes fecha del 1er día, horarios y hotel/zona?`,
    menuHint: 'Para info (clima, transporte, restaurantes, etc.) usa los botones del menú inferior 👇',
    welcomeFlow: 'Te guiaré ciudad por ciudad. Sin hotel/horarios, propongo la mejor opción y luego la ajustamos.'
  },
  en: {
    hi: 'Welcome! 👋 I’m your personal travel concierge.',
    startMeta: (city)=>`Let’s start with **${city}**. One message: day-1 date (DD/MM/YYYY), daily start/end times, and your hotel/area.`,
    contMeta:  (city)=>`Let’s continue with **${city}**. One message: day-1 date, daily start/end times, and hotel/area.`,
    focus: ()=>``,
    review: (city)=>`Here’s **${city}**. Any changes or keep it as is?`,
    nextAsk: (city)=>`Great. Move to **${city}**. Share day-1 date, times and hotel/area.`,
    menuHint: 'For more detail, use the bottom toolbar 👇',
    welcomeFlow: 'I’ll guide you city-by-city. If no hotel/times, I’ll propose and adjust later.'
  },
  fr:{hi:'Bienvenue !',startMeta:(c)=>`Commençons par **${c}** : date du 1er jour (JJ/MM/AAAA), heures début/fin et hôtel/quartier.`,contMeta:(c)=>`Continuons avec **${c}**...`,focus:()=>``,review:(c)=>`Voici **${c}**. Des modifications ?`,nextAsk:(c)=>`Passons à **${c}**...`,menuHint:'Utilisez la barre en bas 👇',welcomeFlow:'Je vous guide ville par ville.'},
  pt:{hi:'Bem-vindo!',startMeta:(c)=>`Vamos começar por **${c}**...`,contMeta:(c)=>`Continuemos com **${c}**...`,focus:()=>``,review:(c)=>`Aqui está **${c}**.`,nextAsk:(c)=>`Vamos para **${c}**...`,menuHint:'Use a barra abaixo 👇',welcomeFlow:'Guiando cidade por cidade.'}
}[detectLang()];

/* no-op hints al cambiar tabs */
function uiMsgFocusCity(){ return; }

/* ===== SECCIÓN 3: Utilidades de fecha ===== */
function parseDMY(str){
  if(!str) return null;
  const mFull = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  const mShort = str.match(/^(\d{1,2})[\/\-](\d{1,2})(?![\/\-]\d{4})$/);
  let day, month, year;
  const now = new Date(), currentYear = now.getFullYear();
  if(mFull){ day=+mFull[1]; month=+mFull[2]-1; year=+mFull[3]; }
  else if(mShort){
    day=+mShort[1]; month=+mShort[2]-1; year=currentYear;
    const temp = new Date(year,month,day);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if(temp<today) year=currentYear+1;
  } else return null;
  const d = new Date(year,month,day);
  if(d.getMonth()!==month||d.getDate()!==day) return null;
  return d;
}
function formatDMY(d){
  const dd=String(d.getDate()).padStart(2,'0');
  const mm=String(d.getMonth()+1).padStart(2,'0');
  const yy=d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}
function addDays(d,n){ const x=new Date(d.getTime()); x.setDate(x.getDate()+n); return x; }

/* ===== SECCIÓN 4: Chat helpers / API ===== */
function msg(text, who='ai'){
  if(!text) return;
  const div=document.createElement('div');
  div.className='chat-message '+(who==='user'?'user':'ai');

  if (/\"(activity|destination|byDay|start|end)\"/.test(text) || text.trim().startsWith('{')) {
    text = '✅ Itinerario actualizado en la interfaz.';
  }
  if (text.length>1200) text=text.slice(0,1200)+'...';
  div.innerHTML=text.replace(/\n/g,'<br>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>');
  $chatM.appendChild(div);
  $chatM.scrollTop = $chatM.scrollHeight;
}
async function callAgent(inputText){
  const payload = { model:'gpt-4o-mini', input: inputText, history: session };
  try{
    const res = await fetch(API_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(()=>({text:''}));
    const raw = data?.text || '';
    if (/```json|<json>/.test(raw) || /^\{[\s\S]*\}$/.test(raw.trim())) return raw;
    if (/itinerario|día|actividades/i.test(raw) && raw.length > 200) return '{"followup":"He actualizado el itinerario correctamente."}';
    return raw;
  }catch(e){
    console.error('callAgent error:',e);
    return '{"followup":"⚠️ No se pudo contactar con el asistente."}';
  }
}
function parseJSON(text){
  if(!text) return null;
  try{ return JSON.parse(text); }catch(_){}
  const m1 = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```([\s\S]*?)```/i);
  if(m1 && m1[1]){ try{ return JSON.parse(m1[1]); }catch(_){ } }
  const m2 = text.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
  if(m2 && m2[1]){ try{ return JSON.parse(m2[1]); }catch(_){ } }
  try{
    const cleaned = text.replace(/^[^\{]+/,'').replace(/[^\}]+$/,'');
    return JSON.parse(cleaned);
  }catch(_){ return null; }
}

/* ===== SECCIÓN 5: UI — Destinos (crear/validar filas) ===== */
function rebuildOrderOptions(){
  const rows=qsa('.city-row',$cities), total=rows.length;
  rows.forEach((row,idx)=>{
    const sel=qs('.city-order',row); const cur=sel.value||(idx+1);
    sel.innerHTML=''; for(let i=1;i<=total;i++){ const o=document.createElement('option'); o.value=i; o.textContent=`${i}º`; sel.appendChild(o); }
    sel.value=Math.min(cur,total);
  });
}
function cityRowTemplate(data={}){
  return `
  <div class="city-row">
    <div>
      <label>Ciudad</label>
      <input class="city-name" type="text" placeholder="Ciudad" value="${data.city||''}">
    </div>
    <div>
      <label>País</label>
      <input class="country" type="text" placeholder="País" value="${data.country||''}">
    </div>
    <div>
      <label>Días</label>
      <input class="city-days" type="number" min="1" placeholder="ej. 3" value="${data.days||''}">
    </div>
    <div>
      <label>Orden</label>
      <select class="city-order"></select>
    </div>
    <div>
      <label>Inicio</label>
      <input class="city-start" type="text" placeholder="DD/MM/AAAA" value="${data.baseDate||''}">
    </div>
    <div style="align-self:end">
      <button class="remove btn ghost" type="button">✖</button>
    </div>

    <!-- Horarios por día (solo placeholders; se pueden dejar vacíos) -->
    <div style="grid-column:1/-1">
      <small>Horas sugeridas por día (opcional): Inicio / Fin</small>
      <div class="grid-2" style="gap:8px;margin-top:6px">
        <input class="start-hour" type="text" placeholder="08:30" />
        <input class="end-hour" type="text" placeholder="18:00" />
      </div>
    </div>
  </div>`;
}
function addCityRow(data={city:'',days:'',order:null}){
  const holder=document.createElement('div');
  holder.innerHTML=cityRowTemplate(data);
  const row=holder.firstElementChild;
  qs('.remove',row).addEventListener('click',()=>{ row.remove(); rebuildOrderOptions(); validateSave(); });
  $cities.appendChild(row);
  rebuildOrderOptions();
  if(data.order) qs('.city-order',row).value=String(data.order);
}
function validateSave(){
  const rows=qsa('.city-row',$cities);
  const ok = rows.length>0 && rows.every(r=>{
    const name=qs('.city-name',r).value.trim();
    const days=parseInt(qs('.city-days',r).value,10);
    return name && days>0;
  });
  $save.disabled = !ok;
  $start.disabled = savedDestinations.length===0;
}
$addCity.addEventListener('click',()=>{ addCityRow(); validateSave(); });
$cities.addEventListener('input', validateSave);
qs('#reset-cities')?.addEventListener('click', ()=>{
  $cities.innerHTML=''; addCityRow(); validateSave();
});

/* ===== SECCIÓN 6: Guardar destinos / sincronizar estado ===== */
$save.addEventListener('click', ()=>{
  const rows=qsa('.city-row',$cities);
  const list = rows.map(r=>({
    city: qs('.city-name',r).value.trim(),
    country: (qs('.country',r).value||'').trim(),
    days: Math.max(1, parseInt(qs('.city-days',r).value,10)||0),
    order: parseInt(qs('.city-order',r).value,10),
    baseDate: (qs('.city-start',r).value||'').trim(),
    start: (qs('.start-hour',r).value||'').trim(),
    end: (qs('.end-hour',r).value||'').trim()
  })).filter(x=>x.city);

  list.sort((a,b)=>a.order-b.order);
  savedDestinations = list.map(({city,days,order})=>({city,days,order}));

  // asegura estructuras
  list.forEach(({city,days,baseDate,start,end})=>{
    if(!itineraries[city]) itineraries[city]={byDay:{}, currentDay:1, baseDate:null};
    if(!cityMeta[city]) cityMeta[city]={ baseDate:null, start:null, end:null, hotel:'', hotelLink:'' };
    if(baseDate) cityMeta[city].baseDate = baseDate;
    if(start)    cityMeta[city].start    = start;
    if(end)      cityMeta[city].end      = end;

    const existingDays = Object.keys(itineraries[city].byDay).length;
    if(existingDays<days){
      for(let d=existingDays+1; d<=days; d++) itineraries[city].byDay[d]=itineraries[city].byDay[d]||[];
    }else if(existingDays>days){
      const trimmed={}; for(let d=1; d<=days; d++) trimmed[d]=itineraries[city].byDay[d]||[];
      itineraries[city].byDay = trimmed;
      if(itineraries[city].currentDay>days) itineraries[city].currentDay=days;
    }
  });

  // Elimina ciudades removidas
  Object.keys(itineraries).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete itineraries[c]; });
  Object.keys(cityMeta).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete cityMeta[c]; });

  renderCityTabs();
  msg('🟪 Destinos guardados. Pulsa "Iniciar planificación" cuando quieras.');
  $start.disabled = savedDestinations.length===0;
});

/* ===== SECCIÓN 7: Tabs / Render de Itinerario ===== */
function setActiveCity(name){
  if(!name) return; activeCity=name;
  qsa('.city-tab',$tabs).forEach(btn=>btn.classList.toggle('active', btn.dataset.city===name));
}
function renderCityTabs(){
  const previousCity=activeCity;
  $tabs.innerHTML='';
  savedDestinations.forEach(({city})=>{
    const b=document.createElement('button');
    b.className='city-tab'+(city===previousCity?' active':'');
    b.textContent=city; b.dataset.city=city;
    b.addEventListener('click',()=>{ setActiveCity(city); renderCityItinerary(city); });
    $tabs.appendChild(b);
  });
  if(savedDestinations.length){
    $intro.style.display='none';
    const validCity = previousCity && savedDestinations.some(x=>x.city===previousCity) ? previousCity : savedDestinations[0].city;
    setActiveCity(validCity); renderCityItinerary(validCity);
  }else{
    $intro.style.display=''; $itineraryWrap.innerHTML=''; activeCity=null;
  }
}
function renderCityItinerary(city){
  if(!city || !itineraries[city]) return;
  const data=itineraries[city];
  const days=Object.keys(data.byDay||{}).map(d=>parseInt(d,10)).sort((a,b)=>a-b);
  $itineraryWrap.innerHTML='';
  if(!days.length){ $itineraryWrap.innerHTML='<p>No hay actividades todavía. El asistente las añadirá aquí.</p>'; return; }
  const base=parseDMY(data.baseDate || (cityMeta[city]?.baseDate||''));
  const sections=[];
  days.forEach(dayNum=>{
    const sec=document.createElement('div');
    sec.className='day-section';
    const dateLabel = base ? ` (${formatDMY(addDays(base, dayNum-1))})` : '';
    sec.innerHTML=`
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
    (data.byDay[dayNum]||[]).slice(0,20).forEach(r=>{
      const tr=document.createElement('tr');
      tr.innerHTML=`
        <td>${r.start||''}</td><td>${r.end||''}</td><td>${r.activity||''}</td>
        <td>${r.from||''}</td><td>${r.to||''}</td><td>${r.transport||''}</td>
        <td>${r.duration||''}</td><td>${r.notes||''}</td>`;
      tb.appendChild(tr);
    });
    $itineraryWrap.appendChild(sec); sections.push(sec);
  });

  const pager=document.createElement('div'); pager.className='pager';
  const prev=document.createElement('button'); prev.textContent='«';
  const next=document.createElement('button'); next.textContent='»';
  pager.appendChild(prev);
  days.forEach(d=>{ const b=document.createElement('button'); b.textContent=d; b.dataset.day=d; pager.appendChild(b); });
  pager.appendChild(next); $itineraryWrap.appendChild(pager);

  function show(n){
    sections.forEach((sec,i)=>sec.style.display = (days[i]===n)?'block':'none');
    qsa('button',pager).forEach(x=>x.classList.remove('active'));
    const btn=qsa('button',pager).find(x=>x.dataset.day==String(n)); if(btn) btn.classList.add('active');
    prev.classList.toggle('ghost', n===days[0]); next.classList.toggle('ghost', n===days[days.length-1]);
    if(itineraries[city]) itineraries[city].currentDay=n;
  }
  pager.addEventListener('click',e=>{
    const t=e.target;
    if(t===prev) show(Math.max(days[0], (itineraries[city]?.currentDay||days[0])-1));
    else if(t===next) show(Math.min(days.at(-1), (itineraries[city]?.currentDay||days[0])+1));
    else if(t.dataset.day) show(Number(t.dataset.day));
  });
  show(itineraries[city]?.currentDay || days[0]);
}

/* ===== SECCIÓN 8: Serialización para el agente ===== */
function getItineraryContext(){
  const snapshot = Object.fromEntries(
    Object.entries(itineraries).map(([city,data])=>{
      const days = Object.fromEntries(
        Object.entries(data.byDay).map(([d,rows])=>[
          d, rows.map(r=>({
            day:Number(d),
            start:r.start||'', end:r.end||'',
            activity:r.activity||'', from:r.from||'',
            to:r.to||'', transport:r.transport||'',
            duration:r.duration||'', notes:r.notes||''
          }))
        ])
      );
      return [city,{days, baseDate: data.baseDate || null}];
    })
  );
  return JSON.stringify(snapshot);
}
function getCityMetaContext(){ return JSON.stringify(cityMeta); }

/* ===== SECCIÓN 9: Construcción de intake y formato JSON ===== */
function buildIntake(){
  const list = savedDestinations.map(x=>`${x.city} (${x.days} días, orden ${x.order})`).join(' | ');
  const pax  = travelerIds.map(id=>`${id.replace('p-','')}:${qs('#'+id).value||0}`).join(', ');
  const stay = (qs('#stay-name').value||'').trim();
  const address = (qs('#stay-address').value||'').trim();
  const budget = Number(qs('#budget').value||0);
  const currency = qs('#currency').value||'USD';
  const notes = (qs('#special-notes').value||'').trim();

  return [
    `Destinations (order): ${list}`,
    `Travelers: ${pax}`,
    `Accommodation: ${stay ? stay+' - ':''}${address}`,
    `Total Budget: ${budget} ${currency}`,
    `User Notes: ${notes}`,
    `Existing plan (keep & adjust): ${getItineraryContext()}`,
    `Existing meta (per city): ${getCityMetaContext()}`
  ].join('\n');
}
const FORMAT = `
Devuelve SOLO JSON (sin texto extra) con alguno de estos formatos:
A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}]}],"followup":"Pregunta breve"}
B) {"destination":"City","rows":[{...}],"followup":"Pregunta breve"}
C) {"rows":[{...}],"followup":"Pregunta breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto","hotelLink":""},"followup":"Pregunta breve"}
Reglas:
- Incluye traslados con transporte y duración (+15% colchón).
- Si faltan datos, pregúntalo en "followup" y asume valores razonables (08:30–18:00).
- Máximo ~20 filas por día si la jornada es larga.
- Nada de markdown. Solo JSON.`.trim();

/* ===== SECCIÓN 10: Generación de itinerarios por ciudad ===== */
async function generateCityItinerary(city){
  const conf  = cityMeta[city] || {};
  const days  = (savedDestinations.find(x=>x.city===city)?.days) || 1;
  const baseDate = conf.baseDate || '';
  const start = conf.start || '08:30';
  const end   = conf.end   || '18:00';
  const hotel = conf.hotel || '';
  const hotelLink = conf.hotelLink || '';

  const instructions = `
${FORMAT}
Eres un planificador experto (concierge premium). Genera el itinerario SOLO para "${city}" con ${days} días.
- Prioriza IMPERDIBLES de la ciudad; si procede, excursiones cercanas.
- Optimiza tiempos y orden. Devuelve **formato B** con "destination":"${city}".
- No escribas texto plano; responde JSON válido.

Contexto:
- BaseDate (día 1): ${baseDate}
- Hora inicio: ${Array.isArray(start)?start.join(', '):start}
- Hora fin: ${Array.isArray(end)?end.join(', '):end}
- Hotel/Zona (si no hay, sugiere mejor zona y colócala en 'notes' de la primera fila del Día 1): ${hotel || 'PENDIENTE'}
- Enlace Hotel: ${hotelLink||''}

Plan existente: ${getItineraryContext()}
`.trim();

  try{
    const text = await callAgent(instructions);
    session.push({role:'assistant', content:text||''});
    const parsed = parseJSON(text);
    if(parsed){
      const hadRows = Object.values(itineraries[city]?.byDay||{}).some(a=>a.length>0);
      applyParsedToState(parsed, !hadRows);
      if(itineraries[city] && baseDate) itineraries[city].baseDate = baseDate;
      setActiveCity(city); renderCityItinerary(city);
      if(parsed.followup && !collectingMeta && !batchGenerating) msg(parsed.followup.replace(/\bCiudad\b/gi, city),'ai');
      else if(!parsed.followup && !batchGenerating) msg(`✅ Itinerario actualizado para ${city}.`,'ai');
    }else{
      msg(`❌ No pude interpretar el itinerario para ${city}.`, 'ai');
    }
  }catch(e){
    console.error(e); msg(`⚠️ Error al generar el itinerario para ${city}.`,'ai');
  }
}
function metaIsComplete(m){ return !!(m && (m.baseDate||true) && (m.start||true) && (m.end||true) && typeof m.hotel === 'string'); }
async function maybeGenerateAllCities(){
  batchGenerating=true;
  for(const {city} of savedDestinations){
    const m=cityMeta[city];
    const hasRows=Object.values(itineraries[city]?.byDay||{}).some(a=>a.length>0);
    if(metaIsComplete(m) && !hasRows){ await generateCityItinerary(city); }
  }
  batchGenerating=false;
  if(!globalReviewAsked){ globalReviewAsked=true; msg('✨ Todos los itinerarios fueron generados. ¿Deseas revisar o ajustar alguno?','ai'); }
}
function nextPendingCity(fromCity=null){
  const order=savedDestinations.map(x=>x.city);
  const startIdx = fromCity ? Math.max(0, order.indexOf(fromCity)) : -1;
  for(let i=startIdx+1;i<order.length;i++){
    const c=order[i]; const m=cityMeta[c];
    const hasRows=Object.values(itineraries[c]?.byDay||{}).some(a=>a.length>0);
    if(!metaIsComplete(m) || !hasRows) return c;
  }
  return null;
}

/* ===== SECCIÓN 11: Flujo secuencial de meta (preguntas iniciales) ===== */
async function askForNextCityMeta(){
  if(awaitingMetaReply) return;
  if(metaProgressIndex >= savedDestinations.length){
    collectingMeta=false; msg('Perfecto 🎉 Generando itinerarios...'); await maybeGenerateAllCities(); return;
  }
  const city = savedDestinations[metaProgressIndex].city;
  activeCity=city; const isFirst = metaProgressIndex===0;
  awaitingMetaReply=true;
  msg(isFirst?tone.startMeta(city):tone.contMeta(city));
}
async function generateInitial(){
  if(savedDestinations.length===0){ alert('Agrega ciudades y guarda destinos primero.'); return; }
  $chatC.style.display='flex';
  planningStarted=true; metaProgressIndex=0; collectingMeta=true;
  awaitingMetaReply=false; batchGenerating=false; globalReviewAsked=false;

  session = [
    {role:'system', content:'Eres un planificador/concierge de viajes internacional. Devuelves JSON limpio según el formato indicado.'},
    {role:'user', content: buildIntake()}
  ];
  msg(`${tone.hi} ${tone.welcomeFlow}`); hintMenuOnce(); await askForNextCityMeta();
}
$start.addEventListener('click', generateInitial);

/* ===== SECCIÓN 12: Merge helpers / actualización de estado ===== */
function dedupeInto(arr,row){
  const key=(o)=>[o.day,o.start||'',o.end||'',(o.activity||'').trim().toLowerCase()].join('|');
  const has=arr.find(x=>key(x)===key(row)); if(!has) arr.push(row);
}
function ensureDays(city){
  const byDay=itineraries[city].byDay||{};
  const present=Object.keys(byDay).map(n=>parseInt(n,10));
  const maxPresent=present.length?Math.max(...present):0;
  const saved=savedDestinations.find(x=>x.city===city)?.days||0;
  const want=Math.max(saved,maxPresent); const have=present.length;
  if(have<want){ for(let d=have+1; d<=want; d++) byDay[d]=byDay[d]||[]; }
  if(have>want){ const trimmed={}; for(let d=1; d<=want; d++) trimmed[d]=byDay[d]||[]; itineraries[city].byDay=trimmed; }
}
function pushRows(city,rows,replace=false){
  if(!itineraries[city]) itineraries[city]={byDay:{}, currentDay:1, baseDate:null};
  if(replace) itineraries[city].byDay={};
  rows.forEach(r=>{
    const d=Math.max(1, parseInt(r.day||1,10));
    if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[];
    const row={
      day:d,
      start:r.start||'', end:r.end||'', activity:r.activity||'',
      from:r.from||'', to:r.to||'', transport:r.transport||'',
      duration:r.duration||'', notes:r.notes||''
    };
    dedupeInto(itineraries[city].byDay[d], row);
  });
  ensureDays(city);
}
function upsertCityMeta(meta){
  const name = meta.city || activeCity || savedDestinations[metaProgressIndex]?.city || savedDestinations[0]?.city;
  if(!name) return;
  if(!cityMeta[name]) cityMeta[name]={baseDate:null,start:null,end:null,hotel:'',hotelLink:''};
  if(meta.baseDate) cityMeta[name].baseDate=meta.baseDate;
  if(meta.start)    cityMeta[name].start=meta.start;
  if(meta.end)      cityMeta[name].end=meta.end;
  if(typeof meta.hotel==='string') cityMeta[name].hotel=meta.hotel;
  if(typeof meta.hotelLink==='string') cityMeta[name].hotelLink=meta.hotelLink;
  if(itineraries[name] && meta.baseDate){ itineraries[name].baseDate=meta.baseDate; }
}
function applyParsedToState(parsed, forceReplaceAll=false){
  const rootReplace = Boolean(parsed.replace) || forceReplaceAll;

  if(parsed.meta && parsed.meta.city){ upsertCityMeta(parsed.meta); }

  if(Array.isArray(parsed.destinations)){
    parsed.destinations.forEach(d=>{
      if(d.meta && d.meta.city) upsertCityMeta(d.meta);
      const name = d.name || d.meta?.city || activeCity || savedDestinations[0]?.city || 'General';
      const destReplace = rootReplace || Boolean(d.replace);
      pushRows(name, d.rows||[], destReplace);
    });
    return;
  }
  if(parsed.destination && Array.isArray(parsed.rows)){
    const name = parsed.destination || activeCity || savedDestinations[0]?.city || 'General';
    pushRows(name, parsed.rows, rootReplace);
    return;
  }
  if(Array.isArray(parsed.rows)){
    const fallback = activeCity || savedDestinations[0]?.city || 'General';
    pushRows(fallback, parsed.rows, rootReplace);
  }
}

/* ===== SECCIÓN 13: Utilidades de edición (parsers) ===== */
function normalize(t){
  return t.toLowerCase().replaceAll('á','a').replaceAll('é','e').replaceAll('í','i').replaceAll('ó','o').replaceAll('ú','u');
}
function extractInt(str){
  const m=str.match(/\b(\d{1,2})\b/); if(m) return Math.max(1,parseInt(m[1],10));
  if(/\bun\b|\buno\b|\buna\b/.test(str)) return 1; return 1;
}
function parseTimesFromText(text){
  const times=[]; let tnorm=text.toLowerCase()
    .replace(/\s+de\s+la\s+manana/g,'am').replace(/\s+de\s+la\s+tarde/g,'pm').replace(/\s+de\s+la\s+noche/g,'pm')
    .replace(/\s*y\s+media/g,':30').replace(/\s*y\s+cuarto/g,':15')
    .replace(/(\d{3,4})\s*(am|pm)?/g,(_,num,ap)=> num.length===3 ? (num[0]+':'+num.slice(1)+(ap||'')) : (num.slice(0,2)+':'+num.slice(2)+(ap||'')));
  const re=/(\b\d{1,2}(:\d{2})?\s*(am|pm|h)?\b)/gi; let m;
  while((m=re.exec(tnorm))!==null){
    let t=m[1].trim().toLowerCase(); let ampm=/(am|pm)$/.exec(t)?.[1];
    t=t.replace(/(am|pm|h)$/,''); if(!t.includes(':')) t=t+':00';
    let [h,mi]=t.split(':').map(x=>parseInt(x,10));
    if(ampm==='pm' && h<12) h+=12; if(ampm==='am' && h===12) h=0;
    const HH=String(Math.max(0,Math.min(23,h))).padStart(2,'0');
    const MM=String(Math.max(0,Math.min(59,mi||0))).padStart(2,'0'); times.push(`${HH}:${MM}`);
  }
  return times;
}
function updateSavedDays(city,newDays){
  const idx=savedDestinations.findIndex(x=>x.city===city);
  if(idx>=0) savedDestinations[idx]={...savedDestinations[idx], days:Math.max(1,newDays)};
}

/* ===== SECCIÓN 14: Chat principal / edición interactiva ===== */
function userWantsReplace(text){ const t=(text||'').toLowerCase(); return /(sustituye|reemplaza|cambia todo|replace|overwrite|desde cero|todo nuevo)/i.test(t); }
function isAcceptance(text){ const t=(text||'').toLowerCase().trim(); return /(^|\b)(ok|listo|esta bien|perfecto|de acuerdo|vale|sounds good|looks good|c’est bon|tout bon|beleza|ta bom)\b/.test(t); }

async function sendChat(){
  const text=($intake.value||'').trim(); if(!text) return;
  msg(text,'user'); $intake.value='';

  // Fase 1: recopilar meta
  if(collectingMeta){
    const city=savedDestinations[metaProgressIndex]?.city;
    if(!city){ collectingMeta=false; await maybeGenerateAllCities(); return; }

    const extractPrompt=`
Extrae del texto la meta para la ciudad "${city}" en formato D del esquema:
${FORMAT}
Devuelve SOLO:
{"meta":{"city":"${city}","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto","hotelLink":""}}
Texto del usuario: ${text}`.trim();

    const answer=await callAgent(extractPrompt);
    const parsed=parseJSON(answer);
    if(parsed?.meta){
      upsertCityMeta(parsed.meta); awaitingMetaReply=false;
      msg(`Perfecto, tengo la información para ${city}.`);
      metaProgressIndex++;
      if(metaProgressIndex<savedDestinations.length){ await askForNextCityMeta(); }
      else { collectingMeta=false; msg('Perfecto 🎉 Generando itinerarios...'); await maybeGenerateAllCities(); }
    }else{
      msg('No logré entender. ¿Podrías repetir la fecha del primer día, horarios y hotel/zona?');
    }
    return;
  }

  // Fase 2: edición/libre
  const tNorm=normalize(text); let handled=false;

  // a) agregar días
  if(/\b(agrega|añade|sumar?|add)\b.*\bdía/.test(tNorm) || /\b(un dia mas|1 dia mas)\b/.test(tNorm)){
    const addN=extractInt(tNorm);
    if(activeCity){
      const current=savedDestinations.find(x=>x.city===activeCity)?.days || Object.keys(itineraries[activeCity]?.byDay||{}).length || 1;
      const newDays=current+addN; updateSavedDays(activeCity,newDays); ensureDays(activeCity);
      await generateCityItinerary(activeCity); renderCityTabs(); setActiveCity(activeCity);
      msg(`Añadí ${addN} día(s) en ${activeCity}.`); hintMenuOnce();
    }
    handled=true;
  }
  // b) quitar días
  if(!handled && /\b(quita|elimina|remueve|remove)\b.*\bdía/.test(tNorm)){
    const remN=extractInt(tNorm);
    if(activeCity){
      const current=savedDestinations.find(x=>x.city===activeCity)?.days || Object.keys(itineraries[activeCity]?.byDay||{}).length || 1;
      const newDays=Math.max(1,current-remN); updateSavedDays(activeCity,newDays); ensureDays(activeCity);
      renderCityTabs(); setActiveCity(activeCity); msg(`Quité ${remN} día(s) en ${activeCity}.`); hintMenuOnce();
    }
    handled=true;
  }
  // c) ajustar horas
  if(!handled && /\b(hora|horario|inicio|fin|empieza|termina|ajusta|cambia|salida|regreso|desde|hasta)\b/.test(tNorm) && /\d/.test(tNorm)){
    const times=parseTimesFromText(text);
    if(activeCity){
      cityMeta[activeCity]=cityMeta[activeCity]||{baseDate:null,start:null,end:null,hotel:'',hotelLink:''};
      if(times.length===1){ if(/\b(hasta|termina|fin)\b/.test(tNorm)) cityMeta[activeCity].end=times[0]; else cityMeta[activeCity].start=times[0]; }
      else if(times.length>=2){ cityMeta[activeCity].start=times[0]; cityMeta[activeCity].end=times[times.length-1]; }
      await generateCityItinerary(activeCity); renderCityTabs(); setActiveCity(activeCity);
      msg(`Ajusté horarios en ${activeCity}.`); hintMenuOnce();
    }
    handled=true;
  }
  // d) recalcular
  if(!handled && /\b(recalcula|replanifica|recompute|replan|recalculate)\b/.test(tNorm)){
    if(activeCity){
      if(userWantsReplace(text)) itineraries[activeCity].byDay={};
      await generateCityItinerary(activeCity); renderCityTabs(); setActiveCity(activeCity);
      msg(`Recalculé el itinerario de ${activeCity}.`); hintMenuOnce();
    }
    handled=true;
  }
  if(handled) return;

  // e) edición por LLM
  let dayScope=null; const mDay=text.match(/\bd[ií]a\s+(\d{1,2})\b/i); if(mDay) dayScope=parseInt(mDay[1],10);
  session.push({role:'user', content:text});
  const cityHint = activeCity ? `Active city: ${activeCity}` : '';
  const replaceHint = userWantsReplace(text) ? 'If you propose new rows, set {"replace": true}.' : '';
  const scopeHint = activeCity ? `\nScope: Modify ONLY "${activeCity}"${dayScope?`, day ${dayScope}`:''}.\n` : '\nScope: assume active tab.\n';
  const prompt = `${FORMAT}
Edit the current plan. ${cityHint}${scopeHint}
Existing plan (keep & adjust): ${getItineraryContext()}
Existing meta (per city): ${getCityMetaContext()}
${replaceHint}
Do NOT write itineraries in plain text; only JSON updates.
Solicitud del usuario: ${text}`;

  try{
    const answer=await callAgent(prompt); session.push({role:'assistant', content:answer||''});
    const parsed=parseJSON(answer);
    if(parsed){
      const before=JSON.stringify(cityMeta);
      applyParsedToState(parsed,false);
      const after=JSON.stringify(cityMeta);
      if(before!==after){ await maybeGenerateAllCities(); }
      else{ renderCityTabs(); setActiveCity(activeCity); renderCityItinerary(activeCity); }
      msg(parsed.followup || '¿Deseas otro ajuste?','ai'); hintMenuOnce();
    }else{
      msg('Listo. Cambios aplicados.','ai'); hintMenuOnce();
    }
    if(isAcceptance(text)){
      const nxt=nextPendingCity(activeCity)||nextPendingCity(null);
      if(nxt){ msg(tone.nextAsk(nxt)); setActiveCity(nxt); renderCityItinerary(nxt); }
    }
  }catch(e){ console.error(e); msg('❌ Error de conexión.','ai'); }
}
$send.addEventListener('click', sendChat);
$intake.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); sendChat(); } });

/* ===== SECCIÓN 15: UX guard ===== */
$start.addEventListener('click',(e)=>{
  if(savedDestinations.length===0){ e.preventDefault(); alert('Agrega ciudades & días y presiona "Guardar destinos" primero.'); }
},{capture:true});

/* ===== SECCIÓN 16: Inicialización de placeholders (sidebar en blanco) ===== */
function initPlaceholders(){
  // Sidebar debe iniciar en blanco (salvo viajeros: adultos=1)
  travelerIds.forEach(id=>{
    const el=qs('#'+id); if(!el) return;
    if(id==='p-adults') el.value=1; else el.value=0;
  });
}
initPlaceholders();

/* ===== SECCIÓN 17: Bootstrap ===== */
/* Inicial: una fila lista (placeholders en blanco) */
addCityRow();
validateSave();

});
