// public/planner-chat.js
(function(){
  // --- Conexión al puente expuesto por Webflow ---
  const PL = window.__planner;
  if(!PL){ console.error('Planner bridge not found'); return; }

  // Desempaquetar referencias necesarias
  const { state, statePatch } = PL;
  const { $send, $intake } = PL.dom;
  const { normalize, extractInt, parseTimesFromText, updateSavedDays } = PL.helpers;
  const { callAgent, parseJSON, getItineraryContext, getCityMetaContext, generateCityItinerary, applyParsedToState, ensureDays, upsertCityMeta } = PL.api;
  const { renderCityTabs, renderCityItinerary, msg, askForNextCityMeta, maybeGenerateAllCities } = PL.ui;

  // ===== SECCIÓN 14: Chat principal / edición interactiva =====
  /* ============ Chat libre (incluye fase de meta y edición) ============ */

  function userWantsReplace(text){
    const t=(text||'').toLowerCase();
    return /(sustituye|reemplaza|cambia todo|replace|overwrite|desde cero|todo nuevo|reformula|plantea de nuevo)/i.test(t);
  }

  function isAcceptance(text){
    const t=(text||'').toLowerCase().trim();
    return /(^|\b)(ok|listo|esta bien|perfecto|de acuerdo|vale|sounds good|looks good|c’est bon|tout bon|beleza|ta bom)\b/.test(t);
  }

  async function sendChat(){
    const text = ($intake.value||'').trim();
    if(!text) return;
    msg(text,'user');
    $intake.value='';

    // ======= Fase 1: recopilación secuencial de meta =======
    if(state.collectingMeta){
      const city = state.savedDestinations[state.metaProgressIndex]?.city;
      if(!city){ statePatch({collectingMeta:false}); await maybeGenerateAllCities(); return; }

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
        msg(\`Perfecto, tengo la información para ${city}.\`);
        statePatch({ awaitingMetaReply:false, metaProgressIndex: state.metaProgressIndex+1 });
        if(state.metaProgressIndex < state.savedDestinations.length){
          await askForNextCityMeta();
        }else{
          statePatch({collectingMeta:false});
          msg('Perfecto 🎉 Ya tengo toda la información. Generando itinerarios...');
          await maybeGenerateAllCities();
        }
      }else{
        msg('No logré entender. ¿Podrías repetir la fecha del primer día, horarios y hotel/zona?');
      }
      return;
    }

    // ======= Fase 2: conversación normal (edición libre) =======
    const tNorm = normalize(text);
    let handled = false;

    // --- a) Agregar días (exactos + actividad opcional)
    if(/\b(agrega|añade|sumar?|add)\b.*\bdía/.test(tNorm) || /\b(un dia mas|1 dia mas)\b/.test(tNorm)){
      const addN = extractInt(tNorm);
      const hasActivity = /\b(segovia|toledo|tour|excursion|museo|visita|actividad|paseo)\b/i.test(tNorm);
      const activityDesc = hasActivity ? text : null;

      if(state.activeCity){
        const current = state.savedDestinations.find(x=>x.city===state.activeCity)?.days 
          || Object.keys(state.itineraries[state.activeCity]?.byDay||{}).length || 1;
        const newDays = current + addN;
        updateSavedDays(state.activeCity, newDays);
        ensureDays(state.activeCity);

        if(hasActivity){
          const prompt = `
${FORMAT}
Edita el itinerario para "${state.activeCity}" agregando ${addN} día${addN>1?'s':''} adicionales.
Incluye la siguiente actividad (prioritario): "${activityDesc}".
No elimines días existentes, inserta al final en formato B (JSON).
`.trim();
          const answer = await callAgent(prompt);
          const parsed = parseJSON(answer);
          if(parsed){ applyParsedToState(parsed,false); }
        }else{
          await generateCityItinerary(state.activeCity);
        }

        renderCityTabs();
        setActiveCity(state.activeCity);
        msg(\`He añadido ${addN} día${addN>1?'s':''} en ${state.activeCity}.\`);
      }
      handled = true;
    }

    // --- b) Quitar días (últimos)
    if(!handled && /\b(quita|elimina|remueve|remove)\b.*\bdía/.test(tNorm)){
      const remN = extractInt(tNorm);
      if(state.activeCity){
        const current = state.savedDestinations.find(x=>x.city===state.activeCity)?.days 
          || Object.keys(state.itineraries[state.activeCity]?.byDay||{}).length || 1;
        const newDays = Math.max(1, current - remN);
        updateSavedDays(state.activeCity, newDays);
        ensureDays(state.activeCity);
        renderCityTabs();
        msg(\`He quitado ${remN} día${remN>1?'s':''} en ${state.activeCity}.\`);
      }
      handled = true;
    }

    // --- c) Ajuste de horas
    if(!handled && /\b(hora|horario|inicio|fin|empieza|termina|ajusta|cambia)\b/.test(tNorm)){
      const times = parseTimesFromText(text);
      if(state.activeCity && times.length){
        PL.state.cityMeta[state.activeCity] = PL.state.cityMeta[state.activeCity] || { baseDate:null, start:null, end:null, hotel:'' };
        if(times.length===1){
          if(/\b(hasta|termina|fin)\b/.test(tNorm)) PL.state.cityMeta[state.activeCity].end = times[0];
          else PL.state.cityMeta[state.activeCity].start = times[0];
        }else{
          PL.state.cityMeta[state.activeCity].start = times[0];
          PL.state.cityMeta[state.activeCity].end = times[times.length-1];
        }
        await generateCityItinerary(state.activeCity);
        renderCityTabs();
        setActiveCity(state.activeCity);
        msg(\`He ajustado las horas en ${state.activeCity}.\`);
      }
      handled = true;
    }

    // --- d) Recalcular itinerario
    if(!handled && /\b(recalcula|replanifica|recompute|replan|recalculate)\b/.test(tNorm)){
      if(state.activeCity){
        await generateCityItinerary(state.activeCity);
        renderCityTabs();
        setActiveCity(state.activeCity);
        msg(\`Recalculé el itinerario de ${state.activeCity}.\`);
      }
      handled = true;
    }

    if(handled) return;

    // --- e) Edición guiada por IA (sustituir/insertar/borrar actividades, reordenar días, etc.)
    PL.state.session.push({role:'user', content:text});
    const cityHint = state.activeCity ? \`Active city: ${state.activeCity}\` : '';
    const prompt = `${FORMAT}
Edit the current plan. ${cityHint}
Existing plan (keep & adjust): ${getItineraryContext()}
Existing meta (per city): ${getCityMetaContext()}
- If the user says "remove X", delete matching activity rows in the active city's current day.
- If the user asks to SUBSTITUTE an activity, remove the old one and add the new one (keep day timing coherent).
- If the user asks to change the order of days, reorder the itinerary accordingly.
- If the user asks to regenerate a full city, rebuild the itinerary fully optimized.
- Avoid duplicates across days in the same city.
- Return ONLY valid JSON (B/C/A).
User request: ${text}`;

    try{
      const answer = await callAgent(prompt);
      const parsed = parseJSON(answer);
      if(parsed){
        applyParsedToState(parsed,false);
        renderCityTabs();
        setActiveCity(state.activeCity);
        renderCityItinerary(state.activeCity);
        msg(parsed.followup || 'He aplicado los cambios y optimizado el día. ¿Quieres otro ajuste?','ai');
      }else{
        msg(answer || 'Listo. ¿Otra cosa?','ai');
      }
    }catch(e){
      console.error(e);
      msg('❌ Error de conexión.','ai');
    }
  }

  // Enlazar UI
  if ($send) $send.addEventListener('click', sendChat);
  if ($intake) $intake.addEventListener('keydown',(e)=>{
    if(e.key==='Enter'){ e.preventDefault(); sendChat(); }
  });
})();
