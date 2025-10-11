/* =========================================================
   ITRAVELBYMYOWN · PLANNER v7  (basado en v6 estable)
   Ajustes mínimos:
   - Campo “País” incluido.
   - Autoformato de fecha DD/MM/AAAA.
   - Horas por defecto 08:30–18:00.
   - Layout coherente con v7 (sidebar 520px).
   - Eliminado mensaje redundante “Destinos guardados”.
========================================================= */

/* ==== UTILIDADES ==== */
const qs=(s,ctx=document)=>ctx.querySelector(s);
const qsa=(s,ctx=document)=>Array.from(ctx.querySelectorAll(s));

const API_URL='https://itravelbymyown-api.vercel.app/api/chat';
let savedDestinations=[], itineraries={}, cityMeta={}, session=[];
let activeCity=null, planningStarted=false, collectingHotels=false, metaProgressIndex=0;

/* ==== FORMATO DE FECHA ==== */
function autoFormatDMYInput(el){
  if(!el) return;
  el.addEventListener('input',()=>{
    const v=el.value.replace(/\D/g,'').slice(0,8);
    if(v.length===8) el.value=`${v.slice(0,2)}/${v.slice(2,4)}/${v.slice(4,8)}`;
    else el.value=v;
  });
}
function parseDMY(str){
  const m=/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(str.trim());
  if(!m)return null;
  return new Date(+m[3],+m[2]-1,+m[1]);
}
function formatDMY(d){
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}
function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x;}

/* ==== CHAT ==== */
function msg(text,who='ai'){
  if(!text)return;
  const div=document.createElement('div');
  div.className='chat-message '+(who==='user'?'user':'ai');
  div.innerHTML=text;
  qs('#chat-messages').appendChild(div);
  qs('#chat-messages').scrollTop=qs('#chat-messages').scrollHeight;
}

/* ==== CREADOR DE FILAS DE CIUDAD ==== */
function makeHoursBlock(days){
  const wrap=document.createElement('div');wrap.className='hours-block';
  for(let d=1;d<=days;d++){
    const row=document.createElement('div');
    row.className='hours-day';
    row.innerHTML=`<span>Día ${d}</span>
      <input class="start" type="time" value="08:30">
      <input class="end" type="time" value="18:00">`;
    wrap.appendChild(row);
  }
  return wrap;
}

function addCityRow(pref={city:'',country:'',days:1,baseDate:''}){
  const row=document.createElement('div');
  row.className='city-row';
  row.innerHTML=`
    <div>
      <label>Ciudad</label>
      <input class="city-name" type="text" placeholder="Ciudad" value="${pref.city}">
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
    <div>
      <button class="remove" type="button">✖</button>
    </div>
  `;
  const base=qs('.base-date',row);
  autoFormatDMYInput(base);

  const hours=makeHoursBlock(pref.days||1);
  row.appendChild(hours);

  qs('.remove',row).addEventListener('click',()=>row.remove());
  qs('.city-days',row).addEventListener('change',e=>{
    const n=Math.max(1,parseInt(e.target.value||1));
    e.target.value=n;
    hours.innerHTML='';
    for(let d=1;d<=n;d++){
      const r=document.createElement('div');
      r.className='hours-day';
      r.innerHTML=`<span>Día ${d}</span>
        <input class="start" type="time" value="08:30">
        <input class="end" type="time" value="18:00">`;
      hours.appendChild(r);
    }
  });

  qs('#cities-container').appendChild(row);
}

/* ==== GUARDAR DESTINOS ==== */
function saveDestinations(){
  const rows=qsa('.city-row');
  const list=[];
  rows.forEach(r=>{
    const city=qs('.city-name',r)?.value.trim()||'';
    if(!city)return;
    const country=qs('.country-name',r)?.value.trim()||'';
    const days=parseInt(qs('.city-days',r)?.value||1);
    const baseDate=qs('.base-date',r)?.value.trim()||'';
    const perDay=[];
    qsa('.hours-day',r).forEach((hd,idx)=>{
      const start=qs('.start',hd)?.value||'08:30';
      const end=qs('.end',hd)?.value||'18:00';
      perDay.push({day:idx+1,start,end});
    });
    list.push({city,country,days,baseDate,perDay});
  });

  savedDestinations=list;
  savedDestinations.forEach(({city,days,baseDate,perDay})=>{
    if(!itineraries[city]) itineraries[city]={byDay:{},currentDay:1,baseDate:baseDate||null};
    if(!cityMeta[city]) cityMeta[city]={baseDate,hotel:'',perDay};
    for(let d=1;d<=days;d++){
      if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[];
    }
  });
  renderCityTabs();
  qs('#start-planning').disabled=!savedDestinations.length;
}

/* ==== TABS / ITINERARIOS ==== */
function setActiveCity(name){
  activeCity=name;
  qsa('.city-tab').forEach(b=>b.classList.toggle('active',b.dataset.city===name));
}
function renderCityTabs(){
  const $tabs=qs('#city-tabs');
  const prev=activeCity;
  $tabs.innerHTML='';
  savedDestinations.forEach(({city})=>{
    const b=document.createElement('button');
    b.textContent=city;
    b.className='city-tab'+(city===prev?' active':'');
    b.dataset.city=city;
    b.onclick=()=>{setActiveCity(city);renderCityItinerary(city)};
    $tabs.appendChild(b);
  });
  if(savedDestinations.length){
    const valid=prev&&savedDestinations.some(x=>x.city===prev)?prev:savedDestinations[0].city;
    setActiveCity(valid);
    renderCityItinerary(valid);
  }else{
    activeCity=null;qs('#itinerary-container').innerHTML='';
  }
}

function ensureDays(city){
  const data=itineraries[city];
  if(!data)return;
  const days=savedDestinations.find(x=>x.city===city)?.days||1;
  for(let d=1;d<=days;d++){
    if(!data.byDay[d]) data.byDay[d]=[];
  }
}

function renderCityItinerary(city){
  if(!itineraries[city])return;
  ensureDays(city);
  const data=itineraries[city];
  const $wrap=qs('#itinerary-container');
  $wrap.innerHTML='';
  const base=parseDMY(data.baseDate||cityMeta[city]?.baseDate||'');
  const days=Object.keys(data.byDay).map(n=>+n).sort((a,b)=>a-b);
  const sections=[];
  days.forEach(d=>{
    const sec=document.createElement('div');
    const dateLabel=base?` (${formatDMY(addDays(base,d-1))})`:'';
    sec.innerHTML=`<div class="day-title"><strong>Día ${d}</strong>${dateLabel}</div>
    <table class="itinerary"><thead>
    <tr><th>Inicio</th><th>Fin</th><th>Actividad</th><th>Desde</th>
    <th>Hacia</th><th>Transporte</th><th>Duración</th><th>Notas</th></tr>
    </thead><tbody></tbody></table>`;
    const tb=qs('tbody',sec);
    (data.byDay[d]||[]).forEach(r=>{
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${r.start||''}</td><td>${r.end||''}</td>
      <td>${r.activity||''}</td><td>${r.from||''}</td><td>${r.to||''}</td>
      <td>${r.transport||''}</td><td>${r.duration||''}</td><td>${r.notes||''}</td>`;
      tb.appendChild(tr);
    });
    $wrap.appendChild(sec);sections.push(sec);
  });
}

/* ==== CHAT FLOW ==== */
function buildIntake(){
  const pax=[
    ['adults','#p-adults'],['young','#p-young'],['children','#p-children'],
    ['infants','#p-infants'],['seniors','#p-seniors']
  ].map(([k,id])=>`${k}:${qs(id)?.value||0}`).join(', ');
  const list=savedDestinations.map(x=>{
    const dates=x.baseDate?`, start=${x.baseDate}`:'';
    return `${x.city} (${x.country||'—'} · ${x.days} días${dates})`;
  }).join(' | ');
  const special=qs('#special-conditions')?.value.trim()||'N/A';
  return [`Destinations: ${list}`,`Travelers: ${pax}`,`Special: ${special}`].join('\n');
}

async function callAgent(text){
  try{
    const res=await fetch(API_URL,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'gpt-5-nano',input:text,history:session})
    });
    const data=await res.json();
    return data.text||'';
  }catch{ return ''; }
}

/* ==== FLUJO PRINCIPAL ==== */
async function startPlanning(){
  if(!savedDestinations.length)return;
  qs('#chat-container').style.display='flex';
  planningStarted=true;collectingHotels=true;metaProgressIndex=0;
  session=[
    {role:'system',content:'Eres un concierge de viajes. Responde con JSON válido.'},
    {role:'user',content:buildIntake()}
  ];
  msg('¡Bienvenido! 👋 Soy tu concierge de viajes personal. Te guiaré ciudad por ciudad.');
  askNextHotel();
}

function askNextHotel(){
  if(metaProgressIndex>=savedDestinations.length){
    collectingHotels=false;
    msg('✨ Perfecto. Generando itinerarios...');
    generateAll();
    return;
  }
  const city=savedDestinations[metaProgressIndex].city;
  setActiveCity(city);renderCityItinerary(city);
  msg(`¿En qué hotel/zona te hospedarás en <strong>${city}</strong>?<br>
  <small>Si aún no lo tienes, escribe <em>pendiente</em>. Luego podremos ajustar.</small>`,'ai');
}

async function generateAll(){
  for(const {city} of savedDestinations){
    await generateCityItinerary(city);
  }
  msg('🎉 Todos los itinerarios fueron generados.');
}

async function generateCityItinerary(city){
  const dest=savedDestinations.find(x=>x.city===city);
  const baseDate=dest.baseDate||'';
  const perDay=dest.perDay||[];
  const prompt=`Genera un itinerario en formato JSON para ${city} durante ${dest.days} días.
Horas por día: ${JSON.stringify(perDay)}
Fecha inicial: ${baseDate}`;
  const text=await callAgent(prompt);
  try{
    const parsed=JSON.parse(text);
    if(Array.isArray(parsed.rows)){
      itineraries[city].byDay={};
      parsed.rows.forEach(r=>{
        const d=r.day||1;
        if(!itineraries[city].byDay[d])itineraries[city].byDay[d]=[];
        itineraries[city].byDay[d].push(r);
      });
      renderCityTabs();setActiveCity(city);renderCityItinerary(city);
    }
  }catch(e){console.warn('No JSON válido');}
}

/* ==== CHAT HANDLER ==== */
async function sendChat(){
  const val=qs('#intake').value.trim();if(!val)return;
  msg(val,'user');qs('#intake').value='';
  if(collectingHotels){
    const city=savedDestinations[metaProgressIndex].city;
    cityMeta[city].hotel=val;
    msg(`Hotel/Zona guardado para ${city}.`,'ai');
    metaProgressIndex++;askNextHotel();
    return;
  }
  msg('Procesando solicitud...','ai');
}

/* ==== EVENTOS ==== */
qs('#add-city')?.addEventListener('click',()=>addCityRow());
qs('#save-destinations')?.addEventListener('click',saveDestinations);
qs('#start-planning')?.addEventListener('click',startPlanning);
qs('#send-btn')?.addEventListener('click',sendChat);
qs('#intake')?.addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();sendChat();}
});

/* ==== BOTONES DE BARRA ==== */
qs('#btn-pdf')?.addEventListener('click',()=>alert('Exportar PDF'));
qs('#btn-email')?.addEventListener('click',()=>alert('Enviar Email'));
qs('#btn-maps')?.addEventListener('click',()=>window.open('https://maps.google.com','_blank'));
qs('#btn-transport')?.addEventListener('click',()=>window.open('https://www.rome2rio.com/','_blank'));
qs('#btn-weather')?.addEventListener('click',()=>window.open('https://weather.com','_blank'));
qs('#btn-clothing')?.addEventListener('click',()=>window.open('https://www.packup.ai/','_blank'));
qs('#btn-restaurants')?.addEventListener('click',()=>window.open('https://www.thefork.com/','_blank'));
qs('#btn-gas')?.addEventListener('click',()=>window.open('https://www.google.com/maps/search/gas+station','_blank'));
qs('#btn-bathrooms')?.addEventListener('click',()=>window.open('https://www.google.com/maps/search/public+restrooms','_blank'));
qs('#btn-lodging')?.addEventListener('click',()=>window.open('https://www.booking.com','_blank'));
qs('#btn-localinfo')?.addEventListener('click',()=>window.open('https://www.wikivoyage.org','_blank'));

/* ==== UPSELL ==== */
qs('#confirm-itinerary')?.addEventListener('click',()=>{
  qs('#monetization-upsell').style.display='flex';
});
qs('#upsell-close')?.addEventListener('click',()=>{
  qs('#monetization-upsell').style.display='none';
});

// Inicial: una fila lista
addCityRow();
