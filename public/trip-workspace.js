(()=>{
'use strict';
const KEY='itbmo_trip_workspace_snapshot_v1';
const $=(s,r=document)=>r.querySelector(s);
const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
let data=null,city=null,day=null,mode='itinerary';
const contextByCity=new Map();
const contextRequests=new Map();
const requestedLang=new URLSearchParams(location.search).get('lang');
const copy={
 es:{back:'Volver al Planner',prepareBadge:'Explora',ready:'Tu viaje está listo',overviewK:'TU VIAJE ITBMO',overviewT:'¿Por dónde quieres empezar?',overviewC:'Elige una ciudad para explorarla día a día y preparar lo que realmente necesitas.',city:'ciudad',cities:'ciudades',d:'día',ds:'días',organized:'organizados',explore:'Explorar',all:'Todas las ciudades',cityK:'TU CIUDAD',it:'Itinerario',prep:'Para tu viaje',wholeK:'PARA TODO TU VIAJE',wholeT:'Lo esencial que viaja contigo.',wholeC:'Aquí aparecerán servicios de alcance general únicamente cuando aporten valor real a tu viaje.',coming:'Próximamente',details:'Ver detalles',hide:'Ocultar detalles',route:'Trayecto',transport:'Transporte',duration:'Duración',notes:'Detalles',prepareT:'Todo lo que necesitas para vivir',prepareC:'Tu itinerario ya está organizado. Aquí reuniremos únicamente lo que conviene resolver para hacerlo realidad.',tickets:'Entradas y reservas',ticketsC:'Accesos, horarios y reservas que realmente requiere tu itinerario.',tours:'Tours y experiencias',toursC:'Alternativas guiadas y experiencias que encajan con lo que ya planeaste.',move:'Cómo moverte',moveC:'Opciones útiles de movilidad relacionadas con esta ciudad.',more:'Más para tu viaje',moreC:'Otros servicios relevantes, solo cuando aporten valor.',contextLoading:'Analizando lo que necesitas para este viaje…',contextError:'No pudimos analizar esta ciudad ahora. Puedes seguir usando tu itinerario normalmente.',contextEmpty:'No detectamos nada que necesites resolver aquí.',required:'Entrada necesaria',recommended:'Conviene reservar',optional:'Opcional',journey:'Trayecto',dayLabel:'Día',next:'Próximamente',loading:'Recuperando tu viaje…',emptyT:'No pudimos cargar este viaje.',emptyC:'Vuelve al Planner para abrirlo nuevamente o inicia sesión si este viaje pertenece a tu cuenta.'},
 en:{back:'Back to Planner',prepareBadge:'Explore',ready:'Your trip is ready',overviewK:'YOUR ITBMO TRIP',overviewT:'Where do you want to start?',overviewC:'Choose a city to explore it day by day and prepare what you actually need.',city:'city',cities:'cities',d:'day',ds:'days',organized:'organized',explore:'Explore',all:'All cities',cityK:'YOUR CITY',it:'Itinerary',prep:'For your trip',wholeK:'FOR YOUR WHOLE TRIP',wholeT:'The essentials that travel with you.',wholeC:'Trip-wide services will appear here only when they add real value to your journey.',coming:'Coming next',details:'View details',hide:'Hide details',route:'Route',transport:'Transport',duration:'Duration',notes:'Details',prepareT:'Everything you need to experience',prepareC:'Your itinerary is already organized. Here we will bring together only what is worth arranging to make it happen.',tickets:'Tickets & reservations',ticketsC:'Access, schedules and reservations your itinerary actually requires.',tours:'Tours & experiences',toursC:'Guided alternatives and experiences that fit what you already planned.',move:'Getting around',moveC:'Useful mobility options related to this city.',more:'More for your trip',moreC:'Other relevant services, only when they add value.',contextLoading:'Analyzing what you need for this trip…',contextError:'We could not analyze this city right now. You can keep using your itinerary normally.',contextEmpty:'Nothing here appears to require action from you.',required:'Ticket needed',recommended:'Reservation recommended',optional:'Optional',journey:'Journey',dayLabel:'Day',next:'Coming next',loading:'Recovering your trip…',emptyT:'We could not load this trip.',emptyC:'Return to the Planner to open it again, or sign in if this trip belongs to your account.'}
};
let lang='es',t=copy.es;
function parseDate(v){if(!v)return null;let m=String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);if(m)return new Date(+m[3],+m[2]-1,+m[1]);m=String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);if(m)return new Date(+m[1],+m[2]-1,+m[3]);return null}
function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x}
function fmt(d){if(!d)return'';return new Intl.DateTimeFormat(lang==='es'?'es-ES':'en-US',{day:'numeric',month:'short',year:'numeric'}).format(d)}
function cities(){const ordered=(data?.destinations||[]).map(x=>x.city).filter(Boolean),extras=Object.keys(data?.itineraries||{}).filter(x=>!ordered.includes(x));return [...ordered,...extras].filter(c=>days(c).some(d=>(data?.itineraries?.[c]?.byDay?.[d]||[]).length))}
function days(c){return Object.keys(data?.itineraries?.[c]?.byDay||{}).map(Number).filter(Number.isFinite).sort((a,b)=>a-b)}
function base(c){return parseDate(data?.itineraries?.[c]?.baseDate||data?.city_meta?.[c]?.baseDate||'')}
function range(c){const ds=days(c),b=base(c);if(!b||!ds.length)return'';const a=fmt(addDays(b,ds[0]-1)),z=fmt(addDays(b,ds.at(-1)-1));return a===z?a:`${a} – ${z}`}
function setText(){document.documentElement.lang=lang;
const plannerUrl=`./planner.html?lang=${encodeURIComponent(lang)}`;
const homeUrl=`./preview-home.html?lang=${encodeURIComponent(lang)}`;
const brand=$('.tw-brand');if(brand)brand.setAttribute('href',homeUrl);
$('#tw-back-planner').setAttribute('data-planner-url',plannerUrl);
$('#tw-empty-back').setAttribute('data-planner-url',plannerUrl);
const badge=$('#tw-prepare-badge');if(badge)badge.textContent=t.prepareBadge;
$('#tw-back-label').textContent=t.back;$('#tw-status-label').textContent=t.ready;$('#tw-overview-kicker').textContent=t.overviewK;$('#tw-overview-title').textContent=t.overviewT;$('#tw-overview-copy').textContent=t.overviewC;$('#tw-trip-kicker').textContent=t.wholeK;$('#tw-trip-title').textContent=t.wholeT;$('#tw-trip-copy').textContent=t.wholeC;$('#tw-coming').textContent=t.coming;$('#tw-all-cities span').textContent=t.all;$('#tw-city-kicker').textContent=t.cityK;$('#tw-mode-itinerary b').textContent=t.it;$('#tw-mode-prepare b').textContent=t.prep}
function overview(){city=null;$('#tw-city').hidden=true;$('#tw-overview').hidden=false;const cs=cities(),total=cs.reduce((n,c)=>n+days(c).length,0);$('#tw-overview-summary').textContent=`${cs.length} ${cs.length===1?t.city:t.cities} · ${total} ${total===1?t.d:t.ds}`;const grid=$('#tw-city-grid');grid.innerHTML='';cs.forEach((c,i)=>{const b=document.createElement('button');b.type='button';b.className='tw-city-card';b.innerHTML=`<span class="tw-city-num">${String(i+1).padStart(2,'0')}</span><small>${esc(range(c))}</small><h2>${esc(c)}</h2><p>${days(c).length} ${esc(t.ds)} ${esc(t.organized)}</p><span class="tw-city-go">${esc(t.explore)} <i>→</i></span>`;b.onclick=()=>enter(c);grid.appendChild(b)});scrollTo({top:0,behavior:'smooth'})}
function enter(c){city=c;const ds=days(c);day=ds.includes(Number(data?.itineraries?.[c]?.currentDay))?Number(data.itineraries[c].currentDay):ds[0];mode='itinerary';$('#tw-overview').hidden=true;$('#tw-city').hidden=false;renderCity();scrollTo({top:0,behavior:'smooth'})}
function renderCity(){if(!city)return;$('#tw-city-name').textContent=city;$('#tw-city-dates').textContent=range(city);const ib=$('#tw-mode-itinerary'),pb=$('#tw-mode-prepare');ib.classList.toggle('active',mode==='itinerary');pb.classList.toggle('active',mode==='prepare');ib.setAttribute('aria-selected',mode==='itinerary');pb.setAttribute('aria-selected',mode==='prepare');renderDays();mode==='itinerary'?renderItinerary():renderPrepare()}
function renderDays(){const nav=$('#tw-days');nav.hidden=mode!=='itinerary';nav.innerHTML='';if(nav.hidden)return;days(city).forEach(d=>{const b=document.createElement('button');b.type='button';b.className='tw-day'+(d===day?' active':'');b.textContent=lang==='es'?`Día ${d}`:`Day ${d}`;b.onclick=()=>{day=d;renderCity();window.scrollTo({top:Math.max(0,$('#tw-content').offsetTop-160),behavior:'smooth'})};nav.appendChild(b)})}
function cleanDuration(v){return String(v||'').replace(/\s*\|\s*/g,' · ').replace(/\n+/g,' · ').trim()}
function renderItinerary(){const rows=data?.itineraries?.[city]?.byDay?.[day]||[],b=base(city),date=b?fmt(addDays(b,day-1)):'',ds=days(city),idx=ds.indexOf(day);let html=`<div class="tw-day-header"><div><span class="tw-kicker">${esc(city)}</span><h2>${lang==='es'?'Día':'Day'} ${day}${date?` · ${esc(date)}`:''}</h2></div><span class="tw-day-count">${idx+1} / ${ds.length}</span></div><div class="tw-timeline">`;rows.forEach((r,i)=>{const activity=String(r.activity||'').replace(/^rev:\s*/i,''),notes=String(r.notes||'').replace(/^\s*valid:\s*/i,'').trim(),route=[r.from,r.to].filter(Boolean).join(' → ');html+=`<article class="tw-stop"><div class="tw-time">${esc(r.start||'')}<small>${esc(r.end||'')}</small></div><div class="tw-node"></div><div class="tw-stop-card"><h3>${esc(activity)}</h3><div class="tw-pills">${r.transport?`<span class="tw-pill">${esc(r.transport)}</span>`:''}${r.duration?`<span class="tw-pill">${esc(cleanDuration(r.duration))}</span>`:''}</div>${(route||notes)?`<button class="tw-details-btn" type="button" data-detail="${i}">${esc(t.details)} ＋</button><div class="tw-details" id="tw-detail-${i}" hidden>${route?`<div class="tw-detail"><small>${esc(t.route)}</small><b>${esc(route)}</b></div>`:''}${r.transport?`<div class="tw-detail"><small>${esc(t.transport)}</small><b>${esc(r.transport)}</b></div>`:''}${r.duration?`<div class="tw-detail"><small>${esc(t.duration)}</small><b>${esc(cleanDuration(r.duration))}</b></div>`:''}${notes?`<div class="tw-detail"><small>${esc(t.notes)}</small><b>${esc(notes)}</b></div>`:''}</div>`:''}</div></article>`});html+='</div>';$('#tw-content').innerHTML=html;document.querySelectorAll('[data-detail]').forEach(btn=>btn.onclick=()=>{const box=$(`#tw-detail-${btn.dataset.detail}`),open=!box.hidden;box.hidden=open;btn.textContent=(open?t.details:t.hide)+(open?' ＋':' −')})}
function contextLabel(item){
  if(item?.need_type==='ticket_required') return t.required;
  if(item?.need_type==='reservation_recommended') return t.recommended;
  if(item?.need_type==='guided_tour_optional') return t.optional;
  if(item?.need_type==='intercity_transport') return t.journey;
  return '';
}

function renderNeedItems(items){
  if(!items.length) return `<div class="tw-context-empty">${esc(t.contextEmpty)}</div>`;
  return `<div class="tw-context-list">${items.map(item=>`
    <article class="tw-context-item">
      <div class="tw-context-item-head">
        <div>
          <span class="tw-context-day">${esc(t.dayLabel)} ${esc(item.day)}</span>
          <h4>${esc(item.entity_name || item.source_activity || '')}</h4>
        </div>
        <span class="tw-context-label">${esc(contextLabel(item))}</span>
      </div>
      ${item.user_message?`<p>${esc(item.user_message)}</p>`:''}
      ${item.source_route?`<small class="tw-context-route">${esc(item.source_route)}${item.transport?` · ${esc(item.transport)}`:''}</small>`:''}
    </article>`).join('')}</div>`;
}

function prepareCard(icon,title,description,items){
  return `<article class="tw-prepare-card tw-prepare-card-live">
    <span>${icon}</span>
    <h3>${esc(title)}</h3>
    <p>${esc(description)}</p>
    ${renderNeedItems(items)}
  </article>`;
}

async function fetchContext(cityName){
  const token=getStoredSessionToken();
  if(!token || !data?.trip_id) throw new Error('CONTEXT_SESSION_REQUIRED');

  const response=await fetch('/api/context',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      session_token:token,
      trip_id:data.trip_id,
      city:cityName
    })
  });

  let payload={};
  try{ payload=await response.json(); }catch(_){}

  if(!response.ok || !payload?.ok){
    const error=new Error(payload?.code || 'CONTEXT_ERROR');
    error.code=payload?.code || 'CONTEXT_ERROR';
    throw error;
  }

  return Array.isArray(payload.needs) ? payload.needs : [];
}

function ensureContext(cityName){
  if(contextByCity.has(cityName)) return Promise.resolve(contextByCity.get(cityName));
  if(contextRequests.has(cityName)) return contextRequests.get(cityName);

  const request=fetchContext(cityName)
    .then(needs=>{
      contextByCity.set(cityName,{status:'ready',needs});
      contextRequests.delete(cityName);
      if(city===cityName && mode==='prepare') renderPrepare();
      return needs;
    })
    .catch(error=>{
      console.warn('[CONTEXT INTELLIGENCE]',error);
      contextByCity.set(cityName,{status:'error',needs:[]});
      contextRequests.delete(cityName);
      if(city===cityName && mode==='prepare') renderPrepare();
      return [];
    });

  contextRequests.set(cityName,request);
  return request;
}

function renderPrepare(){
  const c=esc(city);
  const state=contextByCity.get(city);

  if(!state){
    $('#tw-content').innerHTML=`<section class="tw-prepare-hero">
      <span class="tw-prepare-mark">✦</span>
      <span class="tw-kicker">${c}</span>
      <h2>${esc(t.prepareT)} ${c}.</h2>
      <p>${esc(t.prepareC)}</p>
    </section>
    <div class="tw-context-loading"><span class="tw-context-spinner"></span><b>${esc(t.contextLoading)}</b></div>`;
    ensureContext(city);
    return;
  }

  if(state.status==='error'){
    $('#tw-content').innerHTML=`<section class="tw-prepare-hero">
      <span class="tw-prepare-mark">✦</span>
      <span class="tw-kicker">${c}</span>
      <h2>${esc(t.prepareT)} ${c}.</h2>
      <p>${esc(t.prepareC)}</p>
    </section>
    <div class="tw-context-error">${esc(t.contextError)}</div>`;
    return;
  }

  const needs=Array.isArray(state.needs)?state.needs:[];
  const tickets=needs.filter(item=>item.category==='tickets');
  const tours=needs.filter(item=>item.category==='tours');
  const transport=needs.filter(item=>item.category==='transport');

  $('#tw-content').innerHTML=`<section class="tw-prepare-hero">
    <span class="tw-prepare-mark">✦</span>
    <span class="tw-kicker">${c}</span>
    <h2>${esc(t.prepareT)} ${c}.</h2>
    <p>${esc(t.prepareC)}</p>
  </section>
  <div class="tw-prepare-grid">
    ${prepareCard('🎟',t.tickets,t.ticketsC,tickets)}
    ${prepareCard('✦',t.tours,t.toursC,tours)}
    ${prepareCard('↗',t.move,t.moveC,transport)}
    <article class="tw-prepare-card">
      <span>＋</span>
      <h3>${esc(t.more)}</h3>
      <p>${esc(t.moreC)}</p>
      <small>${esc(t.next)}</small>
    </article>
  </div>`;
}
function getStoredSessionToken(){
  try{
    return String(
      sessionStorage.getItem('itbmo_guest_session_token') ||
      localStorage.getItem('itbmo_session_token') ||
      ''
    ).trim();
  }catch(_){ return ''; }
}

function readSnapshot(){
  try{
    const parsed=JSON.parse(localStorage.getItem(KEY)||'null');
    return parsed && typeof parsed==='object' && !Array.isArray(parsed) ? parsed : null;
  }catch(_){ return null; }
}

function tripToWorkspace(trip){
  if(!trip?.id || trip.status!=='generated') return null;
  const checkpoint=(trip.itinerary_data && typeof trip.itinerary_data==='object')
    ? trip.itinerary_data
    : {};
  const itineraries=(checkpoint.itineraries && typeof checkpoint.itineraries==='object')
    ? checkpoint.itineraries
    : {};
  const cityMeta=(checkpoint.city_meta && typeof checkpoint.city_meta==='object')
    ? checkpoint.city_meta
    : {};
  const destinations=(Array.isArray(trip.destinations) ? trip.destinations : []).map(d=>({
    city:String(d?.city||'').trim(),
    days:Math.max(1,Number(d?.days||1)),
    baseDate:d?.base_date || d?.baseDate || null
  })).filter(d=>d.city);

  if(!destinations.length || !Object.keys(itineraries).length) return null;

  return {
    schema_version:2,
    source:'trip_api',
    created_at:trip.generated_at || trip.updated_at || null,
    lang:trip.language==='en'?'en':'es',
    trip_id:trip.id,
    destinations,
    city_meta:cityMeta,
    itineraries
  };
}

async function fetchTripWorkspace(tripId){
  const token=getStoredSessionToken();
  if(!tripId || !token) return null;

  const response=await fetch('/api/trip',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      action:'get',
      session_token:token,
      trip_id:tripId
    })
  });

  let payload={};
  try{ payload=await response.json(); }catch(_){}

  if(!response.ok || !payload?.ok || !payload?.trip) return null;
  return tripToWorkspace(payload.trip);
}

function showEmpty(){
  $('#tw-overview').hidden=true;
  $('#tw-city').hidden=true;
  $('#tw-empty').hidden=false;
  const title=$('#tw-empty h1');
  const body=$('#tw-empty p');
  if(title) title.textContent=t.emptyT;
  if(body) body.textContent=t.emptyC;
}

function backPlanner(){
  const params=new URLSearchParams();
  params.set('lang',lang);
  if(data?.trip_id) params.set('trip_id',data.trip_id);
  window.location.replace(`./planner.html?${params.toString()}`);
}

async function boot(){
  const params=new URLSearchParams(location.search);
  const requestedTripId=String(params.get('trip_id') || '').trim();
  const cached=readSnapshot();

  lang=(requestedLang==='en'||requestedLang==='es')
    ? requestedLang
    : (cached?.lang==='en'?'en':'es');
  t=copy[lang];
  setText();

  const status=$('#tw-status-label');
  if(status) status.textContent=t.loading;

  if(requestedTripId){
    try{ data=await fetchTripWorkspace(requestedTripId); }
    catch(err){ console.warn('[TRIP WORKSPACE FETCH]',err); }

    if(!data && cached?.trip_id===requestedTripId){
      data=cached;
    }
  }else{
    data=cached;
  }

  if(data?.lang==='en' || data?.lang==='es'){
    lang=(requestedLang==='en'||requestedLang==='es') ? requestedLang : data.lang;
    t=copy[lang];
    setText();
  }

  $('#tw-back-planner').onclick=backPlanner;
  $('#tw-empty-back').onclick=backPlanner;
  $('#tw-all-cities').onclick=overview;
  $('#tw-mode-itinerary').onclick=()=>{mode='itinerary';renderCity()};
  $('#tw-mode-prepare').onclick=()=>{mode='prepare';renderCity()};

  if(!data || !data.itineraries || !cities().length){
    showEmpty();
    return;
  }

  if(status) status.textContent=t.ready;
  overview();
}

boot();
})();
