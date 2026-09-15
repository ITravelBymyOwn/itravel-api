/* ITBMO · Travel Model V2
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
      baseISO:isoDate(row.querySelector('.baseDate')?.value||'')
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
  function _dayChips(meta,field,value,fromISO=''){
    return `<div class="route-v2-daychips" data-day-field="${field}">${_dayOptions(meta,fromISO).map(d=>`<button type="button" data-day-value="${d.iso}" class="${value===d.iso?'is-selected':''}"><strong>${d.label}</strong><small>${d.date}</small></button>`).join('')}</div>`;
  }
  function _deriveNights(arrivalISO,departureISO){
    if(!arrivalISO||!departureISO) return 0;
    return Math.max(0,Math.round((dateKey(departureISO)-dateKey(arrivalISO))/86400000));
  }
  function renderRowSummary(row){
    const host=ensureRouteHost(row), meta=rowMeta(row), route=rowRoute(row);
    const segments=(route.segments||[]).slice().sort((a,b)=>dateKey(a.departureDate,a.departureTime)-dateKey(b.departureDate,b.departureTime));
    host.innerHTML=`<div class="route-v2-head"><div><strong>${copy('Tu recorrido dentro de este destino','Your route within this destination')}</strong><small>${copy('Opcional. Si ya sabes que visitarás, dormirás o te moverás a otro lugar, añádelo. ITBMO conectará cada parada con los días y horarios de tu Planner.','Optional. If you already know you will visit, stay overnight or move elsewhere, add it. ITBMO will connect each stop to your Planner days and times.')}</small></div><button type="button" class="route-v2-add">＋ ${segments.length?copy('Continuar ruta','Continue route'):copy('Añadir traslado o parada','Add transfer or stop')}</button></div>
      <div class="route-v2-segments">${segments.length?segments.map(seg=>segmentCard(seg)).join(''):''}</div>`;
    host.querySelector('.route-v2-add')?.addEventListener('click',()=>openSegmentWizard(row));
    const quickStop=row.querySelector('.hours-quick-add-stop'); if(quickStop&&!quickStop.dataset.routeBound){quickStop.dataset.routeBound='1';quickStop.addEventListener('click',()=>openSegmentWizard(row));}
    host.querySelectorAll('[data-route-edit]').forEach(btn=>btn.addEventListener('click',()=>{const seg=route.segments.find(x=>x.id===btn.dataset.routeEdit);if(seg)openSegmentWizard(row,seg);}));
    host.querySelectorAll('[data-route-remove]').forEach(btn=>btn.addEventListener('click',()=>{route.segments=route.segments.filter(x=>x.id!==btn.dataset.routeRemove);renderRowSummary(row);}));
  }
  function segmentCard(seg){
    const end=seg.disposition==='roundtrip'||seg.disposition==='stay_return'?` → ${seg.origin}`:'';
    const overnight=seg.disposition==='open'||seg.disposition==='continue'||seg.disposition==='stay_return';
    return `<article class="route-v2-segment-card"><div class="route-v2-segment-icon">↗</div><div class="route-v2-segment-main"><strong>${esc(seg.origin)} → ${esc(seg.destination)}${esc(end)}</strong><span>${esc(dmy(seg.departureDate)||seg.departureDate)} · ${esc(seg.departureTime||copy('hora por definir','time TBD'))} → ${esc(dmy(seg.arrivalDate)||seg.arrivalDate)} · ${esc(seg.arrivalTime||copy('hora por definir','time TBD'))}</span><small>${overnight?copy('La ubicación nocturna se integra automáticamente al Planner.','Overnight location is automatically integrated into the Planner.'):copy('Visita dentro del mismo día.','Same-day visit.')}</small></div><div class="route-v2-segment-actions"><button type="button" data-route-edit="${esc(seg.id)}">${copy('Editar','Edit')}</button><button type="button" data-route-remove="${esc(seg.id)}">✕</button></div></article>`;
  }
  function wizardShell(title,subtitle){
    document.querySelector('.route-v2-overlay')?.remove(); const overlay=document.createElement('div');overlay.className='route-v2-overlay';
    overlay.innerHTML=`<div class="route-v2-modal" role="dialog" aria-modal="true"><button class="route-v2-close" type="button">✕</button><div class="route-v2-modal-kicker">${copy('CONSTRUYE TU RECORRIDO','BUILD YOUR ROUTE')}</div><h3>${esc(title)}</h3><p class="route-v2-modal-intro">${esc(subtitle)}</p><div class="route-v2-wizard-body"></div></div>`;
    document.body.appendChild(overlay);const close=()=>{overlay.classList.remove('active');setTimeout(()=>overlay.remove(),180)};overlay.querySelector('.route-v2-close').onclick=close;requestAnimationFrame(()=>overlay.classList.add('active'));return{overlay,body:overlay.querySelector('.route-v2-wizard-body'),close};
  }
  function openSegmentWizard(row,existing=null){
    const meta=rowMeta(row),route=rowRoute(row); if(!meta.baseISO||!meta.days){alert(copy('Primero indica el primer día y la cantidad de días del destino.','First enter the start date and number of days.'));return;}
    const sorted=(route.segments||[]).slice().sort((a,b)=>dateKey(a.arrivalDate,a.arrivalTime)-dateKey(b.arrivalDate,b.arrivalTime));
    const prior=existing?null:sorted.at(-1);
    let drafts=[];
    let seg=existing?{...existing}:{id:uid(),origin:(prior?.disposition==='continue'||prior?.disposition==='open')?prior.destination:(meta.city||''),destination:'',departureDate:prior?.arrivalDate||'',departureTime:'',arrivalDate:'',arrivalTime:'',disposition:'',returnDepartureDate:'',returnDepartureTime:'',returnArrivalDate:'',returnArrivalTime:'',timePrecision:'exact'};
    const ui=wizardShell(copy('Añadir traslado o parada','Add transfer or stop'),copy('Selecciona, no escribas de más. Cada decisión abre solo el siguiente paso y queda conectada con los días reales de tu Planner.','Select instead of typing whenever possible. Each decision reveals only the next step and stays connected to your real Planner days.'));
    const render=()=>{
      const hasDay=!!seg.departureDate,hasDest=!!norm(seg.destination),hasTimes=seg.timePrecision==='unknown'||(seg.departureTime&&seg.arrivalTime);
      if(hasDay&&!seg.arrivalDate)seg.arrivalDate=seg.departureDate;
      if(seg.disposition==='roundtrip'&&seg.arrivalDate)seg.returnDepartureDate=seg.arrivalDate;
      const draftSummary=drafts.length?`<div class="route-v2-built">${drafts.map((d,i)=>`<div><span>✓</span><strong>${esc(d.origin)} → ${esc(d.destination)}</strong><small>${esc(dmy(d.departureDate))} · ${esc(d.departureTime||'--:--')}–${esc(d.arrivalTime||'--:--')}</small></div>`).join('')}</div>`:'';
      ui.body.innerHTML=`${draftSummary}
      <section class="route-v2-step is-open"><div class="route-v2-step-index">1</div><div class="route-v2-step-content"><h4>${copy(`¿Qué día sales de ${seg.origin||meta.city}?`,`What day do you leave ${seg.origin||meta.city}?`)}</h4><p>${copy('Estos son los días que ya creaste en el Planner. Selecciona uno y ocultaremos los demás para continuar.','These are the days already created in your Planner. Select one and we will collapse the rest to continue.')}</p>${_dayChips(meta,'departureDate',seg.departureDate,prior?.arrivalDate||'')}</div></section>
      ${hasDay?`<section class="route-v2-step is-open"><div class="route-v2-step-index">2</div><div class="route-v2-step-content"><h4>${copy('¿A dónde vas?','Where are you going?')}</h4><p>${copy(`Sales desde ${seg.origin||meta.city}. Solo necesitamos el nombre del siguiente lugar.`,`You are leaving from ${seg.origin||meta.city}. We only need the name of the next place.`)}</p><label>${copy('Destino o lugar','Destination or place')}<input data-route-destination value="${esc(seg.destination)}" placeholder="${copy('Ej.: Segovia','E.g. Segovia')}"></label></div></section>`:''}
      ${hasDay&&hasDest?`<section class="route-v2-step is-open"><div class="route-v2-step-index">3</div><div class="route-v2-step-content"><h4>${copy(`¿A qué hora te mueves a ${seg.destination}?`,`What time do you move to ${seg.destination}?`)}</h4><p>${copy('Usamos el mismo selector del Planner. Si el traslado cruza de día, selecciona también el día de llegada.','We use the same selector as the Planner. If the transfer crosses into another day, select the arrival day too.')}</p><div class="route-v2-timegrid">${_timeSelect('departureTime',seg.departureTime,copy('Hora de salida','Departure time'))}${_timeSelect('arrivalTime',seg.arrivalTime,copy('Hora de llegada','Arrival time'))}</div><details class="route-v2-arrival-day"><summary>${copy('¿Llegas otro día?','Arriving another day?')}</summary>${_dayChips(meta,'arrivalDate',seg.arrivalDate,seg.departureDate)}</details><label class="route-v2-check"><input type="checkbox" data-route-unknown ${seg.timePrecision==='unknown'?'checked':''}><span>${copy('Todavía no conozco las horas exactas','I do not know the exact times yet')}</span></label></div></section>`:''}
      ${hasDay&&hasDest&&hasTimes?`<section class="route-v2-step is-open"><div class="route-v2-step-index">4</div><div class="route-v2-step-content"><h4>${copy(`¿Qué harás después de ${seg.destination}?`,`What will you do after ${seg.destination}?`)}</h4><p>${copy('Elige lo que mejor describe tu viaje. Puede ser unas horas, una o varias noches, o continuar a otra ciudad.','Choose what best matches your trip. It can be a few hours, one or several nights, or continuing to another city.')}</p><div class="route-v2-choice-grid route-v2-choice-grid--four">
      ${[['roundtrip',copy('Regreso el mismo día','Return same day'),copy('Visita ida y vuelta.','Round trip visit.')],['stay_return',copy('Me quedaré y regresaré','Stay, then return'),copy('Una o varias noches.','One or several nights.')],['continue',copy('Continuaré a otro lugar','Continue elsewhere'),copy('La ruta sigue desde aquí.','Route continues from here.')],['open',copy('Termino aquí por ahora','Finish here for now'),copy('Podrás continuar después.','Continue later.')]].map(([v,a,b])=>`<label class="route-v2-choice ${seg.disposition===v?'selected':''}"><input type="radio" name="route-disposition" value="${v}" ${seg.disposition===v?'checked':''}><strong>${a}</strong><span>${b}</span></label>`).join('')}</div></div></section>`:''}
      ${(seg.disposition==='roundtrip'||seg.disposition==='stay_return')?`<section class="route-v2-step is-open"><div class="route-v2-step-index">5</div><div class="route-v2-step-content"><h4>${copy(`¿Cuándo sales de ${seg.destination} para volver a ${seg.origin}?`,`When do you leave ${seg.destination} to return to ${seg.origin}?`)}</h4><p>${copy(seg.disposition==='roundtrip'?'La fecha ya está fijada al mismo día. Solo selecciona las horas.':'Selecciona el día de salida. ITBMO calculará automáticamente los días y noches de estancia.','Select the departure day. ITBMO will automatically calculate the stay.')}</p>${seg.disposition==='stay_return'?_dayChips(meta,'returnDepartureDate',seg.returnDepartureDate,seg.arrivalDate):`<div class="route-v2-fixed-day"><strong>${copy('Mismo día','Same day')}</strong><span>${esc(dmy(seg.arrivalDate))}</span></div>`}<div class="route-v2-timegrid">${_timeSelect('returnDepartureTime',seg.returnDepartureTime,copy(`Salida de ${seg.destination}`,`Leave ${seg.destination}`))}${_timeSelect('returnArrivalTime',seg.returnArrivalTime,copy(`Llegada a ${seg.origin}`,`Arrive ${seg.origin}`))}</div></div></section>`:''}
      ${seg.disposition==='continue'?`<section class="route-v2-step is-open"><div class="route-v2-step-index">5</div><div class="route-v2-step-content"><h4>${copy(`¿Cuándo continúas desde ${seg.destination}?`,`When do you continue from ${seg.destination}?`)}</h4><p>${copy('Selecciona el día. No importa si pasas una, dos o más noches: la duración se deriva automáticamente.','Select the day. One, two or more nights are all supported; duration is derived automatically.')}</p>${_dayChips(meta,'nextDepartureDate',seg.nextDepartureDate||'',seg.arrivalDate)}${seg.nextDepartureDate?`<label>${copy('Siguiente ciudad o lugar','Next city or place')}<input data-route-next-destination value="${esc(seg.nextDestination||'')}" placeholder="${copy('Ej.: Toledo','E.g. Toledo')}"></label><div class="route-v2-timegrid">${_timeSelect('nextDepartureTime',seg.nextDepartureTime||'',copy(`Salida de ${seg.destination}`,`Leave ${seg.destination}`))}${_timeSelect('nextArrivalTime',seg.nextArrivalTime||'',copy('Hora de llegada','Arrival time'))}</div>`:''}</div></section>`:''}
      <div class="route-v2-modal-actions"><button type="button" class="route-v2-cancel">${copy('Cancelar','Cancel')}</button>${seg.disposition==='continue'?`<button type="button" class="route-v2-continue">${copy('Guardar tramo y seguir →','Save leg and continue →')}</button>`:`<button type="button" class="route-v2-save">${drafts.length?copy('Guardar recorrido','Save route'):copy('Guardar traslado o parada','Save transfer or stop')}</button>`}</div>`;
      bind();
    };
    const bind=()=>{
      ui.body.querySelectorAll('[data-day-value]').forEach(btn=>btn.onclick=()=>{const field=btn.closest('[data-day-field]').dataset.dayField;seg[field]=btn.dataset.dayValue;if(field==='departureDate'&&!seg.arrivalDate)seg.arrivalDate=seg[field];if(field==='returnDepartureDate')seg.nights=_deriveNights(seg.arrivalDate,seg.returnDepartureDate);render();});
      const dest=ui.body.querySelector('[data-route-destination]');if(dest){dest.oninput=e=>seg.destination=e.target.value;dest.onblur=()=>{if(norm(seg.destination))render();};dest.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();dest.blur();}};}
      const nd=ui.body.querySelector('[data-route-next-destination]');if(nd)nd.oninput=e=>seg.nextDestination=e.target.value;
      ui.body.querySelectorAll('[data-time-field]').forEach(group=>{const field=group.dataset.timeField;const sync=()=>{const h=group.querySelector(`[data-time-hour="${field}"]`).value,m=group.querySelector(`[data-time-minute="${field}"]`).value;seg[field]=h?`${h}:${m}`:'';};group.querySelectorAll('select').forEach(x=>x.onchange=()=>{sync();render();});});
      const unk=ui.body.querySelector('[data-route-unknown]');if(unk)unk.onchange=()=>{seg.timePrecision=unk.checked?'unknown':'exact';render();};
      ui.body.querySelectorAll('input[name="route-disposition"]').forEach(r=>r.onchange=()=>{if(!r.checked)return;seg.disposition=r.value;if(r.value==='roundtrip'){seg.returnDepartureDate=seg.arrivalDate;seg.nights=0;}render();});
      ui.body.querySelector('.route-v2-cancel')?.addEventListener('click',ui.close);
      ui.body.querySelector('.route-v2-continue')?.addEventListener('click',()=>{
        if(!norm(seg.nextDestination)||!seg.nextDepartureDate||(seg.timePrecision!=='unknown'&&(!seg.nextDepartureTime||!seg.nextArrivalTime))){showInlineError(ui.body,copy('Completa el siguiente destino, el día y las horas para continuar la ruta.','Complete the next destination, day and times to continue.'));return;}
        const nextDestination=norm(seg.nextDestination),nextDepartureDate=seg.nextDepartureDate,nextDepartureTime=seg.nextDepartureTime||'',nextArrivalTime=seg.nextArrivalTime||'';
        seg.nights=_deriveNights(seg.arrivalDate,nextDepartureDate);const current={...seg};delete current.nextDestination;delete current.nextDepartureDate;delete current.nextDepartureTime;delete current.nextArrivalTime;drafts.push(current);
        seg={id:uid(),origin:current.destination,destination:nextDestination,departureDate:nextDepartureDate,departureTime:nextDepartureTime,arrivalDate:nextDepartureDate,arrivalTime:nextArrivalTime,disposition:'',returnDepartureDate:'',returnDepartureTime:'',returnArrivalDate:'',returnArrivalTime:'',timePrecision:current.timePrecision||'exact'};
        render();
      });
      ui.body.querySelector('.route-v2-save')?.addEventListener('click',()=>{const errors=validateSegment(seg);if(errors.length){showInlineError(ui.body,errors[0]);return;}const all=[...drafts,{...seg}];if(existing)route.segments=route.segments.filter(x=>x.id!==existing.id);all.forEach(x=>{const i=route.segments.findIndex(y=>y.id===x.id);if(i>=0)route.segments[i]=x;else route.segments.push(x);});renderRowSummary(row);ui.close();});
    };
    render();
  }

  function showInlineError(body,message){
    body.querySelector('.route-v2-inline-error')?.remove();
    const div=document.createElement('div');div.className='route-v2-inline-error';div.textContent=message;
    body.querySelector('.route-v2-modal-actions')?.before(div);
  }
  function validateSegment(seg){
    const errors=[];
    if(!norm(seg.destination)) errors.push(copy('Indica el destino o lugar.','Enter the destination or place.'));
    if(!norm(seg.disposition)) errors.push(copy('Indica qué harás después de llegar.','Tell us what you will do after arriving.'));
    if(!seg.departureDate||!seg.arrivalDate) errors.push(copy('Indica las fechas de salida y llegada.','Enter departure and arrival dates.'));
    if(seg.timePrecision!=='unknown'&&(!seg.departureTime||!seg.arrivalTime)) errors.push(copy('Indica las horas o marca que todavía no las conoces.','Enter the times or mark that you do not know them yet.'));
    if(seg.disposition==='roundtrip'||seg.disposition==='stay_return'){
      if(!seg.returnDepartureDate) errors.push(copy('Indica la fecha de regreso.','Enter the return date.'));
      if(seg.timePrecision!=='unknown'&&(!seg.returnDepartureTime||!seg.returnArrivalTime)) errors.push(copy('Completa las horas del regreso o marca que aún no conoces las horas exactas.','Complete return times or mark that exact times are unknown.'));
    }
    const out=dateKey(seg.departureDate,seg.departureTime||'00:00'), arr=dateKey(seg.arrivalDate,seg.arrivalTime||'23:59');
    if(out&&arr&&arr<out) errors.push(copy('La llegada no puede ocurrir antes de la salida.','Arrival cannot occur before departure.'));
    if((seg.disposition==='roundtrip'||seg.disposition==='stay_return')&&seg.returnDepartureDate){
      const ret=dateKey(seg.returnDepartureDate,seg.returnDepartureTime||'23:59');
      if(arr&&ret&&ret<arr) errors.push(copy('El regreso no puede comenzar antes de llegar al lugar.','The return cannot begin before arriving at the place.'));
      if(seg.disposition==='stay_return' && Number(seg.nights||0)>0){
        const expected=addDays(seg.arrivalDate,Number(seg.nights));
        if(expected && seg.returnDepartureDate!==expected) errors.push(copy(`La cantidad de noches no coincide con la fecha de regreso. Con ${seg.nights} noche(s), la salida debería ser ${expected}.`,`The number of nights does not match the return date. With ${seg.nights} night(s), departure should be ${expected}.`));
      }
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
    renderRowSummary(row);
  }

  function validateAll(rows=[]){
    const errors=[];
    const all=[];
    rows.forEach((row,rowIndex)=>{
      const meta=rowMeta(row), route=rowRoute(row);
      (route.segments||[]).forEach(seg=>{
        validateSegment(seg).forEach(message=>errors.push({rowIndex,segmentId:seg.id,message}));
        all.push({...seg,rowIndex,parentCity:meta.city});
      });
    });
    all.sort((a,b)=>dateKey(a.departureDate,a.departureTime)-dateKey(b.departureDate,b.departureTime));
    for(let i=1;i<all.length;i++){
      const prev=all[i-1], next=all[i];
      const prevEnd=prev.disposition==='roundtrip'||prev.disposition==='stay_return'
        ? dateKey(prev.returnDepartureDate,prev.returnArrivalTime||prev.returnDepartureTime||'23:59')
        : dateKey(prev.arrivalDate,prev.arrivalTime||'23:59');
      const nextStart=dateKey(next.departureDate,next.departureTime||'00:00');
      if(prevEnd&&nextStart&&nextStart<prevEnd){
        errors.push({rowIndex:next.rowIndex,segmentId:next.id,message:copy(`Hay una superposición: el siguiente traslado comienza antes de terminar el anterior.`,`There is an overlap: the next transfer begins before the previous one ends.`)});
      }
    }
    return {ok:errors.length===0,errors};
  }

  function collect(rows=[]){
    const destinations=rows.map(row=>{ const meta=rowMeta(row); return {...meta,route:JSON.parse(JSON.stringify(rowRoute(row)))}; });
    return {schema_version:VERSION,destinations,preferences:JSON.parse(JSON.stringify(state.preferences)),itinerary_language:state.itineraryLanguage||'',updated_at:new Date().toISOString()};
  }

  function restore(model,rows=[]){
    if(!model||Number(model.schema_version)!==VERSION) return;
    const modelPrefs=model.preferences&&typeof model.preferences==='object'?model.preferences:null;
    const currentHasPrefs=Boolean(Object.keys(state.preferences?.places||{}).length || norm(state.preferences?.global?.notes));
    const modelHasPrefs=Boolean(Object.keys(modelPrefs?.places||{}).length || norm(modelPrefs?.global?.notes));
    if(modelHasPrefs || !currentHasPrefs) state.preferences=modelPrefs?JSON.parse(JSON.stringify(modelPrefs)):{global:{},places:{}};
    if(norm(model.itinerary_language) && !norm(state.itineraryLanguage)) state.itineraryLanguage=norm(model.itinerary_language);
    rows.forEach((row,index)=>{
      const src=model.destinations?.[index]; if(!src) return;
      state.routes[rowId(row)]=src.route&&typeof src.route==='object'?JSON.parse(JSON.stringify(src.route)):{segments:[]};
      renderRowSummary(row);
    });
  }

  function compileForDestination(destination,model){
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
        dayContexts[depIndex].fixed_transfers.push({origin:seg.origin,destination:seg.destination,departure:seg.departureTime||null,arrival:seg.arrivalTime||null,date:seg.departureDate,time_precision:seg.timePrecision||'exact',source:'USER_FIXED'});
        dayContexts[depIndex].hard_route_constraints.push(`${seg.origin} → ${seg.destination}${seg.departureTime?` ${seg.departureTime}`:''}${seg.arrivalTime?`–${seg.arrivalTime}`:''}`);
      }
      if(seg.disposition==='roundtrip'){
        const retIndex=dayContexts.findIndex(x=>x.date===seg.returnDepartureDate);
        if(retIndex>=0){
          dayContexts[retIndex].fixed_transfers.push({origin:seg.destination,destination:seg.origin,departure:seg.returnDepartureTime||null,arrival:seg.returnArrivalTime||null,date:seg.returnDepartureDate,time_precision:seg.timePrecision||'exact',source:'USER_FIXED'});
          dayContexts[retIndex].hard_route_constraints.push(`${seg.destination} → ${seg.origin}${seg.returnDepartureTime?` ${seg.returnDepartureTime}`:''}${seg.returnArrivalTime?`–${seg.returnArrivalTime}`:''}`);
          dayContexts[retIndex].overnight_base=seg.origin; dayContexts[retIndex].end_location=seg.origin;
        }
      }else{
        const nights=seg.disposition==='open'?Math.max(1,dayContexts.length-(arrIndex>=0?arrIndex:depIndex)):Math.max(1,Number(seg.nights||1));
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
            dayContexts[retIndex].fixed_transfers.push({origin:seg.destination,destination:seg.origin,departure:seg.returnDepartureTime||null,arrival:seg.returnArrivalTime||null,date:seg.returnDepartureDate,time_precision:seg.timePrecision||'exact',source:'USER_FIXED'});
            dayContexts[retIndex].hard_route_constraints.push(`${seg.destination} → ${seg.origin}${seg.returnDepartureTime?` ${seg.returnDepartureTime}`:''}${seg.returnArrivalTime?`–${seg.returnArrivalTime}`:''}`);
            dayContexts[retIndex].end_location=seg.origin; dayContexts[retIndex].overnight_base=seg.origin;
            if(retIndex+1<dayContexts.length) dayContexts[retIndex+1].start_location=seg.origin;
          }
        }
      }
    });
    // Build deterministic windows for exact same-day transfers.
    dayContexts.forEach(ctx=>{
      const transfers=ctx.fixed_transfers.slice().sort((a,b)=>(a.departure||'99:99').localeCompare(b.departure||'99:99'));
      let cursor=null, location=ctx.start_location;
      transfers.forEach(t=>{
        const availableStart=cursor||destination.perDay?.[ctx.day-1]?.start||null;
        if(t.departure && availableStart && availableStart!==t.departure) ctx.location_windows.push({location,start:availableStart,end:t.departure});
        ctx.location_windows.push({location:`${t.origin} → ${t.destination}`,start:t.departure,end:t.arrival,type:'fixed_transfer'});
        cursor=t.arrival||cursor;location=t.destination;
      });
      const dayEnd=destination.perDay?.[ctx.day-1]?.end||null;
      if(transfers.length) ctx.location_windows.push({location,start:cursor,end:dayEnd});
      ctx.end_location=ctx.overnight_base||location;
    });
    return {schema_version:VERSION,parent_destination:destination.city,day_contexts:dayContexts,segments};
  }

  function placesForPreferences(savedDestinations=[],model){
    const result=[];
    const add=(name,meta={})=>{ const key=norm(name).toLowerCase(); if(!key||result.some(x=>x.key===key)) return; result.push({key,name:norm(name),...meta}); };
    savedDestinations.forEach(dest=>{
      add(dest.city,{type:'main',country:dest.country,dates:dest.baseDate,days:dest.days});
      const source=(model?.destinations||[]).find(x=>norm(x.city).toLowerCase()===norm(dest.city).toLowerCase());
      (source?.route?.segments||[]).forEach(seg=>{
        add(seg.destination,{type:seg.disposition==='roundtrip'?'daytrip':'stay',country:dest.country,nights:seg.disposition==='roundtrip'?0:Number(seg.nights||1)});
      });
    });
    return result;
  }

  function preferenceDefaults(place){
    return {lodgingChoice:'recommend',lodgingText:'',arrivalTransport:'recommend',localTransport:'recommend',pace:'balanced',interests:[],mustDo:'',avoid:'',reservations:'',notes:''};
  }
  function renderPreferences(host,savedDestinations=[],model,onChange){
    if(!host) return;
    const places=placesForPreferences(savedDestinations,model);
    if(!state.itineraryLanguage) state.itineraryLanguage=lang()==='es'?'Español':'English';
    places.forEach(p=>{if(!state.preferences.places[p.key]) state.preferences.places[p.key]=preferenceDefaults(p);});
    host.innerHTML=`
      <div class="pref-v2-assist">
        <div><span>✦</span><div><strong>${copy('Info Chat ya está disponible','Info Chat is now available')}</strong><p>${copy('Úsalo mientras personalizas tu viaje para investigar zonas, hospedaje, transporte, actividades o cualquier duda. La ventana es flotante: puedes moverla y seguir completando esta sección.','Use it while personalizing your trip to research areas, lodging, transport, activities or any question. The window floats, so you can move it and keep completing this section.')}</p></div></div>
        <button type="button" data-pref-info-chat>💬 ${copy('Abrir Info Chat','Open Info Chat')}</button>
      </div>
      <div class="pref-v2-language"><div><strong>${copy('Idioma del itinerario','Itinerary language')}</strong><small>${copy('Hemos seleccionado el idioma de la página. Puedes cambiarlo si prefieres recibir el itinerario en otro idioma.','We selected the page language. You can change it if you prefer the itinerary in another language.')}</small></div><select data-pref-language>${['Español','English','Français','Italiano','Deutsch','Português','Nederlands','Català','日本語','한국어','中文','Русский','العربية'].map(x=>`<option ${state.itineraryLanguage===x?'selected':''}>${x}</option>`).join('')}</select></div>
      <div class="pref-v2-global">
        <div class="pref-v2-section-head"><div><strong>${copy('Para todo mi viaje','For my whole trip')}</strong><small>${copy('Añade aquí lo que debe aplicarse a todos los lugares. Es opcional.','Add anything that should apply everywhere. This is optional.')}</small></div></div>
        <textarea data-pref-global placeholder="${copy('Ej.: ritmo tranquilo, viajamos con niños, priorizar experiencias locales, evitar restaurantes demasiado formales…','E.g. relaxed pace, traveling with children, prioritize local experiences, avoid overly formal restaurants…')}">${esc(state.preferences.global.notes||'')}</textarea>
      </div>
      <div class="pref-v2-list-head"><strong>${copy('Información por destino y estancia','Information by destination and stay')}</strong><p>${copy('Completa un lugar a la vez. Al guardar, se cerrará y quedará un resumen limpio para que la pantalla respire.','Complete one place at a time. After saving, it collapses into a clean summary so the screen stays light.')}</p></div>
      <div class="pref-v2-place-list">${places.map((p,i)=>placeCard(p,i)).join('')}</div>`;
    host.querySelector('[data-pref-info-chat]')?.addEventListener('click',()=>document.querySelector('#info-chat-floating')?.click());
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
    const complete=Boolean(pref.lodgingChoice&&pref.arrivalTransport&&pref.localTransport);
    return `<article class="pref-v2-place-card ${complete?'is-complete':''}">
      <span class="pref-v2-number">${index+1}</span><div class="pref-v2-place-title"><strong>${esc(p.name)}</strong><small>${p.type==='stay'?copy(`${p.nights||1} noche(s) dentro de la ruta`,'Overnight stay within route'):(p.type==='daytrip'?copy('Parada / excursión de un día','Stop / day trip'):copy(`${p.days||''} día(s) · destino principal`,'Main destination'))}</small></div>
      <div class="pref-v2-place-summary">${p.type==='daytrip'?'':`<span>🛏 ${esc(pref.lodgingChoice==='recommend'?copy('Recomiéndame','Recommend'):pref.lodgingText||copy('Definido','Set'))}</span>`}<span>🚆 ${esc(pref.arrivalTransport||'')}</span><span>♡ ${pref.interests?.length?esc(pref.interests.slice(0,2).join(', ')):copy('Opcional','Optional')}</span></div>
      <button type="button" data-pref-open="${esc(p.key)}">${state.locked?copy('Ver','View'):(complete?copy('Revisar','Review'):copy('Completar','Complete'))}</button>
    </article>`;
  }
  function openPreferenceEditor(host,place,savedDestinations,model,onChange){
    if(!place) return;
    const pref=state.preferences.places[place.key]||preferenceDefaults(place);
    const ui=wizardShell(copy(`Personaliza ${place.name}`,`Personalize ${place.name}`),copy('Primero pedimos lo imprescindible. Después puedes añadir detalles opcionales para afinar todavía más la planificación.','We ask for the essentials first. Then you can add optional details to fine-tune the plan.'));
    ui.body.innerHTML=`
      ${place.type==='daytrip'?'':`<section class="route-v2-step is-open"><div class="route-v2-step-index">1</div><div class="route-v2-step-content"><h4>${copy('Hospedaje','Lodging')} <em>${copy('Obligatorio','Required')}</em></h4><p>${copy(`Indica dónde te hospedarás en ${place.name}. Puede ser el nombre, una dirección, una zona, un punto de referencia o simplemente pedirnos una recomendación.`,`Tell us where you will stay in ${place.name}. It can be a name, address, area, landmark, or simply ask us to recommend one.`)}</p>
      <select data-p="lodgingChoice"><option value="recommend">${copy('Recomiéndame un alojamiento','Recommend lodging')}</option><option value="hotel">${copy('Tengo hotel/alojamiento','I have lodging')}</option><option value="area">${copy('Solo sé la zona aproximada','I only know the approximate area')}</option><option value="address">${copy('Tengo una dirección / ubicación','I have an address / location')}</option><option value="reference">${copy('Tengo un punto de referencia','I have a landmark')}</option></select>
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
        state.preferences.places[place.key]=pref; onChange?.(); ui.close(); renderPreferences(host,savedDestinations,model,onChange);
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
    return placesForPreferences(savedDestinations,model).every(p=>{const v=state.preferences.places[p.key];return p.type==='daytrip'?Boolean(v?.arrivalTransport&&v?.localTransport):Boolean(v?.lodgingChoice&&v?.arrivalTransport&&v?.localTransport);});
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
  window.ITBMOTravelV2={VERSION,state,attachCityRow,renderRowSummary,collect,restore,validateAll,compileForDestination,renderPreferences,preferencesPayload,allRequiredPreferencesComplete,specialConditionsText,placesForPreferences,setLocked};
})();
