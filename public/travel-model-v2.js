/* ITBMO · Travel Model V2 · Trip Story V4 continuous compiler
   Deterministic route + progressive-disclosure preferences layer.
   No network calls. No Supabase schema dependency.
*/
(function(){
  'use strict';

  const VERSION=2;
  const state={
    routes:{},
    preferences:{global:{},places:{}},
    itineraryLanguage:'',
    tripStory:null,
    activePreferencePlace:'',
    locked:false
  };

  const esc=(v='')=>String(v).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
  const norm=(v='')=>String(v||'').trim();
  const uid=()=>`rt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
  const lang=()=>document.documentElement.lang?.toLowerCase().startsWith('es')?'es':'en';
  const copy=(es,en)=>lang()==='es'?es:en;
  const isoDate=(dmy='')=>{ const m=String(dmy).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m?`${m[3]}-${m[2]}-${m[1]}`:''; };
  const dmy=(iso='')=>{ const m=String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m?`${m[3]}/${m[2]}/${m[1]}`:''; };
  const dateKey=(date,time='00:00')=>Date.parse(`${date}T${time||'00:00'}:00`)||0;
  const addDays=(iso,days)=>{ const d=new Date(`${iso}T12:00:00`); if(Number.isNaN(d.getTime())) return ''; d.setDate(d.getDate()+days); return d.toISOString().slice(0,10); };
  const timeShift=(time,minutes)=>{ if(!/^\d{2}:\d{2}$/.test(String(time||''))) return time||''; const [h,m]=time.split(':').map(Number),v=h*60+m+minutes; if(v<0||v>=1440) return time; return `${String(Math.floor(v/60)).padStart(2,'0')}:${String(v%60).padStart(2,'0')}`; };
  const transferPrepMinutes=(mode='')=>({plane:120,train:45,bus:30,ferry:60,car:15,transfer:15,recommend:45,other:30}[String(mode||'').toLowerCase()]||30);
  const transferArrivalMinutes=(mode='')=>({plane:45,train:15,bus:15,ferry:20,car:10,transfer:10,recommend:15,other:15}[String(mode||'').toLowerCase()]||15);

  const DESTINATION_URL='/api/destination-suggestions';
  const destinationCache=new Map();
  function countryName(code=''){
    if(!code) return '';
    try{return new Intl.DisplayNames([lang()==='es'?'es':'en'],{type:'region'}).of(String(code).toUpperCase())||code;}
    catch(_){return code;}
  }
  async function searchDestinations(query=''){
    const q=norm(query);
    if(q.length<3) return [];
    const key=`${lang()}|${q.toLowerCase()}`;
    if(destinationCache.has(key)) return destinationCache.get(key);
    try{
      const response=await fetch(`${DESTINATION_URL}?lang=${encodeURIComponent(lang())}&q=${encodeURIComponent(q)}&global=1`,{headers:{Accept:'application/json'}});
      const data=await response.json().catch(()=>({}));
      const rows=response.ok&&Array.isArray(data?.results)?data.results:[];
      destinationCache.set(key,rows);
      return rows;
    }catch(_){return [];}
  }

  function rowId(row){
    if(!row) return '';
    if(!row.dataset.routeV2Id) row.dataset.routeV2Id=uid();
    return row.dataset.routeV2Id;
  }
  function rowRoute(row){
    const id=rowId(row);
    if(!state.routes[id]) state.routes[id]={segments:[]};
    return state.routes[id];
  }
  function rowMeta(row){
    return {
      id:rowId(row),
      city:norm(row.querySelector('.city')?.value),
      country:norm(row.querySelector('.country')?.value),
      days:Number(row.querySelector('.days')?.value||0),
      baseDate:norm(row.querySelector('.baseDate')?.value),
      baseISO:isoDate(row.querySelector('.baseDate')?.value||''),
      perDay:[...row.querySelectorAll('.hours-day')].map((day,index)=>({
        day:index+1,
        start:norm(day.querySelector('.start')?.value),
        end:norm(day.querySelector('.end')?.value)
      }))
    };
  }

  function ensureRouteHost(row){
    let host=row.querySelector('.route-v2-host');
    if(host) return host;
    host=document.createElement('div');
    host.className='route-v2-host';
    const schedule=row.querySelector('.city-card-schedule');
    (schedule||row).appendChild(host);
    return host;
  }

  function _dayOptions(meta,fromISO=''){
    const out=[];
    for(let i=0;i<Math.max(1,meta.days||1);i++){
      const iso=addDays(meta.baseISO,i); if(fromISO && iso<fromISO) continue;
      out.push({day:i+1,iso,label:copy(`Día ${i+1}`,`Day ${i+1}`),date:new Intl.DateTimeFormat(lang()==='es'?'es-ES':'en-US',{day:'2-digit',month:'short'}).format(new Date(`${iso}T12:00:00`)).replace('.','')});
    }
    return out;
  }
  function _timeSelect(field,value='',label=''){
    const [hh='',mm='00']=String(value||'').split(':');
    const hours=['',...Array.from({length:24},(_,i)=>String(i).padStart(2,'0'))];
    const mins=['00','15','30','45'];
    return `<div class="route-v2-time" data-time-field="${field}"><span>${esc(label)}</span><div><select data-time-hour="${field}">${hours.map(h=>`<option value="${h}" ${h===hh?'selected':''}>${h||'--'}</option>`).join('')}</select><b>:</b><select data-time-minute="${field}">${mins.map(m=>`<option value="${m}" ${m===mm?'selected':''}>${m}</option>`).join('')}</select></div></div>`;
  }
  function _routeTransportOptions(selected=''){
    return [
      ['',copy('Seleccionar…','Select…')],
      ['recommend',copy('Recomiéndame','Recommend')],
      ['train',copy('Tren','Train')],
      ['bus','Bus'],
      ['plane',copy('Avión','Plane')],
      ['car',copy('Automóvil','Car')],
      ['ferry','Ferry'],
      ['transfer','Transfer'],
      ['other',copy('Otro','Other')]
    ].map(([value,label])=>`<option value="${value}" ${selected===value?'selected':''}>${label}</option>`).join('');
  }
  function _dayChips(meta,field,value,fromISO=''){
    return `<div class="route-v2-daychips" data-day-field="${field}">${_dayOptions(meta,fromISO).map(d=>`<button type="button" data-day-value="${d.iso}" class="${value===d.iso?'is-selected':''}"><strong>${d.label}</strong><small>${d.date}</small></button>`).join('')}</div>`;
  }
  function _deriveNights(arrivalISO,departureISO){
    if(!arrivalISO||!departureISO) return 0;
    return Math.max(0,Math.round((dateKey(departureISO)-dateKey(arrivalISO))/86400000));
  }
  function _setPlannerTimeGroup(group,value='',disabled=false){
    if(!group) return;
    const match=/^(\d{2}):(\d{2})$/.exec(String(value||''));
    const hour=group.querySelector('.time-hour'), minute=group.querySelector('.time-minute'), hidden=group.querySelector('input[type="hidden"]');
    if(hour){ hour.value=match?.[1]||''; hour.disabled=Boolean(disabled); }
    if(minute){ minute.value=['15','30','45'].includes(match?.[2])?match[2]:''; minute.disabled=Boolean(disabled); }
    if(hidden) hidden.value=match?`${match[1]}:${match[2]}`:'';
    group.classList.toggle('route-v2-time-locked',Boolean(disabled));
  }
  function syncPlannerAvailability(row){
    const meta=rowMeta(row), route=rowRoute(row), base=norm(meta.city).toLowerCase();
    const dayRows=[...row.querySelectorAll('.hours-day')];
    // Restore the user's pre-route schedule before re-applying deterministic route limits.
    dayRows.forEach(day=>{
      const startGroup=day.querySelector('[data-time-type="start"]'), endGroup=day.querySelector('[data-time-type="end"]');
      if(day.dataset.routeV2OriginalStart===undefined) day.dataset.routeV2OriginalStart=norm(day.querySelector('.start')?.value);
      if(day.dataset.routeV2OriginalEnd===undefined) day.dataset.routeV2OriginalEnd=norm(day.querySelector('.end')?.value);
      _setPlannerTimeGroup(startGroup,day.dataset.routeV2OriginalStart||'',false);
      _setPlannerTimeGroup(endGroup,day.dataset.routeV2OriginalEnd||'',false);
      day.classList.remove('route-v2-day-away','route-v2-day-partial');
      day.removeAttribute('data-route-v2-note');
    });
    const segments=(route.segments||[]).slice().sort((a,b)=>dateKey(a.departureDate,a.departureTime)-dateKey(b.departureDate,b.departureTime));
    if(!segments.length){
      dayRows.forEach(day=>{
        day.dataset.routeV2OriginalStart=norm(day.querySelector('.start')?.value);
        day.dataset.routeV2OriginalEnd=norm(day.querySelector('.end')?.value);
        day.dataset.routeV2HasConstraints='0';
      });
      return;
    }
    dayRows.forEach(day=>{
      if(day.dataset.routeV2HasConstraints!=='1'){
        day.dataset.routeV2OriginalStart=norm(day.querySelector('.start')?.value);
        day.dataset.routeV2OriginalEnd=norm(day.querySelector('.end')?.value);
      }
      day.dataset.routeV2HasConstraints='1';
    });
    const cycles=[]; let active=null;
    for(const seg of segments){
      if(!active && norm(seg.origin).toLowerCase()===base){
        active={departureDate:seg.departureDate,departureTime:seg.departureTime||'',returnDate:'',returnTime:'',resumeTime:'',open:false};
      }
      if(active && (seg.disposition==='roundtrip'||seg.disposition==='stay_return')){
        active.returnDate=seg.returnDepartureDate||seg.arrivalDate;
        active.returnTime=seg.returnArrivalTime||'';
        active.resumeTime=seg.resumeTime||active.returnTime;
        cycles.push(active); active=null;
      }else if(active && seg.disposition==='end_block'){
        active.open=true; cycles.push(active); active=null;
      }
    }
    if(active){ active.open=true; cycles.push(active); }
    const minTime=(a,b)=>!a?b:(!b?a:(a<b?a:b));
    const maxTime=(a,b)=>!a?b:(!b?a:(a>b?a:b));
    dayRows.forEach((day,index)=>{
      const iso=addDays(meta.baseISO,index); let startMin='',endMax='',away=false,partial=false;
      for(const c of cycles){
        if(!c.departureDate) continue;
        if(iso===c.departureDate){ endMax=minTime(endMax,c.departureTime); partial=true; }
        if(c.returnDate && iso===c.returnDate){ startMin=maxTime(startMin,c.resumeTime||c.returnTime); partial=true; }
        const afterDeparture=iso>c.departureDate;
        const beforeReturn=c.returnDate?iso<c.returnDate:true;
        if(afterDeparture&&beforeReturn) away=true;
      }
      const startGroup=day.querySelector('[data-time-type="start"]'), endGroup=day.querySelector('[data-time-type="end"]');
      if(away){
        _setPlannerTimeGroup(startGroup,'',true); _setPlannerTimeGroup(endGroup,'',true);
        day.classList.add('route-v2-day-away'); day.dataset.routeV2Note=copy('Día ocupado fuera del destino base','Day occupied away from base destination');
        return;
      }
      if(partial){
        day.classList.add('route-v2-day-partial');
        if(startMin){
          const original=day.dataset.routeV2OriginalStart||'';
          _setPlannerTimeGroup(startGroup,original&&original>startMin?original:startMin,true);
        }
        if(endMax){
          const original=day.dataset.routeV2OriginalEnd||'';
          _setPlannerTimeGroup(endGroup,original&&original<endMax?original:endMax,true);
        }
      }
    });
  }
  function renderRowSummary(row){
    const host=ensureRouteHost(row), meta=rowMeta(row), route=rowRoute(row);
    const segments=(route.segments||[]).slice().sort((a,b)=>dateKey(a.departureDate,a.departureTime)-dateKey(b.departureDate,b.departureTime));
    host.innerHTML=`<div class="route-v2-segments">${segments.length?segments.map(seg=>segmentCard(seg,meta.city)).join(''):''}</div>`;
    syncPlannerAvailability(row);
    const quickStop=row.querySelector('.hours-quick-add-stop');
    if(quickStop&&!quickStop.dataset.routeBound){
      quickStop.dataset.routeBound='1';
      quickStop.addEventListener('click',()=>openSegmentWizard(row));
    }
    host.querySelectorAll('[data-route-edit]').forEach(btn=>btn.addEventListener('click',()=>{
      const ordered=(route.segments||[]).slice().sort((a,b)=>dateKey(a.departureDate,a.departureTime)-dateKey(b.departureDate,b.departureTime));
      if(ordered.length) openSegmentWizard(row,ordered[0],{editWholeRoute:true});
    }));
    host.querySelectorAll('[data-route-remove]').forEach(btn=>btn.addEventListener('click',()=>{
      route.segments=route.segments.filter(x=>x.id!==btn.dataset.routeRemove);
      renderRowSummary(row);
    }));
  }
  function segmentCard(seg,baseCity=''){
    const returns=seg.disposition==='roundtrip'||seg.disposition==='stay_return';
    const returnBase=norm(seg.returnDestination||seg.baseDestination||baseCity||seg.origin);
    const end=returns?` → ${returnBase}`:'';
    const endPlace=returns?returnBase:seg.destination;
    const endDate=returns?seg.returnDepartureDate:seg.arrivalDate;
    const endTime=returns?seg.returnArrivalTime:seg.arrivalTime;
    return `<article class="route-v2-segment-card"><div class="route-v2-segment-icon">↗</div><div class="route-v2-segment-main"><strong>${esc(seg.origin)} → ${esc(seg.destination)}${esc(end)}</strong><span>${esc(dmy(seg.departureDate)||seg.departureDate)} · ${esc(seg.departureTime||copy('hora por definir','time TBD'))}${seg.transportMode?` · ${esc(({recommend:copy('Recomiéndame','Recommend'),train:copy('Tren','Train'),plane:copy('Avión','Plane'),bus:'Bus',car:copy('Automóvil','Car'),ferry:'Ferry',transfer:'Transfer',other:copy('Otro','Other')})[seg.transportMode]||seg.transportMode)}`:''} · ${copy('finaliza en','ends in')} ${esc(endPlace)} ${esc(dmy(endDate)||endDate)} ${esc(endTime||'')}</span><small>${returns?copy(`El Planner retoma ${returnBase} desde ${seg.resumeTime||seg.returnArrivalTime||'--:--'}.`,`Planner resumes ${returnBase} from ${seg.resumeTime||seg.returnArrivalTime||'--:--'}.`):copy('El recorrido continúa desde esta ubicación.','The route continues from this location.')}</small></div><div class="route-v2-segment-actions"><button type="button" data-route-edit="${esc(seg.id)}">${copy('Editar','Edit')}</button><button type="button" data-route-remove="${esc(seg.id)}">✕</button></div></article>`;
  }
  function wizardShell(title,subtitle){
    document.querySelector('.route-v2-overlay')?.remove(); const overlay=document.createElement('div');overlay.className='route-v2-overlay';
    overlay.innerHTML=`<div class="route-v2-modal" role="dialog" aria-modal="true"><button class="route-v2-close" type="button">✕</button><div class="route-v2-modal-kicker">${copy('TU RECORRIDO','YOUR ROUTE')}</div><h3>${esc(title)}</h3><p class="route-v2-modal-intro">${esc(subtitle)}</p><div class="route-v2-wizard-body"></div></div>`;
    document.body.appendChild(overlay);const close=()=>{overlay.classList.remove('active');setTimeout(()=>overlay.remove(),180)};overlay.querySelector('.route-v2-close').onclick=close;requestAnimationFrame(()=>overlay.classList.add('active'));return{overlay,body:overlay.querySelector('.route-v2-wizard-body'),close};
  }
  function _isLastPlannerDay(meta,iso){return Boolean(iso&&iso===addDays(meta.baseISO,Math.max(0,meta.days-1)));}
  function _routeEnd(seg){
    if(seg.disposition==='roundtrip'||seg.disposition==='stay_return') return {place:seg.origin,date:seg.returnDepartureDate,time:seg.returnArrivalTime};
    return {place:seg.destination,date:seg.arrivalDate,time:seg.arrivalTime};
  }
  function _validResumeTime(seg){
    return !seg.resumeTime||!seg.returnArrivalTime||seg.resumeTime>=seg.returnArrivalTime;
  }
  function _destinationField(field,value=''){
    return `<label class="route-v2-destination-field">${copy('Destino o lugar','Destination or place')}<div class="route-v2-search-wrap"><input data-route-search="${field}" value="${esc(value)}" autocomplete="off" placeholder="${copy('Escribe al menos 3 letras','Type at least 3 letters')}"><div class="route-v2-search-menu" data-route-search-menu="${field}" hidden></div></div><small>${copy('Escribe 3 letras y selecciona el lugar correcto. Verás ciudad y país.','Type 3 letters and select the correct place. You will see city and country.')}</small></label>`;
  }
  function openSegmentWizard(row,existing=null,options={}){
    const meta=rowMeta(row),route=rowRoute(row);
    if(!meta.baseISO||!meta.days){alert(copy('Primero indica el primer día y la cantidad de días del destino.','First enter the start date and number of days.'));return;}
    let drafts=[];
    const editWholeRoute=Boolean(existing&&options?.editWholeRoute);
    let originalEditSegments=editWholeRoute?(route.segments||[]).slice().sort((a,b)=>dateKey(a.departureDate,a.departureTime)-dateKey(b.departureDate,b.departureTime)):[];
    const originalEditIds=new Set(originalEditSegments.map(x=>x.id));
    let editCursor=0;
    const hydrateContinuation=(target,index)=>{
      if(!editWholeRoute) return target;
      const next=originalEditSegments[index+1];
      if(next && norm(next.origin).toLowerCase()===norm(target.destination).toLowerCase()){
        target.disposition='continue';
        target.nextDepartureDate=next.departureDate||'';
        target.nextDestination=next.destination||'';
        target.nextDestinationCountry=next.destinationCountry||'';
        target.nextDestinationCountryCode=next.destinationCountryCode||'';
        target.nextDepartureTime=next.departureTime||'';
        target.nextArrivalTime=next.arrivalTime||'';
        target.nextTransportMode=next.transportMode||'';
      }
      return target;
    };
    let seg=existing?hydrateContinuation({...existing},0):{id:uid(),baseDestination:meta.city||'',origin:meta.city||'',destination:'',destinationCountry:'',departureDate:'',departureTime:'',arrivalDate:'',arrivalTime:'',transportMode:'',disposition:'',returnDepartureDate:'',returnDepartureTime:'',returnArrivalDate:'',returnArrivalTime:'',returnTransportMode:'',resumeTime:'',timePrecision:'exact'};
    const ui=wizardShell(editWholeRoute?copy('Editar mi recorrido','Edit my route'):copy('Agregar lugar a mi recorrido','Add a place to my route'),copy(`Construye el recorrido dentro de ${meta.city}. El ciclo debe regresar a ${meta.city} o terminar en otra ubicación al consumir el último día disponible.`,`Build the route within ${meta.city}. The cycle must return to ${meta.city} or end elsewhere when the last available day is consumed.`));

    const allDrafts=()=>[...drafts,{...seg}];
    const render=()=>{
      const hasDay=!!seg.departureDate,hasDest=!!norm(seg.destination),hasTimes=seg.timePrecision==='unknown'||(seg.departureTime&&seg.arrivalTime),hasTransport=!!seg.transportMode,hasMovement=hasTimes&&hasTransport;
      if(hasDay&&!seg.arrivalDate)seg.arrivalDate=seg.departureDate;
      if(seg.disposition==='roundtrip'&&seg.arrivalDate)seg.returnDepartureDate=seg.arrivalDate;
      if((seg.disposition==='roundtrip'||seg.disposition==='stay_return')&&seg.returnArrivalTime&&!seg.resumeTime)seg.resumeTime=seg.returnArrivalTime;
      const atLastDay=_isLastPlannerDay(meta,seg.arrivalDate);
      const editOverview=editWholeRoute?`<div class="route-v2-edit-overview"><div class="route-v2-edit-overview-head"><strong>${copy('Recorrido completo','Full route')}</strong><small>${copy('Puedes ajustar cada tramo o eliminarlo. Al guardar, este recorrido reemplazará al anterior.','You can adjust or remove each segment. Saving replaces the previous route.')}</small></div>${originalEditSegments.length?originalEditSegments.map((d,i)=>`<div class="route-v2-edit-segment ${i===editCursor?'is-current':''}"><div><strong>${esc(d.origin)} → ${esc(d.destination)}</strong><small>${esc(dmy(d.departureDate))} · ${esc(d.departureTime||'--:--')}–${esc(d.arrivalTime||'--:--')}</small></div><button type="button" data-edit-route-remove="${esc(d.id)}" aria-label="${copy('Eliminar tramo','Remove segment')}">${copy('Eliminar','Remove')}</button></div>`).join(''):`<div class="route-v2-edit-empty">${copy('No quedan tramos en este recorrido.','No segments remain in this route.')}</div>`}</div>`:'';
      const built=drafts.length?`<div class="route-v2-built">${drafts.map(d=>`<div><span>✓</span><strong>${esc(d.origin)} → ${esc(d.destination)}</strong><small>${esc(dmy(d.departureDate))} · ${esc(d.departureTime||'--:--')}–${esc(d.arrivalTime||'--:--')}</small></div>`).join('')}</div>`:'';
      ui.body.innerHTML=`${editOverview}${built}
        <section class="route-v2-step is-open"><div class="route-v2-step-index">1</div><div class="route-v2-step-content"><h4>${copy(`¿Qué día sales de ${seg.origin}?`,`What day do you leave ${seg.origin}?`)}</h4><p>${copy('Selecciona uno de los días reales de este destino. El recorrido nunca podrá extenderse fuera de este bloque.','Select one of this destination’s actual days. The route can never extend beyond this block.')}</p>${_dayChips(meta,'departureDate',seg.departureDate,drafts.at(-1)?._routeEndDate||'')}</div></section>
        ${hasDay?`<section class="route-v2-step is-open"><div class="route-v2-step-index">2</div><div class="route-v2-step-content"><h4>${copy('¿A dónde vas?','Where are you going?')}</h4><p>${copy(`Sales desde ${seg.origin}. No hay lugares predefinidos: busca el destino que tú decidiste.`,`You leave from ${seg.origin}. There are no predefined places: search for the destination you chose.`)}</p>${_destinationField('destination',seg.destination)}</div></section>`:''}
        ${hasDay&&hasDest?`<section class="route-v2-step is-open"><div class="route-v2-step-index">3</div><div class="route-v2-step-content"><h4>${copy(`¿Cuándo sales de ${seg.origin} y llegas a ${seg.destination}?`,`When do you leave ${seg.origin} and arrive in ${seg.destination}?`)}</h4><p>${copy(`La hora de salida cerrará la ventana disponible del Planner en ${seg.origin}; al llegar, comenzará la ventana disponible en ${seg.destination}.`,`Departure closes the Planner window in ${seg.origin}; arrival opens the available window in ${seg.destination}.`)}</p><div class="route-v2-timegrid">${_timeSelect('departureTime',seg.departureTime,copy('Hora de salida','Departure time'))}${_timeSelect('arrivalTime',seg.arrivalTime,copy('Hora de llegada','Arrival time'))}</div><label>${copy('Medio de transporte para este traslado','Transport for this transfer')}<select data-field="transportMode">${_routeTransportOptions(seg.transportMode)}</select></label><details class="route-v2-arrival-day"><summary>${copy('¿Llegas otro día?','Arriving another day?')}</summary>${_dayChips(meta,'arrivalDate',seg.arrivalDate,seg.departureDate)}</details></div></section>`:''}
        ${hasDay&&hasDest&&hasMovement?`<section class="route-v2-step is-open"><div class="route-v2-step-index">4</div><div class="route-v2-step-content"><h4>${copy(`¿Qué harás después de ${seg.destination}?`,`What will you do after ${seg.destination}?`)}</h4><p>${atLastDay?copy(`Estás en el último día de ${meta.city}. Puedes regresar a ${meta.city} o finalizar este bloque en ${seg.destination}.`,`This is the last day of ${meta.city}. You can return to ${meta.city} or finish this block in ${seg.destination}.`):copy(`Para cerrar este recorrido debes regresar a ${meta.city} o continuar hacia otro lugar. No dejamos rutas abiertas a mitad del ciclo.`,`To close this route you must return to ${meta.city} or continue to another place. Routes cannot be left open mid-cycle.`)}</p><div class="route-v2-choice-grid">
          ${(atLastDay?[['roundtrip',copy(`Regreso a ${meta.city} el mismo día`,`Return to ${meta.city} the same day`),copy('Cierra el ciclo hoy.','Closes the cycle today.')]]:[['roundtrip',copy(`Regreso a ${meta.city} el mismo día`,`Return to ${meta.city} the same day`),copy('Cierra el ciclo hoy.','Closes the cycle today.')],['stay_return',copy(`Me quedaré y regresaré a ${meta.city}`,`Stay, then return to ${meta.city}`),copy('Una o varias noches.','One or several nights.')],['continue',copy('Continuaré hacia otro lugar','Continue to another place'),copy('El recorrido sigue desde aquí.','The route continues from here.')]]).map(([v,a,b])=>`<label class="route-v2-choice ${seg.disposition===v?'selected':''}"><input type="radio" name="route-disposition" value="${v}" ${seg.disposition===v?'checked':''}><strong>${a}</strong><span>${b}</span></label>`).join('')}
          <label class="route-v2-choice ${seg.disposition==='end_block'?'selected':''}"><input type="radio" name="route-disposition" value="end_block" ${seg.disposition==='end_block'?'checked':''}><strong>${copy(atLastDay?'Finalizo este destino aquí':'Me quedaré aquí hasta finalizar este destino',atLastDay?'Finish this destination here':'Stay here until this destination ends')}</strong><span>${copy(atLastDay?`Tu ubicación al finalizar será ${seg.destination}.`:`Los días restantes se planificarán desde ${seg.destination}.`,`Your final location will be ${seg.destination}.`)}</span></label>
        </div></div></section>`:''}
        ${(seg.disposition==='roundtrip'||seg.disposition==='stay_return')?`<section class="route-v2-step is-open"><div class="route-v2-step-index">5</div><div class="route-v2-step-content"><h4>${copy(`Regreso a ${meta.city}`,`Return to ${meta.city}`)}</h4><p>${copy(seg.disposition==='roundtrip'?'El regreso ocurre el mismo día.':'Selecciona el día real en que regresarás. La estancia se deriva de estas fechas.','Select the actual day you return. The stay is derived from these dates.')}</p>${seg.disposition==='stay_return'?_dayChips(meta,'returnDepartureDate',seg.returnDepartureDate,seg.arrivalDate):`<div class="route-v2-fixed-day"><strong>${copy('Mismo día','Same day')}</strong><span>${esc(dmy(seg.arrivalDate))}</span></div>`}<div class="route-v2-timegrid">${_timeSelect('returnDepartureTime',seg.returnDepartureTime,copy(`Salida de ${seg.destination}`,`Leave ${seg.destination}`))}${_timeSelect('returnArrivalTime',seg.returnArrivalTime,copy(`Llegada a ${meta.city}`,`Arrive ${meta.city}`))}</div><label>${copy('Medio de transporte para este regreso','Transport for this return')}<select data-field="returnTransportMode">${_routeTransportOptions(seg.returnTransportMode||'')}</select></label>${seg.returnArrivalTime?`<div class="route-v2-resume"><div><strong>${copy(`¿Desde qué hora retomamos ${meta.city}?`,`When should we resume ${meta.city}?`)}</strong><small>${copy(`Precargamos ${seg.returnArrivalTime}. Puedes moverla hacia adelante, nunca antes de tu llegada.`,`We preloaded ${seg.returnArrivalTime}. You can move it later, never before arrival.`)}</small></div>${_timeSelect('resumeTime',seg.resumeTime||seg.returnArrivalTime,copy('Retomar Planner','Resume Planner'))}</div>`:''}</div></section>`:''}
        ${seg.disposition==='continue'?`<section class="route-v2-step is-open"><div class="route-v2-step-index">5</div><div class="route-v2-step-content"><h4>${copy(`Continúa desde ${seg.destination}`,`Continue from ${seg.destination}`)}</h4><p>${copy('Elige el día en que sales. Si llegas al último día, el recorrido podrá finalizar en el último lugar alcanzado.','Choose the day you leave. If you reach the last day, the route may finish at the last place reached.')}</p>${_dayChips(meta,'nextDepartureDate',seg.nextDepartureDate||'',seg.arrivalDate)}${seg.nextDepartureDate?`${_destinationField('nextDestination',seg.nextDestination||'')}<div class="route-v2-timegrid">${_timeSelect('nextDepartureTime',seg.nextDepartureTime||'',copy(`Salida de ${seg.destination}`,`Leave ${seg.destination}`))}${_timeSelect('nextArrivalTime',seg.nextArrivalTime||'',copy('Hora de llegada','Arrival time'))}</div><label>${copy('Medio de transporte para este traslado','Transport for this transfer')}<select data-field="nextTransportMode">${_routeTransportOptions(seg.nextTransportMode||'')}</select></label>`:''}</div></section>`:''}
        <div class="route-v2-modal-actions"><button type="button" class="route-v2-cancel">${copy('Cancelar','Cancel')}</button>${seg.disposition==='continue'?`<button type="button" class="route-v2-continue">${copy('Continuar recorrido →','Continue route →')}</button>`:`<button type="button" class="route-v2-save">${copy('Guardar recorrido','Save route')}</button>`}</div>`;
      bind();
    };

    const bindSearch=(field)=>{
      const input=ui.body.querySelector(`[data-route-search="${field}"]`);
      const menu=ui.body.querySelector(`[data-route-search-menu="${field}"]`);
      if(!input||!menu)return;
      let timer=0,token=0;
      input.addEventListener('input',()=>{
        const value=input.value;
        if(field==='destination'){seg.destination=value;seg.destinationCountry='';}
        else{seg.nextDestination=value;seg.nextDestinationCountry='';}
        clearTimeout(timer);
        if(norm(value).length<3){menu.hidden=true;menu.innerHTML='';return;}
        menu.hidden=false;menu.innerHTML=`<div class="route-v2-search-status">${copy('Buscando…','Searching…')}</div>`;
        const my=++token;
        timer=setTimeout(async()=>{
          const results=await searchDestinations(value);
          if(my!==token||input.value!==value)return;
          menu.innerHTML=results.length?results.slice(0,10).map((r,i)=>`<button type="button" data-route-result="${i}"><strong>${esc(r.city||r.label||'')}</strong><span>${esc(r.country||countryName(r.countryCode)||'')}</span></button>`).join(''):`<div class="route-v2-search-status">${copy('No encontramos coincidencias. Revisa la escritura.','No matches found. Check the spelling.')}</div>`;
          menu.hidden=false;
          menu.querySelectorAll('[data-route-result]').forEach(btn=>btn.onclick=()=>{
            const r=results[Number(btn.dataset.routeResult)];
            input.value=r.city||r.label||'';
            if(field==='destination'){seg.destination=input.value;seg.destinationCountry=r.country||countryName(r.countryCode)||'';seg.destinationCountryCode=r.countryCode||'';}
            else{seg.nextDestination=input.value;seg.nextDestinationCountry=r.country||countryName(r.countryCode)||'';seg.nextDestinationCountryCode=r.countryCode||'';}
            menu.hidden=true;render();
          });
        },180);
      });
    };
    const bind=()=>{
      ui.body.querySelectorAll('[data-edit-route-remove]').forEach(btn=>btn.addEventListener('click',()=>{
        if(!editWholeRoute) return;
        const id=btn.dataset.editRouteRemove;
        const idx=originalEditSegments.findIndex(x=>x.id===id);
        if(idx<0) return;
        originalEditSegments.splice(idx,1);
        // A route is a physical chain. When a middle segment is removed, reconnect the
        // following segment to the physical endpoint immediately before it instead of
        // leaving a stale origin that would later create continuity/overlap errors.
        if(idx<originalEditSegments.length){
          const prev=idx>0?originalEditSegments[idx-1]:null;
          originalEditSegments[idx].origin=prev?_routeEnd(prev).place:(meta.city||'');
        }
        if(idx>0 && idx>=originalEditSegments.length){
          originalEditSegments[idx-1].disposition='';
        }
        drafts=[]; editCursor=0;
        if(originalEditSegments.length){
          seg=hydrateContinuation({...originalEditSegments[0]},0);
        }else{
          seg={id:uid(),baseDestination:meta.city||'',origin:meta.city||'',destination:'',destinationCountry:'',departureDate:'',departureTime:'',arrivalDate:'',arrivalTime:'',transportMode:'',disposition:'',returnDepartureDate:'',returnDepartureTime:'',returnArrivalDate:'',returnArrivalTime:'',returnTransportMode:'',resumeTime:'',timePrecision:'exact'};
        }
        render();
      }));
      ui.body.querySelectorAll('[data-day-value]').forEach(btn=>btn.onclick=()=>{const field=btn.closest('[data-day-field]').dataset.dayField;seg[field]=btn.dataset.dayValue;if(field==='departureDate')seg.arrivalDate=seg[field];if(field==='returnDepartureDate')seg.nights=_deriveNights(seg.arrivalDate,seg.returnDepartureDate);render();});
      bindSearch('destination');bindSearch('nextDestination');
      ui.body.querySelector('[data-field="transportMode"]')?.addEventListener('change',e=>{seg.transportMode=e.target.value||'';render();});
      ui.body.querySelector('[data-field="nextTransportMode"]')?.addEventListener('change',e=>{seg.nextTransportMode=e.target.value||'';});
      ui.body.querySelector('[data-field="returnTransportMode"]')?.addEventListener('change',e=>{seg.returnTransportMode=e.target.value||'';});
      ui.body.querySelectorAll('[data-time-field]').forEach(group=>{const field=group.dataset.timeField;const sync=()=>{const h=group.querySelector(`[data-time-hour="${field}"]`)?.value||'',m=group.querySelector(`[data-time-minute="${field}"]`)?.value||'00';seg[field]=h?`${h}:${m}`:'';};group.querySelectorAll('select').forEach(x=>x.onchange=()=>{sync();if(field==='returnArrivalTime')seg.resumeTime=seg.returnArrivalTime;render();});});
      ui.body.querySelectorAll('input[name="route-disposition"]').forEach(r=>r.onchange=()=>{if(!r.checked)return;seg.disposition=r.value;if(r.value==='roundtrip'){seg.returnDepartureDate=seg.arrivalDate;seg.nights=0;}render();});
      ui.body.querySelector('.route-v2-cancel')?.addEventListener('click',ui.close);
      ui.body.querySelector('.route-v2-continue')?.addEventListener('click',()=>{
        if(!norm(seg.nextDestination)||!seg.nextDepartureDate||!seg.nextDepartureTime||!seg.nextArrivalTime||!seg.nextTransportMode){showInlineError(ui.body,copy('Completa el siguiente lugar, el día, las horas y el medio de transporte para continuar.','Complete the next place, day, times and transport mode to continue.'));return;}
        if(dateKey(seg.nextDepartureDate,seg.nextDepartureTime)<dateKey(seg.arrivalDate,seg.arrivalTime)){showInlineError(ui.body,copy('No puedes salir del lugar antes de haber llegado.','You cannot leave before arriving.'));return;}
        seg.nights=_deriveNights(seg.arrivalDate,seg.nextDepartureDate);
        const current={...seg,disposition:'continue'};
        const originalNext=editWholeRoute?originalEditSegments[editCursor+1]:null;
        const next=hydrateContinuation({id:originalNext?.id||uid(),baseDestination:meta.city||'',origin:current.destination,destination:norm(current.nextDestination),destinationCountry:current.nextDestinationCountry||'',destinationCountryCode:current.nextDestinationCountryCode||'',departureDate:current.nextDepartureDate,departureTime:current.nextDepartureTime,arrivalDate:originalNext?.arrivalDate||current.nextDepartureDate,arrivalTime:current.nextArrivalTime,transportMode:current.nextTransportMode||'',disposition:originalNext?.disposition||'',returnDepartureDate:originalNext?.returnDepartureDate||'',returnDepartureTime:originalNext?.returnDepartureTime||'',returnArrivalDate:originalNext?.returnArrivalDate||'',returnTransportMode:originalNext?.returnTransportMode||'',resumeTime:originalNext?.resumeTime||'',timePrecision:'exact'},editCursor+1);
        delete current.nextDestination;delete current.nextDestinationCountry;delete current.nextDestinationCountryCode;delete current.nextDepartureDate;delete current.nextDepartureTime;delete current.nextArrivalTime;delete current.nextTransportMode;
        drafts.push(current);editCursor+=1;seg=next;render();
      });
      ui.body.querySelector('.route-v2-save')?.addEventListener('click',()=>{
        const errors=validateSegment(seg,meta);
        if(errors.length){showInlineError(ui.body,errors[0]);return;}
        if(!_validResumeTime(seg)){showInlineError(ui.body,copy('La hora para retomar el Planner no puede ser anterior a la llegada.','Planner resume time cannot be before arrival.'));return;}
        const all=[...drafts,{...seg}];
        if(editWholeRoute) route.segments=route.segments.filter(x=>!originalEditIds.has(x.id));
        else if(existing) route.segments=route.segments.filter(x=>x.id!==existing.id);
        all.forEach(x=>{const i=route.segments.findIndex(y=>y.id===x.id);if(i>=0)route.segments[i]=x;else route.segments.push(x);});
        renderRowSummary(row);ui.close();
      });
    };
    render();
  }

  function showInlineError(body,message){
    body.querySelector('.route-v2-inline-error')?.remove();
    const div=document.createElement('div');div.className='route-v2-inline-error';div.textContent=message;
    body.querySelector('.route-v2-modal-actions')?.before(div);
  }
  function validateSegment(seg,meta=null){
    const errors=[];
    if(!norm(seg.destination)) errors.push(copy('Selecciona un destino de la lista después de escribir al menos 3 letras.','Select a destination from the list after typing at least 3 letters.'));
    if(!seg.departureDate||!seg.arrivalDate) errors.push(copy('Indica las fechas de salida y llegada.','Enter departure and arrival dates.'));
    if(!seg.departureTime||!seg.arrivalTime) errors.push(copy('Completa las horas de salida y llegada.','Complete departure and arrival times.'));
    // Transport belongs to the movement itself and is a prerequisite for every
    // downstream route decision. Validate it before disposition so the user is
    // never shown a later-step error while the transfer is still incomplete.
    if(!seg.transportMode) errors.push(copy('Selecciona el medio de transporte para este traslado antes de continuar.','Select the transport mode for this transfer before continuing.'));
    if(!norm(seg.disposition)) errors.push(copy('Indica qué harás después de llegar.','Tell us what you will do after arriving.'));
    const blockEnd=meta?.baseISO?addDays(meta.baseISO,Math.max(0,meta.days-1)):'';
    if(blockEnd&&(seg.departureDate>blockEnd||seg.arrivalDate>blockEnd||seg.returnDepartureDate>blockEnd)) errors.push(copy('Este recorrido supera los días disponibles del destino principal.','This route exceeds the main destination’s available days.'));
    if(seg.disposition==='roundtrip'||seg.disposition==='stay_return'){
      if(!seg.returnDepartureDate) errors.push(copy(`Indica el día en que regresarás a ${meta?.city||'destino base'}.`,`Enter the day you will return to ${meta?.city||'the base destination'}.`));
      else if(!seg.returnDepartureTime) errors.push(copy(`Indica la hora de salida de ${seg.destination} para regresar a ${meta?.city||'el destino base'}.`,`Enter the departure time from ${seg.destination} to return to ${meta?.city||'the base destination'}.`));
      else if(!seg.returnArrivalTime) errors.push(copy(`Indica la hora de llegada a ${meta?.city||'el destino base'}.`,`Enter the arrival time at ${meta?.city||'the base destination'}.`));
      else if(!seg.returnTransportMode) errors.push(copy('Selecciona el medio de transporte para el regreso.','Select the transport mode for the return.'));
      if(seg.resumeTime&&seg.returnArrivalTime&&seg.resumeTime<seg.returnArrivalTime) errors.push(copy('La hora para retomar el Planner debe ser igual o posterior a tu llegada.','Planner resume time must be at or after your arrival.'));
    }
    const out=dateKey(seg.departureDate,seg.departureTime||'00:00'),arr=dateKey(seg.arrivalDate,seg.arrivalTime||'23:59');
    if(out&&arr&&arr<out) errors.push(copy('La llegada no puede ocurrir antes de la salida.','Arrival cannot occur before departure.'));
    if((seg.disposition==='roundtrip'||seg.disposition==='stay_return')&&seg.returnDepartureDate){
      const ret=dateKey(seg.returnDepartureDate,seg.returnDepartureTime||'23:59');
      const retArr=dateKey(seg.returnDepartureDate,seg.returnArrivalTime||'23:59');
      if(arr&&ret&&ret<arr) errors.push(copy('El regreso no puede comenzar antes de llegar al lugar.','The return cannot begin before arriving at the place.'));
      if(ret&&retArr&&retArr<ret) errors.push(copy('La llegada al destino base no puede ser anterior a la salida de regreso.','Return arrival cannot be before return departure.'));
    }
    return errors;
  }

  function attachCityRow(row,pref={}){
    const id=rowId(row);
    if(pref?.travelRouteV2 && typeof pref.travelRouteV2==='object') state.routes[id]=JSON.parse(JSON.stringify(pref.travelRouteV2));
    const rerender=()=>renderRowSummary(row);
    row.querySelector('.city')?.addEventListener('change',rerender);
    row.querySelector('.baseDatePicker')?.addEventListener('change',rerender);
    row.querySelector('.days')?.addEventListener('change',rerender);
    row.querySelectorAll('.hours-day .time-selector select').forEach(select=>select.addEventListener('change',()=>{
      const day=select.closest('.hours-day');
      if(!day || !(rowRoute(row).segments||[]).length) return;
      const group=select.closest('.time-selector');
      const field=group?.dataset.timeType;
      const h=group?.querySelector('.time-hour')?.value||'', m=group?.querySelector('.time-minute')?.value||'00';
      const value=h?`${h}:${m}`:'';
      if(field==='start') day.dataset.routeV2OriginalStart=value;
      if(field==='end') day.dataset.routeV2OriginalEnd=value;
      setTimeout(()=>syncPlannerAvailability(row),0);
    }));
    row.querySelector('.same-schedule')?.addEventListener('change',()=>setTimeout(()=>syncPlannerAvailability(row),0));
    renderRowSummary(row);
  }

  function validateAll(rows=[]){
    const errors=[];
    rows.forEach((row,rowIndex)=>{
      const meta=rowMeta(row), route=rowRoute(row);
      const segments=(route.segments||[]).slice().sort((a,b)=>dateKey(a.departureDate,a.departureTime)-dateKey(b.departureDate,b.departureTime));
      segments.forEach(seg=>validateSegment(seg,meta).forEach(message=>errors.push({rowIndex,segmentId:seg.id,message})));

      // Validate only the chronological chain INSIDE this destination block.
      // Main-destination sequencing is validated separately by the Planner dates.
      // Do not compare a return leg or a different destination block as though it
      // were the previous outbound movement: that produced false overlap alerts.
      for(let i=1;i<segments.length;i++){
        const prev=segments[i-1], next=segments[i];
        const prevArrival=dateKey(prev.arrivalDate,prev.arrivalTime||'23:59');
        const nextDeparture=dateKey(next.departureDate,next.departureTime||'00:00');
        const physicallyContinues=norm(next.origin).toLowerCase()===norm(prev.destination).toLowerCase();
        if(physicallyContinues&&prevArrival&&nextDeparture&&nextDeparture<prevArrival){
          errors.push({rowIndex,segmentId:next.id,message:copy(`Hay una superposición real: sales de ${next.origin} antes de haber llegado allí.`,`There is a real overlap: you leave ${next.origin} before arriving there.`)});
        }
      }
    });
    return {ok:errors.length===0,errors};
  }

  function collect(rows=[]){
    const destinations=rows.map(row=>{ const meta=rowMeta(row); return {...meta,route:JSON.parse(JSON.stringify(rowRoute(row)))}; });
    const transitions=[];
    for(let i=0;i<destinations.length-1;i++){
      const current=destinations[i],next=destinations[i+1];
      const segs=(current.route?.segments||[]).slice().sort((a,b)=>dateKey(a.departureDate,a.departureTime)-dateKey(b.departureDate,b.departureTime));
      const last=segs.at(-1);
      const lastEnd=last?_routeEnd(last):{place:current.city,date:addDays(current.baseISO,Math.max(0,current.days-1)),time:current.perDay?.at(-1)?.end||''};
      transitions.push({
        type:'MAIN_DESTINATION_TRANSITION',
        origin:lastEnd.place||current.city,
        destination:next.city,
        departure_after:{date:lastEnd.date||addDays(current.baseISO,Math.max(0,current.days-1)),time:lastEnd.time||current.perDay?.at(-1)?.end||null},
        arrival:{date:next.baseISO,time:next.perDay?.[0]?.start||null},
        transport_status:'UNRESOLVED',
        commerce_need:'TRANSPORT',
        source:'USER_STRUCTURE'
      });
    }
    return {schema_version:VERSION,destinations,transitions,trip_story:state.tripStory?JSON.parse(JSON.stringify(state.tripStory)):null,preferences:JSON.parse(JSON.stringify(state.preferences)),itinerary_language:state.itineraryLanguage||'',updated_at:new Date().toISOString()};
  }

  function restore(model,rows=[]){
    if(!model||Number(model.schema_version)!==VERSION) return;
    const modelPrefs=model.preferences&&typeof model.preferences==='object'?model.preferences:null;
    const currentHasPrefs=Boolean(Object.keys(state.preferences?.places||{}).length || norm(state.preferences?.global?.notes));
    const modelHasPrefs=Boolean(Object.keys(modelPrefs?.places||{}).length || norm(modelPrefs?.global?.notes));
    if(modelHasPrefs || !currentHasPrefs) state.preferences=modelPrefs?JSON.parse(JSON.stringify(modelPrefs)):{global:{},places:{}};
    if(norm(model.itinerary_language) && !norm(state.itineraryLanguage)) state.itineraryLanguage=norm(model.itinerary_language);
    if(model.trip_story&&typeof model.trip_story==='object') state.tripStory=JSON.parse(JSON.stringify(model.trip_story));
    rows.forEach((row,index)=>{
      const src=model.destinations?.[index]; if(!src) return;
      state.routes[rowId(row)]=src.route&&typeof src.route==='object'?JSON.parse(JSON.stringify(src.route)):{segments:[]};
      renderRowSummary(row);
    });
  }

  function compileTripStoryContinuous(destination,story,model){
    const stays=(story?.stays||[]).filter(x=>x&&x.startDate&&norm(x.place));
    if(!stays.length) return null;
    const endOf=st=>addDays(st.startDate,Math.max(0,Number(st.days||1)-1));
    const firstDate=stays[0].startDate,lastDate=endOf(stays[stays.length-1]);
    const span=Math.max(1,Math.round((dateKey(lastDate)-dateKey(firstDate))/86400000)+1);
    const dayContexts=Array.from({length:span},(_,i)=>{const date=addDays(firstDate,i),owner=stays.find(st=>date>=st.startDate&&date<=endOf(st))||stays[Math.max(0,stays.findIndex(st=>st.startDate>date)-1)]||stays[0],di=Math.max(0,Math.round((dateKey(date)-dateKey(owner.startDate))/86400000)),hours=owner.perDay?.[di]||{};return {day:i+1,date,start_location:owner.place,end_location:owner.place,overnight_base:owner.place,fixed_transfers:[],location_windows:[],hard_route_constraints:[],_owner:owner,_dayStart:hours.start||null,_dayEnd:hours.end||null};});
    const movements=[];
    for(let i=1;i<stays.length;i++){const st=stays[i],prev=stays[i-1];movements.push({id:`story_move_${st.id||i}`,origin:prev.place,destination:st.place,departureDate:st.departureDate||st.startDate,arrivalDate:st.arrivalDate||st.startDate,departureTime:st.departureTime||'',arrivalTime:st.arrivalTime||'',transportMode:st.transportMode||'recommend',timePrecision:(st.departureTime&&st.arrivalTime)?'exact':'unknown',disposition:'continue',nights:Number(st.days||1),source:'TRIP_STORY'});}
    stays.forEach(st=>(st.dayTrips||[]).forEach((dt,j)=>{if(!norm(dt.place))return;const date=addDays(st.startDate,Math.max(0,Number(dt.day||1)-1));movements.push({id:`story_daytrip_${dt.id||j}`,origin:st.place,destination:dt.place,departureDate:date,arrivalDate:date,departureTime:dt.outbound?.departureTime||'',arrivalTime:dt.outbound?.arrivalTime||'',returnDepartureDate:date,returnDepartureTime:dt.return?.departureTime||'',returnArrivalDate:date,returnArrivalTime:dt.return?.arrivalTime||'',returnDestination:st.place,transportMode:dt.outbound?.transportMode||'recommend',returnTransportMode:dt.return?.transportMode||dt.outbound?.transportMode||'recommend',timePrecision:(dt.outbound?.departureTime&&dt.outbound?.arrivalTime&&dt.return?.departureTime&&dt.return?.arrivalTime)?'exact':'unknown',disposition:'roundtrip',source:'TRIP_STORY_DAYTRIP'});}));
    dayContexts.forEach(ctx=>{
      const dayMoves=movements.filter(m=>m.departureDate===ctx.date||m.returnDepartureDate===ctx.date).sort((a,b)=>(a.departureTime||'99:99').localeCompare(b.departureTime||'99:99'));
      let cursor=ctx._dayStart,location=ctx.start_location;
      dayMoves.forEach(m=>{
        if(m.departureDate===ctx.date){
          const exact=Boolean(m.departureTime&&m.arrivalTime),prep=exact?timeShift(m.departureTime,-transferPrepMinutes(m.transportMode)):'';
          if(exact&&prep&&(!cursor||cursor<prep))ctx.location_windows.push({location,start:cursor||null,end:prep,type:'plannable',flexible_start:!cursor,boundary_buffer:{kind:'pre_transfer',minutes:transferPrepMinutes(m.transportMode),mode:m.transportMode||null}});
          ctx.fixed_transfers.push({transfer_id:`${m.id}:outbound`,origin:m.origin,destination:m.destination,departure:m.departureTime||null,arrival:m.arrivalTime||null,date:m.departureDate,time_precision:m.timePrecision||'unknown',source:'USER_FIXED',mode:m.transportMode||null,buffer_before_minutes:transferPrepMinutes(m.transportMode),buffer_after_minutes:transferArrivalMinutes(m.transportMode)});
          ctx.location_windows.push({location:`${m.origin} → ${m.destination}`,start:m.departureTime||null,end:m.arrivalTime||null,type:'fixed_transfer',transfer_id:`${m.id}:outbound`,buffer_before_minutes:transferPrepMinutes(m.transportMode),buffer_after_minutes:transferArrivalMinutes(m.transportMode)});
          ctx.hard_route_constraints.push(`${m.origin} → ${m.destination}${m.departureTime?` ${m.departureTime}`:''}${m.arrivalTime?`–${m.arrivalTime}`:''}`);
          if(exact){cursor=timeShift(m.arrivalTime,transferArrivalMinutes(m.transportMode));location=m.destination;}
          else {ctx.flexible_movement=true;location=m.destination;}
          if(m.disposition!=='roundtrip'){ctx.end_location=m.destination;ctx.overnight_base=m.destination;}
        }
        if(m.disposition==='roundtrip'&&m.returnDepartureDate===ctx.date){
          const exactRet=Boolean(m.returnDepartureTime&&m.returnArrivalTime),prepRet=exactRet?timeShift(m.returnDepartureTime,-transferPrepMinutes(m.returnTransportMode||m.transportMode)):'';
          if(exactRet&&prepRet&&(!cursor||cursor<prepRet))ctx.location_windows.push({location,start:cursor||null,end:prepRet,type:'plannable',flexible_start:!cursor,day_trip:true});
          ctx.fixed_transfers.push({transfer_id:`${m.id}:return`,origin:m.destination,destination:m.origin,departure:m.returnDepartureTime||null,arrival:m.returnArrivalTime||null,date:m.returnDepartureDate,time_precision:m.timePrecision||'unknown',source:'USER_FIXED',mode:m.returnTransportMode||m.transportMode||null,buffer_before_minutes:transferPrepMinutes(m.returnTransportMode||m.transportMode),buffer_after_minutes:transferArrivalMinutes(m.returnTransportMode||m.transportMode)});
          ctx.location_windows.push({location:`${m.destination} → ${m.origin}`,start:m.returnDepartureTime||null,end:m.returnArrivalTime||null,type:'fixed_transfer',transfer_id:`${m.id}:return`,buffer_before_minutes:transferPrepMinutes(m.returnTransportMode||m.transportMode),buffer_after_minutes:transferArrivalMinutes(m.returnTransportMode||m.transportMode)});
          ctx.hard_route_constraints.push(`${m.destination} → ${m.origin}${m.returnDepartureTime?` ${m.returnDepartureTime}`:''}${m.returnArrivalTime?`–${m.returnArrivalTime}`:''}`);
          if(exactRet){cursor=timeShift(m.returnArrivalTime,transferArrivalMinutes(m.returnTransportMode||m.transportMode));location=m.origin;}
          else location=m.origin;
          ctx.end_location=m.origin;ctx.overnight_base=m.origin;
        }
      });
      if(!dayMoves.length){ctx.location_windows.push({location:ctx.start_location,start:ctx._dayStart,end:ctx._dayEnd,type:'plannable',flexible_start:!ctx._dayStart,flexible_end:!ctx._dayEnd,open_end:!ctx._dayEnd});}
      else if(cursor&&!ctx.flexible_movement&&(!ctx._dayEnd||cursor<ctx._dayEnd)){ctx.location_windows.push({location,start:cursor,end:ctx._dayEnd||null,type:'plannable',flexible_end:!ctx._dayEnd,open_end:!ctx._dayEnd});}
      delete ctx._owner;delete ctx._dayStart;delete ctx._dayEnd;
    });
    return {schema_version:VERSION,parent_destination:destination.city,day_contexts:dayContexts,segments:movements,main_destination_transitions:[],trip_story_compiled:true};
  }

  function compileForDestination(destination,model){
    if(model?.trip_story?.stays?.length){const compiled=compileTripStoryContinuous(destination,model.trip_story,model);if(compiled)return compiled;}
    const baseISO=isoDate(destination.baseDate||'');
    const totalDays=Math.max(1,Number(destination.days||1));
    const dayContexts=Array.from({length:totalDays},(_,i)=>({
      day:i+1,date:addDays(baseISO,i),start_location:destination.city,end_location:destination.city,overnight_base:destination.city,fixed_transfers:[],location_windows:[],hard_route_constraints:[]
    }));
    const allModelDestinations=(model?.destinations||[]);
    const source=allModelDestinations.find(x=>norm(x.city).toLowerCase()===norm(destination.city).toLowerCase()) || allModelDestinations.find(x=>x.baseDate===destination.baseDate);
    const ownSegments=(source?.route?.segments||[]);
    const inboundSegments=allModelDestinations.flatMap(x=>x?.route?.segments||[]).filter(seg=>
      norm(seg.destination).toLowerCase()===norm(destination.city).toLowerCase() && !ownSegments.some(own=>own.id===seg.id)
    );
    const segments=[...ownSegments,...inboundSegments].slice().sort((a,b)=>dateKey(a.departureDate,a.departureTime)-dateKey(b.departureDate,b.departureTime));
    let currentBase=destination.city;
    for(const ctx of dayContexts){ ctx.start_location=currentBase; ctx.end_location=currentBase; ctx.overnight_base=currentBase; }
    segments.forEach(seg=>{
      const depIndex=dayContexts.findIndex(x=>x.date===seg.departureDate);
      const arrIndex=dayContexts.findIndex(x=>x.date===seg.arrivalDate);
      const inboundToMain=norm(seg.destination).toLowerCase()===norm(destination.city).toLowerCase() && norm(seg.origin).toLowerCase()!==norm(destination.city).toLowerCase();
      if(depIndex>=0){
        if(inboundToMain) dayContexts[depIndex].start_location=seg.origin;
        const terminalArrival=_isLastPlannerDay({baseISO:source?.base_date||destination.baseDate,days:totalDays},seg.arrivalDate) && !['roundtrip','stay_return'].includes(String(seg.disposition||''));
        dayContexts[depIndex].fixed_transfers.push({origin:seg.origin,destination:seg.destination,departure:seg.departureTime||null,arrival:seg.arrivalTime||null,date:seg.departureDate,time_precision:seg.timePrecision||'exact',source:'USER_FIXED',mode:seg.transportMode||null,terminal_arrival:terminalArrival});
        if(terminalArrival){
          dayContexts[depIndex].terminal_arrival_only=true;
          dayContexts[depIndex].terminal_destination=seg.destination;
          dayContexts[depIndex].end_destination_block=true;
        }
        dayContexts[depIndex].hard_route_constraints.push(`${seg.origin} → ${seg.destination}${seg.departureTime?` ${seg.departureTime}`:''}${seg.arrivalTime?`–${seg.arrivalTime}`:''}`);
      }
      if(seg.disposition==='roundtrip'){
        const retIndex=dayContexts.findIndex(x=>x.date===seg.returnDepartureDate);
        if(retIndex>=0){
          dayContexts[retIndex].fixed_transfers.push({origin:seg.destination,destination:destination.city,departure:seg.returnDepartureTime||null,arrival:seg.returnArrivalTime||null,date:seg.returnDepartureDate,time_precision:seg.timePrecision||'exact',source:'USER_FIXED',mode:seg.returnTransportMode||seg.transportMode||null});
          dayContexts[retIndex].hard_route_constraints.push(`${seg.destination} → ${destination.city}${seg.returnDepartureTime?` ${seg.returnDepartureTime}`:''}${seg.returnArrivalTime?`–${seg.returnArrivalTime}`:''}`);
          dayContexts[retIndex].overnight_base=destination.city; dayContexts[retIndex].end_location=destination.city;
        }
      }else{
        const nights=seg.disposition==='end_block'?Math.max(1,dayContexts.length-(arrIndex>=0?arrIndex:depIndex)):Math.max(1,Number(seg.nights||1));
        const firstStay=arrIndex>=0?arrIndex:depIndex;
        for(let i=firstStay;i>=0&&i<dayContexts.length&&i<firstStay+nights;i++){
          dayContexts[i].end_location=seg.destination;dayContexts[i].overnight_base=seg.destination;
          if(!inboundToMain && (i>firstStay||(!seg.arrivalTime||seg.arrivalTime<'12:00'))) dayContexts[i].start_location=seg.destination;
        }
        if(firstStay+1<dayContexts.length) dayContexts[firstStay+1].start_location=seg.destination;
        if(seg.disposition==='stay_return'){
          const retIndex=dayContexts.findIndex(x=>x.date===seg.returnDepartureDate);
          if(retIndex>=0){
            dayContexts[retIndex].start_location=seg.destination;
            dayContexts[retIndex].fixed_transfers.push({origin:seg.destination,destination:destination.city,departure:seg.returnDepartureTime||null,arrival:seg.returnArrivalTime||null,date:seg.returnDepartureDate,time_precision:seg.timePrecision||'exact',source:'USER_FIXED',mode:seg.returnTransportMode||seg.transportMode||null});
            dayContexts[retIndex].hard_route_constraints.push(`${seg.destination} → ${destination.city}${seg.returnDepartureTime?` ${seg.returnDepartureTime}`:''}${seg.returnArrivalTime?`–${seg.returnArrivalTime}`:''}`);
            dayContexts[retIndex].end_location=destination.city; dayContexts[retIndex].overnight_base=destination.city;
            if(retIndex+1<dayContexts.length) dayContexts[retIndex+1].start_location=destination.city;
          }
        }
      }
    });
    // Propagate the real overnight location into the following morning.
    // This is essential for chained routes such as Madrid → Segovia → Toledo → Madrid.
    for(let i=1;i<dayContexts.length;i++){
      const previousBase=dayContexts[i-1].overnight_base||dayContexts[i-1].end_location;
      if(previousBase && norm(previousBase).toLowerCase()!==norm(destination.city).toLowerCase() && norm(dayContexts[i].start_location).toLowerCase()===norm(destination.city).toLowerCase()){
        dayContexts[i].start_location=previousBase;
      }
    }
    // Route Spine invariant: every user-entered movement carries deterministic identity
    // and rule-of-thumb operational buffers before the model sees any planning window.
    dayContexts.forEach(ctx=>{
      (ctx.fixed_transfers||[]).forEach((t,index)=>{
        t.transfer_id=t.transfer_id||`day-${ctx.day}-transfer-${index+1}`;
        t.source='USER_FIXED';
        t.buffer_before_minutes=Number.isFinite(Number(t.buffer_before_minutes))?Number(t.buffer_before_minutes):transferPrepMinutes(t.mode);
        t.buffer_after_minutes=Number.isFinite(Number(t.buffer_after_minutes))?Number(t.buffer_after_minutes):transferArrivalMinutes(t.mode);
      });
    });

    // Build deterministic windows for exact same-day transfers.
    dayContexts.forEach(ctx=>{
      const transfers=ctx.fixed_transfers.slice().sort((a,b)=>(a.departure||'99:99').localeCompare(b.departure||'99:99'));
      let cursor=null, location=ctx.start_location, terminalReached=false;
      transfers.forEach(t=>{
        const availableStart=cursor||destination.perDay?.[ctx.day-1]?.start||null;
        const prepEnd=t.departure?timeShift(t.departure,-transferPrepMinutes(t.mode)):t.departure;
        if(t.departure && availableStart && prepEnd && availableStart<prepEnd) ctx.location_windows.push({location,start:availableStart,end:prepEnd,type:'plannable',boundary_buffer:{kind:'pre_transfer',minutes:transferPrepMinutes(t.mode),mode:t.mode||null}});
        ctx.location_windows.push({location:`${t.origin} → ${t.destination}`,start:t.departure,end:t.arrival,type:'fixed_transfer',terminal_arrival:!!t.terminal_arrival});
        cursor=t.arrival?timeShift(t.arrival,transferArrivalMinutes(t.mode)):cursor;location=t.destination;
        if(t.terminal_arrival) terminalReached=true;
        const owner=segments.find(seg=>seg.returnDepartureDate===ctx.date&&seg.returnArrivalTime===t.arrival&&norm(destination.city).toLowerCase()===norm(t.destination).toLowerCase());
        if(owner?.resumeTime && cursor && owner.resumeTime>cursor) cursor=owner.resumeTime;
      });
      const dayStart=destination.perDay?.[ctx.day-1]?.start||null;
      const dayEnd=destination.perDay?.[ctx.day-1]?.end||null;
      if(transfers.length && cursor && !terminalReached){
        if(dayEnd && cursor<dayEnd) ctx.location_windows.push({location,start:cursor,end:dayEnd});
        else if(!dayEnd) ctx.location_windows.push({location,start:cursor,end:null,open_end:true,minimum_useful_target:'19:00'});
      }else if(!transfers.length && dayStart){
        // Every ordinary day also receives an explicit physical planning window.
        // V3 Quality Gate can therefore detect half-empty days and large unexplained
        // gaps instead of auditing route-transfer days only.
        if(dayEnd && dayStart<dayEnd) ctx.location_windows.push({location:ctx.start_location||destination.city,start:dayStart,end:dayEnd,type:'plannable'});
        else if(!dayEnd) ctx.location_windows.push({location:ctx.start_location||destination.city,start:dayStart,end:null,open_end:true,minimum_useful_target:'19:00',type:'plannable'});
      }
      ctx.end_location=ctx.overnight_base||location;
    });
    const transitions=(model?.transitions||[]).filter(t=>norm(t.origin).toLowerCase()===norm(destination.city).toLowerCase()||norm(t.destination).toLowerCase()===norm(destination.city).toLowerCase());
    return {schema_version:VERSION,parent_destination:destination.city,day_contexts:dayContexts,segments,main_destination_transitions:transitions};
  }

  function placesForPreferences(savedDestinations=[],model){
    const result=[];
    const add=(name,meta={})=>{ const key=norm(name).toLowerCase(); if(!key||result.some(x=>x.key===key)) return; result.push({key,name:norm(name),...meta}); };
    if(model?.trip_story?.stays?.length){
      // Preferences are collected only for physical stays/overnight bases.
      // Day Trips remain part of the route/timeline and generation context, but
      // they must never become independent preference cards.
      model.trip_story.stays.forEach(st=>{
        add(st.place,{
          type:'stay',
          country:st.country||'',
          dates:st.startDate||'',
          days:Number(st.days||1),
          nights:Math.max(0,Number(st.days||1)-1),
          routeArrivalTransport:st.transportMode||'recommend'
        });
      });
      return result;
    }
    savedDestinations.forEach(dest=>{
      add(dest.city,{type:'main',country:dest.country,dates:dest.baseDate,days:dest.days});
      const source=(model?.destinations||[]).find(x=>norm(x.city).toLowerCase()===norm(dest.city).toLowerCase());
      (source?.route?.segments||[]).forEach(seg=>{
        // A pure terminal arrival closes the current main-destination block but
        // is not itself a stay to personalize. It will appear later if the user
        // declares it as a main destination.
        const isLastDayArrival=_isLastPlannerDay({baseISO:source.base_date||dest.baseDate,days:Number(dest.days||0)},seg.arrivalDate);
        const returnsToBase=seg.disposition==='roundtrip'||seg.disposition==='stay_return';
        // Any non-returning arrival on the final day is terminal for preferences:
        // it closes this planning unit and becomes configurable only if the user
        // later adds that place as a MAIN destination.
        if(isLastDayArrival && !returnsToBase) return;
        // Round-trip excursions are route context, not independent preference destinations.
        if(seg.disposition==='roundtrip') return;
        add(seg.destination,{type:'stay',country:dest.country,nights:Number(seg.nights||1),routeArrivalTransport:seg.transportMode||''});
      });
    });
    return result;
  }

  function preferenceDefaults(place){
    return {saved:false,lodgingChoice:'recommend',lodgingText:'',arrivalTransport:'recommend',localTransport:'recommend',pace:'balanced',interests:[],mustDo:'',avoid:'',reservations:'',notes:''};
  }
  function renderPreferences(host,savedDestinations=[],model,onChange){
    if(!host) return;
    const places=placesForPreferences(savedDestinations,model);
    if(!state.itineraryLanguage) state.itineraryLanguage=lang()==='es'?'Español':'English';
    const activeKeys=new Set(places.map(p=>p.key));
    Object.keys(state.preferences.places||{}).forEach(key=>{if(!activeKeys.has(key)) delete state.preferences.places[key];});
    places.forEach(p=>{if(!state.preferences.places[p.key]) state.preferences.places[p.key]=preferenceDefaults(p);});
    host.innerHTML=`
      <div class="pref-v2-assist pref-v2-assist--intro"><div><span>✦</span><div><strong>${copy('Haz que tu itinerario se adapte realmente a ti','Make your itinerary truly fit you')}</strong><p>${copy('Cuéntanos tu estilo de viaje, ritmo, imprescindibles y cualquier necesidad o restricción especial. Primero puedes indicar generalidades para todo el viaje y después personalizar cada destino o estancia. Info Chat permanece disponible si necesitas investigar algo antes de decidir.','Tell us your travel style, pace, must-dos and any special need or restriction. Start with trip-wide preferences, then personalize each destination or stay. Info Chat remains available if you want to research something before deciding.')}</p></div></div></div>
      <div class="pref-v2-global">
        <div class="pref-v2-section-head"><div><strong>${copy('1. Para todo mi viaje','1. For my whole trip')}</strong><small>${copy('Generalidades opcionales que aplicaremos a todo el viaje. En el punto 2 podrás completar información específica, lugar por lugar, para cada destino y estancia.','Optional general preferences that apply to your whole trip. In section 2 you can add specific information, place by place, for every destination and stay.')}</small></div></div>
        <textarea data-pref-global placeholder="${copy('Ej.: ritmo tranquilo, viajamos con niños, priorizar experiencias locales, evitar restaurantes demasiado formales…','E.g. relaxed pace, traveling with children, prioritize local experiences, avoid overly formal restaurants…')}">${esc(state.preferences.global.notes||'')}</textarea>
      </div>
      <div class="pref-v2-list-head"><strong>${copy('2. Información por destino y estancia','2. Information by destination and stay')}</strong><p>${copy('Completa cada lugar por separado. Cuando guardes la información obligatoria, la tarjeta quedará marcada como lista, pero podrás volver a entrar y ajustarla cuando quieras antes de generar.','Complete each place separately. Once the required information is saved, its card will be marked ready, but you can reopen and adjust it any time before generation.')}</p></div>
      <div class="pref-v2-place-list">${places.map((p,i)=>placeCard(p,i)).join('')}</div>
      <div class="pref-v2-language"><div><strong>${copy('3. Idioma del itinerario','3. Itinerary language')}</strong><small>${copy('Hemos seleccionado el idioma de la página. Cámbialo aquí si prefieres recibir el itinerario en otro idioma.','We selected the page language. Change it here if you prefer the itinerary in another language.')}</small></div><select data-pref-language>${['Español','English','Français','Italiano','Deutsch','Português','Nederlands','Català','日本語','한국어','中文','Русский','العربية'].map(x=>`<option ${state.itineraryLanguage===x?'selected':''}>${x}</option>`).join('')}</select></div>
`;
    if(state.locked){
      host.querySelectorAll('[data-pref-language],[data-pref-global]').forEach(el=>{el.disabled=true;el.setAttribute('aria-disabled','true');});
    }else{
      host.querySelector('[data-pref-language]')?.addEventListener('change',e=>{state.itineraryLanguage=e.target.value;onChange?.();});
      host.querySelector('[data-pref-global]')?.addEventListener('input',e=>{state.preferences.global.notes=e.target.value;onChange?.();});
    }
    host.querySelectorAll('[data-pref-open]').forEach(btn=>btn.addEventListener('click',()=>openPreferenceEditor(host,places.find(x=>x.key===btn.dataset.prefOpen),savedDestinations,model,onChange)));
  }
  function placeCard(p,index){
    const pref=state.preferences.places[p.key]||preferenceDefaults(p);
    const complete=Boolean(pref.saved && (p.type==='daytrip'||pref.lodgingChoice)&&pref.arrivalTransport&&pref.localTransport);
    return `<article class="pref-v2-place-card ${complete?'is-complete':''}">
      <span class="pref-v2-number">${complete?'✓':index+1}</span><div class="pref-v2-place-title"><strong>${esc(p.name)}</strong><small>${p.type==='stay'?copy(`${p.nights||1} noche(s) dentro de la ruta`,'Overnight stay within route'):(p.type==='daytrip'?copy('Parada / excursión de un día','Stop / day trip'):copy(`${p.days||''} día(s) · destino principal`,'Main destination'))}</small></div>
      <div class="pref-v2-place-summary">${p.type==='daytrip'?'':`<span>🛏 ${esc(pref.lodgingChoice==='recommend'?copy('ITBMO elegirá una zona base conveniente','ITBMO will choose a convenient base area'):pref.lodgingText||copy('Definido','Set'))}</span>`}<span>🚆 ${esc(pref.arrivalTransport||'')}</span><span>♡ ${pref.interests?.length?esc(pref.interests.slice(0,2).join(', ')):copy('Opcional','Optional')}</span></div>
      <button type="button" data-pref-open="${esc(p.key)}">${state.locked?copy('Ver','View'):(complete?copy('Revisar','Review'):copy('Completar','Complete'))}</button>
    </article>`;
  }
  function openPreferenceEditor(host,place,savedDestinations,model,onChange){
    if(!place) return;
    const pref=state.preferences.places[place.key]||{...preferenceDefaults(place),arrivalTransport:place.routeArrivalTransport||'recommend'};
    const ui=wizardShell(copy(`Personaliza ${place.name}`,`Personalize ${place.name}`),copy('Primero pedimos lo imprescindible. Después puedes añadir detalles opcionales para afinar todavía más la planificación.','We ask for the essentials first. Then you can add optional details to fine-tune the plan.'));
    ui.body.innerHTML=`
      ${place.type==='daytrip'?'':`<section class="route-v2-step is-open"><div class="route-v2-step-index">1</div><div class="route-v2-step-content"><h4>${copy('Hospedaje','Lodging')} <em>${copy('Obligatorio','Required')}</em></h4><p>${copy(`Indica dónde te hospedarás en ${place.name}. Si aún no tienes alojamiento, ITBMO usará una zona base conveniente solo para optimizar rutas y tiempos; no reservará ni seleccionará un hotel por ti.`,`Tell us where you will stay in ${place.name}. It can be a name, address, area, landmark, or simply ask us to recommend one.`)}</p>
      <select data-p="lodgingChoice"><option value="recommend">${copy('Aún no tengo alojamiento · usa una zona base conveniente','I do not have lodging yet · use a convenient base area')}</option><option value="hotel">${copy('Tengo hotel/alojamiento','I have lodging')}</option><option value="area">${copy('Solo sé la zona aproximada','I only know the approximate area')}</option><option value="address">${copy('Tengo una dirección / ubicación','I have an address / location')}</option><option value="reference">${copy('Tengo un punto de referencia','I have a landmark')}</option></select>
      <input data-p="lodgingText" value="${esc(pref.lodgingText)}" placeholder="${copy('Nombre, dirección, zona, coordenadas o referencia…','Name, address, area, coordinates or landmark…')}"></div></section>`}
      <section class="route-v2-step is-open"><div class="route-v2-step-index">${place.type==='daytrip'?1:2}</div><div class="route-v2-step-content"><h4>${copy('Transporte','Transport')} <em>${copy('Obligatorio','Required')}</em></h4><p>${copy('Dinos cómo llegarás y cómo prefieres moverte. Si aún no lo sabes, selecciona “Recomiéndame”.','Tell us how you will arrive and how you prefer to get around. If you do not know yet, choose “Recommend”.')}</p>
      <div class="route-v2-grid2"><label>${copy('Cómo llegarás','How you will arrive')}<select data-p="arrivalTransport">${transportOptions(pref.arrivalTransport)}</select></label><label>${copy(`Cómo te moverás en ${place.name}`,`How you will get around ${place.name}`)}<select data-p="localTransport">${localTransportOptions(pref.localTransport)}</select></label></div></div></section>
      <section class="route-v2-step is-open route-v2-step--optional"><div class="route-v2-step-index">3</div><div class="route-v2-step-content"><h4>${copy(`Preferencias en ${place.name}`,`Preferences in ${place.name}`)} <em>${copy('Opcional','Optional')}</em></h4><p>${copy('Sé tan específico como quieras. ITBMO seguirá aplicando todas sus reglas para construir el mejor itinerario posible en este lugar.','Be as specific as you want. ITBMO will still apply all its planning rules to build the best itinerary possible in this place.')}</p>
      <label>${copy('Ritmo','Pace')}<select data-p="pace"><option value="relaxed">${copy('Relajado','Relaxed')}</option><option value="balanced">${copy('Equilibrado','Balanced')}</option><option value="intense">${copy('Intenso','Intense')}</option></select></label>
      <div class="pref-v2-interest-grid">${['Cultura e historia','Gastronomía','Naturaleza','Compras','Vida nocturna','Experiencias locales','Fotografía','Actividades familiares'].map(x=>`<label><input type="checkbox" data-interest value="${esc(x)}" ${pref.interests?.includes(x)?'checked':''}>${esc(x)}</label>`).join('')}</div>
      <label>${copy('Imprescindibles','Must-do')}<textarea data-p="mustDo" placeholder="${copy('Lugares, actividades o experiencias que quieres incluir sí o sí…','Places, activities or experiences you definitely want included…')}">${esc(pref.mustDo)}</textarea></label>
      <label>${copy('Reservas ya confirmadas','Confirmed reservations')}<textarea data-p="reservations" placeholder="${copy('Entradas, tours, restaurantes, trenes u otros compromisos con hora fija…','Tickets, tours, restaurants, trains or other fixed-time commitments…')}">${esc(pref.reservations)}</textarea></label>
      <label>${copy('Quiero evitar','I want to avoid')}<textarea data-p="avoid" placeholder="${copy('Ej.: museos largos, muchas escaleras, vida nocturna, caminatas intensas…','E.g. long museums, many stairs, nightlife, strenuous walks…')}">${esc(pref.avoid)}</textarea></label>
      <label>${copy('Algo más que debamos saber','Anything else we should know')}<textarea data-p="notes" placeholder="${copy('Cualquier detalle adicional que pueda ayudarnos a personalizar mejor este lugar…','Any additional detail that can help us personalize this place better…')}">${esc(pref.notes)}</textarea></label>
      </div></section>
      <div class="route-v2-modal-actions"><button type="button" class="route-v2-cancel">${copy('Cancelar','Cancel')}</button><button type="button" class="route-v2-save">${copy('Guardar y continuar','Save and continue')}</button></div>`;
    if(ui.body.querySelector('[data-p="lodgingChoice"]')) ui.body.querySelector('[data-p="lodgingChoice"]').value=pref.lodgingChoice||'recommend';
    ui.body.querySelector('[data-p="arrivalTransport"]').value=pref.arrivalTransport||'recommend';
    ui.body.querySelector('[data-p="localTransport"]').value=pref.localTransport||'recommend';
    ui.body.querySelector('[data-p="pace"]').value=pref.pace||'balanced';
    ui.body.querySelector('.route-v2-cancel')?.addEventListener('click',ui.close);
    if(state.locked){
      ui.body.querySelectorAll('input,select,textarea').forEach(el=>{el.disabled=true;el.setAttribute('aria-disabled','true');});
      const cancel=ui.body.querySelector('.route-v2-cancel'); if(cancel) cancel.style.display='none';
      const save=ui.body.querySelector('.route-v2-save'); if(save){save.textContent=copy('Cerrar','Close');save.addEventListener('click',ui.close);}
    }else{
      ui.body.querySelector('.route-v2-save')?.addEventListener('click',()=>{
        ui.body.querySelectorAll('[data-p]').forEach(el=>pref[el.dataset.p]=el.value);
        pref.interests=[...ui.body.querySelectorAll('[data-interest]:checked')].map(x=>x.value);
        pref.saved=true; state.preferences.places[place.key]=pref; onChange?.(); ui.close(); renderPreferences(host,savedDestinations,model,onChange);
      });
    }
  }
  function transportOptions(selected='recommend'){
    return [['recommend',copy('Recomiéndame','Recommend')],['train',copy('Tren','Train')],['bus',copy('Bus','Bus')],['plane',copy('Avión','Plane')],['car',copy('Automóvil','Car')],['transfer',copy('Transfer','Transfer')],['ferry',copy('Ferry','Ferry')],['other',copy('Otro','Other')]].map(([v,l])=>`<option value="${v}" ${selected===v?'selected':''}>${l}</option>`).join('');
  }
  function localTransportOptions(selected='recommend'){
    return [['recommend',copy('Recomiéndame','Recommend')],['walk',copy('A pie','Walking')],['public',copy('Transporte público','Public transport')],['car',copy('Automóvil','Car')],['taxi',copy('Taxi / Uber','Taxi / Uber')],['bike',copy('Bicicleta','Bicycle')],['mixed',copy('Mixto','Mixed')]].map(([v,l])=>`<option value="${v}" ${selected===v?'selected':''}>${l}</option>`).join('');
  }

  function preferencesPayload(){return {schema_version:VERSION,itinerary_language:state.itineraryLanguage,global:JSON.parse(JSON.stringify(state.preferences.global)),places:JSON.parse(JSON.stringify(state.preferences.places))};}
  function allRequiredPreferencesComplete(savedDestinations=[],model){
    return placesForPreferences(savedDestinations,model).every(p=>{const v=state.preferences.places[p.key];return Boolean(v?.saved) && (p.type==='daytrip'?Boolean(v?.arrivalTransport&&v?.localTransport):Boolean(v?.lodgingChoice&&v?.arrivalTransport&&v?.localTransport));});
  }
  function specialConditionsText(){
    const blocks=[];
    if(norm(state.preferences.global.notes)) blocks.push(`GLOBAL: ${norm(state.preferences.global.notes)}`);
    Object.entries(state.preferences.places||{}).forEach(([key,p])=>{
      const lines=[];
      if(p.lodgingChoice) lines.push(`Lodging: ${p.lodgingChoice}${p.lodgingText?` — ${p.lodgingText}`:''}`);
      if(p.arrivalTransport) lines.push(`Arrival transport: ${p.arrivalTransport}`);
      if(p.localTransport) lines.push(`Local transport: ${p.localTransport}`);
      if(p.pace) lines.push(`Pace: ${p.pace}`);
      if(p.interests?.length) lines.push(`Interests: ${p.interests.join(', ')}`);
      if(norm(p.mustDo)) lines.push(`Must-do: ${norm(p.mustDo)}`);
      if(norm(p.reservations)) lines.push(`Confirmed reservations: ${norm(p.reservations)}`);
      if(norm(p.avoid)) lines.push(`Avoid: ${norm(p.avoid)}`);
      if(norm(p.notes)) lines.push(`Other: ${norm(p.notes)}`);
      if(lines.length) blocks.push(`${key.toUpperCase()}:\n${lines.join('\n')}`);
    });
    return blocks.join('\n\n');
  }

  function setLocked(value){state.locked=Boolean(value);}
  function setTripStory(story){state.tripStory=story&&typeof story==='object'?JSON.parse(JSON.stringify(story)):null;}
  function setRouteSegments(row,segments=[]){if(!row)return;state.routes[rowId(row)]={segments:JSON.parse(JSON.stringify(segments||[]))};renderRowSummary(row);}
  window.ITBMOTravelV2={VERSION,state,attachCityRow,renderRowSummary,collect,restore,validateAll,compileForDestination,renderPreferences,preferencesPayload,allRequiredPreferencesComplete,specialConditionsText,placesForPreferences,setLocked,setTripStory,setRouteSegments};
})();
