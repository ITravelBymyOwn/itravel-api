// ==========================================================
// planner-chat.js — Motor completo de la SECCIÓN 14 (chat libre e inteligente)
// ==========================================================

(async function(){
  console.log("🧠 planner-chat.js inicializando...");

  // ===== Esperar que Webflow exporte las variables globales =====
  function waitForPlanner(maxMs=8000){
    return new Promise((resolve,reject)=>{
      const t0=Date.now();
      (function poll(){
        if(window.savedDestinations && window.itineraries && window.cityMeta && document.querySelector('#send-btn')){
          resolve(window);
        }else if(Date.now()-t0>maxMs) reject(new Error('Planner not ready'));
        else setTimeout(poll,50);
      })();
    });
  }

  await waitForPlanner();
  console.log("✅ planner-chat.js conectado al entorno Webflow.");

  // ===== Helpers =====
  const msg=(text,who='ai')=>{
    const $chatM=document.querySelector('#chat-messages');
    if(!text||!$chatM)return;
    const div=document.createElement('div');
    div.className='chat-message '+(who==='user'?'user':'ai');
    div.innerHTML=text.replace(/\n/g,'<br>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>');
    $chatM.appendChild(div);
    $chatM.scrollTop=$chatM.scrollHeight;
  };

  const parseJSON=(text)=>{
    if(!text) return null;
    try{return JSON.parse(text);}catch(_){}
    const m=text.match(/```json\s*([\s\S]*?)```/i)||text.match(/```([\s\S]*?)```/i);
    if(m&&m[1]){try{return JSON.parse(m[1]);}catch(_){}}return null;
  };

  const normalize=(t)=>{
    return t.toLowerCase()
      .replaceAll('á','a').replaceAll('é','e').replaceAll('í','i')
      .replaceAll('ó','o').replaceAll('ú','u');
  };

  const extractInt=(str)=>{
    const m=str.match(/\b(\d{1,2})\b/);
    if(m) return Math.max(1,parseInt(m[1],10));
    if(/\bun\b|\buno\b|\buna\b/.test(str)) return 1;
    return 1;
  };

  const parseTimesFromText=(text)=>{
    const times=[];let tnorm=text.toLowerCase()
      .replace(/\s+de\s+la\s+manana/g,'am')
      .replace(/\s+de\s+la\s+tarde/g,'pm')
      .replace(/\s+de\s+la\s+noche/g,'pm')
      .replace(/\s*y\s+media/g,':30')
      .replace(/\s*y\s+cuarto/g,':15');
    const re=/(\b\d{1,2}(:\d{2})?\s*(am|pm|h)?\b)/gi;
    let m;while((m=re.exec(tnorm))!==null){
      let t=m[1].trim().toLowerCase();
      let ampm=/(am|pm)$/.exec(t)?.[1];
      t=t.replace(/(am|pm|h)$/,'');
      if(!t.includes(':')) t=t+':00';
      let[h,mi]=t.split(':').map(x=>parseInt(x,10));
      if(ampm==='pm'&&h<12)h+=12;if(ampm==='am'&&h===12)h=0;
      const HH=String(Math.max(0,Math.min(23,h))).padStart(2,'0');
      const MM=String(Math.max(0,Math.min(59,mi||0))).padStart(2,'0');
      times.push(`${HH}:${MM}`);
    }
    return times;
  };

  // ===== Variables compartidas del planner (Webflow) =====
  const savedDestinations = window.savedDestinations;
  const itineraries = window.itineraries;
  const cityMeta = window.cityMeta;
  const callAgent = window.callAgent || (async ()=>'{}');
  const applyParsedToState = window.applyParsedToState;
  const renderCityTabs = window.renderCityTabs;
  const renderCityItinerary = window.renderCityItinerary;
  const setActiveCity = window.setActiveCity;
  const generateCityItinerary = window.generateCityItinerary;
  const metaIsComplete = window.metaIsComplete;
  const maybeGenerateAllCities = window.maybeGenerateAllCities;

  // ===== Chat Helpers =====
  function findCityInText(text){
    const t=normalize(text);
    for(const {city} of savedDestinations){
      if(t.includes(normalize(city))) return city;
    }
    return null;
  }

  function removeActivityRows(city, dayOrNull, keyword){
    if(!itineraries[city] || !keyword) return 0;
    const kw = normalize(keyword);
    const targetDays = dayOrNull ? [dayOrNull] : Object.keys(itineraries[city].byDay||{}).map(n=>parseInt(n,10));
    let removed = 0;
    targetDays.forEach(d=>{
      const rows = itineraries[city].byDay?.[d] || [];
      const before = rows.length;
      itineraries[city].byDay[d] = rows.filter(r => !normalize(r.activity||'').includes(kw));
      removed += Math.max(0, before - (itineraries[city].byDay[d]||[]).length);
    });
    return removed;
  }

  function getDayScopeFromText(text){
    const m = text.match(/\bd[ií]a\s+(\d{1,2})\b/i);
    if (m) return Math.max(1, parseInt(m[1],10));
    if (/\b(ultimo|último)\s+d[ií]a\b/i.test(text)) return 'LAST';
    return null;
  }

  function resolveDayNumber(city, dayScope){
    if(dayScope === 'LAST'){
      const days = Object.keys(itineraries[city]?.byDay||{}).map(n=>parseInt(n,10));
      return days.length ? Math.max(...days) : 1;
    }
    return dayScope || null;
  }

  async function checkAndGenerateMissing(){
    for(const {city} of savedDestinations){
      const m = cityMeta[city];
      const hasRows = Object.values(itineraries[city]?.byDay || {}).some(a => a.length > 0);
      if(typeof metaIsComplete === 'function' && metaIsComplete(m) && !hasRows){
        await generateCityItinerary(city);
      }
    }
  }

  // ====== Chat principal ======
  async function sendChat(){
    const $intake=document.querySelector('#intake');
    const text=($intake?.value||'').trim();
    if(!text)return;
    msg(text,'user');
    $intake.value='';

    const tNorm = normalize(text);
    let handled = false;
    const cityFromText = findCityInText(text);
    const workingCity = cityFromText || window.activeCity;

    if(cityFromText && cityFromText !== window.activeCity){
      setActiveCity(cityFromText);
      renderCityItinerary(cityFromText);
    }

    // --- Agregar días ---
    if(/\b(agrega|añade|sumar?|add)\b.*\bd[ií]a/.test(tNorm) || /\b(un dia mas|1 dia mas)\b/.test(tNorm)){
      const addN = extractInt(tNorm);
      if(workingCity){
        const current = savedDestinations.find(x=>x.city===workingCity)?.days || Object.keys(itineraries[workingCity]?.byDay||{}).length || 1;
        const newDays = current + addN;
        const hasActivity = /\b(tour|excursion|visita|museo|paseo|segovia|toledo|parque|mercado|playa|ruta)\b/i.test(text);
        const activityDesc = hasActivity ? text : null;

        if(activityDesc){
          const prompt = `
${window.FORMAT}
Edita el itinerario de "${workingCity}" agregando ${addN} día${addN>1?'s':''}.
Incluye como actividad principal: "${activityDesc}".
Devuelve SOLO JSON formato B.`;
          const ans = await callAgent(prompt);
          const parsed = parseJSON(ans);
          if(parsed) applyParsedToState(parsed,false);
        } else {
          await generateCityItinerary(workingCity);
        }

        renderCityTabs(); setActiveCity(workingCity); renderCityItinerary(workingCity);
        msg(`He añadido ${addN} día${addN>1?'s':''} en ${workingCity}.`);
      }
      handled = true;
    }

    // --- Quitar días ---
    if(!handled && (/\b(quita|elimina|remueve|remove)\b.*\bd[ií]a/.test(tNorm) || /\b(ultimo|último)\s+d[ií]a\b/i.test(tNorm))){
      const remN = /\b\d+\b/.test(tNorm) ? extractInt(tNorm) : 1;
      if(workingCity){
        const current = savedDestinations.find(x=>x.city===workingCity)?.days || Object.keys(itineraries[workingCity]?.byDay||{}).length || 1;
        const newDays = Math.max(1, current - remN);
        const keys = Object.keys(itineraries[workingCity]?.byDay||{}).map(d=>parseInt(d,10)).sort((a,b)=>b-a);
        keys.slice(0,remN).forEach(k=>delete itineraries[workingCity].byDay[k]);
        renderCityTabs(); setActiveCity(workingCity); renderCityItinerary(workingCity);
        msg(`He quitado ${remN} día${remN>1?'s':''} en ${workingCity}.`);
      }
      handled = true;
    }

    // --- Eliminar / sustituir actividades ---
    if(!handled && /(quita|elimina|remueve|sustituye|reemplaza|cambia)/i.test(text)){
      const targetCity = workingCity;
      const mSwap = /(sustituye|reemplaza|cambia)\s+(?:el\s+)?(.+?)\s+por\s+(.+?)(?:$|\.|,)/i.exec(text);
      const dayScopeRaw = getDayScopeFromText(text);
      const dayN = resolveDayNumber(targetCity, dayScopeRaw);
      if(mSwap){
        const oldK=mSwap[2].trim(), newK=mSwap[3].trim();
        const removed=removeActivityRows(targetCity,dayN,oldK);
        const swapPrompt=`
${window.FORMAT}
En "${targetCity}" ${dayN?`(día ${dayN})`:''} elimina "${oldK}" y sustitúyelo por "${newK}".
Devuelve JSON formato B.`;
        const ans=await callAgent(swapPrompt);
        const parsed=parseJSON(ans);
        if(parsed){
          applyParsedToState(parsed,false);
          renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
          msg(removed>0?`Sustituí "${oldK}" por "${newK}" en ${targetCity}.`:`Añadí "${newK}" en ${targetCity}.`,'ai');
        } else msg(`Eliminé "${oldK}". ¿Qué quieres en su lugar?`,'ai');
        handled=true;
      }
    }

    // --- Ajuste de horas ---
    if(!handled && /\b(hora|horario|inicio|fin|empieza|termina|ajusta|cambia)\b/.test(tNorm)){
      const times = parseTimesFromText(text);
      if(workingCity && times.length){
        cityMeta[workingCity] = cityMeta[workingCity] || { baseDate:null,start:null,end:null,hotel:'' };
        if(times.length===1){
          if(/\b(hasta|termina|fin)\b/.test(tNorm)) cityMeta[workingCity].end=times[0];
          else cityMeta[workingCity].start=times[0];
        }else{
          cityMeta[workingCity].start=times[0];
          cityMeta[workingCity].end=times[times.length-1];
        }
        await generateCityItinerary(workingCity);
        renderCityTabs(); setActiveCity(workingCity); renderCityItinerary(workingCity);
        msg(`He ajustado las horas en ${workingCity}.`);
      }
      handled = true;
    }

    // --- Recalcular itinerario ---
    if(!handled && /\b(recalcula|replanifica|optimiza|regen|actualiza)\b/.test(tNorm)){
      if(workingCity){
        await generateCityItinerary(workingCity);
        renderCityTabs(); setActiveCity(workingCity); renderCityItinerary(workingCity);
        msg(`He recalculado el itinerario de ${workingCity}.`);
      }
      handled=true;
    }

    // Si ya resolvimos algo, verificar faltantes
    if(handled){ await checkAndGenerateMissing(); return; }

    // --- Edición libre (fallback) ---
    const prompt=`
${window.FORMAT}
Edita el plan actual (solo ciudad activa o mencionada). 
Solicitud: ${text}
Plan existente: ${window.getItineraryContext()}
Meta: ${window.getCityMetaContext()}`;
    const ans = await callAgent(prompt);
    const parsed = parseJSON(ans);
    if(parsed){
      applyParsedToState(parsed,false);
      renderCityTabs(); setActiveCity(workingCity||window.activeCity); renderCityItinerary(workingCity||window.activeCity);
      msg(parsed.followup || '¿Deseas otro ajuste?','ai');
    }else{
      msg(ans || 'Listo. ¿Otra cosa?','ai');
    }
    await checkAndGenerateMissing();
  }

  // ===== Eventos =====
  const $send=document.querySelector('#send-btn');
  const $intake=document.querySelector('#intake');
  if($send)$send.addEventListener('click',sendChat);
  if($intake)$intake.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();sendChat();}});

  console.log("💬 planner-chat.js listo y escuchando mensajes.");
})();
