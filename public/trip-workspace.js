(()=>{
'use strict';
const KEY='itbmo_trip_workspace_snapshot_v1';
const $=(s,r=document)=>r.querySelector(s);
const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
let data=null,city=null,day=null,mode='itinerary';
const contextByCity=new Map();
const contextRequests=new Map();
const partnerOffersByCity=new Map();
let tripPartnerOffers=[];
const viewedOfferIds=new Set();
const requestedLang=new URLSearchParams(location.search).get('lang');
const copy={
 es:{back:'Volver al Planner',prepareBadge:'Explora',prepareTeaser:'Tu itinerario es solo el comienzo. Prepárate para vivirlo.',ready:'Tu viaje está listo',overviewK:'TU VIAJE ITBMO',overviewT:'¿Por dónde quieres empezar?',overviewC:'Elige una ciudad para explorarla día a día y preparar lo que realmente necesitas.',city:'ciudad',cities:'ciudades',d:'día',ds:'días',organized:'organizados',explore:'Explorar',all:'Todas las ciudades',cityK:'TU CIUDAD',it:'Itinerario',prep:'Para tu viaje',wholeK:'PARA TODO TU VIAJE',wholeT:'Lo esencial que viaja contigo.',wholeC:'Necesidades que acompañan el viaje completo, sin repetirlas ciudad por ciudad.',connectivityK:'VIAJE COMPLETO',connectivityT:'Conectividad',connectivityC:'Opciones de datos y eSIM para mantenerte conectado durante todo el viaje.',insuranceK:'VIAJE COMPLETO',insuranceT:'Seguro de viaje',insuranceC:'Protección transversal para el viaje cuando exista una opción que aporte valor real.',coming:'Próximamente',details:'Ver detalles',hide:'Ocultar detalles',route:'Trayecto',transport:'Transporte',duration:'Duración',notes:'Detalles',prepareT:'Tu itinerario es solo el comienzo. Prepárate para vivirlo.',prepareC:'Entradas, reservas, experiencias y movilidad, seleccionadas según tu viaje.',tickets:'Entradas y reservas',ticketsC:'Accesos, horarios y reservas que realmente requiere tu itinerario.',tours:'Tours y experiencias',toursC:'Alternativas guiadas y experiencias que encajan con lo que ya planeaste.',move:'Cómo moverte',moveC:'Opciones útiles de movilidad relacionadas con esta ciudad.',more:'Más para tu viaje',moreC:'Otros servicios relevantes, solo cuando aporten valor.',contextLoading:'Analizando lo que necesitas para este viaje…',contextError:'No pudimos analizar esta ciudad ahora. Puedes seguir usando tu itinerario normalmente.',contextEmpty:'No detectamos nada que necesites resolver aquí.',required:'Entrada necesaria',recommended:'Conviene reservar',optional:'Opcional',journey:'Trayecto a resolver',dayLabel:'Día',basedOn:'Basado en tu itinerario',items:'pendientes',next:'Próximamente',loading:'Recuperando tu viaje…',emptyT:'No pudimos cargar este viaje.',emptyC:'Vuelve al Planner para abrirlo nuevamente o inicia sesión si este viaje pertenece a tu cuenta.',partnerCta:'Ver opción',optionsForBooking:'Opciones para reservar',linkDisclosure:'Transparencia de enlaces: Algunas opciones de reserva utilizan enlaces de afiliados. Si reservas a través de ellos, ITBMO puede recibir una comisión del proveedor. ITBMO no añade ningún recargo al precio mostrado por el proveedor y, en algunos casos, acceder desde ITBMO puede darte un beneficio o descuento adicional. Fechas, disponibilidad, condiciones y precio final se confirman directamente con el proveedor.',available:'Disponible'},
 en:{back:'Back to Planner',prepareBadge:'Explore',prepareTeaser:'Your itinerary is only the beginning. Get ready to live it.',ready:'Your trip is ready',overviewK:'YOUR ITBMO TRIP',overviewT:'Where do you want to start?',overviewC:'Choose a city to explore it day by day and prepare what you actually need.',city:'city',cities:'cities',d:'day',ds:'days',organized:'organized',explore:'Explore',all:'All cities',cityK:'YOUR CITY',it:'Itinerary',prep:'For your trip',wholeK:'FOR YOUR WHOLE TRIP',wholeT:'The essentials that travel with you.',wholeC:'Needs that travel with the whole trip, without repeating them city by city.',connectivityK:'WHOLE TRIP',connectivityT:'Connectivity',connectivityC:'Data and eSIM options to keep you connected throughout the trip.',insuranceK:'WHOLE TRIP',insuranceT:'Travel insurance',insuranceC:'Trip-wide protection when there is an option that genuinely adds value.',coming:'Coming next',details:'View details',hide:'Hide details',route:'Route',transport:'Transport',duration:'Duration',notes:'Details',prepareT:'Your itinerary is only the beginning. Get ready to live it.',prepareC:'Tickets, reservations, experiences and mobility, selected around your trip.',tickets:'Tickets & reservations',ticketsC:'Access, schedules and reservations your itinerary actually requires.',tours:'Tours & experiences',toursC:'Guided alternatives and experiences that fit what you already planned.',move:'Getting around',moveC:'Useful mobility options related to this city.',more:'More for your trip',moreC:'Other relevant services, only when they add value.',contextLoading:'Analyzing what you need for this trip…',contextError:'We could not analyze this city right now. You can keep using your itinerary normally.',contextEmpty:'Nothing here appears to require action from you.',required:'Ticket needed',recommended:'Reservation recommended',optional:'Optional',journey:'Transport to arrange',dayLabel:'Day',basedOn:'Based on your itinerary',items:'items',next:'Coming next',loading:'Recovering your trip…',emptyT:'We could not load this trip.',emptyC:'Return to the Planner to open it again, or sign in if this trip belongs to your account.',partnerCta:'View option',optionsForBooking:'Booking options',linkDisclosure:'Link transparency: Some booking options use affiliate links. If you book through them, ITBMO may receive a commission from the provider. ITBMO does not add any surcharge to the price shown by the provider and, in some cases, accessing through ITBMO may include an additional benefit or discount. Dates, availability, conditions and final price are confirmed directly with the provider.',available:'Available'}
};
let lang='es',t=copy.es;
function parseDate(v){if(!v)return null;let m=String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);if(m)return new Date(+m[3],+m[2]-1,+m[1]);m=String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);if(m)return new Date(+m[1],+m[2]-1,+m[3]);return null}
function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x}
function fmt(d){if(!d)return'';return new Intl.DateTimeFormat(lang==='es'?'es-ES':'en-US',{day:'numeric',month:'short',year:'numeric'}).format(d)}
function cities(){const ordered=(data?.destinations||[]).map(x=>x.city).filter(Boolean),extras=Object.keys(data?.itineraries||{}).filter(x=>!ordered.includes(x));return [...ordered,...extras].filter(c=>days(c).some(d=>(data?.itineraries?.[c]?.byDay?.[d]||[]).length))}
function days(c){return Object.keys(data?.itineraries?.[c]?.byDay||{}).map(Number).filter(Number.isFinite).sort((a,b)=>a-b)}
function base(c){return parseDate(data?.itineraries?.[c]?.baseDate||data?.city_meta?.[c]?.baseDate||'')}
function range(c){const ds=days(c),b=base(c);if(!b||!ds.length)return'';const a=fmt(addDays(b,ds[0]-1)),z=fmt(addDays(b,ds.at(-1)-1));return a===z?a:`${a} – ${z}`}
function dayDate(c,d){const b=base(c),n=Number(d);return b&&Number.isFinite(n)&&n>0?fmt(addDays(b,n-1)):''}
function travelDateLabel(raw){const parsed=parseDate(raw);return parsed?fmt(parsed):String(raw||'').trim()}
function setText(){document.documentElement.lang=lang;
const plannerUrl=`./planner.html?lang=${encodeURIComponent(lang)}`;
const homeUrl=`./preview-home.html?lang=${encodeURIComponent(lang)}`;
const brand=$('.tw-brand');if(brand)brand.setAttribute('href',homeUrl);
$('#tw-back-planner').setAttribute('data-planner-url',plannerUrl);
$('#tw-empty-back').setAttribute('data-planner-url',plannerUrl);
const badge=$('#tw-prepare-badge');if(badge)badge.textContent=t.prepareBadge;
$('#tw-back-label').textContent=t.back;$('#tw-status-label').textContent=t.ready;$('#tw-overview-kicker').textContent=t.overviewK;$('#tw-overview-title').textContent=t.overviewT;$('#tw-overview-copy').textContent=t.overviewC;$('#tw-trip-kicker').textContent=t.wholeK;$('#tw-trip-title').textContent=t.wholeT;$('#tw-trip-copy').textContent=t.wholeC;const disclosure=$('#tw-link-disclosure');if(disclosure)disclosure.textContent=t.linkDisclosure;$('#tw-connectivity-kicker').textContent=t.connectivityK;$('#tw-connectivity-title').textContent=t.connectivityT;$('#tw-connectivity-copy').textContent=t.connectivityC;$('#tw-insurance-kicker').textContent=t.insuranceK;$('#tw-insurance-title').textContent=t.insuranceT;$('#tw-insurance-copy').textContent=t.insuranceC;$('#tw-connectivity-status').textContent=t.coming;$('#tw-insurance-status').textContent=t.coming;$('#tw-all-cities span').textContent=t.all;$('#tw-city-kicker').textContent=t.cityK;$('#tw-mode-itinerary b').textContent=t.it;$('#tw-mode-prepare b').textContent=t.prep;$('#tw-prepare-teaser').textContent=t.prepareTeaser;$('#tw-prepare-badge').textContent=t.prepareBadge}
function overview(){city=null;$('#tw-city').hidden=true;$('#tw-overview').hidden=false;const cs=cities(),total=cs.reduce((n,c)=>n+days(c).length,0);$('#tw-overview-summary').textContent=`${cs.length} ${cs.length===1?t.city:t.cities} · ${total} ${total===1?t.d:t.ds}`;const grid=$('#tw-city-grid');grid.innerHTML='';cs.forEach((c,i)=>{const b=document.createElement('button');b.type='button';b.className='tw-city-card';b.innerHTML=`<span class="tw-city-num">${String(i+1).padStart(2,'0')}</span><small>${esc(range(c))}</small><h2>${esc(c)}</h2><p>${days(c).length} ${esc(t.ds)} ${esc(t.organized)}</p><span class="tw-city-go">${esc(t.explore)} <i>→</i></span>`;b.onclick=()=>enter(c);grid.appendChild(b)});scrollTo({top:0,behavior:'smooth'})}
function enter(c){city=c;const ds=days(c);day=ds.includes(Number(data?.itineraries?.[c]?.currentDay))?Number(data.itineraries[c].currentDay):ds[0];mode='itinerary';$('#tw-overview').hidden=true;$('#tw-city').hidden=false;window.ITBMOFoundation?.track('city_workspace_opened',{destination:c,language:lang});renderCity();scrollTo({top:0,behavior:'smooth'})}
function renderCity(){if(!city)return;$('#tw-city-name').textContent=city;$('#tw-city-dates').textContent=range(city);const ib=$('#tw-mode-itinerary'),pb=$('#tw-mode-prepare');ib.classList.toggle('active',mode==='itinerary');pb.classList.toggle('active',mode==='prepare');ib.setAttribute('aria-selected',mode==='itinerary');pb.setAttribute('aria-selected',mode==='prepare');renderDays();mode==='itinerary'?renderItinerary():renderPrepare()}
function renderDays(){const nav=$('#tw-days');nav.hidden=mode!=='itinerary';nav.innerHTML='';if(nav.hidden)return;days(city).forEach(d=>{const b=document.createElement('button');b.type='button';b.className='tw-day'+(d===day?' active':'');const date=dayDate(city,d);b.textContent=(lang==='es'?`Día ${d}`:`Day ${d}`)+(date?` · ${date}`:'');b.onclick=()=>{day=d;renderCity();window.scrollTo({top:Math.max(0,$('#tw-content').offsetTop-160),behavior:'smooth'})};nav.appendChild(b)})}
function cleanDuration(v){return String(v||'').replace(/\s*\|\s*/g,' · ').replace(/\n+/g,' · ').trim()}
function renderItinerary(){const rows=data?.itineraries?.[city]?.byDay?.[day]||[],b=base(city),date=b?fmt(addDays(b,day-1)):'',ds=days(city),idx=ds.indexOf(day);let html=`<div class="tw-day-header"><div><span class="tw-kicker">${esc(city)}</span><h2>${lang==='es'?'Día':'Day'} ${day}${date?` · ${esc(date)}`:''}</h2></div><span class="tw-day-count">${idx+1} / ${ds.length}</span></div><div class="tw-timeline">`;rows.forEach((r,i)=>{const activity=String(r.activity||'').replace(/^rev:\s*/i,''),notes=String(r.notes||'').replace(/^\s*valid:\s*/i,'').trim(),route=[r.from,r.to].filter(Boolean).join(' → ');html+=`<article class="tw-stop"><div class="tw-time">${esc(r.start||'')}<small>${esc(r.end||'')}</small></div><div class="tw-node"></div><div class="tw-stop-card"><h3>${esc(activity)}</h3><div class="tw-pills">${r.transport?`<span class="tw-pill">${esc(r.transport)}</span>`:''}${r.duration?`<span class="tw-pill">${esc(cleanDuration(r.duration))}</span>`:''}</div>${(route||notes)?`<button class="tw-details-btn" type="button" data-detail="${i}">${esc(t.details)} ＋</button><div class="tw-details" id="tw-detail-${i}" hidden>${route?`<div class="tw-detail"><small>${esc(t.route)}</small><b>${esc(route)}</b></div>`:''}${r.transport?`<div class="tw-detail"><small>${esc(t.transport)}</small><b>${esc(r.transport)}</b></div>`:''}${r.duration?`<div class="tw-detail"><small>${esc(t.duration)}</small><b>${esc(cleanDuration(r.duration))}</b></div>`:''}${notes?`<div class="tw-detail"><small>${esc(t.notes)}</small><b>${esc(notes)}</b></div>`:''}</div>`:''}</div></article>`});html+='</div>';$('#tw-content').innerHTML=html;document.querySelectorAll('[data-detail]').forEach(btn=>btn.onclick=()=>{const box=$(`#tw-detail-${btn.dataset.detail}`),open=!box.hidden;box.hidden=open;btn.textContent=(open?t.details:t.hide)+(open?' ＋':' −')})}
function tripRoutes(){
  const destinations=(Array.isArray(data?.destinations)?data.destinations:[])
    .map((item,index)=>({
      index,
      city:String(item?.city||'').trim(),
      baseDate:String(item?.baseDate||item?.base_date||'').trim()
    }))
    .filter(item=>item.city);
  return destinations.slice(0,-1).map((from,index)=>({
    id:`route:${index}:${from.city}:${destinations[index+1].city}`,
    category:'transport',
    need_type:'intercity_transport',
    day:'',
    city:from.city,
    entity_name:`${from.city} → ${destinations[index+1].city}`,
    source_activity:`${from.city} → ${destinations[index+1].city}`,
    source_route:`${from.city} → ${destinations[index+1].city}`,
    origin:from.city,
    destination:destinations[index+1].city,
    travel_date:destinations[index+1].baseDate||'',
    user_message:lang==='es'
      ? 'Compara opciones para conectar tus destinos.'
      : 'Compare options to connect your destinations.',
    derived_by:'trip_sequence'
  }));
}
function contextualNeedsForCity(cityName,needs){
  const source=Array.isArray(needs)?needs:[];
  const derived=tripRoutes().filter(route=>route.origin===cityName);
  if(!derived.length)return source;
  const normalizeRoute=value=>String(value||'').toLowerCase().replace(/\s+/g,' ').trim();
  const derivedRoutes=new Set(derived.map(route=>normalizeRoute(route.source_route)));
  const withoutDuplicateTopLevelRoutes=source.filter(item=>{
    if(item?.need_type!=='intercity_transport' && item?.need_type!=='transport_arrangement') return true;
    return !derivedRoutes.has(normalizeRoute(item?.source_route||item?.entity_name));
  });
  return [...withoutDuplicateTopLevelRoutes,...derived];
}

function contextLabel(item){
  if(item?.need_type==='ticket_required') return t.required;
  if(item?.need_type==='reservation_recommended') return t.recommended;
  if(item?.need_type==='guided_tour_optional') return t.optional;
  if(item?.need_type==='intercity_transport' || item?.need_type==='transport_arrangement') return t.journey;
  return '';
}

function renderNeedItems(items,offers=[]){
  if(!items.length) return '';
  return `<div class="tw-context-list">${items.map(item=>{
    const matched=(Array.isArray(offers)?offers:[]).filter(offer=>offer?.need_id===item?.id);
    return `
    <article class="tw-context-item">
      <div class="tw-context-item-top">
        ${item.day?`<span class="tw-context-day">${esc(t.dayLabel)} ${esc(item.day)}${dayDate(city,item.day)?` · ${esc(dayDate(city,item.day))}`:''}</span>`:`<span class="tw-context-day">↗${item.travel_date?` · ${esc(travelDateLabel(item.travel_date))}`:''}</span>`}
        <span class="tw-context-label">${esc(contextLabel(item))}</span>
      </div>
      <h4>${esc(item.entity_name || item.source_activity || '')}</h4>
      ${item.user_message?`<p>${esc(item.user_message)}</p>`:''}
      <small class="tw-context-source">${item.derived_by==='trip_sequence'?(lang==='es'?'Basado en el orden de tus destinos':'Based on your destination order'):`${esc(t.basedOn)} · ${esc(t.dayLabel)} ${esc(item.day)}${dayDate(city,item.day)?` · ${esc(dayDate(city,item.day))}`:''}`}</small>
      ${item.source_route && (item.need_type==='intercity_transport' || item.need_type==='transport_arrangement')
        ? `<small class="tw-context-route">${esc(item.source_route)}${item.transport?` · ${esc(item.transport)}`:''}</small>`
        : ''}
      ${partnerOptions(matched)}
    </article>`;
  }).join('')}</div>`;
}

function contextSection(icon,title,description,items,offers=[]){
  if(!items.length) return '';
  return `<section class="tw-context-section">
    <div class="tw-context-section-head">
      <div class="tw-context-section-icon">${icon}</div>
      <div class="tw-context-section-copy">
        <div class="tw-context-section-title">
          <h3>${esc(title)}</h3>
          <span>${items.length}</span>
        </div>
        <p>${esc(description)}</p>
      </div>
    </div>
    ${renderNeedItems(items,offers)}
  </section>`;
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

function scheduleWorkspaceContextPrewarm(){
  const list=cities();
  if(!list.length || !data?.trip_id || !getStoredSessionToken()) return;

  let index=0;
  const runNext=()=>{
    if(index>=list.length) return;
    const cityName=list[index++];
    ensureContext(cityName).finally(()=>{
      window.setTimeout(runNext,180);
    });
  };

  // The Planner already starts prewarming as soon as generation completes.
  // This is a delayed safety net for direct/recovered Workspace entry.
  window.setTimeout(runNext,12000);
}

function localizedOffer(offer){
  return {title:lang==='es'?offer.title_es:offer.title_en,description:lang==='es'?offer.description_es:offer.description_en};
}
function offerCard(offer,placement){
  if(!offer?.id)return'';
  const c=localizedOffer(offer);
  const partnerSlug=offer.partner?.slug||'';
  const benefit=lang==='en'?(offer.metadata?.benefit_text_en||''):(offer.metadata?.benefit_text_es||'');
  const displayTitle=placement==='trip_connectivity'
    ? (lang==='es'?'Conectividad para tu viaje':'Connectivity for your trip')
    : (c.title||offer.partner?.name||'');
  return `<div class="tw-partner-offer" data-offer-id="${esc(offer.id)}" data-placement="${esc(placement)}" data-partner-slug="${esc(partnerSlug)}" data-need-type="${esc(offer.need_type||'')}" data-entity-name="${esc(offer.entity_name||'')}" data-travel-date="${esc(offer.travel_date||'')}"><div class="tw-partner-offer__top"><strong>${esc(displayTitle)}</strong><small>${esc(offer.partner?.name||'')}</small></div><p>${esc(c.description||'')}</p>${benefit?`<div class="tw-partner-benefit">${esc(benefit)}</div>`:''}<button type="button" data-partner-open="${esc(offer.id)}" data-partner-token="${esc(offer.offer_token||'')}">${esc(t.partnerCta)} →</button></div>`;
}
function partnerOptions(offers=[]){
  const list=Array.isArray(offers)?offers:[];
  if(!list.length)return'';
  return `<div class="tw-partner-options"><small class="tw-partner-options__label">${esc(t.optionsForBooking)}</small>${list.map(offer=>{
    const slug=offer.partner?.slug||'';
    return `<div class="tw-partner-option" data-offer-id="${esc(offer.id)}" data-placement="${esc(offer.placement||'city_contextual')}" data-partner-slug="${esc(slug)}" data-need-type="${esc(offer.need_type||'')}" data-entity-name="${esc(offer.entity_name||'')}" data-travel-date="${esc(offer.travel_date||'')}"><strong>${esc(offer.partner?.name||'')}</strong><button type="button" data-partner-open="${esc(offer.id)}" data-partner-token="${esc(offer.offer_token||'')}">${esc(t.partnerCta)} →</button></div>`;
  }).join('')}</div>`;
}

async function fetchPartnerOffers(action,needs=[]){
  const token=getStoredSessionToken();if(!data?.trip_id)return[];
  const response=await fetch('/api/partners',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,session_token:token,trip_id:data.trip_id,city:city||'',language:lang,needs})});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok||!payload?.ok){console.warn('[PARTNER ENGINE]',payload?.code||response.status);return[]}
  return Array.isArray(payload.offers)?payload.offers:[];
}
async function openPartnerOffer(offerId,placement,offerToken,meta={}){
  const token=getStoredSessionToken();
  const target=window.open('about:blank','_blank');if(target)target.opener=null;
  try{
    const response=await fetch('/api/partners',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'click',session_token:token,trip_id:data?.trip_id,offer_id:offerId,offer_token:offerToken||'',placement})});
    const payload=await response.json().catch(()=>({}));
    if(response.ok&&payload?.ok&&/^https:\/\//i.test(payload.url||'')){
      window.ITBMOFoundation?.track('partner_offer_click',{partner_name:payload.partner_name||meta.partnerSlug||'',partner_slug:payload.partner_slug||meta.partnerSlug||'',placement,destination:city||'',need_type:payload.need_type||meta.needType||'',entity_name:payload.entity_name||meta.entityName||'',travel_date:payload.travel_date||meta.travelDate||''});
      if(target)target.location.replace(payload.url);else window.location.assign(payload.url);
      return;
    }
  }catch(error){console.warn('[PARTNER CLICK]',error)}
  if(target)target.close();
}
function bindPartnerOffers(){document.querySelectorAll('[data-partner-open]').forEach(btn=>{
  btn.onclick=()=>{
    const card=btn.closest('[data-placement]');
    openPartnerOffer(btn.dataset.partnerOpen,card?.dataset.placement||'',btn.dataset.partnerToken||'',{partnerSlug:card?.dataset.partnerSlug||'',needType:card?.dataset.needType||'',entityName:card?.dataset.entityName||'',travelDate:card?.dataset.travelDate||''});
  };
});}
async function loadTripPartnerOffers(){tripPartnerOffers=await fetchPartnerOffers('resolve_trip');renderTripPartnerOffers();}
function renderTripPartnerOffers(){
  const offers=tripPartnerOffers.filter(x=>x.placement==='trip_connectivity');
  const item=$('#tw-connectivity-status')?.closest('.tw-trip-wide__item');
  if(!offers.length){ if(item) item.classList.remove('is-live'); return; }
  if(!item)return;item.classList.add('is-live');$('#tw-connectivity-status').textContent=t.available;
  item.querySelectorAll('.tw-partner-offer').forEach(el=>el.remove());
  item.insertAdjacentHTML('beforeend',offers.map(offer=>offerCard(offer,'trip_connectivity')).join(''));bindPartnerOffers();
  offers.forEach(offer=>{
    if(!viewedOfferIds.has(offer.id)){
      viewedOfferIds.add(offer.id);
      window.ITBMOFoundation?.track('partner_offer_view',{partner_name:offer.partner?.name||'',partner_slug:offer.partner?.slug||'',placement:'trip_connectivity'});
    }
  });
}
function renderPrepare(){
  const c=esc(city);
  const state=contextByCity.get(city);

  if(!state){
    $('#tw-content').innerHTML=`<section class="tw-prepare-hero">
      <span class="tw-prepare-mark">✦</span>
      <span class="tw-kicker">${c}</span>
      <h2>${esc(t.prepareT)}</h2>
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
      <h2>${esc(t.prepareT)}</h2>
      <p>${esc(t.prepareC)}</p>
    </section>
    <div class="tw-context-error">${esc(t.contextError)}</div>`;
    return;
  }

  const needs=contextualNeedsForCity(city,Array.isArray(state.needs)?state.needs:[]);
  if(!partnerOffersByCity.has(city)){partnerOffersByCity.set(city,[]);fetchPartnerOffers('resolve_city',needs).then(offers=>{partnerOffersByCity.set(city,offers);if(mode==='prepare')renderPrepare()}).catch(()=>{});}
  const tickets=needs.filter(item=>item.category==='tickets');
  const tours=needs.filter(item=>item.category==='tours');
  const transport=needs.filter(item=>item.category==='transport');

  const cityOffers=partnerOffersByCity.get(city)||[];
  const ticketOffers=cityOffers.filter(x=>x.placement==='city_tickets');
  const tourOffers=cityOffers.filter(x=>x.placement==='city_experiences');
  const transportOffers=cityOffers.filter(x=>x.placement==='city_transport');
  const activeSections=[
    contextSection('🎟',t.tickets,t.ticketsC,tickets,ticketOffers),
    contextSection('✦',t.tours,t.toursC,tours,tourOffers),
    contextSection('↗',t.move,t.moveC,transport,transportOffers)
  ].filter(Boolean).join('');

  $('#tw-content').innerHTML=`<section class="tw-prepare-hero">
    <span class="tw-prepare-mark">✦</span>
    <span class="tw-kicker">${c}</span>
    <h2>${esc(t.prepareT)}</h2>
    <p>${esc(t.prepareC)}</p>
  </section>
  <div class="tw-context-sections">
    ${activeSections || `<div class="tw-context-empty tw-context-empty-page">${esc(t.contextEmpty)}</div>`}
    <section class="tw-context-more">
      <div>
        <span>＋</span>
        <div>
          <h3>${esc(t.more)}</h3>
          <p>${esc(t.moreC)}</p>
        </div>
      </div>
      <small>${esc(t.next)}</small>
    </section>
  </div>`;
  bindPartnerOffers();
  cityOffers.forEach(offer=>{
    const viewKey=`${offer.id}:${offer.need_id||offer.placement}:${offer.partner?.slug||''}`;
    if(viewedOfferIds.has(viewKey))return;
    viewedOfferIds.add(viewKey);
    window.ITBMOFoundation?.track('partner_offer_view',{partner_name:offer.partner?.name||'',partner_slug:offer.partner?.slug||'',placement:offer.placement||'',destination:city,need_type:offer.need_type||'',entity_name:offer.entity_name||'',resolution_type:offer.resolution_type||'',travel_date:offer.travel_date||''});
  });
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
  window.ITBMOFoundation?.track('workspace_opened',{city_count:cities().length,language:lang});
  overview();
  loadTripPartnerOffers().catch(()=>{});
  scheduleWorkspaceContextPrewarm();
}

boot();
})();
