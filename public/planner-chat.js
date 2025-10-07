/* ============================================================
   planner-chat.js — SECCIÓN 14 COMPLETA Y FUNCIONAL (v6)
   ============================================================ */

(function(){
  const PL = window.__planner;
  if(!PL){ console.error('❌ Planner bridge not found'); return; }

  const {
    dom: { $send, $intake },
    helpers: { normalize, extractInt, parseTimesFromText, updateSavedDays },
    api: { callAgent, parseJSON, getItineraryContext, getCityMetaContext,
           generateCityItinerary, applyParsedToState, ensureDays, upsertCityMeta },
    ui: { renderCityTabs, renderCityItinerary, msg, askForNextCityMeta, maybeGenerateAllCities },
    state
  } = PL;

  let {
    savedDestinations, itineraries, cityMeta,
    activeCity, collectingMeta, metaProgressIndex,
    awaitingMetaReply, planningStarted, session
  } = state;

  /* ============ Chat libre (incluye fase de meta y edición) ============ */
  function userWantsReplace(text){
    const t=(text||'').toLowerCase();
    return /(sustituye|reemplaza|cambia todo|replace|overwrite|desde cero|todo nuevo)/i.test(t);
  }

  function isAcceptance(text){
    const t=(text||'').toLowerCase().trim();
    return /(^|\b)(ok|listo|esta bien|perfecto|de acuerdo|vale|sounds good|looks good|c’est bon|tout bon|beleza|ta bom)\b/.test(t);
  }

  /* ==== Helpers extendidos de NL ==== */
  function getDayScopeFromText(text){
    const m = text.match(/\bd[ií]a\s+(\d{1,2})\b/i);
    if (m) return Math.max(1, parseInt(m[1],10));
    if (/\b(ultimo|último)\s+d[ií]a\b/i.test(text)) return 'LAST';
    return null;
  }

  function extractRemovalKeyword(text){
    const clean = text.replace(/\ben el d[ií]a\s+\d+\b/ig,'').replace(/\bdel d[ií]a\s+\d+\b/ig,'');
    const p = /\b(?:no\s+(?:quiero|deseo)\s+|quita(?:r)?\s+|elimina(?:r)?\s+|remueve(?:r)?\s+|cancelar\s+)(.+)$/i.exec(clean);
    return p && p[1] ? p[1].trim() : null;
  }

  function hasAskForAlternative(text){
    const t = text.toLowerCase();
    return /(otra|alternativa|sustituye|reemplaza|cambia por|pon otra|dame opciones|algo diferente|dame otro|sugiere)/i.test(t);
  }

  function normalizeActivityString(s){
    return (s||'').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/\s+/g,' ')
      .trim();
  }

  function removeActivityRows(city, dayOrNull, keyword){
    if(!itineraries[city] || !keyword) return 0;
    const kw = normalizeActivityString(keyword);
    const targetDays = dayOrNull ? [dayOrNull] : Object.keys(itineraries[city].byDay||{}).map(n=>parseInt(n,10));
    let removed = 0;
    targetDays.forEach(d=>{
      const rows = itineraries[city].byDay?.[d] || [];
      const before = rows.length;
      itineraries[city].byDay[d] = rows.filter(r => !normalizeActivityString(r.activity||'').includes(kw));
      removed += Math.max(0, before - (itineraries[city].byDay[d]||[]).length);
    });
    ensureDays(city);
    return removed;
  }

  function findCityInText(text){
    const t = normalize(text);
    for(const {city} of savedDestinations){
      if(t.includes(normalize(city))) return city;
    }
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

  /* ==== Chat principal ==== */
  async function sendChat(){
    const text = ($intake.value||'').trim();
    if(!text) return;
    msg(text,'user'); 
    $intake.value='';

    // ======= Fase 1: recopilación secuencial de meta =======
    if(collectingMeta){
      const city = savedDestinations[metaProgressIndex]?.city;
      if(!city){ collectingMeta=false; await maybeGenerateAllCities(); return; }

      const extractPrompt = `
Extrae del texto la meta para la ciudad "${city}" en formato D del esquema:
${FORMAT}
Devuelve SOLO:
{"meta":{"city":"${city}","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"}}
Texto del usuario: ${text}`.trim();

      const answer = await callAgent(extractPrompt);
      const parsed = parseJSON(answer);

      if(parsed?.meta){
        upsertCityMeta(parsed.meta);
        awaitingMetaReply = false;
        msg(`Perfecto, tengo la información para ${city}.`);
        metaProgressIndex++;
        if(metaProgressIndex < savedDestinations.length){
          await askForNextCityMeta();
        }else{
          collectingMeta = false;
          msg('Perfecto 🎉 Ya tengo toda la información. Generando itinerarios...');
          await maybeGenerateAllCities();
        }
      }else{
        msg('No logré entender. ¿Podrías repetir la fecha del primer día, horarios y hotel/zona?');
      }
      return;
    }

    // ======= Fase 2: conversación normal =======
    const tNorm = normalize(text);
    let handled = false;

    const cityFromText = findCityInText(text);
    const workingCity = cityFromText || activeCity;
    if(cityFromText && cityFromText !== activeCity){
      setActiveCity(cityFromText);
      renderCityItinerary(cityFromText);
    }

    // --- a) Agregar días ---
    if(/\b(agrega|añade|sumar?|add)\b.*\bd[ií]a/.test(tNorm) || /\b(un dia mas|1 dia mas)\b/.test(tNorm)){
      const addN = extractInt(tNorm);
      const hasActivity = /\b(tour|excursion|visita|museo|paseo|segovia|toledo|montserrat|catedral|parque|mercado|playa|ruta)\b/i.test(text);
      const activityDesc = hasActivity ? text : null;

      if(workingCity){
        const current = savedDestinations.find(x=>x.city===workingCity)?.days 
          || Object.keys(itineraries[workingCity]?.byDay||{}).length || 1;
        const newDays = current + addN;
        updateSavedDays(workingCity,newDays);
        ensureDays(workingCity);

        if(hasActivity){
          const prompt = `
${FORMAT}
Edita el itinerario de "${workingCity}" agregando ${addN} día${addN>1?'s':''}.
Incluye como actividad principal: "${activityDesc}" en el/los día(s) nuevo(s) y completa con otras actividades no repetidas.
No elimines días previos.
Devuelve SOLO JSON con "destination":"${workingCity}".`.trim();
          const ans = await callAgent(prompt);
          const parsed = parseJSON(ans);
          if(parsed){ applyParsedToState(parsed,false); }
        }else{
          await generateCityItinerary(workingCity);
        }

        renderCityTabs();
        setActiveCity(workingCity);
        renderCityItinerary(workingCity);
        msg(`He añadido ${addN} día${addN>1?'s':''} en ${workingCity}.`);
      }
      handled = true;
    }

    // --- b) Quitar días ---
    if(!handled && (/\b(quita|elimina|remueve|remove)\b.*\bd[ií]a/.test(tNorm) || /\b(ultimo|último)\s+d[ií]a\b/i.test(tNorm))){
      const remN = /\b\d+\b/.test(tNorm) ? extractInt(tNorm) : 1;
      const targetCity = workingCity;
      if(targetCity){
        const current = savedDestinations.find(x=>x.city===targetCity)?.days 
          || Object.keys(itineraries[targetCity]?.byDay||{}).length || 1;
        const newDays = Math.max(1, current - remN);
        updateSavedDays(targetCity,newDays);
        const keys = Object.keys(itineraries[targetCity]?.byDay||{}).map(d=>parseInt(d,10)).sort((a,b)=>b-a);
        keys.slice(0,remN).forEach(k=>delete itineraries[targetCity].byDay[k]);
        ensureDays(targetCity);
        renderCityTabs();
        setActiveCity(targetCity);
        renderCityItinerary(targetCity);
        msg(`He quitado ${remN} día${remN>1?'s':''} en ${targetCity}.`);
      }
      handled = true;
    }

    // --- c) Eliminar / sustituir actividades ---
    if(!handled && /(no\s+(?:quiero|deseo)|quita|elimina|remueve|cancelar|sustituye|reemplaza|cambia)/i.test(text)){
      const targetCity = workingCity;
      if(targetCity){
        const mSwap = /(sustituye|reemplaza|cambia)\s+(?:el\s+)?(.+?)\s+por\s+(.+?)(?:$|\.|,)/i.exec(text);
        const dayScopeRaw = getDayScopeFromText(text);
        const dayN = resolveDayNumber(targetCity, dayScopeRaw);

        if(mSwap){
          const oldK = mSwap[2].trim();
          const newK = mSwap[3].trim();
          const removed = removeActivityRows(targetCity, dayN, oldK);

          const swapPrompt = `
${FORMAT}
En "${targetCity}" ${dayN?`(día ${dayN})`:''} elimina "${oldK}" y sustitúyelo por actividades basadas en "${newK}".
Mantén coherencia de horarios y no repitas con lo ya existente.
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
          const ans = await callAgent(swapPrompt);
          const parsed = parseJSON(ans);
          if(parsed){ 
            applyParsedToState(parsed,false);
            renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
            msg(removed>0?`Sustituí "${oldK}" por "${newK}" en ${targetCity}.`:`Añadí actividades de "${newK}" en ${targetCity}.`,'ai');
          }else{
            msg(`Eliminé "${oldK}". ¿Qué tipo de actividad quieres en su lugar?`,'ai');
          }
          handled = true;
        }else if (/(quita|elimina|remueve|cancelar|no\s+(?:quiero|deseo))/i.test(text)){
          const keyword = extractRemovalKeyword(text);
          if(keyword){
            const removed = removeActivityRows(targetCity, dayN, keyword);
            renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);

            if(removed>0 && hasAskForAlternative(text)){
              const altPrompt = `
${FORMAT}
En "${targetCity}" ${dayN?`(día ${dayN})`:''} el usuario quitó "${keyword}".
Propón y añade nuevas actividades equivalentes o alternativas (sin repetir otras del mismo día).
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
              const ans = await callAgent(altPrompt);
              const parsed = parseJSON(ans);
              if(parsed){
                applyParsedToState(parsed,false);
                renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
                msg(`He sustituido "${keyword}" por nuevas actividades en ${targetCity}.`,'ai');
              }else{
                msg(`He eliminado "${keyword}". Puedo sugerir alternativas si me dices el tipo que prefieres.`,'ai');
              }
            }else{
              msg(removed>0?`He eliminado "${keyword}" ${dayN?`del día ${dayN}`:''} en ${targetCity}.`:`No encontré "${keyword}" ${dayN?`en el día ${dayN}`:''}.`,'ai');
            }
            handled = true;
          }
        }
      }
    }

    // --- d) Más detalle ---
    if(!handled && /\b(detalla|mas detalle|más detalle|expande|amplia|amplía|describe mejor|dame mas info|hazlo mas preciso)\b/i.test(text)){
      const targetCity = workingCity;
      if(targetCity){
        const dayScopeRaw = getDayScopeFromText(text);
        const dayN = resolveDayNumber(targetCity, dayScopeRaw);
        const detailPrompt = `
${FORMAT}
El usuario quiere más detalle ${dayN?`del día ${dayN} `:''}en "${targetCity}".
Amplía descripciones, incluye contexto, tiempos realistas y recomendaciones. No dupliques con el resto de días.
Devuelve SOLO JSON formato B para "destination":"${targetCity}" ${dayN?`limitado al día ${dayN}`:''}.`.trim();
        const ans = await callAgent(detailPrompt);
        const parsed = parseJSON(ans);
        if(parsed){
          applyParsedToState(parsed,false);
          renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
          msg(`He detallado las actividades ${dayN?`del día ${dayN} `:''}en ${targetCity}.`,'ai');
        }else{
          msg('No pude detallar actividades.','ai');
        }
      }
      handled = true;
    }

    // --- e) Ajuste de horas ---
    if(!handled && /\b(hora|horario|inicio|fin|empieza|termina|ajusta|cambia)\b/.test(tNorm)){
      const times = parseTimesFromText(text);
      const targetCity = workingCity;
      if(targetCity && times.length){
        cityMeta[targetCity] = cityMeta[targetCity] || { baseDate:null, start:null, end:null, hotel:'' };
        if(times.length === 1){
          if(/\b(hasta|termina|fin)\b/.test(tNorm)) cityMeta[targetCity].end = times[0];
          else cityMeta[targetCity].start = times[0];
        }else{
          cityMeta[targetCity].start = times[0];
          cityMeta[targetCity].end = times[times.length-1];
        }
        await generateCityItinerary(targetCity);
        renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
        msg(`He ajustado las horas en ${targetCity}.`);
      }
      handled = true;
    }

    // --- f) Recalcular itinerario ---
    if(!handled && /\b(recalcula|replanifica|recompute|replan|recalculate|actualiza|regen|optimiza)\b/.test(tNorm)){
      const targetCity = workingCity;
      if(targetCity){
        await generateCityItinerary(targetCity);
        renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
        msg(`He recalculado el itinerario de ${targetCity}.`);
      }
      handled = true;
    }

    if(handled){
      await checkAndGenerateMissing();
      return;
    }

    // --- g) Edición libre general ---
    session.push({role:'user', content:text});
    const cityHint = workingCity ? `Active city: ${workingCity}` : '';
    const prompt = `
${FORMAT}
Edit the current plan. ${cityHint}
Scope: Modifica SOLO la ciudad activa o la mencionada por el usuario; no toques otras ciudades.
Existing plan (keep & adjust): ${getItineraryContext()}
Existing meta (per city): ${getCityMetaContext()}
Si el usuario pide añadir/ajustar actividades o destinos, responde con B/C/A. No envíes texto plano.
Solicitud: ${text}`.trim();

    try{
      const ans = await callAgent(prompt);
      const parsed = parseJSON(ans);
      if(parsed){
        applyParsedToState(parsed,false);
        renderCityTabs(); setActiveCity(workingCity||activeCity); renderCityItinerary(workingCity||activeCity);
        msg(parsed.followup || '¿Deseas otro ajuste?','ai');
      }else{
        msg(ans || 'Listo. ¿Otra cosa?','ai');
      }
      await checkAndGenerateMissing();
    }catch(e){
      console.error(e);
      msg('❌ Error de conexión.','ai');
    }
  }

  /* ==== Eventos ==== */
  $send?.addEventListener('click', sendChat);
  $intake?.addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); sendChat(); } });

  console.log('✅ planner-chat.js (v6) cargado, lógica original de meta restaurada y listeners activos.');
})();
