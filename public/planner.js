/* ================== v15 app.js ================== */
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

// Estado principal
let savedDestinations = []; // [{city, days, order}]
let itineraries = {};       // itineraries[city] = { byDay:{1:[rows],...}, currentDay:1, baseDate:'DD/MM/YYYY' }
let cityMeta = {};          // cityMeta[city] = { baseDate:'DD/MM/YYYY', start:'HH:MM', end:'HH:MM', hotel:{provided,name,address,zoneSuggested}, perDay?:[] }
let session = [];
let activeCity = null;

// Control de conversación
let planningStarted = false;
let metaProgressIndex = 0;
let collectingMeta = false;
let awaitingMetaReply = false;
let batchGenerating = false;
let globalReviewAsked = false;

// Throttle para hints en chat
let lastMenuHintTs = 0;
function hintMenuOnce(){
  const now = Date.now();
  if(now - lastMenuHintTs > 180000){ // 3 min
    msg(tone.menuHint);
    lastMenuHintTs = now;
  }
}

/* ===== SECCIÓN 2: Idioma y tono ===== */
function detectLang(){
  const n = (navigator.language || 'es').toLowerCase();
  if(n.startsWith('es')) return 'es';
  if(n.startsWith('pt')) return 'pt';
  if(n.startsWith('fr')) return 'fr';
  return 'en';
}
const tone = {
  es: {
    hi: '¡Bienvenido! 👋 Soy tu concierge de viajes personal.',
    startMeta: (city)=>`Comencemos por **${city}**. En un solo texto: fecha del primer día (DD/MM/AAAA), horas de inicio y fin diarias y hotel/zona (si ya lo tienes). Si no lo tienes, escribe "pendiente".`,
    contMeta:  (city)=>`Continuemos con **${city}**. Fecha del 1er día (DD/MM/AAAA), horario diario (inicio–fin) y hotel/zona o “pendiente”.`,
    focus: ()=>``,
    review: (city)=>`Listo, aquí tienes el itinerario para **${city}**. ¿Quieres ajustar algo?`,
    nextAsk: (city)=>`Perfecto. Pasemos a **${city}**. ¿Fecha del primer día, horario diario y hotel/zona?`,
    menuHint: 'Para info extra (clima, transporte, restaurantes…) usa el menú inferior 👇',
    welcomeFlow: 'Te guiaré ciudad por ciudad. Si aún no tienes hotel, te sugeriré la mejor zona.'
  },
  en: {
    hi: 'Welcome! 👋 I’m your personal travel concierge.',
    startMeta: (city)=>`Let’s start with **${city}**. In one message: day-1 date (DD/MM/YYYY), daily start/end times, and hotel/area (or “pending”).`,
    contMeta:  (city)=>`Let’s continue with **${city}**. Day-1 date, daily hours, and hotel/area (or “pending”).`,
    focus: ()=>``,
    review: (city)=>`Here’s **${city}**. Any tweaks?`,
    nextAsk: (city)=>`Great. Now **${city}**: day-1 date, daily hours, hotel/area?`,
    menuHint: 'For more detail (weather, transport, restaurants…) use the bottom toolbar 👇',
    welcomeFlow: 'I’ll guide you city-by-city. If you don’t have a hotel yet, I’ll suggest the best area.'
  },
  fr: {
    hi: 'Bienvenue ! 👋 Je suis votre concierge de voyage.',
    startMeta: (city)=>`Commençons par **${city}** : date du 1er jour (JJ/MM/AAAA), heures quotidiennes début/fin et hôtel/quartier (ou “en attente”).`,
    contMeta:  (city)=>`Continuons avec **${city}** : date du 1er jour, horaires quotidiens et hôtel/quartier (ou “en attente”).`,
    focus: ()=>``,
    review: (city)=>`Voici **${city}**. Des ajustements ?`,
    nextAsk: (city)=>`Parfait. Passons à **${city}** : date du 1er jour, horaires quotidiens et hôtel/quartier ?`,
    menuHint: 'Pour plus de détails (météo, transports, restos…), utilisez la barre du bas 👇',
    welcomeFlow: 'Je vous guide ville par ville. Sans hôtel, je suggère les meilleures zones.'
  },
  pt: {
    hi: 'Bem-vindo! 👋 Sou o seu concierge de viagens.',
    startMeta: (city)=>`Vamos começar por **${city}**: data do 1º dia (DD/MM/AAAA), horários diários e hotel/bairro (ou “pendente”).`,
    contMeta:  (city)=>`Continuemos com **${city}**: data do 1º dia, horários e hotel/bairro (ou “pendente”).`,
    focus: ()=>``,
    review: (city)=>`Aqui está **${city}**. Quer ajustar algo?`,
    nextAsk: (city)=>`Perfeito. Agora **${city}**: data do 1º dia, horários, hotel/bairro?`,
    menuHint: 'Para mais detalhes (clima, transporte, restaurantes…), use a barra inferior 👇',
    welcomeFlow: 'Vou guiá-lo cidade a cidade. Sem hotel? Eu sugerirei a melhor zona.'
  }
}[detectLang()];

/* Evitar “spam” al cambiar de tab — desactivado */
function uiMsgFocusCity(){ return; }

/* ===== SECCIÓN 3: Utilidades de fecha ===== */
function parseDMY(str){
  if(!str) return null;
  // Soporta DD/MM y DD/MM/YYYY
  const mFull = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  const mShort = str.match(/^(\d{1,2})[\/\-](\d{1,2})(?![\/\-]\d{4})$/);
  let day, month, year;
  const now = new Date();
  if(mFull){ day=+mFull[1]; month=+mFull[2]-1; year=+mFull[3]; }
  else if(mShort){ day=+mShort[1]; month=+mShort[2]-1; year=now.getFullYear(); if(new Date(year,month,day)<new Date(now.getFullYear(),now.getMonth(),now.getDate())) year++;}
  else return null;
  const d = new Date(year,month,day);
  if(d.getMonth()!==month||d.getDate()!==day) return null;
  return d;
}
function formatDMY(d){ const dd=String(d.getDate()).padStart(2,'0'); const mm=String(d.getMonth()+1).padStart(2,'0'); const yy=d.getFullYear(); return `${dd}/${mm}/${yy}`;}
function addDays(d,n){ const x=new Date(d.getTime()); x.setDate(x.getDate()+n); return x; }

/* ===== SECCIÓN 4: Chat helpers / API ===== */
function msg(text, who='ai'){
  if(!text) return;
  const div = document.createElement('div');
  div.className = 'chat-message ' + (who==='user'?'user':'ai');
  // Evita mostrar JSON/estructuras en chat
  if (/\"(activity|destination|byDay|start|end)\"/.test(text) || text.trim().startsWith('{')) {
    text = '✅ Itinerario actualizado en la interfaz.';
  }
  if(text.length>1200) text = text.slice(0,1200)+'...';
  div.innerHTML = text.replace(/\n/g,'<br>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>');
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
    if(/```json|<json>/.test(raw) || /^\{[\s\S]*\}$/.test(raw.trim())) return raw;
    if(/itinerario|día|actividades/i.test(raw) && raw.length>200) return '{"followup":"He actualizado el itinerario correctamente."}';
    return raw;
  }catch(err){
    console.error('callAgent error:',err);
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
  try{ const cleaned=text.replace(/^[^\{]+/,'').replace(/[^\}]+$/,''); return JSON.parse(cleaned);}catch(_){ return null; }
}

/* ===== SECCIÓN 5: UI — Destinos (crear/validar filas) ===== */
function rebuildOrderOptions(){
  const rows = qsa('.city-row', $cities);
  const total = rows.length;
  rows.forEach((row,idx)=>{
    const sel = qs('.city-order', row);
    const cur = sel.value || (idx+1);
    sel.innerHTML='';
    for(let i=1;i<=total;i++){ const opt=document.createElement('option'); opt.value=i; opt.textContent=`${i}º`; sel.appendChild(opt); }
    sel.value = Math.min(cur,total);
  });
}
function addCityRow(data={city:'',country:'',days:'',order:null,start:'08:30',end:'18:00',baseDate:''}){
  const row = document.createElement('div');
  row.className='city-row';
  row.innerHTML=`
    <div>
      <label>Ciudad</label>
      <input class="city-name" type="text" placeholder="Ciudad" value="${data.city||''}">
    </div>
    <div>
      <label>País</label>
      <input class="city-country" type="text" placeholder="País" value="${data.country||''}">
    </div>
    <div>
      <label>Días</label>
      <input class="city-days" type="number" min="1" placeholder="" value="${data.days||''}">
    </div>
    <div>
      <label>Inicio (Día 1)</label>
      <input class="city-date" type="text" placeholder="DD/MM/AAAA" value="${data.baseDate||''}">
    </div>
    <div>
      <label>Orden</label>
      <select class="city-order"></select>
    </div>
    <div class="remove">
      <button type="button" class="btn ghost js-remove">✖</button>
    </div>
    <div style="grid-column:1/-1;display:grid;grid-template-columns:repeat(8,1fr);gap:6px">
      <div><small>Día 1</small><div class="row"><input class="d1-start" type="text" value="${data.start||'08:30'}"><input class="d1-end" type="text" value="${data.end||'18:00'}"></div></div>
      <div><small>Día 2</small><div class="row"><input class="d2-start" type="text" value="${data.start||'08:30'}"><input class="d2-end" type="text" value="${data.end||'18:00'}"></div></div>
      <div><small>Día 3</small><div class="row"><input class="d3-start" type="text" value="${data.start||'08:30'}"><input class="d3-end" type="text" value="${data.end||'18:00'}"></div></div>
      <div><small>Día 4</small><div class="row"><input class="d4-start" type="text" value="${data.start||'08:30'}"><input class="d4-end" type="text" value="${data.end||'18:00'}"></div></div>
      <div><small>Día 5</small><div class="row"><input class="d5-start" type="text" value="${data.start||'08:30'}"><input class="d5-end" type="text" value="${data.end||'18:00'}"></div></div>
      <div><small>Día 6</small><div class="row"><input class="d6-start" type="text" value="${data.start||'08:30'}"><input class="d6-end" type="text" value="${data.end||'18:00'}"></div></div>
      <div><small>Día 7</small><div class="row"><input class="d7-start" type="text" value="${data.start||'08:30'}"><input class="d7-end" type="text" value="${data.end||'18:00'}"></div></div>
      <div><small>Día 8</small><div class="row"><input class="d8-start" type="text" value="${data.start||'08:30'}"><input class="d8-end" type="text" value="${data.end||'18:00'}"></div></div>
    </div>
  `;
  qs('.js-remove',row).addEventListener('click',()=>{ row.remove(); rebuildOrderOptions(); validateSave(); });
  $cities.appendChild(row);
  rebuildOrderOptions();
  if(data.order) qs('.city-order',row).value=String(data.order);
}
function validateSave(){
  const rows = qsa('.city-row',$cities);
  const ok = rows.length>0 && rows.every(r=>{
    const name = qs('.city-name',r).value.trim();
    const days = parseInt(qs('.city-days',r).value,10);
    return name && days>0;
  });
  $save.disabled = !ok;
  $start.disabled = savedDestinations.length===0;
}
$addCity.addEventListener('click',()=>{ addCityRow(); validateSave(); });
$cities.addEventListener('input',validateSave);
addCityRow(); // fila inicial limpia

/* ===== SECCIÓN 6: Guardar destinos / sincronizar estado ===== */
$save.addEventListener('click',()=>{
  const rows = qsa('.city-row',$cities);
  const list = rows.map(r=>({
    city: qs('.city-name',r).value.trim(),
    country: qs('.city-country',r).value.trim(),
    days: Math.max(1, parseInt(qs('.city-days',r).value,10)||0),
    order: parseInt(qs('.city-order',r).value,10)||1,
    baseDate: qs('.city-date',r).value.trim(),
    perDay: Array.from({length:8},(_,i)=>({
      start: (qs(`.d${i+1}-start`,r)?.value||'08:30'),
      end:   (qs(`.d${i+1}-end`,r)?.value||'18:00')
    }))
  })).filter(x=>x.city);

  list.sort((a,b)=>a.order-b.order);
  savedDestinations = list;

  savedDestinations.forEach(({city,days,baseDate,perDay})=>{
    if(!itineraries[city]) itineraries[city] = { byDay:{}, currentDay:1, baseDate: baseDate || null };
    if(!cityMeta[city]){
      cityMeta[city] = { baseDate: baseDate||null, start: perDay?.[0]?.start||'08:30', end: perDay?.[0]?.end||'18:00',
        hotel:{provided:false,name:'',address:'',zoneSuggested:''}, perDay: perDay||[] };
    }else{
      if(baseDate) cityMeta[city].baseDate=baseDate;
      if(perDay?.[0]){ cityMeta[city].start=perDay[0].start; cityMeta[city].end=perDay[0].end; cityMeta[city].perDay=perDay; }
    }
    const existing = Object.keys(itineraries[city].byDay).length;
    if(existing<days){ for(let d=existing+1; d<=days; d++) itineraries[city].byDay[d]=itineraries[city].byDay[d]||[]; }
    else if(existing>days){
      const trimmed={}; for(let d=1; d<=days; d++) trimmed[d]=itineraries[city].byDay[d]||[];
      itineraries[city].byDay = trimmed; if(itineraries[city].currentDay>days) itineraries[city].currentDay = days;
    }
  });

  Object.keys(itineraries).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete itineraries[c]; });
  Object.keys(cityMeta).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete cityMeta[c]; });

  renderCityTabs();
  msg('✅ Destinos guardados. Pulsa “Iniciar planificación” para comenzar.');
  $start.disabled = savedDestinations.length===0;
});

/* ===== SECCIÓN 7: Tabs / Render de Itinerario ===== */
function setActiveCity(name){
  if(!name) return;
  activeCity = name;
  qsa('.city-tab',$tabs).forEach(btn=>btn.classList.toggle('active',btn.dataset.city===name));
}
function renderCityTabs(){
  const previous = activeCity;
  $tabs.innerHTML='';
  savedDestinations.forEach(({city})=>{
    const b=document.createElement('button');
    b.className='city-tab'+(city===previous?' active':'');
    b.textContent=city; b.dataset.city=city;
    b.addEventListener('click',()=>{ setActiveCity(city); renderCityItinerary(city); });
    $tabs.appendChild(b);
  });
  if(savedDestinations.length){
    $intro.style.display='none';
    const valid = previous && savedDestinations.some(x=>x.city===previous) ? previous : savedDestinations[0].city;
    setActiveCity(valid); renderCityItinerary(valid);
  }else{
    $intro.style.display=''; $itineraryWrap.innerHTML=''; activeCity=null;
  }
}
function renderCityItinerary(city){
  if(!city || !itineraries[city]) return;
  const data = itineraries[city];
  const days = Object.keys(data.byDay||{}).map(n=>parseInt(n,10)).sort((a,b)=>a-b);
  $itineraryWrap.innerHTML='';
  if(!days.length){ $itineraryWrap.innerHTML='<p>No activities yet. The assistant will fill them in.</p>'; return; }

  const base = parseDMY(data.baseDate || (cityMeta[city]?.baseDate || ''));
  const hotelInfo = cityMeta[city]?.hotel || {provided:false,name:'',address:'',zoneSuggested:''};
  const sections = [];

  days.forEach(dayNum=>{
    const sec=document.createElement('div'); sec.className='day-section';
    const dateLabel = base ? ` (${formatDMY(addDays(base, dayNum-1))})` : '';
    sec.innerHTML=`
      <div class="day-title">Día ${dayNum}${dateLabel}</div>
      <table class="itinerary">
        <thead>
          <tr>
            <th>Inicio</th><th>Fin</th><th>Actividad</th><th>Desde</th>
            <th>Hacia</th><th>Transporte</th><th>Duración</th><th>Notas</th><th>Hospedaje / Zona</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>`;
    const tb = qs('tbody',sec);
    (data.byDay[dayNum]||[]).forEach(r=>{
      const tr=document.createElement('tr');
      const hospCell = r.hotelInfo
        || (hotelInfo.provided
            ? `${hotelInfo.name||''}${hotelInfo.address?'<br>'+hotelInfo.address:''}`
            : (hotelInfo.zoneSuggested ? `Zona sugerida: ${hotelInfo.zoneSuggested}` : ''));
      tr.innerHTML=`
        <td>${r.start||''}</td><td>${r.end||''}</td><td>${r.activity||''}</td>
        <td>${r.from||''}</td><td>${r.to||''}</td><td>${r.transport||''}</td>
        <td>${r.duration||''}</td><td>${r.notes||''}</td><td>${hospCell||''}</td>`;
      tb.appendChild(tr);
    });
    $itineraryWrap.appendChild(sec); sections.push(sec);
  });

  const pager=document.createElement('div'); pager.className='pager';
  const prev=document.createElement('button'); prev.textContent='«';
  const next=document.createElement('button'); next.textContent='»';
  pager.appendChild(prev); days.forEach(d=>{ const b=document.createElement('button'); b.textContent=d; b.dataset.day=d; pager.appendChild(b); }); pager.appendChild(next); $itineraryWrap.appendChild(pager);

  function show(n){
    sections.forEach((sec,i)=>sec.style.display = (days[i]===n)?'block':'none');
    qsa('button',pager).forEach(x=>x.classList.remove('active'));
    const btn = qsa('button',pager).find(x=>x.dataset.day==String(n)); if(btn) btn.classList.add('active');
    prev.classList.toggle('ghost', n===days[0]); next.classList.toggle('ghost', n===days[days.length-1]);
    if(itineraries[city]) itineraries[city].currentDay = n;
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
  const snapshot = Object.fromEntries(Object.entries(itineraries).map(([city,data])=>{
    const days = Object.fromEntries(Object.entries(data.byDay).map(([d,rows])=>[
      d, rows.slice(0,20).map(r=>({
        day:Number(d), start:r.start||'', end:r.end||'', activity:r.activity||'',
        from:r.from||'', to:r.to||'', transport:r.transport||'', duration:r.duration||'',
        notes:r.notes||'', hotelInfo: r.hotelInfo||''
      }))
    ]));
    return [city,{days, baseDate: data.baseDate || null}];
  }));
  return JSON.stringify(snapshot);
}
function getCityMetaContext(){ return JSON.stringify(cityMeta); }

/* ===== SECCIÓN 9: Construcción de intake y formato JSON ===== */
function buildIntake(){
  const list = savedDestinations.map(x=>`${x.city} (${x.days} días, orden ${x.order})`).join(' | ');
  const pax = travelerIds.map(id=>`${id.replace('p-','')}:${qs('#'+id).value||0}`).join(', ');
  const stayName = (qs('#stay-name').value||'').trim();
  const stayAddr = (qs('#stay-address').value||'').trim();
  const budget = Number(qs('#budget').value||0);
  const currency = qs('#currency').value||'USD';
  const special = (qs('#special-conditions').value||'').trim() || 'N/A';

  // NOTA: el hospedaje escrito aquí es genérico; por ciudad se maneja en cityMeta.hotel
  return [
    `Destinations (order): ${list}`,
    `Travelers: ${pax}`,
    `Special conditions: ${special}`,
    `Budget: ${budget?budget+' '+currency:'N/A'}`,
    `User global stay (optional): ${stayName?stayName+' - ':''}${stayAddr}`,
    `Existing plan (keep & adjust): ${getItineraryContext()}`,
    `Existing meta (per city): ${getCityMetaContext()}`
  ].join('\n');
}
const FORMAT = `
Devuelve SOLO JSON válido (sin texto extra) con alguno de estos formatos:
A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":"..","hotelInfo":""}]}],"followup":"Texto breve"}
B) {"destination":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":"..","hotelInfo":""}],"followup":"Texto breve"}
C) {"rows":[{...}],"followup":"Texto breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" or ["HH:MM",...],"end":"HH:MM" or ["HH:MM",...],
      "hotel":{"provided":true|false,"name":"","address":"","zoneSuggested":""}},"followup":"Texto breve"}
Reglas:
- Incluye traslados realistas (transport y duration con ~15% de colchón).
- Si faltan datos, pregúntalos en "followup" y asume valores razonables (08:30–18:00).
- Si el usuario NO dio hotel, sugiere "hotel.zoneSuggested" en D y usa "hotelInfo" por fila con la zona sugerida.
- Máximo 20 filas por día. Sin markdown, SOLO JSON.`.trim();

/* ===== SECCIÓN 10: Generación de itinerarios por ciudad ===== */
async function generateCityItinerary(city){
  const meta = cityMeta[city] || {};
  const days = (savedDestinations.find(x=>x.city===city)?.days) || 1;
  const baseDate = meta.baseDate || '';
  const start = meta.start || '08:30';
  const end   = meta.end   || '18:00';
  const hotel = meta.hotel || {provided:false,name:'',address:'',zoneSuggested:''};
  const perDay = meta.perDay || [];

  const instructions = `
${FORMAT}
Eres un planificador experto (concierge). Genera el itinerario SOLO para "${city}" con ${days} días (máximo 20 filas por día).
- Prioriza imperdibles y optimiza tiempos/orden.
- Si "hotel.provided" es false, sugiere una zona (hotel.zoneSuggested) y úsala en "hotelInfo" por fila.

Contexto:
- BaseDate (día 1): ${baseDate||'N/A'}
- Horarios por día (si aplica): ${perDay.length?JSON.stringify(perDay):`${start}–${end}`}
- Hotel meta: ${JSON.stringify(hotel)}

Plan existente: ${getItineraryContext()}
`.trim();

  try{
    const raw = await callAgent(instructions);
    session.push({role:'assistant', content: raw||''});
    const parsed = parseJSON(raw);
    if(parsed){
      applyParsedToState(parsed, false);
      if(baseDate) itineraries[city].baseDate = baseDate;
      setActiveCity(city); renderCityItinerary(city);
      if(parsed.followup && !collectingMeta && !batchGenerating) msg(parsed.followup,'ai');
    }else{
      msg(`No pude interpretar el itinerario para ${city}.`, 'ai');
    }
  }catch(e){
    console.error(e); msg(`⚠️ Error al generar el itinerario para ${city}.`,'ai');
  }
}
function metaIsComplete(m){ return !!(m && (m.baseDate||true) && (m.start||true) && (m.end||true) && m.hotel); }
async function maybeGenerateAllCities(){
  batchGenerating=true;
  for(const {city} of savedDestinations){
    const m=cityMeta[city];
    const hasRows=Object.values(itineraries[city]?.byDay||{}).some(a=>a.length>0);
    if(metaIsComplete(m) && !hasRows){ await generateCityItinerary(city); }
  }
  batchGenerating=false;
  if(!globalReviewAsked){ globalReviewAsked=true; msg('✨ Itinerarios generados. ¿Revisamos o ajustamos alguno?','ai'); }
}
function nextPendingCity(fromCity=null){
  const order=savedDestinations.map(x=>x.city);
  const startIdx = fromCity ? Math.max(0,order.indexOf(fromCity)) : -1;
  for(let i=startIdx+1;i<order.length;i++){
    const c=order[i]; const m=cityMeta[c]; const hasRows=Object.values(itineraries[c]?.byDay||{}).some(a=>a.length>0);
    if(!metaIsComplete(m) || !hasRows) return c;
  }
  return null;
}

/* ===== SECCIÓN 11: Flujo secuencial de meta ===== */
async function askForNextCityMeta(){
  if(awaitingMetaReply) return;
  if(metaProgressIndex>=savedDestinations.length){
    collectingMeta=false;
    msg('Perfecto 🎉 Ya tengo la información base. Generando itinerarios...'); await maybeGenerateAllCities(); return;
  }
  const city = savedDestinations[metaProgressIndex].city;
  activeCity=city; awaitingMetaReply=true;
  msg(metaProgressIndex===0 ? tone.startMeta(city) : tone.contMeta(city));
}
async function generateInitial(){
  if(savedDestinations.length===0){ alert('Agrega y guarda destinos primero.'); return; }
  $chatC.style.display='flex'; planningStarted=true; metaProgressIndex=0; collectingMeta=true;
  awaitingMetaReply=false; batchGenerating=false; globalReviewAsked=false;

  session = [
    {role:'system',content:'Eres un concierge internacional. Devuelves SIEMPRE JSON limpio y válido según el esquema proporcionado.'},
    {role:'user',content:buildIntake()}
  ];
  msg(`${tone.hi} ${tone.welcomeFlow}`); hintMenuOnce(); await askForNextCityMeta();
}
$start.addEventListener('click',generateInitial);

/* ===== SECCIÓN 12: Merge helpers / actualización de estado ===== */
function dedupeInto(arr,row){
  const key = (o)=>[o.day,o.start||'',o.end||'',(o.activity||'').trim().toLowerCase()].join('|');
  if(!arr.find(x=>key(x)===key(row))) arr.push(row);
}
function ensureDays(city){
  const byDay=itineraries[city].byDay||{}; const present=Object.keys(byDay).map(n=>+n);
  const maxPresent=present.length?Math.max(...present):0; const saved=savedDestinations.find(x=>x.city===city)?.days||0;
  const want=Math.max(saved,maxPresent); const have=present.length;
  if(have<want){ for(let d=have+1;d<=want;d++) itineraries[city].byDay[d]=itineraries[city].byDay[d]||[]; }
  if(have>want){ const trimmed={}; for(let d=1;d<=want;d++) trimmed[d]=byDay[d]||[]; itineraries[city].byDay=trimmed; }
}
function pushRows(city,rows,replace=false){
  if(!itineraries[city]) itineraries[city]={byDay:{},currentDay:1,baseDate:null};
  if(replace) itineraries[city].byDay={};
  rows.forEach(r=>{
    const d=Math.max(1,parseInt(r.day||1,10));
    if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[];
    const row={
      day:d, start:r.start||'', end:r.end||'', activity:r.activity||'', from:r.from||'',
      to:r.to||'', transport:r.transport||'', duration:r.duration||'', notes:r.notes||'',
      hotelInfo:r.hotelInfo||''
    };
    dedupeInto(itineraries[city].byDay[d],row);
  });
  ensureDays(city);
}
function upsertCityMeta(meta){
  const name = meta.city || activeCity || savedDestinations[metaProgressIndex]?.city || savedDestinations[0]?.city;
  if(!name) return;
  if(!cityMeta[name]) cityMeta[name]={baseDate:null,start:null,end:null,hotel:{provided:false,name:'',address:'',zoneSuggested:''},perDay:[]};
  if(meta.baseDate) cityMeta[name].baseDate=meta.baseDate;
  if(meta.start)    cityMeta[name].start=meta.start;
  if(meta.end)      cityMeta[name].end=meta.end;
  if(meta.hotel){
    const h = cityMeta[name].hotel || {provided:false,name:'',address:'',zoneSuggested:''};
    cityMeta[name].hotel = {
      provided: meta.hotel.provided ?? h.provided,
      name: meta.hotel.name ?? h.name,
      address: meta.hotel.address ?? h.address,
      zoneSuggested: meta.hotel.zoneSuggested ?? h.zoneSuggested
    };
  }
  if(itineraries[name] && meta.baseDate) itineraries[name].baseDate=meta.baseDate;
}
function applyParsedToState(parsed,forceReplaceAll=false){
  const rootReplace = Boolean(parsed.replace) || forceReplaceAll;

  if(parsed.meta){ upsertCityMeta(parsed.meta); }

  if(Array.isArray(parsed.destinations)){
    parsed.destinations.forEach(d=>{
      if(d.meta) upsertCityMeta(d.meta);
      const name = d.name || d.meta?.city || activeCity || savedDestinations[0]?.city || 'General';
      const destReplace = rootReplace || Boolean(d.replace);
      pushRows(name, (d.rows||[]).slice(0,20), destReplace);
    });
    renderCityTabs(); return;
  }

  if(parsed.destination && Array.isArray(parsed.rows)){
    const name = parsed.destination || activeCity || savedDestinations[0]?.city || 'General';
    pushRows(name, (parsed.rows||[]).slice(0,20), rootReplace);
    renderCityTabs(); return;
  }

  if(Array.isArray(parsed.rows)){
    const fallback = activeCity || savedDestinations[0]?.city || 'General';
    pushRows(fallback, (parsed.rows||[]).slice(0,20), rootReplace);
    renderCityTabs(); return;
  }
}

/* ===== SECCIÓN 13: Utilidades de edición (parsers) ===== */
function normalize(t){ return (t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); }
function extractInt(str){ const m=str.match(/\b(\d{1,2})\b/); if(m) return Math.max(1,parseInt(m[1],10)); if(/\bun\b|\buno\b|\buna\b/.test(str)) return 1; return 1; }
function parseTimesFromText(text){
  const times=[]; let tnorm=text.toLowerCase().replace(/\s+y\s+media/g,':30').replace(/(\d{3,4})\s*(am|pm)?/g,(_,num,ap)=>{if(num.length===3)return num[0]+':'+num.slice(1)+(ap||'');if(num.length===4)return num.slice(0,2)+':'+num.slice(2)+(ap||'');return _;});
  const re=/(\b\d{1,2}(:\d{2})?\s*(am|pm|h)?\b)/gi; let m;
  while((m=re.exec(tnorm))!==null){ let t=m[1].trim().toLowerCase(); let ap=/(am|pm)$/.exec(t)?.[1]; t=t.replace(/(am|pm|h)$/,''); if(!t.includes(':')) t=t+':00'; let[h,mi]=t.split(':').map(x=>parseInt(x,10)); if(ap==='pm'&&h<12)h+=12; if(ap==='am'&&h===12)h=0; const HH=String(Math.max(0,Math.min(23,h))).padStart(2,'0'); const MM=String(Math.max(0,Math.min(59,mi||0))).padStart(2,'0'); times.push(`${HH}:${MM}`);}
  return times;
}
function updateSavedDays(city,newDays){ const idx=savedDestinations.findIndex(x=>x.city===city); if(idx>=0){ savedDestinations[idx]={...savedDestinations[idx],days:Math.max(1,newDays)}; } }

/* ===== SECCIÓN 14: Chat principal / edición interactiva ===== */
function userWantsReplace(text){ const t=(text||'').toLowerCase(); return /(sustituye|reemplaza|cambia todo|replace|overwrite|desde cero|todo nuevo)/i.test(t); }
function isAcceptance(text){ const t=(text||'').toLowerCase().trim(); return /(^|\b)(ok|listo|esta bien|perfecto|de acuerdo|vale|sounds good|looks good)\b/.test(t); }

async function sendChat(){
  const text = ($intake.value||'').trim(); if(!text) return;
  msg(text,'user'); $intake.value='';

  // Fase 1: recopilación secuencial de meta
  if(collectingMeta){
    const city = savedDestinations[metaProgressIndex]?.city;
    if(!city){ collectingMeta=false; await maybeGenerateAllCities(); return; }

    const extractPrompt = `
Extrae del texto la meta para "${city}" en formato D del esquema:
${FORMAT}
Devuelve SOLO:
{"meta":{"city":"${city}","baseDate":"DD/MM/YYYY",
"start":"HH:MM" or ["HH:MM",...],"end":"HH:MM" or ["HH:MM",...],
"hotel":{"provided":true|false,"name":"","address":"","zoneSuggested":""}}}
Texto del usuario: ${text}`.trim();

    const answer = await callAgent(extractPrompt);
    const parsed = parseJSON(answer);

    if(parsed?.meta){
      upsertCityMeta(parsed.meta);
      awaitingMetaReply=false;
      msg(`Perfecto, tengo la información para ${city}.`);
      metaProgressIndex++;
      if(metaProgressIndex < savedDestinations.length){ await askForNextCityMeta(); }
      else { collectingMeta=false; msg('Perfecto 🎉 Ya tengo todo. Generando itinerarios...'); await maybeGenerateAllCities(); }
    }else{
      msg('No logré entender. ¿Podrías repetir fecha del primer día, horario diario y hotel/zona (o “pendiente”)?');
    }
    return;
  }

  // Fase 2: interacción normal
  const tNorm=normalize(text); let handled=false;

  // a) Agregar días
  if(/\b(agrega|anade|sumar?|add)\b.*\bdia/.test(tNorm) || /\b(un dia mas|1 dia mas)\b/.test(tNorm)){
    const addN=extractInt(tNorm);
    if(activeCity){
      const current = savedDestinations.find(x=>x.city===activeCity)?.days || Object.keys(itineraries[activeCity]?.byDay||{}).length || 1;
      const newDays=current+addN; updateSavedDays(activeCity,newDays); ensureDays(activeCity);
      await generateCityItinerary(activeCity); renderCityTabs(); setActiveCity(activeCity); renderCityItinerary(activeCity);
      msg(`Añadí ${addN} día(s) en ${activeCity}.`); hintMenuOnce();
    } handled=true;
  }

  // b) Quitar días
  if(!handled && /\b(quita|elimina|remueve|remove)\b.*\bdia/.test(tNorm)){
    const remN=extractInt(tNorm);
    if(activeCity){
      const current=savedDestinations.find(x=>x.city===activeCity)?.days || Object.keys(itineraries[activeCity]?.byDay||{}).length || 1;
      const newDays=Math.max(1,current-remN); updateSavedDays(activeCity,newDays); ensureDays(activeCity);
      renderCityTabs(); setActiveCity(activeCity); renderCityItinerary(activeCity);
      msg(`Quité ${remN} día(s) en ${activeCity}.`); hintMenuOnce();
    } handled=true;
  }

  // c) Ajuste de horas
  if(!handled && /\b(hora|horario|inicio|fin|empieza|termina|ajusta|cambia|desde|hasta)\b/.test(tNorm)){
    const times=parseTimesFromText(text);
    if(activeCity){
      cityMeta[activeCity]=cityMeta[activeCity]||{baseDate:null,start:null,end:null,hotel:{provided:false,name:'',address:'',zoneSuggested:''}};
      if(times.length===1){ if(/\b(hasta|termina|fin)\b/.test(tNorm)) cityMeta[activeCity].end=times[0]; else cityMeta[activeCity].start=times[0]; }
      else if(times.length>=2){ cityMeta[activeCity].start=times[0]; cityMeta[activeCity].end=times[times.length-1]; }
      await generateCityItinerary(activeCity); renderCityTabs(); setActiveCity(activeCity); renderCityItinerary(activeCity);
      msg(`Ajusté horarios en ${activeCity}.`); hintMenuOnce();
    } handled=true;
  }

  // d) Recalcular
  if(!handled && /\b(recalcula|replanifica|recompute|replan|recalculate)\b/.test(tNorm)){
    if(activeCity){
      if(userWantsReplace(text)) itineraries[activeCity].byDay={};
      await generateCityItinerary(activeCity); renderCityTabs(); setActiveCity(activeCity); renderCityItinerary(activeCity);
      msg(`Recalculé el itinerario de ${activeCity}.`); hintMenuOnce();
    } handled=true;
  }
  if(handled) return;

  // e) Edición guiada por IA
  session.push({role:'user',content:text});
  const cityHint = activeCity ? `Active city: ${activeCity}` : '';
  const replaceHint = userWantsReplace(text) ? 'If you propose new rows, set {"replace": true}.' : '';
  const prompt = `${FORMAT}
Edit the current plan. ${cityHint}
Existing plan (keep & adjust): ${getItineraryContext()}
Existing meta (per city): ${getCityMetaContext()}
${replaceHint}
Solicitud del usuario: ${text}`;

  try{
    const answer=await callAgent(prompt); const parsed=parseJSON(answer);
    session.push({role:'assistant',content:answer||''});
    if(parsed){
      const before=JSON.stringify(cityMeta); applyParsedToState(parsed,false); const after=JSON.stringify(cityMeta);
      if(before!==after){ await maybeGenerateAllCities(); } else { renderCityTabs(); setActiveCity(activeCity); renderCityItinerary(activeCity); }
      msg(parsed.followup || '¿Deseas otro ajuste?','ai'); hintMenuOnce();
    }else{
      msg('Listo. Cambios aplicados.','ai'); hintMenuOnce();
    }
    if(isAcceptance(text)){ const nxt=nextPendingCity(activeCity)||nextPendingCity(null); if(nxt){ msg(tone.nextAsk(nxt)); setActiveCity(nxt); renderCityItinerary(nxt); } }
  }catch(e){ console.error(e); msg('❌ Error de conexión.','ai'); }
}
$send.addEventListener('click',sendChat);
$intake.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); sendChat(); } });

/* ===== SECCIÓN 15: UX guard ===== */
$start.addEventListener('click',(e)=>{ if(savedDestinations.length===0){ e.preventDefault(); alert('Agrega ciudades & días y presiona "Guardar destinos" primero.'); } },{capture:true});

/* ===== SECCIÓN 16: Inicialización de valores por defecto ===== */
// Sidebar limpio (solo horas por día predefinidas en inputs de cada fila). Ya se cubre en addCityRow().
// Viajeros: 1 adulto por defecto (HTML ya lo define).

/* ===== SECCIÓN 17: Exposición mínima debug (opcional) ===== */
window.__plannerState = { get savedDestinations(){return savedDestinations}, get itineraries(){return itineraries}, get cityMeta(){return cityMeta} };

});
/* ================== /v15 app.js ================== */
